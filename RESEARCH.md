# webgpu-dna — Research Protocol

## Thesis

> **Electron track-structure radiobiology Monte Carlo runs in a browser tab
> on commodity GPU hardware, reproduces Geant4-DNA reference physics within
> published statistical uncertainties at every energy from 100 eV to 20 keV,
> and yields cross sections, ranges, radiolysis G-values, and DNA damage
> counts that can be cross-validated against tabulated G4EMLOW data,
> Karamitros 2011, the Geant4 11.4.1 dnaphysics ntuple, and the Tran 2024
> ESA BioRad III chemistry review.**

Every level below decomposes that thesis into falsifiable experiments.

## Standards (apply to every experiment)

### Reproducibility

- Every experiment records the exact git commit SHA, timestamp (UTC ISO8601),
  Node version, OS platform, hostname, CPU count, and — when run on GPU —
  `navigator.userAgent`, `adapter.info` (vendor / architecture / device /
  description), and WebGPU device limits, alongside its numbers.
- Every random input is driven by a **named deterministic seed** from
  `experiments/lib/seeds.mjs`. No `Math.random()` in an experiment path.
- Every JSON artifact includes `protocol`, `hypothesis`, `passBar`, `seed`,
  `warmup`, `trials` so an outsider can re-run and compare.
- Stage 1 experiments are CPU-only data checks (no GPU); from Level 2 onwards
  experiments run a real WGSL pipeline and capture adapter info.

### Timing

- All wall-clock measurements use `performance.now()` with **forced GPU
  sync before and after** (a mapped readback of a tiny buffer) — `queue.submit`
  is non-blocking.
- First **W = 5** samples per configuration are discarded (shader compile
  + warm-up).
- Next **T = 20** samples are retained.
- Reported stats: **median, p10, p90, p99, std, IQR**. Never single-shot.
- If `std/median > 0.1` for any cell, the experiment flags it as
  **NOISY** and the author must investigate before publishing.

### Correctness

- Tabulated cross-section comparisons report **relative error** at every
  source energy (raw G4EMLOW grid). Pass bars are stated per-experiment;
  the universal floor is **median rel_err < 1e-3** and **scale ratio
  ∈ [0.95, 1.05]** vs the raw data — this catches scale-factor regressions
  (e.g. the historical Champion 334× bug) before they reach a track.
- Track-structure metrics use **mean ± SEM over N primaries** vs the
  Geant4 ntuple's mean for the same N, with a 2σ pass bar.
- Chemistry G-values report **value at t** vs Karamitros 2011 / Tran 2024
  references with **explicit LET corrections** documented per experiment.
- DNA damage counts use **Poisson-error pass bars** on SSB / DSB per Gy
  per Da, vs Friedland 2011 / molecularDNA references.

### Honest negative results

- If an experiment fails its pass bar, the JSON is still committed with
  `"status": "fail"` and a short `"diagnosis"` string. **Failures are
  the evidence.** No rerunning until it passes.
- `experiments/results/<date>/<level>/<E#>.json` is committed even when
  status = fail; the README index links it as a fail row.

## The six levels

| # | Level | Thesis fragment | Experiments |
|---|-------|-----------------|-------------|
| 1 | Cross sections | "WGSL tables agree with G4EMLOW within log-log subsampling noise" | E1–E4 |
| 2 | Track structure | "CSDA, MFP, ions/primary, energy spectrum match Geant4 11.4.1 ntuple within 2σ at every energy in [100 eV, 20 keV]" | E5–E8 |
| 3 | Pre-chemistry | "G(OH)_init, G(eaq)_init at 1 ps reproduce Geant4 chem6 with the documented mother-displacement convention" | E9 |
| 4 | Chemistry @ 1 μs | "IRT G-values match Karamitros 2011 / Tran 2024 with explicit LET-deficit accounting at 10 keV" | E10–E11 |
| 5 | DNA damage | "Direct + indirect SSB and DSB yields land within the published band of Friedland 2011 / molecularDNA on a comparable target geometry" | E12–E14 |
| 6 | Performance | "Per-primary fused dispatch is bandwidth-limited and beats Geant4 single-thread by ≥ 10² on the same machine" | E15–E16 |

