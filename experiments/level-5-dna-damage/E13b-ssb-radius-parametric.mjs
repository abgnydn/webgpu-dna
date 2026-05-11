// E13b — Parametric sweep of SSB_R_DAMAGE_NM, reproducing the WGSL
// indirect-SSB scoring logic in Node on the existing rad_buf positions.
//
// E13 surfaced that the observed SSB_ind = 0 at r_damage = 0.29 nm
// (Nikjoo reaction radius). PARTRAC uses an effective ~1 nm because it
// folds OH diffusion within the encounter window into the scoring radius.
// E13b computes what SSB_ind would become at r ∈ {0.29, 0.5, 1.0, 1.5,
// 2.0, 3.0} nm — guides the physics-fix decision in PHYSICS_DIAGNOSIS.md §3.
//
// Method:
//   1. Read dumps/rad_E10000_N4096.bin (pre-chemistry rad_buf at 10 keV,
//      N=4096 primaries).
//   2. Filter to OH (species code 0) and pre-thermalized eaq (code 5,
//      thermalizes to eaq within ps → eligible for the indirect-SSB
//      surface that the actual harness scores; we apply species filter
//      = OH only to match scoreIndirectSSB exactly).
//   3. Build the 21×21 DNA fiber geometry in Node (mirror of
//      src/physics/dna-geometry.ts).
//   4. For each candidate r_damage:
//      a. Apply an OH survival fraction (G(OH)_1μs / G(OH)_initial ≈
//         1.55 / 4.51 ≈ 0.344 from E10/E9) by Bernoulli sampling each OH.
//      b. For each surviving OH, compute distance to nearest backbone
//         bp atom (replicates scoreIndirectSSB's ±2-bp search window).
//      c. If within r_damage, apply SSB_P_INDIRECT = 0.4 Bernoulli.
//      d. Count unique (bp, strand) damage sites (de-dup).
//   5. Report SSB_ind(r_damage) curve. Pick r where SSB_ind ≈ 2-3 × SSB_dir
//      to match PARTRAC's indirect/direct ratio.
//
// Pass bar: SSB_ind(r=1.0) ≥ 2 × observed_SSB_dir (= 24) i.e. ≥ 48.
// This validates that r_damage = 1.0 would bring the ratio into the
// PARTRAC band, supporting the one-line fix in src/physics/constants.ts.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RAD_BIN = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');

const N_PRIMARIES = 4096;
const ENERGY_EV = 10000;
const RADII_NM = [0.29, 0.5, 1.0, 1.5, 2.0, 3.0];
const SSB_P_INDIRECT = 0.4;
const OH_SURVIVAL_FRACTION = 0.344; // G(OH)_1μs / G(OH)_initial ≈ 1.55 / 4.51

// DNA geometry constants — must match src/physics/dna-geometry.ts:
const GRID_N = 21;
const SPACING_NM = 150;
const L_NM = 3000; // 3 μm
const RISE = 0.34;
const BP_PER_TURN = 10.5;
const R_BB = 1.0;

function buildDNA() {
  const n_bp_per = Math.floor(L_NM / RISE);
  const x0 = -(n_bp_per - 1) * RISE * 0.5;
  const x_half = -x0;
  const off = -((GRID_N - 1) * SPACING_NM) * 0.5;
  const fy = new Float32Array(GRID_N * GRID_N);
  const fz = new Float32Array(GRID_N * GRID_N);
  for (let fi = 0; fi < GRID_N; fi++) {
    for (let fj = 0; fj < GRID_N; fj++) {
      const idx = fi * GRID_N + fj;
      fy[idx] = off + fi * SPACING_NM;
      fz[idx] = off + fj * SPACING_NM;
    }
  }
  const d_phase = (2 * Math.PI) / BP_PER_TURN;
  const rbb0 = new Float32Array(n_bp_per * 2);
  const rbb1 = new Float32Array(n_bp_per * 2);
  for (let i = 0; i < n_bp_per; i++) {
    const phi = i * d_phase;
    rbb0[i * 2 + 0] = R_BB * Math.cos(phi);
    rbb0[i * 2 + 1] = R_BB * Math.sin(phi);
    rbb1[i * 2 + 0] = R_BB * Math.cos(phi + Math.PI);
    rbb1[i * 2 + 1] = R_BB * Math.sin(phi + Math.PI);
  }
  return { fy, fz, rbb0, rbb1, n_bp_per, x0, x_half, n_bp: GRID_N * GRID_N * n_bp_per };
}

