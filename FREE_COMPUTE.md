# Free compute strategy

The validation work splits by **compute type**, not by how heavy it is. The
binding constraint is that WebGPU needs a real GPU adapter, which most free
infrastructure does not expose — so we route GPU-free work to free infra and
keep only the genuine WebGPU runs local. (The sibling `webgpu-q` reached the
same conclusion: its CI skips WebGPU E2E but runs heavy CPU/WASM work on the
16 GB runner.)

| Work | Compute type | Where it runs | Status |
|---|---|---|---|
| Phase A+B track-structure physics | **WebGPU** | local (Apple Metal) | local only |
| IRT radiolysis chemistry (the memory hog) | CPU / Node | **GitHub Actions** (16 GB runner) | ✅ wired |
| Geant4 reference + E15-fairer | CPU | **Oracle Always Free** (24 GB ARM) | runbook below |
| Multi-GPU / arbitrary-N physics | native WebGPU (wgpu-py) | **Colab/Kaggle T4** | ✅ **OPEN (2026-06-23)** — see §3 |
| Citizen-science WebGPU at scale | volunteer WebGPU | WebRTC swarm + Cloudflare Workers | roadmap (the real free-WebGPU path) |

## 1. GitHub Actions — IRT chemistry (wired)

`.github/workflows/chemistry-validation.yml` runs `tools/run_irt.cjs` on a
pre-chemistry `rad_buf` dump on a 16 GB runner. The dumps (the WebGPU output
the runner cannot regenerate) are hosted as assets on the
`validation-inputs-v1` release. The default dispatch fans out a dynamic matrix
over all 8 ESTAR energies in parallel.

```bash
gh workflow run chemistry-validation.yml -f energies=all        # full sweep
gh workflow run chemistry-validation.yml -f energies=10000      # one energy
gh run download <run-id>                                        # pull artifacts
```

Proven: 10 keV (4.97M radicals, 1.62M reactions, 203 s) completes on the runner
with G-values matching the committed E13c values — the exact run that OOMs a
16 GB laptop shared with other apps.

To refresh the dumps after a shader change (needs local WebGPU):
`node experiments/lib/regenerate-dumps.mjs` then
`gh release upload validation-inputs-v1 dumps/rad_E*_N4096.bin --clobber`.

## 2. Oracle Cloud Always Free — Geant4 / E15-fairer (runbook)

Oracle's **Always Free** tier includes an Ampere A1 ARM instance (up to
4 OCPU / 24 GB RAM, free indefinitely — not a trial). More RAM than the laptop,
persistent, no per-run trigger. Use it for the Geant4-side work that is pure
CPU.

**Provision (one-time, user does this — needs the Oracle account):**
1. Create an Always Free Ampere A1 instance (Ubuntu 22.04 ARM, 4 OCPU / 24 GB).
2. `sudo apt update && sudo apt install -y build-essential cmake libexpat1-dev \
   libxerces-c-dev qtbase5-dev libxmu-dev libxi-dev` (Geant4 build deps).

**Build Geant4 11.4.1 + dnaphysics (one-time, ~30–60 min on 4 ARM cores):**
```bash
# Geant4 source + data, build with DNA physics
cmake -DGEANT4_INSTALL_DATA=ON -DGEANT4_USE_QT=OFF <geant4-src>
make -j4 && sudo make install
# dnaphysics example
cmake <geant4>/examples/extended/medical/dna/dnaphysics && make -j4
```

**E15-fairer — isolate the ntuple-I/O cost (the open L6 item):**
The 289 s Geant4 baseline writes ~6.8 GB of per-event ntuple (measured,
1.65 MB/primary). E15-fair showed init is only ~2 s; E15-fairer isolates how
much wall-time the I/O adds. On the box:
```bash
# (a) baseline WITH ntuple — same as E15b
time ./dnaphysics validation/run_validation.mac          # writes dna.root

# (b) no-ntuple variant: patch the example's RunAction to skip the
#     G4AnalysisManager OpenFile/Write (or comment the ntuple Fill in the
#     SteppingAction), rebuild, and re-run:
time ./dnaphysics-nontuple validation/run_validation.mac # no dna.root

# E15-fairer result = (a) − (b) = the ntuple-I/O wall-time on the event loop.
# Commit as experiments/results/<date>/level-6/E15-fairer-*.json
```
This is CPU-only, so it runs on Oracle without the local memory pressure, and
the box stays available for ad-hoc Geant4 reference regenerations.