Each level has its own `protocol.md` under `experiments/level-N-<slug>/`.

## Status

| Level | Status | Notes |
|-------|--------|-------|
| 0 — Env / infra | **In progress.** B0 (browser-runner sanity) passing. | Playwright + headless Chromium + WebGPU pipeline functional; B1 (webgpu-dna harness liveness) deferred. |
| 1 — Cross sections | **Complete.** E1, E2, E3, E4, E4b all passing. | Born ionization + Born excitation (v0.7.0, E29) + Champion elastic + Sanche vibrational total + per-mode fractions bit-match. |
| 2 — Track structure | **Complete (headline) + open residual.** E5–E8 plus E20–E29/E35 cascade + Auger work. | CSDA 0.997× @10 keV (E29), cascade 0.981× (E35), primary 0.1% (E20); residual ~1.9% secondary-cascade deficit. |
| 3 — Pre-chemistry | **Measured (honest negative).** E9. | 0.1 ps vs chem6: OH/eaq/H ~0.87–0.90×, H₂/H₂O₂ ~0.5× — deficit localised to pre-chemistry. |
| 4 — Chemistry | **Measured.** E10 family (incl. E10r/E17/E25) + E11. | 1 µs RMS 7.0% vs chem6 (E29); GPU backend diverges at long times (E11, honest negative). |
| 5 — DNA damage | **Measured.** E12/E12-local/E13 family + E30–E41. | Absolute yields vindicated per local dose (E12-local); explicit OH+deoxyribose channel 2.28 in-band (E39–E41). E14 molecularDNA comparison deferred. |
| 6 — Performance | **Measured.** E15 family + E16. | Tracking ~241× ST / ~148× MT-8 (v0.6.0 full cascade); honest end-to-end 1.48×; fusion 40× Phase-A-only (E16 honest negative). |

## References

- **Geant4 11.4.1** (released 2026-03-13) and **G4EMLOW 8.8** (paired with
  11.4.0+; ELSEPA elastic XS extended to 10 MeV in water).
  https://geant4.web.cern.ch/download/
- **Karamitros 2011** — IRT chemistry foundation; webgpu-dna's 9-reaction
  table source.
- **Tran et al. 2024** — Med Phys, ESA BioRad III review of every
  Geant4-DNA chemistry constructor (Geant4 10.1 → 11.2) with G-value
  benchmarks.
  https://aapm.onlinelibrary.wiley.com/doi/10.1002/mp.17256
- **Chatzipapas 2023** — Precision Radiation Oncology, molecularDNA
  example (released in Geant4 11.1, Dec 2022).
  https://onlinelibrary.wiley.com/doi/10.1002/pro6.1186
- **dsbandrepair 2024** — Geant4-DNA tool for damage + repair scoring.
  https://www.physicamedica.com/article/S1120-1797(24)00217-5/fulltext
- **2024 UHDR / FLASH water radiolysis** — Oriatron eRT6 linac.
  https://www.nature.com/articles/s41598-024-76769-0
- **2025 SBS-RDME verification** — long-term radiolysis, Fricke dosimeter.
  https://www.sciencedirect.com/science/article/abs/pii/S1120179725000936
- **Friedland 2011** — DNA damage yield reference (still cited by current
  generation). Cross-link to webgpu-dna validation.
- **NIST ESTAR** — already used at 8 energies (100 eV → 20 keV).

## Bench logs

All run artifacts live under `experiments/results/<YYYY-MM-DD>/level-N/<E#>.json`.
The top-level `experiments/results/README.md` indexes them chronologically.
