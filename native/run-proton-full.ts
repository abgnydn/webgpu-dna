// Full proton chain: Phase A (proton) -> Phase B (electron cascade) -> rad dump.
// Demonstrates protons producing the complete radiolysis via the EXISTING cascade.
//   deno run --unstable-webgpu --allow-read --allow-write --allow-env native/run-proton-full.ts [E_eV] [N]
import { initGPU } from "../src/gpu/device.ts";
import { allocateBuffers } from "../src/gpu/buffers.ts";

const HERE = import.meta.dirname!; const ROOT = `${HERE}/..`;
const read = (f: string) => Deno.readTextFile(`${ROOT}/${f}`);
const xs = await read("public/cross_sections.wgsl");
const pxs = await read("public/proton_cross_sections.wgsl");
const helpers = await read("src/shaders/helpers.wgsl");
const protonWgsl = await read("src/shaders/proton.wgsl");
const secondaryWgsl = await read("src/shaders/secondary.wgsl");

const E_eV = Number(Deno.args[0] ?? 1_000_000);
const np = Number(Deno.args[1] ?? 1);
const boxNm = 40_000;            // 40 µm half-width — contains a ~1 MeV proton track
const MAX_SEC = 5_000_000, MAX_RAD = 16_000_000, VC = 128, MAX_SEC_STEPS = 2000;

const device = await initGPU((m) => console.error(`[init] ${m}`));
if (!device) Deno.exit(1);
const b = allocateBuffers(device, Math.max(np, 256));

async function compile(code: string, label: string) {
  device.pushErrorScope("validation");
  const m = device.createShaderModule({ code, label });
  const info = await m.getCompilationInfo(); const err = await device.popErrorScope();
  const errs = info.messages.filter((x) => x.type === "error");
  if (errs.length || err) { for (const e of errs) console.error(`${label} ${e.lineNum}: ${e.message}`); if (err) console.error(err.message); Deno.exit(1); }
  return m;
}
const pMod = await compile(`${xs}\n${pxs}\n${helpers}\n${protonWgsl}`, "proton");
const sMod = await compile(`${xs}\n${helpers}\n${secondaryWgsl}`, "secondary");

const stor = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } });
const unif = (n: number) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } });
const pLayout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4), stor(5), stor(6), stor(7)] });
const protonBG = device.createBindGroup({ layout: pLayout, entries: [
  { binding: 0, resource: { buffer: b.params } }, { binding: 1, resource: { buffer: b.results } }, { binding: 2, resource: { buffer: b.rng } },
  { binding: 3, resource: { buffer: b.dbg } }, { binding: 4, resource: { buffer: b.radBuf } }, { binding: 5, resource: { buffer: b.secBuf } },
  { binding: 6, resource: { buffer: b.dose } }, { binding: 7, resource: { buffer: b.counters } }] });
const protonPipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [pLayout] }), compute: { module: pMod, entryPoint: "main" } });

const sLayout = device.createBindGroupLayout({ entries: [unif(0), stor(1), stor(2), stor(3), stor(4), stor(5)] });
const secBG = device.createBindGroup({ layout: sLayout, entries: [
  { binding: 0, resource: { buffer: b.secParams } }, { binding: 1, resource: { buffer: b.secBuf } }, { binding: 2, resource: { buffer: b.secStats } },
  { binding: 3, resource: { buffer: b.dose } }, { binding: 4, resource: { buffer: b.counters } }, { binding: 5, resource: { buffer: b.radBuf } }] });
const secPipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [sLayout] }), compute: { module: sMod, entryPoint: "step" } });

// init
device.queue.writeBuffer(b.dbg, 0, new Uint32Array(8));
device.queue.writeBuffer(b.secStats, 0, new Uint32Array(8));
device.queue.writeBuffer(b.counters, 0, new Uint32Array(8));
device.queue.writeBuffer(b.dose, 0, new Uint32Array(VC * VC * VC));
const pbuf = new ArrayBuffer(64); const pu = new Uint32Array(pbuf); const pf = new Float32Array(pbuf);
pu[0] = np; pf[1] = boxNm; pf[2] = 7.4; pu[3] = 2_000_000; pf[4] = E_eV; pu[5] = MAX_SEC; pu[6] = VC; pu[7] = MAX_RAD;
device.queue.writeBuffer(b.params, 0, pbuf);
const rngInit = new Uint32Array(Math.max(np, 256) * 4);
for (let i = 0; i < rngInit.length; i++) rngInit[i] = (0x9e3779b9 * (i + 1) + E_eV) >>> 0;
device.queue.writeBuffer(b.rng, 0, rngInit);

