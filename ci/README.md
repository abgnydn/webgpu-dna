# `ci/` — notes on the headless WebGPU smoke workflow

## `webgpu-smoke.yml` — **now activated**

The headless WebGPU smoke workflow was staged here while the authoring token
lacked the GitHub `workflow` OAuth scope. It has since been moved into
[`.github/workflows/webgpu-smoke.yml`](../.github/workflows/webgpu-smoke.yml)
and now runs on every `pull_request`, on `push` to `main`, and via
`workflow_dispatch`.

What it does: runs the real shipped WGSL shaders (primary / secondary /
chemistry, assembled exactly like `src/shaders/loader.ts`) on a **software**
WebGPU adapter (Mesa lavapipe / SwiftShader in headless Chromium) and runs a
compute dispatch, so a WGSL regression that vitest cannot see (syntax /
validation / undefined symbol) fails here. See
`experiments/tools/webgpu-smoke.mjs` and README §Numbers ("GPU coverage in CI").

It is a **smoke test, not a physics re-validation** (a software adapter at
small N is too noisy / vendor-dependent — see README §Numbers reproducibility
tiers).

### Still non-blocking

It ships `continue-on-error: true`, so a software-WebGPU/harness hiccup cannot
fail PRs while the lavapipe/SwiftShader bring-up proves itself on a real runner.
**Once it has its first green run, remove that line** (and optionally add
`webgpu-smoke` to branch-protection required checks) to make it gate.
