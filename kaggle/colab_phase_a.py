#!/usr/bin/env python3
"""
Phase A (primary electron tracking) on a free Colab/Kaggle GPU via wgpu-py.

This is the host port of src/gpu/{buffers,dispatch}.ts (Phase A only), faithful
to the browser/Deno code:
  - P uniform packing      <- writePrimaryParams (dispatch.ts:13)
  - buffer sizes/usages     <- allocateBuffers   (buffers.ts:49)
  - per-primary RNG seed    <- seedPrimaryRNG     (buffers.ts:96)
  - dispatch ceil(np/256)   <- runAtEnergy        (dispatch.ts:108)
  - results aggregation     <- runAtEnergy        (dispatch.ts:236) — R.path -> CSDA,
                                                    R.ni -> primary ions/pri, skip escaped

It runs the REAL primary.wgsl on Google's Tesla T4 (wgpu-native / Vulkan) and
reports CSDA + primary-track ions/primary + energy conservation — an independent
SECOND-IMPLEMENTATION, SECOND-MACHINE check of the marquee primary track
(production is Apple Metal; Geant4 is the oracle). It is Phase A only: it does
NOT track the secondary cascade (that is Phase B) or run chemistry, so `ions/pri`
here is the PRIMARY-track count (compare to Geant4 195.6, E20), not the full
cascade (509.2).

Run (Colab/Kaggle GPU runtime):
    !git clone --depth 1 -b <branch> https://github.com/abgnydn/webgpu-dna
    !python webgpu-dna/kaggle/colab_phase_a.py [E_eV] [N]
"""
import json
import math
import os
import struct
import subprocess
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Matched-condition Geant4 11.4.1 references (README §Numbers / E5 / E20).
G4_CSDA_NM = {100: 26.21, 300: 35.91, 500: 48.07, 1000: 90.32, 10000: 2747.5}
G4_PRIMARY_IONS_10KEV = 195.6  # primary-track ionisations/primary (E20)

# Constants — mirror src/physics/constants.ts.
VC = 128
MS = 65536          # max primary steps (dispatch.ts pu[3])
BOX_NM = 15000.0
CE_EV = 7.4


def ensure_gpu_vulkan():
    """Idempotent: install the NVIDIA Vulkan producer + register an ICD so the
    real GPU is reachable (see kaggle/colab_webgpu_smoke.py / FREE_COMPUTE.md §3)."""
    # Force Vulkan: when both Vulkan and GL adapters exist for the T4, wgpu may
    # pick GL, which cannot do compute storage buffers ("device is lost"). Must
    # be set before `import wgpu`.
    os.environ["WGPU_BACKEND_TYPE"] = "Vulkan"
    os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/xdg-runtime")
    os.makedirs(os.environ["XDG_RUNTIME_DIR"], exist_ok=True)
    smi = subprocess.run("nvidia-smi --query-gpu=driver_version --format=csv,noheader",
                         shell=True, capture_output=True, text=True)
    drv = (smi.stdout or "").strip().split(".")[0]
    # Full Vulkan stack (same as the proven kaggle/colab_webgpu_smoke.py step 1):
    # loader + tools + the NVIDIA producer for THIS driver. Self-contained so it
    # works in a fresh Colab VM even if the smoke wasn't run first. Idempotent.
    subprocess.run("apt-get -qq update >/dev/null 2>&1 || true", shell=True)
    subprocess.run("apt-get -qq install -y libvulkan1 vulkan-tools >/dev/null 2>&1 || true", shell=True)
    if drv:
        subprocess.run(f"apt-get -qq install -y libnvidia-gl-{drv} >/dev/null 2>&1 || true", shell=True)
    os.makedirs("/usr/share/vulkan/icd.d", exist_ok=True)
    icd = {"file_format_version": "1.0.0",
           "ICD": {"library_path": "libGLX_nvidia.so.0", "api_version": "1.3.0"}}
    with open("/usr/share/vulkan/icd.d/nvidia_icd.json", "w") as f:
        json.dump(icd, f)
    vk = subprocess.run("vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|deviceType' | head",
                        shell=True, capture_output=True, text=True)
    print("vulkaninfo:", (vk.stdout.strip() or "(no Vulkan device visible)").replace("\n", " | "))


