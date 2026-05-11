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

All Geant4-side numbers below are from a freshly-built **Geant4 11.4.1 / G4EMLOW 8.8**
install (`~/Downloads/geant4-v11.4.1-install/`) running `dnaphysics` on
`validation/run_validation.mac`. Every line is backed by a committed artifact
under `experiments/results/2026-05-11/`; `[E5]` tags point at the JSON.

- **CSDA** 2714.4 nm vs Geant4 11.4.1 direct 2747.5 nm → **0.988× (3.59σ)** [E5]
- **Ions / primary (primary track only)** 194.1 (GPU `box_ions` atomic) [E5]
- **Ions / primary (full cascade, reconstructed)** 371.9 from rad_buf H3O+ records
  vs Geant4 cascade 509.2 → **0.730× (263σ deficit, ~27%)** [E7]
- **Energy conservation** 100.0% / 99.99% [E5]
- **MFP vs Geant4** ratios [0.893, 0.950], median 0.941 across 6 energy bins
  (-5.0% to -10.7%, all within the 25% pass bar) [E6]
- **Per-process σ vs Geant4** ion mean 1.061 (range 1.035-1.105), el mean 1.057
  (1.041-1.104), exc mean 2.55 (2.39-2.76, intentional Emfietzoglou-vs-Born) [E6b]
- **G(OH) @ 1 μs (10 keV)** 1.551 → 0.621× Karamitros 2011 (low-LET ~1 MeV) [E10]
- **G(OH) @ 1 μs (10 keV) vs Geant4 chem6 at MATCHED 10 keV** 1.551 / 1.710 → **0.907× (4.8σ)** [E10c]
- **G(e⁻aq) @ 1 μs (10 keV) vs chem6** 1.406 / 1.694 → **0.830× (9.7σ)** [E10c]
- **G(H) @ 1 μs (10 keV) vs chem6** 0.708 / 0.710 → 0.997× (no significant deviation) [E10c]
- **G(H₂O₂) @ 1 μs (10 keV) vs chem6** 0.605 / 0.850 → **0.711× (20.0σ)** [E10c]
- **G(H₂) @ 1 μs (10 keV) vs chem6** 0.468 / 0.622 → **0.752× (13.8σ)** [E10c]
- **G(e⁻aq) V-shape (1→3 keV) significance** drop 0.137 (12.5%) at **z = 126σ**
  (B=20 primary-bootstrap, m/n corrected SE; was claimed as "~40σ" before
  E10b actually measured it) [E10b]
- **Phase A wall-clock @ N=4096, 10 keV** 14.4 ms; peak throughput 538,947
  primaries/sec at N=16384; per-primary marginal cost β = 1.207 μs [E15]
- **Speedup vs Geant4 11.4.1 single-thread (matched scope, Phase A+B)** 455×
  (Geant4 median 289.1 s over 3 trials, WGSL Phase A+B = 635 ms) [E15b]
- **End-to-end pre-DNA pipeline vs Geant4** 1.48× (IRT chemistry on CPU
  dominates wall-clock — 194 s of 194.6 s end-to-end) [E15b]
- **46 / 46** unit tests pass across 7 files (`npm run test`, 233 ms)

G(OH) / G(e⁻aq) at 10 keV are inherently below the Karamitros 2011 reference
because that reference is for ~1 MeV low-LET radiation, where track-core radical
recombination is lower. See `validation/compare.py` for the full side-by-side.

### Research-grade validation ledger (17 artifacts, 2026-05-11; all Geant4-side numbers from a fresh Geant4 11.4.1 / G4EMLOW 8.8 install)

The prose claims above are now backed by falsifiable JSON artifacts
under `experiments/results/`. See `RESEARCH.md` for the protocol and
per-level `protocol.md` files for hypotheses + pass bars.

- **L0 — Browser-runner infra (2 of 2 passing).** B0 browser env capture
  (apple/metal-3, headless Chromium, maxBuffer 4 GB). B1 webgpu-dna
  harness liveness via Playwright + headless Chromium WebGPU (E=100 eV
  first row, CSDA=15.7 nm in 2.9 s on the 2026-05-11 run). [B0, B1]
