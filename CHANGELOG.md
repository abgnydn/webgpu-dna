# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/) starting
from `0.1.0`.

## [Unreleased]

### Errata — corrected from v0.2.0 docs (2026-05-11 audit)

After re-running all 11 experiments and auditing the prose against the
committed artifacts, two claims were tightened to match what the JSON
actually supports:

- **"Ions per primary ≈ 509 vs 509.1 → 1.00×"** in the README headline
  table is **incorrect as written**. The E5 artifact reports
  `wgslPrimaryOnly = 194.1` (primary track only) and `wgslSecPerPri = 143.2`,
  and explicitly flags this metric as `INFORMATIONAL — counting-convention
  mismatch` (Geant4 ntuple sums the full cascade; WebGPU's `box_ions`
  counts the primary track only). Corrected to report 194.1 + an
  implied-ions-per-secondary sanity check of 2.20 (physical bound [2, 3]).
- **"G(e⁻aq) V-shape at 1-3 keV is ~40σ outside MC noise"** appeared in
  five places (`README.md`, `CLAUDE.md`, `CHANGELOG.md`, `experiments/results/README.md`,
  `experiments/level-4-chemistry/protocol.md`). The E10 artifact stores
  `trials: 1` and no per-row SEM — the σ figure is not derivable from
  anything committed. Replaced with the artifact-supported statement
  from `summary.lowEFindings.eaq`: an **11.8% drop** between 1 keV and
  3 keV, real track-end / spur-structure physics, not MC scatter.
  Computing a formal σ-significance via bootstrap is the explicit
  follow-up (working title E10b).

Every numeric claim in `README.md` and `CLAUDE.md` is now tagged with a
`[E5]` / `[E10]` / `[B1]` source marker pointing at the dated artifact.

## [0.2.0] — 2026-05-08

Research-grade protocol release. Promotes the validation prose from
"we claim X" to "X.json says X with these specific bars and findings"
by adopting the same falsifiable-experiment discipline as the sibling
`webgpu-q` project.

### Added — research protocol

- **`RESEARCH.md`** — thesis sentence, reproducibility / timing /
  correctness / honest-negatives standards, six-level experiment table.
- **`experiments/` tree** — 12 falsifiable experiments shipping JSON
  artifacts under `experiments/results/<date>/level-N/`:
  - **L0 env** (2): B0 browser env, B1 harness liveness.
  - **L1 cross sections** (5, all passing): E1 Born ionization,
    E2 Emfietzoglou excitation, E3 Champion elastic (retroactively
    catches the historical 334× scale-factor regression in
    `memory/cross_section_fix.md`), E4 Sanche vibrational total,
    E4b Sanche per-mode XVMF fractions.
  - **L2 track structure** (3): E5 CSDA + E-cons + ions vs Geant4
    ntuple, E6 MFP across 6 energy bins, E6b per-process σ
    decomposition.
  - **L4 chemistry** (1): E10 IRT G-values vs Karamitros 2011 across
    5 primary energies.
  - **L3, L5, L6** — protocol-only (deferred).
- **`experiments/lib/`** — shared helpers (`xs-bitmatch.mjs` for L1,
  `run-irt.mjs` for L4 with mtime-keyed cache, `browser.mjs` +
  `env-browser.mjs` + `dev-server.mjs` for browser-runner experiments,
  `artifact.mjs` for the `meta / env / status / diagnosis / summary /
  rows` JSON shape, `env.mjs` for Node-side env capture, `seeds.mjs`
  for named deterministic seeds).
- **`npm run experiments -- <id>`** — CLI dispatcher; `<id>` ∈
  {B0, B1, E1, E2, E3, E4, E4b, E5, E6, E6b, E10}.
- **`npm run check-browser`** — quick Playwright + headless Chromium
  + WebGPU pipeline sanity check.

### Added — browser-runner infrastructure

- **Playwright + headless Chromium** (`devDependency`) with the
  `--headless=new` + `--enable-unsafe-webgpu` + `--enable-features=Vulkan`
  flag set that exposes `navigator.gpu` in a secure context. Vite
  dev-server lifecycle wrapper (`dev-server.mjs`) for browser-driven
  physics experiments. B1 proves the full stack live: vite + harness
  HTML + main.ts + `ensurePipelines` + Phase A WGSL dispatch + table
  render → captured Node-side as a JSON artifact.

### Research findings now in the ledger

The protocol surfaced four substantive findings that were not visible
from the prose-only validation:

1. **G(e⁻aq) is non-monotonic between 1 and 3 keV** (1.156 → 1.027 →
   1.149). At N=4096 this is ~40σ outside MC noise — a real V-shape
   attributable to track-end / spur-structure physics. The naive
   "monotonic LET deficit" framing applies cleanly only to E ≥ 5 keV.
2. **The 0.985× CSDA ratio is 4.61σ statistically significant.** The
   1.5% systematic underestimate is a real physics gap, not random
   scatter at N=4096. Tightening to a 2σ pass bar when the physics
   improves is the explicit follow-up.
3. **MFP is consistently 4-11% lower than Geant4 across all bins.**
   Quantifies the README's "MFP within 2-14%" prose.
4. **σ_ion is 5.6% high and σ_el is 6.3% high vs Geant4.** Previously
   undocumented. E6b decomposes the MFP shortfall as ~47% from
   σ_ion overestimate, ~31% from σ_el overestimate, ~22% from the
   intentional Emfietzoglou-vs-Born σ_exc inflation.

### Added — auto-memory entries

- `geant4_versions.md` — current Geant4 11.4.1 / G4EMLOW 8.8 ecosystem
  state (refresh ~6 months).
