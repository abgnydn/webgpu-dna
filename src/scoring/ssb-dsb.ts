/**
 * SSB/DSB scoring — direct port from public/geant4dna.html.
 *
 * Three scoring paths:
 *  1. `scoreIndirectSSB` — loops surviving OH at t=1 μs. Each OH within the
 *     backbone reach radius (r_bb + r_damage) may create a single-strand break
 *     with probability `SSB_P_INDIRECT`.
 *  2. `scoreDirectSSB_events` — loops ionization/excitation sites stored in
 *     rad_buf. Each event near the backbone may create an SSB with probability
 *     `SSB_P_DIRECT`. This is the preferred direct-damage path because it
 *     preserves the nm-scale spatial correlation that voxel dose smears out.
 *  3. `scoreDirectSSB` — voxel-based alternative (kept for reference / lambda
 *     used by `expectedDSBLocal`).
 *
 * DSB clustering:
 *  - `clusterDSB` — greedy pairing of strand-0 and strand-1 SSBs within ±10 bp.
 *  - `expectedDSBLocal` — analytical local-density approximation for low-stats
 *    regimes where integer DSB counts are noisy.
 */
import {
  VC,
  SSB_R_DAMAGE_NM,
  SSB_R_DAMAGE_INDIRECT_NM,
  SSB_P_INDIRECT,
  SSB_P_DIRECT,
  DSB_WINDOW_BP,
  SPECIES,
} from '../physics/constants';
import type {
  DNATarget,
  IndirectSSBResult,
  DirectSSBResult,
  DSBClusterResult,
} from '../physics/types';

/** Deterministic RNG signature — returns uniform [0,1). */
export type Rng = () => number;

/**
 * Score indirect SSBs from surviving OH radicals at t = 1 μs.
 * `chem_pos` layout: vec4 per radical — (x, y, z, species_code).
 * Species encoding matches {@link SPECIES} (0 = OH, 1 = eaq, 2 = H).
 */
export function scoreIndirectSSB(
  dna: DNATarget,
  chem_pos_final: Float32Array,
  chem_alive_final: Uint32Array,
  chem_n: number,
  rng: Rng,
): IndirectSSBResult {
  // Use SSB_R_DAMAGE_INDIRECT_NM (PARTRAC effective ~1.0 nm), NOT
  // SSB_R_DAMAGE_NM (Nikjoo reaction-only, 0.29 nm). Indirect needs the
  // larger radius to fold in OH diffusion-to-encounter within the
  // per-step chemistry window. See PHYSICS_DIAGNOSIS.md §3 + E13/E13b/E13c.
  const r_damage = SSB_R_DAMAGE_INDIRECT_NM;
  const r_damage2 = r_damage * r_damage;
  const p_ssb = SSB_P_INDIRECT;
  const hits = new Uint8Array(dna.n_bp * 2);
  const x_half = (dna.n_bp_per - 1) * dna.rise * 0.5;
  const rise_inv = 1 / dna.rise;
  const grid_off = -((dna.grid_N - 1) * dna.spacing_nm) * 0.5;
  const inv_spacing = 1 / dna.spacing_nm;

  let candidates = 0;
  let in_reach = 0;
  let ssb0 = 0;
  let ssb1 = 0;

  for (let i = 0; i < chem_n; i++) {
    if (chem_alive_final[i] === 0) continue;
    const sp = Math.round(chem_pos_final[i * 4 + 3]);
    if (sp !== SPECIES.OH) continue;

    const x = chem_pos_final[i * 4 + 0];
    const y = chem_pos_final[i * 4 + 1];
    const z = chem_pos_final[i * 4 + 2];

    if (x < -x_half - r_damage || x > x_half + r_damage) continue;

    const fi = Math.round((y - grid_off) * inv_spacing);
    const fj = Math.round((z - grid_off) * inv_spacing);
    if (fi < 0 || fi >= dna.grid_N || fj < 0 || fj >= dna.grid_N) continue;

    const fiber_idx = fi * dna.grid_N + fj;
    const y_rel = y - dna.fy[fiber_idx];
    const z_rel = z - dna.fz[fiber_idx];
    const r2 = y_rel * y_rel + z_rel * z_rel;
    const outer = dna.r_bb + r_damage;
    if (r2 > outer * outer) continue;

    candidates++;
    const bp_est = Math.round((x + x_half) * rise_inv);
    const bp0 = Math.max(0, bp_est - 2);
    const bp1 = Math.min(dna.n_bp_per - 1, bp_est + 2);

    let best_d2 = Infinity;
    let best_bp = -1;
    let best_strand = -1;
    for (let b = bp0; b <= bp1; b++) {
      const dx = x - (dna.x0 + b * dna.rise);
      const dy0 = y_rel - dna.rbb0[b * 2 + 0];
      const dz0 = z_rel - dna.rbb0[b * 2 + 1];
      const d20 = dx * dx + dy0 * dy0 + dz0 * dz0;
      if (d20 < best_d2) { best_d2 = d20; best_bp = b; best_strand = 0; }
      const dy1 = y_rel - dna.rbb1[b * 2 + 0];
      const dz1 = z_rel - dna.rbb1[b * 2 + 1];
      const d21 = dx * dx + dy1 * dy1 + dz1 * dz1;
      if (d21 < best_d2) { best_d2 = d21; best_bp = b; best_strand = 1; }
    }

    if (best_d2 < r_damage2) {
      in_reach++;
      if (rng() < p_ssb) {
        const global_bp = fiber_idx * dna.n_bp_per + best_bp;
        const idx = global_bp + best_strand * dna.n_bp;
        if (hits[idx] === 0) {
          hits[idx] = 1;
          if (best_strand === 0) ssb0++;
          else ssb1++;
        }
      }
    }
  }

  return { hits, ssb0, ssb1, candidates, in_reach };
}

