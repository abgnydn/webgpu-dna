# Where this build deliberately differs from Geant4-DNA `DNA_Opt2`

One page, so anyone (including future-us) can see exactly where the WGSL
physics departs from Geant4-DNA's `DNA_Opt2` defaults, **why**, and **what it
costs**. Every divergence is tracked by a falsifiable experiment in
[`README.md` § Numbers](./README.md#numbers) — the numbers below come from
there, nowhere else.

**The headline:** the way we *use* Geant4 is standard — a normally-compiled
Geant4 11.4.1 / G4EMLOW 8.8 install is the validation oracle (the same way
GGEMS / gMicroMC / GPUMCD validate). The divergences below are deliberate
modelling choices and a couple of tuning knobs, all labelled — not bugs. The
validation ladder exists precisely so each one shows up as a documented row
instead of hiding.

## What we DON'T diverge on (faithful to Geant4)

So the divergence list reads against the right backdrop — these match Geant4:

- **Born ionisation** (5 shells) — same model and data as `DNA_Opt2`.
- **Born excitation** (5 levels) — same model and data as `DNA_Opt2` since
  v0.7.0 (E29); the earlier Emfietzoglou hybrid + `SIGMA_EXC_SCALE` is gone.
- **Champion elastic** — G4EMLOW total XS + angular CDF across the full range
  (no screened-Rutherford formula remains in `src/`).
- **Sanche vibrational** — bit-exact (E4).
- **Karamitros 2011 9-reaction IRT chemistry as the base** — same rates,
  diffusion coefficients, VDW radii as `G4EmDNAChemistry_option1` / chem6;
  the worker additionally carries a 38-reaction oxygen network from
  `G4EmDNAChemistry_option3` (47 rows total), so "9-reaction" describes the
  base, not the full table.
- **e⁻aq thermalisation at 1.7 eV** (Meesungnoen 2002, Geant4 autoionisation
  default) and **2.0 nm mother displacement** — both match Geant4.

Cross sections agree to **peak ratios 0.975–1.000** (median devs ~1e-3);
CSDA range is **0.997×** Geant4 at 10 keV under v0.7.0 Born excitation
(E29; the older 0.988× was the scaled-Emfietzoglou value) — i.e. the
faithful parts are genuinely faithful (L1, E5/E29).

## Deliberate divergences

### A. Model choices

| # | `DNA_Opt2` | This build | Why | Cost / tracked in |
|---|---|---|---|---|
| ~~A1~~ | ~~**Born** excitation (`G4DNABornExcitationModel`) vs **Emfietzoglou**~~ | **RETIRED — both sides now use Born excitation (v0.7.0, E29).** The Emfietzoglou hybrid + `SIGMA_EXC_SCALE` era is over; see B1. | ~~Emfietzoglou σ_exc was **2.55× Geant4's effective value**~~ → real Born XS closed the sub-keV CSDA deficit (100 eV 0.782→0.956×, all 8 energies 0.956–1.005×). [E6b, E29] |

### B. Tuning knobs (the honest fudges)

| # | Knob | Value | Why it's there | Cost / tracked in |
|---|---|---|---|---|
| ~~B1~~ | ~~`SIGMA_EXC_SCALE`~~ | **REMOVED — v0.7.0 uses the real Born excitation XS 2026-06-09** | Was a flat scalar (0.5, later 0.39) approximating Born by down-scaling Emfietzoglou. | **Removed: a physics-list audit (E29) showed option2 — the list both Geant4 oracles register — uses Born excitation, not Emfietzoglou. Swapping in the real Born XS (scalar gone) closed the chronic sub-keV CSDA deficit (100 eV 0.782→0.956×, all 8 energies 0.956–1.005×) and nudged the cascade to 0.942× (then emitting the K-shell Auger electron → **0.981×**, E35). Track-structure physics is now parameter-free.** [E29, E35] |
| ~~B2~~ | ~~`RECOMB_BOOST`~~ | **REMOVED — set to 1.0 (neutral) 2026-06-08** | Was the one genuinely un-physical knob (no Geant4 basis — the H₂O⁺ refutation). | **Removed after the RECOMB→1.0 flip passed all three gates:** cascade ions *recover* 0.677→0.766× [E7d], chemistry parameter-free at +1.4 pp RMS and *improves* OH/eaq/H [E10r], SSB ratio *holds* in PARTRAC's 2–3 band at 2.32 with no recalibration [E13d]. No longer a divergence — production, README, and paper all run RECOMB_BOOST=1.0. [E7d, E10r, E13d] |

> B1 + B2 are coupled: improving CSDA/chemistry via these knobs *worsens*
> cascade ions. This "two-knob structural limit" is documented in E10i/E7b and
> is what the open theories (super-excitation autoionisation; Onsager escape
> probability) aim to dissolve — replacing the knobs with real physics.

### C. Tractability-forced approximations

| # | Geant4 chem6 | This build | Why | Cost / tracked in |
|---|---|---|---|---|
| C1 | IRT over **all primaries in one pool** | **Per-primary** IRT (`priMap`) | Cross-primary IRT is O(N²)-hard for a point source (551 nm horizon spans the blob) → ~71 hr in-browser. Needs a native runtime. | Misses inter-track reactions: **ΔG(H₂) = +0.149 at 1 µs** on H₂ alone [E10f]. **Interpretation superseded**: E17 showed cross-primary pooling is a coupled H₂↑/OH↓ tradeoff (not the chem6-gap fix), and v0.6.0 showed the gap was the untracked tertiary cascade, closed browser-native (RMS 19.7→7.6%, E25). [E10f, E17, E25, CROSS_PRIMARY_IRT + GPU_SBS findings] |
| C2 | (n/a) | GPU chemistry backend (`chemistry.wgsl`) | A fast CSDA-only alternative to the IRT worker. | Undercounts long-time reactions; **default backend is `'worker'` (IRT)** so production never uses it. [E11] |

### D. Numerical / geometry

| # | Reference | This build | Why | Cost / tracked in |
|---|---|---|---|---|
| D1 | fp64 CPU | **fp32** GPU `atomicAdd` (fixed-point ×100/eV for dose) | WGSL atomics are integer-only; fp32 is the GPU native. | Results are statistically equivalent across vendors but **not bit-exact** (same machine+seed+shader *is*). [§Numbers reproducibility caveat] |
| D2 | bulk / realistic DNA geometry | **21×21 concentrated fiber grid** sampling the track core | Simpler scoring target. | The box-average per-Da yields look 223×/796× high, but E12-local shows this is a **point-source dose artifact**: 98.1% of energy deposits in the central 3 µm core (`start_half=0`), so local dose ≈238 Gy (C≈981). Per *local* dose, absolute yields are **SSB_dir 0.34× / DSB 0.82× / SSB_total 1.28×** of experiment (Ward 1988) — within ~3×, geometry defense **quantitatively vindicated**. Residual: the strand-break *ratio* is now **parameter-free** — indirect uses the Nikjoo OH+deoxyribose→SSB branching (`SSB_P_INDIRECT=0.13`, data-sourced, not tuned) and direct a Nikjoo/Charlton energy-threshold ramp (`E_low=5`/`E_high=37.5` eV, no tuned probability), so the ratio is a *prediction*, not a fit: **5.74 (accumulated-volume, scored at the true energy-deposit site [E33])**, threshold-free `P=1` limit **2.34 in-band** [E33] — the encounter-proxy release lands **above** PARTRAC's 2–3 band (honest-negative; correcting a ~2 nm scoring-position error dropped it 7.1→5.74). **Update (2026-08, shipped default):** making the deoxyribose an **explicit competing IRT reactant** (molecularDNA structure) gives **2.28 at 10 keV, in-band, parameter-free** [E39/E40/E41] — the 5.74 was encounter-proxy over-counting, not geometry. [E12, E12-local, E30, E31, E33, E39, E40, E41] |

## The one-line version
We use Geant4 the standard way (as the oracle), match it on the core
transport physics, and diverge in a short, labelled list: no active model
swaps (A1 retired — both sides Born), no tuning knobs (B1/B2 removed), and a
few tractability/geometry approximations (C/D). Each costs something
specific, each cost is measured, and the biggest open ones have removal
plans.