// Mulberry32 deterministic RNG
function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readOHPositions(binPath) {
  const buf = readFileSync(binPath);
  const recordCount = buf.length / 16;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const xs = [];
  const ys = [];
  const zs = [];
  for (let i = 0; i < recordCount; i++) {
    const encoded = Math.round(f32[i * 4 + 3]);
    const species = encoded & 7;
    if (species !== 0) continue; // OH only
    xs.push(f32[i * 4 + 0]);
    ys.push(f32[i * 4 + 1]);
    zs.push(f32[i * 4 + 2]);
  }
  return { xs, ys, zs };
}

function scoreAtRadius(dna, ohs, rDamage, rng) {
  const { fy, fz, rbb0, rbb1, n_bp_per, x0, x_half } = dna;
  const r_damage2 = rDamage * rDamage;
  const outer = R_BB + rDamage;
  const outer2 = outer * outer;
  const grid_off = -((GRID_N - 1) * SPACING_NM) * 0.5;
  const inv_spacing = 1 / SPACING_NM;
  const rise_inv = 1 / RISE;
  const hits = new Uint8Array(n_bp_per * GRID_N * GRID_N * 2);
  let candidates = 0;
  let inReach = 0;
  let ssb0 = 0;
  let ssb1 = 0;

  const N = ohs.xs.length;
  for (let i = 0; i < N; i++) {
    // OH survival sampling
    if (rng() >= OH_SURVIVAL_FRACTION) continue;
    const x = ohs.xs[i];
    const y = ohs.ys[i];
    const z = ohs.zs[i];
    if (x < -x_half - rDamage || x > x_half + rDamage) continue;
    const fi = Math.round((y - grid_off) * inv_spacing);
    const fj = Math.round((z - grid_off) * inv_spacing);
    if (fi < 0 || fi >= GRID_N || fj < 0 || fj >= GRID_N) continue;
    const fiber_idx = fi * GRID_N + fj;
    const y_rel = y - fy[fiber_idx];
    const z_rel = z - fz[fiber_idx];
    const r2 = y_rel * y_rel + z_rel * z_rel;
    if (r2 > outer2) continue;

    candidates++;
    const bp_est = Math.round((x + x_half) * rise_inv);
    const bp0 = Math.max(0, bp_est - 2);
    const bp1 = Math.min(n_bp_per - 1, bp_est + 2);

    let best_d2 = Infinity;
    let best_bp = -1;
    let best_strand = -1;
    for (let b = bp0; b <= bp1; b++) {
      const dx = x - (x0 + b * RISE);
      const dy0 = y_rel - rbb0[b * 2 + 0];
      const dz0 = z_rel - rbb0[b * 2 + 1];
      const d20 = dx * dx + dy0 * dy0 + dz0 * dz0;
      if (d20 < best_d2) { best_d2 = d20; best_bp = b; best_strand = 0; }
      const dy1 = y_rel - rbb1[b * 2 + 0];
      const dz1 = z_rel - rbb1[b * 2 + 1];
      const d21 = dx * dx + dy1 * dy1 + dz1 * dz1;
      if (d21 < best_d2) { best_d2 = d21; best_bp = b; best_strand = 1; }
    }

    if (best_d2 < r_damage2) {
      inReach++;
      if (rng() < SSB_P_INDIRECT) {
        const global_bp = fiber_idx * n_bp_per + best_bp;
        const idx = global_bp + best_strand * (n_bp_per * GRID_N * GRID_N);
        if (hits[idx] === 0) {
          hits[idx] = 1;
          if (best_strand === 0) ssb0++; else ssb1++;
        }
      }
    }
  }

  return { candidates, inReach, ssb0, ssb1, ssbTotal: ssb0 + ssb1 };
}