/**
 * Score direct SSBs from rad_buf ionization-site positions.
 *
 * rad_buf stores one vec4 per radical created at an ionization event. Ionization
 * events emit 2 entries (OH + e-aq at the same position) and dissociative
 * excitation events emit 2 entries (OH + H at the same position). The scorer
 * de-duplicates pairs by comparing the next entry's position.
 *
 * For each unique site: snap to nearest fiber → nearest bp → check distance
 * to nearest backbone atom; if within `r_direct` (0.29 nm), roll `p_direct`
 * (0.15) to decide SSB.
 */
export function scoreDirectSSB_events(
  dna: DNATarget,
  rad_buf: Float32Array,
  rad_n: number,
  rng: Rng,
): DirectSSBResult {
  const r_direct = SSB_R_DAMAGE_NM;
  const r_direct2 = r_direct * r_direct;
  const p_direct = SSB_P_DIRECT;
  const hits = new Uint8Array(dna.n_bp * 2);
  const x_half = (dna.n_bp_per - 1) * dna.rise * 0.5;
  const rise_inv = 1 / dna.rise;
  const grid_off = -((dna.grid_N - 1) * dna.spacing_nm) * 0.5;
  const inv_spacing = 1 / dna.spacing_nm;

  let candidates = 0;
  let in_reach = 0;
  let ssb_count = 0;

  let i = 0;
  while (i < rad_n) {
    const x = rad_buf[i * 4 + 0];
    const y = rad_buf[i * 4 + 1];
    const z = rad_buf[i * 4 + 2];
    // Dedupe paired radicals (same ionization/excitation site).
    let skip = 1;
    if (i + 1 < rad_n) {
      if (rad_buf[(i + 1) * 4 + 0] === x &&
          rad_buf[(i + 1) * 4 + 1] === y &&
          rad_buf[(i + 1) * 4 + 2] === z) {
        skip = 2;
      }
    }
    i += skip;

    if (x < -x_half - r_direct || x > x_half + r_direct) continue;

    const fi = Math.round((y - grid_off) * inv_spacing);
    const fj = Math.round((z - grid_off) * inv_spacing);
    if (fi < 0 || fi >= dna.grid_N || fj < 0 || fj >= dna.grid_N) continue;

    const fiber_idx = fi * dna.grid_N + fj;
    const y_rel = y - dna.fy[fiber_idx];
    const z_rel = z - dna.fz[fiber_idx];
    const r2 = y_rel * y_rel + z_rel * z_rel;
    const outer = dna.r_bb + r_direct;
    if (r2 > outer * outer) continue;

    candidates++;
    const bp_est = Math.round((x + x_half) * rise_inv);
    const b0 = Math.max(0, bp_est - 2);
    const b1 = Math.min(dna.n_bp_per - 1, bp_est + 2);

    let best_d2 = Infinity;
    let best_bp = -1;
    let best_strand = -1;
    for (let b = b0; b <= b1; b++) {
      const dx = x - (dna.x0 + b * dna.rise);
      const dy0 = y_rel - dna.rbb0[b * 2 + 0];
      const dz0 = z_rel - dna.rbb0[b * 2 + 1];
      const d20 = dx * dx + dy0 * dy0 + dz0 * dz0;
      if (d20 < best_d2) { best_d2 = d20; best_bp = b; best_strand = 0; }
      const dy1 = y_rel - dna.rbb1[b * 2 + 0];
      const dz1 = z_rel - dna.rbb1[b * 2 + 1];
      const d21 = dx * dx + dy1 * dy1 + dz1 * dz1;
      if (d21 < best_d2) { best_d2 = d21; best_bp = b; best_strand = 1; }
    }

    if (best_d2 < r_direct2) {
      in_reach++;
      if (rng() < p_direct) {
        const global_bp = fiber_idx * dna.n_bp_per + best_bp;
        const idx = global_bp + best_strand * dna.n_bp;
        if (hits[idx] === 0) {
          hits[idx] = 1;
          ssb_count++;
        }
      }
    }
  }

  return { hits, ssb_count, candidates, in_reach };
}

