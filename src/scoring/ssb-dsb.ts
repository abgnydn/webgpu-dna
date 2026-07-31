/**
 * SSB/DSB scoring — direct port from public/geant4dna.html.
 *
 * Two scoring paths:
 *  1. `scoreIndirectSSB` — loops surviving OH at t=1 μs. Each OH within the
 *     backbone reach radius (r_bb + r_damage) may create a single-strand break
 *     with probability `SSB_P_INDIRECT`.
 *  2. `scoreDirectSSB_events` — loops ionization/excitation sites stored in
 *     rad_buf and accumulates each event's deposited energy (`rad_e`) into its
 *     nearest sugar-phosphate site, then breaks that site once with the
 *     Nikjoo/Charlton ramp `P(E)=clamp((E−SSB_E_LOW)/(SSB_E_HIGH−SSB_E_LOW),0,1)`.
 *     It preserves the nm-scale spatial correlation that voxel dose smears out.
 *
 * DSB clustering: `clusterDSB` — greedy pairing of strand-0 and strand-1 SSBs
 * within ±DSB_WINDOW_BP.
 */
import {
  SSB_R_DAMAGE_NM,
  SSB_R_DAMAGE_INDIRECT_NM,
  SSB_P_INDIRECT,
  SSB_E_LOW,
  SSB_E_HIGH,
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
 * Score direct SSBs from rad_buf ionization/dissociation-site positions.
 *
 * Direct damage is scored **once per dissociation event**, at the site where the
 * parent water molecule dissociated (the "mother" position). The scorer must
 * therefore collapse all of an event's rad_buf entries down to that single site.
 *
 * Two things make a naive "compare the next entry" de-dup wrong (it over-counted
 * `SSB_dir` by ~2x before this was fixed):
 *   1. An event emits **up to 3** rad_buf entries, not 2 — e.g. the dominant
 *      no-recomb ionization channel writes OH, e-aq, H3O+ (primary.wgsl:285-288),
 *      and the recomb / dissociative-attachment channels write a 3rd entry too.
 *   2. The ejected electron (e-aq, species 1 or 5) is written at a **displaced**
 *      thermalization point (primary.wgsl:535,618; secondary.wgsl:118,286), so it
 *      breaks the run of identical mother positions and, if scored, double-books
 *      the same electron that `scoreIndirectSSB` already counts as a chemistry
 *      source.
 *
 * Fix: skip the displaced e-aq (species 1, 5) and the non-radical H2 marker
 * (species 7) entirely — they are not energy deposited at the backbone — then
 * collapse consecutive entries that share the mother position into one roll.
 * What remains (OH, H, H3O+, O, OH-) is emitted at the mother site, so each event
 * yields exactly one site.
 *
 * Accumulated-volume energy-threshold model (Nikjoo/Charlton). For each unique
 * event: snap to nearest fiber → nearest bp → nearest backbone atom; if within
 * `r_direct` (0.29 nm), ADD its deposited energy (`rad_e`, eV) to that sugar
 * site's running total. After all events, break each site ONCE with
 * P = clamp((E_acc − E_low)/(E_high − E_low), 0, 1). Summing overlapping
 * deposits before thresholding is the physically-faithful direct model — a
 * single sub-threshold ionisation can't break a sugar, but several can. No
 * tuned knob. (The per-event variant — threshold each deposit independently —
 * is the more conservative bracket; see artifact E31.)
 */
export function scoreDirectSSB_events(
  dna: DNATarget,
  rad_buf: Float32Array,
  rad_e: Float32Array,
  rad_n: number,
  rng: Rng,
): DirectSSBResult {
  const r_direct = SSB_R_DAMAGE_NM;
  const r_direct2 = r_direct * r_direct;
  const e_span = SSB_E_HIGH - SSB_E_LOW;
  const hits = new Uint8Array(dna.n_bp * 2);
  // Energy accumulated in each (bp, strand) sugar-phosphate site across all
  // nearby ionisation events — thresholded once at the end.
  const E_acc = new Float32Array(dna.n_bp * 2);
  const x_half = (dna.n_bp_per - 1) * dna.rise * 0.5;
  const rise_inv = 1 / dna.rise;
  const grid_off = -((dna.grid_N - 1) * dna.spacing_nm) * 0.5;
  const inv_spacing = 1 / dna.spacing_nm;

  let candidates = 0;
  let in_reach = 0;
  let ssb_count = 0;

  // Track the last mother-site position we scored so repeated entries from the
  // same event collapse to one roll. NaN so the first real entry always differs.
  let last_x = NaN;
  let last_y = NaN;
  let last_z = NaN;

  for (let i = 0; i < rad_n; i++) {
    // Species code is packed into .w as pid*8 + species (see rad-buf-encoding).
    const species = Math.round(rad_buf[i * 4 + 3]) % 8;
    // Skip the ejected electron (e-aq, at a displaced thermalization point — an
    // INDIRECT seed, already counted by scoreIndirectSSB) and the non-radical H2
    // marker. Skipping them is also what lets the mother-site entries collapse.
    if (species === SPECIES.eaq || species === 5 || species === SPECIES.H2) continue;

    const x = rad_buf[i * 4 + 0];
    const y = rad_buf[i * 4 + 1];
    const z = rad_buf[i * 4 + 2];
    // One roll per event: entries sharing the exact mother position are the same
    // dissociation site (distinct ionization sites never share an fp position).
    if (x === last_x && y === last_y && z === last_z) continue;
    last_x = x;
    last_y = y;
    last_z = z;

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
      // Accumulate this event's deposit into its nearest sugar-phosphate site.
      const global_bp = fiber_idx * dna.n_bp_per + best_bp;
      const idx = global_bp + best_strand * dna.n_bp;
      E_acc[idx] += rad_e[i];
    }
  }

  // Threshold ONCE per sugar site on the accumulated energy (Nikjoo/Charlton
  // ramp). Summing overlapping deposits before thresholding is what a single
  // sub-threshold ionisation cannot do — the physically-faithful direct model.
  for (let idx = 0; idx < E_acc.length; idx++) {
    const e = E_acc[idx];
    if (e <= SSB_E_LOW) continue;
    const p_break = e >= SSB_E_HIGH ? 1 : (e - SSB_E_LOW) / e_span;
    if (rng() < p_break) {
      hits[idx] = 1;
      ssb_count++;
    }
  }

  return { hits, ssb_count, candidates, in_reach };
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

  let dsb_int = 0;
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
  }

  return { dsb: dsb_int, ssb0: ssb0_tot, ssb1: ssb1_tot };
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
