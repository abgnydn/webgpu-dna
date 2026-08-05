/**
 * Physics + runtime constants. Values sourced directly from the monolithic
 * geant4dna.html and cross-referenced with the cited Geant4 headers.
 */

import type { ReactionTuple } from './types';

// --- Water / physics ---

/** Water molecule number density (molecules / nm³, liquid 25 °C). */
export const NW = 33.4;

/** Ionization shell binding energies (eV).
 * Source: G4DNAWaterIonisationStructure.cc — 1b₁ 3a₁ 1b₂ 2a₁ 1a₁. */
export const BIND = [10.79, 13.39, 16.05, 32.30, 539.0] as const;

/** Emfietzoglou excitation level energies (eV).
 * Source: G4DNAEmfietzoglouWaterExcitationStructure.cc. */
export const EXC_E = [8.22, 10.0, 11.24, 12.61, 13.77] as const;

/** Sanche vibrational mode energy losses (eV).
 * Source: G4DNASancheExcitationModel.cc. */
export const VIB_LEV = [0.01, 0.024, 0.061, 0.092, 0.204, 0.417, 0.460, 0.500, 0.835] as const;

/** Diffusion coefficients (nm²/ns).
 * Source: G4OH.cc, G4Electron_aq.cc, G4Hydrogen.cc, G4Hydronium.cc. */
export const DIFFUSION = {
  OH: 2.2,
  eaq: 4.9,
  H: 7.0,
  H3O: 9.46, // G4Hydronium.cc (9.46e-9 m²/s); matches the production worker's IRT_D
} as const;

/** Species numeric codes (rad_buf .w / chem_pos .w). */
export const SPECIES = {
  OH: 0,
  eaq: 1,
  H: 2,
  H3O: 3,
  OHminus: 6,
  H2: 7,
} as const;

/** Solvation threshold (eV). Below this, electrons become eaq.
 * Source: G4EmDNABuilder.cc line 314 — emaxT = 7.4 eV for DNA_Opt2. */
export const SOLVATION_THRESHOLD = 7.4;

// --- Buffer / grid sizing (match monolithic HTML) ---

/** Secondary particle buffer — 5M × 48 B = 240 MB. */
export const MAX_SEC = 5_000_000;

/** Radical buffer — 16M × 16 B = 256 MB. */
export const MAX_RAD = 16_000_000;

/** Chemistry buffer — 8M × 16 B = 128 MB (chem_pos). */
export const CHEM_N = 8_000_000;

/** Voxel grid resolution (VC × VC × VC). */
export const VC = 128;

/** Chemistry spatial hash buckets (2²³ = 8M). */
export const HASH_SIZE = 8_388_608;

/** Secondary wavefront stepper cap (Champion elastic thermalization is slow). */
export const MAX_SEC_STEPS = 2000;

// --- Chemistry reaction tables (MUST mirror WGSL react_* arrays) ---

/** IRT reactions using contact probability pc (used by the GPU chemistry kernel;
 *  also by the unused reference irtChemistry() in irt.ts — not a runtime fallback).
 *  [speciesA, speciesB, R_nm, pc, product (0=none, 1=H2O2, 2=H2, 3=eaq→H)] */
export const IRT_REACTIONS: readonly ReactionTuple[] = [
  [0, 0, 0.44, 0.376, 1],  // OH+OH  → H2O2
  [0, 1, 0.57, 0.980, 0],  // OH+eaq → OH⁻
  [0, 2, 0.45, 0.511, 0],  // OH+H   → H2O
  [1, 1, 0.54, 0.125, 2],  // eaq+eaq→ H2
  [1, 2, 0.61, 0.455, 2],  // eaq+H  → H2
  [1, 3, 0.47, 0.538, 3],  // eaq+H3O+ → H   (Onsager σ=0.469)
  [2, 2, 0.34, 0.216, 2],  // H+H    → H2
];

/** Per-species diffusion coefficients (nm²/ns) in species-index order. */
export const IRT_D = [
  DIFFUSION.OH,
  DIFFUSION.eaq,
  DIFFUSION.H,
  DIFFUSION.H3O,
] as const;

// --- Reference G-values ---

/**
 * Karamitros 2011 G-values at 1 μs (molecules per 100 eV) — the **low-LET
 * escape-yield plateau** (≈MeV electrons / ⁶⁰Co γ), near the Buxton 1988
 * standard (G(e⁻aq)≈2.6, G(OH)≈2.7, G(H)≈0.6, G(H₂)≈0.45, G(H₂O₂)≈0.7).
 *
 * APPLE-TO-APPLE WARNING: this is NOT the matched-condition target for our
 * 10 keV runs. A 10 keV electron deposits at higher effective LET (short
 * ~2.7 µm track, dense end-of-track spurs → more intra-spur recombination →
 * genuinely lower escape yields), so a direct ratio of our 10 keV G-values to
 * these plateau numbers conflates real LET physics with implementation error.
 * The matched validation is vs Geant4 chem6 run at the same 10 keV (E10c:
 * OH 0.91×, eaq 0.83×). Use this constant only as the low-LET anchor, never as
 * the 10 keV pass bar.
 */
