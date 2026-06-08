# Cross-primary IRT — design doc

Status: design only. Implementation deferred to a fresh session with
~2 hr multi-agent wall budget. This is the named structural fix from
[`ROADMAP.md`](./ROADMAP.md) Tier 1 (revised) after
[`H2OP_TRACKING_DESIGN.md`](./H2OP_TRACKING_DESIGN.md) refuted the
H₂O⁺-tracking hypothesis on 2026-05-13.

## What the fix does

Drop the `priMap` per-primary partitioning in `public/irt-worker.js`
(lines 459-473, 551). Run the IRT scheduler across **all primaries
in one chemistry pool**, exactly like Geant4 chem6 does. Inter-primary
reactions (H + H, eaq + eaq, OH + OH crossing primary track boundaries)
that we currently lose become reachable.

E10f at N = 128 primaries (`experiments/results/2026-05-12/level-4/
E10f-per-primary-partitioning.json`) already measured the impact:

| @ 1 μs                         | partitioned | no-partition | Δ    |
|--------------------------------|------------:|-------------:|-----:|
| G(OH)                          | 1.551       | 1.223        | -0.328 |
| G(eaq)                         | 1.415       | 0.874        | -0.541 |
| G(H)                           | 0.719       | 0.660        | -0.059 |
| G(H₂)                          | 0.461       | **0.610**    | **+0.149** |
| G(H₂O₂)                        | 0.607       | 0.620        | +0.013 |

That ΔG(H₂) = +0.149 closes **96 % of the 1 μs implementation gap**
(chem6 target = 0.622, current = 0.473, gap = 0.149).

The fix is therefore well-motivated empirically, but the naive
O(N²) cross-primary scan E10f used took **14 minutes for 128
primaries** (~166 K records). At 4096 primaries (~5 M records) it
would be `O(N²) = 25 T` operations — intractable.

The structural fix is therefore: **cross-primary IRT plus a
spatial-hash candidate lookup** so the algorithm becomes `O(N × c)`
where `c` is the bounded number of radicals per neighborhood cell.

## Algorithm

The existing IRT loop in `public/irt-worker.js` lines 482-732 has
this structure:

```
for each primary p in priMap:
  load p's radicals into px[], py[], pz[], species[], alive[]
  build initial pairs (O(n²) inside primary, n ≈ 1300)
  process heap until empty (handles diffusion sync + product
    creation, calls pairWithAlive(new_idx, ...) to rebuild pairs
    when a product is born)
  record per-primary contribution to checkpoint accumulators
```

The cross-primary version replaces the outer `for` loop with a
single global pool and uses a spatial hash for pair lookup:

```
load ALL primaries' radicals into one global pool:
  px[0..N-1], py[0..N-1], pz[0..N-1], species[0..N-1], alive[0..N-1]
build spatial hash:
  cell_size = R_CUT (5 nm, matches existing R_CUT2 = 25)
  hash[key(cx, cy, cz)] = Int32Array of radical indices in that cell

build initial pairs via spatial scan:
  for each radical i (~5M):
    cx, cy, cz = floor(px[i] / cell_size), ...
    for dx in [-1, 0, 1], dy in [-1, 0, 1], dz in [-1, 0, 1]:
      bucket = hash[key(cx+dx, cy+dy, cz+dz)]
      for j in bucket:
        if j <= i: continue   # avoid double-counting
        if !alive[j]: continue
        check rxnMap, compute t, push to heap

process heap until empty:
  on reaction firing: same as existing (handles products)
  on product creation:
    add new radical to spatial hash
    rebuild pairs for the new index via the 3×3×3 neighbor scan
      (NOT pairWithAlive's O(N) scan)
```

Cell size considerations:
- **⚠ CORRECTION (see Addendum, Option 5 verification):** `R_CUT` is
  **NOT 5 nm**. The actual value (line 364) is
  `R_CUT = 1.45 + 2·sqrt(8·9.46·1000) ≈ 551.65 nm`, `R_CUT2 ≈ 304317`.
  The "5 nm / R_CUT2 = 25" figure used throughout this algorithm section
  is a misreading and is refuted in the addendum. The spatial-hash
  `cell_size` must be 551 nm, not 5 nm — which changes the cell-occupancy
  and memory math below by ~110× per axis. Read the addendum before
  implementing any of this section.
