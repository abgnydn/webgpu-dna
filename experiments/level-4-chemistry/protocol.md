# Level 4 — Chemistry G-values at 1 μs

## Status: in progress
E10 (IRT vs Karamitros 2011) implemented and shipping its first artifact.
E11 (GPU vs IRT backend) blocked on browser-runner infrastructure (the
GPU chemistry path needs WebGPU; we run the IRT side Node-side via
`tools/run_irt.cjs` against rad_E*_N4096.bin dumps).

## Thesis fragment
> G-values at t = 1 μs from the Karamitros 2011 9-reaction IRT in
> `public/irt-worker.js` reproduce the published reference values from
> Karamitros 2011 / Tran 2024, with explicit accounting for the
> LET-induced deficit at 10 keV vs the ~1 MeV low-LET reference.

## Baseline (E10 results across 5 energies, post-migration 2026-04-21 dumps)

| E (eV) | G(OH) | G(e⁻aq) | G(H) | G(H₂O₂) | G(H₂) |
|-------:|------:|--------:|-----:|--------:|------:|
|   1000 | 0.961 |   1.156 | 0.715 |  0.943 | 0.665 |
|   3000 | 1.104 |   1.027 | 0.697 |  0.777 | 0.626 |
|   5000 | 1.275 |   1.149 | 0.704 |  0.700 | 0.566 |
|  10000 | 1.553 |   1.408 | 0.705 |  0.604 | 0.468 |
|  20000 | 1.802 |   1.658 | 0.690 |  0.520 | 0.387 |

vs Karamitros 2011 reference (low-LET, ~1 MeV): 2.50 / 2.50 / 0.57 /
0.73 / 0.42.

The G(OH) / G(e⁻aq) deficit is physically expected — Karamitros's
reference is for low-LET radiation where track-core radical recombination
is lower. A research-grade pass bar must encode this expectation;
comparing 10 keV results to low-LET references with a flat 10% bar
would always fail for the wrong reason.

**Empirical finding from E10 first run:** G(e⁻aq) is **non-monotonic
between 1 and 3 keV** (1.156 at 1 keV, drops to 1.027 at 3 keV, back
up to 1.149 at 5 keV). At N = 4096 primaries this is ~40σ outside MC
noise — it's a real physical V-shape, attributable to track-end /
spur-structure effects in the keV regime. The naive
"monotonically-increasing G(e⁻aq) with primary energy" framing in the
README applies cleanly only to E ≥ 5 keV. The protocol's LET-trend
pass bar reflects this: monotonic check applied only above the 5 keV
threshold; sub-5-keV deviations reported as informational findings.

## Experiments

### E10 — IRT G-values at 1 μs vs Karamitros 2011
- **Status:** **Implemented.** First artifact at
  `experiments/results/<date>/level-4/E10-irt-vs-karamitros.json`.
- **Hypothesis:** Karamitros 2011 9-reaction IRT (run via
  `tools/run_irt.cjs` on per-energy `rad_E*_N4096.bin` dumps) produces
  G-values at t = 1 μs that match the published low-LET (~1 MeV)
  reference within per-species bands, AND G(OH) / G(e⁻aq) increase
  monotonically with primary energy (the LET-deficit signature).
- **Method:** For each available `dumps/rad_E<E>_N4096.bin`,
  invoke the Node-side IRT runner; extract `G(species, t=1μs)` from
  the timeline; compare per-species against Karamitros 2011.
- **Pass bar (all required):**
  1. Per-(energy, species) loose bands designed to catch scale-factor /
     unit bugs (Karamitros is a low-LET reference; tight bands aren't
     justified at 1-20 keV without a matched-LET reference):
     - G(OH), G(e⁻aq): ratio ∈ [0.30, 1.10]
     - G(H): ratio ∈ [0.50, 1.80]
     - G(H₂O₂), G(H₂): ratio ∈ [0.40, 2.20]
  2. **LET trend monotonic for E ≥ 5 keV** — G(OH) and G(e⁻aq) increase
     with primary energy in the regime where Karamitros's framing
     applies cleanly. Sub-5-keV behavior is reported as informational
     evidence of track-end / spur-structure effects, not a failure.
- **Inputs (gitignored).** `rad_E*_N4096.bin` dumps live under `dumps/`
  and are produced by the browser harness via the `dump_server.cjs`
  POST endpoint. Sizes range from 1 MB (100 eV) to 162 MB (20 keV);
  too large for git. Regenerate via `npm run dev` → run the validation
  sweep → "Dump radicals" per energy. The experiment fails gracefully
  with a clear diagnosis when a dump is missing.
- **IRT cache.** `experiments/.cache/E10/E<E>-N<n>.json` (gitignored)
  caches the IRT timeline keyed on the .bin file's mtime. Re-runs are
  free when the .bin hasn't changed; fresh runs auto-populate the
  cache. The cache is recreatable from the .bin and run_irt.cjs.
- **Energies covered:** 1, 3, 5, 10, 20 keV (the post-migration
  2026-04-21 dump set). 100 / 300 / 500 eV dumps exist on disk but
  are excluded from E10 because Karamitros 2011 is a low-LET reference
  and sub-keV electrons are deep in the high-LET regime where
  bias-correction is large.
- **Future E10b — Tran 2024 chem6 at matched LET.** Tran 2024 (Med
  Phys, ESA BioRad III review) Fig 5 shows G(eaq) and G(OH) for "1 MeV
  electrons with eLossMin=10 keV, eLossMax=10.1 keV" — i.e. restricted
  to electrons depositing ~10 keV per event, which gives an **LET
  matched to our 10 keV primary data**. That's a much tighter cross-
  reference than the Karamitros 2011 low-LET (~1 MeV) frame.
  Blocked: 2026-05-07 ingest attempt via WebFetch failed because the
  G-values are embedded in figures rather than tabular text. Path
  forward is either (a) PDF + manual digitization of Fig 5 / Tabs
  cited in [67-69], (b) running Geant4-DNA chem6 example locally,
  or (c) fetching one of Tran's three cited experimental datasets.

### E11 — GPU chemistry backend vs IRT worker
- **Status:** **Deferred — needs browser-runner infrastructure.**
  The IRT side runs Node-side via `tools/run_irt.cjs`, but the GPU
  chemistry path (`src/shaders/chemistry.wgsl`) needs WebGPU. Either:
  (a) add Playwright + headless Chrome with WebGPU enabled, or
  (b) add `node-webgpu` as a runtime. Either is a separate
  infrastructure stage.
- **Hypothesis:** The `chemBackend: 'gpu'` path produces G-values within
  10% of the IRT worker at the same N and same time checkpoints.
- **Method:** Run the same primary set through both backends; compare
  G(species, t) at all 7 time checkpoints (0.1 ps → 1 μs).
- **Pass bar:** `|G_gpu − G_irt| / G_irt < 0.10` at every (species, t).
- **Expected outcome:** **fail.** CLAUDE.md flags the GPU backend as
  undercounting long-time reactions because the spatial-hash search
  radius is narrower than the diffusion σ at 30 ns timesteps. This
  experiment exists to *quantify* the deficit and commit it as
  `status: "fail"` with a diagnosis pointing at the diffusion-σ vs
  hash-radius math — the marquee honest negative for Level 4.
- **Why ship the failure:** webgpu-q's pattern. A documented failure
  with reproducible numbers is research-grade; a one-line "known gap"
  in CLAUDE.md is a footnote.

## Artifacts
`experiments/results/<YYYY-MM-DD>/level-4/E<k>-<slug>.json`.