export const KARAMITROS_2011 = {
  G_OH: 2.50,
  G_eaq: 2.50,
  G_H: 0.57,
  G_H2O2: 0.73,
  G_H2: 0.42,
} as const;

// --- DNA target defaults ---

export const DNA_LENGTH_NM = 3000;
export const DNA_GRID_N = 21;
export const DNA_SPACING_NM = 150;

// --- SSB/DSB scoring ---

// SSB damage radii. The DIRECT and INDIRECT pathways have different
// physical origins and need different radii — they were briefly unified
// at 1.0 nm on 2026-05-11 to test the indirect fix, but E13c surfaced
// that the unified radius EXPLODED SSB_dir from 24 → 388 (~16× too
// many) because direct scoring uses rad_buf ionization sites that are
// already at the molecular scale. Split:
//
//   SSB_R_DAMAGE_NM             — direct pathway, Nikjoo reaction
//   SSB_R_DAMAGE_INDIRECT_NM    — indirect pathway, PARTRAC effective
//                                  (folds in OH diffusion-to-encounter
//                                  within the per-step window)
//
// E13c also showed that even at r_indirect = 1.0 nm, the late-time
// scoring at t = 1 μs gives SSB_ind = 0 because IRT consumes OHs near
// DNA before scoring sees them. The full fix requires accumulating
// indirect hits during the IRT timeline (pending — option (b) in
// PHYSICS_DIAGNOSIS.md §3). The split constant here is correct and
// future-proof for that follow-up.
export const SSB_R_DAMAGE_NM = 0.29;            // direct pathway, Nikjoo OH-backbone reaction radius
export const SSB_R_DAMAGE_INDIRECT_NM = 1.0;    // indirect pathway, PARTRAC-effective (diffusion folded)
// Parameter-free SSB scoring (no calibrated fit). History: SSB_P_INDIRECT was
// 0.05, tuned 0.4→0.05 to land the indirect/direct ratio in PARTRAC's 2–3 band
// (E13c) — a fit to a target. Removed 2026-07: the two damage probabilities are
// now physical, not tuned, so the indirect/direct ratio is a PREDICTION (it may
// land outside PARTRAC's band — that is the honest outcome, not a regression).
//
//  - Indirect: the branching probability that an OH radical reacting with the
//    2-deoxyribose sugar produces a strand break (vs. restitution) ≈ 0.13,
//    Nikjoo et al. 1997/2001 (also used by PARTRAC). Data-sourced, not tuned.
//  - Direct: energy-threshold model — a strand break occurs with a probability
//    that ramps linearly from 0 at SSB_E_LOW to 1 at SSB_E_HIGH in the deposited
//    energy at the ionisation site (within the reaction radius). Nikjoo/Charlton
//    linear-probability model. This supersedes the flat P=1 threshold-free limit
//    now that the shaders emit per-event deposited energy (rad_e buffer).
export const SSB_P_INDIRECT = 0.13;      // Nikjoo OH+dRibose → SSB branching (data-sourced, not tuned)
// Indirect-SSB mechanism: the deoxyribose is an EXPLICIT competing IRT reactant
// (Geant4-DNA molecularDNA structure) — an OH damages a sugar only when it actually
// reacts with it before its radical reactions (first-passage, k=2.5e9 Buxton), not
// merely when it dies within r_indirect of a backbone. This is the faithful model:
// it gives indirect/direct = 2.28 at 10 keV, IN PARTRAC's 2–3 band, parameter-free
// [E39/E40], vs the encounter proxy's 5.74 (which over-counted every near-backbone
// OH — only ~20% actually react with the sugar). false → the legacy encounter proxy.
export const SSB_EXPLICIT_DNA_REACTION = true;
// Direct-SSB energy-threshold ramp (Nikjoo 1997 / Charlton 1989 linear model):
// P(break) = clamp((E_dep − E_low)/(E_high − E_low), 0, 1). Physical bond-energy
// thresholds, not tuned to a target.
export const SSB_E_LOW = 5.0;            // eV — below this a deposit never breaks the backbone
export const SSB_E_HIGH = 37.5;          // eV — at/above this a deposit always breaks it
export const DSB_WINDOW_BP = 10;         // ±bp clustering window for DSB pairing