## 3. Colab / Kaggle — free GPU via wgpu-py — ✅ OPEN (re-tested 2026-06-23)

**UPDATE 2026-06-23 — the "closed" finding below is OVERTURNED.** On a Colab
Tesla T4 (driver 580.82.07), installing the NVIDIA Vulkan **producer** for the
running driver makes the GPU Vulkan-visible, and `wgpu-py` 0.31.0 binds it:

```
adapter_type  DiscreteGPU
backend_type  Vulkan
device        Tesla T4
```

A trivial WGSL compute runs, and the **real shipped shaders compile on the T4**
(`primary` / `secondary` / `chemistry`, assembled exactly like
`src/shaders/loader.ts`). Recipe (in `kaggle/colab_webgpu_smoke.py`, runnable via
`kaggle/webgpu_dna_colab.ipynb`):

```bash
drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | cut -d. -f1)
apt-get install -y libnvidia-gl-$drv          # the Vulkan producer — the missing piece
printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' \
  > /usr/share/vulkan/icd.d/nvidia_icd.json
# then: wgpu.gpu.request_adapter_sync(power_preference='high-performance')
```

**Why the 2026-06-08 probe missed it:** it only *detected* an ICD; it never
installed `libnvidia-gl-<driver>`, so the producer library was absent and `wgpu`
fell back to `llvmpipe`. **Still open (honest scope):** this is shader *compile* +
a trivial dispatch on the real GPU — NOT yet a full physics numeric validation,
which needs the buffer/pipeline/dispatch host ported to Python (now unblocked).
Artifact: `experiments/results/2026-06-23/level-0/B2-colab-gpu-webgpu.json`.

**Original probe (2026-06-08) — superseded, kept for provenance:**

The hypothesis was: Colab/Kaggle give free CUDA GPUs, and
[`wgpu-py`](https://github.com/pygfx/wgpu-py) (bindings to `wgpu-native`) could
run WGSL on them over Vulkan, unlocking free GPU hours for the physics.

**Probed and refuted.** `kaggle/webgpu_dna_kaggle.ipynb` on a Kaggle GPU T4 x2
instance (accelerator ON) — even after detecting/registering the NVIDIA Vulkan
ICD — reports:

```
device       llvmpipe (LLVM 15.0.7)
adapter_type CPU
backend_type OpenGL
```

i.e. `wgpu` found **no GPU-accessible Vulkan device**, fell back to OpenGL, and
that too is only Mesa's **software** rasterizer (`llvmpipe`). Kaggle's Tesla
driver is **compute-only (CUDA), with no Vulkan and no GPU OpenGL** — and *every*
WebGPU implementation (wgpu-native, Dawn) is Vulkan/Metal/D3D, never CUDA. So the
GPU is reachable for PyTorch but **not for WGSL/WebGPU**. Colab was tested too (2026-06-08): same Tesla T4, `NVIDIA Vulkan lib: NONE
FOUND` — identical compute-only result. Both Google free GPUs confirmed.

**Verdict (corrected 2026-06-23):** the 2026-06-08 "free datacenter GPUs cannot
run our physics" was **wrong** — it followed from not installing the Vulkan
producer (see the UPDATE at the top of §3). With `libnvidia-gl-<driver>` the
Colab/Kaggle T4 runs WebGPU/WGSL and the real shaders compile on it. §4 (the
swarm) is still the only free path *at scale*, but free *rented* GPU is now a
viable second free-WebGPU path for batch runs.

## 4. WebRTC swarm — volunteer WebGPU (roadmap)

Volunteer browsers *are* free WebGPU. The swarm turns each visitor's GPU into a
compute node, with a Cloudflare Workers free-tier coordinator (already on
Cloudflare). `webgpu-q` has the swarm pattern (WASM + BroadcastChannel + SAB)
to mirror. The only source of free WebGPU *at scale*.

## The shape

For **CPU / memory / Geant4** work, free compute is abundant — GitHub Actions
(wired) and Oracle Always Free (a few hours of setup) cover it. For **WebGPU**,
free *rented* GPU now works too: the free GPU clouds (Kaggle, Colab) **do** run
WebGPU once you install the NVIDIA Vulkan producer `libnvidia-gl-<driver>`
(re-tested 2026-06-23, §3 — the earlier "no Vulkan" reading had skipped that
install). So there are now two free WebGPU paths: rented datacenter GPU (batch,
via wgpu-py) and **consumer hardware with a real graphics driver** — the local
machine, or volunteer browsers via the **swarm** (§4), the latter still the sole
free path *at scale*.