- 3×3×3 neighbor scan with `cell_size = R_CUT` guarantees coverage
  of all pairs within `R_CUT × sqrt(3)` worst-case, well
  beyond `R_CUT`. So 3×3×3 is sufficient (this part holds for any cell
  size = R_CUT).
- Mean radicals per 5 nm³ cell at 10 keV: 5 M radicals / (27 fL =
  2.7e10 nm³ ÷ 125 nm³) = **~23 radicals/cell on average**. Local
  density at track cores could be 100-500/cell. Initial pair scan
  cost per radical: 27 cells × ~50 radicals = 1,350 pair checks
  on average. Total: **5 M × 1,350 = 6.75 B pair checks**, tractable
  in seconds in JS at typical throughput.

## File-level changes

`public/irt-worker.js`:

| Section | Lines (approx) | Change |
|---|---:|---|
| Phase 1 grouping | 453-473 | Remove `priMap`; replace with flat indices array. Keep `initH2` (per-primary H₂ count) since it's a counter, not a chemistry partition. |
| Phase 2 allocation | 482-492 | Allocate global pool sized `2 × rad_n + 512` (one big array, not per-primary). |
| Phase 3 outer loop | 548-732 | Drop `for (const [pid, indices] of priMap)`. Body becomes one global iteration. |
| Initial pair construction | 620-639 | Replace inner O(n²) scan with spatial-hash neighbor scan. |
| `pairWithAlive` | 511-546 | Already does the "rebuild pairs for one new radical" work — replace its O(N) scan with 3×3×3 neighbor scan. |
| Spatial hash | NEW | ~40 lines: `cellKey`, `addToHash`, `removeFromHash`, `getNeighbors`. |
| Checkpoint recording | 651-697 | Now needs to sum across all primaries in one pass, no per-primary accumulation. |
| Per-primary G(H₂) attribution | n/a | The `initH2.get(pid)` lookup at line 644 stays (initial H₂ markers from B1A1/DEA are per-primary). |

`src/chemistry/worker.ts` and `src/app.ts`: no changes — the worker
API stays identical.

Estimated diff: -100 lines, +200 lines.

## Validation chain

