# Roadmap

Forward-looking companion to [`README.md` § Numbers](./README.md#numbers)
(canonical truth), [`PHYSICS_DIAGNOSIS.md`](./PHYSICS_DIAGNOSIS.md) (open
physics gaps), and [`EXTENDING.md`](./EXTENDING.md) (recipe for adding a
new model).

## Estimation convention

**Wall-clock estimates here assume multi-agent parallel work** — typically
10-20 Claude Code agents running in parallel against the falsifiable-
artifact protocol. Single-engineer estimates are 1-2 orders of magnitude
larger and irrelevant for the deployment scale this project actually runs
under.

The genuine sequential floor is **Playwright + IRT chemistry at 10 keV
takes ~3 min per harness run** — this is a physics-simulator bottleneck
that doesn't compress with agent count. Plan validation in batches that
share a single harness run when possible.

Each item below lists: **(scope) (parallelism) (sequential bottleneck) (validation gate)**.

## Tier 0 — Operational housekeeping (~minutes)

- **Zenodo DOI for v0.3.0.** OAuth-based, must be done from a browser.
  Updates `CITATION.cff` `preferred-citation` block with the real DOI.
  (5 min · sequential · n/a · n/a — but you have to do it yourself)

- ~~**`shaderHashes` retrofit for pre-2026-05-12 artifacts**~~ **DONE
  2026-05-13.** `tools/retrofit-shader-hashes.mjs` walked
  `experiments/results/` and back-filled shader hashes via
  `git rev-parse <gitSha>:<shader-path>` for 48 of 59 artifacts (the
  other 11 already had organic `shaderHashes` from `captureEnv()`).
  Every L0-L6 artifact now identifies its shader version.

## Tier 1 — Open physics (the structural questions)

### H₂O⁺ tracking with proper time-integration (~1.5-2 hr)

The named third-knob fix from E7c. Replaces the `RECOMB_BOOST` constant
with the actual physical model: H₂O⁺ as a discrete species with finite
lifetime, encounter-based recomb fires during the chem timestep against
the nearest eaq within `10 × r_Onsager`.

**Design doc**: [`H2OP_TRACKING_DESIGN.md`](./H2OP_TRACKING_DESIGN.md) —
captures the open physics question (what does Geant4 actually do over
H₂O⁺ lifetime? naive Onsager-per-step gives `P → 1` quickly, which is
unphysical), the implementation plan, the file:line catalogue of WGSL
recomb branches to strip, the Phase 0 algorithm in pseudocode, the
validation chain (E10k / E5f / E7d / E13d), and the anti-pattern that
disqualifies a "fix" (no physics citation = not done).

**Scope:**
- Add Phase 0 in `public/irt-worker.js` (before the existing IRT
  reaction-time loop)
- Modify `src/shaders/primary.wgsl` and `src/shaders/secondary.wgsl`
  to emit OH + H₃O⁺ + eaq unconditionally at every ionization (strip
  the WGSL-side recomb branches)
- Set `RECOMB_BOOST = 1.0` in `src/shaders/helpers.wgsl`
- Implement Brownian-walk + Onsager-check sub-loop in Phase 0
- New experiment E10k: G-values at 0.1 ps and 1 μs under the new model

**Parallelism:** 3 agents in parallel — one for the WGSL strip, one for
the IRT worker Phase 0 implementation, one for E10k validation harness.

**Sequential bottleneck:** one Playwright run to compare (~3 min).

**Validation gate:** RMS dev vs chem6 ≤ 19% (current best), cascade
ions ≥ 360, G(eaq) ≥ 0.85× chem6.

### W_sec distribution shifter (~30 min)

Alternative third knob: increase `p.ce` (the secondary-tracking cutoff)
from 7.4 eV to 12-15 eV, shifting more secondaries to the sub-cutoff
geminate-recomb branch. Tests whether the cascade-vs-chemistry tradeoff
can be decoupled by changing which path each secondary takes.

**Scope:** Add `ceEV` sweep harness; run validation at ceEV ∈ {7.4, 10,
12, 15, 20}; capture G-values + cascade ions per ceEV.

**Parallelism:** 5 agents in parallel running each ceEV value.

**Sequential bottleneck:** 5 × 3 min Playwright runs = 15 min wall
(harness runs are sequential per-machine).

**Validation gate:** identify a ceEV that yields cascade > 380 AND
chem6 RMS dev < 22%.

### E14 — molecularDNA full-chromatin geometry (~2-3 hr)

The remaining open L5 experiment. Closes "we use a 21×21 fiber grid;
molecularDNA uses full chromatin" geometry gap.

**Scope:** Port `molecularDNA`'s GDML chromatin model (Geant4 11.4.1
examples), import as a buffer-backed scoring target in
`src/scoring/`, rerun SSB/DSB scoring against the new geometry.

**Parallelism:** 2 agents — one geometry conversion, one scoring
refactor. Validation harness reuses E13c pattern.

**Sequential bottleneck:** 1-2 Playwright runs.

**Validation gate:** indirect/direct SSB ratio still in PARTRAC [2, 3]
band on chromatin target; absolute yields cross-check with Friedland 2011.

## Tier 2 — Scope expansion (the "full port" chunks)

### option3 chemistry — extended species + reactions (~1-2 hr)

Adds HO₂, HO₂⁻, O, O⁻, O₂, O₂⁻, O₃, O₃⁻ species + ~16 extra reactions
from `G4EmDNAChemistry_option3.cc`. Note: chem6's `beam.in` macro
resets the reaction table to option1 explicitly, so direct comparison
to chem6 stays on option1. option3 reactions become available for
users who explicitly enable them.

