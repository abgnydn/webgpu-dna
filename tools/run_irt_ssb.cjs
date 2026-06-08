#!/usr/bin/env node
/**
 * Run the IRT chemistry WITH SSB/DSB scoring on a saved rad_buf dump.
 *
 * Extends tools/run_irt.cjs: builds the DNA target, passes it + ssbScoring to
 * the worker (which accumulates indirect SSB during the timeline), then scores
 * direct SSB from rad_buf and clusters DSBs — the same pipeline as
 * src/app.ts scoreDamageAt10keV, ported to CJS so it runs GPU-free on a CI
 * runner (the chemistry heap OOMs a memory-pressured laptop).
 *
 * Used to revalidate SSB/DSB after a shader change (e.g. RECOMB_BOOST 2.0->1.0,
 * E7d) without the local memory wall.
 *
 * Usage: node tools/run_irt_ssb.cjs <dump_file> <n_therm> <E_eV>
 * Output: JSON line { type:'damage', ssb_dir, ssb_ind, dsb, ratio, ... } on stdout.
 *
 * Constants mirror src/physics/constants.ts (verified 2026-06-08).
 */
'use strict';
const fs = require('fs');
const path = require('path');

// --- constants (src/physics/constants.ts) ---
const DNA_LENGTH_NM = 3000, DNA_GRID_N = 21, DNA_SPACING_NM = 150;
const SSB_R_DAMAGE_NM = 0.29, SSB_R_DAMAGE_INDIRECT_NM = 1.0;
const SSB_P_INDIRECT = 0.05, SSB_P_DIRECT = 0.15, DSB_WINDOW_BP = 10;

// --- buildDNATarget (src/physics/dna-geometry.ts) ---
function buildDNATarget(L_nm = 3000, grid_N = 21, spacing_nm = 150) {
  const rise = 0.34, bp_per_turn = 10.5, r_bb = 1.0;
  const n_bp_per = Math.floor(L_nm / rise);
  const x0 = -(n_bp_per - 1) * rise * 0.5;
  const d_phase = (2 * Math.PI) / bp_per_turn;
  const n_fibers = grid_N * grid_N;
  const n_bp = n_fibers * n_bp_per;
  const fy = new Float32Array(n_fibers), fz = new Float32Array(n_fibers);
  const off = -((grid_N - 1) * spacing_nm) * 0.5;
  for (let fi = 0; fi < grid_N; fi++)
    for (let fj = 0; fj < grid_N; fj++) {
      const idx = fi * grid_N + fj;
      fy[idx] = off + fi * spacing_nm; fz[idx] = off + fj * spacing_nm;
    }
  const rbb0 = new Float32Array(n_bp_per * 2), rbb1 = new Float32Array(n_bp_per * 2);
  for (let i = 0; i < n_bp_per; i++) {
    const phi = i * d_phase;
    rbb0[i * 2] = r_bb * Math.cos(phi); rbb0[i * 2 + 1] = r_bb * Math.sin(phi);
    rbb1[i * 2] = r_bb * Math.cos(phi + Math.PI); rbb1[i * 2 + 1] = r_bb * Math.sin(phi + Math.PI);
  }
  return { rise, r_bb, n_bp_per, n_fibers, n_bp, grid_N, spacing_nm, x0, L_nm, fy, fz, rbb0, rbb1 };
}