/**
 * Score direct SSBs per-bp from voxelized dose. Returns a flat per-bp λ array
 * (2 strands × n_bp) plus the total expected direct_ssb. Used as the `lambda`
 * input to {@link expectedDSBLocal}.
 *
 * `dose_arr` is the 128³ u32 voxel grid (×100 units/eV) read back from the GPU.
 * `box_nm` is the half-width of the simulation volume (matches WGSL `p.box`).
 */
export function scoreDirectSSB(
  dna: DNATarget,
  dose_arr: Uint32Array,
  box_nm: number,
): { direct_ssb: number; lambda: Float32Array } {
  const vc = VC;
  const vox_nm = (2 * box_nm) / vc;
  const vox_vol = vox_nm * vox_nm * vox_nm;
  const half = box_nm;
  const inv_vox = 1 / vox_nm;
  const r_sugar = SSB_R_DAMAGE_NM;
  const bb_vol_per_bp = (4.0 / 3) * Math.PI * r_sugar * r_sugar * r_sugar;
  const E_mean_ion = 22;
  const p_ion_ssb = SSB_P_DIRECT;
  const K = ((bb_vol_per_bp / vox_vol) * p_ion_ssb) / E_mean_ion;

  const n = dna.n_bp;
  const lambda = new Float32Array(n * 2);
  let direct_expected = 0;

  for (let fi = 0; fi < dna.n_fibers; fi++) {
    const fy = dna.fy[fi];
    const fz = dna.fz[fi];
    const base = fi * dna.n_bp_per;
    for (let b = 0; b < dna.n_bp_per; b++) {
      const bx = dna.x0 + b * dna.rise;
      const vx = Math.floor((bx + half) * inv_vox);
      if (vx < 0 || vx >= vc) continue;

      const y0 = fy + dna.rbb0[b * 2 + 0];
      const z0 = fz + dna.rbb0[b * 2 + 1];
      const y1 = fy + dna.rbb1[b * 2 + 0];
      const z1 = fz + dna.rbb1[b * 2 + 1];

      const vy0 = Math.floor((y0 + half) * inv_vox);
      const vz0 = Math.floor((z0 + half) * inv_vox);
      const vy1 = Math.floor((y1 + half) * inv_vox);
      const vz1 = Math.floor((z1 + half) * inv_vox);

      if (vy0 >= 0 && vy0 < vc && vz0 >= 0 && vz0 < vc) {
        const d = dose_arr[(vz0 * vc + vy0) * vc + vx] / 100.0;
        const l = d * K;
        lambda[base + b] = l;
        direct_expected += l;
      }
      if (vy1 >= 0 && vy1 < vc && vz1 >= 0 && vz1 < vc) {
        // NOTE: the HTML uses /10.0 here (vs /100.0 above). Preserved verbatim
        // to keep bit-identical output. TODO: verify intended behaviour.
        const d = dose_arr[(vz1 * vc + vy1) * vc + vx] / 10.0;
        const l = d * K;
        lambda[n + base + b] = l;
        direct_expected += l;
      }
    }
  }

  return { direct_ssb: direct_expected, lambda };
}

/**
 * Spatially-local expected DSB calculation.
 *
 * Treats each bp density as `lambda_direct[b] + indicator(indirect_hit[b])`
 * per strand. For each strand-0 bp b, window-sum strand-1 densities over
 * [b-W, b+W] and accumulate the product. Window size W comes from
 * {@link DSB_WINDOW_BP}.
 */