def seed_primary_rng(np_count, seed):
    """Exact port of seedPrimaryRNG (buffers.ts:96) — splitmix per primary."""
    d = np.zeros(np_count * 4, dtype=np.uint32)
    M = 0xFFFFFFFF
    for i in range(np_count):
        s = ((i + 1) * 2654435761 + seed * 1013904223) & M
        for j in range(4):
            s ^= s >> 16
            s = (s * 0x45D9F3B) & M
            s ^= s >> 16
            d[i * 4 + j] = (s + j * 0x9E3779B9) & M
    return d


def pack_params(np_count, e_ev, max_sec, max_rad):
    """Exact port of writePrimaryParams (dispatch.ts:13). DNA disabled (null)."""
    b = bytearray(64)
    struct.pack_into("<I", b, 0, np_count)      # n
    struct.pack_into("<f", b, 4, BOX_NM)        # box
    struct.pack_into("<f", b, 8, CE_EV)         # ce
    struct.pack_into("<I", b, 12, MS)           # ms
    struct.pack_into("<f", b, 16, float(e_ev))  # be
    struct.pack_into("<I", b, 20, max_sec)      # max_sec
    struct.pack_into("<I", b, 24, VC)           # vc
    struct.pack_into("<I", b, 28, max_rad)      # max_rad
    struct.pack_into("<f", b, 32, 0.0)          # start_half
    struct.pack_into("<I", b, 36, 0)            # dna_enable
    struct.pack_into("<I", b, 40, 0)            # dna_grid_n
    struct.pack_into("<I", b, 44, 0)            # _pad3
    for off in (48, 52, 56, 60):                # dna rise/spacing/x0/r_bb
        struct.pack_into("<f", b, off, 0.0)
    return bytes(b)


