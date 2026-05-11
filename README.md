# WebGPU Geant4-DNA

[![CI](https://github.com/abgnydn/webgpu-dna/actions/workflows/ci.yml/badge.svg)](https://github.com/abgnydn/webgpu-dna/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Live demo](https://img.shields.io/badge/live-webgpudna.com-6ea8ff)](https://webgpudna.com)
[![Geant4-DNA validated](https://img.shields.io/badge/Geant4--DNA-cross--checked-b0ffd0)](./validation/compare.py)
[![Tests](https://img.shields.io/badge/tests-46%20%E2%9C%93-82c98b)](./tests)

A WebGPU port of [Geant4-DNA](https://geant4-dna.in2p3.fr/) — the CNRS/IN2P3-coordinated Monte Carlo track-structure toolkit for radiobiology — running entirely in the browser.

One GPU thread per primary electron, full particle history in a single fused compute dispatch, Karamitros 2011 Independent-Reaction-Time chemistry in a Web Worker, and SSB/DSB scoring on a 21×21 B-DNA fiber grid at 10 keV.

<p align="center">
  <a href="https://webgpudna.com">
    <img src="public/og-image.png" alt="WebGPU Geant4-DNA — in-browser Monte Carlo track-structure" width="100%" />
  </a>
</p>

## Results (N = 4096 primaries @ 10 keV)

Every numeric claim below is backed by a committed JSON artifact. `[E5]` / `[E10]` / `[B1]` / `[E15]` tags link to the latest run under [`experiments/results/2026-05-11/`](./experiments/results/2026-05-11/) — re-run any with `npm run experiments -- E5`.

| Metric                                | This build | Reference                   | Ratio              | Source |
| ------------------------------------- | ---------- | --------------------------- | ------------------ | ------ |
| CSDA range (nm)                       | 2714.4     | 2756.5 (Geant4-DNA direct)  | **0.985× (4.61σ)** | [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| Energy conservation                   | 100.0 %    | 100.0 %                     | 1.000×             | [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| Ions / primary (primary track only)²  | 194.1      | 509.1 (Geant4 full cascade) | informational²     | [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| Implied ions / secondary              | 2.20       | [2, 3] physical bound       | ✓ in band          | [[E5]](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| MFP_total ratio (median over 6 bins)  | 0.926      | 1.000 (Geant4 ntuple)       | -7.4% (range -3.5% to -10.5%) | [[E6]](./experiments/results/2026-05-11/level-2/E6-mfp-vs-g4-ntuple.json) |
| G(OH) at 1 μs                         | 1.551      | 2.50 (Karamitros 2011)      | 0.621×¹            | [[E10]](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| G(e⁻aq) at 1 μs                       | 1.406      | 2.50                        | 0.563×¹            | [[E10]](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| G(H) at 1 μs                          | 0.708      | 0.57                        | 1.243×             | [[E10]](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| G(H₂O₂) at 1 μs                       | 0.605      | 0.73                        | 0.828×             | [[E10]](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| G(H₂) at 1 μs                         | 0.468      | 0.42                        | 1.114×             | [[E10]](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| Phase A wall-clock @ N=4096 (10 keV)  | 14.4 ms    | (no Geant4 baseline yet³)   | informational³     | [[E15]](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |
| Phase A peak throughput               | 538,947 primaries/sec at N=16384 | (no Geant4 baseline yet³) | informational³ | [[E15]](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |
| Phase A per-primary marginal cost (β) | 1.207 μs/primary | (no Geant4 baseline yet³) | informational³ | [[E15]](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |

¹ G(OH) / G(e⁻aq) at 10 keV LET are inherently below the Karamitros 2011 low-LET (~1 MeV) reference — track-core density drives higher radical recombination.
² **Counting-convention mismatch.** Geant4's `dnaphysics` ntuple reports the full cascade total (509.1 ions/primary, summed across primary + all secondaries). WebGPU's `box_ions` counter accumulates only the primary track (194.1); the secondary side contributes via `sec_per_primary = 143.2`. Reconstructing a directly comparable cascade total would require an extra reduction pass over `rad_buf`. E5 reports the implied 2.20 ions/secondary as the comparable sanity check (physical bound [2, 3] for sub-keV cascades). See [E5 artifact](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) `rows[ions_per_primary]`.

³ **No Geant4 single-thread baseline on this machine yet.** The marquee "kernel fusion beats Geant4 by N×" claim is not yet measured. E15 reports an honest within-WebGPU baseline (Phase A α/β decomposition + peak throughput). E15b will measure Geant4 11.4.1 single-thread on the same machine for the matched workload; Geant4 install is in progress (source at `~/Downloads/geant4-11.3.0`, install build was wiped — rebuild underway).

**46 / 46** unit tests pass across 7 files (`npm run test`). See [`validation/compare.py`](./validation/compare.py) for the full side-by-side against a Geant4-DNA ntuple.

### Research-grade validation ledger

11 falsifiable experiments shipped as committed JSON artifacts under [`experiments/results/`](./experiments/results/). See [RESEARCH.md](./RESEARCH.md) for the protocol; per-experiment specs under [`experiments/level-N-*/protocol.md`](./experiments/).

| Level | ID | Status | Headline | Artifact (2026-05-11) |
|------:|:---|:-------|:---------|:----------------------|
| 0 | B0  | ✓ | Browser env capture: apple/metal-3, headless Chromium, maxBuffer 4 GB | [B0](./experiments/results/2026-05-11/level-0/B0-browser-env.json) |
| 0 | B1  | ✓ | Harness liveness: vite + Playwright + WebGPU, first row (E=100 eV, CSDA=15.7 nm) in 2.9s | [B1](./experiments/results/2026-05-11/level-0/B1-harness-liveness.json) |
| 1 | E1  | ✓ | Born σ_ion: 58 rows, peak ratio 0.9987, median 8.46e-4 vs G4EMLOW | [E1](./experiments/results/2026-05-11/level-1/E1-ion-xs-match.json) |
| 1 | E2  | ✓ | Emfietzoglou σ_exc: 74 rows, peak ratio 0.9970, median 2.42e-4 vs G4EMLOW | [E2](./experiments/results/2026-05-11/level-1/E2-exc-xs-match.json) |
| 1 | E3  | ✓ | Champion σ_el: 58 rows, peak ratio 0.9751, max 3.26e-3 vs G4EMLOW (retroactive 334× scale-factor catcher) | [E3](./experiments/results/2026-05-11/level-1/E3-elastic-xs-match.json) |
| 1 | E4  | ✓ | Sanche σ_vib total: 38 rows, peak ratio 1.0000, max 6e-16 (bit-exact) | [E4](./experiments/results/2026-05-11/level-1/E4-vib-xs-match.json) |
| 1 | E4b | ✓ | Sanche per-mode XVMF: 342 (energy, mode) pairs, max sum-dev 4e-8 | [E4b](./experiments/results/2026-05-11/level-1/E4b-vib-mode-fractions.json) |
| 2 | E5  | ✓ | CSDA 2714.4 vs 2756.5 nm — **0.985× is 4.61σ statistically significant** | [E5](./experiments/results/2026-05-11/level-2/E5-csda-vs-g4-ntuple.json) |
| 2 | E6  | ✓ | MFP across 6 energy bins — ratios [0.895, 0.965], median 0.926 (-3.5% to -10.5%) | [E6](./experiments/results/2026-05-11/level-2/E6-mfp-vs-g4-ntuple.json) |
| 2 | E6b | ✓ | Per-process σ decomposition — **σ_ion 5.6% high, σ_el 6.3% high** vs Geant4, σ_exc 2.57× (intentional Emfietzoglou) | [E6b](./experiments/results/2026-05-11/level-2/E6b-sigma-per-process-vs-g4.json) |
| 4 | E10 | ✓ | IRT G-values vs Karamitros 2011 across 5 energies — surfaces **G(e⁻aq) V-shape at 1→3 keV** (1.163→1.026→1.147, 11.8% drop, real track-end / spur-structure effect; LET monotonicity confirmed for E ≥ 5 keV) | [E10](./experiments/results/2026-05-11/level-4/E10-irt-vs-karamitros.json) |
| 6 | E15 | ✗ fail (honest negative) | Phase A α/β decomposition via WebGPU timestamp-disciplined N-sweep — **α = 10.5 ms (single-workgroup compute floor, not pure dispatch overhead — original [10, 500] μs hypothesis falsified)**, β = 1.207 μs/primary, R² = 0.908. **Peak throughput 538,947 primaries/sec at N=16384, 10 keV** on apple/metal-3. Diagnosis + revised two-regime pass bar in [level-6-performance/protocol.md](./experiments/level-6-performance/protocol.md). | [E15](./experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json) |

Run any experiment via `npm run experiments -- <id>` (e.g. `E1`, `E10`, `B1`, `E15`).

## Quick start

```bash
npm install
npm run dev            # http://localhost:8765
npm run test           # 46 tests, ~200 ms
npm run lint
npm run build          # dist/
```

Requires a WebGPU-capable browser. Shipped on-by-default in Chrome / Edge 113+ desktop, Chrome 121+ Android (Android 12+ on Qualcomm / ARM GPUs), Safari 26+ (macOS Tahoe, iOS / iPadOS / visionOS 26, Sep 2025), Firefox 141+ on Windows, and Firefox 145+ on macOS 26 Tahoe (Apple Silicon only). Firefox Linux, Firefox Android, and older Firefox still need `dom.webgpu.enabled` in `about:config`. Full matrix: [caniuse.com/webgpu](https://caniuse.com/webgpu).

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

Deep-dive: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Physics provenance and validation history: [`CLAUDE.md`](./CLAUDE.md).

## Regenerating cross sections

The committed `public/cross_sections.wgsl` (1.3 MB) is generated from the G4EMLOW reference data (245 MB, not committed). To rebuild:

```bash
# Download G4EMLOW from https://geant4-data.web.cern.ch/datasets/
# (current: G4EMLOW.8.8.tar.gz, shipped with Geant4 11.4.1). Extract so that
# data/g4emlow/dna/ exists, then:
npm run convert
```

## What's implemented

- **Physics:** Born ionization (5 shells, data-driven CDF sampling), Emfietzoglou excitation (5 levels, dissociative branching 0.65 / 0.55 / 0.80), Champion tabulated elastic angular CDF (< 200 eV), screened-Rutherford elastic (> 200 eV), Sanche 9-mode vibrational (2–100 eV), full primary-momentum conservation.
- **Chemistry:** Karamitros 2011 9-reaction IRT in a Web Worker (Smoluchowski TDC + Onsager-screened PDC for charged pairs, G4EmDNAChemistry_option1). 2.0 nm mother displacement, species-specific product displacement, e⁻aq thermalization at 1.7 eV, H₂O₂ / OH⁻ tracked as reactive products with full re-pairing.
- **DNA scoring:** Event-level direct SSB from `rad_buf` ionization sites, indirect SSB from diffused OH at 1 μs, greedy ±10 bp DSB clustering, kernel-level backbone hit counter as a cross-check.
- **Grid target:** 21×21 parallel B-DNA fibers × 3 μm × 150 nm spacing = 3.89 Mbp.

## Known gaps

- GPU-resident chemistry path (`chemBackend: 'gpu'`) undercounts long-time reactions vs IRT because the spatial hash search radius is narrower than the diffusion σ at 30 ns timesteps. Default backend is therefore the IRT worker.
- `data/g4emlow/` is not committed — download from CERN (link above) to rebuild cross sections.

## License

MIT for the simulation code. The Geant4-DNA cross-section data is distributed under the [Geant4 Software License](https://geant4.web.cern.ch/license/LICENSE.html) (BSD-like).