export function expectedDSBLocal(
  dna: DNATarget,
  direct_lambda: Float32Array,
  indirect_hits: Uint8Array,
): number {
  const W = DSB_WINDOW_BP;
  const n = dna.n_bp;
  const n_per = dna.n_bp_per;
  let dsb_expected = 0;

  const s0 = new Float32Array(n_per);
  const s1 = new Float32Array(n_per);

  for (let fi = 0; fi < dna.n_fibers; fi++) {
    const base = fi * n_per;
    let sum_s0 = 0;
    let sum_s1 = 0;
    for (let b = 0; b < n_per; b++) {
      const v0 = direct_lambda[base + b] + (indirect_hits[base + b] === 1 ? 1 : 0);
      const v1 = direct_lambda[n + base + b] + (indirect_hits[n + base + b] === 1 ? 1 : 0);
      s0[b] = v0;
      s1[b] = v1;
      sum_s0 += v0;
      sum_s1 += v1;
    }
    if (sum_s0 === 0 || sum_s1 === 0) continue;

    let window_s1 = 0;
    for (let b = 0; b <= Math.min(W, n_per - 1); b++) window_s1 += s1[b];

    for (let b = 0; b < n_per; b++) {
      dsb_expected += s0[b] * window_s1;
      const lo_out = b - W;
      const hi_in = b + 1 + W;
      if (hi_in < n_per) window_s1 += s1[hi_in];
      if (lo_out >= 0) window_s1 -= s1[lo_out];
    }
  }

  return dsb_expected;
}

/**
 * Cluster SSBs on both strands into DSBs.
 *
 * Integer DSB: greedy pairing of strand-0 and strand-1 SSBs within ±{@link DSB_WINDOW_BP} bp
 * on the same fiber.
 *
 * Expected DSB: uniform-random closed-form approximation for single fibers:
 *    E[DSB_per_fiber] = 1 − (1 − (2W+1) / L)^(k0 · k1)
 * For low density k·W/L ≪ 1 this simplifies to k0 · k1 · (2W+1) / L. Reported
 * alongside the integer count because at low stats the integer number is
 * often 0 and noisy.
 */
export function clusterDSB(dna: DNATarget, hits: Uint8Array): DSBClusterResult {
  const n = dna.n_bp;
  const n_per = dna.n_bp_per;
  const W = DSB_WINDOW_BP;
  const window_bp = 2 * W + 1;

  let dsb_int = 0;
  let dsb_expected = 0;
  let ssb0_tot = 0;
  let ssb1_tot = 0;

  const fiber_has_any = new Uint8Array(dna.n_fibers);
  for (let fi = 0; fi < dna.n_fibers; fi++) {
    const base = fi * n_per;
    for (let b = 0; b < n_per; b++) {
      if (hits[base + b] || hits[base + b + n]) {
        fiber_has_any[fi] = 1;
        break;
      }
    }
  }

  for (let fi = 0; fi < dna.n_fibers; fi++) {
    if (fiber_has_any[fi] === 0) continue;
    const base = fi * n_per;
    const s0_bps: number[] = [];
    const s1_bps: number[] = [];
    for (let b = 0; b < n_per; b++) {
      if (hits[base + b] === 1) s0_bps.push(b);
      if (hits[base + b + n] === 1) s1_bps.push(b);
    }
    const k0 = s0_bps.length;
    const k1 = s1_bps.length;
    ssb0_tot += k0;
    ssb1_tot += k1;

    // Integer clustering — greedy pairing within ±W bp.
    const used1 = new Uint8Array(k1);
    let j_lo = 0;
    for (const b0 of s0_bps) {
      while (j_lo < k1 && s1_bps[j_lo] < b0 - W) j_lo++;
      for (let j = j_lo; j < k1 && s1_bps[j] <= b0 + W; j++) {
        if (used1[j] === 0) {
          used1[j] = 1;
          dsb_int++;
          break;
        }
      }
    }

    if (k0 > 0 && k1 > 0 && n_per > 0) {
      const p_pair = Math.min(1, window_bp / n_per);
      const n_pairs = k0 * k1;
      const p_no_dsb = Math.pow(1 - p_pair, n_pairs);
      dsb_expected += 1 - p_no_dsb;
    }
  }

  return { dsb: dsb_int, dsb_expected, ssb0: ssb0_tot, ssb1: ssb1_tot };
}

/**
 * Combine direct + indirect strand-hit arrays by bit-OR.
 * Helper used by runValidation when both scoring passes ran.
 */
export function combineHits(a: Uint8Array, b: Uint8Array): Uint8Array {
  const n = a.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] | b[i] ? 1 : 0;
  return out;
}

/** Deterministic LCG used in HTML runValidation so SSB rolls are reproducible. */
export function makeSsbRng(seed = 0x12345678 >>> 0): Rng {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
