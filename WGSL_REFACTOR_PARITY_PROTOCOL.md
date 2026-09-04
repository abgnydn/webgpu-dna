# WGSL Refactor Parity Protocol (R2)

Status: **Phase 1 (harness) — this PR. No shader changed.**

## Goal

Make WGSL deduplication safe by giving every future shader refactor a
mechanical pass/fail gate: run the *production* Phase A+B pipeline twice at
small N with a fixed seed — once before, once after the refactor — and
require bit-level parity on everything the GPU writes.

## Non-goals

- No physics re-validation (this is not L1–L6; it proves *sameness*, not
  *correctness*).
- No CI gating yet (SwiftShader + ~1.5 GB fixed buffers are too heavy for
  default runners; see Open risks).
- No shader edits in Phase 1.

## Background: what is duplicated (all verified in-tree)

Assembly order is `cross_sections + helpers + kernel` for both shaders
(`src/shaders/loader.ts:21-28`), so anything in `helpers.wgsl` is visible
to both — yet the pure helpers were copy-pasted instead:

| Function | primary.wgsl | secondary.wgsl | Uniform reads | RNG draws |
|---|---|---|---|---|
| `deposit(px,py,pz,dep_eV,box,vc)` | 109–119 | 36–46 (comment at 33–35 admits the dup) | none (box/vc are explicit params) | none |
| `meesungnoen_sigma(k)` | 97–105 | 23–31 | none | none |
| `dna_near` / `dna_near_sec` | 48–93 (`p.*`) | 48–86 (`sp.*`) | yes (`p.P` struct 1–7 vs `sp.SP` struct 1–5) | none |

The 7× H₂O⁺ recombination-branch copies are rank 1 by size but need their
own protocol (they interleave `rf()` draws; extraction must preserve draw
order — safe in principle since each block is self-contained, but the proof
is stricter). Phase 2 starts with `deposit` + `meesungnoen_sigma` only.

## Determinism analysis (MEASURED 2026-09-04 on apple/metal-3 — was REASONED)

- `seedPrimaryRNG(np, floor(E))` (`src/gpu/buffers.ts:116-129`) is pure
  SplitMix: identical seeds ⇒ identical per-thread RNG streams.
- u32 atomics (`counters[*]`, dose voxels in ×100 fixed-point,
  `secStats`) are order-independent: counts and per-voxel sums commute.
  ⇒ counters, dose grid, secStats exactly reproducible (MEASURED:
  `counters=[8759,7810,888,7700,0,306,4170,25758]`,
  `doseHash=25256e84` identical across runs).
- `results[idx]` is written by its own thread only ⇒ exact (MEASURED:
  `mean_ions`/`mean_total` identical).
- `rad_buf` / `rad_e` / `rad_dep` row *order* depends on `atomicAdd`
  slot-claim order, which scheduling may vary ⇒ compared as **multisets**
  (sorted rows, then hashed — MEASURED: `radHash=81c43d00` identical).
- All CPU-side aggregates in `runAtEnergy` (`src/gpu/dispatch.ts:238-265`)
  iterate in index order ⇒ exact (MEASURED).

## Phase 1 baseline (MEASURED 2026-09-04, unmodified shaders)

`node experiments/tools/wgsl-parity.mjs --hardware`,
`{np:16, energyEv:10000, boxNm:15000, ceEV:7.4}`, apple/metal-3:
run 1 wall 1.42 s (rig setup + run), run 2 wall 0.096 s (run only),
`n_therm=16 rad_n=25758 sec_n=2235`, all 21 compared fields +
counters + adapter identical ⇒ **PASS, exit 0**. Digests archived at
`/tmp/wgsl-parity-run{1,2}.json` (gate output, not experiment artifacts).

## Harness design

- `window.runParitySnapshot({np, energyEv, boxNm, ceEV})` (`src/bench.ts`):
  reuses the cached rig, calls production `runAtEnergy` with `dna=null`
  and no chemistry callback at `E=10000` (dose grid is only returned at
  10 keV, `dispatch.ts:355`; chemistry is skipped without a callback,
  `dispatch.ts:311`), then re-reads `counters[0..7]` and returns a
  JSON-safe digest (counters exact, dose exact fnv1a + sum, rad buffers
  order-insensitive hashes, CPU scalars).
- `experiments/tools/wgsl-parity.mjs`: dev-server (`lib/dev-server.mjs`)
  + Chromium with the smoke-test software flags
  (`webgpu-smoke.mjs:50-57`) + `bench.html`, calls the snapshot twice at
  `{np:16, energyEv:10000, boxNm:15000, ceEV:7.4}` in the same page
  (`runAtEnergy` zeroes all state on entry, `dispatch.ts:99-102`, so runs
  are independent), compares field-by-field.
- Exit codes: `0` PASS (all fields equal), `1` FAIL (any mismatch, with
  per-field report), `2` environment-incapable (no WebGPU, OOM, init
  failure — with adapter limits dumped).

## Pass bars (Phase 1)

- Double-run on UNMODIFIED shaders: PASS, both digests identical.
  (MET 2026-09-04 — see baseline above.)
- Wall time recorded but not gated.

## Phase 2 plan (separate PR, not this one)

1. Move `deposit` + `meesungnoen_sigma` verbatim into `helpers.wgsl`,
   delete both copies.
2. Harness must stay PASS (it executes both functions via Phase A+B:
   `deposit` on every energy deposit, `meesungnoen_sigma` on every
   sub-cutoff/autoionization thermalization).
3. Record new `env.shaderHashes` + artifact row per `EXTENDING.md`
   (shader bytes changed ⇒ new hashes, even though behavior is proven
   identical — the ledger must show it, not trust it).

## Open risks

- **SwiftShader CANNOT run production dispatches (MEASURED 2026-09-04).**
  The harness bisected it precisely: rig setup succeeds (device created,
  ~1.5 GB buffers allocated, all 3 shaders compile), then `device.lost`
  (`reason=unknown`) fires during the first Phase A submit — before even
  the Phase A sync returns. Compile ✓, trivial 16-byte kernels ✓ (smoke),
  production dispatch ✗. The failure is fast and deterministic, not a
  hang. Consequence: software WebGPU is exit-2-incapable for this gate
  (the driver says so and dumps pre-flight limits), CI can never execute
  production physics (validating the README "smoke, not validation"
  stance with a measurement), and the gate runs on hardware Metal via
  `node experiments/tools/wgsl-parity.mjs --hardware` (E15 flag set).
- **~1.5 GB fixed buffers regardless of np** (`buffers.ts:53-98`:
  256+256+64+64+256+256 MB radical buffers, 240 MB secBuf, 8+8 MB dose,
  ~352 MB chemistry): allocation — not compute — was the suspected
  dominant cost on SwiftShader, but the device loss happened at submit,
  so this stays ASSUMED for software and unmeasured for hardware
  (wall-time split recorded per run).
- **`initGPU` requests adapter-max limits** (`device.ts:27-34`); if
  SwiftShader reports < 256 MB binding size, allocation fails ⇒ exit 2
  path (ASSUMED capable — SwiftShader on this box is MEASURED working
  by `npm run webgpu-smoke`, but smoke only allocates 16-byte buffers).
- **Same-page rig reuse** between the two runs: state reset is by
  `runAtEnergy`'s zeroing (MEASURED in code, behavior confirmed by the
  double-run itself).
