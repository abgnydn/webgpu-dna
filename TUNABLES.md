# Tunables ledger

A complete, audited inventory of every non-physical-constant scalar in the
pipeline, so "parameter-free" is never ambiguous. The honest one-line summary:

> **The track-structure physics and the IRT chemistry are parameter-free /
> data-sourced. The DNA-damage *scoring* layer has two calibrated probabilities
> (`SSB_P_DIRECT`, `SSB_P_INDIRECT`) — which is exactly why [README §Numbers](./README.md#numbers)
> labels SSB/DSB as *methodology*, not validated absolute physics.**

Categories:

- **A. Data-sourced** — traceable to a Geant4 source file or a cited paper. Not free.
- **B. Methodology choice** — geometry/model scaffolding (e.g. the fibre grid), not a
  physics value; documented as a divergence in [`GEANT4_DIVERGENCES.md`](./GEANT4_DIVERGENCES.md).
- **C. Calibrated to a target** — genuinely tuned to land a validation number. These
  are the only "knobs". Both live in DNA-damage scoring.

Every row was verified against the source at the cited location (not the prose
self-description) on 2026-06-23.

## A. Data-sourced (not free)

| Constant | Value | Where | Provenance |
|:---|:---|:---|:---|
| `SIGMA_EXC_SCALE` | **1.0** (neutral) | `src/shaders/helpers.wgsl` | v0.7.0 loads the real Born excitation XS directly (E29); scale is a no-op. |
| `RECOMB_BOOST` | **1.0** (neutral) | `src/shaders/helpers.wgsl` | Removed v0.5.0 (the H₂O⁺ refutation); not load-bearing (E10r). |
| `BIND` (5 shells) | 10.79…539.0 eV | `constants.ts:15` | G4DNAWaterIonisationStructure.cc |
| `EXC_E` (5 levels) | 8.22…13.77 eV | `constants.ts:19` | G4DNAEmfietzoglouWaterExcitationStructure.cc |
| `VIB_LEV` (9 modes) | 0.01…0.835 eV | `constants.ts:23` | G4DNASancheExcitationModel.cc |
| `DIFFUSION` (4 species) | 2.2…9.0 nm²/ns | `constants.ts:27` | G4OH/Electron_aq/Hydrogen/Hydronium.cc |
| `SOLVATION_THRESHOLD` | 7.4 eV | `constants.ts:46` | G4EmDNABuilder.cc:314 (DNA_Opt2 emaxT) |
| Dissociative branching | 55% / 50% autoionisation, etc. | `primary.wgsl:435-436` | G4DNA dissociative channels (documented inline) |
| eaq thermalization | 1.7 eV → σ=1.764 nm/axis | `primary.wgsl:482`, `chemistry.wgsl:350` | Meesungnoen 2002 (autoionisation default) |
| Product displacement σ | [0.462, 1.764, 1.309] nm | `irt.ts:240` | G4 WaterDissociationDisplacer (per-axis 1D) |
| Mother displacement | 2.0 nm RMS | shaders | G4DNA ionisation OH+H₃O⁺ |
| IRT reaction radii + `pc` | 9-reaction table | `constants.ts:73-101` | Karamitros 2011 / chem6 `beam.in` rate constants |

## B. Methodology choices (geometry/model, not physics values)

| Constant | Value | Where | Note |
|:---|:---|:---|:---|
| `DNA_LENGTH_NM` | 3000 | `constants.ts:129` | Fibre grid is a track-core stand-in, **not chromatin** (GEANT4_DIVERGENCES). |
| `DNA_GRID_N` | 21 | `constants.ts:130` | 21×21 fibres. SSB ratio is robust to this (E27 swept 75–300 nm). |
| `DNA_SPACING_NM` | 150 | `constants.ts:131` | as above |
| `DSB_WINDOW_BP` | 10 | `constants.ts:166` | ±10 bp clustering — standard convention (Friedland/PARTRAC). |
| `SSB_R_DAMAGE_NM` | 0.29 | `constants.ts:153` | Nikjoo OH-backbone reaction radius (sourced, but a modelling choice). |
| `SSB_R_DAMAGE_INDIRECT_NM` | 1.0 | `constants.ts:154` | PARTRAC-effective (folds OH diffusion-to-encounter) — chosen. |

## C. Calibrated to a target (the only knobs)

| Constant | Value | Where | What it's tuned to |
|:---|:---|:---|:---|
| **`SSB_P_INDIRECT`** | 0.05 | `constants.ts:164` | Tuned **0.4 → 0.05** to land the indirect/direct ratio in PARTRAC's 2–3 band (E13c). v0.7.0's Born physics drifted it to 3.26 — reported, not re-tuned. |
| **`SSB_P_DIRECT`** | 0.15 | `constants.ts:165` | Sets the direct-SSB count directly (`SSB_dir = ⌊reach × 0.15⌋`, E13c). **No source citation** — a chosen scoring probability. |

Both knobs are confined to the DNA-damage scoring layer. There are **no calibrated
scalars in the track-structure physics or the chemistry**.
