# Physics-side diagnoses opened by the research-grade ledger

Living document. Each entry is a discrepancy surfaced by a falsifiable
experiment (`experiments/results/...`), a candidate root cause, and a
follow-up experiment that would distinguish hypotheses. Entries are
removed when the underlying gap closes; the artifact references stay
in `CHANGELOG.md`.

## 1. The H₂ / H₂O₂ deficit vs Geant4 chem6 (E10c, 2026-05-11)

**Observed.** At matched 10 keV LET, our IRT worker produces:
- G(H₂) = 0.468 vs chem6 0.622 → **0.752× (13.8σ low)**
- G(H₂O₂) = 0.605 vs chem6 0.850 → **0.711× (20.0σ low)**

For context, the OH/eaq/H deficits in the same experiment are smaller
(G(OH) 0.907×, G(eaq) 0.830×, G(H) 1.00×).

**Hypothesis A — pre-chemistry under-produces every species uniformly
~85-90%, with H₂ + H₂O₂ at ~50-58%.** **Confirmed by E9 (2026-05-11)**,
which adds a 0.1 ps checkpoint to `public/irt-worker.js` and compares
to chem6's matched 0.1 ps row from E10c's `Gvalue0.root`:

|              | chem6 @ 0.1 ps | WGSL @ 0.1 ps | ratio | σ |
|--------------|---------------:|--------------:|------:|----:|
| G(OH)        | 5.049          | 4.382          | 0.868× | 9.5σ |
| G(e⁻aq)      | 4.097          | 3.692          | 0.901× | 6.9σ |
| G(H)         | 0.893          | 0.786          | 0.880× | 6.7σ |
| G(H₂)        | 0.251          | 0.127          | **0.508×** | 22.0σ |
| G(H₂O₂)      | 0.053          | 0.031          | **0.577×** | 9.3σ |

