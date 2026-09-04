# Tunables ledger

A complete, audited inventory of every non-physical-constant scalar in the
pipeline, so "parameter-free" is never ambiguous. The honest one-line summary:

> **The whole pipeline is now parameter-free / data-sourced — including
> DNA-damage scoring.** The two former calibrated probabilities
> (`SSB_P_DIRECT`, `SSB_P_INDIRECT`) were replaced with physical values
> (2026-07): direct = a Nikjoo/Charlton **accumulated-volume energy threshold**
> (sum each event's deposit per sugar site, then ramp; `E_low`=5, `E_high`=37.5 eV;
> the shaders emit the energy via `rad_e`), indirect = 0.13 (Nikjoo OH+deoxyribose → SSB branching).
> **Category C is now empty.** The consequence: the indirect/direct SSB ratio
> is a *prediction*, not tuned to PARTRAC's band — and it does land outside it
> (**5.74** accumulated-volume, scored at the true energy-deposit site [E33]) — the
> honest outcome. The threshold-free `P=1` limit gives **2.34, in-band** [E33]; the
> span brackets the physics without any tuning. (Scoring at the true deposit site,
> not the ~2 nm displaced radical, raised direct SSB 27→35 and dropped the ratio
> 7.1→5.74; the energy threshold — not localization — is the residual gap.)
> SSB/DSB is still labelled *methodology* in [README §Numbers](./README.md#numbers)
> because the fibre grid is a track-core stand-in (category B), not chromatin.

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
| `DSB_WINDOW_BP` | 10 | `constants.ts:175` | ±10 bp clustering — standard convention (Friedland/PARTRAC). |
| `SSB_R_DAMAGE_NM` | 0.29 | `constants.ts:153` | Nikjoo OH-backbone reaction radius (sourced, but a modelling choice). |
| `SSB_R_DAMAGE_INDIRECT_NM` | 1.0 | `constants.ts:154` | PARTRAC-effective (folds OH diffusion-to-encounter) — chosen. |

## C. Calibrated to a target (the only knobs)

**Empty as of 2026-07.** The two former knobs were de-calibrated and moved to
category A (data-sourced). There are now **no scalars anywhere in the pipeline
tuned to reproduce a validation number** — including in DNA-damage scoring.

| Former knob | Was | Now | Change |
|:---|:---|:---|:---|
| ~~`SSB_P_INDIRECT`~~ | 0.05 (tuned 0.4→0.05 to land the indirect/direct ratio in PARTRAC's 2–3 band) | **0.13** | Nikjoo OH+deoxyribose → SSB branching (Nikjoo 1997/2001; used by PARTRAC). Data-sourced. |
| ~~`SSB_P_DIRECT`~~ | 0.15 (uncited flat probability) | **accumulated-volume energy threshold** `SSB_E_LOW=5.0`, `SSB_E_HIGH=37.5` eV | Sum each event's deposit per sugar site (shaders emit energy via `rad_e` + true deposit site via `rad_dep`), threshold once with the Nikjoo/Charlton ramp — scored at the true energy-deposit site, not the displaced radical. Data-sourced bond-energy thresholds, not tuned. Deposit-site brackets: accumulated 5.74, threshold-free `P=1` 2.34 in-band [E33]. |

Consequence: the indirect/direct SSB **ratio is now a prediction**, not tuned —
the encounter-proxy value is **5.74** (above band [E33]); with the shipped
**explicit OH+deoxyribose competing-reactant channel** (molecularDNA structure,
same `p_ssb`=0.13) it is **2.28, in band** [E39/E40/E41] — the 5.74 was
encounter-proxy over-counting, not a fit residual. The remaining SSB modelling
choices (reaction radii, fibre grid) are category B above, not fits.
