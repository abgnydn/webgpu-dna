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
- `R_CUT = 5 nm` is the existing distance cutoff in the IRT pair
  loop (line 535: `if (r2 > R_CUT2) continue;`)
- 3×3×3 neighbor scan with `cell_size = R_CUT` guarantees coverage
  of all pairs within `R_CUT × sqrt(3) ≈ 8.7 nm` worst-case, well
  beyond `R_CUT`. So 3×3×3 is sufficient.
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
