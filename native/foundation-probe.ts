// webgpu-dna-native — foundation probe.
// Proves wgpu-native (via Deno) (1) runs WGSL compute on the local GPU and
// (2) compiles the actual production shaders verbatim. Run:
//   deno run --unstable-webgpu --allow-read native/foundation-probe.ts
const HERE = import.meta.dirname!;
const ROOT = `${HERE}/..`;

const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) { console.error("NO ADAPTER"); Deno.exit(1); }
const device = await adapter.requestDevice();

// (1) trivial compute round-trip
const WGSL = `@group(0) @binding(0) var<storage, read_write> d: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x; if (i < arrayLength(&d)) { d[i] = d[i] * 2.0 + 1.0; } }`;
const n = 4096, input = new Float32Array(n).map((_, i) => i);
const buf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(buf, 0, input);
const rb = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const pl = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "main" } });
const bg = device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
const enc = device.createCommandEncoder();
const p = enc.beginComputePass(); p.setPipeline(pl); p.setBindGroup(0, bg); p.dispatchWorkgroups(n / 64); p.end();
enc.copyBufferToBuffer(buf, 0, rb, 0, input.byteLength); device.queue.submit([enc.finish()]);
await rb.mapAsync(GPUMapMode.READ);
const out = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap();
console.log("compute round-trip:", out[0] === 1 && out[5] === 11 ? "✅ pass" : "❌ fail", `(out[0..5]=${[...out.slice(0,5)]})`);

// (2) production shaders compile verbatim
const xs = await Deno.readTextFile(`${ROOT}/public/cross_sections.wgsl`);
const helpers = await Deno.readTextFile(`${ROOT}/src/shaders/helpers.wgsl`);
for (const k of ["primary", "secondary"]) {
  const code = `${xs}\n${helpers}\n${await Deno.readTextFile(`${ROOT}/src/shaders/${k}.wgsl`)}`;
  device.pushErrorScope("validation");
  const info = await device.createShaderModule({ code, label: k }).getCompilationInfo();
  const scope = await device.popErrorScope();
  const errs = info.messages.filter((m) => m.type === "error").length;
  console.log(`${k}.wgsl compile:`, errs === 0 && !scope ? "✅ pass" : `❌ ${errs} errors`);
}
