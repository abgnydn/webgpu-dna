# H₂O⁺ tracking — design doc

**Status: PREMISE REFUTED 2026-05-13 by source archaeology** (see
§"Geant4 source archaeology — verdict" below). The whole motivation
for replacing `RECOMB_BOOST = 2.0` with "real" time-integrated
recombination assumed Geant4's `G4DNAElectronHoleRecombination`
integrates over the H₂O⁺ lifetime. **It doesn't.** Geant4 is a
one-shot, single-sample check against the nearest eaq within
`10 × r_Onsager`, which is essentially what our WGSL kernel already
does (modulo geminate-vs-nearest, which E10e measured as a 3.5 %
contribution to the deficit).

This file is kept in the tree as a record of how the design was
revised and what the actual next-research-question is. **Do not
implement Phase 0 H₂O⁺ tracking — it would not change behavior in
the way the original design predicted.**

The historical design (kept below for the archaeology trail).
Original status line:

This is the named structural fix in [`ROADMAP.md`](./ROADMAP.md) Tier 1
and [`PHYSICS_DIAGNOSIS.md`](./PHYSICS_DIAGNOSIS.md) §1, called for by
the two-knob structural limit that E7c (asymmetric `RECOMB_BOOST`) and
E5e (W_sec cutoff sweep) both confirmed cannot be sidestepped with
existing knobs.

## Geant4 source archaeology — verdict (2026-05-13)

The premise driving this entire design — that Geant4 has a
time-integrated e-h recomb that our one-shot WGSL check
under-approximates — **does not survive contact with the source.**

`G4DNAElectronHoleRecombination.cc` in Geant4 11.4.1 implements
recomb as follows (file:line citations below verified by hand):

| File:line | What |
|---|---|
| `GetMeanFreePath` (line 322-332) and `GetMeanLifeTime` (line 336-344) | Return `0.` if `FindReactant(track)` is true, else `DBL_MAX`. Result: the process fires on the **first chem-step call** if any nearby eaq is within range; otherwise it doesn't fire at all (no re-checking on subsequent steps). |
| `FindReactant` (line 213-309) | Finds nearest eaqs within `10 × onsagerRadius`, computes `P = 1 - exp(-r_Onsager / r_sep)` for each, samples a single uniform random against `pState->fSampleProba`. Returns `reactants[0].fProbability > pState->fSampleProba` — i.e., it only matters whether the **single closest eaq** beats the sample. |
| `MakeReaction` (line 161-209) | Iterates `reactants` BUT contains `break` (line 180) right after the first iteration's check. So it selects from `reactants[0]` only. The H₂O⁺ becomes H₂Ovib via `ChangeConfigurationToLabel("H2Ovib")` on success, or stays as `fStopButAlive` (= no recomb, decay as default H₂O⁺ → OH + H₃O⁺ path) on failure. |

**There is no Brownian sub-loop. No per-step re-check. No
time-integrated cumulative probability.** It's a single sample against
the nearest eaq.

The only ways Geant4's recomb effectively differs from our WGSL
one-shot check:

- **(a)** Geant4 uses **nearest eaq within `10 × r_Onsager`**, not
  the geminate eaq. Cross-event candidates from other ionizations can
  win if they're closer.
- **(b)** Geant4's `r_sep` is whatever the eaq's actual position is
  at H₂O⁺ creation time (after pre-chem displacement steps). Ours is
  Meesungnoen-sampled at primary kernel emit time. Probably close.

**E10e already measured difference (a)** end-to-end on real rad_buf
data: `mean P_recomb_nearest = 0.230` vs `mean P_recomb_geminate = 0.221`
(point estimate at r=2.84 nm Meesungnoen mean). ΔP = +0.009, which
maps to **+0.44 H₂/primary out of a 12.4 H₂/primary chem6 deficit
(3.5 %)**. The cross-event lookup is essentially a no-op at 10 keV
because the geminate eaq is the nearest one in ~98 % of cases.

**Conclusion**: `RECOMB_BOOST = 2.0` has no physical basis. There's
no time-integrated Geant4 mechanism for it to approximate. The
chemistry deficit must come from somewhere else.

## What the chemistry deficit actually is