export async function runE13b() {
  const env = captureEnv();
  const meta = {
    protocol: 'E13b-ssb-radius-parametric',
    hypothesis:
      'Bumping SSB_R_DAMAGE_NM from the Nikjoo pure-reaction value of 0.29 nm up to the PARTRAC effective value of ~1.0 nm lifts the predicted SSB_ind from ~0 (observed) into the 48-72 range (i.e. 2-3× the observed SSB_dir = 24) — matching PARTRAC\'s low-LET indirect/direct ratio of 2-3.',
    passBar:
      'At r_damage = 1.0 nm: predicted SSB_ind ≥ 48 (≥ 2× observed SSB_dir = 24).',
    seed: `E13_INDIRECT_SSB=0x${SEEDS.E13_INDIRECT_SSB.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      radBin: RAD_BIN.replace(REPO_ROOT + '/', ''),
      scoring: 'src/scoring/ssb-dsb.ts:scoreIndirectSSB (replicated in Node)',
      dnaGeometry: 'src/physics/dna-geometry.ts (replicated in Node)',
      ohSurvivalFraction: '0.344 (G(OH)_1μs=1.55 / G(OH)_init=4.51, from E10/E9)',
    },
    config: {
      radii_nm: RADII_NM,
      ssb_p_indirect: SSB_P_INDIRECT,
      oh_survival_fraction: OH_SURVIVAL_FRACTION,
      observed_ssb_dir: 24,
    },
  };

  if (!existsSync(RAD_BIN)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `rad_bin missing: ${RAD_BIN}`,
      summary: { headline: 'skipped' }, rows: [],
    };
  }

  const dna = buildDNA();
  const ohs = readOHPositions(RAD_BIN);

  const rows = [];
  let ssbAtR1 = null;
  for (const r of RADII_NM) {
    const rng = makeRng(SEEDS.E13_INDIRECT_SSB ^ Math.round(r * 1000));
    const res = scoreAtRadius(dna, ohs, r, rng);
    if (r === 1.0) ssbAtR1 = res.ssbTotal;
    rows.push({
      metric: `r_${r.toFixed(2)}_nm`,
      r_damage_nm: r,
      n_oh_total: ohs.xs.length,
      candidates_in_box_band: res.candidates,
      in_reach_at_r_damage: res.inReach,
      ssb0_strand_0: res.ssb0,
      ssb1_strand_1: res.ssb1,
      ssb_ind_total: res.ssbTotal,
      ratio_to_observed_ssb_dir: res.ssbTotal / 24,
      status: 'informational',
    });
  }

  const observed_ssb_dir = 24;
  const partracRatio = 2.5; // mid-range of 2-3
  const targetSsb = Math.round(observed_ssb_dir * partracRatio);
  const passed = ssbAtR1 !== null && ssbAtR1 >= observed_ssb_dir * 2;

  rows.push({
    metric: 'recommendation',
    observed_ssb_dir,
    partrac_indirect_over_direct_range: '[2, 3]',
    target_ssb_ind_for_ratio_2: observed_ssb_dir * 2,
    target_ssb_ind_for_ratio_3: observed_ssb_dir * 3,
    measured_at_r_1nm: ssbAtR1,
    measured_at_r_1nm_meets_target: passed,
    recommended_fix: passed
      ? 'Set SSB_R_DAMAGE_NM = 1.0 nm in src/physics/constants.ts (parametric sweep confirms this lifts SSB_ind into the PARTRAC band).'
      : 'r=1.0 nm does not reach the PARTRAC band by parametric prediction; consider a different fix path (move scoring into IRT worker, or change OH survival assumption).',
    status: passed ? 'pass' : 'fail',
  });

  const status = passed ? 'pass' : 'fail';
  const diagnosis = passed
    ? null
    : `at r_damage = 1.0 nm, predicted SSB_ind = ${ssbAtR1} < ${observed_ssb_dir * 2} (2× SSB_dir)`;

  const summary = {
    n_oh_in_rad_buf: ohs.xs.length,
    observed_ssb_dir,
    ssb_ind_predicted_at_radii: Object.fromEntries(
      rows.filter((r) => r.metric.startsWith('r_')).map((r) => [r.r_damage_nm, r.ssb_ind_total]),
    ),
    headline: `SSB_ind(r): ${RADII_NM.map((r) => {
      const row = rows.find((row) => row.r_damage_nm === r);
      return `r=${r}nm→${row.ssb_ind_total}`;
    }).join(' | ')} (observed SSB_dir = ${observed_ssb_dir})`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
