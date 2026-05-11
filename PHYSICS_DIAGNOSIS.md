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
1. Inspect the B1A1 dissociative branching ratio for the H₂-producing
   channel in primary.wgsl line 248-256. Compare to Geant4-DNA's
   `G4DNAEmfietzoglouExcitationModel`. If the WGSL constant is lower,
   raise it.
2. The dissociative-electron-attachment (DEA) channel may need its
   own H₂-producer branch.
3. Add HO₂° tracking + the HO₂° + HO₂° → H₂O₂ + O₂ channel to recover
   the H₂O₂ deficit cleanly.

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
- *(a) 1-line tweak:* raise SSB_R_DAMAGE_NM from 0.29 nm to 1.0 nm.
  Expected to lift SSB_ind from 0 to ~20-50.
- *(b) Refactor:* move indirect-SSB scoring into `public/irt-worker.js`,
  accumulate hits during the full IRT timeline rather than only at t=1 μs.
  Expected to roughly triple SSB_ind.
- *(c) Target redesign:* swap the 21×21 fiber grid for a uniform-cell
  DNA distribution. Closes both this gap and E12's target-concentration
  artifact in one move.

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
