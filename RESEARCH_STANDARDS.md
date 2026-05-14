# Research-grade engineering standards

**Canonical document. Mirrored across four sibling WebGPU/WGSL research
projects:**

- [`webgpu-q`](https://github.com/abgnydn/webgpu-q) — quantum chemistry
- [`webgpu-dna`](https://github.com/abgnydn/webgpu-dna) — radiation track-structure / radiobiology
- [`zero-tvm`](https://github.com/abgnydn/zero-tvm) — Phi-3 LLM inference (hand-written WGSL, head-to-head vs WebLLM)
- [`neuropulse`](https://github.com/abgnydn/neuropulse) — live 1:1 LLM forward-pass visualization (Phi-3, 3.8B params)

Edit any one and propagate. Project-specific examples in §§ 1, 6, 7, 8, 10
diverge per repo; sections 2–5, 9, 11–15 are universal.

This is the discipline that makes the work publishable in JOSS, citable
years later, and reproducible by reviewers on different hardware. The
patterns matured in different repos and back-port / forward-port between
them (research-grade artifact discipline first in `webgpu-dna`, the
"falsify before shipping" CPU pre-screen in `zero-tvm`, automated
doc-vs-code drift detection in `neuropulse`, full porting framework in
`webgpu-q`). Future siblings inherit the union.

**Umbrella thesis**: every advanced physics simulation in the world
should ship as a URL. The browser/WebGPU layer is what's novel; the
chemistry/physics/data is textbook. **Hand-write only the novel
layer; port everything with a peer-reviewed reference.**

---

## 1. Single source of truth for quantitative claims

All measured numbers for `webgpu-dna` live in **one** canonical section:

- `README.md` § Numbers — every G-value, every cross-section
  comparison, every SSB/DSB yield, every wall-clock cell.

Anywhere else (`CLAUDE.md`, `index.html`, slide decks, blog posts, hero
SVG, README headlines) may *summarize* numbers but never *introduce*
new ones.

**If a number isn't in § Numbers, it isn't measured.**

Before stating a measurement anywhere:

  protocol → run experiment → commit JSON artifact → add § Numbers row → quote

Not the other way around. Each row links to the JSON artifact via the
`[Eᵢ]` tag and is re-runnable via `npm run experiments -- <id>`.

---

## 2. Falsifiable JSON artifacts back every claim

Path: `experiments/results/YYYY-MM-DD/level-N/<id>.json`.

Shape (locked; don't add top-level keys without updating the runner):

```json
{
  "meta":     { "protocol": "...", "hypothesis": "...", "passBar": "...",
                "seed": "named-seed-id", "warmup": 5, "trials": 20 },
  "env":      { "gitSha": "...", "userAgent": "...", "adapter": {...},
                "limits": {...}, "timestamp": "2026-05-14T...",
                "shaderHashes": {"helpers_wgsl": "...", "primary_wgsl": "...",
                                 "secondary_wgsl": "...", "chemistry_wgsl": "..."} },
  "rows":     [ { /* per-cell measurements */ } ],
  "status":   "pass" | "fail" | "noisy" | "partial",
  "diagnosis": "first-failing-cell + smoking-gun explanation"
}
```

`npm run experiments -- <id>` re-runs deterministically. Same machine
+ same seed + same shader hash = bit-exact. fp32 `atomicAdd` on the
dose grid / `rad_buf` is NOT order-deterministic across GPU vendors —
same WGSL on different hardware (Apple Metal vs Nvidia Vulkan vs Intel
iGPU) yields statistically equivalent but not bit-exact results;
`shaderHashes` lets reviewers group rows correctly.

---

## 3. Status labels are first-class

- **`pass`** — meets the protocol's pass bar.
- **`fail`** — doesn't. Commit anyway with a `diagnosis` field naming
  the first failing cell and the smoking gun. **Never silently rerun
  until pass.**
- **`noisy`** — `std/median > 0.1` on any cell. Informational, not
  pass/fail.
- **`partial`** — some cells pass, others don't; explicit `N of M`
  count in the diagnosis.
- **`honest negative`** — failures that are evidence.
  `PHYSICS_DIAGNOSIS.md` cites the artifact and the rejected
  hypothesis.

Honest negatives become the project's evidence base. They are not
bugs to fix; they are findings.

---

## 4. Reproducibility (no randomness left to chance)

- `Math.random()` is **banned** in any experiment path. Every random
  draw uses a named seed from `experiments/lib/seeds.mjs` via
  `mulberry32(seed)`. WGSL random draws use the seed channel routed
  via uniform.
- Every JSON artifact records: git SHA (when available), full
  `navigator.userAgent`, `adapter.info`, WebGPU `limits`, UTC
  ISO8601 timestamp, **shader-file SHA-256 / git-rev-parse hashes**
  for `helpers_wgsl`, `primary_wgsl`, `secondary_wgsl`, `chemistry_wgsl`.
- 5 warmup samples are discarded; 20 trials retained.
- Report **median + p10/p90/p99 + std + IQR** — never single-shot.
- If `std/median > 0.1` on any cell → label the artifact `"noisy"`.

---

## 5. GPU timing requires a forced sync

`performance.now()` deltas around `queue.submit` alone are fiction —
WebGPU is asynchronous. **Mandatory pattern**: a mapped readback of a
tiny buffer before AND after the work. The `timedRun()` helper in
`experiments/lib/runner.mjs` does this correctly; use it.

---

## 6. Multi-level correctness verification

Match against more than one reference frame. Listed in increasing
sophistication / decreasing strength:

1. **Analytical / handbook limits**: ICRU 31 W-value for liquid water
   (~21.8 eV/ip), CSDA range scaling, equilibrium stopping power.
   Closed-form Smoluchowski for diffusion-limited reactions.
2. **Brute-force diagnostic on a small primary count**: deterministic
   N = 1 history dumps with the full event stream, hand-checked
   against expected ionization → secondary → chemistry chain.
3. **Peer-reviewed reference packages**: Geant4-DNA 11.4.1 with G4EMLOW
   8.8 as the bit-comparable upstream baseline (build runs the same
   `dnaphysics` macro on identical primary energy/geometry). Karamitros
   2011 IRT chemistry reactions and rate constants. Friedland 2011 /
   PARTRAC for cluster-damage statistics.
4. **Experiment**: NIST ESTAR for stopping powers, chem6 G-value
   spreads for OH/H₂/H₂O₂/e⁻aq at 1 μs, ICRU 16 SSB/DSB yields per
   keV, PARTRAC DSB/SSB ratios.

Multiple independent reference frames > one. Each artifact should
state which it's checking against in `meta.hypothesis`.

---

## 7. Port from references; hand-write only the novel layer

This is the architectural rule. The differentiator of `webgpu-dna` is
the WebGPU/WGSL/browser stack — not the physics formulas. So:

- **Hand-written and owned**: WGSL compute kernels (`helpers.wgsl`,
  `primary.wgsl`, `secondary.wgsl`, `chemistry.wgsl`), WebGPU dispatch
  glue, Web Worker IRT scheduling and event-driven Smoluchowski TDC
  loop, `rad_buf` reduction, SSB/DSB scoring kernel, the research-grade
  harness, the Geant4 native-runtime comparison harness.
- **Ported from peer-reviewed source with attribution**:
  - G4EMLOW cross-section tables (Born ionization, Emfietzoglou
    excitation, Sanche vibrational, Champion / screened-Rutherford
    elastic) — `public/cross_sections.wgsl` is generated from
    `data/g4emlow/dna/` by `tools/convert.py`.
  - Karamitros 2011 9-reaction IRT rate constants and Onsager
    correction.
  - Geant4-DNA angular CDFs for elastic scattering < 200 eV.
  - Dissociation branching ratios (0.65 / 0.55 / 0.80) from Geant4
    `G4DNAWaterDissociationDisplacer`.
  - Mean displacements (2.0 nm mother, species-specific products)
    and thermalization energies (e⁻aq at 1.7 eV) from Karamitros and
    G4 source.

**Per-file header** for ported code:

```
// Ported from <upstream> (<upstream-url>), <license> license.
// Source: <relative-path> at commit <SHA>
// Original authors: <upstream/AUTHORS>
// Adaptations for webgpu-dna:
//   - <substantive change 1>
//   - ...
// See LICENSE-<UPSTREAM> at repo root for the <license> notice.
```

**Repo-level**: `LICENSE-GEANT4` at root (verbatim from upstream).
Per-module status table belongs in a `MIGRATION.md` table:

| module | reference | license | status |
|---|---|---|---|
| `cross_sections.wgsl` (Born) | G4EMLOW 8.8 `G4DNABornIonisationModel*` | BSD-like | 🟢 |
| `chemistry.wgsl` IRT rates | Karamitros 2011 (Geant4 `G4DNAMolecularReactionTable`) | BSD-like | 🟢 |

License compatibility: MIT + Geant4 (BSD-like) work together — the
ported portion keeps its upstream license obligations (notice + state
changes); the rest of the repo stays MIT.

---

## 8. No fudge factors without a citation

Any tunable scalar in production code that isn't backed by a
peer-reviewed source is:

1. **Labeled empirical** in the code comment at point of use.
2. **Documented in `PHYSICS_DIAGNOSIS.md`** with the magnitude of the
   empirical correction and what observable it was tuned against.
3. **Queued for removal** once the structural fix lands.
4. **Tracked in `CHANGELOG.md` / commit messages** when added and
   when removed.

Examples carried at the time of writing:

- `SIGMA_EXC_SCALE = 0.5` in `src/shaders/helpers.wgsl` — empirical
  scale on the Emfietzoglou excitation cross-section. Improves
  chem6-matched G(H₂)/G(H₂O₂) agreement. Tuned against
  Frongillo/Hervé du Penhoat liquid-water reference G-values. Queued
  for replacement by a structural fix once cross-primary IRT lands.
- `RECOMB_BOOST = 2.0` in `helpers.wgsl` — geminate-recombination
  multiplier. **Publicly refuted as having no physical basis** after
  Geant4 source archaeology (E10c). Still kept because its removal
  re-opens the low-E CSDA deficit; documented as the worst of the
  empirical corrections. Queued for cross-primary IRT.

Tested-and-rejected hypotheses go into `PHYSICS_DIAGNOSIS.md` so
future sessions don't re-test them. Worth their own entry: every
candidate root cause that has already been falsified should appear
struck through with a link to the refutation artifact.

---

## 9. Shader byte-hashing for reproducibility

Every artifact records the SHA-256 (or `git rev-parse <gitSha>:<path>`
short hash) of each WGSL shader file the experiment depended on. Old
artifacts get retrofitted via `tools/retrofit-shader-hashes.mjs`. This
lets reviewers group rows by shader version when a tunable scale
(`SIGMA_EXC_SCALE`, `RECOMB_BOOST`, `SSB_R_DAMAGE_NM`, …) shifts the
baseline.

The `env` block carries `shaderHashes: { helpers_wgsl: "...",
primary_wgsl: "...", secondary_wgsl: "...", chemistry_wgsl: "..." }`.

---

## 10. Living open-gaps document

`PHYSICS_DIAGNOSIS.md` at repo root lists each open issue as:

```
## N. The <observable> deficit vs <reference> (<artifact>, <date>)

Observed.  <quantitative gap with σ-significance>

Hypothesis A — <candidate root cause>
Hypothesis B — <alternative>

Falsification experiment: <what would distinguish them>
```

Entries are removed when the underlying gap closes; the artifact
references stay in `CHANGELOG.md`. Tested-and-rejected hypotheses
get a strikethrough entry with the refutation artifact link, so the
same hypothesis isn't tried twice. Design docs for the two named
structural fixes — `H2OP_TRACKING_DESIGN.md` (refuted via Geant4
source archaeology) and `CROSS_PRIMARY_IRT_DESIGN.md` (waiting on
the headless native runtime) — are siblings to this document.

---

## 11. Honest self-corrections

When a prior claim turns out wrong, revise it **in the same commit
that surfaces the data**, with the full arc preserved. Examples:

- "G(e⁻aq) V-shape — was claimed as ~40σ without backing → 126σ via
  primary-bootstrap" (E10b). The V-shape narrative changed from
  "almost certainly real" to "real and quantified" in the same
  commit that added the bootstrap analysis.
- "`RECOMB_BOOST` is physically motivated" — refuted via Geant4
  source archaeology (E10c). The README claim was retracted in the
  same commit as the diagnosis. Kept in code because removal
  re-opens the low-E CSDA deficit; queued for cross-primary IRT.
- "`SIGMA_EXC_SCALE = 1.0` works" — false: chem6 G-values
  systematically high. Found via E10g, scale set to 0.5 in the
  same commit with the joint-fix artifact.

This is publication-grade transparency. **Wrong hypotheses become
part of the public scientific record, not an embarrassment to
hide.**

---

## 12. Citation infrastructure per release

Each minor release ships:

1. Git tag (`v0.X.Y`)
2. GitHub Release with notes drawn from `CHANGELOG.md`
3. **Zenodo DOI** minted via the GitHub-Zenodo integration
4. `CITATION.cff` `preferred-citation` block updated with the real
   DOI

Patch releases (doc-only, refactor, etc.) skip the Zenodo step.

---

## 13. WebGPU gotchas (carry forward across all projects)

- `initGPU()` MUST pass `requiredLimits` for
  `maxStorageBufferBindingSize` and `maxBufferSize`. The default
  128 MiB cap silently truncates large dispatches (chemistry-step
  buffers in particular cross this on N ≥ 16k primaries).
- `atomicAdd` works only on `u32` — not f32. Use fixed-point encoding
  for f32 reductions; `webgpu-dna` uses ×100 units/eV on the dose
  grid.
- No recursion in WGSL. All shaders are single-pass.
- Uniform buffers must be 16-byte aligned.
- No subgroup intrinsics in WebGPU 1.0 spec (out for now, in future
  revisions).

---

## 14. Test discipline (non-negotiable)

- TypeScript `strict` + `noUncheckedIndexedAccess`. No exceptions.
- ESLint clean — 0 errors. Warnings tracked, ideally 0.
- CI green. Every PR runs unit + e2e + typecheck + lint.
- Each method has paired test coverage by **intent**, not by metric:
  - **Analytical** (ICRU 31 W-value, CSDA scaling, Smoluchowski) where it exists.
  - **Peer-package** (Geant4-DNA 11.4.1 / G4EMLOW 8.8) on a fixed cell.
  - **Brute-force** N = 1 deterministic history dump where feasible.
- Honest negatives (status: "fail" tests) live alongside passes; they
  don't break CI but they're surfaced in the suite output.

---

## 15. Release cadence

- **Minor releases** (`v0.X.0`) for substantive features or
  scientific findings. Tag + GitHub Release + Zenodo DOI.
- **Patch releases** (`v0.X.Y`) for doc-only, refactor, SVG refresh,
  narrative updates. Tag + GitHub Release, no DOI.
- **CHANGELOG** follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  format: `### Added / Changed / Fixed / Documented / Honest negatives`.
- **CITATION.cff version** matches `package.json` version matches
  Git tag matches GitHub Release tag, all pinned per release.

---

## On adding a new sibling project

Inherit these 15 principles from day one. Copy this file verbatim into
the new repo. Replace project-specific references in sections 1, 6, 7,
8, 10 with the new project's analogs. Cross-link sibling projects in
the header.

The discipline is the product.

---

*Last revised: 2026-05-14. Canonical mirror of
[`webgpu-q/RESEARCH_STANDARDS.md`](https://github.com/abgnydn/webgpu-q/blob/main/RESEARCH_STANDARDS.md).
Edit either and propagate.*
