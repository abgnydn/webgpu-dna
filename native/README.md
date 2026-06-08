# webgpu-dna-native (foundation)

The headless native runtime from the [ROADMAP](../ROADMAP.md) Tier 3 — Node/Deno
+ `wgpu-native` wrapping the existing WGSL, removing the browser-tab memory
ceiling. Its first marquee payoff is **cross-primary (inter-track) IRT
chemistry**, which E10f measured as 96% of the residual 1 µs chem6 gap but which
needs ~1 GB of heap that exceeds a browser tab (see
[`CROSS_PRIMARY_IRT_DESIGN.md`](../CROSS_PRIMARY_IRT_DESIGN.md)).

## ✅ Phase A+B — WORKING & VALIDATED 2026-06-08

`run-phase-a.ts` runs the full primary+secondary track-structure physics
natively in Deno (no browser) and reproduces the browser harness **bit-for-bit**:

```
$ deno run --unstable-webgpu --allow-read --allow-env native/run-phase-a.ts 10000 4096
[init] GPU initialized: Apple M2 Pro
{"E_eV":10000,"np":4096,"wall_ms":654,"rad_n":5279842,"mean_total_csda_nm":2733.3,
 "ions_per_pri":195.4,"sec_per_pri":144.1,"E_cons":0.9995}
```

`rad_n = 5,279,842` is **identical** to the production browser dump
(deterministic RNG seed → identical trajectories); CSDA, ions/pri, sec/pri, and
E-conservation all match. It reuses `device.ts` / `buffers.ts` / `dispatch.ts`
(`runAtEnergy`) verbatim — only the shader loader is swapped for
`Deno.readTextFile`. Needs ~1.5 GB free for the fixed buffers (the same as a
browser tab), so the *run* is memory-gated, not WebGPU-gated.

## Foundation — DE-RISKED 2026-06-08

`foundation-probe.ts` proves the runtime is viable on **Deno** (which ships
`wgpu-native` with the WebGPU API built in — no binding package, and unlike the
datacenter GPUs in [`FREE_COMPUTE.md`](../FREE_COMPUTE.md) §3, the local Apple
M2 Pro exposes a real Metal adapter):

```
$ deno run --unstable-webgpu --allow-read=. native/foundation-probe.ts
compute round-trip: ✅ pass (out[0..5]=1,3,5,7,9)
primary.wgsl compile: ✅ pass
secondary.wgsl compile: ✅ pass
```

Two things confirmed:
1. **wgpu-native runs WGSL compute** on the local GPU (Metal), no browser.
2. **The production shaders compile verbatim** — `cross_sections + helpers +
   primary/secondary` (1.3 MB assembled) compile with zero errors under
   `wgpu-native`. The "shaders port unchanged" claim is measured, not assumed.

## Path to the full runtime

The WGSL is portable; only the **host orchestration** needs a Deno entry point.
And because Deno runs TypeScript and exposes the standard `navigator.gpu` API,
much of `src/gpu/` (`buffers.ts`, `pipelines.ts`, `dispatch.ts`) can be reused
nearly as-is — the browser-specific edges are small:

- `src/shaders/loader.ts`: replace the `fetch('/cross_sections.wgsl')` with
  `Deno.readTextFile` (the `?raw` imports of helpers/primary become file reads).
- Skip the canvas/UI in `src/app.ts`; keep `runAtEnergy` → buffers → dispatch →
  readback.
- The IRT worker already runs GPU-free in Node (`tools/run_irt.cjs`); in Deno it
  runs the same, but now with **host RAM** instead of a tab heap — which is what
  unblocks the global (cross-primary) IRT pool.

### Next steps
1. ~~Port loader + initGPU + Phase A/B to a Deno entry; match the browser dump.~~ **DONE** (`run-phase-a.ts`, bit-identical rad_n).
2. ~~Add Phase B + dose readback.~~ **DONE** (runAtEnergy covers A+B).
3. Swap the per-primary `priMap` IRT for a **global pool** (the cross-primary
   fix) now that host RAM is available — the ~30-minute drop-in the design doc
   describes.
4. Validate G-values vs the browser harness within MC noise.

Install Deno (user-space, no sudo): `curl -fsSL https://deno.land/install.sh | sh`.