- `geant4_dna_references.md` — landmark cross-validation papers
  (Karamitros 2011, Tran 2024, Friedland 2011, molecularDNA,
  dsbandrepair) and the chemistry constructor taxonomy
  (option1 SBS vs option3 IRT clarification).

### Site copy fix

- `index.html`: replaced "chemistry within textbook tolerances" with
  the explicit `0.6×–1.2× Karamitros 2011 (LET-dependent)` range, and
  "G(H) / G(H₂) match Karamitros within 15%" with per-species ratios
  (G(H₂) ≈ 1.1×, G(H) ≈ 1.2×, plus the LET caveat for G(OH) / G(eaq)).

### Test surface

- Same 46 unit tests pass (no physics changes; all additions are
  research-protocol scaffolding and validation infrastructure).
- 12 new research-grade experiments exposed via `npm run experiments`.

### Known gaps unchanged from 0.1.0

- GPU-resident chemistry path (`chemBackend: 'gpu'`) still undercounts.
  E11 (GPU vs IRT formal comparison) is now infrastructure-ready —
  pending only a programmatic API in `src/app.ts` to drive Phase C
  on a saved rad_buf without re-running Phase A+B. Deferred to 0.3.x.
- `data/g4emlow/` is not committed; download from CERN to rebuild
  cross sections.

[0.2.0]: https://github.com/abgnydn/webgpu-dna/releases/tag/v0.2.0

## [0.1.0] — 2026-05-04

First public release. The repo has been on GitHub for a while via
preview-only deploys; this is the line under which versioned releases start.

### Added

- **Physics engine** (`src/physics/` + `src/shaders/`) — Born ionization
  (5 shells, data-driven CDF sampling), Emfietzoglou excitation (5 levels,
  dissociative branching 0.65 / 0.55 / 0.80), Champion tabulated elastic
  angular CDF (< 200 eV), screened-Rutherford elastic (> 200 eV), Sanche
  9-mode vibrational (2–100 eV), full primary-momentum conservation. One
  GPU thread per primary electron, full particle history in a single fused
  compute dispatch.
- **Chemistry — Karamitros 2011 IRT** in a Web Worker (`src/chemistry/`):
  9-reaction Smoluchowski TDC + Onsager-screened PDC for charged pairs
  (G4EmDNAChemistry_option1). 2.0 nm mother displacement, species-specific
  product displacement, e⁻aq thermalization at 1.7 eV, H₂O₂ / OH⁻ tracked
  as reactive products with full re-pairing.
- **DNA scoring** (`src/scoring/`) — event-level direct SSB from `rad_buf`
  ionization sites, indirect SSB from diffused OH at 1 μs, greedy ±10 bp
  DSB clustering, kernel-level backbone hit counter as cross-check.
  Target: 21×21 parallel B-DNA fibers × 3 μm × 150 nm spacing = 3.89 Mbp.
- **Validation harness** (`validation/compare.py`) — side-by-side run
  against a Geant4-DNA ntuple (4096 primaries @ 10 keV).
- **G4EMLOW converter** (`tools/convert_g4data.py`) — Python pipeline that
  emits `public/cross_sections.wgsl` (1.3 MB committed) from the 245 MB
  CERN G4EMLOW reference data.
- **WGDNA-4D viewer** (`src/splat/`) — Gaussian-splat 4D visualisation of
  the simulation, with a one-click handoff from the landing page and a
  `/see` share view. Mobile-friendly with touch + pinch and a responsive
  control panel; perf-aware defaults for low-end devices.
- **Landing page** with verified browser-support claims, comparison table
  vs Geant4 direct, full SEO + social + PWA asset pass, and links to the
  companion projects ([kernelfusion.dev](https://kernelfusion.dev),
  [gpubench.dev](https://gpubench.dev),
  [zerotvm.com](https://zerotvm.com)).
- **Live deployment** at https://webgpudna.com.

### Validated against (N = 4096 primaries @ 10 keV)

| Metric                  | This build | Reference                  | Ratio       |
| ----------------------- | ---------- | -------------------------- | ----------- |
| CSDA range (nm)         | 2714.4     | 2756.5 (Geant4-DNA direct) | **0.985×**  |
| Energy conservation     | 100.0 %    | 100.0 %                    | 1.000×      |
| Ions per primary (full) | ≈ 509      | 509.1 (Geant4 direct)      | 1.00×       |
| G(OH) at 1 μs           | 1.55       | 2.50 (Karamitros 2011)     | 0.62×¹      |
| G(e⁻aq) at 1 μs         | 1.41       | 2.50                       | 0.56×¹      |
| G(H) at 1 μs            | 0.71       | 0.57                       | 1.24×       |
| G(H₂O₂) at 1 μs         | 0.60       | 0.73                       | 0.83×       |
| G(H₂) at 1 μs           | 0.47       | 0.42                       | 1.11×       |

¹ G(OH) / G(e⁻aq) at 10 keV LET are inherently below the Karamitros 2011
low-LET (~1 MeV) reference — track-core density drives higher radical
recombination.

### Test surface

- 46 unit tests across 7 files (Vitest).
- Geant4-DNA reference numbers shipped as JSON fixtures under
  `tests/fixtures/`.

### Known gaps

- GPU-resident chemistry path (`chemBackend: 'gpu'`) undercounts long-time
  reactions vs IRT because the spatial-hash search radius is narrower than
  the diffusion σ at 30 ns timesteps. Default backend is therefore the IRT
  worker.
- `data/g4emlow/` is not committed — download from CERN to rebuild
  cross sections via `npm run convert`.

[0.1.0]: https://github.com/abgnydn/webgpu-dna/releases/tag/v0.1.0
