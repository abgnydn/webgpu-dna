// webgpu-dna-native — proton Phase A (CSDA + ionisation yield) in Deno.
//   deno run --unstable-webgpu --allow-read --allow-env native/run-proton.ts [E_eV] [N]
// Validates the proton track-structure physics (Rudd + Miller-Green + Born)
// against PSTAR / Geant4-DNA proton CSDA ranges in liquid water.

import { initGPU } from "../src/gpu/device.ts";
import { allocateBuffers } from "../src/gpu/buffers.ts";

const HERE = import.meta.dirname!;
const ROOT = `${HERE}/..`;
const read = (f: string) => Deno.readTextFile(`${ROOT}/${f}`);

const xs = await read("public/cross_sections.wgsl");
const pxs = await read("public/proton_cross_sections.wgsl");
const helpers = await read("src/shaders/helpers.wgsl");
const protonWgsl = await read("src/shaders/proton.wgsl");

const E_eV = Number(Deno.args[0] ?? 1_000_000);  // default 1 MeV
const np = Number(Deno.args[1] ?? 64);
const boxNm = 2_000_000;   // 2 mm half-width — protons range µm..mm, must not escape

const device = await initGPU((m) => console.error(`[init] ${m}`));
if (!device) Deno.exit(1);
const b = allocateBuffers(device, np);

// compile proton shader = cross_sections + proton_cross_sections + helpers + proton
device.pushErrorScope("validation");
const mod = device.createShaderModule({ code: `${xs}\n${pxs}\n${helpers}\n${protonWgsl}`, label: "proton" });
const info = await mod.getCompilationInfo();
const err = await device.popErrorScope();
const errs = info.messages.filter((m) => m.type === "error");
if (errs.length || err) {
  for (const e of errs) console.error(`  WGSL ${e.lineNum}:${e.linePos} ${e.message}`);
  if (err) console.error(`  ${err.message}`);
  Deno.exit(1);
}

const stor = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } });
const unif = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } });
const layout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4), stor(5), stor(6), stor(7)] });
const bg = device.createBindGroup({ layout, entries: [
  { binding: 0, resource: { buffer: b.params } }, { binding: 1, resource: { buffer: b.results } },
  { binding: 2, resource: { buffer: b.rng } }, { binding: 3, resource: { buffer: b.dbg } },
  { binding: 4, resource: { buffer: b.radBuf } }, { binding: 5, resource: { buffer: b.secBuf } },
  { binding: 6, resource: { buffer: b.dose } }, { binding: 7, resource: { buffer: b.counters } }] });
const pipeline = device.createComputePipeline({
  layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
  compute: { module: mod, entryPoint: "main" } });

// P params: be = proton KE, ce = 7.4 (ejected-electron cutoff), ms large, box huge
const pbuf = new ArrayBuffer(64); const pu = new Uint32Array(pbuf); const pf = new Float32Array(pbuf);
pu[0] = np; pf[1] = boxNm; pf[2] = 7.4; pu[3] = 2_000_000; pf[4] = E_eV;
pu[5] = 5_000_000; pu[6] = 128; pu[7] = 16_000_000; pf[8] = 0.0; pu[9] = 0;
device.queue.writeBuffer(b.params, 0, pbuf);

// seed rng
const rngInit = new Uint32Array(np * 4);
for (let i = 0; i < np * 4; i++) rngInit[i] = (0x9e3779b9 * (i + 1) + E_eV) >>> 0;
device.queue.writeBuffer(b.rng, 0, rngInit);

const t0 = performance.now();
const enc = device.createCommandEncoder();
const pass = enc.beginComputePass();
pass.setPipeline(pipeline); pass.setBindGroup(0, bg);
pass.dispatchWorkgroups(Math.ceil(np / 64));
pass.end();
const rb = device.createBuffer({ size: np * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
enc.copyBufferToBuffer(b.results, 0, rb, 0, np * 32);
device.queue.submit([enc.finish()]);
await device.queue.onSubmittedWorkDone();
await rb.mapAsync(GPUMapMode.READ);
const r = new Float32Array(rb.getMappedRange());
const ru = new Uint32Array(rb.getMappedRange());
let path = 0, ni = 0, nx = 0, fE = 0, esc = 0;
for (let i = 0; i < np; i++) {
  path += r[i * 8 + 0]; ni += ru[i * 8 + 3]; nx += ru[i * 8 + 4]; fE += r[i * 8 + 2]; esc += ru[i * 8 + 5];
}
rb.unmap();
const ms = (performance.now() - t0).toFixed(0);
console.log(JSON.stringify({
  E_eV, np, csda_nm: path / np, csda_um: path / np / 1000,
  ions_per_proton: ni / np, exc_per_proton: nx / np,
  mean_final_E: fE / np, escaped: esc, wall_ms: Number(ms),
}));
console.error(`[proton] E=${E_eV} eV: CSDA=${(path/np/1000).toFixed(2)} µm, ions=${(ni/np).toFixed(0)}/proton, esc=${esc}, ${ms}ms`);