const t0 = performance.now();
// Phase A: proton
{
  const enc = device.createCommandEncoder(); const pass = enc.beginComputePass();
  pass.setPipeline(protonPipe); pass.setBindGroup(0, protonBG); pass.dispatchWorkgroups(Math.ceil(np / 64)); pass.end();
  enc.copyBufferToBuffer(b.counters, 0, b.countersRB, 0, 32); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone();
}
await b.countersRB.mapAsync(GPUMapMode.READ);
let cc = new Uint32Array(b.countersRB.getMappedRange().slice(0) as ArrayBuffer); b.countersRB.unmap();
const sec_n0 = Math.min(cc[6], MAX_SEC);
console.error(`[proton-full] Phase A: ejected ${sec_n0} electrons, ${cc[0]} OH, ${cc[3]} H3O+`);

// Phase B: chunked cascade
const writeSec = (secN: number) => { const s = new ArrayBuffer(48); const su = new Uint32Array(s); const sf = new Float32Array(s);
  su[0] = secN; sf[1] = boxNm; sf[2] = 7.4; su[3] = VC; su[4] = MAX_RAD; su[5] = 0; su[6] = 0; su[7] = MAX_SEC; device.queue.writeBuffer(b.secParams, 0, s); };
let cur = sec_n0, base = 0;
while (base < MAX_SEC_STEPS && cur > 0) {
  const steps = Math.min(100, MAX_SEC_STEPS - base); writeSec(cur);
  const enc = device.createCommandEncoder(); const pass = enc.beginComputePass();
  pass.setPipeline(secPipe); pass.setBindGroup(0, secBG); const wg = Math.ceil(cur / 256);
  for (let st = 0; st < steps; st++) pass.dispatchWorkgroups(wg); pass.end();
  enc.copyBufferToBuffer(b.counters, 0, b.countersRB, 0, 32); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone();
  await b.countersRB.mapAsync(GPUMapMode.READ); const grown = Math.min(new Uint32Array(b.countersRB.getMappedRange().slice(0) as ArrayBuffer)[6], MAX_SEC); b.countersRB.unmap();
  base += steps; if (grown === cur) break; cur = grown;
}
if (base < MAX_SEC_STEPS) { writeSec(cur);
  const enc = device.createCommandEncoder(); const pass = enc.beginComputePass(); pass.setPipeline(secPipe); pass.setBindGroup(0, secBG);
  const wg = Math.ceil(cur / 256); for (let st = base; st < MAX_SEC_STEPS; st++) pass.dispatchWorkgroups(wg); pass.end();
  device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); }

// read rad_n + species
const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(b.counters, 0, b.countersRB, 0, 32); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone();
await b.countersRB.mapAsync(GPUMapMode.READ); cc = new Uint32Array(b.countersRB.getMappedRange().slice(0) as ArrayBuffer); b.countersRB.unmap();
const rad_n = Math.min(cc[7], MAX_RAD);
const rrb = device.createBuffer({ size: rad_n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const e2 = device.createCommandEncoder(); e2.copyBufferToBuffer(b.radBuf, 0, rrb, 0, rad_n * 16); device.queue.submit([e2.finish()]); await device.queue.onSubmittedWorkDone();
await rrb.mapAsync(GPUMapMode.READ); const fr = new Float32Array(rrb.getMappedRange());
const sp = new Array(8).fill(0); for (let i = 0; i < rad_n; i++) sp[Math.round(fr[i * 4 + 3]) & 7]++;
await Deno.writeFile(`${ROOT}/dumps/rad_proton_E${E_eV}.bin`, new Uint8Array(rrb.getMappedRange())); rrb.unmap();
const ms = (performance.now() - t0).toFixed(0);
console.log(JSON.stringify({ E_eV, np, rad_n, OH: sp[0] / np, eaq: sp[1] / np, H3Op: sp[3] / np, H2: sp[7] / np, wall_ms: Number(ms) }));
console.error(`[proton-full] E=${E_eV}: rad_n=${rad_n}, OH=${(sp[0]/np).toFixed(0)} eaq=${(sp[1]/np).toFixed(0)} H2=${(sp[7]/np).toFixed(0)}/proton, ${ms}ms`);