function makeSsbRng(seed = 0x12345678 >>> 0) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// --- scoreDirectSSB_events (src/scoring/ssb-dsb.ts) ---
function scoreDirectSSB_events(dna, rad_buf, rad_n, rng) {
  const r_direct = SSB_R_DAMAGE_NM, r_direct2 = r_direct * r_direct, p_direct = SSB_P_DIRECT;
  const hits = new Uint8Array(dna.n_bp * 2);
  const x_half = (dna.n_bp_per - 1) * dna.rise * 0.5, rise_inv = 1 / dna.rise;
  const grid_off = -((dna.grid_N - 1) * dna.spacing_nm) * 0.5, inv_spacing = 1 / dna.spacing_nm;
  let candidates = 0, in_reach = 0, ssb_count = 0, i = 0;
  while (i < rad_n) {
    const x = rad_buf[i * 4], y = rad_buf[i * 4 + 1], z = rad_buf[i * 4 + 2];
    let skip = 1;
    if (i + 1 < rad_n && rad_buf[(i + 1) * 4] === x && rad_buf[(i + 1) * 4 + 1] === y && rad_buf[(i + 1) * 4 + 2] === z) skip = 2;
    i += skip;
    if (x < -x_half - r_direct || x > x_half + r_direct) continue;
    const fi = Math.round((y - grid_off) * inv_spacing), fj = Math.round((z - grid_off) * inv_spacing);
    if (fi < 0 || fi >= dna.grid_N || fj < 0 || fj >= dna.grid_N) continue;
    const fiber_idx = fi * dna.grid_N + fj;
    const y_rel = y - dna.fy[fiber_idx], z_rel = z - dna.fz[fiber_idx];
    const r2 = y_rel * y_rel + z_rel * z_rel, outer = dna.r_bb + r_direct;
    if (r2 > outer * outer) continue;
    candidates++;
    const bp_est = Math.round((x + x_half) * rise_inv);
    const b0 = Math.max(0, bp_est - 2), b1 = Math.min(dna.n_bp_per - 1, bp_est + 2);
    let best_d2 = Infinity, best_bp = -1, best_strand = -1;
    for (let b = b0; b <= b1; b++) {
      const dx = x - (dna.x0 + b * dna.rise);
      const dy0 = y_rel - dna.rbb0[b * 2], dz0 = z_rel - dna.rbb0[b * 2 + 1];
      const d20 = dx * dx + dy0 * dy0 + dz0 * dz0;
      if (d20 < best_d2) { best_d2 = d20; best_bp = b; best_strand = 0; }
      const dy1 = y_rel - dna.rbb1[b * 2], dz1 = z_rel - dna.rbb1[b * 2 + 1];
      const d21 = dx * dx + dy1 * dy1 + dz1 * dz1;
      if (d21 < best_d2) { best_d2 = d21; best_bp = b; best_strand = 1; }
    }
    if (best_d2 < r_direct2) {
      in_reach++;
      if (rng() < p_direct) {
        const global_bp = fiber_idx * dna.n_bp_per + best_bp, idx = global_bp + best_strand * dna.n_bp;
        if (hits[idx] === 0) { hits[idx] = 1; ssb_count++; }
      }
    }
  }
  return { hits, ssb_count, candidates, in_reach };
}

// --- clusterDSB (src/scoring/ssb-dsb.ts) ---
function clusterDSB(dna, hits) {
  const n = dna.n_bp, n_per = dna.n_bp_per, W = DSB_WINDOW_BP;
  let dsb_int = 0, ssb0_tot = 0, ssb1_tot = 0;
  for (let fi = 0; fi < dna.n_fibers; fi++) {
    const base = fi * n_per;
    const s0 = [], s1 = [];
    for (let b = 0; b < n_per; b++) {
      if (hits[base + b] === 1) s0.push(b);
      if (hits[base + b + n] === 1) s1.push(b);
    }
    const k0 = s0.length, k1 = s1.length;
    ssb0_tot += k0; ssb1_tot += k1;
    if (!k0 || !k1) continue;
    const used1 = new Uint8Array(k1);
    let j_lo = 0;
    for (const b0 of s0) {
      while (j_lo < k1 && s1[j_lo] < b0 - W) j_lo++;
      for (let j = j_lo; j < k1 && s1[j] <= b0 + W; j++) {
        if (used1[j] === 0) { used1[j] = 1; dsb_int++; break; }
      }
    }
  }
  return { dsb: dsb_int, ssb0: ssb0_tot, ssb1: ssb1_tot };
}

