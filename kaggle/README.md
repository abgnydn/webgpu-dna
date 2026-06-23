# Running webgpu-dna on Kaggle's free GPU

Kaggle gives a free CUDA GPU (T4 x2 / P100, ~30 GPU-hrs/week). Our physics is
**WGSL** (WebGPU), so we reach the GPU through [`wgpu-py`](https://github.com/pygfx/wgpu-py) —
Python bindings to `wgpu-native`, running WGSL compute over Vulkan.

`webgpu_dna_kaggle.ipynb` is a **probe**: it confirms `wgpu-py` acquires
Kaggle's GPU and runs a WGSL compute shader. It is the foundation for a Python
port of the Phase A+B physics host (see [`../FREE_COMPUTE.md`](../FREE_COMPUTE.md)).

`webgpu_dna_colab.ipynb` (+ `colab_webgpu_smoke.py`) goes further and is the one
to run if you want to **actually use the GPU**. It (1) makes a genuine best-effort
to reach the real GPU — it *installs* `libnvidia-gl-<driver>` (the NVIDIA Vulkan
producer), which the earlier probe only *detected*; (2) **measures** whether the
adapter is the real GPU or software (`llvmpipe`); and (3) compiles the real
shipped shaders (assembled exactly like `src/shaders/loader.ts`) on `wgpu-native`
either way — so even if the datacenter driver stays CUDA-only, you get a free
cross-implementation validation of the production WGSL. One cell:
`!git clone … && !python webgpu-dna/kaggle/colab_webgpu_smoke.py`.

## Import it from GitHub (no download needed)

1. On Kaggle: **Create → Notebook**, then **File → Import Notebook → GitHub**.
2. Paste this repo (`abgnydn/webgpu-dna`) and pick
   `kaggle/webgpu_dna_kaggle.ipynb`.
   (Or **File → Import Notebook → URL** with the raw URL of the `.ipynb`.)
3. **Turn on the GPU**: right sidebar → **Settings → Accelerator → GPU T4 x2**
   (or P100). Without this, `wgpu-py` falls back to the CPU software adapter and
   the probe will say so.
4. **Run all**. Two probes:
   - Probe 1 prints the adapter — confirms it's the Tesla GPU, not `llvmpipe`.
   - Probe 2 runs a WGSL compute kernel and verifies the output.

## What "pass" unlocks

If both probes pass, the same `wgpu-py` path can dispatch our real shaders
(`src/shaders/primary.wgsl` et al. compile unchanged). The remaining work is
porting the TS host orchestration (`src/gpu/{buffers,pipelines,dispatch}.ts`)
to Python — the `webgpu-dna-native` runtime, in Python instead of Node. That
unlocks **free GPU hours** for the Phase A+B physics that GitHub Actions can't
run (no GPU on default runners). The CPU-side IRT chemistry already runs free
on GitHub Actions — see `FREE_COMPUTE.md`.

## Honest caveat

`wgpu-py` on a headless Kaggle GPU depends on the NVIDIA Vulkan ICD being
present. If Probe 1 reports a CPU/software adapter even with the accelerator on,
the ICD isn't exposed in that image — that's a real finding, and the fallback is
the WebRTC swarm (volunteer browsers) for free WebGPU. The probe is cheap; run
it first before investing in the host port.
