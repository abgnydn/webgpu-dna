# WebGPU Geant4-DNA Architecture

## Core design decision

Geant4 tracks one particle at a time, sequentially. We invert this:

- **Phase A (primaries):** 1 dispatch, 1 GPU thread per primary. Each thread runs the full particle history in a loop — no per-step dispatch overhead. This is "kernel fusion": the entire track-structure simulation is a single `@compute` entry point.
- **Phase B (secondaries):** wavefront stepping. 1 dispatch per physics step, all secondaries advance in parallel. Can't fuse because secondary count isn't known until Phase A completes.
- **Phase C (chemistry):** Karamitros 2011 IRT chemistry. Default path is a dedicated Web Worker (`public/irt-worker.js`) running on CPU off the main thread — matches published G-values. A GPU grid-hash backend (`src/shaders/chemistry.wgsl`, 133 timesteps × 4 dispatches) is kept as a faster but less accurate alternative for CSDA-only runs; see `src/chemistry/backend.ts`.

## Module layout

```
src/
├── shaders/       WGSL compute shaders (helpers, primary, secondary, chemistry)
│   ├── helpers.wgsl       RNG, xs_all, CDF samplers, DNA-proximity helpers
│   ├── primary.wgsl       Fused Phase A tracking kernel
│   ├── secondary.wgsl     Wavefront Phase B stepper
│   ├── chemistry.wgsl     GPU-resident Phase C (alt backend)
│   └── loader.ts          Prepends cross_sections.wgsl to each kernel
│
├── physics/       Constants, types, DNA geometry, ESTAR reference
├── gpu/           Device init, buffers, pipelines, Phase A/B/C dispatch
├── chemistry/     IRT worker wiring, reaction tables, schedule, measure
├── scoring/       SSB/DSB scoring, dose projections
├── ui/            Results table + canvas dose projections
├── app.ts         runValidation orchestrator (8-energy ESTAR sweep)
└── main.ts        Entry point
```

## Pipeline overview

```
  JS Orchestrator (src/app.ts)
  runValidation() → makePipes() → runAtEnergy() × 8 energies
       │
       │  fetch('/cross_sections.wgsl')
       │  ↓ prepended to SHADER + SEC_SHADER at compile time
       │
       ▼
  ┌──────────┐  counters[6]  ┌──────────────┐  counters[7]  ┌──────────────────┐
  │ PHASE A  │──(sec_n)────▶│   PHASE B    │──(rad_n)────▶│   PHASE C        │
  │ Primary  │               │  Secondary   │               │  IRT worker      │
  │ Tracking │               │  Wavefront   │               │  (default) or    │
  │ (fused)  │               │  Stepper     │               │  GPU grid-hash   │
  └──────────┘               └──────────────┘               └──────┬───────────┘
   1 dispatch                 2000 dispatches                       │
   N threads                  ~1–5M threads each                    │
                                                                    ▼
                                                          ┌────────────────┐
                                                          │ JS Post-Process│
                                                          │ - SSB/DSB      │
                                                          │ - Dose project │
                                                          │ - ESTAR compare│
                                                          │ - G(t) timeline│
                                                          └────────────────┘

  Shared buffers across A+B:
    dose[]      ← atomicAdd from both phases (128³ voxel grid, fixed-point ×100)
    rad_buf[]   ← append from both phases (OH/eaq/H/H3O+ positions + species tag)
    counters[]  ← atomic species counts + append indices (sec_n, rad_n)
```

## Phase A: primary electron tracking (fused kernel)

One GPU thread traces one primary electron through its entire history.
No inter-step synchronization, no per-step dispatch — pure loop.

