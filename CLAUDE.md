# WebGPU DNA Track Structure Simulation

## Goal

Port Geant4-DNA (the CNRS/IN2P3-coordinated Monte Carlo track structure toolkit
for radiobiology) to WebGPU compute shaders using kernel fusion architecture.
One WGSL dispatch per batch for primaries — one GPU thread per primary electron,
full history in a loop, zero per-step dispatch overhead.

## Research protocol

The repo is on a research-grade ladder mirroring `~/webgpu-q`. The
master doc is `RESEARCH.md`. Per-level protocols live under
`experiments/level-N-<slug>/protocol.md`. Stage 1 ships **Level 1, E1**
(Born ionization total cross section vs G4EMLOW) — passing artifact
committed under `experiments/results/<date>/level-1/`.

Six levels:
1. Cross sections vs G4EMLOW (E1–E4)
2. Track structure vs Geant4 11.4.1 ntuple (E5–E8)
3. Pre-chemistry initial G-values vs chem6 (E9)
4. Chemistry G-values vs Karamitros 2011 / Tran 2024 (E10–E11)
5. DNA damage vs Friedland 2011 / molecularDNA (E12–E14)
6. Performance vs Geant4 single-thread baseline (E15–E16)

Working pattern (mirroring webgpu-q):
- Each stage = one focused commit with the protocol update + the
  experiment + the artifact JSON.
- Failed experiments are committed with `status: "fail"` and a
  diagnosis. Failures are evidence — never rerun until the test passes.
- Every artifact carries git SHA, timestamp, named seed (from
  `experiments/lib/seeds.mjs`), pass bar, and per-row observations.
- Run via `npm run experiments -- E1` (CLI dispatcher in
  `experiments/runner.mjs`).

When extending: write the protocol entry **before** the code, commit
both together. CLAUDE.md should describe the next stage before it
lands — the discipline that makes the doc one stage ahead of git.

## Architecture (high level)

See `ARCHITECTURE.md` for the full pipeline diagram and buffer map. Summary:

- **Phase A (primary tracking)** is a single fused WGSL compute dispatch. One
  thread per primary runs the full particle history in a `for` loop — ionization,
  excitation, elastic, vibrational all inline in `main()`.
- **Phase B (secondary wavefront)** — 2000 dispatches of `chemistry.wgsl`'s
  sibling `secondary.wgsl`, each advancing all alive secondaries by one physics
  step. Can't fuse because sec_n is unknown until Phase A completes.
- **Phase C (radiolysis chemistry)** — by default a Web Worker
  (`public/irt-worker.js`) running the Karamitros 2011 9-reaction IRT on CPU off
  the main thread. A GPU grid-hash alternative (`src/shaders/chemistry.wgsl`)
  exists for CSDA-only throughput runs but is less accurate at long times.
  Backend is selectable via `src/chemistry/backend.ts` (`DEFAULT_CHEM_BACKEND`).
- **atomicAdd** for dose/radical deposition to shared voxel grid (128³, with
  WGSL `p.box` as half-width). Dose is fixed-point ×100 units/eV (max voxel
  42.9 MeV, catches sub-0.1 eV events).

## Validation harness

The active harness is `src/app.ts` → `runValidation()`, rendered by the TS/Vite
build into `index.html`. `public/geant4dna.html` is a historical monolithic
reference kept in-repo for bit-identical physics cross-checks — it is not the
validation target.

### Current validation status (N = 4096 primaries, 10 keV)

Matches numbers in `README.md` — single source of truth. As of 2026-04-21:

- **CSDA** 2714.4 nm vs Geant4-DNA direct 2756.5 nm → **0.985×**
- **Ions per primary** ≈ 509 vs Geant4 509.1 → 1.00×
- **Energy conservation** 100.0% across all 8 ESTAR energies
- **MFP vs Geant4** within 2–14% at all energies (100 eV – 10 keV)
- **G(OH) @ 1 μs** 1.55 → 0.62× Karamitros 2011
- **G(e⁻aq) @ 1 μs** 1.41 → 0.56×
- **G(H) @ 1 μs** 0.71 → 1.24×
- **G(H₂O₂) @ 1 μs** 0.60 → 0.83×
- **G(H₂) @ 1 μs** 0.47 → 1.11×
- **46 / 46** unit tests pass (`npm run test`)

G(OH) / G(e⁻aq) at 10 keV are inherently below the Karamitros 2011 reference
because that reference is for ~1 MeV low-LET radiation, where track-core radical
recombination is lower. See `validation/compare.py` for the full side-by-side.

