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

### Current validation status

**All quantitative claims about this project live in [`README.md` § Numbers](./README.md#numbers).**
That section is the single source of truth — every artifact link, every ratio, every
σ-significance figure. Do not introduce new numbers anywhere else (this file, slide
decks, blog posts, index.html headlines) without first landing them in §Numbers.

When measuring a new ratio: write the protocol → run the experiment → commit the
JSON artifact under `experiments/results/<UTC-date>/<level>/<id>.json` → add a row
to §Numbers → only then mention it elsewhere.

Notable current findings (full descriptions in §Numbers):

- **L0/L1**: 2 of 2 env + 9 of 9 cross-section bit-matches pass.
- **L2**: CSDA 0.988× @ 10 keV (3.59σ) [E5]; E5b shows the deficit is energy-dependent (0.587× @ 100 eV → 0.992× @ 20 keV); cascade ions 27% low [E7]; secondary KE spectrum 7/8 bins within 0.1-3.1% [E8].
- **L3**: G(species) @ 0.1 ps pre-chem vs chem6 — OH/eaq/H all ~12% low, H₂/H₂O₂ ~50% low [E9].
- **L4**: G-values vs chem6 @ 10 keV — OH 0.91×, eaq 0.83×, H 1.00×, H₂ 0.75×, H₂O₂ 0.71× [E10c]. G(eaq) V-shape 1→3 keV @ 126σ [E10b]. E10e refuted cross-event recomb (3.5% contribution); E10f confirmed per-primary partitioning is 96% of the 1 μs gap; E10i joint fix (σ_exc=0.5, B=2.0) lifts RMS dev 30% → 19% and CSDA @ 100 eV to 0.74×.
- **L5**: indirect SSB ratio closed 0 → 2.96 (PARTRAC 2-3 band) via 4-stage fix [E13c].
- **L6**: 455× vs Geant4 ST [E15b], 280× vs Geant4 MT-8 [E15c], 40× kernel-fusion factor [E16].
- **46/46 unit tests** pass (`npm run test`, ~200 ms).

See README.md § Numbers for the falsifiable artifact behind each row.
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
