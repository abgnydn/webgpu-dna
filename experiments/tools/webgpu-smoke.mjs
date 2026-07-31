#!/usr/bin/env node
/**
 * Headless WebGPU smoke test — the piece the unit suite cannot cover.
 *
 * `npm run check` (typecheck + lint + vitest) never touches a GPU, so the core
 * WGSL physics is unverified in CI. This brings up a *software* WebGPU adapter
 * (Mesa lavapipe / SwiftShader — see .github/workflows/webgpu-smoke.yml) in
 * headless Chromium and checks two things:
 *
 *   1. RUNTIME: a trivial compute shader (out[i] = in[i] + 1) dispatches and
 *      reads back correctly — proves WebGPU compute works end-to-end.
 *   2. PHYSICS WGSL: the REAL shipped shaders compile with zero errors. The
 *      bundles are assembled exactly as src/shaders/loader.ts does
 *      (cross_sections + helpers + kernel), so a WGSL syntax/validation
 *      regression — undefined symbol, bad binding, type error — fails CI. This
 *      is a class of bug vitest cannot see (it can't compile WGSL).
 *
 * It does NOT re-validate physics numbers (a software adapter at small N is too
 * noisy and vendor-dependent for that — see README §Numbers reproducibility
 * tiers). It is a smoke test: "does the real pipeline still run on a GPU?".
 *
 * Run locally (needs a WebGPU-capable Chromium + adapter):
 *   node experiments/tools/webgpu-smoke.mjs
 * Exit 0 = pass, non-zero = fail.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Assemble the production bundles exactly like src/shaders/loader.ts.
const xs = read('public/cross_sections.wgsl');
const helpers = read('src/shaders/helpers.wgsl');
const pxs = read('public/proton_cross_sections.wgsl');
const bundles = [
  { name: 'primary', code: `${xs}\n${helpers}\n${read('src/shaders/primary.wgsl')}` },
  { name: 'secondary', code: `${xs}\n${helpers}\n${read('src/shaders/secondary.wgsl')}` },
  { name: 'chemistry', code: read('src/shaders/chemistry.wgsl') },
  { name: 'proton', code: `${xs}\n${pxs}\n${helpers}\n${read('src/shaders/proton.wgsl')}` },
];

// Software-WebGPU args. --enable-unsafe-swiftshader lets WebGPU fall back to
// SwiftShader (CPU Vulkan) on a GPU-less runner; --use-angle=vulkan + Vulkan
// feature pairs with a Mesa lavapipe ICD when present. This is the Chrome
// headless-WebGPU recipe (per the Colab/Chrome guidance).
const ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
];

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><title>webgpu-smoke</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`; // localhost = secure context → navigator.gpu

let browser;
let exitCode = 1;
try {
  browser = await chromium.launch({ headless: false, args: ARGS });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => console.log(`  [page] ${m.text()}`));
  await page.goto(url);

  const out = await page.evaluate(async (bundles) => {
    if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu missing (not a secure context / no WebGPU)' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'requestAdapter() returned null (no adapter — software Vulkan/SwiftShader not available?)' };
    const device = await adapter.requestDevice();
    const info = adapter.info ?? {};

    // 1) RUNTIME: trivial compute + readback.
    const data = new Uint32Array([10, 20, 30, 40]);
    const inBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inBuf, 0, data);
    const outBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const trivMod = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage,read> inp: array<u32>;
      @group(0) @binding(1) var<storage,read_write> outp: array<u32>;
      @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) g: vec3<u32>) { outp[g.x] = inp[g.x] + 1u; }` });
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: trivMod, entryPoint: 'main' } });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } } ] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(1); pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 16);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const runtime = Array.from(new Uint32Array(readBuf.getMappedRange().slice(0)));
    const runtimeOk = runtime.join(',') === '11,21,31,41';

    // 2) PHYSICS WGSL: compile the real shipped bundles, collect errors.
    const compiles = [];
    for (const b of bundles) {
      device.pushErrorScope('validation');
      const mod = device.createShaderModule({ code: b.code });
      const ci = await mod.getCompilationInfo();
      const errs = ci.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
      const valErr = await device.popErrorScope();
      if (valErr) errs.push(`validation: ${valErr.message}`);
      compiles.push({ name: b.name, errors: errs });
    }

    return {
      ok: true,
      adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' },
      runtime, runtimeOk, compiles,
    };
  }, bundles);

  if (!out.ok) {
    console.error(`✗ WebGPU unavailable: ${out.reason}`);
  } else {
    console.log(`adapter: ${JSON.stringify(out.adapter)}`);
    console.log(`runtime compute: [${out.runtime}] ${out.runtimeOk ? '✓' : '✗ expected 11,21,31,41'}`);
    let compileOk = true;
    for (const c of out.compiles) {
      if (c.errors.length) { compileOk = false; console.error(`✗ ${c.name}.wgsl compile errors:\n    ${c.errors.join('\n    ')}`); }
      else console.log(`compiled ${c.name}.wgsl ✓`);
    }
    if (out.runtimeOk && compileOk) { console.log('\n✓ WebGPU smoke PASSED'); exitCode = 0; }
    else console.error('\n✗ WebGPU smoke FAILED');
  }
} catch (e) {
  console.error(`✗ smoke harness error: ${e.message.split('\n')[0]}`);
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(exitCode);