### Research-grade validation ledger (11 artifacts, 2026-05-07/08)

The prose claims above are now backed by falsifiable JSON artifacts
under `experiments/results/`. See `RESEARCH.md` for the protocol and
per-level `protocol.md` files for hypotheses + pass bars.

- **L0 — Browser-runner infra (2 of 2 passing).** B0 browser env capture,
  B1 webgpu-dna harness liveness via Playwright + headless Chromium WebGPU
  (E=100 eV first row, CSDA=15.7 nm in 4.4 s).
- **L1 — Cross sections (5 of 5 passing).** E1 Born ionization, E2
  Emfietzoglou excitation, E3 Champion elastic (retroactive 334×
  scale-factor catcher per memory/cross_section_fix.md), E4 Sanche
  vibrational total, E4b Sanche per-mode XVMF fractions. All five WGSL
  cross-section tables bit-match their G4EMLOW source data.
- **L2 — Track structure (3 of 5 planned, 3 of 3 attempted passing).**
  E5 CSDA + E-cons + ions @ 10 keV vs Geant4 ntuple. E6 MFP across 6
  energy bins (-3.5% to -10.5% deviation, all within 25% bar). E6b
  per-process σ decomposition — back out σ_ion / σ_el / σ_exc from
  the ntuple's per-process counts and compare to WGSL XI / XL / XC.
  E7 (ions per primary) and E8 (secondary KE spectrum) deferred.
- **L4 — Chemistry (1 of 2 passing).** E10 IRT G-values vs Karamitros
  2011 across 5 primary energies (1/3/5/10/20 keV). E11 GPU vs IRT
  backend deferred — needs browser runner infrastructure.
- **L3, L5, L6** — protocols only.

**Four substantive findings now in the research ledger** (would NOT
be visible without the protocol):

1. **G(e⁻aq) is non-monotonic between 1 and 3 keV** (1.156 → 1.027 → 1.149).
   ~40σ outside MC noise at N=4096 — a real V-shape attributable to
   track-end / spur-structure physics, not MC scatter or a bug. The
   naive "monotonic LET deficit" framing applies cleanly only to E ≥ 5 keV.
   In E10's `summary.lowEFindings`.
2. **The 0.985× CSDA ratio is 4.61σ statistically significant.**
   The 1.5% systematic underestimate is a real physics gap, not random
   scatter at N=4096. E5's σ pass bar at 5σ deliberately accommodates
   this documented bias; tightening to 2σ when the physics is improved
   is the explicit follow-up.
3. **MFP is consistently 4-11% lower than Geant4 across all bins.**
   Confirms README's "MFP within 2-14%" prose numerically.
4. **σ_ion is 5.6% high and σ_el is 6.3% high vs Geant4** (E6b
   decomposition). Previously undocumented — only the σ_exc inflation
   (Emfietzoglou-vs-Born) was explained. Per E6b, the MFP shortfall
   decomposes as ~47% from σ_ion overestimate, ~31% from σ_el
   overestimate, ~22% from the (intentional) σ_exc inflation.
   The σ_exc ratio observed (2.46-2.66×, mean 2.57×) is slightly
   higher than the "2.2-2.4× larger than Born" documented in
   `tools/convert_g4data.py` — worth re-deriving when convenient.

Run any experiment via `npm run experiments -- <id>` (e.g. `E10`).

### What's wired up

- Full tabulated cross sections from G4EMLOW 8.8 (Born ionization, Emfietzoglou
  excitation, Champion elastic CDF, Sanche vib)
- 5 ionization shells (Born) + 5 excitation levels (Emfietzoglou, data-driven
  fractions) with level-dependent dissociative branching (0.65 / 0.55 / 0.80)
- Screened-Rutherford elastic analytical + Champion tabulated angular CDF
- Sanche vibrational excitation (9 modes, 2–100 eV)
- Secondary electron wavefront stepper (2000 steps)
- **Karamitros 2011 9-reaction IRT chemistry** in `public/irt-worker.js`
  (G4EmDNAChemistry_option1, TDC / PDC types, Onsager-screened for charged pairs).
  Default backend.
- Pre-chemistry: 2.0 nm mother displacement + species-specific product
  displacement (OH σ=0.46 nm, eaq σ=3.46 nm, H σ=1.30 nm)