**Scope:** Extend species table in `public/irt-worker.js` (codes 8-15
or extend to 4-bit encoding), add diffusion constants, append reactions
to `RXN_TABLE`. Add E10l experiment that validates new-species
production at 1 μs against chem6 option3 default.

**Parallelism:** 10 agents — one per new reaction, plus 2 for the
species-encoding migration and validation harness.

**Sequential bottleneck:** 1 Playwright run for the species-production
check.

**Validation gate:** all 8 new species produced at ≥ 0.5× chem6 option3
1 μs G-values.

### Rudd ionization (p⁺, α) + Dingfelder charge exchange (~2-3 hr)

First heavy-particle port. Same data-table-driven pattern as Born for
electrons.

**Scope:**
- New `src/shaders/proton.wgsl` parallel to `primary.wgsl`
  (kinematics swap, Rudd differential CDF, charge-exchange branch)
- Convert `sigma_ionisation_p_rudd.dat` etc. in `tools/convert_g4data.py`
- Reuse `secondary.wgsl` for the secondary electron cascade
- New experiments E1p (σ bit-match), E5p (CSDA), E6p (MFP),
  E7p (cascade ions) at proton energies

**Parallelism:** 4 agents in parallel:
- Proton kernel WGSL
- Rudd σ data conversion
- Charge-exchange branch
- Validation experiment scaffolding

**Sequential bottleneck:** 1-2 Playwright proton runs (~3 min each)
+ Geant4 11.4.1 proton-beam ntuple regeneration.

**Validation gate:** σ_ion proton vs G4 within 5%; CSDA at MeV
energies within 15% of ICRU 49 stopping-power tables.

### Light + heavy ions (Li, Be, B, C, N, O) parametrized over Rudd (~30 min)

Once Rudd is in place, light/heavy ions are mostly Z/M parameter swaps.

**Parallelism:** 6 agents — one per ion species, each adding the
parameter set + a validation experiment.

### Alternative low-E electron models (~2 hr total)

CPA100, ELSEPA, Uehara-Screened Rutherford, Miller-Green, Quinn plasmon,
RPWBA. Drop-in alternatives selectable via shader define or runtime flag.

**Parallelism:** 6 agents — one per model.

**Validation gate:** each new model's σ matches its G4EMLOW data table
within 5e-3 (E1-style bit-match) AND track-structure validation passes
at all 8 ESTAR energies.

## Tier 3 — Architecture beyond the static demo

### WebRTC swarm MVP (~3 hr)

Architecture for citizen-science radiation-biology compute at scale.
Discussion: [thread above in the work log; see SWARM.md when written].

**Components, parallel:**
1. Coordinator service (Cloudflare Worker / Durable Object) holding the
   work queue + WebRTC signaling
2. Worker mode in the existing harness — auto-pull batches, run,
   stream JSON deltas back
3. WebRTC DataChannel transport layer
4. Trust / validation layer (BOINC-style re-verification on a known-
   good node)
5. Aggregator that merges JSON artifacts across nodes with statistical-
   reduction discipline
6. Live progress UI

**Parallelism:** 6 agents, one per component.

**Sequential bottleneck:** end-to-end integration test with 5+ real
browsers as workers.

**Validation gate:** crowdsourced run of E10 against ground-truth
single-machine artifact, ratio across all 5 species within MC noise
(σ-significance < 1 of single-machine baseline).

### Headless native runtime (`webgpu-dna-native`) (~2-3 hr)

Removes the browser-tab-lifetime ceiling. Node + `wgpu-native`
(`@webgpu/node` or Dawn bindings) wraps the existing WGSL shaders.

**Scope:** Adapter enumeration, multi-GPU primary-batch scheduler,
streaming I/O for arbitrary-size outputs, Slurm-friendly seed
partitioning.

**Parallelism:** 4 agents — runtime wrapper, multi-GPU scheduler,
streaming writer, distributed reducer.

**Validation gate:** matched-N run produces same G-values as the
browser harness within statistical noise.

## Tier 4 — Stretch / speculative

- **GPU chemistry path made accurate.** E11's 13.6× speedup is gated
  by long-time accuracy. Investigating chemistry-step time-integration
  + spatial-hash radius adaptation could close that gap.
- **Continuous-time IRT** (Karamitros 2011 II) vs. our discrete-step
  worker. Likely useful at sub-fs timescales.
- **Multi-track integration.** Currently per-primary. Inter-primary
  recombination at the chemistry stage was confirmed by E10f to drive
  96% of the 1 μs implementation gap.

## Full-port total

Tiers 1 + 2 + integration = **~10-15 hours** of multi-agent wall time
to reach feature parity with Geant4-DNA's electron + water + low-Z-ion
scope. Tier 3 stretches the deployment ceiling beyond what conventional
HPC Geant4 can address (browser tab = citizen science; native runtime
= HPC cluster).

## Anti-roadmap (explicit non-goals)

- **Clinical / regulatory workflow** (TG-43, TG-119, MQA paper trail).
  Out of scope by design. Use Geant4-DNA for production radiotherapy.
- **GDML import beyond pre-baked geometries.** A full GDML parser in
  the browser is a project of its own; pre-baked targets (fiber grid,
  chromatin) are the right scope for teaching + research-method work.
- **ROOT output.** JSON artifacts + offline conversion utilities are
  enough for the protocol; embedding a ROOT writer in-browser is
  unnecessary.

These boundaries are *features*, not gaps — they let the project stay
focused on its actual thesis: validated radiation track-structure
physics, in a browser, with a falsifiable artifact ledger.
