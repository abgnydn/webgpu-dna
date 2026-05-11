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
| 2026-05-11 | L2 | E5-csda-vs-g4-ntuple  | pass | CSDA 2714.4 vs 2756.5 (0.985×, 4.61σ); E-cons 100% vs 100%; ions/primary reported informational (counting-convention mismatch) — surfaces 1.5% CSDA bias as statistically significant |
| 2026-05-11 | L2 | E6-mfp-vs-g4-ntuple   | pass | 6 energy bins (100 eV → 10 keV), MFP_total ratios [0.895, 0.965] (median 0.926), confirms README "MFP within 2-14%" claim numerically |
| 2026-05-11 | L2 | E6b-sigma-per-process-vs-g4 | pass | Per-process σ decomposition: σ_ion mean 1.056 (5.6% high), σ_el mean 1.063 (6.3% high), σ_exc mean 2.57 (Emfietzoglou-vs-Born, intentional) — **decomposes the E6 -7% MFP into per-process contributions** |
| 2026-05-11 | L4 | E10-irt-vs-karamitros | pass | 5 energies (1/3/5/10/20 keV) × 5 species vs Karamitros 2011 — surfaced G(e⁻aq) V-shape at 1→3 keV (1.163→1.026→1.147, **11.8% drop** in `summary.lowEFindings`; real track-end / spur-structure effect; LET monotonicity confirmed for E ≥ 5 keV) |
| 2026-05-11 | L6 | E15-phase-a-alpha-beta | **fail (honest negative)** | Phase A N-sweep {1,4,16,64,256,1024,4096,16384} on apple/metal-3, W=5 + T=20 with `onSubmittedWorkDone()` sync. OLS fit: **α = 10527.8 μs** (outside original [10, 500] μs hypothesis — actually a single-workgroup compute floor, not pure dispatch overhead), β = 1.207 μs/primary, R² = 0.908. **Peak throughput 538,947 primaries/sec at N=16384**. Diagnosis + revised two-regime pass bar in `experiments/level-6-performance/protocol.md`. |
