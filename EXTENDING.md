# Extending WebGPU Geant4-DNA

This document is a concrete recipe for adding a new physics model or
chemistry reaction to the codebase at the same falsifiable-artifact
quality bar as the existing L0-L6 ledger ([README § Numbers](./README.md#numbers)).

If you only want to **read** the existing code, start with
[`ARCHITECTURE.md`](./ARCHITECTURE.md) instead. This file is for
contributors who want to land a new model and have it survive code
review.

## 0. The protocol contract

Before touching any code, internalize the discipline. **Every new
physics claim ships in the form**:

1. A protocol entry in `experiments/level-N-<slug>/protocol.md` describing the hypothesis, pass bar, and reference.
2. A driver `experiments/level-N-<slug>/<id>-<short-name>.mjs` that exports `runEi()`.
3. A registry row in `experiments/runner.mjs`.
4. A first run via `npm run experiments -- Ei` that writes a JSON artifact under `experiments/results/<UTC-date>/level-N/<id>-<short-name>.json`.
5. A row in [`README.md` § Numbers](./README.md#numbers) — README is the **single source of truth**; CLAUDE.md, index.html, and the OG image are summaries that link back.
6. A commit message that names the experiment + status (`pass` / `noisy` / `fail (honest negative)` / `marquee closure`).

Failed experiments are committed *with their failure*, not retried until they pass. Failure is evidence; rewriting until green is data-fitting. The point of the protocol is to make embarrassing gaps surface so they can be fixed.

## 1. Add a new electron physics model (worked example: a hypothetical CPA100 elastic)

CPA100 is one of Geant4-DNA's alternative elastic models for sub-1-keV electrons. We currently ship Champion + Screened Rutherford. Adding CPA100 as a user-selectable alternative is a 5-step recipe.

### 1.1 — Land the cross-section data

```bash
# Geant4-DNA elastic data files live under
#   data/g4emlow/dna/sigma_elastic_e_cpa100.dat
# (if you have Geant4 11.4.1 source / G4EMLOW 8.8 extracted)

# Inspect the file — column 0 is energy in eV, column 1 is σ in
# arbitrary units, the conversion factor lives in
# G4DNACPA100ElasticModel.cc:lineXXX.
head data/g4emlow/dna/sigma_elastic_e_cpa100.dat
```

### 1.2 — Extend `tools/convert_g4data.py`

Add a parallel block to the existing Champion path. The output is a WGSL `const` array (`XL_CPA100`) prepended to the shader at load time via the existing concat in `src/shaders/loader.ts`.

Key constraints:

- Use the SAME log-energy grid as the existing `XE` array — otherwise the binary search in `xs_all` won't work. Subsample using the existing `subsample_logspace()` helper.
- The conversion factor for CPA100 is NOT the same as Champion (CPA100 uses `1e-18 cm²` per data unit; Champion uses `1e-16 cm²`). See `G4DNACPA100ElasticModel.cc` for the exact `scaleFactor`.
- Run `npm run convert` from the repo root to regenerate `public/cross_sections.wgsl`.

### 1.3 — Wire into the WGSL kernel

In `src/shaders/helpers.wgsl`, extend `xs_all(E)` (or add a sibling `xs_elastic_cpa100(E)`) to read from the new const array.

In `src/shaders/primary.wgsl`, branch on a new shader define (`USE_CPA100_ELASTIC` or a buffer-uniform flag) to select between Champion and CPA100. **Do not silently replace** — keep both paths so existing artifacts remain comparable.

Constants like the joint-fix `SIGMA_EXC_SCALE` and `RECOMB_BOOST` live in `helpers.wgsl` for the same reason: easy to find, easy to audit, easy to tag in the per-artifact `shaderHashes` block.

### 1.4 — Write a Level-1 bit-match experiment (E3c)

Follow the E3 / E3b template literally:

```js
// experiments/level-1-cross-sections/E3c-cpa100-elastic-xs.mjs
//
// Hypothesis: σ_el_CPA100(E) computed from our converted XL_CPA100
// matches G4EMLOW's sigma_elastic_e_cpa100.dat within the same
// pass bar as E3 (Champion): max relative error < 5e-3 over the
// full 11 eV – 1 MeV range.
//
// Pass bar: peak_ratio ∈ [0.99, 1.01] AND median ratio − 1 < 1e-3.
// Failure means the conversion factor or interpolation scheme drifted.

export async function runE3c() {
  // 1. Load XE / XL_CPA100 from public/cross_sections.wgsl
  // 2. Load sigma_elastic_e_cpa100.dat directly
  // 3. Interpolate both onto a common log grid
  // 4. Compute per-row ratios, return rows + pass/fail summary
  return { meta, env, status, diagnosis, summary, rows };
}
```

Register in `experiments/runner.mjs`. Run with `npm run experiments -- E3c`. Commit the artifact under `experiments/results/<UTC-date>/level-1/E3c-cpa100-elastic-xs.json`.

### 1.5 — Write a Level-2 track-structure validation (E6c)

Once σ matches the reference data, validate that running the kernel with CPA100 selected produces sensible track structure:

```js
// experiments/level-2-track-structure/E6c-cpa100-mfp.mjs
//
// Hypothesis: with USE_CPA100_ELASTIC, the WGSL primary-track MFP
// across 6 energy bins falls within ±15% of the Geant4 dnaphysics
// ntuple run with CPA100 elastic enabled (G4EmDNAPhysics_option3).
//
// Pass bar: |MFP_wgsl / MFP_g4 − 1| < 0.15 for all 6 bins.
```

This is the "are the cross-sections actually being sampled correctly" check. It's the difference between "we shipped a new file" and "we shipped a working physics model".

### 1.6 — Update [`README.md` § Numbers](./README.md#numbers)

Add a row to the Level-1 and Level-2 tables with the new artifact, the headline metric, and a pass/fail status. **Do not introduce any number that is not in the artifact JSON.**

## 2. Add a new chemistry reaction (worked example: H₂ + OH → H₂O + H)

The IRT worker in `public/irt-worker.js` reads a data-driven reaction table; adding a row is a one-edit change.

### 2.1 — Edit the `RXN_TABLE` array

```js
// public/irt-worker.js around line 215
const RXN_TABLE = [
  // ... existing 9 reactions ...
  // 9 (new): H₂ + OH → H + H₂O
  { a: 6, b: 0, k: 3.28e7, prods: [2], type: 1 },
];
```

Indices:
- `a`, `b`: species codes (see the encoding comment near `species_code` in primary.wgsl line ~454)
- `k`: rate constant in L/(mol·s) — the same units chem6's `/chem/reaction/add` macro uses
- `prods`: array of product species codes
- `type`: 0 for totally diffusion-controlled (TDC), 1 for partially diffusion-controlled (PDC, applies Onsager screening for charged pairs)

For the H₂ + OH example: rate constant 3.28e7 M⁻¹s⁻¹ matches `G4EmDNAChemistry_option3.cc:270`.

### 2.2 — Add the new species (if applicable)

If the new reaction involves a species we don't track yet (e.g., HO₂°, O⁻, O₃), you'll also need to:

- Extend the species encoding (currently 0-7 in 3 bits of `rad_buf.w`) — may require a 4-bit encoding migration.
- Add diffusion constants to `DIFF_NM2_PER_NS` in `irt-worker.js`.
- Update `src/physics/types.ts` `ChemCheckpoint` to add `G_<species>` fields.
- Update `src/ui/table.ts` if the new species should show in the UI.

### 2.3 — Validate vs chem6

Write E10j-style experiment: run the IRT worker with the new reaction, compare G(species) at 1 μs to a freshly-built chem6 run with the matching reaction added to `beam.in` via `/chem/reaction/add`.

Pass bar: |G_wgsl − G_chem6| / G_chem6 < 0.20 at 1 μs.

## 3. Add a new heavy-particle primary (sketch — bigger lift)

Currently the kernel is electron-only. Adding protons or alphas means:

1. **New WGSL kernel**: `proton.wgsl` parallel to `primary.wgsl`. Most code is reusable (Sanche vib, DEA, mother displacement), but the ionization model swaps from Born to Rudd, the differential CDF is different, and there's a Dingfelder charge-exchange branch.
2. **New cross-section tables**: G4EMLOW ships `sigma_ionisation_p_rudd.dat`, `sigma_excitation_p_miller-green.dat`, etc. Convert them via `tools/convert_g4data.py` extension.
3. **Kinematics**: proton mass + Bethe-Bloch high-energy regime + Rudd low-energy regime. Geant4 references: `G4DNARuddIonisationModel.cc`, `G4DNADingfelderChargeIncreaseModel.cc`.
4. **Secondary cascade**: a proton's secondary electrons go through the existing `secondary.wgsl` path. No change there.
5. **Validation**: full L1 / L2 / L4 sweep against Geant4 dnaphysics with proton beam.

Estimated effort per [README § Feature scope](./README.md#numbers): 3-4 weeks for Rudd ionization alone, plus 6-8 weeks of validation infrastructure for the full proton sweep.

## 4. Code review checklist

Before opening a PR for a new physics model, verify:

- [ ] New shader constants are in `src/shaders/helpers.wgsl` (so they show up in `env.shaderHashes`).
- [ ] Existing code paths are preserved (the new model is additive, selectable, not a silent replacement).
- [ ] L1 bit-match artifact lands first (passes before any kernel changes).
- [ ] L2 track-structure validation passes (or fails honestly with a row in PHYSICS_DIAGNOSIS.md).
- [ ] README § Numbers updated with the new row + headline number + artifact link.
- [ ] Commit message states `pass` / `noisy` / `fail (honest negative)` / `marquee closure`.
- [ ] `npm run test` still 46/46 (or you grew the test count and named the new tests).
- [ ] `npm run lint` clean.
- [ ] Failed experiments are committed with status=`fail`, not retried until passing.

## 5. What we will NOT accept

- A model added with no validation artifact.
- A number in README/CLAUDE.md/index.html that isn't sourced from a committed JSON artifact.
- A "fix" that silently re-baselines existing artifacts (always emit a new artifact rather than overwriting).
- Squashing the diff so the per-stage progression in `git log` becomes unreadable.

The protocol is the value-add. Without it this is just another GPU port; with it, it's a research-grade artifact ledger that survives audit. Read [`RESEARCH.md`](./RESEARCH.md) for the longer rationale.