If Geant4 recomb fires identically to ours at the H₂O⁺ creation step,
the 0.5×-0.7× G(H₂) / G(H₂O₂) gap (E9 at 0.1 ps) and the residual
~10-20 % deficit at 1 μs (E10c) can only come from one of:

1. **Per-primary IRT partitioning at the chem stage** — E10f measured
   this is responsible for **96 % of the 1 μs implementation gap**.
   Geant4 chem6 runs all primaries in one chemistry pool; we run
   per-primary. Inter-primary recomb reactions (H+H, eaq+eaq, etc.)
   that Geant4 captures, we don't.

2. **Secondary KE differential distribution (W_sec)** — E8 noted a
   43 % deficit in the 438-806 eV tail. Affects how many secondaries
   end up sub-cutoff vs tracked, which affects local radical density
   and downstream chemistry.

3. **Solvation radius / Meesungnoen kinetic-energy input** — our
   autoionization eaq uses Meesungnoen at 1.7 eV uniformly. Geant4's
   matches but the effective eaq position may differ at higher excited
   states (B1A1 autoion ke = exc_energy - I_p, ranges 0-2 eV).

The structural fix is **NOT H₂O⁺ tracking**. It's likely:

- **Cross-primary IRT** via spatial hash at the chem stage. Substantial
  refactor of `public/irt-worker.js` to drop the `priMap` partitioning
  and use a spatial-hash for reaction candidate lookup. O(N² log N)
  worst case but tractable with appropriate cell size + diffusion-
  bounded search radius. Per-primary partitioning is only a perf
  optimization, not physics.

- **W_sec differential CDF audit** — re-derive our Born differential
  table and compare bin-by-bin against Geant4's 438-806 eV bin where
  E8 noted a 43 % deficit.

The roadmap should be updated to reflect this. The H₂O⁺ tracking
item moves to "REFUTED — see H2OP_TRACKING_DESIGN.md".

---

**Below: the original design as written 2026-05-13 BEFORE the source
archaeology was done. Kept for the archaeology trail.**

## What the fix needs to do

The current model encodes the recomb decision **inline in the WGSL
primary kernel** at every ionization event:

```wgsl
let p_recomb = min(1.0, RECOMB_BOOST * (1.0 - exp(-r_onsager / r_sep)));
if (rf(&s) < p_recomb) {
  // emit H2Ovib products
} else {
  // emit OH + H3O+ + eaq
}
```

This is a **one-shot decision at t = 0** using the geminate Meesungnoen-
displaced eaq separation. It under-counts the recomb that should happen
during the H₂O⁺'s real lifetime, so we multiply by `RECOMB_BOOST = 2.0`
to approximate the time-integrated rate.

The fix replaces this with:

1. **Always emit** `OH + H3O+ + eaq` at the ionization site (strip the
   if/else recomb branch from WGSL).
2. **Reduce `RECOMB_BOOST` to 1.0** (no compensation factor).
3. In the IRT worker's **Phase 0** (before the existing reaction-time
   loop), simulate H₂O⁺ with a finite lifetime and run a real
   encounter-based recomb against ANY nearby eaq.
4. On recomb fire, delete the `OH + H3O+ + eaq` triple and emit the
   `G4ChemDissociationChannels_option1.cc:431-465` H₂Ovib decay
   products (13.65 % 2OH+H₂ / 35.75 % OH+H / 15.6 % 2H / 35 % relax).

## The open physics question

**What does Geant4 actually do over the H₂O⁺ lifetime?** The naive
"check Onsager every chem step" formula
`P_recomb_per_step = 1 - exp(-r_Onsager / r_sep)`
applied N times gives `P_total = 1 - (1 - P_step)^N`, which approaches
1.0 quickly for `P_step ≈ 0.22` and `N = 1000` (Geant4's default ~1 fs
step over ~1 ps H₂O⁺ lifetime). That's unphysical — Geant4 doesn't
recombine ~100 % of ionizations.

Candidate explanations (verify against `G4DNAElectronHoleRecombination.cc`
in Geant4 11.4.1, lines ~140-310, in particular the `AtRestDoIt`,
`GetMeanFreePath`, and `GetMeanLifeTime` methods):

