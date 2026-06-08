// webgpu-dna-native — Phase A+B physics in Deno (no browser).
//
// Reuses the browser host code almost verbatim: device init, buffer
// allocation, RNG seeding, and the runAtEnergy() Phase A→B orchestrator all
// import directly from src/ (they use the standard navigator.gpu API). The
// only browser-specific edge is the shader loader (Vite `?raw` + fetch), which
// we replace here with Deno.readTextFile.
//
//   deno run --unstable-webgpu --allow-read --allow-env native/run-phase-a.ts [E_eV] [N]
//
// Needs ~1.5 GB free for the fixed-size GPU buffers (MAX_RAD 256 MB + sec 240 MB
// + chem + readbacks) — the same allocation the browser tab makes. Validation
// against the browser dump is therefore memory-gated, not WebGPU-gated.

import { initGPU } from "../src/gpu/device.ts";
import { allocateBuffers } from "../src/gpu/buffers.ts";
import { buildDNATarget } from "../src/physics/dna-geometry.ts";
import { runAtEnergy } from "../src/gpu/dispatch.ts";
import type { GPUBuffers } from "../src/gpu/buffers.ts";
import type { Pipelines } from "../src/gpu/pipelines.ts";

const HERE = import.meta.dirname!;
const ROOT = `${HERE}/..`;

// --- Deno shader assembly (replaces src/shaders/loader.ts ?raw + fetch) ---
const xs = await Deno.readTextFile(`${ROOT}/public/cross_sections.wgsl`);
const helpers = await Deno.readTextFile(`${ROOT}/src/shaders/helpers.wgsl`);
const primaryWgsl = await Deno.readTextFile(`${ROOT}/src/shaders/primary.wgsl`);
const secondaryWgsl = await Deno.readTextFile(`${ROOT}/src/shaders/secondary.wgsl`);
const chemWgsl = await Deno.readTextFile(`${ROOT}/src/shaders/chemistry.wgsl`);

// --- createPipelines, ported from src/gpu/pipelines.ts (same bind layouts) ---
async function createPipelines(device: GPUDevice, b: GPUBuffers): Promise<Pipelines> {
  const compile = async (code: string, label: string) => {
    device.pushErrorScope("validation");
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    const err = await device.popErrorScope();
    const errs = info.messages.filter((x) => x.type === "error");
    if (errs.length || err) throw new Error(`${label}: ${errs.map((e) => e.message).join("; ")} ${err?.message ?? ""}`);
    return m;
  };
  const pMod = await compile(`${xs}\n${helpers}\n${primaryWgsl}`, "primary");
  const sMod = await compile(`${xs}\n${helpers}\n${secondaryWgsl}`, "secondary");
  const cMod = await compile(chemWgsl, "chemistry");

  const stor = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } });
  const unif = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } });

  const pLayout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4), stor(5), stor(6), stor(7)] });
  const ppl = device.createPipelineLayout({ bindGroupLayouts: [pLayout] });
  const primaryBG = device.createBindGroup({ layout: pLayout, entries: [
    { binding: 0, resource: { buffer: b.params } }, { binding: 1, resource: { buffer: b.results } },
    { binding: 2, resource: { buffer: b.rng } }, { binding: 3, resource: { buffer: b.dbg } },
    { binding: 4, resource: { buffer: b.radBuf } }, { binding: 5, resource: { buffer: b.secBuf } },
    { binding: 6, resource: { buffer: b.dose } }, { binding: 7, resource: { buffer: b.counters } }] });

  const sLayout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4), stor(5)] });
  const spl = device.createPipelineLayout({ bindGroupLayouts: [sLayout] });
  const secondaryBG = device.createBindGroup({ layout: sLayout, entries: [
    { binding: 0, resource: { buffer: b.secParams } }, { binding: 1, resource: { buffer: b.secBuf } },
    { binding: 2, resource: { buffer: b.secStats } }, { binding: 3, resource: { buffer: b.dose } },
    { binding: 4, resource: { buffer: b.counters } }, { binding: 5, resource: { buffer: b.radBuf } }] });

  const cLayout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4),
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" as const } }, stor(6), stor(7), stor(8)] });
  const cpl = device.createPipelineLayout({ bindGroupLayouts: [cLayout] });
  const chemBG = device.createBindGroup({ layout: cLayout, entries: [
    { binding: 0, resource: { buffer: b.chemUni } }, { binding: 1, resource: { buffer: b.chemPos } },
    { binding: 2, resource: { buffer: b.chemAlive } }, { binding: 3, resource: { buffer: b.chemRng } },
    { binding: 4, resource: { buffer: b.chemStats } }, { binding: 5, resource: { buffer: b.radBuf } },
    { binding: 6, resource: { buffer: b.chemCellHead } }, { binding: 7, resource: { buffer: b.chemNextIdx } },
    { binding: 8, resource: { buffer: b.chemPosOld } }] });

  const mk = (l: GPUPipelineLayout, m: GPUShaderModule, e: string) => device.createComputePipeline({ layout: l, compute: { module: m, entryPoint: e } });
  return {
    primary: mk(ppl, pMod, "main"), secondary: mk(spl, sMod, "step"),
    chemDiffuse: mk(cpl, cMod, "diffuse"), chemReact: mk(cpl, cMod, "react"), chemMatch: mk(cpl, cMod, "match_react"),
    chemClearHash: mk(cpl, cMod, "clear_hash"), chemBuildHash: mk(cpl, cMod, "build_hash"), chemCount: mk(cpl, cMod, "count_alive"),
    chemSample: mk(cpl, cMod, "sample_init"), chemInit: mk(cpl, cMod, "init_thermal"),
    primaryBG, secondaryBG, chemBG,
  };
}

// --- main ---
const E_eV = Number(Deno.args[0] ?? 10000);
const np = Number(Deno.args[1] ?? 4096);
const boxNm = 15000, ceEV = 7.4;

const device = await initGPU((m) => console.error(`[init] ${m}`));
if (!device) Deno.exit(1);

console.error(`[native] allocating buffers (np=${np})…`);
const buffers = allocateBuffers(device, np);
const pipelines = await createPipelines(device, buffers);
const dna = buildDNATarget();

console.error(`[native] Phase A+B at ${E_eV} eV, ${np} primaries…`);
const t0 = performance.now();
const r = await runAtEnergy(device, buffers, pipelines, E_eV, np, boxNm, ceEV, dna, undefined);
const ms = (performance.now() - t0).toFixed(1);

console.log(JSON.stringify({
  E_eV, np, wall_ms: Number(ms),
  rad_n: r.rad_n_stored, mean_total_csda_nm: r.mean_total, ions_per_pri: r.mean_ions,
  sec_per_pri: r.sec_per_pri, E_cons: r.cons_ratio,
}));
console.error(`[native] done in ${ms} ms — rad_n=${r.rad_n_stored}, CSDA=${r.mean_total?.toFixed(1)}nm, ions/pri=${r.mean_ions?.toFixed(1)}`);