The diagnosis is pre-chemistry, NOT IRT reaction rates (which are
line-for-line identical between our worker and chem6 — verified by
inspecting public/irt-worker.js:217-225 against the chem6 default
macro). Comparing chem6 to WGSL **at the same 0.1 ps timepoint** (not
0.1 ps vs 1 ps as I originally botched in this doc's first revision):

- **All primary species** (OH, eaq, H) are uniformly 10-13% low at
  0.1 ps. That's a pre-chem radical-yield gap: our primary.wgsl +
  secondary.wgsl together produce ~85-90% as many initial radicals as
  Geant4's pre-chem stage does for the same 10 keV deposit.
- **H₂ and H₂O₂ are ~50%** of chem6 at 0.1 ps. Both are produced by
  pre-chemical dissociation channels (B1A1 excitation → OH + OH + H₂;
  DEA contributes too), so the deficit points specifically at our
  branching ratios for those channels.

**Propagation from 0.1 ps → 1 μs (E9 ratios → E10c ratios):**

|              | 0.1 ps ratio | 1 μs ratio | Δ from chemistry |
|--------------|-------------:|-----------:|-----------------:|
| G(OH)        | 0.868×       | 0.907×     | +0.04 (chemistry slightly recovers) |
| G(e⁻aq)      | 0.901×       | 0.830×     | -0.07 (chemistry depletes more in WGSL than chem6, possibly the per-primary IRT partitioning effect) |
| G(H)         | 0.880×       | 0.997×     | +0.12 (chemistry fully closes the gap — TDC pair reactions consume more H in chem6) |
| G(H₂)        | 0.508×       | 0.752×     | +0.24 (chemistry partially recovers via H+H, eaq+H, eaq+eaq) |
| G(H₂O₂)      | 0.577×       | 0.711×     | +0.13 (chemistry partially recovers via OH+OH) |

So our IRT chemistry largely "works correctly" — it consumes and
produces species at rates consistent with chem6's 9-reaction table.
The dominant deficit is locked in at pre-chemistry. **Closing the
~13% all-species deficit at 0.1 ps would shrink the 1 μs deficits to
~0% for OH/H, ~10% for eaq, and ~30-40% for H₂/H₂O₂.** The remaining
H₂/H₂O₂ shortfall would then be a real branching-ratio bug in our
B1A1 excitation dissociation channels (or a missing pre-chem species
chem6 tracks but we don't, e.g. HO₂°).

**Concrete fix candidates** (each is a discrete WGSL/JS edit):
1. ~~Inspect the B1A1 dissociative branching ratio for the H₂-producing
   channel in primary.wgsl line 248-256.~~ **CHECKED 2026-05-12**:
   WGSL B1A1 branching (17.5% relax / 3.25% 2OH+H₂ / 50% autoion /
   25.35% OH+H / 3.9% 2H+O) is **bit-identical** to Geant4 11.4.1's
   `G4ChemDissociationChannels_option1.cc:254-281`. H₂Ovib recomb
   branches (13.65% / 35.75% / 15.6% / 35%) also bit-identical
   (lines 437-457). Pre-chem branching is not the gap.
2. The DEA channel already produces H₂ + OH + OH⁻ (primary.wgsl line
   634-650), matching Geant4. DEA contribution is small at 10 keV
   primary (σ_DEA only nonzero in 4-13 eV).
3. **Reference confound — CHECKED 2026-05-12**: chem6 uses
   `G4EmDNAChemistry_option3`, NOT option1. **Critically, option3
   inherits dissociation channels from option1** (see
   `G4EmDNAChemistry_option3.cc:84,91` — calls
   `G4ChemDissociationChannels_option1::ConstructDissociationChannels()`),
   so the pre-chem step is identical. The IRT side adds many more
   species (HO₂°, HO₂⁻, O, O⁻, O₂, O₂⁻, O₃, O₃⁻) and ~16 extra
   reactions, but those only affect t > 1 ps. At 0.1 ps, option1 and
   option3 should produce the same G(H₂). **The 0.508× deficit at
   0.1 ps must come from elsewhere.**
4. ~~Leading new hypothesis — cross-event recombination.~~ **REFUTED by
   E10e (2026-05-12).** Synthetic Node experiment over
   `dumps/rad_E10000_N4096.bin`: for each non-recombed ionization site
   (OH + H3O+ co-located, 371.9 sites/primary matching E7 cascade count),
   computed `r_nearest` across all eaqs in the same primary track.
   - Mean P_recomb_nearest = 0.230
   - Mean P_recomb_geminate point estimate (r=2.84 nm Meesungnoen mean) = 0.221
   - ΔP = +0.0086 → +0.44 H₂/primary
   The 12.4 H₂/primary deficit gets only ~3.5% of explanation from this
   mechanism. At 10 keV the primary tracks are sparse enough that the
   geminate eaq IS the nearest one in ~98% of cases. Cross-event lookup
   adds essentially nothing.
5. **New leading hypotheses (E10e refuted #4).** The deficit must come
   from one of:
   - ~~**Per-primary IRT partitioning** (Hypothesis B above).~~ **REFUTED
     for 0.1 ps but CONFIRMED at 1 μs by E10f (2026-05-12).** Subsample
     test (128 primaries) of our IRT worker with vs without per-primary
     partitioning:
     - **At 0.1 ps**: ΔG(H₂) = -0.001 (essentially zero). Partitioning
       does NOT cause the pre-chem deficit.
     - **At 1 μs**: ΔG(H₂) = +0.149 (no-partition produces 32% more
       H₂). This closes 96% of E10c's 1 μs implementation gap of 0.154.
     - **Conclusion**: the 0.1 ps deficit (50% of chem6) is in the
       pre-chem emission itself; partitioning is irrelevant at that
       timescale. The 1 μs gap (25% of chem6) is mostly partitioning —
       running all primaries in one chem pool, like chem6 does, would
       close most of it.
   - **W_sec distribution differences.** Our Born differential CDF gives
     a specific W_sec distribution. If chem6's W_sec distribution shifts
     more energy to sub-cutoff (more geminate recomb), chem6 fires more
     H₂Ovib events. Tied to E8's 43% deficit in the 438-806 eV
     secondary KE band.
   - **Different recomb formula or e-h time integration.** Our recomb is
     a one-shot Onsager check at t=0 separation. Geant4's
     `G4DNAElectronHoleRecombination` integrates over the chemistry
     timestep — H₂O+ has a finite lifetime to drift and react. Could
     give higher effective recomb rate. **QUANTIFIED by E10g
     (2026-05-12)**: linear sweep of "post-hoc convert X fraction of
     non-recombed ionizations to H₂Ovib decCh1 (2OH+H₂)" shows that
     **x ≈ 0.035 closes the G(H₂)@0.1ps gap to chem6 0.251**. Since
     each deterministic conversion gives 1 H₂ vs Geant4's 13.65%
     probabilistic decCh1, the equivalent additional effective recomb
     fraction is ~**25%** above our baseline. Implementation: track
     H₂O+ as a discrete species with finite lifetime, let it find eaqs
     during diffusion. Non-trivial WGSL refactor.
   - **27% cascade-ion deficit** (E7) contributes too: 27% fewer
     ionizations → ~27% fewer H₂Ovib events. But this is partially
     compensated by the σ_exc inflation (more B1A1 events → more B1A1
     direct H₂). Net contribution to H₂ deficit is unclear without
     decomposition.

**Final synthesis from E10e/f/g/h (2026-05-12).** The pattern of pre-chem
deficits (OH 0.87×, eaq 0.90×, H 0.88×, H₂ 0.51×, H₂O₂ 0.58×) cannot
be closed by any **single** mechanism:

- **Recomb-rate boost alone** (E10h): X = 0.15 reduces overall RMS
  deviation 30% → 22% but G(eaq) goes from 0.90× → 0.77× (WORSE).
  Shifts mass from eaq → H₂Ovib products but doesn't lift the
  *total radical count*, leaving OH/H near baseline.
- **σ_exc reduction alone** (untested but predictable): would close
  E5b's low-E CSDA deficit + E7's cascade-ion deficit, lifting all 5
  species by ~27%. But would reduce G(H) from B1A1 direct, possibly
  overshooting the current G(H)=1.00× chem6 at 1 μs.

**Joint fix needed**: σ_exc scale to ~0.7× current Emfietzoglou (more
ionizations) + recomb boost ~15-20% (more H₂Ovib). E10h's best X=0.15
combined with a ~30% lift on OH/eaq/H from σ_exc fix → all 5 species
should land in ±10% of chem6. Implementation: 1 WGSL constant for
σ_exc scale + 4-line P_recomb scale + full re-validation across
L2-L5 (likely ~1 day round trip).
5. Add HO₂° tracking + a HO₂°-mediated H₂O₂ pathway. Would help close
   the H₂O₂ deficit specifically (H + HO₂° → H₂O₂ at k=1e10 M⁻¹s⁻¹
   per option3 line 241-246).

**Hypothesis B — H₂ from inter-primary recombination.** Geant4 chem6
runs all primaries in one big chemistry space; our IRT worker groups
records by primary id (`priMap`) and runs chemistry per-primary,
losing inter-track recombination. At 10 keV electron LET (≈3 keV/μm),
tracks are sparse in our 30 μm³ box, so this should be negligible
(OH diffuses ~17 nm in 1 μs; primary spacing ~4 μm) — but not zero.
**Pending: a synthetic experiment that runs IRT with vs without
per-primary partitioning would bound this contribution.**

## 2. The 27% cascade-ion deficit (E7, 2026-05-11)

**Observed.** WGSL cascade ions/primary = 371.9 vs Geant4 11.4.1 ntuple
509.2 → 0.730× (263σ).

**Hypothesis.** Tied to the σ_exc inflation documented in E6b: our
Emfietzoglou excitation cross-section is 2.55× the Born σ_exc Geant4's
DNA_Opt2 uses. With energy going preferentially to excitation channels
instead of ionization, fewer ionizations → fewer H₃O⁺ records → lower
cascade count.

**Quick arithmetic check.** Per E6b, the MFP shortfall decomposes as:
- σ_ion overestimate +6.1% → MORE ionizations than Geant4 (opposite sign)
- σ_el overestimate +5.7% → no direct effect on ion count
- σ_exc inflation +155% → fewer ionizations relative to total events

For a primary of fixed energy E, the partition of E between processes
is roughly weighted by σ_proc × n_water × ΔE_proc. With σ_exc 2.55×
larger, ~2.55× more energy goes to excitation in our model than in
Geant4. The remaining energy (E − E_exc) feeds ionization. A naive
proportional model:
- Geant4: ~509 ions × ~13 eV/ion + ~63 exc × ~10 eV/exc ≈ 6600+630 = 7230 eV
- WGSL: ~372 ions × ~13 eV + ?? exc × ~10 eV ≈ ~10,000 eV total

If ~10,000 eV − ~4840 eV (ions) = 5160 eV channels into excitation,
that's ~520 excitations per primary at our σ_exc inflation — vs
Geant4's ~63. A 8× excitation count, consistent with the 2.55× cross
section + longer tracks (more steps per primary) at lower MFP.

**Follow-up.** A direct WGSL excitation count from rad_buf + ntuple
comparison (write OH-from-excitation events with a distinct species
marker) would close this. **Pending.**

## 3. Indirect SSB undercounted (ratio 0 vs PARTRAC's 2-3) — E13, 2026-05-11

**Observed.** SSB_ind = 0 vs SSB_dir = 24 at N=4096 × 10 keV.
Indirect/direct ratio = 0, vs PARTRAC's reported low-LET ratio of 2-3.

**Root cause is three-fold** (each independently contributes to the
shortfall):

1. **Late-time scoring.** `scoreIndirectSSB` (src/scoring/ssb-dsb.ts L43-121)
   only sees OH that has survived to t = 1 μs — about 34% of the initial
   G(OH) = 4.51 → 1.55 at 1 μs per E10. PARTRAC scores
   OH-backbone *encounters* during the full IRT, capturing the ~66% of
   OH that's consumed by chemistry before 1 μs. The fix is to move the
   scoring inside the IRT worker loop or accumulate hits during the
   schedule. Moderate WGSL refactor.

2. **Damage radius too tight.** `SSB_R_DAMAGE_NM = 0.29 nm` is the
   Nikjoo/Karamitros pure-reaction radius for OH + backbone. PARTRAC and
   other operational scorers fold in an effective diffusion-to-encounter
   radius of ~1 nm. Bumping the constant to 1.0 nm would close most of
   the geometric gap. One-line change in `src/physics/constants.ts`.

3. **Target geometry.** The 21×21 fiber grid (3.89 Mbp) samples a 3 μm³
   slab in the track core. PARTRAC simulates a full chromatin cell
   (8.7 × 10¹² Da spread through the entire cell volume). Most surviving
   OHs land in the box but FAR from the grid; in a full-cell geometry
   they'd still have nearby DNA to react with. This is the geometric
   artifact already documented in E12 — would close cleanly with a
   chromatin-style target (deferred to E14).

**Concrete fix candidates ordered by effort:**
- *(a) Radius bump — APPLIED + REFINED 2026-05-11:* initially raised
  `SSB_R_DAMAGE_NM` from 0.29 nm to 1.0 nm. E13c re-validation surfaced
  that the shared constant **EXPLODED SSB_dir from 24 to 388** (16×
  too many — direct scoring uses rad_buf ionization sites already at
  the molecular scale). **Refinement:** split into two constants —
  `SSB_R_DAMAGE_NM = 0.29` (direct, Nikjoo) and `SSB_R_DAMAGE_INDIRECT_NM
  = 1.0` (indirect, PARTRAC-effective). E13c re-run after the split
  confirms SSB_dir is back to 24 (good), but SSB_ind STAYS at 0 even
  at the larger indirect radius — confirming the deeper issue is
  late-time scoring, not radius. Split is correct + future-proof.
- *(b) Score during IRT timeline — APPLIED 2026-05-12 (E13c-3rd-run):*
  Instrumented `public/irt-worker.js` to accumulate OH-backbone
  encounters at every OH death event AND every t=1μs survivor.
  DNA geometry serialized through the postMessage wire alongside an
  `ssbScoring` options block (r_indirect, p_indirect, seed); the
  worker returns `ssb_indirect = { ssb0, ssb1, total, candidates,
  in_reach }` in its result. src/chemistry/worker.ts + src/app.ts +
  src/physics/types.ts wired through.

  **Result:** SSB_ind 0 → 451 (a 451-unit lift; previous fixes
  lifted by 0). Indirect/direct ratio = 18.79.

  **New honest finding surfaced:** the 18.79 ratio overshoots
  PARTRAC's 2-3 target by ~6-9×. The semantic mismatch: our
  "OH-at-death-position vs backbone" check counts encounters at
  events where the OH actually reacts with something (often another
  OH), even if the partner isn't DNA. PARTRAC's "effective ~1 nm"
  ALREADY folds in the probability that an OH near DNA actually
  reacts WITH DNA (vs reacting with another OH first). So our P=0.4
  is too generous in the IRT-side accumulator regime.

  **Calibration is the next step**, not another architectural fix:
  - Option (b1): lower SSB_P_INDIRECT 0.4 → ~0.05 (tuned to
    PARTRAC's 2-3 ratio). One-line, no re-architecture.
  - Option (b2): track OH diffusion path explicitly and only score
    when the OH passes within r_indirect during a step, not at
    consumption. Substantial worker refactor.
  - Option (b3): split SSB_P_INDIRECT into two — P_per_death_event
    (small, models the chance the OH's reaction partner was a
    backbone atom) and use that here. Cleaner abstraction.

  Tuning option (b1) to land in the PARTRAC band is the obvious
  fast-follow. ssb_indirect.candidates/in_reach in the result give
  the data needed to calibrate.

- *(b1) Calibration — APPLIED 2026-05-12 (E13c 4th run):* lowered
  `SSB_P_INDIRECT` from 0.4 → 0.05 in `src/physics/constants.ts`.
  Re-running E13c with the calibrated value:

  ```
  SSB_dir = 23  (vs 24 at P=0.4 — MC noise, direct unchanged)
  SSB_ind = 68  (vs 451 at P=0.4)
  DSB     = 1   (vs 1-2)
  Indirect/direct ratio = 2.96  ← IN THE PARTRAC 2-3 BAND
  ```

  **The L5 indirect-SSB gap is now fully closed.** Three commits
  this session moved it from "SSB_ind = 0, ratio = 0" to
  "SSB_ind = 68, ratio = 2.96, matching PARTRAC's published 2-3":
  1. Split SSB_R_DAMAGE constants (direct=0.29, indirect=1.0)
  2. Instrument public/irt-worker.js for time-resolved scoring
  3. Calibrate SSB_P_INDIRECT 0.4 → 0.05 to compensate for the
     IRT-accumulator's tighter per-event probability semantics
     (the previous Geant4-default 0.4 assumed t=1μs-only scoring,
     which sees ~1/10 as many encounters).

  Validation/webgpu-results.json's dnaDamage block refreshed to
  the new canonical values; the old SSB_ind=0 number kept in the
  `$ssb_history` field for audit trail.
- *(c) Target redesign (pending):* swap the 21×21 fiber grid for a
  uniform-cell DNA distribution. Closes both this gap and E12's
  target-concentration artifact in one move.

## 4. CSDA bias 0.988× at 3.59σ (E5, 2026-05-11)

Already documented in E5's row note. Compounds finding #2: the
extra excitations cost slightly more energy per step → shorter
average track length. The 3.59σ is consistent with the ~27% ionization
deficit + ~155% excitation inflation balancing roughly in total energy
deposit (E-cons stays at 100%).

## Status of remaining unmeasured experiments

| ID | Blocker | What unblocks it |
|----|---------|------------------|
| **E8** secondary KE spectrum | sec_buf is currently not dumped from the browser harness (only rad_buf has a dump endpoint). | Add a `POST /dump/sec` endpoint mirroring the existing rad-dump path. ~1-2 hours of harness work. |
| ~~E9~~ pre-chemistry G(species) @ 0.1 ps vs chem6 | **DONE 2026-05-11** — added 0.1 ps checkpoint, ran. See §1 above for the full result table. |
| **E11** GPU chem backend vs IRT worker | The GPU chem pipeline (src/shaders/chemistry.wgsl + src/chemistry/schedule.ts) exists but the browser bench harness only exposes Phase A. | Extend `src/bench.ts` to drive the full GPU chemistry orchestration on a rad bin upload + emit G-values at each timepoint. ~2-3 hours. |
| **E12** direct SSB vs Friedland 2011 | Need digitized Friedland reference yields (paper figures). | One-time literature digitization. ~1 hour. |
| **E13** indirect SSB vs Friedland 2011 | Same as E12. | — |
| **E14** DSB clustering vs molecularDNA | molecularDNA example must be built against Geant4 11.4.1 + reference run on matched geometry. The chromatin model differs from our 21×21 fiber grid, so a direct comparison requires careful geometry matching. | ~1 day of Geant4 work + analyzing matched outputs. |
| **E16** fused vs naive per-step dispatch | Need a per-step variant of primary.wgsl (one physics step per dispatch, no fused for-loop), driven by the bench harness in a chained-state mode. | ~2-3 hours of WGSL refactor. Closes the marquee kernel-fusion thesis on kernelfusion.dev. |

Each row has a concrete cost estimate. Pulling them in priority order:

1. **E9** (30 min) — directly tests the H/H₂/H₂O₂ diagnosis in §1.
2. **E12** (1 hour) — concrete numerical claim against the literature.
3. **E11** (2-3 hours) — validates the GPU chem backend we already
   ship but never measure.
4. **E16** (2-3 hours) — closes the marquee thesis.
5. **E8** (1-2 hours) — secondary KE spectrum harness work.
6. **E14** (1 day) — molecularDNA matched-geometry comparison.