```
  GPU Thread (1 of N primaries)
  ──────────────────────────────
  for step = 0 to 65536:
    if E < cutoff or escaped: break

    ┌─ Cross sections ────────────────────────────────┐
    │  xs = xs_all(E)        → (σ_ion, σ_exc, σ_el)  │
    │  s_vib = xs_vib_total(E) → σ_vib                │
    │  σ_total = σ_ion + σ_exc + σ_el + σ_vib         │
    │  λ = 1 / (NW × σ_total)                         │
    │  dist = -ln(U) × λ                              │
    └─────────────────────────────────────────────────┘
          │
          ▼
    ┌─ Direction (every step) ────────────────────────┐
    │  Champion elastic angular CDF → cos_θ           │
    │  Rotate direction by (cos_θ, φ)                 │
    │  Move: pos += dir × dist                        │
    │  Deposit dose (atomicAdd to voxel grid)         │
    └─────────────────────────────────────────────────┘
          │
          ▼
    ┌─ Process selection (r × σ_total) ──────────────┐
    │                                                 │
    │  r < σ_ion?                                     │
    │    YES → Ionization                             │
    │      1. Shell selection (Born per-shell σ)      │
    │      2. W_transfer from paired CDF (bsearch)    │
    │      3. sec_KE = W_transfer - binding           │
    │      4. E -= W_transfer (NOT bind + W_sec)      │
    │      5. G4DNABornAngle: secondary direction      │
    │         <50eV: isotropic                        │
    │         50–200: 10% iso + 90% forward           │
    │         >200: kinematic sin²θ                   │
    │      6. Primary momentum conservation            │
    │         p_final = p_inc - p_sec                  │
    │      7. Emit secondary → sec_buf[]              │
    │      8. Radicals → rad_buf[]: OH + eaq + H3O+   │
    │                                                 │
    │  r < σ_ion + σ_exc?                             │
    │    YES → Excitation                             │
    │      Level from Born per-level fractions (v0.7.0, E29) │
    │      G4ChemDissociationChannels:                │
    │        Lev 0 (A¹B₁): 65% OH+H                   │
    │        Lev 1 (B¹A₁): 55% autoion, 15% 2OH+H₂   │
    │        Lev 2–4:      50–80% autoionization       │
    │      Autoion → OH + eaq + H3O+ (like ionization)│
    │                                                 │
    │  r < σ_ion + σ_exc + σ_vib?                     │
    │    YES → Vibrational (Sanche, 9 modes, 2× liq)  │
    │                                                 │
    │  else → Elastic (no energy loss, already rotated)│
    └─────────────────────────────────────────────────┘
```

## Phase B: secondary electron wavefront stepper

Can't fuse: secondary count (sec_n) unknown until Phase A finishes.
Instead: 2000 dispatches, each advancing all alive secondaries by 1 step.

```
  for dispatch = 0 to 2000:
    GPU Thread (1 of sec_n, ~900k at 10 keV)
    ──────────────────────────────────────────
    if dead: return early
    Same physics as Phase A except:
      - Above-cutoff tertiaries (gen3+) are TRACKED: emitted into sec_buf
        as new particles (v0.6.0, E21/E25) — the wavefront grows in chunks
        until stable, then thermalises
      - Sub-cutoff tertiaries absorbed in place: deposit(bind + W_sec)
        (full transfer deposited locally)
    Writes to same shared dose[], rad_buf[], counters[]
```

## Phase C: radiolysis chemistry

### Default backend — IRT Web Worker (`public/irt-worker.js`)

Karamitros 2011 Independent Reaction Times. Runs on a dedicated worker thread so
the main thread stays responsive during the full 8-energy sweep. For each pair of
radicals, analytically computes the first-passage reaction time from positions,
diffusion coefficients and reaction radius, then processes reactions in time
order (retaining products, re-pairing them into the pool).