def main():
    e_ev = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    np_count = int(sys.argv[2]) if len(sys.argv) > 2 else 1024

    ensure_gpu_vulkan()
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "wgpu", "numpy"], check=False)
    import wgpu

    adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
    if adapter is None:
        sys.exit("ERROR: no Vulkan adapter found. Run kaggle/colab_webgpu_smoke.py first (it installs "
                 "libnvidia-gl-<driver>), or check that nvidia-smi's driver major matches the installed libnvidia-gl.")
    info = dict(adapter.info)
    backend = str(info.get("backend_type", "")).lower()
    print(f"adapter: {info.get('device','')} | {info.get('adapter_type','')} / {info.get('backend_type','')}")
    if "vulkan" not in backend:
        sys.exit(f"ERROR: selected the {info.get('backend_type','?')!r} backend, which cannot do compute storage "
                 "buffers (that is the 'device is lost' error). WGPU_BACKEND_TYPE=Vulkan is set; if Vulkan still "
                 "isn't picked, the libnvidia-gl install didn't take — re-run the cell.")
    is_gpu = True
    device = adapter.request_device_sync()

    # --- shader: cross_sections + helpers + primary (assemble like loader.ts) ---
    rd = lambda p: open(os.path.join(REPO, p), encoding="utf-8").read()
    code = rd("public/cross_sections.wgsl") + "\n" + rd("src/shaders/helpers.wgsl") + "\n" + rd("src/shaders/primary.wgsl")
    module = device.create_shader_module(code=code)

    # --- buffers (Phase A subset of allocateBuffers). radBuf/secBuf only need to
    #     EXIST + be bound; their size doesn't affect R.path/R.ni (per-primary
    #     counters), so keep them modest. Capacities are passed as p.max_rad/
    #     p.max_sec so the shader self-limits its atomic appends. ---
    BU = wgpu.BufferUsage
    max_rad = min(6_000_000, max(2_000_000, np_count * 1000))   # *16B <= 96MB (< 128MB default binding limit)
    max_sec = min(1_500_000, max(500_000, np_count * 400))      # *48B <= 72MB

    def buf(nbytes, usage):
        return device.create_buffer(size=nbytes, usage=usage)

    params = buf(64, BU.UNIFORM | BU.COPY_DST)
    results = buf(np_count * 32, BU.STORAGE | BU.COPY_SRC)
    rng = buf(np_count * 16, BU.STORAGE | BU.COPY_DST)
    dbg = buf(32, BU.STORAGE | BU.COPY_SRC)
    rad_buf = buf(max_rad * 16, BU.STORAGE)
    sec_buf = buf(max_sec * 48, BU.STORAGE)
    dose = buf(VC * VC * VC * 4, BU.STORAGE | BU.COPY_SRC)
    counters = buf(32, BU.STORAGE | BU.COPY_SRC | BU.COPY_DST)

    device.queue.write_buffer(params, 0, pack_params(np_count, e_ev, max_sec, max_rad))
    device.queue.write_buffer(rng, 0, seed_primary_rng(np_count, e_ev).tobytes())
    device.queue.write_buffer(counters, 0, np.zeros(8, np.uint32).tobytes())  # atomic append idxs start at 0

    # --- bind group layout = run-phase-a.ts createPipelines: unif(0)+stor(1..7) ---
    BT = wgpu.BufferBindingType
    COMPUTE = wgpu.ShaderStage.COMPUTE
    entries_layout = [{"binding": 0, "visibility": COMPUTE, "buffer": {"type": BT.uniform}}]
    entries_layout += [{"binding": i, "visibility": COMPUTE, "buffer": {"type": BT.storage}} for i in range(1, 8)]
    bgl = device.create_bind_group_layout(entries=entries_layout)
    pl = device.create_pipeline_layout(bind_group_layouts=[bgl])
    pipeline = device.create_compute_pipeline(layout=pl, compute={"module": module, "entry_point": "main"})

    bufs = [params, results, rng, dbg, rad_buf, sec_buf, dose, counters]
    bind_group = device.create_bind_group(layout=bgl, entries=[
        {"binding": i, "resource": {"buffer": b, "offset": 0, "size": b.size}} for i, b in enumerate(bufs)])

    # --- Phase A dispatch (dispatch.ts:108) ---
    import time
    t0 = time.perf_counter()
    enc = device.create_command_encoder()
    cpass = enc.begin_compute_pass()
    cpass.set_pipeline(pipeline)
    cpass.set_bind_group(0, bind_group)
    cpass.dispatch_workgroups(math.ceil(np_count / 256))
    cpass.end()
    device.queue.submit([enc.finish()])
    device.queue.read_buffer(counters)  # forces completion of the submitted work
    wall_ms = (time.perf_counter() - t0) * 1000

    # --- readback + per-primary aggregation (dispatch.ts:236) ---
    dt = np.dtype([("path", "<f4"), ("prod", "<f4"), ("fE", "<f4"), ("ni", "<u4"),
                   ("nx", "<u4"), ("esc", "<u4"), ("mx", "<f4"), ("pad", "<u4")])
    R = np.frombuffer(bytes(device.queue.read_buffer(results)), dtype=dt, count=np_count)
    therm = R["esc"] != 1
    n_therm = int(therm.sum())
    n_esc = int((~therm).sum())
    mean_csda = float(R["path"][therm].mean()) if n_therm else 0.0
    mean_ions = float(R["ni"][therm].mean()) if n_therm else 0.0

    dose_arr = np.frombuffer(bytes(device.queue.read_buffer(dose)), dtype=np.uint32)
    total_dep_ev = float(dose_arr.astype(np.float64).sum()) / 100.0
    e_cons = total_dep_ev / (n_therm * e_ev) if n_therm else 0.0

    # --- report ---
    g4 = G4_CSDA_NM.get(e_ev)
    print("\n" + "=" * 64)
    print(f"PHASE A on {'REAL GPU' if is_gpu else 'software'} — {np_count} primaries @ {e_ev} eV  ({wall_ms:.0f} ms)")
    print("=" * 64)
    print(f"  CSDA range ......... {mean_csda:8.1f} nm" + (f"   vs Geant4 {g4} -> {mean_csda/g4:.3f}x" if g4 else ""))
    print(f"  primary ions/pri ... {mean_ions:8.1f}   " + (f" vs Geant4 {G4_PRIMARY_IONS_10KEV} -> {mean_ions/G4_PRIMARY_IONS_10KEV:.3f}x  (E20 primary; Phase A is primary-only, not the 509.2 cascade)" if e_ev == 10000 else ""))
    print(f"  energy conservation  {e_cons*100:8.2f} %")
    print(f"  thermalized / escaped {n_therm} / {n_esc}")
    print(json.dumps({"E_eV": e_ev, "N": np_count, "real_gpu": is_gpu,
                      "csda_nm": round(mean_csda, 2), "primary_ions_per_pri": round(mean_ions, 2),
                      "e_cons": round(e_cons, 4), "n_therm": n_therm, "n_esc": n_esc,
                      "adapter": info.get("device", ""), "wall_ms": round(wall_ms)}))


if __name__ == "__main__":
    main()