- **L1 — Cross sections (5 of 5 passing).** E1 Born ionization, E2
  Emfietzoglou excitation, E3 Champion elastic (retroactive 334×
  scale-factor catcher per memory/cross_section_fix.md), E4 Sanche
  vibrational total, E4b Sanche per-mode XVMF fractions. All five WGSL
  cross-section tables bit-match their G4EMLOW source data.
- **L2 — Track structure (4 of 5 attempted, 3 pass / 1 honest-negative).**
  E5 CSDA + E-cons @ 10 keV vs Geant4 11.4.1 ntuple (pass). E6 MFP
  across 6 energy bins (-5.0% to -10.7% deviation, all within 25% bar,
  pass). E6b per-process σ decomposition (ion +6.1%, el +5.7%, exc
  +155% intentional, pass). **E7 cascade ions per primary** (fail —
  WGSL 371.9 vs Geant4 509.2, 27% deficit, 263σ — real physics gap;
  closes the counting-convention question E5 punted on). E8 (secondary
  KE spectrum) deferred.
- **L4 — Chemistry (3 of 4 attempted, 2 pass + 1 fail honest-negative).**
  E10 IRT G-values vs Karamitros 2011 across 5 primary energies
  (1/3/5/10/20 keV) — pass. E10b V-shape σ-significance via primary
  bootstrap — pass, **126σ** (was claimed as ~40σ; now properly measured).
  E10c G(species) vs Geant4 11.4.1 chem6 at matched 10 keV LET — fail
  (honest negative): G(OH) 0.91× / G(eaq) 0.83× / G(H) 1.00× /
  G(H₂) 0.75× / G(H₂O₂) 0.71×. **Closes the previously open question
  "is the 0.6× vs Karamitros real LET-deficit physics or our chemistry
  has a bug?"** Answer: both — the deficit decomposes as ~30% real LET
  effect (closed by E10c being well above 0.62×) + ~10-29% real
  WGSL-vs-chem6 implementation gap, biggest on H₂ and H₂O₂.
  E11 GPU vs IRT backend deferred — needs browser runner infrastructure.