```
  rad_buf (readback) ─▶ worker
                          │
                          ▼
  ┌─ Pre-chemistry (once) ───────────────────────────┐
  │  Mother displacement: 2.0 nm RMS per ionization   │
  │    site (OH + H3O+ move together from their       │
  │    shared origin before independent walks)        │
  │  Species-specific product displacement:           │
  │    OH:  σ = 0.46 nm   (from RMS 0.8 / √3)         │
  │    eaq: σ = 3.46 nm   (Meesungnoen 2002 @ 1.7 eV) │
  │    H:   σ = 1.30 nm   (A¹B₁ kinematics)           │
  │    H3O+: 50% σ=0.46 nm, 50% co-located with OH    │
  └───────────────────────────────────────────────────┘
       │
       ▼
  ┌─ IRT scheduling loop ─────────────────────────────┐
  │  For every unordered radical pair (a,b):          │
  │    lookup reaction (a,b) in RXN_TABLE             │
  │    if found → sample first-passage t from         │
  │      Smoluchowski (TDC) or Onsager-screened       │
  │      (PDC for charged pairs) distribution         │
  │    enqueue reaction event at time t               │
  │                                                   │
  │  Process events in time order:                    │
  │    emit products, decrement species counts,       │
  │    re-pair products against remaining pool        │
  │                                                   │
  │  At each checkpoint (7 log-spaced, 0.1 ps → 1 μs):│
  │    snapshot alive[] + products → G(t)             │
  └───────────────────────────────────────────────────┘

  9-reaction base table (Karamitros 2011, G4EmDNAChemistry_option1) — the
  worker now carries 47 rows total (base 9 + 38-reaction oxygen network from
  G4EmDNAChemistry_option3):
  ┌───┬──────────────────┬──────────┬──────┬──────────────────┐
  │ # │ reaction         │ k (M⁻¹s⁻¹)│ type │ products         │
  ├───┼──────────────────┼──────────┼──────┼──────────────────┤
  │ 0 │ OH + OH          │ 0.55e10  │ PDC  │ H₂O₂             │
  │ 1 │ eaq + OH         │ 2.95e10  │ PDC  │ OH⁻              │
  │ 2 │ OH + H           │ 1.55e10  │ PDC  │ H₂O              │
  │ 3 │ eaq + eaq        │ 0.636e10 │ TDC  │ 2 OH⁻ + H₂       │
  │ 4 │ eaq + H          │ 2.50e10  │ TDC  │ OH⁻ (+ H₂)       │
  │ 5 │ eaq + H3O+       │ 2.11e10  │ PDC  │ H                │
  │ 6 │ H + H            │ 0.503e10 │ TDC  │ H₂               │
  │ 7 │ eaq + H₂O₂       │ 1.10e10  │ PDC  │ OH⁻ + OH         │
  │ 8 │ H3O+ + OH⁻       │ 1.13e11  │ TDC  │ H₂O              │
  └───┴──────────────────┴──────────┴──────┴──────────────────┘
  TDC = totally diffusion-controlled (contact reaction at σ).
  PDC = partially diffusion-controlled (effective radius; charged pairs
        use Onsager-screened Coulomb radius rc = 0.711·q₁q₂ nm @ 293 K).
```

### Alt backend — GPU grid hash (`src/shaders/chemistry.wgsl`)

Spatial hash + Brownian diffusion on GPU. 7-reaction subset (H₂O₂ and OH⁻
not tracked as products). Much faster but undercounts long-time encounters
because hash cell size (1.5 nm × 3-neighbor) is smaller than σ_diff at
the 30 ns timestep. Kept for CSDA-only runs where chemistry can be skipped
for throughput. Not the validation path.

## JS post-processing (CPU)

```
  After GPU phases complete:
    1. Readback dose grid → sum for E_cons, render XY/YZ projections (10 keV only)
    2. Readback results[] → per-primary CSDA, ions, stopping power
    3. Readback rad_buf[] → direct SSB scoring (ionization site clustering)
    4. IRT worker output → indirect SSB (diffused OH near DNA at 1 μs)
    5. Cluster SSB → DSB (greedy ±10 bp)
    6. Compare CSDA vs ESTAR reference at 8 energies
    7. Report G(t) timeline vs Karamitros 2011
```

## Buffer map & data flow

```
                     ┌──────────────────────┐
                     │  GPU MEMORY ~850 MB  │
                     └──────────────────────┘

  Phase A/B shared               Phase C (GPU alt path)
  ────────────────               ──────────────────────
  rad_buf    256 MB ─────────▶  chem_pos    128 MB
  sec_buf    240 MB              chem_rng    128 MB
  dose         2 MB              chem_alive   32 MB
  counters    32  B              cell_head    32 MB
  results    128 KB              next_idx     32 MB
  rng         64 KB              chem_stats  128  B
  params      64  B              chem_uni     16  B

  Data flow:
    Phase A writes → sec_buf     (secondaries for Phase B)
    Phase A writes → rad_buf     (radical positions)
    Phase A writes → counters[6] (sec_n for Phase B dispatch count)
    Phase A writes → counters[7] (rad_n for Phase C input count)
    Phase B reads  → sec_buf     (one step per dispatch)
    Phase B writes → rad_buf, dose, counters (shared with A)
    rad_buf readback → IRT worker (default) or GPU grid-hash (alt)

  Cross sections (WGSL const arrays, compiled into shader):
    fetch('/cross_sections.wgsl') → prepended to SHADER + SEC_SHADER
    Total XS:   XI/XC/XL × 100 pts (Born ion/exc, Champion elastic)
    Ion CDF:    XWC/XWT × 5 shells × 58 energies × 100 breakpoints
    Elastic:    XAE/XAC 25×25 (Champion angular CDF)
    Vibrational: XVE/XVS/XVMF (Sanche 38 pts × 9 modes)
    Shell/Exc:  XSF/XEF × 5 × 100 pts (per-shell/level fractions)

  Buffer sizing is in src/gpu/buffers.ts. initGPU() requests the adapter's
  maxBufferSize / maxStorageBufferBindingSize explicitly — the WebGPU
  default cap of 128 MiB is too small for rad_buf (256 MB) and silently
  produces empty dispatches.
```

