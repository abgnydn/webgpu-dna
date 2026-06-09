# WebGPU DNA Track Structure Simulation

## Next session — start here

**Status as of 2026-06-09 — `v0.6.0`, full electron cascade.** The cascade-ion deficit is **resolved**: the secondary shader now tracks the tertiary (gen3+) electron cascade (`secondary.wgsl` emits tertiaries into `sec_buf`; `dispatch.ts` grows the Phase B wavefront in chunks). Clean win on every axis — cascade ions **0.766→0.931×**, chemistry RMS vs chem6 **19.7→7.6%** (H₂ 0.74→0.99×, H₂O₂ 0.69→0.93× — the long-standing chem6 gap closed), SSB **2.53** in-band, primary track **bit-exact** (195.4 vs Geant4 195.6 by trackID), energy conserved, validated across all 8 energies + browser. Mechanism arc: E20 (primary bit-exact; deficit is the secondary cascade) → E21 (80% is untracked tertiaries) → E22 (implemented) → E25 (clean win — after E22–E24 chased a phantom "over-recombination" that was a `n_therm` normalization bug in my own analysis; corrected via verify-before-asserting). `RECOMB_BOOST` stays 1.0; only `SIGMA_EXC_SCALE=0.5` remains (documented divergence). **v0.5.0 carryover**: free-compute infra (`FREE_COMPUTE.md`), webgpu-dna-native runtime (`native/`). **Next**: cut v0.6.0 release + Zenodo; regenerate/re-upload the 8 production dumps with the cascade; open items are the residual 7% cascade gap and the slight G(H) overshoot (1.085×).

<details><summary>Earlier session notes (pre-v0.5.0, kept for provenance)</summary>

### The structural pivot to read first

1. **`H2OP_TRACKING_DESIGN.md`** — the H₂O⁺-tracking hypothesis was REFUTED via Geant4 source archaeology of `G4DNAElectronHoleRecombination.cc:140-310`. Geant4's recomb is one-shot single-sample (not time-integrated), so `RECOMB_BOOST = 2.0` has no physical basis — it's a fudge that empirically improves chem6 agreement but doesn't model any underlying physics.
2. **`CROSS_PRIMARY_IRT_DESIGN.md`** — the actual structural fix. E10f measured per-primary IRT partitioning as the cause of **96 %** of the 1 μs chem6 implementation gap. BUT: naïve cross-primary IRT in a browser needs ~1 GB of heap memory (exceeds tab ceiling). Design doc sequences this **behind** the headless native runtime build (Tier 3 in ROADMAP), since `webgpu-dna-native` removes the browser memory ceiling and makes cross-primary IRT a 30-minute drop-in.

### Recommended next moves (in order)

1. **Verify TCC access** — `ls ~/Downloads/webgpu-dna/.git`; if "Operation not permitted", grant Ghostty Downloads access via System Settings → Privacy & Security → Files and Folders before doing anything else. If access is fine, skip.
2. **Polish queue** (4 mechanical commits, ~10 min total once filesystem access works):
   - Update `CHANGELOG.md` `[Unreleased]` section with the 40 post-v0.3.0 commits (E5d, E5e, E6c, E7b, E7c, E10i, E10j, E13c re-runs + retrofit + 3 design docs + ROADMAP)
   - Bump `package.json` to `0.4.0` and cut a `v0.4.0` git tag + GitHub Release titled "v0.4.0 — audit closure + structural pivots". The release notes write themselves from the CHANGELOG entries.
   - Update `validation/webgpu-results.json` `dnaDamage` block: `SSB_dir=23 SSB_ind=68 DSB=1 ratio=2.96` → `SSB_dir=26 SSB_ind=64 DSB=9 ratio=2.46` (post-joint-fix values from E13c re-run on 2026-05-13). Keep `$ssb_history` with both.
   - Push the OG image if any §Numbers headline changed (currently still accurate: `0.988 / 0.73 / 100.0% / 46/46`).
3. **Tier 3 — `webgpu-dna-native` runtime** (~2-3 hr multi-agent wall per ROADMAP). Node + `wgpu-native` wrapping the existing WGSL + `irt-worker.js`. This is the prerequisite that unblocks cross-primary IRT. Choose between:
   - `@sylphx/webgpu-darwin-arm64` 1.0.4 (npm registry, found 2026-05-13 search)
   - `bun-webgpu` 0.1.7 (alternative)
   - Or vendor `wgpu-native` C bindings directly via Node N-API
