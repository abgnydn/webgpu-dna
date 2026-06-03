# Level 5 — DNA damage yields

## Status: protocol only
No experiments implemented in stage 1. Awaits ingest of Friedland 2011
or molecularDNA reference data (DSB / SSB per Gy per Da).

## Thesis fragment
> Direct + indirect SSB yield and DSB yield per Gy per Dalton on the
> 21×21 B-DNA fiber grid land within the published band of Friedland
> 2011 / molecularDNA on a comparable target geometry.

## Baseline
Current 10 keV results (from validation/compare.py WEBGPU dict, N=4096):
- SSB direct:   24
- SSB indirect:  0
- DSB:           2
- Kernel hits: 117

These are absolute counts on the 21×21 fiber grid (3.89 Mbp target,
~1 e × 0.243 Gy at 30 μm box). To compare to literature, they must be
normalized to per-Gy-per-Da yields. Current README is honest that
"indirect SSB uses diffused OH at t = 1 μs against a concentrated 21×21
fiber grid sampling the track core, rather than a uniform bulk
distribution. The DSB/SSB ratio is therefore target-geometry-dependent."
That caveat means the pass bars below must use the same geometry
convention as the reference, or carry a documented geometry-correction
factor.

## Experiments

### E12 — Direct SSB yield per Gy per Da vs Friedland 2011 / molecularDNA
- **Hypothesis:** Direct-SSB count, normalized to (Gy × Da_target),
  matches the published band (Friedland 2011 ~5×10⁻¹⁰ /Gy/Da for
  10 keV electrons).
- **Method:** Score direct-SSB count from `rad_buf` ionization sites;
  normalize by total absorbed dose × target mass.
- **Pass bar:** `wgsl_yield ∈ [0.5×, 2×] published_yield`. Loose because
  geometry-correction factors live in this band.

### E13 — Indirect SSB yield with documented geometry caveat
- **Hypothesis:** Indirect-SSB count from t=1 μs OH-diffusion onto the
  fiber grid lies in the [0.3×, 3×] band of the published indirect-SSB
  reference, given the 21×21 concentrated-grid geometry vs uniform-bulk
  reference.
- **Method:** Same as E12 but with the t=1 μs OH front instead of
  ionization sites.
- **Pass bar:** band as above, with `notes` field carrying the geometry
  convention difference.

### E14 — DSB clustering: ±10 bp greedy vs reference
- **Hypothesis:** Greedy-clustered DSB count matches the published
  DSB/SSB ratio (~0.04 at 10 keV per molecularDNA) within 50%.
- **Method:** Apply ±10 bp clustering to combined direct + indirect SSB
  per chromatid; report DSB / SSB ratio.
- **Pass bar:** `|DSB/SSB_wgsl - DSB/SSB_ref| / DSB/SSB_ref < 0.5`.

### E12-local — absolute yield vs experiment, per LOCAL dose (terminal test)
- **Why:** E12/E13c normalise by the **box-average** dose (0.243 Gy), giving
  absolute yields 223×/796× over experiment — attributed to track-core
  concentration but never quantified. The strand-break *ratio* passes only
  because `P_indirect` was tuned to PARTRAC's band, so it is a fit, not a
  prediction. E12-local removes the box-average confound to test the absolute
  yield directly.
- **Hypothesis:** Normalised by the *local* dose the fiber grid actually
  receives (integrated from the 128³ voxel `dose_arr` over the grid
  footprint), the **direct** SSB yield lands within ~5× of the experimental
  ~1000 SSB / cell·Gy (Ward 1988, *Prog Nucleic Acid Res Mol Biol* 35:95);
  DSB within ~5× of ~35 / cell·Gy.
- **Method:** (1) read `dose_arr`; (2) sum dose over voxels intersecting the
  fiber footprint → local Gy; (3) yield = count / (local_Gy × target_Da);
  (4) compare to Ward 1988 cellular yields (≈ E12's "Friedland" per-Da
  numbers). Report `P_direct` separately since it is a literature value
  (~0.13–0.15), unlike the tuned `P_indirect`.
- **Pass bar:** direct-channel absolute yield within 5× of experiment with
  **no** geometry hand-wave. Falsifiable either way: vindicates the track-core
  defense quantitatively, or surfaces a real discrepancy.
- **Status:** defined 2026-06-03; needs one harness run for the voxel readback
  (deferred — was memory-blocked). Driver: `E12-local-dose-yield.mjs`.

## Artifacts
`experiments/results/<YYYY-MM-DD>/level-5/E<k>-<slug>.json`.