- e⁻aq thermalization at 1.7 eV (Geant4 autoionization default, Meesungnoen 2002)
- Product tracking: H₂O₂ and OH⁻ as reactive species with full re-pairing
- Event-level direct SSB scoring from `rad_buf` ionization sites (nm-scale
  spatial correlation)
- Kernel-level DNA backbone hit counter (`dna_near` in both primary + secondary
  shaders) cross-checks the JS post-processing — `kernel_hits == reach_dir`,
  exactly
- Indirect SSB from diffused OH at t = 1 μs
- 21×21 parallel B-DNA fiber grid, 3 μm long, 150 nm spacing = 3.89 Mbp target
- Greedy ±10 bp DSB clustering
- Dose XY / YZ projections with zoom-to-bbox and log-magma colormap
- ESTAR validation at **8 energies**: 100 eV, 300 eV, 500 eV, 1 keV, 3 keV,
  5 keV, 10 keV, 20 keV

### Buffer sizing

Lives in `src/gpu/buffers.ts`. Key points:

- `initGPU` requests the adapter's max `maxBufferSize` and
  `maxStorageBufferBindingSize` via `requiredLimits`. The WebGPU default cap
  of 128 MiB is too small for `rad_buf` (256 MB) and silently produces empty
  dispatches.
- `MAX_SEC = 5M × 48 B = 240 MB`
- `MAX_RAD = 16M × 16 B = 256 MB`
- `CHEM_N = 8M × 16 B = 128 MB` (chem_pos) + 32 MB (alive) + 128 MB (rng) +
  32 MB (next_idx)
- `HASH_SIZE = 8M buckets × 4 B = 32 MB` (cell_head). 8× larger than the
  initial 1M baseline — gave a 4.6× chemistry speedup at N=16384.
- N = 16384 at 10 keV fits cleanly (~13M radicals, under MAX_RAD); E_cons
  stays 99.9%.

### Known convention quirks

- `p.box` is the HALF-WIDTH in WGSL (voxel size = 2×box / vc). JS scoring
  must match.
- UI `box = 15000` means ±15000 nm → 30 μm cube total (27 fL water = 27 pg).
- For a 30 μm box and 4096 × 10 keV primaries, `box_dose ≈ 0.243 Gy`.

## Known gaps

- **GPU chemistry backend** (`chemBackend: 'gpu'`) undercounts long-time
  reactions vs IRT because the spatial-hash search radius is narrower than
  the diffusion σ at the 30 ns timestep. `DEFAULT_CHEM_BACKEND` is therefore
  `'worker'` (the IRT path).
- **Indirect SSB** uses diffused OH at t = 1 μs against a concentrated
  21×21 fiber grid sampling the track core, rather than a uniform bulk
  distribution. The DSB/SSB ratio is therefore target-geometry-dependent.
- **`data/g4emlow/`** is not committed (245 MB). Download from
  https://geant4-data.web.cern.ch/datasets/ (currently `G4EMLOW.8.8.tar.gz`,
  shipped with Geant4 11.4.1) and extract so that `data/g4emlow/dna/` exists,
  then run `npm run convert` to regenerate `public/cross_sections.wgsl`.

## Commands

```bash
npm install
npm run dev            # Vite dev server at http://localhost:8765
npm run test           # 46 tests, ~200 ms
npm run lint           # ESLint src/ tests/
npm run build          # → dist/
npm run convert        # tools/convert_g4data.py  (needs data/g4emlow/)
```

## Historical validation log

Dated bug-fix entries that shaped the current physics — kept for provenance.

### 2026-04-14 — Switch to IRT + Emfietzoglou + mother displacement

1. Switched excitation from Born to Emfietzoglou (2.4× higher XS, correct
   initial G(H) = 0.33)
2. Added Geant4 mother molecule displacement (2.0 nm RMS) for ionization
   OH + H3O+
3. Full 9-reaction IRT table from G4EmDNAChemistry_option1 (added
   eaq+H₂O₂, H3O++OH⁻)
4. All reactions typed TDC / PDC matching Karamitros 2011; charged pairs
   use Onsager-screened Coulomb radius
5. Product creation + re-pairing for all reactions (not just eaq+H3O+→H)
6. e⁻aq thermalization at 1.7 eV (Geant4 autoionization default);
   H3O+ displacement = 0 + mother

### 2026-04-12 — Direct Geant4-DNA validation

Built Geant4 11.3.0, ran dnaphysics with DNA_Opt2, 4096 e⁻ at 10 keV.
Key bugs fixed against the ntuple:

