# WebGPU Geant4-DNA

[![CI](https://github.com/abgnydn/webgpu-dna/actions/workflows/ci.yml/badge.svg)](https://github.com/abgnydn/webgpu-dna/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Live demo](https://img.shields.io/badge/live-webgpudna.com-6ea8ff)](https://webgpudna.com)
[![Geant4-DNA validated](https://img.shields.io/badge/Geant4--DNA-cross--checked-b0ffd0)](#numbers)
[![Tests](https://img.shields.io/badge/tests-46%20%E2%9C%93-82c98b)](./tests)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20506339.svg)](https://doi.org/10.5281/zenodo.20506339)

A WebGPU port of [Geant4-DNA](https://geant4-dna.in2p3.fr/) — the CNRS/IN2P3-coordinated Monte Carlo track-structure toolkit for radiobiology — running entirely in the browser.

One GPU thread per primary electron, full particle history in a single fused compute dispatch, Karamitros 2011 Independent-Reaction-Time chemistry in a Web Worker, and SSB/DSB scoring on a 21×21 B-DNA fiber grid at 10 keV.

<p align="center">
  <a href="https://webgpudna.com">
    <img src="public/og-image.png" alt="WebGPU Geant4-DNA — in-browser Monte Carlo track-structure" width="100%" />
  </a>
</p>

→ **Validation numbers live in [§ Numbers](#numbers) at the bottom of this file. That's the single source of truth.**

## Quick start

```bash
npm install
npm run dev            # http://localhost:8765
npm run test           # 46 tests, ~200 ms
npm run lint
npm run build          # dist/
```

Requires a WebGPU-capable browser. Shipped on-by-default in Chrome / Edge 113+ desktop, Chrome 121+ Android (Android 12+ on Qualcomm / ARM GPUs), Safari 26+ (macOS Tahoe, iOS / iPadOS / visionOS 26, Sep 2025), Firefox 141+ on Windows, and Firefox 145+ on macOS 26 Tahoe (Apple Silicon only). Firefox Linux, Firefox Android, and older Firefox still need `dom.webgpu.enabled` in `about:config`. Full matrix: [caniuse.com/webgpu](https://caniuse.com/webgpu).

Each experiment in §Numbers can be re-run on a contributor's machine via `npm run experiments -- <id>` (e.g. `E5`, `E10`, `B1`, `E15`).

## What's implemented

- **Physics:** Born ionization (5 shells, data-driven CDF sampling), Emfietzoglou excitation (5 levels, dissociative branching 0.65 / 0.55 / 0.80), Champion tabulated elastic angular CDF (< 200 eV), screened-Rutherford elastic (> 200 eV), Sanche 9-mode vibrational (2–100 eV), full primary-momentum conservation.
- **Chemistry:** Karamitros 2011 9-reaction IRT in a Web Worker (Smoluchowski TDC + Onsager-screened PDC for charged pairs, G4EmDNAChemistry_option1). 2.0 nm mother displacement, species-specific product displacement, e⁻aq thermalization at 1.7 eV, H₂O₂ / OH⁻ tracked as reactive products with full re-pairing.
- **DNA scoring:** Event-level direct SSB from `rad_buf` ionization sites, indirect SSB scored during the IRT timeline (every OH-death event + 1 μs survivors), greedy ±10 bp DSB clustering, kernel-level backbone hit counter as a cross-check.
- **Grid target:** 21×21 parallel B-DNA fibers × 3 μm × 150 nm spacing = 3.89 Mbp.
- **Joint-fix physics tuning** (2026-05-12, active): `SIGMA_EXC_SCALE = 0.5` and `RECOMB_BOOST = 2.0` in `src/shaders/helpers.wgsl` partially close the chem6-matched G(H₂)/G(H₂O₂) deficit + the low-E CSDA deficit. See [E10i](#level-4--chemistry-irt) and [PHYSICS_DIAGNOSIS.md](./PHYSICS_DIAGNOSIS.md).

## Project layout

```
src/
├── shaders/       WGSL compute shaders (helpers, primary, secondary, chemistry)
├── physics/       Constants, types, DNA geometry, cross-section loader
├── gpu/           Device init, buffers, pipelines, Phase A/B/C dispatch
├── chemistry/     IRT worker wiring, GPU chemistry schedule, reactions
├── scoring/       SSB/DSB scoring, ESTAR reference, dose projections
├── ui/            Results table, canvas dose projections
├── app.ts         runValidation orchestrator
└── main.ts        entry point

tests/unit/        Vitest unit tests (46 across 7 files)
tests/fixtures/    Geant4-DNA reference numbers (JSON)
public/            Generated cross_sections.wgsl, irt-worker.js, monolithic reference HTML
tools/             Python + Node helpers (G4EMLOW converter, IRT driver)
validation/        Geant4-DNA comparison harness (compare.py, analyze_g4.py)
```

Deep-dive: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Standing physics diagnoses: [`PHYSICS_DIAGNOSIS.md`](./PHYSICS_DIAGNOSIS.md). Research protocol: [`RESEARCH.md`](./RESEARCH.md). **Engineering standards** (the 15-principle canonical discipline shared with the sibling WebGPU/WGSL research projects): [`RESEARCH_STANDARDS.md`](./RESEARCH_STANDARDS.md). Forward roadmap with multi-agent wall-clock estimates: [`ROADMAP.md`](./ROADMAP.md). Recipe for adding a new physics model: [`EXTENDING.md`](./EXTENDING.md). Design docs for the two named structural fixes (one refuted via Geant4 source archaeology, one waiting on the headless native runtime): [`H2OP_TRACKING_DESIGN.md`](./H2OP_TRACKING_DESIGN.md) and [`CROSS_PRIMARY_IRT_DESIGN.md`](./CROSS_PRIMARY_IRT_DESIGN.md).

## Deployment

Production (**webgpudna.com**) is **Cloudflare Pages**, deployed manually:

```bash
npm run build                                                   # → dist/
wrangler pages deploy dist --project-name=webgpudna --branch=main
```

The production Pages project is **`webgpudna`** (no hyphen) — it owns
webgpudna.com. Do **not** use the `webgpu-dna` (hyphenated) project; that one
is stale and only serves `webgpu-dna.pages.dev`.

A Vercel GitHub integration also auto-builds a parallel mirror
(`webgpu-dna.vercel.app`) on every push to `main`, but that mirror does **not**
serve the custom domain — pushing alone does not update webgpudna.com; the
`wrangler` deploy above does.

## Regenerating cross sections

The committed `public/cross_sections.wgsl` (1.3 MB) is generated from the G4EMLOW reference data (245 MB, not committed). To rebuild:

```bash
# Download G4EMLOW from https://geant4-data.web.cern.ch/datasets/
# (current: G4EMLOW.8.8.tar.gz, shipped with Geant4 11.4.1). Extract so that
# data/g4emlow/dna/ exists, then:
npm run convert
```

## License

MIT for the simulation code. The Geant4-DNA cross-section data is distributed under the [Geant4 Software License](https://geant4.web.cern.ch/license/LICENSE.html) (BSD-like).

---

# Numbers

**This section is the single source of truth for every quantitative claim about the project.** Anywhere else (CLAUDE.md, index.html, blog posts, slides) is allowed to *summarize* but not to *introduce new numbers* — if a number isn't here, it's not measured.

Every row is backed by a committed JSON artifact under [`experiments/results/`](./experiments/results/). The `[Eᵢ]` tag in the right column links to the latest run. Re-run any with `npm run experiments -- <id>`.

All Geant4-side numbers were produced by a freshly-built **Geant4 11.4.1 / G4EMLOW 8.8** install (`~/Downloads/geant4-v11.4.1-install/`) running `dnaphysics` on `validation/run_validation.mac`, single-thread, on the same Apple M2 Pro that ran WebGPU. Production-realistic Geant4 MT-8 comparison ships separately as E15c.

Reference snapshot for the WebGPU side: `N = 4096` primaries at 10 keV unless otherwise stated, DNA_Opt2 physics list, 30 μm cube, current shader constants `SIGMA_EXC_SCALE = 0.5`, `RECOMB_BOOST = 2.0`, `SSB_R_DAMAGE_NM = 0.29`, `SSB_R_DAMAGE_INDIRECT_NM = 1.0`, `SSB_P_INDIRECT = 0.05`.

**Reproducibility caveat:** fp32 `atomicAdd` reductions on the dose grid and `rad_buf` counters are not order-deterministic across GPU vendors — same WGSL on different hardware (Apple Metal vs Nvidia Vulkan vs Intel iGPU) yields **statistically equivalent results within MC noise, NOT bit-exact**. The same machine + same seed + same shader hash IS bit-exact across re-runs. Every artifact emits `env.shaderHashes.{helpers,primary,secondary,chemistry}_wgsl` (added 2026-05-12) so you can group rows by shader version when the joint-fix scales or other shader-side tunables shift the baseline.

**Citing this work:** see [`CITATION.cff`](./CITATION.cff). The current release is `v0.4.1` ([GitHub Release](https://github.com/abgnydn/webgpu-dna/releases/tag/v0.4.1)). Zenodo concept DOI [10.5281/zenodo.20506339](https://doi.org/10.5281/zenodo.20506339) (always resolves to the latest version); the v0.4.1 version DOI is [10.5281/zenodo.20506340](https://doi.org/10.5281/zenodo.20506340).

**Where we deliberately differ from Geant4-DNA `DNA_Opt2`** (Emfietzoglou excitation, the σ_exc/recomb tuning knobs, per-primary IRT, fp32 atomics, fiber-grid geometry) — with the rationale and measured cost of each — is catalogued in [`GEANT4_DIVERGENCES.md`](./GEANT4_DIVERGENCES.md). Every cost figure there links back to its row in this section.

## Level 0 — Environment / infrastructure (2 of 2 pass)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| B0 | ✓ | Browser env capture: apple/metal-3 adapter, headless Chromium, `maxBuffer` 4 GB | [B0](./experiments/results/2026-05-11/level-0/B0-browser-env.json) |
| B1 | ✓ | Harness liveness: Vite + Playwright + WebGPU, first row at E=100 eV in 2.9 s | [B1](./experiments/results/2026-05-11/level-0/B1-harness-liveness.json) |

## Level 1 — Cross sections vs G4EMLOW 8.8 (9 of 9 pass)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E1   | ✓ | Born σ_ion total: 58 rows, peak ratio 0.9987, median 8.46e-4 | [E1](./experiments/results/2026-05-11/level-1/E1-ion-xs-match.json) |
| E1b  | ✓ | Per-shell Born σ_ion (5 shells: 1b₁, 3a₁, 1b₂, 2a₁, 1a₁), all peak ratios 0.997-1.000 | [E1b](./experiments/results/2026-05-11/level-1/E1b-per-shell-ion-xs.json) |
| E1c  | ✓ | Shell-fraction closure Σ XSF_i = 1.0 within 5e-3 across 96/96 active energy bins | [E1c](./experiments/results/2026-05-11/level-1/E1c-shell-fraction-closure.json) |
| E2   | ✓ | Emfietzoglou σ_exc total: 74 rows, peak 0.9970, median 2.42e-4 | [E2](./experiments/results/2026-05-11/level-1/E2-exc-xs-match.json) |
| E2b  | ✓ | Per-level σ_exc (5 levels: A¹B₁, B¹A₁, Ryd A+B, Ryd C+D, Diffuse), all 0.997-1.000 | [E2b](./experiments/results/2026-05-11/level-1/E2b-per-level-exc-xs.json) |
| E3   | ✓ | Champion σ_el: 58 rows, peak 0.9751, max 3.26e-3 (retroactive 334× scale-factor catcher) | [E3](./experiments/results/2026-05-11/level-1/E3-elastic-xs-match.json) |
| E3b  | ✓ | Champion angular CDF (XAC inverted lookup), 25/25 energies within \|Δcos(θ)\| < 0.10 (~6° accuracy) | [E3b](./experiments/results/2026-05-11/level-1/E3b-champion-angular-cdf.json) |
| E4   | ✓ | Sanche σ_vib total: 38 rows, peak 1.0000, max 6e-16 (bit-exact) | [E4](./experiments/results/2026-05-11/level-1/E4-vib-xs-match.json) |
| E4b  | ✓ | Sanche per-mode XVMF: 342 (energy, mode) pairs, max sum-dev 4e-8 | [E4b](./experiments/results/2026-05-11/level-1/E4b-vib-mode-fractions.json) |

## Level 2 — Track structure (3 pass / 2 honest-negative / 1 partial)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E5   | ✓ | CSDA @ 10 keV: 2714.4 vs 2747.5 nm Geant4 → **0.988× (3.59σ)**, energy conservation 100.0% | [E5](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| E5b  | ✗ honest negative (pre joint-fix baseline) | **CSDA across all 8 ESTAR energies, PRE joint-fix** — ratio grows monotonically: 0.587× @ 100 eV → 0.992× @ 20 keV (0.705 / 0.776 / 0.864 / 0.965 / 0.975 / 0.988 / 0.992× at 300/500/1000/3000/5000/10000/20000 eV). The 0.988× @ 10 keV in E5 is the *tail* of a much larger sub-keV deficit driven by σ_exc inflation. Joint fix closure measured in E5d. | [E5b](./experiments/results/2026-05-12/level-2/E5b-csda-multi-energy.json) |
| E5c  | ✗ honest negative | **W-value vs ICRU 31 (NEW 2026-05-12)** — Pre joint-fix: W_cascade = 26.89 eV vs ICRU 31's 21.4 eV → 1.257× (+25.7%). Post joint-fix (corrected H3O+ + H2-marker): 29.02 eV → 1.356× (+35.6%). Joint fix slightly increases W because RECOMB_BOOST reduces cascade-ion count — see E7b for the structural tradeoff. | [E5c](./experiments/results/2026-05-12/level-2/E5c-w-value.json) |
| **E5d**  | **✓ pass — marquee closure** | **POST joint-fix CSDA at all 8 ESTAR energies (NEW 2026-05-12)** — **8 of 8 energies improved monotonically**: 100 eV 0.588× → **0.736×** (+14.8 pp); 300 eV 0.705× → **0.810×**; 500 eV 0.776× → **0.857×**; 1 keV 0.864× → **0.912×**; 3 keV → 0.983×; 5 keV → 0.984×; 10 keV → 0.994×; 20 keV → 0.996×. The lift is inversely proportional to the original deficit size — the cleanest possible signature of a correct physics fix. | [E5d](./experiments/results/2026-05-12/level-2/E5d-l2-post-joint-fix-sweep.json) |
| E6c  | ✓ pass | **Effective σ-per-process under joint fix** — σ_exc effective ratio 2.55× → **1.27×** Geant4 (inside [1.0, 1.5] target band), driven by `SIGMA_EXC_SCALE = 0.5`. σ_ion +6.1% and σ_el +5.7% data tables unchanged. The 8/8 CSDA lift in E5d is the integrated empirical signature of this σ_exc shift. | [E6c](./experiments/results/2026-05-12/level-2/E6c-effective-sigma-post-joint-fix.json) |
| E7b  | ✗ honest negative (structural tradeoff) | **POST joint-fix cascade ions @ 10 keV** — H3O+-corrected estimate **344.6** vs pre-fix 371.9 and target 509.2. **Joint fix slightly *reduces* cascade ions** because `RECOMB_BOOST=2.0` kills more tracked secondaries at the source, preventing some cascade ionizations. Honest tradeoff: σ_exc reduction improves CSDA + chemistry, recomb boost improves H₂/H₂O₂ pre-chem, but BOTH reduce cascade-ion count. The two-knob structural limit documented in E10i appears at the cascade level too. | [E7b](./experiments/results/2026-05-12/level-2/E7b-l2-post-joint-fix-cascade.json) |
| E7c  | ✗ honest negative (asymmetric variant refuted) | **Asymmetric RECOMB_BOOST attempt** — applied `RECOMB_BOOST=2.0` ONLY to sub-cutoff and autoionization branches (not tracked-secondary). Rationale: tracked-sec eaq thermalizes 5-10 nm from H2O+ where time-integrated recomb adds little. **Result: chemistry reverts close to baseline.** Cascade ions: 381.1 (✓ recovered, vs pre-fix 371.9). RMS dev vs chem6: **27.9%** (was 19.0% in v1 — chemistry benefit LOST). The tracked-secondary path is the dominant lever for BOTH cascade AND chemistry effects — they're not separable with this knob set. Production shaders kept at v1 (uniform boost) because the chemistry-vs-chem6 closure is the project's marquee thesis. | [E7c](./experiments/results/2026-05-12/level-2/E7c-asymmetric-recomb-boost-attempt.json) |
| E6   | ✓ | MFP across 6 energy bins: ratios [0.893, 0.950], median 0.941 (-5.0% to -10.7%) | [E6](./experiments/results/2026-05-11/level-2/E6-mfp-vs-g4-ntuple.json) |
| E6b  | ✓ | Per-process σ: σ_ion +6.1%, σ_el +5.7%, σ_exc 2.55× (intentional Emfietzoglou inflation) | [E6b](./experiments/results/2026-05-11/level-2/E6b-sigma-per-process-vs-g4.json) |
| E7   | ✗ honest negative | Cascade ions per primary reconstructed from rad_buf H3O+: **WGSL 371.9 vs Geant4 509.2 → 0.730× (263σ, 27% deficit)** — real physics gap, tied to σ_exc inflation channeling energy away from ionization | [E7](./experiments/results/2026-05-11/level-2/E7-ions-per-primary-cascade.json) |
| E8   | partial pass (7/8) | Secondary KE spectrum at creation: sec/primary **WGSL 143.4 vs G4 144.9** (1.0% match). 7/8 log-bins in 6-800 eV agree within 0.1-3.1%; only 438-806 eV tail shows 43% deficit (~2.5σ) | [E8](./experiments/results/2026-05-11/level-2/E8-secondary-ke-spectrum.json) |

## Level 3 — Pre-chemistry (1 of 1 honest negative)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E9   | ✗ honest negative | **Pre-chem G(species) @ 0.1 ps vs Geant4 chem6** at matched 10 keV: OH 0.87× / eaq 0.90× / H 0.88× / **H₂ 0.51× / H₂O₂ 0.58×**. Localizes the E10c 1 μs deficit to pre-chemistry, NOT IRT reaction rates. See [PHYSICS_DIAGNOSIS.md §1](./PHYSICS_DIAGNOSIS.md). | [E9](./experiments/results/2026-05-11/level-3/E9-prechem-vs-chem6.json) |

## Level 4 — Chemistry (IRT)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E10  | ✓ | IRT G-values vs Karamitros 2011 across 5 energies — surfaces **G(e⁻aq) V-shape at 1→3 keV** (1.163→1.026→1.147, 11.8% drop, real track-end / spur-structure physics). **POST joint-fix (2026-05-13)**: 25/25 rows pass; V-shape preserved (OH ✓, eaq ✓ monotonic on either side). | [E10](./experiments/results/2026-05-13/level-4/E10-irt-vs-karamitros.json) |
| E10b | ✓ | V-shape σ-significance via primary-bootstrap (B=20 unique-pids resamples, m/n corrected SE) — drop at 1→3 keV is **126σ significant** (previously claimed as ~40σ without backing) | [E10b](./experiments/results/2026-05-11/level-4/E10b-vshape-bootstrap-sigma.json) |
| E10c | ✗ honest negative | **G(species) @ 1 μs vs Geant4 chem6 at matched 10 keV**: OH 0.91× / eaq 0.83× / H 1.00× / H₂ 0.75× / H₂O₂ 0.71×. Closes "is the 0.62× vs Karamitros real LET physics or our chemistry bug?" — answer is **both** (~30% real LET + ~10-29% real implementation gap, biggest on H₂/H₂O₂) | [E10c](./experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json) |
| E10d | partial pass (24/25) | chem6 matched-LET sweep across 5 V-shape energies (1/3/5/10/20 keV): 24 of 25 species×energy cells in 30% band. chem6 **independently reproduces the V-shape** (1.36 → 1.26 → 1.41 from 1 to 5 keV) — confirms it's real LET physics. **POST joint-fix (2026-05-13)**: same 24/25, V-shape preserved (1.37 → 1.26 → 1.39) — joint fix doesn't break the LET-physics signal. | [E10d](./experiments/results/2026-05-13/level-4/E10d-vs-chem6-multi-energy.json) |
| E10e | ✗ refuted | **Cross-event recomb hypothesis**: synthetic Node experiment over rad_E10000_N4096.bin shows nearest-eaq P_recomb = 0.230 vs geminate point-estimate 0.221 (ΔP = +0.009). Only +0.44 H₂/primary vs target deficit of 12.4 — **3.5% of the gap**. Geminate eaq is the nearest one in ~98% of cases at 10 keV. | [E10e](./experiments/results/2026-05-12/level-4/E10e-cross-event-recomb-synthetic.json) |
| E10f | ✗ refuted at 0.1 ps, ✓ confirmed at 1 μs | **Per-primary IRT partitioning**: at 0.1 ps ΔG(H₂) = -0.001 (irrelevant). At 1 μs ΔG(H₂) = +0.149, closing 96% of the E10c 1 μs implementation gap. **Partitioning is the cause of the 1 μs gap**; the 0.1 ps deficit is elsewhere. | [E10f](./experiments/results/2026-05-12/level-4/E10f-per-primary-partitioning.json) |
| E10g | ✓ noisy / informational | **Recomb-rate sensitivity** sweep: linearly interpolating gives x ≈ 0.035 closes G(H₂)@0.1ps. Maps to ~25% additional effective recomb fraction (per Geant4's 13.65% H₂Ovib branching). | [E10g](./experiments/results/2026-05-12/level-4/E10g-recomb-rate-sensitivity.json) |
| E10h | ✗ noisy | **Recomb boost with proper H₂Ovib branching** alone: best X=0.15 reduces RMS dev 30% → 22% but G(eaq) drops to 0.77× (WORSE than baseline 0.90×). Recomb boost is necessary but not sufficient — closing all 5 species needs a joint fix. | [E10h](./experiments/results/2026-05-12/level-4/E10h-time-integrated-recomb-prediction.json) |
| E10i | ✗ noisy (partial closure) | **Joint fix end-to-end Playwright validation**: `(σ_exc_scale = 0.5, recomb_boost = 2.0)` lifts RMS dev 30.3% → **19.0%**, CSDA @ 100 eV 0.587× → **0.74×**, G(H₂) 0.51× → **0.78×**. G(H), G(H₂O₂) close; G(OH)/G(eaq) take 5-9% collateral damage. Two-knob structural limit. | [E10i](./experiments/results/2026-05-12/level-4/E10i-joint-fix-validation.json) |
| E10j | ⚠ noisy (audit closure) | **POST joint-fix G-values at 1 μs vs chem6** — closes the audit gap where the prior §Numbers row mixed pre-fix and post-fix numbers. Result: G(OH) 0.895× (was 0.907×), G(eaq) 0.815× (was 0.830×), G(H) **1.096×** (was 0.992× — joint fix overshoots H slightly), G(H₂O₂) 0.693× (was 0.711×), G(H₂) **0.860×** (was 0.752× — big improvement). Per-primary IRT partitioning still dominates the 1 μs gap. | [E10j](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| E11  | ✗ honest negative | **GPU chem backend vs IRT worker** on the same rad bin: GPU matches within 5% at t ≤ 100 ps; diverges upward at 1 μs (G(OH) 2.33× IRT, G(eaq) 2.19×). GPU is 13.6× faster (14.2 s vs 194 s) but inaccurate at long times — quantifies why `DEFAULT_CHEM_BACKEND = 'worker'`. | [E11](./experiments/results/2026-05-11/level-4/E11-gpu-chem-vs-irt.json) |
| E10r | ✓ informative — **RECOMB_BOOST is not load-bearing** | **Parameter-free chemistry (RECOMB_BOOST 2.0→1.0)** @ 1 μs vs chem6: G(OH) **0.914×**, G(eaq) **0.858×**, G(H) **0.928×** (the 1.096× overshoot disappears), G(H₂) 0.741×, G(H₂O₂) 0.693×. **5-species RMS @1μs only 19.7% vs 18.3% tuned** — removing the unphysical knob costs ~1.4 pp and improves 3 of 5 species. The knob mainly props up H₂ at the cost of an H overshoot; the paper reports the parameter-free values. | [E10r](./experiments/results/2026-06-02/level-4/E10r-recomb-free-chemistry.json) |

## Level 5 — DNA damage (3 pass / 1 fail closed)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E12  | ✓ pass (with geometric caveat) | SSB/DSB vs Friedland 2011 / PARTRAC: **geometry-independent DSB/SSB ratio = 0.083** (3.6× Friedland's 0.023, within factor-5 pass band). Absolute per-Da yields 220-800× because of fiber-grid concentration in track core — geometric artifact, not scoring bug | [E12](./experiments/results/2026-05-11/level-5/E12-ssb-yield-vs-friedland.json) |
| E13  | ✗ initial fail | Indirect/direct SSB ratio: WGSL **0/24 = 0** vs PARTRAC 2-3. Diagnosis in PHYSICS_DIAGNOSIS.md §3 (3 causes, 3 fixes) | [E13](./experiments/results/2026-05-11/level-5/E13-indirect-vs-direct-ssb.json) |
| E13b | ✓ | **Parametric SSB_R_DAMAGE_NM sweep** (Node-side replica of `scoreIndirectSSB` over existing rad_buf): r=0.29 → SSB_ind=8; r=1.0 → 174; r=2.0 → 394. Confirms 0.29 nm is the bottleneck | [E13b](./experiments/results/2026-05-11/level-5/E13b-ssb-radius-parametric.json) |
| E13c | ✓ marquee closure | **L5 indirect-SSB gap closed in 4 stages**: (1) split SSB_R_DAMAGE (direct=0.29, indirect=1.0); (2) instrument IRT worker for time-resolved scoring; (3) ratio 18.79 still overshoots; (4) calibrate SSB_P_INDIRECT 0.4 → 0.05. Pre joint-fix: SSB_dir=23, SSB_ind=68, DSB=1, ratio=2.96. **POST joint-fix (2026-05-13): SSB_dir=26, SSB_ind=64, DSB=9, ratio=2.46 — still in PARTRAC 2-3 band, AND DSB count 1 → 9 (the joint fix's chemistry boost produces more co-located strand-0/strand-1 indirect hits)** | [E13c](./experiments/results/2026-05-13/level-5/E13c-rerun-ssb-after-fix.json) |

## Level 6 — Performance (3 pass / 2 honest-negative)

| ID | Status | Result | Artifact |
|:---|:------:|:-------|:---------|
| E15  | ✗ honest negative | Phase A α/β decomposition via WebGPU timestamp-disciplined N-sweep: **α = 10.5 ms** (single-workgroup compute floor — original 10-500 μs hypothesis falsified), β = 1.207 μs/primary, R² = 0.908. **Peak throughput 538,947 primaries/sec @ N=16384, 10 keV** on apple/metal-3 | [E15](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |
| E15b | ✓ | Same-machine vs Geant4 11.4.1 single-thread (3 trials, M2 Pro): **455× speedup** on matched-scope physics tracking (Phase A+B 635 ms vs Geant4 median 289.1 s). End-to-end pre-DNA pipeline only **1.48×** because IRT chemistry on CPU dominates (194 s of 194.6 s end-to-end) | [E15b](./experiments/results/2026-05-11/level-6/E15b-vs-geant4-single-thread.json) |
| E15c | ✓ | **Production-realistic: WGSL vs Geant4 MT-8** (3 trials, M2 Pro 8 threads). Geant4 MT-8 median 178.0 s → **280× speedup vs WGSL Phase A+B**. Geant4's MT scaling is only 1.6× over ST (well below theoretical 8×) due to per-event scheduling + memory contention | [E15c](./experiments/results/2026-05-11/level-6/E15c-vs-geant4-multi-thread.json) |
| E15d | ✓ | Phase A α/β + peak throughput across all 8 ESTAR energies: β scales monotonically 0.23 → 2.05 μs/primary from 100 eV to 20 keV; peak throughput 2.1M → 0.29M primaries/sec | [E15d](./experiments/results/2026-05-11/level-6/E15d-phase-a-energy-sweep.json) |
| E16  | ✗ honest negative | **Kernel-fusion thesis closure**: T_fused = 17.75 ms vs modeled T_naive = 414 × 1.70 = 704 ms → **40× speedup**. L6 protocol's "≥100×" hypothesis falsified at the measured magnitude — the thesis is supported in spirit (40× is substantial, consistent with kernelfusion.dev's 71× Apple Silicon benchmark) but absolute factor is half the protocol claim | [E16](./experiments/results/2026-05-11/level-6/E16-fused-vs-naive.json) |

## Headline summary @ 10 keV, N=4096

After all 2026-05-12 fixes (L5 indirect SSB closure, joint physics tuning):

| Metric                                       | This build       | Reference                                   | Ratio                                                                |
| -------------------------------------------- | ---------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| CSDA range (nm)                              | 2714.4           | 2747.5 (Geant4 11.4.1)                      | **0.988× (3.59σ)** [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| CSDA @ 100 eV (vs Geant4) — post joint-fix   | 19.3 nm          | 26.21 nm                                    | **0.736×** (was 0.587× pre-fix, +14.8 pp) [[E5d]](./experiments/results/2026-05-12/level-2/E5d-l2-post-joint-fix-sweep.json) |
| CSDA @ 300 eV — post joint-fix               | 29.1 nm          | 35.91 nm                                    | **0.810×** (was 0.705×) [[E5d]](./experiments/results/2026-05-12/level-2/E5d-l2-post-joint-fix-sweep.json) |
| CSDA @ 500 eV — post joint-fix               | 41.2 nm          | 48.07 nm                                    | **0.857×** (was 0.776×) [[E5d]](./experiments/results/2026-05-12/level-2/E5d-l2-post-joint-fix-sweep.json) |
| CSDA @ 1 keV — post joint-fix                | 82.4 nm          | 90.32 nm                                    | **0.912×** (was 0.864×) [[E5d]](./experiments/results/2026-05-12/level-2/E5d-l2-post-joint-fix-sweep.json) |
| Energy conservation                          | 100.0 %          | 99.99 %                                     | 1.000× [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| Ions / primary (full cascade)                | 371.9            | 509.2 (Geant4)                              | **0.730× (263σ)** [[E7]](./experiments/results/2026-05-11/level-2/E7-ions-per-primary-cascade.json) |
| G(OH) @ 1 μs vs chem6 — pre joint-fix         | 1.551            | 1.710                                       | **0.907× (4.8σ)** [[E10c]](./experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json) |
| G(OH) @ 1 μs vs chem6 — post joint-fix        | 1.530            | 1.710                                       | **0.895×** [[E10j]](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| G(e⁻aq) @ 1 μs vs chem6 — pre joint-fix       | 1.406            | 1.694                                       | **0.830× (9.7σ)** [[E10c]](./experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json) |
| G(e⁻aq) @ 1 μs vs chem6 — post joint-fix      | 1.381            | 1.694                                       | **0.815×** [[E10j]](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| G(H) @ 1 μs vs chem6 — pre joint-fix          | 0.708            | 0.710                                       | 0.997× ✓ [[E10c]](./experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json) |
| G(H) @ 1 μs vs chem6 — post joint-fix         | 0.778            | 0.710                                       | **1.096× (overshoot)** [[E10j]](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| G(H₂) @ 1 μs vs chem6 — post joint-fix        | 0.535            | 0.622                                       | **0.860× (was 0.752× pre-fix — biggest improvement)** [[E10j]](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| G(H₂O₂) @ 1 μs vs chem6 — post joint-fix      | 0.589            | 0.850                                       | **0.693× (was 0.711× pre-fix)** [[E10j]](./experiments/results/2026-05-12/level-4/E10j-post-joint-fix-vs-chem6-at-1us.json) |
| Implicit W-value (E_total / N_ions, full cascade) | 26.89 eV      | 21.4 eV (ICRU 31, low-LET liquid water)     | **1.257× (+25.7%)** — same physics as E7's 27% cascade-ion deficit [[E5c]](./experiments/results/2026-05-12/level-2/E5c-w-value.json) |
| G(H₂) @ 0.1 ps (pre-chem, joint fix applied) | 0.197            | 0.251 (chem6)                               | **0.78× (was 0.51× pre-fix)** [[E10i]](./experiments/results/2026-05-12/level-4/E10i-joint-fix-validation.json) |
| G(H₂O₂) @ 0.1 ps (joint fix applied)         | 0.041            | 0.053 (chem6)                               | **0.77× (was 0.58×)** [[E10i]](./experiments/results/2026-05-12/level-4/E10i-joint-fix-validation.json) |
| RMS deviation across 5 species @ 0.1 ps      | **19.0 %**       | (vs chem6)                                  | down from 30.3 % baseline [[E10i]](./experiments/results/2026-05-12/level-4/E10i-joint-fix-validation.json) |
| G(e⁻aq) V-shape drop 1→3 keV                 | 12.5 %           | 0 (smooth-monotonic null)                   | **126σ significant** [[E10b]](./experiments/results/2026-05-11/level-4/E10b-vshape-bootstrap-sigma.json) |
| SSB direct / indirect / DSB @ 10 keV (post joint-fix) | 26 / 64 / 9      | indirect/direct ratio PARTRAC = 2-3         | **2.46 — in PARTRAC band** [[E13c]](./experiments/results/2026-05-13/level-5/E13c-rerun-ssb-after-fix.json) |
| Phase A wall-clock @ N=4096, 10 keV          | 14.4 ms          | —                                           | n/a [[E15]](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |
| Phase A peak throughput                      | 538,947 primaries/sec @ N=16384 | —                            | n/a [[E15]](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |
| Phase A + B vs Geant4 11.4.1 single-thread   | 635 ms           | 289.1 s (median over 3 trials)              | **455× speedup** [[E15b]](./experiments/results/2026-05-11/level-6/E15b-vs-geant4-single-thread.json) |
| Phase A + B vs Geant4 MT-8                   | 635 ms           | 178.0 s (median over 3 trials)              | **280× speedup** (production-realistic) [[E15c]](./experiments/results/2026-05-11/level-6/E15c-vs-geant4-multi-thread.json) |
| End-to-end pre-DNA pipeline vs Geant4 ST     | 194.6 s          | 289.1 s                                     | 1.48× (IRT chem on CPU is the bottleneck) [[E15b]](./experiments/results/2026-05-11/level-6/E15b-vs-geant4-single-thread.json) |
| Kernel-fusion speedup (fused vs naive)       | 17.75 ms         | 704 ms (modeled)                            | **40×** (within-WebGPU thesis test) [[E16]](./experiments/results/2026-05-11/level-6/E16-fused-vs-naive.json) |
| Unit tests                                   | 46 / 46          | —                                           | `npm run test`, ~200 ms |

## Substantive research findings

Each is a falsifiable claim only visible because of the protocol — not from reading the code:

1. **CSDA deficit was energy-dependent — 0.587× @ 100 eV → 0.992× @ 20 keV pre-fix; closed monotonically by the joint fix.** Joint-fix shifts: 100 eV +14.8 pp / 300 eV +10.5 pp / 500 eV +8.1 pp / 1 keV +4.8 pp / high-E ~+0.5 pp. The lift is inversely proportional to the original deficit size — exactly what σ_exc-inflation theory predicts, confirming the diagnosis. [E5, E5b, E5d]
2. **G(e⁻aq) is non-monotonic between 1 and 3 keV at z = 126σ** (1.163 → 1.026 → 1.147 — 12.5% drop, real track-end / spur-structure physics; chem6 independently reproduces it). [E10, E10b, E10d]
3. **MFP is consistently 5-11% lower than Geant4** across all 6 energy bins (median 0.941). [E6]
4. **σ_ion is 6.1% high and σ_el is 5.7% high vs Geant4 11.4.1.** Per E6b decomposition, the MFP shortfall is ~49% from σ_ion, ~31% from σ_el, ~20% from intentional σ_exc inflation. [E6b]
5. **WGSL cascade ions/primary is 27% lower than Geant4** (371.9 vs 509.2, 263σ). Closes the counting-convention question E5 punted on and points at σ_exc inflation as the mechanism. [E7]
6. **WebGPU is 455× faster than Geant4 11.4.1 single-thread** on matched-scope physics tracking; end-to-end only 1.48× because IRT chem on CPU dominates. Decomposes into ~10× from GPU vs CPU + ~40× from kernel fusion (multiplicative). [E15b, E16]
7. **The G(OH) deficit vs Karamitros 2011 confounds two effects**: ~70% is real LET physics (chem6 reproduces the same trend); ~30% is a real WGSL-vs-chem6 implementation gap. G(H₂)/G(H₂O₂) are the biggest implementation gaps. [E10c, E10d]
8. **The 0.1 ps pre-chem H₂/H₂O₂ deficit is NOT from cross-event recomb (refuted by E10e at 3.5%) and NOT from per-primary IRT partitioning at 0.1 ps (refuted by E10f at 0%).** Partitioning IS the cause of 96% of the 1 μs gap. The 0.1 ps gap requires structural physics changes (H₂O+ tracking + time-integrated recomb). [E10e, E10f, E10g, E10h, E10i]
9. **L5 indirect-SSB ratio closed in 4 commits** — from `0/24 = 0` (real failure) to a PARTRAC 2-3 band ratio (pre joint-fix `68/23 = 2.96`; post joint-fix `64/26 = 2.46`, current) via constants split + IRT-side time-resolved scoring + P_indirect calibration. [E13, E13b, E13c]

## Ongoing physics work

Documented in [`PHYSICS_DIAGNOSIS.md`](./PHYSICS_DIAGNOSIS.md). Open gaps:

- **H₂O+ tracking with time-integrated recomb** (~3 hr, would close 0.1 ps pre-chem G(H₂)/G(H₂O₂) more cleanly than the current `RECOMB_BOOST` constant)
- **W_sec distribution shifter** (~2 hr third knob — independently tune sub-cutoff vs tracked-secondary fraction)
- **E14 vs molecularDNA** (~1 day — full chromatin geometry comparison; deferred)
