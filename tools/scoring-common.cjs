/**
 * Shared SSB/DSB scoring + DNA-target builders.
 *
 * Plain CommonJS, NO top-level side effects on require — safe to import from
 * tests and other tools. Algorithms and RNG call order are byte-identical to
 * the TypeScript sources they mirror.
 */
'use strict';

// --- constants (src/physics/constants.ts) ---
const DNA_LENGTH_NM = 3000;
const DNA_GRID_N = 21;
const DNA_SPACING_NM = 150;
const SSB_R_DAMAGE_NM = 0.29;
const SSB_R_DAMAGE_INDIRECT_NM = 1.0;
const SSB_P_INDIRECT = 0.13;
const SSB_E_LOW = 5.0;
const SSB_E_HIGH = 37.5;
const DSB_WINDOW_BP = 10;

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
function scoreDirectSSB_events(dna, rad_buf, rad_e, rad_dep, rad_n, rng) {
  const r_direct = SSB_R_DAMAGE_NM, r_direct2 = r_direct * r_direct, e_span = SSB_E_HIGH - SSB_E_LOW;
  const hits = new Uint8Array(dna.n_bp * 2);
  const E_acc = new Float32Array(dna.n_bp * 2);
  const x_half = (dna.n_bp_per - 1) * dna.rise * 0.5, rise_inv = 1 / dna.rise;
  const grid_off = -((dna.grid_N - 1) * dna.spacing_nm) * 0.5, inv_spacing = 1 / dna.spacing_nm;
  let candidates = 0, in_reach = 0, ssb_count = 0;
  let last_x = NaN, last_y = NaN, last_z = NaN;
  for (let i = 0; i < rad_n; i++) {
    const species = Math.round(rad_buf[i * 4 + 3]) % 8;
    if (species === 1 || species === 5 || species === 7) continue;
    const x = rad_dep[i * 4], y = rad_dep[i * 4 + 1], z = rad_dep[i * 4 + 2];
    if (x === last_x && y === last_y && z === last_z) continue;
    last_x = x; last_y = y; last_z = z;
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
      const global_bp = fiber_idx * dna.n_bp_per + best_bp, idx = global_bp + best_strand * dna.n_bp;
      E_acc[idx] += rad_e[i];
    }
  }
  for (let idx = 0; idx < E_acc.length; idx++) {
    const e = E_acc[idx];
    if (e <= SSB_E_LOW) continue;
    const p_break = e >= SSB_E_HIGH ? 1 : (e - SSB_E_LOW) / e_span;
    if (rng() < p_break) { hits[idx] = 1; ssb_count++; }
  }
  return { hits, ssb_count, candidates, in_reach };
}

// --- clusterDSB (src/scoring/ssb-dsb.ts, CJS variant) ---
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

module.exports = {
  DNA_LENGTH_NM,
  DNA_GRID_N,
  DNA_SPACING_NM,
  SSB_R_DAMAGE_NM,
  SSB_R_DAMAGE_INDIRECT_NM,
  SSB_P_INDIRECT,
  SSB_E_LOW,
  SSB_E_HIGH,
  DSB_WINDOW_BP,
  makeSsbRng,
  buildDNATarget,
  scoreDirectSSB_events,
  clusterDSB,
  combineHits,
};