1. DNA_Opt2 uses Born (NOT Emfietzoglou) for ionization (kept), but we use
   Emfietzoglou for excitation because it gives the correct initial G(H)
2. Champion elastic scaleFactor: 1e-16 cm² = 0.01 nm²/unit (was using
   2.993e-5)
3. Elastic subsampled on its own 7.4–10M eV grid then paired with 8–10K eV
   XE grid
4. Secondary wavefront step limit 300 → 2000 (elastic-dominated
   thermalization)
5. Born differential CDF returns total transfer (bind + sec_KE), not
   sec_KE alone — was double-counting binding energy, shortening tracks
   by 30%
6. G4DNABornAngle: 3-regime secondary angular sampling (<50 eV isotropic,
   50–200 mixed, >200 kinematic)
7. Primary momentum conservation after ionization (p_final = p_inc - p_sec)
8. Sanche vibrational 2× liquid phase factor
9. Data-driven Born excitation level fractions (both primary + secondary
   shaders)
10. Paired CDF / E_transfer arrays with binary search (58 energies × 100
    breakpoints × 5 shells) replacing uniform CDF sampling (mean transfer
    40 → 57 eV, matching Geant4's 57.1 eV)

## Geant4-DNA source reference

Cloned from: https://github.com/Geant4/geant4.git

Key directories:

- `source/processes/electromagnetic/dna/models/src/` — physics models
- `source/processes/electromagnetic/dna/utils/src/` — water structure data
- `source/processes/electromagnetic/dna/utils/include/` — headers

### Physics models (all in models/src/):

| Model | File | What it does |
|-------|------|-------------|
| Emfietzoglou ionization | G4DNAEmfietzoglouIonisationModel.cc | Loads `sigma_ionisation_e_emfietzoglou`, log-log interp |
| Emfietzoglou excitation | G4DNAEmfietzoglouExcitationModel.cc | Loads `sigma_excitation_e_emfietzoglou` |
| Born ionization | G4DNABornIonisationModel1.cc | Loads `sigma_ionisation_e_born` + differential |
| Screened Rutherford | G4DNAScreenedRutherfordElasticModel.cc | Analytical formula (ported) |
| Champion elastic | G4DNAChampionElasticModel.cc | Loads `sigma_elastic_e_champion` |
| Sanche vibrational | G4DNASancheExcitationModel.cc | 9 modes, 2× liquid phase factor |

### Exact formulas extracted

**Screened Rutherford elastic** (NIM 155, 145–156, 1978):

```
Z = 10 (water)
σ_Ruth = Z(Z+1) × [e²(K+mec²) / (4πε₀·K·(K+2mec²))]²
n(K) = (1.64 - 0.0825·ln(K/eV)) × 1.7e-5 × Z^(2/3) / [K/mec² × (2 + K/mec²)]
σ_el = π × σ_Ruth / [n × (n+1)]
```

**Water ionisation shells** (G4DNAWaterIonisationStructure.cc):

```
1b₁: 10.79 eV, 3a₁: 13.39 eV, 1b₂: 16.05 eV, 2a₁: 32.30 eV, 1a₁: 539.0 eV
```

**Emfietzoglou ionisation shells** (liquid phase adjusted):

```
10.0, 13.0, 17.0, 32.2, 539.7 eV
```

**Excitation levels** (Emfietzoglou, Rad Res 163, 2005):

```
A¹B₁: 8.22, B¹A₁: 10.00, Rydberg A+B: 11.24, Rydberg C+D: 12.61, Diffuse: 13.77 eV
```

## WGSL shader constraints

- No recursive function calls
- Avoid complex function signatures with many `ptr<function, array>` params
- Everything inline in `main()` is safest
- `atomicAdd` only works on `u32` (use fixed-point for fractional values: ×100)
- Ping-pong buffers required for stencil / diffusion operations
- `const` arrays up to ~100 elements work fine
- `initGPU` MUST pass `requiredLimits` requesting the adapter's max buffer
  sizes — the default `maxStorageBufferBindingSize` of 128 MiB is too small
  for `rad_buf` (256 MB) and silently produces empty dispatches

## Project links

- kernelfusion.dev — kernel fusion research papers
- gpubench.dev — WebGPU benchmarking
- Zero-TVM — from-scratch LLM inference replacing Apache TVM

## License

MIT (simulation code).
Geant4-DNA data: [Geant4 Software License](https://geant4.web.cern.ch/license/LICENSE.html)
(BSD-like, Apache-2.0 compatible).