## Geant4 → WGSL / TS model mapping

| Geant4 C++ | Data file | WGSL / TS | Key difference |
|-------------|-----------|-----------|----------------|
| G4DNABornIonisationModel1 | sigma_ionisation_e_born | `xs_all().x` + `sample_W_sec()` | Paired CDF binary search vs Geant4's std::map |
| G4DNABornAngle | (analytical) | Inline in ionization block | 3 regimes: <50 eV iso, 50–200 mixed, >200 kinematic |
| G4DNABornExcitationModel | sigma_excitation_e_born | `xs_all().y` + `xs_exc_fracs()` | Data-driven level fractions, not hardcoded (Born since v0.7.0, E29) |
| G4ChemDissociationChannels | (code) | Inline branching in primary.wgsl | Autoionization for levels 1–4 (produces eaq) |
| G4DNAChampionElasticModel | sigma_elastic_e_champion | `xs_all().z` + `xs_el_cos()` | Scale: 1e-16 cm² (not Emfietzoglou's 1e-22/3.343 m²) |
| G4DNASancheExcitationModel | sigma_excitationvib_e_sanche | `xs_vib_total()` + `sample_vib_mode()` | 2× liquid phase factor applied |
| G4DNAWaterDissociationDisplacer | (code) | `init_thermal()` + worker prechem | Mother displacement + species-specific Gaussian σ |
| G4EmDNAChemistry_option1 | (code) | `public/irt-worker.js` RXN_TABLE | IRT off-main-thread — matches Karamitros 2011 |

## Performance

Measured on Apple M2 Max, Chrome 132, 4096 primaries @ 10 keV.

```
                   Geant4 (CPU)              WebGPU (GPU + Worker)
                   ─────────────             ──────────────────────
 Runtime           Single-thread C++         Parallel WGSL compute + CPU IRT
 Parallelism       1 particle at a time      4096 pri + ~900k sec + ~5M radicals
 Full 8-energy     minutes per energy        ~8 s physics total
 Chemistry @10keV  hours                     ~30–60 s in IRT worker

 Physics match @ 10 keV, 4096 primaries (v0.7.0; README § Numbers is the
 single source of truth — this only summarizes it):
   CSDA range       0.997× Geant4 (2739.6 vs 2747.5 nm)          [E5, E29]
   Ions/primary     primary track 0.999× (195.4 vs 195.6);
                    full cascade 0.981× (499.3 vs 509.2)         [E20, E35]
   Energy cons.     100.0%
   Mean W_transfer  57.14 eV vs 57.15 eV Geant4 (1.000×)
 (The earlier "Ions/pri 509.1 → 1.00×" row was retracted — see CHANGELOG;
 it conflated the Geant4 full-cascade sum with the WGSL primary-only count.)
   MFP                                       within 2–14% at all 8 energies
```

## Known gaps

- GPU-resident chemistry path (`chemBackend: 'gpu'`) undercounts long-time
  reactions vs IRT because the spatial hash search radius is narrower than
  the diffusion σ at 30 ns timesteps. The IRT worker is the default for
  this reason.
- `data/g4emlow/` is not committed (245 MB) — download from
  https://geant4-data.web.cern.ch/datasets/ to rebuild `public/cross_sections.wgsl`
  via `npm run convert`.
- G(OH) and G(eaq) ratios to Karamitros 2011 are inherently below unity at
  10 keV because Karamitros's reference is for ~1 MeV low-LET radiation,
  where track-core radical recombination is lower.
