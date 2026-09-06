#!/usr/bin/env node
/**
 * R2 WGSL refactor-parity gate — WGSL_REFACTOR_PARITY_PROTOCOL.md.
 *
 * Runs the PRODUCTION Phase A+B pipeline twice at small N with a fixed
 * seed (via window.runParitySnapshot on bench.html) and requires bit-level
 * parity on everything the GPU wrote. Any future shader refactor must keep
 * this gate green.
 *
 * Comparison rules: counters/scalars/dose exact; rad_buf/rad_e/rad_dep as
 * multisets (the snapshot hashes sorted rows — raw order may vary with
 * atomic scheduling). wallMs is recorded, never compared.
 *
 * Exit codes: 0 PASS, 1 FAIL (per-field report below), 2 environment
 * incapable (no WebGPU / init failure / OOM — adapter limits dumped).
 *
 * Usage: node experiments/tools/wgsl-parity.mjs [--np 16] [--energy 10000] [--hardware]
 *   --hardware uses the native GPU adapter (required for production
 *   dispatches — SwiftShader loses the device; see ARGS_HARDWARE note).
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startDevServer } from '../lib/dev-server.mjs';

// Software-WebGPU flags — same recipe as webgpu-smoke.mjs (SwiftShader CPU
// Vulkan fallback for GPU-less runners).
const ARGS_SWIFTSHADER = [
  '--headless=new',
  '--no-sandbox',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
];

// Hardware flags — same set as the E15 browser driver: native adapter
// (Metal on Apple Silicon). REQUIRED for production dispatches: MEASURED —
// SwiftShader loses the device on the first primary-shader dispatch
// (compiles fine, trivial kernels run), so software WebGPU is
// exit-2-incapable for this gate. Use --hardware.
const ARGS_HARDWARE = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--no-sandbox',
];

const BENCH_PATH = '/bench.html';
const EVAL_TIMEOUT_MS = 1_500_000; // SwiftShader runs the full cascade slowly
const READY_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const out = { np: 16, energyEv: 10000, boxNm: 15000, ceEV: 7.4, hardware: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--np' && argv[i + 1]) out.np = Number(argv[++i]);
    else if (argv[i] === '--energy' && argv[i + 1]) out.energyEv = Number(argv[++i]);
    else if (argv[i] === '--box' && argv[i + 1]) out.boxNm = Number(argv[++i]);
    else if (argv[i] === '--ce' && argv[i + 1]) out.ceEV = Number(argv[++i]);
    else if (argv[i] === '--hardware') out.hardware = true;
  }
  return out;
}

// wallMs excluded (timing, not behavior). adapter compared — same page, same GPU.
const COMPARE_FIELDS = [
  'E', 'np', 'boxNm', 'ceEV', 'n_therm', 'n_esc', 'mean_total', 'mean_ions',
  'cons_ratio', 'total_deposited_eV', 'rad_n_raw', 'rad_n_stored', 'rad_dropped',
  'sec_n', 'sec_tertiary_ions', 'sec_steps', 'kernel_dna_hits', 'doseSum', 'doseHash',
  'radHash', 'radEHash', 'radDepHash',
];

function compare(a, b) {
  const diffs = [];
  if (JSON.stringify(a.counters) !== JSON.stringify(b.counters)) {
    diffs.push(`counters: [${a.counters}] vs [${b.counters}]`);
  }
  for (const f of COMPARE_FIELDS) {
    if (!Object.is(a[f], b[f])) diffs.push(`${f}: ${a[f]} vs ${b[f]}`);
  }
  if (JSON.stringify(a.adapter) !== JSON.stringify(b.adapter)) {
    diffs.push(`adapter changed between runs (should be impossible same-page)`);
  }
  return diffs;
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  let server;
  let browser;
  try {
    server = await startDevServer();
    const ARGS = params.hardware ? ARGS_HARDWARE : ARGS_SWIFTSHADER;
    console.log(`browser flags: ${params.hardware ? 'HARDWARE (native adapter)' : 'SWIFTSHADER (software)'}`);
    browser = await chromium.launch({ headless: false, args: ARGS });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[parity page error]', err.message));
    // Print everything except favicon noise: staging logs ([parity-snap])
    // are the only progress signal during multi-minute software runs.
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('/favicon')) return;
      console.log(`  [page:${msg.type()}] ${t.slice(0, 300)}`);
    });

    await page.goto(`${server.url}${BENCH_PATH}`);
    try {
      await page.waitForFunction(
        () => window.__benchReady === true || typeof window.__benchError === 'string',
        null,
        { timeout: READY_TIMEOUT_MS },
      );
    } catch {
      console.error('✗ bench page never became ready (vite transform or WebGPU init failed)');
      return 2;
    }
    const initErr = await page.evaluate(() => window.__benchError);
    if (initErr) {
      console.error(`✗ bench page init error: ${initErr}`);
      return 2;
    }

    // Pre-flight: adapter identity + the limits that decide whether the
    // ~1.5 GB fixed buffer set can even be allocated. Cheap, no device.
    try {
      const pre = await page.evaluate(async () => {
        const a = await navigator.gpu.requestAdapter();
        if (!a) return null;
        const keep = {};
        for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupsPerDimension']) {
          keep[k] = a.limits[k];
        }
        return { info: a.info ?? {}, limits: keep };
      });
      console.log(`pre-flight adapter: ${JSON.stringify(pre && pre.info)}`);
      console.log(`pre-flight limits: ${JSON.stringify(pre && pre.limits)}`);
    } catch (e) {
      console.error(`✗ pre-flight adapter query failed: ${e.message.split('\n')[0]}`);
      return 2;
    }

    const runs = [];
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now();
      // Fire-and-forget + waitForFunction polling (NOT a single awaited
      // evaluate): this Playwright's evaluate() rejects a 3rd options arg,
      // and the snapshot runs minutes on SwiftShader — past any default
      // action timeout. waitForFunction takes an explicit timeout (E15
      // pattern). The promise result/error lands on window for polling.
      await page.evaluate((p) => {
        window.__parityDone = undefined;
        window.__parityErr = undefined;
        window.runParitySnapshot(p).then(
          (r) => { window.__parityDone = r; },
          (e) => { window.__parityErr = String((e && e.message) || e); },
        );
      }, params);
      try {
        await page.waitForFunction(
          () => window.__parityDone !== undefined || window.__parityErr !== undefined,
          null,
          { timeout: EVAL_TIMEOUT_MS },
        );
      } catch {
        console.error(`✗ snapshot run ${k + 1} timed out after ${EVAL_TIMEOUT_MS / 1000}s (OOM? device loss? too slow?)`);
        return 2;
      }
      const perr = await page.evaluate(() => window.__parityErr);
      if (perr) {
        // Full stack (not just the first line): on SwiftShader the rejection
        // is usually a Dawn/device error whose cause is lines down.
        console.error(`✗ snapshot run ${k + 1} rejected:\n${String(perr).split('\n').slice(0, 15).join('\n')}`);
        return 2;
      }
      const snap = await page.evaluate(() => window.__parityDone);
      if (!snap || !Array.isArray(snap.counters)) {
        console.error(`✗ snapshot run ${k + 1} returned no digest (initGPU null?)`);
        return 2;
      }
      runs.push(snap);
      writeFileSync(`/tmp/wgsl-parity-run${k + 1}.json`, JSON.stringify(snap, null, 1) + '\n');
      console.log(
        `run ${k + 1}: ${(Date.now() - t0) / 1000}s wall, ` +
        `counters=[${snap.counters}], n_therm=${snap.n_therm}, ` +
        `rad_n=${snap.rad_n_stored}, sec_n=${snap.sec_n}, ` +
        `doseHash=${snap.doseHash}, radHash=${snap.radHash}`,
      );
    }

    const diffs = compare(runs[0], runs[1]);
    console.log(`adapter: ${JSON.stringify(runs[0].adapter)}`);
    if (diffs.length === 0) {
      console.log('\n✓ PARITY PASSED — both snapshots identical');
      return 0;
    }
    console.error('\n✗ PARITY FAILED — field diffs (run1 vs run2):');
    for (const d of diffs) console.error(`  - ${d}`);
    return 1;
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
  }
}

const code = await main().catch((e) => {
  console.error(`✗ harness error: ${e.message.split('\n')[0]}`);
  return 2;
});
process.exit(code);