function combineHits(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] | b[i]) ? 1 : 0;
  return out;
}

// --- main ---
const dumpFile = process.argv[2];
const n_therm = parseInt(process.argv[3] || '0', 10);
const E_eV = parseInt(process.argv[4] || '10000', 10);
if (!dumpFile || !n_therm) { console.error('usage: node tools/run_irt_ssb.cjs <dump> <n_therm> <E_eV>'); process.exit(1); }

const buf = fs.readFileSync(dumpFile);
const rad_buf = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const rad_n = rad_buf.length / 4;
console.error(`[run_irt_ssb] ${dumpFile}: ${rad_n} radicals  n_therm=${n_therm}  E=${E_eV} eV`);

const dna = buildDNATarget(DNA_LENGTH_NM, DNA_GRID_N, DNA_SPACING_NM);
const dnaForWorker = {
  fy: dna.fy, fz: dna.fz, rbb0: dna.rbb0, rbb1: dna.rbb1,
  n_bp_per: dna.n_bp_per, grid_N: dna.grid_N, spacing_nm: dna.spacing_nm,
  x0: dna.x0, x_half: -dna.x0, r_bb: dna.r_bb,
};
const ssbScoring = { r_indirect: SSB_R_DAMAGE_INDIRECT_NM, p_indirect: SSB_P_INDIRECT, seed: 0x53534231 };

// Shim WebWorker globals so irt-worker.js runs unmodified (as in run_irt.cjs).
let workerOnMessage = null;
let workerResult = null;
const shim = {
  onmessage: null,
  postMessage(data) {
    if (data.type === 'progress') console.error(`[worker] ${data.msg}`);
    else if (data.type === 'result') workerResult = data;
  },
};
Object.defineProperty(shim, 'onmessage', { set(fn) { workerOnMessage = fn; }, get() { return workerOnMessage; } });
global.self = shim;
const src = fs.readFileSync(path.resolve(__dirname, '../public/irt-worker.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(src);
if (typeof workerOnMessage !== 'function') { console.error('[run_irt_ssb] worker did not register onmessage'); process.exit(2); }

workerOnMessage({ data: { rad_buf, rad_n, n_therm, E_eV, dna: dnaForWorker, ssbScoring } });
if (!workerResult || !workerResult.ssb_indirect) { console.error('[run_irt_ssb] no ssb_indirect from worker'); process.exit(3); }

const ind = workerResult.ssb_indirect;
const ssb_ind = ind.total;
const indirectHits = ind.hits;
const rng = makeSsbRng();
const direct = scoreDirectSSB_events(dna, rad_buf, rad_n, rng);
const ssb_dir = direct.ssb_count;
const combined = combineHits(direct.hits, indirectHits);
const dsbRes = clusterDSB(dna, combined);

const ratio = ssb_dir > 0 ? ssb_ind / ssb_dir : null;
const us = workerResult.timeline.find((t) => t.label === '1 us') || workerResult.timeline[workerResult.timeline.length - 1];
const out = {
  type: 'damage', E_eV, ssb_dir, ssb_ind, dsb: dsbRes.dsb,
  indirect_over_direct_ratio: ratio,
  in_reach_direct: direct.in_reach, in_reach_indirect: ind.in_reach, candidates_indirect: ind.candidates,
  G_OH_1us: us.G_OH, G_eaq_1us: us.G_eaq,
  config: { RECOMB_BOOST: 'from dump', SSB_P_INDIRECT, SSB_P_DIRECT, SSB_R_DAMAGE_INDIRECT_NM },
};
process.stdout.write(JSON.stringify(out) + '\n');
console.error(`[run_irt_ssb] SSB_dir=${ssb_dir} SSB_ind=${ssb_ind} DSB=${dsbRes.dsb} ratio=${ratio ? ratio.toFixed(2) : 'n/a'} (PARTRAC 2-3) | G(OH)@1us=${us.G_OH.toFixed(3)}`);