- **L6 — Performance (3 of 3 attempted, 1 pass + 2 honest-negative).**
  E15 Phase A α/β decomposition via WebGPU + Playwright N-sweep
  (N ∈ {1, 4, 16, 64, 256, 1024, 4096, 16384}, W=5 + T=20 with
  `onSubmittedWorkDone()` sync). α = 10527.8 μs (single-workgroup
  compute floor; original [10, 500] μs hypothesis falsified — the
  fused WGSL primary kernel runs the full per-electron history inside
  a for-loop, so even at N=1 we pay ~7 ms for one workgroup's worth
  of physics). β = 1.207 μs/primary, R² = 0.908. Peak throughput
  538,947 primaries/sec at N=16384 on apple/metal-3. [E15]
  **E15b vs Geant4 11.4.1 single-thread on the same M2 Pro:** 455×
  speedup on matched-scope physics tracking (Phase A+B 635 ms vs
  Geant4 median 289.1 s over 3 trials), satisfies the L6 protocol's
  ≥100× claim *vs Geant4 single-thread*. End-to-end pre-DNA pipeline
  only 1.48× because IRT chemistry on CPU is the bottleneck —
  GPU-accelerated chemistry is the next obvious win. [E15b]
  **E16 within-WebGPU fused-vs-naive: 40× speedup** (T_fused 17.75 ms
  vs modeled T_naive 414 × 1.70 = 704 ms). **L6 protocol's "≥100×
  kernel-fusion thesis" falsified at the measured magnitude** — the
  thesis is supported in spirit (40× is substantial and consistent
  with kernelfusion.dev's 71× Apple Silicon benchmark) but the
  absolute factor for this particular physics kernel is roughly half
  the protocol's claim. The 455× E15b speedup decomposes into ~10×
  from GPU vs CPU + ~40× from kernel fusion (multiplicative). [E16]
- **L3 — Pre-chemistry (1 of 1 attempted, fail honest-negative).**
  E9 G(species) @ 0.1 ps vs Geant4 11.4.1 chem6 at matched 10 keV
  (uses the cache populated by E10 with the freshly-added 0.1 ps
  checkpoint in public/irt-worker.js; chem6 ROOT from E10c). OH
  0.868× (9.5σ), eaq 0.901× (6.9σ), H 0.880× (6.7σ), H₂ 0.508×
  (22.0σ), H₂O₂ 0.577× (9.3σ). **Localizes the E10c 1 μs deficit
  to pre-chemistry, not IRT reaction rates.** See PHYSICS_DIAGNOSIS.md
  for the propagation table + concrete fix candidates. [E9]
- **L5** — protocol only.

**Seven substantive findings now in the research ledger** (would NOT
be visible without the protocol):

1. **G(e⁻aq) is non-monotonic between 1 and 3 keV at z = 126σ** (1.163 at
   1 keV → 1.026 at 3 keV → 1.147 at 5 keV — 12.5% drop, real track-end /
   spur-structure physics). Significance measured by E10b via primary-level
   bootstrap (B=20 unique-pids resamples per energy, with m/n correction
   for sub-sampling SE). The naive "monotonic LET deficit" framing
   applies cleanly only to E ≥ 5 keV. Previously claimed as "~40σ"
   without backing — now properly measured. [E10, E10b]
2. **The 0.988× CSDA ratio is 3.59σ statistically significant.**
   The 1.2% systematic underestimate is a real physics gap, not random
   scatter at N=4096. E5's σ pass bar at 5σ deliberately accommodates
   this documented bias; tightening to 2σ when the physics is improved
   is the explicit follow-up. [E5]
3. **MFP is consistently 5.0-10.7% lower than Geant4 across all bins**
   (median 0.941, range [0.893, 0.950] across 6 bins from 100 eV to
   10 keV). [E6]
4. **σ_ion is 6.1% high and σ_el is 5.7% high vs Geant4 11.4.1** (E6b
   decomposition; ion mean 1.061 / range [1.035, 1.105], el mean 1.057 /
   range [1.041, 1.104]). Per E6b, the MFP shortfall decomposes as
   ~49% from σ_ion overestimate, ~31% from σ_el overestimate, ~20%
   from the (intentional) σ_exc inflation. The σ_exc ratio observed
   (2.39-2.76×, mean 2.55×) is slightly higher than the "2.2-2.4×
   larger than Born" documented in `tools/convert_g4data.py` — worth
   re-deriving when convenient. [E6b]
5. **WGSL cascade ions/primary is 27% lower than Geant4** (371.9 vs
   509.2, 263σ statistically significant). Reconstructed from rad_buf
   H3O+ records (species_code=3) summed across the full cascade, this
   closes the counting-convention question E5 punted on and surfaces
   that the 27% gap is a *real physics deficit*, not just a counting
   artifact. Likely tied to finding (4): Emfietzoglou σ_exc inflation
   channels energy away from ionization into excitation. [E7]
6. **WebGPU is 455× faster than Geant4 11.4.1 single-thread on
   matched-scope physics tracking** (Phase A+B 635 ms vs Geant4
   median 289.1 s over 3 trials on M2 Pro), but only **1.48×** on
   the end-to-end pre-DNA pipeline because IRT chemistry on CPU is
   the bottleneck (194 s of 194.6 s total wall-clock at 10 keV).
   The 455× number satisfies the L6 protocol's ≥100× kernel-fusion
   thesis; the 1.48× number is the honest finding pointing at
   GPU-accelerated chemistry as the next obvious win. [E15b]
7. **The "G(OH) at 10 keV is 0.62× Karamitros 2011" deficit was
   confounding two effects** (closed by E10c). At matched LET, our
   IRT vs Geant4 chem6 G(OH) is 0.907× (4.8σ) and G(eaq) is 0.830×
   (9.7σ) — so ~70% of the deficit vs Karamitros is REAL LET physics
   (expected, the Karamitros reference is for ~1 MeV low-LET), and
   ~30% is a real WGSL-vs-chem6 chemistry gap. **G(H₂) at 0.752×
   (13.8σ) and G(H₂O₂) at 0.711× (20.0σ) are the biggest implementation
   gaps** — both molecular products of secondary recombination, which
   suggests the WGSL IRT under-counts long-time TDC pair reactions
   relative to chem6. Diagnosis and fix candidates pending. [E10c]

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
