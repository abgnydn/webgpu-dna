/**
 * Shared type definitions — mirror the structs used by the monolithic
 * geant4dna.html so every module speaks the same shape.
 *
 * The TS types follow the `snake_case` names used in the HTML JS (to make
 * bit-for-bit parity obvious when reading both side-by-side). Per-module
 * helpers can re-shape this into camelCase where it matters.
 */

/** ESTAR reference entry (NIST liquid water stopping power) */
export interface EstarEntry {
  E: number;    // eV
  csda: number; // nm
  sp: number;   // eV/nm
}

/** B-DNA fiber grid target.
 * Layout: `grid_N × grid_N` straight parallel fibers along X at (fy[i], fz[i]).
 * Each fiber has `n_bp_per` base pairs at rise `rise`. Two helical backbone
 * strands are precomputed as (y,z) offsets relative to the fiber axis in
 * `rbb0` and `rbb1` (length = 2 × n_bp_per).
 */
export interface DNATarget {
  rise: number;
  r_bb: number;
  n_bp_per: number;
  n_fibers: number;
  n_bp: number;
  grid_N: number;
  spacing_nm: number;
  x0: number;
  L_nm: number;
  fy: Float32Array;
  fz: Float32Array;
  rbb0: Float32Array;
  rbb1: Float32Array;
}

/** Timeline checkpoint emitted by chem worker / GPU chemistry */
export interface ChemCheckpoint {
  label: string;
  t_ns: number;
  G_OH: number;
  G_eaq: number;
  G_H: number;
  G_H2O2: number;
  G_H2: number;
  alive_OH?: number;
  alive_eaq?: number;
  alive_H?: number;
  prod_H2O2?: number;
  prod_H2?: number;
}

/** Per-checkpoint snapshot of radical positions + alive flags. Subsampled
 *  to the first `n` radicals to keep blob size tractable for a 4D viewer. */
export interface ChemSnapshot {
  label: string;
  t_ns: number;
  n: number;          // number of subsampled radicals stored
  pos: Float32Array;  // length = 4*n  (xyz + species/pid packed in w)
  alive: Uint32Array; // length = n    (1=alive, 0=reacted)
}

export interface ChemResult {
  chem_n: number;
  t_wall: number;
  timeline: ChemCheckpoint[];
  chem_pos_final: Float32Array | null;
  chem_alive_final: Uint32Array | null;
  deposited_eV?: number;
  /** Filled only when runChemistry is invoked with `dump_snapshots: true`. */
  snapshots?: ChemSnapshot[];
  /**
   * Indirect-SSB accumulation during the IRT timeline. Filled when the
   * worker is given a DNA target via the `dna` + `ssbScoring` options.
   * Replaces the t=1μs-only scoreIndirectSSB scan in src/scoring/ssb-dsb.ts
   * (which under-counted because the IRT had already consumed most OHs
   * near DNA by t=1μs — see E13c).
   */
  ssb_indirect?: {
    ssb0: number;
    ssb1: number;
    total: number;
    candidates: number;
    in_reach: number;
    r_indirect: number;
    p_indirect: number;
  } | null;
}

/** Per-species alive snapshot from chemMeasure() */
export interface ChemAliveSnapshot {
  alive_OH: number;
  alive_eaq: number;
  alive_H: number;
  prod_H2O2: number;
  prod_H2: number;
}

/** Result of one energy run (runAtEnergy) */
export interface EnergyResult {
  E: number;
  n_therm: number;
  n_esc: number;
  mean_total: number;
  mean_prod: number;
  mean_sp: number;
  mean_ions: number;
  dt: number;
  t_prim: number;
  t_sec: number;
  sec_n: number;
  sec_dropped: number;
  sec_per_pri: number;
  sec_terminated_cutoff: number;
  sec_terminated_bounds: number;
  sec_steps: number;
  sec_tertiary_ions: number;
  total_deposited_eV: number;
  expected_deposited_eV: number;
  cons_ratio: number;
  rad_OH: number;
  rad_eaq: number;
  rad_H: number;
  G_OH: number;
  G_eaq: number;
  G_H: number;
  rad_n_raw: number;
  rad_n_stored: number;
  rad_dropped: number;
  kernel_dna_hits: number;
  chem_result: ChemResult | null;
  rad_buf_final: Float32Array | null;
}

/** Indirect SSB scoring output */
export interface IndirectSSBResult {
  hits: Uint8Array;
  ssb0: number;
  ssb1: number;
  candidates: number;
  in_reach: number;
}

/** Direct (event-level) SSB scoring output */
export interface DirectSSBResult {
  hits: Uint8Array;
  ssb_count: number;
  candidates: number;
  in_reach: number;
}

/** DSB clustering output */
export interface DSBClusterResult {
  dsb: number;
  dsb_expected: number;
  ssb0: number;
  ssb1: number;
}

/** One reaction channel (matches IRT_REACTIONS tuple order) */
export type ReactionTuple = readonly [
  speciesA: number,
  speciesB: number,
  R_nm: number,
  pc: number,
  product: number,
];

/** Logger signature used everywhere — (msg, css_class_or_empty) */
export type LogFn = (msg: string, cls?: string) => void;