| Experiment | What | Pass bar |
|---|---|---|
| E10m (NEW) | re-run E10c-equivalent under cross-primary IRT at 10 keV | G(H₂)@1μs ≥ 0.95× chem6 (up from 0.78×); G(eaq) ≥ 0.85× (up from 0.81×) |
| E10f re-run (NEW v2) | confirm spatial-hash version matches E10f's no-partition result at 128 primaries | within 5 % of E10f's reported ΔG(H₂) = +0.149 |
| E5d under cross-primary | confirm CSDA at 8 ESTAR energies unchanged | 8/8 monotonic (CSDA is primary-phase, shouldn't shift) |
| E7b under cross-primary | confirm cascade ions unchanged | 344.6 ± 5 (cascade is primary-phase, shouldn't shift) |
| E13c under cross-primary | confirm L5 SSB closure preserved | ratio ∈ [2, 3] PARTRAC band |

The structural prediction: G-values at 1 μs improve substantially
(E10f basis), CSDA / cascade / SSB rows unchanged (those are
primary-phase metrics, not chemistry-phase). If anything moves in
the primary-phase rows, the spatial-hash implementation has a bug.

## Performance budget

Expected wall time @ N = 4096 primaries × 10 keV:

- Per-primary IRT (current): 139 s (measured in E13c log)
- Cross-primary O(N²) (naive, E10f): 14 min @ 128 primaries → extrapolates
  to ~3.7 hr @ 4096 (intractable)
- Cross-primary O(N · c) with spatial hash (target): ~150-300 s
  (similar to current; the 3×3×3 scan replaces the per-primary inner
  loop with similar total work but better locality)

If the spatial-hash implementation takes > 10 minutes, profile
before merging. The cell-size and product-rebuild paths are the
likely hot spots.

## Memory constraint (browser ceiling)

This is the implementation complexity that wasn't obvious before
drafting the per-primary → global refactor.

Current per-primary worker: `CAP = maxN * 2 + 512 ≈ 3112` per primary.
Heap capacity `CAP * 8 ≈ 25 k` entries, used for one primary at a
time. Total memory per primary loop iteration: ~10 MB (px/py/pz +
species + alive + gen + tbirth + heap), reused 4096 times.

Cross-primary global pool would need:
- `CAP = 2 × rad_n + 512 ≈ 10 M` slots (each Float64/Int32 array
  alone = 40-80 MB; total static allocation across 7 typed arrays ≈
  **~400 MB**, near the browser tab memory ceiling)
- Heap size: initial pairs after R_CUT prune ≈ 50 M entries × ~20
  bytes packed = **~1 GB just for the heap** (well over browser
  ceiling at ~1.5-2 GB tab limit)

Naïve cross-primary IRT therefore **cannot run end-to-end in a
browser tab at N = 4096**.

Mitigations (pick one, each is its own design choice):

1. **Spatial chunking.** Process the simulation in 3D sub-volumes
   (e.g., 6 × 6 × 6 = 216 chunks of 5 μm cubes). Each chunk holds
   the radicals inside it + a "halo" extending R_CUT into neighbors.
   Run IRT per chunk; merge results. Trades determinism (chunk
   boundaries break some reactions) for tractability. Tradeoff
   needs an experimental gate.
2. **Streaming heap.** Don't materialize all initial pairs; instead,
   emit pairs lazily during the time-stepping, scanning the spatial
   hash for the next-event candidate as needed. Replaces the priority
   queue with a per-cell event horizon. Different algorithm, closer
   to G4DNAIRT's actual implementation.
3. **Run in `webgpu-dna-native`** (`ROADMAP.md` Tier 3). Drop the
   browser memory ceiling entirely. The same WGSL shaders + worker
   code run in Node/Deno with `wgpu-native`; heap memory becomes a
   host-OS concern, not a browser tab concern. This unblocks the
   naïve cross-primary IRT as a 30-minute drop-in.
4. **Subsample test only.** Don't run cross-primary at full N. Use
   N = 128 (E10f-style) as the validation, and ship the per-primary
   version as the production path with a documented "this is a known
   ~20 % chemistry deficit at 1 μs because we partition for memory
   reasons" caveat.

Option 3 (native runtime) is by far the cleanest and aligns with the
broader Tier 3 / swarm work. The HPC discussion ([commit chain w/
WebRTC swarm and headless wgpu]) already had this as a separate
trajectory; cross-primary IRT becomes one of the first concrete
demonstrations of why the native runtime is worth building.

**Recommended sequence:**

1. Build `webgpu-dna-native` minimal runner (~2-3 hr per ROADMAP
   Tier 3) — Node + `wgpu-native` wrapping the existing WGSL +
   the irt-worker.js shimmed through Dawn or a Node Worker.
2. THEN run the naïve cross-primary IRT in that runtime (no spatial
   hash needed — RAM is cheap on a workstation).
3. Validate: measure E10m, E5d, E7b, E13c under the cross-primary
   variant.
4. If validation passes, decide whether to build the spatial-hash
   browser-tractable version, or document the browser path's
   chemistry-deficit caveat and direct power users to the native
   runner.

This is a different sequencing than the original `H2OP_TRACKING_DESIGN`
ordering implied, but it's the structurally honest one once the
memory ceiling is recognized.

## Anti-patterns

Same as `H2OP_TRACKING_DESIGN.md` — do not ship a "fix" that
silently re-baselines existing artifacts or that's slower than the
current per-primary version. The validation chain above is the
gate.

## Estimated effort

Multi-agent wall time:

- ~1 hr engineering wall (3 parallel agents: spatial-hash module,
  worker-loop refactor, validation harness scaffolding)
- ~5 min Playwright validation runs
- ~10 min for hot-spot profiling + fixup if needed

Total: ~1.5-2 hours wall. The complexity is real (spatial hash on
5M elements with dynamic product addition is tricky to get right)
but the algorithm is well-defined.

## What unlocks this work

The E10f artifact (`experiments/results/2026-05-12/level-4/
E10f-per-primary-partitioning.json`) is the falsifiable evidence
that this fix WILL close 96 % of the 1 μs chem6 gap. The H₂O⁺
tracking refutation (`H2OP_TRACKING_DESIGN.md`) confirms it's the
only remaining structural lever. The `RECOMB_BOOST = 2.0` fudge
can drop to 1.0 after this lands.

That's a clean research-grade publication arc:
1. Joint-fix v1 (current) closes 30 % → 19 % RMS dev vs chem6, but
   surfaces an unexplained `RECOMB_BOOST` knob.
2. Source archaeology refutes the time-integrated recomb hypothesis.
3. Cross-primary IRT (this fix) closes most of the residual gap
   without any fudge factor.
4. `RECOMB_BOOST` removed; the chemistry side of the validation
   chain becomes physics-grounded instead of empirically-tuned.

The narrative is "we found the structural cause, validated it twice
(once via the synthetic E10f experiment, once via the cross-primary
production refactor), and removed the fudge factor."

---

# Addendum — Option 5 (swarm spatial decomposition): verification + verdict

Added 2026-06-01. A proposed 5th mitigation: distribute the cross-primary
IRT across multiple browser tabs via spatial domain decomposition, reusing
the SAB multi-tab swarm infrastructure proven in `~/webgpu-q`
(`src/parallel/swarm/*`). The hypothesis: Option 1 "spatial chunking" *is*
the swarm, and if every pair is truncated at a small `R_CUT`, a halo of
that width makes chunking ~lossless relative to the approximation the code
already makes — a clean browser-native unblock instead of going native.

That hypothesis rested on three claims. I verified all three against the
actual `public/irt-worker.js`. **Two of the three fail, and a fourth
geometry fact (point-source seeding) independently defeats the load-balance
premise.** The honest verdict is at the bottom: **for the validation
geometry, the swarm does not cleanly unblock this — Option 3 (native) or a
WASM-memory build is the better path.** Details below so the reasoning is
falsifiable.

## Verification of the three load-bearing claims

### Claim 1 — "every pair truncates at R_CUT = 5 nm (R_CUT2 = 25)" → **REFUTED**

The cutoff is **551.65 nm**, not 5 nm:

```js
// irt-worker.js:363-365
const R_CUT = 1.45 + 2 * Math.sqrt(8 * 9.46 * 1000); // ≈ 551.65 nm
const R_CUT2 = R_CUT * R_CUT;                          // ≈ 304317 nm²
```

This is the Geant4 `G4DNAIRT` cutoff formula `1.45 + 2·sqrt(8·D_max·t_max)`
with `D_max = 9.46 nm²/ns` (H₃O⁺, the fastest species) and
`t_max = 1000 ns`. It is, by construction, the maximum distance the
fastest-diffusing pair could close over the full 1 µs window and still
react. The "5 nm" figure was a misreading carried into this doc's own
Algorithm section (now flagged inline). **A lossless halo is 551 nm wide,
not 5 nm — 110× larger per axis.**

### Claim 2 — "candidate-pair set is R_CUT-bounded (no longer-range reactions)" → **CONFIRMED, but at 551 nm**

This is the good news, with the right number. The pair set genuinely *is*
bounded: every pair-forming site applies the same `r2 > R_CUT2` gate —
initial pairs (line 634) and product re-pairing in `pairWithAlive`
(line 535). Nothing in the code can pair two radicals separated by more
than 551 nm. The 551 nm value already folds in the full 1 µs diffusion
broadening (that's *why* the formula uses `t_max`), so there is no
"late-time diffusion lets them react farther" escape hatch — that physics
is baked into the 551 nm number.

**Consequence:** a halo of **551 nm** captures every *initial* pair the
single-pool code would ever evaluate. For initial pairs, chunking with a
551 nm halo is exactly as lossless as the production code already is — it
inherits the code's own approximation rather than adding a new one. The
user's structural instinct ("halo = R_CUT ⇒ lossless for initial pairs")
is correct; only the magnitude was wrong.

### Claim 3 — "product radicals born mid-sim near a boundary" → **this is the genuine lossiness**

`pairWithAlive(idx, n_total, t_new)` (lines 511-546) is called every time a
product is created (line 733). It scans **all** currently-alive radicals,
diffuses each existing partner forward by `dt = t_new − tbirth[jj]` to
synchronise Brownian clocks (lines 524-531), then applies the same 551 nm
gate. Products are first-class reactants and can pair with anything alive
within 551 nm *at their birth time*.

A static `t = 0` halo does **not** carry products created during the 1 µs
evolution. A product born in chunk A's interior, within 551 nm of the A/B
boundary, is invisible to chunk B's pool. So chunking is **lossy for
products** unless products born within 551 nm of a boundary are injected
into the neighbour's live pool with their birth time and generation, and
the neighbour's heap is re-opened.

And that exchange is *not* a clean per-checkpoint barrier, because IRT is
**event-driven, not time-stepped**. A product created at t = 5 ns in chunk
A may react with a chunk-B radical at t = 6 ns — but chunk B, running its
own priority queue independently, may already have processed events past
t = 6 ns. To stay correct each chunk could only process events up to a
global `t_safe`, then barrier-exchange boundary products, then advance.
That conservative event-horizon barrier serialises the chunks and
reintroduces most of the coordination cost — and it is, almost exactly,
the doc's **Option 2 (streaming heap / per-cell event horizon)** wearing a
swarm hat. It is not "reuse the existing swarm"; it is a different
algorithm.

## The decisive fourth fact — point-source seeding defeats load balance

Even setting products aside, spatial decomposition only reduces *peak*
per-tab memory if radicals are spread across the volume. They are not, in
the validation geometry:

```js
// src/gpu/dispatch.ts:33
pf[8] = 0.0;           // start_half (0 = origin)
```

With `start_half = 0` every primary launches from the **origin** with an
isotropic direction (primary.wgsl:121-138). All 4096 tracks radiate from a
single point; radicals form one ~5 µm-diameter blob whose density is
**peaked at the origin** and falls off outward. Two failures follow:

1. **The dense chunk still needs the full heap.** The heap (~1 GB, the
   binding memory constraint) scales with local pair density, which scales
   with local radical density². Whatever chunk owns the origin core carries
   the overwhelming majority of pairs. Splitting space does not shrink that
   chunk's heap — so peak per-tab memory barely drops. The swarm splits the
   *cheap* periphery and leaves the *expensive* core in one tab.

2. **The halo is worst exactly where density is worst.** To subdivide a
   ~5 µm blob you need chunks of order ~1–2.5 µm. A 551 nm halo on a 2 µm
   chunk is ~28%/axis ⇒ the halo more than doubles the chunk's volume
   (`(2+1.1)³/2³ ≈ 3.7×`). And in a 2×2×2 octant split the origin core
   sits at the **corner junction where all 8 chunks meet**, so the densest
   radicals land in 7 neighbours' halos simultaneously — maximal
   duplication precisely at the memory hot-spot.

For a **bulk-dose geometry** (`start_half > 0`, the "unbiased bulk-dose
yield" path noted in primary.wgsl:121) the picture flips: radicals spread
roughly uniformly, chunks of several µm balance well, and a 551 nm halo on
multi-µm chunks is a modest (~10–20%) overhead. **Spatial decomposition is
sound there.** But the cross-primary fix is motivated by, and validated
against (E10c/E10f/E5d/E13c), the **point-source** snapshot — and that is
the regime where the swarm does not help.

## Option 5 — swarm spatial decomposition (documented, NOT recommended for the validation geometry)

For completeness and for the bulk-geometry case where it *does* apply, the
scheme would be:

- **Partition.** Decompose the occupied volume into a 3D grid of sub-volumes.
  For balanced load under a point source you'd need a non-uniform
  (octree/k-d) split that puts small cells at the dense core — but see the
  halo objection above, which a non-uniform split makes *worse*, not better.
- **Halo width = 551 nm** (R_CUT), not 5 nm. Each chunk's pool = its owned
  radicals + every radical within 551 nm of its boundary (read-only halo).
- **Canonical owner rule (no double-count).** A pair (i, j) spanning a
  boundary is seen by both chunks. Fire it in exactly one: the chunk owning
  `min(globalIdx(i), globalIdx(j))`, equivalently the chunk owning the
  reactant whose owned-cell index is canonically lower. Halo-only reactants
  never *originate* a firing; they only complete a pair owned elsewhere.
  This matches the existing `aa = min(i,j), bb = max(i,j)` heap convention
  (lines 541, 670).
- **Product propagation.** A product born within 551 nm of any boundary
  must be published to the neighbour pool(s) with `{x,y,z, species, gen,
  tbirth}`, and the neighbour must `pairWithAlive` it against its live set
  at the product's birth time — gated by the event-horizon barrier in
  Claim 3. This is the hard part and the source of residual error if
  skipped.
- **Transport = SAB, not BroadcastChannel.** The user is right that
  structured-clone over BroadcastChannel is too slow for per-step boundary
  swaps; a `SharedArrayBuffer` ring per boundary face (same pattern as
  webgpu-q's `swarm-sab` MVP) is the correct transport. But transport is
  not the bottleneck — the **event-ordering barrier** is. SAB makes the
  bytes move fast; it does not make the IRT event order correct.
- **Memory math (bulk geometry, 30 µm box).** Non-overlapping per-tab pool
  for the heap-dominated ~1.4 GB total: 4 tabs ⇒ ~350 MB owned + halo. A
  551 nm halo on 15 µm (2×2×2) chunks adds ~11%/axis ⇒ ~1.37× volume ⇒
  ~480 MB/tab — fits. 8 tabs (2×2×2 with finer cells or 2×2×1×… ) ⇒
  ~240 MB owned, ~1.5× halo ⇒ ~360 MB/tab. **These numbers only hold for
  spread sources.** For the point-source validation snapshot the origin
  chunk approaches the full ~1.4 GB regardless of tab count — so the
  per-tab budget does **not** fall below the browser ceiling, which is the
  whole reason the swarm was proposed.
- **Validation chain.** Reuse the doc's existing gates: E10m (G(H₂)@1µs ≥
  0.95× chem6), E10f-v2 (match the no-partition ΔG(H₂) = +0.149 within 5%),
  and confirm primary-phase rows do **not** move (E5d 8/8 monotonic, E7b
  cascade 344.6 ± 5, E13c SSB ratio ∈ [2,3]). **Additional gate required
  for Option 5 specifically:** a single-tab single-pool reference run
  (native or WASM-memory, see below) at reduced N, compared against the
  N-tab chunked run — the chunked G-values must match the single-pool
  reference within MC noise. If they do not, the boundary-product handling
  is lossy and the error must be quantified and reported, not shipped.

**Expected error if products are NOT exchanged (static t=0 halo only):**
not yet measured. The fraction of reactions involving a product (rxn 7's
OH, rxn 1/4/7's OH⁻ as further reactant via rxn 8, etc.) that occur within
551 nm of a chunk boundary is the upper bound on the dropped-reaction rate.
This *must* be measured with an E10f-style synthetic experiment before any
static-halo version ships — per the doc's own anti-pattern rule, a silent
chemistry approximation is not acceptable. My estimate is that it is small
for products of slow species but non-trivial for OH/OH⁻ in the dense core,
exactly where cross-primary effects matter most — so I expect it to be
material, but that is a hypothesis to test, not a measured fact.

## WASM fits a different axis — and may be the real browser-native unblock

Keep the two tools separate:

- **Swarm = memory** (and, per above, only for spread sources).
- **WASM = speed.** The inner loop — `sampleIRT` / `sampleIRT_type0/1`,
  `erfcx`, `SamplePDC`, and the pair scan — is tight scalar `Float64` math
  with no allocation, the same profile as webgpu-q's `wasm-eri` kernels.
  A WASM (and eventually SIMD) port targets the **139 s per-primary wall**
  and the **194 s end-to-end CPU-IRT ceiling** (the E15b bottleneck that
  pins end-to-end speedup at 1.48× despite 455× tracking). It does not, by
  itself, change the algorithm or the pair count.

But there is a **memory** consequence of WASM worth flagging separately,
because it may unblock cross-primary IRT in a *single* tab without any
chunking approximation:

- The heap is already `Float64Array`/`Int32Array` (ArrayBuffer-backed), not
  GC objects — see `MinHeap` (lines 289-346). So the ~1.4 GB lives in
  ArrayBuffers today, not the JS object heap.
- WASM linear memory (wasm32) can grow to ~4 GB in one `ArrayBuffer`;
  `memory64` lifts it further. Allocating the global pool + heap inside one
  WASM linear memory sidesteps the per-`ArrayBuffer` and GC-heap pressures
  the doc cites as the "~1.5–2 GB tab ceiling."
- **Therefore the doc's flat claim "naïve cross-primary IRT cannot run
  end-to-end in a browser tab at N = 4096" is itself untested and may be
  too pessimistic.** Before building either the swarm *or* the native
  runtime, the cheapest experiment is: in a worker, attempt to allocate the
  full-size arrays (~1.4 GB across the typed arrays) and a single-pool
  run at reduced N, and see whether Chrome OOMs. If it does not, the
  single-pool browser path is viable as-is (slow but correct), and WASM
  then makes it fast — no chunking, no native runtime, no approximation.

## Measured feasibility (E10k, 2026-06-01) — the walls are real and the escape hatch is refuted

Two Node-side measurements over the real `dumps/rad_E10000_N4096.bin`
(4.89M reactive radicals, displaced per the worker's Phase-3 logic).
Artifacts: `experiments/results/2026-06-01/level-4/E10k-stageA.json`,
`E10k-stageB.json`. Reproduce:
`node experiments/level-4-chemistry/E10k-crossprimary-memory-feasibility.mjs`
and `…/E10k-stageB-effective-radius.mjs`.

**Stage A — cell occupancy & scan cost (the spatial hash does not prune):**

| Quantity | Doc assumed | **Measured (551 nm)** |
|---|---|---|
| radicals / cell | ~23–50 | **mean 13,780; core 294,484** |
| occupied 551 nm cells | (implied many) | **355** (blob is ~9 cells across) |
| 3×3×3 scan pair-checks | 6.75e9 ("seconds") | **5.11e12 (758×)** |

The blob spans only ~9 cells per axis at 551 nm, so the hash is just
~2.4× better than naive O(N²) (1.2e13). The "tractable in seconds" claim
was entirely the 5 nm artifact.

**Stage B — effective reaction radius (the 551 nm horizon is irreducible):**

Sampled 400 source radicals, scanned their full 551 nm neighborhoods
(1.72e8 reactive-pair `sampleIRT` calls), histogrammed accepted reactions
by separation:

| ≤ nm | accept-rate/pair | cumulative % of accepted reactions |
|---:|---:|---:|
| 5 | 9.9% | 4.97% |
| 20 | 2.0% | 12.97% |
| 50 | 0.73% | 25.63% |
| 100 | 0.23% | **47.78%** |
| 200 | 0.049% | **82.55%** |
| 551 | 0.001% | 100% |

**R(99.9%) = 551.65 nm.** Any individual distant pair almost never reacts,
but there are ~1.6e8 of them per source in the outer shell, so they
*collectively* dominate: **>50% of cross-primary reactions come from pairs
farther apart than 100 nm.** This is not noise — it is exactly the
inter-track coupling cross-primary IRT exists to capture (and the same
behavior G4DNAIRT/chem6 exhibit; E10f confirmed it gives the right
G-values). **There is no small-cutoff approximation that is lossless** —
the escape hatch that would have rescued the hash and the swarm is refuted.

**Implied full-run cost** (extrapolating the measured rate): ~1.05e12
`sampleIRT` calls and ~80M heap entries.
- **Compute:** at the measured 4.1e6 calls/s in JS → **~71 hours single-thread
  in-browser.** This — not memory — is the dominant wall.
- **Memory:** ~80M heap entries × 24 B ≈ **1.9 GB heap + ~0.43 GB pool ≈
  2.3 GB** (the doc's ~1.4 GB was the right order; ~2 GB is closer). Over a
  comfortable browser-tab budget, but secondary to the compute wall.

## Verdict

**Does the R_CUT-halo losslessness claim hold? No — and the test surfaced a
bigger problem than memory: compute.**

The original reasoning (initial-pair losslessness at a small halo) is
refuted twice over: the halo is 551 nm not 5 nm (Claim 1), and **E10k stage
B shows >50% of accepted reactions genuinely come from >100 nm pairs**, so
even a 100–200 nm halo would silently drop a large fraction of exactly the
inter-track reactions the fix targets. The 551 nm horizon is irreducible
for a point source.

Therefore:
- **Swarm (Option 5) and in-tab spatial hash (Option 1): dead for this
  geometry.** The reaction horizon spans the whole ~5 µm blob, so there is
  nothing to prune (stage A: hash = 2.4× over naive) and no halo small
  enough to save memory is lossless (stage B). Confirmed by measurement,
  not just argued.
- **The dominant wall is compute (~71 hr single-thread JS), not memory
  (~2.3 GB).** A WASM-memory single-tab build (my earlier suggestion)
  addresses memory but leaves a ~7 hr single-thread WASM compute wall — not
  viable without WASM threads.
- **Option 3 (native runtime) is the right call — for a stronger reason
  than the doc gave.** It is not just that RAM is cheap off-browser; it is
  that you need *multiple cores* to bring 1e12 `sampleIRT` calls down to a
  tolerable wall (~1 hr on 8 threads). Native unlocks both axes; the browser
  unlocks neither.
- **The genuinely tractable alternative is algorithmic, not infrastructural:
  Option 2 (streaming heap / per-cell event horizon) — i.e. G4DNAIRT's
  actual design — never materializes the 1e12 candidate pairs.** If a
  browser-native path is wanted, this is the only one that survives the
  E10k numbers, and it is a from-scratch reimplementation, not a refactor.

Old verdict text (reasoning-only, now superseded by the E10k measurement)
retained below for provenance:

- For **initial pairs**: yes, lossless — but with a **551 nm** halo, not
  5 nm (Claim 1 refuted, Claim 2 confirmed at the corrected magnitude).
- For **products**: no — a static halo is lossy, and the correct fix is an
  event-horizon barrier that is Option 2 in disguise, not a reuse of the
  existing swarm (Claim 3).
- For the **validation geometry**: the point-source seeding
  (`start_half = 0`) means the dense origin chunk still needs ~the full
  heap and the 551 nm halo duplicates the densest radicals across 7
  neighbours — so peak per-tab memory does **not** drop below the browser
  ceiling, which was the entire point.

So this is **not** the clean browser-native unblock hoped for. The swarm is
a real tool, but for the *bulk-dose* geometry, not the point-source
validation snapshot the fix targets.

**Recommended sequencing (revised):**

1. **Cheap test first** — does the single-pool naïve run actually OOM in a
   browser worker at full N? (The data is already ArrayBuffer-backed; the
   doc's "can't fit" claim is unverified.) ~30 min.
2. If it fits → ship single-pool cross-primary IRT in-browser (correct,
   slow), then **WASM-port the inner loop for speed**. No chunking, no
   approximation. This is the cleanest path and also attacks the 194 s
   end-to-end ceiling.
3. If it OOMs → **Option 3 (native runtime)** remains the cleanest path to
   the *exact* single-pool result, since RAM is a host concern off-browser.
   A WASM build with `memory64` is a third contender that keeps it
   browser-native.
4. **Option 5 (swarm)** is reserved for the bulk-dose geometry, and only
   after an E10f-style synthetic experiment measures the
   boundary-product-loss rate and confirms it is within the validation
   bars. Do not ship a static-halo chunking without that measurement.


## RESOLVED 2026-06-08 (E17) — cross-primary is a coupled tradeoff, not a clean fix

Built and ran (enabled by the native runtime; `tools/run_irt_xprimary.cjs`,
global pool via pid=0 in the production worker). It reproduces E10f's
dG(H2)=+0.129 @128 primaries (E10f +0.149) — but a density sweep (K=16->128)
shows dH2 up and dOH/eaq down are **monotonically coupled** (~3 OH lost per H2):

| K | dH2 | dOH | deaq |
|---|----|-----|------|
| 16 | +0.012 | -0.081 | -0.077 |
| 32 | +0.050 | -0.131 | -0.208 |
| 64 | +0.083 | -0.229 | -0.372 |
| 128 | +0.129 | -0.367 | -0.537 |

**No density matches chem6** (high H2 AND high OH). This corrects E10f, which
pinned per-primary partitioning as "96% of the 1 us gap" by looking at **H2
only** — fixing H2 via cross-primary *breaks* OH/eaq. So the chem6 gap is NOT a
partitioning artifact; chem6's high-H2-and-high-OH must come from a
reaction/diffusion-physics difference (rate constants, radii, initial spatial
distribution) — the real open question. Production keeps per-primary IRT.
