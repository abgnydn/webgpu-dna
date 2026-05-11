# Level 6 — Performance

## Status (as of 2026-05-11)
- **E15 stage 1: implemented.** First artifact at
  `experiments/results/2026-05-11/level-6/E15-phase-a-alpha-beta.json`.
  **Status: fail** (honest negative) — α came in at 10.5 ms, ~21× higher
  than the protocol's [10, 500] μs upper bound, and R² = 0.908 still
  satisfies the linearity criterion only because OLS fits a forced line
  through a piecewise-flat-then-linear curve.
- **E16: not implemented.** Needs a naive per-step variant of `primary.wgsl`.
- **E15b (vs Geant4 single-thread): not implemented.** Geant4 11.3.0
  source on disk at `~/Downloads/geant4-11.3.0`; binary install missing
  (`geant4-config` not on PATH). Build in flight as of 2026-05-11.

## Thesis fragment
> The fused per-primary WGSL dispatch is bandwidth-limited at production
> N (≥ 4096 primaries) and beats Geant4-DNA single-thread CPU on the
> same machine by ≥ 10² wall-clock for a 10 keV 4096-primary run.

## Baseline
Per the kernel-fusion thesis (kernelfusion.dev), single-dispatch fused
kernels reach 71× on Apple Silicon and 56× on NVIDIA on launch-bound
workloads. Whether that magnitude transfers to webgpu-dna is the open
question this level answers. Existing claim "hours → 6 seconds" is
~10³× but unmeasured head-to-head.

## Experiments

### E15 — Phase A dispatch overhead α + per-amplitude β
- **Original hypothesis:** Phase A wall time decomposes as `T(N) = α + β·N`
  with α ∈ [10, 500] μs (fixed submit + sync cost) and β > 0. At N ≥ 1024
  the variable term dominates.
- **Method:** Dispatch Phase A at N ∈ {1, 4, 16, 64, 256, 1024, 4096,
  16384}; W=5 warmup + T=20 trials with forced GPU sync (encode +
  submit + `onSubmittedWorkDone()`) before/after each measurement; OLS
  fit medians.
- **Original pass bar:** α ∈ [10, 500] μs AND β > 0 AND R² ≥ 0.85. NOISY
  if > 50% of cells flag std/median > 0.1.
- **Observed (2026-05-11, apple/metal-3):** α = **10527.8 μs** (10.5 ms),
  β = **1.207 μs/primary**, R² = 0.908. Per-N medians (ms):
  - N=1: 6.7, N=4: 8.75, N=16: 10.6, N=64: 12.5, N=256: 13.35,
    N=1024: 13.9, N=4096: 14.4, N=16384: 30.4.
  - Peak throughput **538,947 primaries/sec at N=16384**.
- **Diagnosis:** the original "α ∈ [10, 500] μs" hypothesis was wrong
  for this kernel. Phase A's inner loop runs the full per-primary
  history (up to 65 536 steps) within the WGSL `for` loop, so even at
  N=1 the launched workgroup runs ~7 ms of compute. What OLS is fitting
  as "α" is actually a **single-workgroup compute floor** (1 workgroup
  = 256 threads, fully utilized once we have ≥ 256 primaries to issue),
  not pure dispatch overhead. The kernel-fusion thesis itself is intact:
  β > 0, peak throughput is 5.4×10⁵ primaries/sec, and adding more
  primaries past the saturation point is ~free until the per-workgroup
  bandwidth bound dominates at N ≥ 16k.
- **Revised pass bar (for E15 v2, when implemented):** fit a two-regime
  model — a launch-bound floor `T_floor(N) = max(T_1, ⌈N/256⌉·t_wg)`
  for small N and a linear regime `T(N) ≈ α + β·N` for N ≥ N_sat
  (saturation point, expected around the number of resident workgroups
  the GPU can run concurrently). Pass when N_sat is identifiable AND
  β > 0 in the saturated regime AND peak throughput ≥ 1×10⁵ primaries/sec.
- **Why this matters:** the floor that the fusion thesis attacks. A
  measured α gives the speedup magnitude. The first run already
  surfaces that the marginal cost of one more primary is 1.2 μs once
  the kernel is "warm" — that's the number to multiply against Geant4's
  per-primary CPU cost in E15b.

### E16 — Fused vs naive per-step dispatch (synthetic baseline)
- **Hypothesis:** The fused single-dispatch path is ≥ 10² faster than
  a "naive" baseline that submits one dispatch per physics step.
- **Method:** Implement a naive variant for measurement purposes only
  (one dispatch per step, no fusion); benchmark against the production
  fused path at N=4096, E=10 keV; report speedup.
- **Pass bar:** `t_naive / t_fused ≥ 100` AND fused path is bandwidth-
  bound by E15's α/β decomposition.
- **Why:** This is the kernel-fusion thesis demonstrated within
  webgpu-dna. Without it, the kernelfusion.dev framing on the site
  is unsupported speculation.

## Artifacts
`experiments/results/<YYYY-MM-DD>/level-6/E<k>-<slug>.json`. GPU runs;
artifact carries the full adapter info + limits block per webgpu-q's
shape.