- **Single-firing semantics**: the recomb check happens **once** at H₂O⁺
  creation (`AtRestDoIt`), not at every chem step. Time integration is
  implicit in the choice of `r_Onsager` and the search radius
  `10 × r_Onsager`, not in repeated sampling.
- **Spontaneous decay competing channel**: H₂O⁺ has a finite lifetime τ
  with `P_decay_per_step` that ALSO grows with step count, bounding
  the recomb probability via competition.
- **Brownian escape**: the eaq diffuses out of the Onsager well before
  the H₂O⁺ lifetime expires, and the per-step P_recomb decays with the
  cube of `r_sep`. Even if recomb fires "always" while bound,
  diffusion limits the binding window.

The diffusion math: `D_rel ≈ 0.0072 nm²/ns`, `τ_H2O+ ≈ 1 ps`. RMS
displacement over τ: `sqrt(6 × D × τ) = sqrt(6 × 0.0072 × 0.001) = 0.0066 nm`.
**Essentially zero motion in 1 ps.** So Brownian escape ISN'T the
bounding mechanism. Probably option 1 or option 2 above.

**Action item**: read `G4DNAElectronHoleRecombination.cc` lines 140-310
in Geant4 11.4.1 carefully. Determine which mechanism Geant4 actually
uses. That answer dictates the rest of the design.

## Implementation plan (after the physics is settled)

### Step 1 — strip WGSL recomb branches

`src/shaders/primary.wgsl`:

| Line | Branch | Action |
|---:|---|---|
| 229-288 | Sub-cutoff ionization recomb (`p_recomb`) | Remove `if/else`, always emit `OH + H3O+ + eaq` |
| 290-353 | Tracked-secondary recomb (`p_recomb_t`) | Same |
| 466-536 | B1A1 autoionization recomb (`abp_recomb`) | Same |
| 555-621 | L2-4 autoionization recomb (`ahp_recomb`) | Same |

`src/shaders/secondary.wgsl`:

| Line | Branch | Action |
|---:|---|---|
| 210-260 | Tracked-tertiary recomb (`p_recomb_t`) | Same |
| 297-340 | B1A1 autoion in secondary (`sabp_recomb`) | Same |
| 370-410 | L2-4 autoion in secondary (`sahp_recomb`) | Same |

Estimated diff: -200 lines, +50 lines (just the unconditional
emit-OH+H3O+-eaq path).

### Step 2 — set `RECOMB_BOOST = 1.0`

`src/shaders/helpers.wgsl`: drop the `RECOMB_BOOST = 2.0` to `1.0`.
Or remove the constant entirely once Phase 0 owns recomb.

### Step 3 — implement Phase 0 in `public/irt-worker.js`

Add a new function `phase0_h2op_recomb(rad_buf, rad_n, rng)` called
BEFORE the existing `priMap`/reaction-time loop. Pseudocode:

```js
function phase0_h2op_recomb(rad_buf, rad_n, rng) {
  // 1. Find all ionization sites (OH + H3O+ co-located within ε).
  //    Hash by quantized position; mark each (oh_idx, h3op_idx)
  //    pair as one ion site. The eaq from this ionization is at
  //    a Meesungnoen-displaced position nearby.
  const ionSites = findIonizationSites(rad_buf, rad_n);

  // 2. Spatial index all eaqs (sp=1 and sp=5) for fast nearest-
  //    neighbor lookup.
  const eaqIndex = buildSpatialHash(rad_buf, rad_n);

  // 3. For each ion site:
  for (const site of ionSites) {
    //   a. Find all eaqs within 10 × r_Onsager
    const candidates = eaqIndex.findInRange(site.pos, 10 * R_ONSAGER);

    //   b. For each candidate, compute the (Geant4-equivalent)
    //      time-integrated P_recomb. See §"The open physics question"
    //      above — formula TBD.
    const r_nearest = computeNearestRsep(site.pos, candidates);
    const P_recomb = geant4EquivalentRecombProbability(r_nearest);

    //   c. Sample.
    if (rng() < P_recomb) {
      //   d. On recomb, delete OH + H3O+ at site + nearest eaq.
      //      Emit H2Ovib decay products via G4 branching:
      //      13.65 % 2OH + H2  (decCh1)
      //      35.75 % OH + H    (decCh2)
      //      15.60 % 2H + O    (decCh3)
      //      35.00 % nothing   (decCh4)
      const r = rng();
      if (r < 0.1365) emitH2Ovib_2OH_H2(rad_buf, site);
      else if (r < 0.494) emitH2Ovib_OH_H(rad_buf, site);
      else if (r < 0.650) emitH2Ovib_2H(rad_buf, site);
      // else: relax — just delete the triple
    }
  }
}
```