4. **Tier 1 cross-primary IRT** (~30 min drop-in once native runtime exists). Drop `priMap` partitioning in `public/irt-worker.js`, run global pool. Validation: re-run E10c-equivalent + E5d / E7b / E13c (the last three should not change — they're primary-phase metrics).
5. **`RECOMB_BOOST` removal** (after cross-primary IRT validates). The fudge factor drops to 1.0; chemistry side becomes physics-grounded.

### Sequencing rationale

This ordering produces a clean research-grade arc: joint fix v0.3.0 (empirical) → audit closure (every claim traceable to artifact + shader hash) → H₂O⁺ refutation (source archaeology) → cross-primary IRT (real fix, validates E10f's measurement) → fudge factor removed. The "we found the structural cause and validated it twice" narrative is the v1.0 publishable story.

### Anti-pattern reminders

- **No fudge factors without a Geant4 source citation.** The H₂O⁺ refutation establishes the precedent: any new tunable scalar in `helpers.wgsl` must have a single-line provenance back to G4 source, or it gets flagged for removal by the next audit.
- **No artifacts without `shaderHashes` in `env`.** The 2026-05-13 retrofit covered all pre-fix artifacts; future artifacts get them organically via `captureEnv()`.
- **Failed experiments are committed with `status: "fail"` and not re-run until they pass.** The two-knob structural limit (E7c) and the cutoff-shifter (E5e) are both honest negatives — those refutations are publishable findings, not engineering bugs to fix.

### Memory of host-side gotchas

If `ls ~/Downloads/` returns `Operation not permitted` in the next session: it's the recurring Ghostty TCC drop documented in `~/.claude/.../memory/macos_tcc_ghostty.md` and `~/.claude/.../memory/macos_tcc_ghostty_downloads.md`. Recovery: System Settings → Privacy & Security → Files and Folders → Ghostty, toggle Downloads off+on, then quit and reopen Ghostty. Or `tccutil reset SystemPolicyDownloadsFolder com.mitchellh.ghostty` from a non-Ghostty terminal.

</details>

---


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

Where the WGSL physics **deliberately differs** from Geant4-DNA `DNA_Opt2`
(Emfietzoglou excitation, the σ_exc/recomb tuning knobs, per-primary IRT, fp32
atomics, fiber-grid geometry) is catalogued — with the why and the measured
cost of each — in [`GEANT4_DIVERGENCES.md`](./GEANT4_DIVERGENCES.md).

When measuring a new ratio: write the protocol → run the experiment → commit the
JSON artifact under `experiments/results/<UTC-date>/<level>/<id>.json` → add a row
to §Numbers → only then mention it elsewhere.

Notable current findings (full descriptions in §Numbers):

- **L0/L1**: 2 of 2 env + 9 of 9 cross-section checks pass — these are **ratio-matches** (peak 0.975–1.000: σ_ion 0.9987, σ_exc 0.9970, σ_el **0.9751** is the worst), NOT bit-matches. Only Sanche σ_vib (E4) is genuinely bit-exact (max dev 6e-16). Do not call the cross sections "bit-matched".
- **L2**: CSDA 0.988× @ 10 keV (3.59σ) [E5]; E5b shows the deficit is energy-dependent (0.587× @ 100 eV → 0.992× @ 20 keV); cascade ions **0.931× in production (v0.6.0, 7% deficit, was 23%)** — the full tertiary electron cascade is now tracked (E20 primary bit-exact 195.4 vs 195.6; E21 deficit was 80% untracked tertiaries; E25 clean win); secondary KE spectrum 7/8 bins within 0.1-3.1% [E8].
- **L3**: G(species) @ 0.1 ps pre-chem vs chem6 — OH/eaq/H all ~12% low, H₂/H₂O₂ ~50% low [E9].
- **L4**: G-values vs chem6 @ 10 keV — **production (v0.6.0, full cascade)** (E25: G(OH) 0.940×, eaq 0.887×, H 1.085×, H₂ 0.993×, H₂O₂ 0.927×, **RMS 7.6%** — down from 19.7% pre-cascade; the long-standing H₂/H₂O₂ deficits are closed by tracking the tertiary cascade, not by inter-track partitioning as E10f had attributed). `RECOMB_BOOST=1.0` (still parameter-free). G(eaq) V-shape 1→3 keV @ 126σ [E10b]. **The E22–E24 "over-recombination" was a `n_therm` normalization bug in my own analysis, corrected in E25** — verify-before-asserting catching a multi-turn error.
- **L5**: two separable claims. **Absolute yields — vindicated** (E12-local, 2026-06-03): the 223×/796× box-normalised over-yield is a **point-source dose artifact** (98.1% of energy in the central 3 µm core, C≈981, local dose ≈238 Gy); per local dose, SSB_dir 0.34× / DSB 0.82× / SSB_total 1.28× experiment (Ward 1988) — within ~3×. **DSB/SSB ratio — calibrated fit** (2.32 parameter-free, was 2.46 @ 2.0; `P_indirect` tuned to PARTRAC's band; held in-band across the RECOMB→1.0 flip with no recalibration [E13d]). Exact voxel dose confirms C=991 vs the C≈981 proxy [E12-local-exact]. Open follow-up: E12-bulk (spread tracks, `start_half`=box). [E12-local-exact, E13d]
- **L6**: 455× vs Geant4 ST [E15b], 280× vs MT-8 [E15c]. **E15-fair (measured)**: init + DNA table-build is only ~2.1 s (16-primary probe = 3.2 s wall) = 0.7% of 289 s → event-loop-only speedup is **452×**, ≈ 455×. (Retracts an earlier wrong "~160 s serial / ~200×" Amdahl guess — init is negligible.) One real residual asymmetry: G4 writes 6.8 GB per-event ntuple I/O (measured: 1.65 MB/primary, near-linear; likely the cause of the 1.62× MT-8 scaling via row-wise merge); WGSL dispatch excludes its ~87 MB dump. 256-primary run = 19.7 s confirms the 2 s-init + 0.070 s/pri model. **Kernel fusion contributes ~2× to the pipeline, not 40×** — the 40× [E16] is Phase-A-only and Phase A is 2% of the 635 ms. Honest like-for-like number remains **1.48× end-to-end**.
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
