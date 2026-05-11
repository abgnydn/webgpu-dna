# Experiments — bench logs

All run artifacts live under
`experiments/results/<YYYY-MM-DD>/level-N/E<k>-<slug>.json`.

Per RESEARCH.md "Honest negatives" standard, failed runs are committed
alongside passing ones. Each artifact carries:

- `meta` — protocol ID, hypothesis, pass bar, named seed, warmup, trials
- `env` — git SHA, timestamp, runner, platform, hardware
- `status` — `pass` | `fail` | `noisy`
- `diagnosis` — short failure reason when `status != "pass"`
- `summary` — aggregated metrics (median, p90, max, peak ratio, etc.)
- `rows` — per-trial / per-cell observations

## Index (chronological)

| Date | Level | Experiment | Status | Headline |
|------|-------|-----------|--------|----------|
| 2026-05-11 | L0 | B0-browser-env        | pass | apple/metal-3, maxBuffer 4 GB, headless Chromium; first browser-runner artifact (validates Playwright + WebGPU pipeline) |
| 2026-05-11 | L0 | B1-harness-liveness   | pass | First row (E=100 eV) in 2.9s, CSDA=15.7 nm via Playwright + vite + real WebGPU; full pipeline live end-to-end |
| 2026-05-11 | L1 | E1-ion-xs-match       | pass | peak_ratio 0.9987, median 8.46e-4, p90 1.78e-2 vs G4EMLOW Born σ_ion |
| 2026-05-11 | L1 | E2-exc-xs-match       | pass | peak_ratio 0.9970, median 2.42e-4, p90 3.51e-3 vs G4EMLOW Emfietzoglou σ_exc |
| 2026-05-11 | L1 | E3-elastic-xs-match   | pass | peak_ratio 0.9751, median 1.25e-4, p90 7.78e-4 vs G4EMLOW Champion σ_el (retroactive 334× catcher) |
| 2026-05-11 | L1 | E4-vib-xs-match       | pass | peak_ratio 1.0000, median 2.6e-16, max 6e-16 vs G4EMLOW Sanche σ_vib total |
| 2026-05-11 | L1 | E4b-vib-mode-fractions | pass | 342 (energy × mode) pairs vs raw σ_mode/σ_total; max sum dev 4e-8 (closes L1 fully) |
| 2026-05-11 | L2 | E5-csda-vs-g4-ntuple  | pass | CSDA 2714.4 vs 2747.5 (0.988×, 3.59σ); E-cons 100% vs 99.99% vs Geant4 11.4.1 ntuple — surfaces 1.2% CSDA bias as statistically significant |
| 2026-05-11 | L2 | E6-mfp-vs-g4-ntuple   | pass | 6 energy bins (100 eV → 10 keV) vs Geant4 11.4.1 ntuple, MFP_total ratios [0.893, 0.950] (median 0.941) |
| 2026-05-11 | L2 | E6b-sigma-per-process-vs-g4 | pass | Per-process σ vs Geant4 11.4.1: σ_ion mean 1.061 (6.1% high), σ_el mean 1.057 (5.7% high), σ_exc mean 2.55 (Emfietzoglou-vs-Born, intentional) |
| 2026-05-11 | L2 | E7-ions-per-primary-cascade | **fail (honest negative)** | Cascade ions/primary reconstructed from dumps/rad_E10000_N4096.bin H3O+ records (species_code=3): **WGSL 371.88 vs Geant4 11.4.1 509.23 → 0.7303× (263.2σ, 27% deficit)**. Closes the counting-convention question E5 punted on — the gap is a real physics deficit, likely tied to E6b's σ_exc inflation channeling energy away from ionization. |
| 2026-05-11 | L4 | E10-irt-vs-karamitros | pass | 5 energies (1/3/5/10/20 keV) × 5 species vs Karamitros 2011 — surfaced G(e⁻aq) V-shape at 1→3 keV (1.163→1.026→1.147, **11.8% drop** in `summary.lowEFindings`; real track-end / spur-structure effect; LET monotonicity confirmed for E ≥ 5 keV) |
| 2026-05-11 | L6 | E15-phase-a-alpha-beta | **fail (honest negative)** | Phase A N-sweep {1,4,16,64,256,1024,4096,16384} on apple/metal-3, W=5 + T=20 with `onSubmittedWorkDone()` sync. OLS fit: **α = 10527.8 μs** (outside original [10, 500] μs hypothesis — actually a single-workgroup compute floor, not pure dispatch overhead), β = 1.207 μs/primary, R² = 0.908. **Peak throughput 538,947 primaries/sec at N=16384**. Diagnosis + revised two-regime pass bar in `experiments/level-6-performance/protocol.md`. |
| 2026-05-11 | L6 | E15b-vs-geant4-single-thread | pass | Geant4 11.4.1 single-thread on M2 Pro, 3 trials × 4096 primaries × 10 keV × DNA_Opt2, median 289.1 s wall (trials 293.3 / 286.6 / 289.1 s). **WGSL Phase A+B = 635 ms → 455× speedup** (matched-scope physics tracking, satisfies L6 ≥100× thesis). End-to-end pre-DNA pipeline (Phase A+B+IRT) only 1.48× because IRT chemistry on CPU dominates (194 s of 194.6 s). |