Implementation notes:
- `findIonizationSites`: quantize positions to `1e-4 nm` and bucket;
  OH+H3O+ in the same bucket = an ion site. Same pattern as
  `experiments/level-4-chemistry/E10e-cross-event-recomb-synthetic.mjs`.
- `buildSpatialHash`: 0.5 nm cell size, ~50 eaqs/cell at 10 keV. Use
  existing `chem_pos` spatial-hash infrastructure if available.
- `geant4EquivalentRecombProbability`: this is the gap. Pending the
  source-archaeology answer.
- The H₂O⁺ "lifetime" is implicit — Phase 0 is a one-shot pass, so
  the model implicitly takes τ → ∞ (recomb if ever within range).
  If Geant4 uses single-firing semantics, this matches exactly.

### Step 4 — validation chain

Mirroring the pattern already in `experiments/`:

| New experiment | Purpose | Pass bar |
|---|---|---|
| E10k | G-values at 0.1 ps and 1 μs under Phase 0 vs chem6 | RMS dev ≤ 19 % (current best) |
| E5f | CSDA at 8 ESTAR energies (re-run of E5d) | 8/8 monotonic preserved |
| E7d | Cascade ions @ 10 keV (re-run of E7b) | cascade ≥ 380, W ≤ 26.5 eV (recovered) |
| E13d | SSB / DSB closure (re-run of E13c) | ratio ∈ [2, 3] (PARTRAC band) preserved |

The structural prediction: if Phase 0 is implemented correctly, all
of these should pass simultaneously — cascade ions AND chemistry both
recover, escaping the two-knob structural limit documented in E7c.

## Why this is a real research deliverable

The current `RECOMB_BOOST = 2.0` is a documented fudge factor (see
`src/shaders/helpers.wgsl`). The H₂O⁺ tracking refactor replaces it
with the actual physical model. The validation gate above is the
**falsifiable prediction**: if Phase 0 doesn't escape the two-knob
limit, then the joint chemistry+cascade structural limit is more
fundamental than the recomb branch — maybe it lives in the W_sec
distribution or the secondary stepper.

Either outcome (success or refutation) advances the project's
research-grade ledger. Don't ship a flag without a measurement.

## Estimated effort

Multi-agent wall time per [`ROADMAP.md`](./ROADMAP.md) convention:

- **1 hr engineering wall**: 3 parallel agents (WGSL strip, IRT Phase 0
  implementation, validation harness scaffolding)
- **~10 min Playwright wall**: 1 validation harness re-run with chem
  enabled, IRT chem step is the hard floor
- **~30 min source archaeology**: read `G4DNAElectronHoleRecombination.cc`
  lines 140-310 to settle the `geant4EquivalentRecombProbability`
  question. Must be done FIRST.

Total: ~1.5-2 hours wall, of which the physics archaeology is the
sequential gate. Everything else is parallel.

## Anti-pattern to avoid

Do not ship a Phase 0 that re-introduces `RECOMB_BOOST`-style multipliers
without a physical derivation. The whole point of this refactor is to
replace the fudge factor with a model that has a single-line citation
back to Geant4 source. If the implementation can't cite a specific
file:line in `G4DNAElectronHoleRecombination.cc` for its recomb
probability formula, the work isn't done.

A successful PR for this fix:
- Strips RECOMB_BOOST entirely (or sets it to 1.0 and notes it's no
  longer the active recomb knob)
- Cites Geant4 source for the Phase 0 formula
- Lands artifacts under `experiments/results/<date>/level-{2,3,4,5}/`
  showing the structural-limit prediction passes (or fails — failure
  is a publishable result)
- Updates `README.md` § Numbers with post-fix rows under the new
  shader hash
- Updates `PHYSICS_DIAGNOSIS.md` § 1 to reflect the closed gap
- Removes the "two-knob structural limit" entry from
  `ROADMAP.md` Tier 1
