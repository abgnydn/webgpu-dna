#!/usr/bin/env python3
"""
Colab / Kaggle WebGPU smoke via wgpu-py.

Three things, in order:
  1. Best-effort to reach the *real* GPU for WebGPU: install the NVIDIA Vulkan
     producer for the running driver and register an ICD. (The earlier
     FREE_COMPUTE.md §3 probe only *detected* an ICD; it did not install
     libnvidia-gl-<driver>, which is what actually provides the Vulkan
     producer. Datacenter Tesla images often still lack it — but this gives it
     a fair shot, then MEASURES the result rather than assuming.)
  2. MEASURE which adapter wgpu-py actually gets (real GPU vs llvmpipe/CPU).
  3. Validate the REAL shipped shaders: a trivial compute proves the runtime,
     then the production primary/secondary/chemistry bundles (assembled exactly
     like src/shaders/loader.ts) are compiled on wgpu-native — a free
     cross-implementation check of the production WGSL even when the GPU only
     exposes CUDA.

Run in a Colab/Kaggle cell (GPU runtime) after cloning the repo:
    !git clone --depth 1 https://github.com/abgnydn/webgpu-dna
    !python webgpu-dna/kaggle/colab_webgpu_smoke.py

Exit 0 if the runtime works AND the real shaders compile (regardless of whether
the adapter is GPU or software); non-zero otherwise.
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sh(cmd, quiet=True):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if not quiet:
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
    return r


def step1_try_real_gpu_vulkan():
    print("=" * 70)
    print("STEP 1 — best-effort: make the real GPU reachable for Vulkan/WebGPU")
    print("=" * 70)
    smi = sh("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader")
    line = (smi.stdout or "").strip()
    print("nvidia-smi:", line or "(no GPU / nvidia-smi missing)")
    drv_major = ""
    if "," in line:
        drv_major = line.split(",")[1].strip().split(".")[0]
    print("driver major:", drv_major or "(unknown)")

    sh("apt-get -qq update")
    sh("apt-get -qq install -y libvulkan1 vulkan-tools")
    # The package that ships the NVIDIA Vulkan producer (libGLX_nvidia.so.0 etc.)
    # for THIS driver. Non-fatal: it may be absent/mismatched on Colab images.
    if drv_major:
        r = sh(f"apt-get -qq install -y libnvidia-gl-{drv_major}")
        print(f"libnvidia-gl-{drv_major}:", "installed" if r.returncode == 0 else "unavailable (expected on stripped Tesla images)")

    os.makedirs("/usr/share/vulkan/icd.d", exist_ok=True)
    icd = {"file_format_version": "1.0.0",
           "ICD": {"library_path": "libGLX_nvidia.so.0", "api_version": "1.3.0"}}
    with open("/usr/share/vulkan/icd.d/nvidia_icd.json", "w") as f:
        json.dump(icd, f)
    print("registered /usr/share/vulkan/icd.d/nvidia_icd.json")

    vk = sh("vulkaninfo --summary")
    devs = [ln.strip() for ln in (vk.stdout or "").splitlines()
            if "deviceName" in ln or "deviceType" in ln]
    print("vulkaninfo devices:", devs or "(none — no GPU-accessible Vulkan device)")


def step2_measure_adapter():
    print("\n" + "=" * 70)
    print("STEP 2 — MEASURE the wgpu-py adapter (the honest verdict)")
    print("=" * 70)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "wgpu", "numpy"], check=False)
    import wgpu  # noqa: E402  (after pip install)
    print("wgpu-py:", wgpu.__version__)
    adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
    info = dict(adapter.info)
    for k in ("vendor", "architecture", "device", "description", "adapter_type", "backend_type"):
        print(f"  {k:13} {info.get(k, '')}")
    blob = (str(info.get("device", "")) + " " + str(info.get("description", "")) + " "
            + str(info.get("adapter_type", ""))).lower()
    is_real_gpu = not any(s in blob for s in ("cpu", "llvmpipe", "software", "lavapipe", "swiftshader"))
    print(f"\n>>> REAL GPU adapter? {is_real_gpu}")
    if not is_real_gpu:
        print(">>> (software fallback — Colab's datacenter driver exposes CUDA, not Vulkan;")
        print(">>>  the shader validation below is still a real wgpu-native cross-check.)")
    return adapter, is_real_gpu


def step3_validate_shaders(adapter):
    print("\n" + "=" * 70)
    print("STEP 3 — validate the runtime + the REAL shipped shaders")
    print("=" * 70)
    import numpy as np
    from wgpu.utils.compute import compute_with_buffers

    triv = ("@group(0) @binding(0) var<storage,read> inp: array<u32>;\n"
            "@group(0) @binding(1) var<storage,read_write> outp: array<u32>;\n"
            "@compute @workgroup_size(4) fn main(@builtin(global_invocation_id) g: vec3<u32>) "
            "{ outp[g.x] = inp[g.x] + 1u; }")
    res = list(compute_with_buffers({0: np.array([10, 20, 30, 40], dtype=np.uint32)},
                                    {1: (4, "u32")}, triv, n=(4, 1, 1))[1])
    runtime_ok = res == [11, 21, 31, 41]
    print(f"trivial compute: {res} -> {'OK' if runtime_ok else 'FAIL (expected 11,21,31,41)'}")

    def rd(p):
        with open(os.path.join(REPO, p), encoding="utf-8") as f:
            return f.read()

    xs, helpers = rd("public/cross_sections.wgsl"), rd("src/shaders/helpers.wgsl")
    # Assemble exactly like src/shaders/loader.ts: cross_sections + helpers + kernel.
    bundles = {
        "primary": xs + "\n" + helpers + "\n" + rd("src/shaders/primary.wgsl"),
        "secondary": xs + "\n" + helpers + "\n" + rd("src/shaders/secondary.wgsl"),
        "chemistry": rd("src/shaders/chemistry.wgsl"),
    }
    device = adapter.request_device_sync()
    compiles_ok = True
    for name, code in bundles.items():
        try:
            device.create_shader_module(code=code)
            print(f"compiled {name}.wgsl   OK")
        except Exception as e:  # noqa: BLE001 — report any compile/validation error
            compiles_ok = False
            print(f"compiled {name}.wgsl  FAIL\n   {str(e)[:400]}")
    return runtime_ok, compiles_ok


def main():
    step1_try_real_gpu_vulkan()
    adapter, is_real_gpu = step2_measure_adapter()
    runtime_ok, compiles_ok = step3_validate_shaders(adapter)

    print("\n" + "=" * 70)
    print("VERDICT")
    print("=" * 70)
    print(f"  real GPU adapter ...... {is_real_gpu}  "
          f"({'WebGPU on the Colab GPU — update FREE_COMPUTE.md §3!' if is_real_gpu else 'software fallback (CUDA-only GPU)'})")
    print(f"  runtime compute ....... {'OK' if runtime_ok else 'FAIL'}")
    print(f"  real shaders compile .. {'OK' if compiles_ok else 'FAIL'}")
    ok = runtime_ok and compiles_ok
    print(f"\n{'PASS' if ok else 'FAIL'} — the production WGSL "
          f"{'runs+validates' if ok else 'did NOT validate'} on wgpu-native "
          f"({'real GPU' if is_real_gpu else 'software'}).")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
