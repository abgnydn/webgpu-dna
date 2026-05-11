// E11 — GPU chemistry backend (src/shaders/chemistry.wgsl) vs IRT worker
// (public/irt-worker.js) on the SAME rad_buf input.
//
// The GPU chem backend exists in the codebase but the project ships
// `DEFAULT_CHEM_BACKEND='worker'` (the IRT) because the GPU spatial-hash
// reaction kernel is documented as undercounting long-time reactions at
// the 30 ns timestep. This experiment quantifies that gap directly:
// drive the GPU pipeline on the rad_E10000_N4096.bin dump via the new
// bench-chem harness, then compare per-species G-values at every
// checkpoint to the cached IRT result.
//
// Pass bar: |G_gpu - G_irt| / G_irt < 0.20 per species AND per checkpoint
// AT t ≤ 100 ns (where the GPU backend is documented to be adequate).
// At t = 1 μs the GPU backend is known to undercount; that row is
// reported informationally as the diagnosis quantification.

import { chromium } from 'playwright';
import { existsSync, readFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RAD_BIN_SRC = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RAD_BIN_PUBLIC = join(REPO_ROOT, 'public', 'rad_E10000_N4096.bin');
const IRT_CACHE = join(REPO_ROOT, 'experiments', '.cache', 'E10', 'E10000-N4096.json');
const N_PRIMARIES = 4096;
const ENERGY_EV = 10000;

const BROWSER_ARGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--no-sandbox',
];

const STRICT_CHECKPOINT_MAX_NS = 100; // GPU backend documented adequate ≤ 100 ns

export async function runE11() {
  const env = captureEnv();
  const meta = {
    protocol: 'E11-gpu-chem-vs-irt',
    hypothesis:
      'On the same rad_E10000_N4096.bin input, the GPU chemistry backend (src/shaders/chemistry.wgsl) produces G(species) within 20% of the IRT worker at all checkpoints up to t = 100 ns. At t > 100 ns the GPU backend is documented to undercount long-time reactions due to the 30 ns timestep × spatial-hash search radius; that gap is quantified here.',
    passBar:
      'Per species AND per checkpoint at t ≤ 100 ns: |G_gpu / G_irt - 1| < 0.20. t > 100 ns rows reported informationally.',
    seed: `E11_GPU_VS_IRT=0x${SEEDS.E11_GPU_VS_IRT.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      gpuHarness: 'src/bench-chem.ts (drives runChemistry from src/chemistry/schedule.ts)',
      irtCache: IRT_CACHE.replace(REPO_ROOT + '/', ''),
      radBin: RAD_BIN_SRC.replace(REPO_ROOT + '/', ''),
    },
    config: { primaryEnergyEv: ENERGY_EV, nPrimaries: N_PRIMARIES, strictCheckpointMaxNs: STRICT_CHECKPOINT_MAX_NS },
  };

  if (!existsSync(RAD_BIN_SRC)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `rad_buf dump missing: ${RAD_BIN_SRC}`,
      summary: { headline: 'skipped (rad_buf missing)' }, rows: [],
    };
  }
  if (!existsSync(IRT_CACHE)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `IRT cache missing: ${IRT_CACHE}. Run E10 first.`,
      summary: { headline: 'skipped (IRT cache missing)' }, rows: [],
    };
  }

  // Stage the rad bin in public/ so vite serves it. Restore on exit.
  let publicAlreadyStaged = existsSync(RAD_BIN_PUBLIC);
  if (!publicAlreadyStaged) copyFileSync(RAD_BIN_SRC, RAD_BIN_PUBLIC);

  let server;
  let browser;
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('[E11 pageerror]', e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[E11 console]', msg.text());
    });

    await page.goto(`${server.url}/bench-chem.html`);
    await page.waitForFunction(
      () => window.__chemBenchReady === true || typeof window.__chemBenchError === 'string',
      null,
      { timeout: 60_000 },
    );
    const err = await page.evaluate(() => window.__chemBenchError);
    if (err) throw new Error(`bench-chem init failed: ${err}`);

    const gpuResult = await page.evaluate(
      async ({ binUrl, energyEv, nTherm }) =>
        window.runGpuChemBench({ binUrl, energyEv, nTherm }),
      { binUrl: '/rad_E10000_N4096.bin', energyEv: ENERGY_EV, nTherm: N_PRIMARIES },
    );

    // Read IRT timeline from cache.
    const irtCache = JSON.parse(readFileSync(IRT_CACHE, 'utf8'));
    const irtTimeline = irtCache.irtResult.timeline;

    // Match GPU checkpoints to IRT checkpoints by t_ns (closest within 10%).
    const SPECIES = ['G_OH', 'G_eaq', 'G_H', 'G_H2O2', 'G_H2'];
    const rows = [];
    let nStrictFail = 0;
    let nStrictPass = 0;

    for (const gpuCp of gpuResult.timeline) {
      if (gpuCp.t_ns === 0) continue; // skip t=0 — IRT starts at 1 ps
      const irtCp = irtTimeline.find(
        (c) => Math.abs(c.t_ns - gpuCp.t_ns) / Math.max(c.t_ns, 1e-6) < 0.1,
      );
      if (!irtCp) {
        rows.push({
          metric: `checkpoint_${gpuCp.label}`,
          gpu_t_ns: gpuCp.t_ns,
          status: 'informational',
          note: 'no matching IRT checkpoint',
        });
        continue;
      }
      const strict = gpuCp.t_ns <= STRICT_CHECKPOINT_MAX_NS;
      for (const k of SPECIES) {
        const gpuG = gpuCp[k];
        const irtG = irtCp[k];
        if (irtG === 0 && gpuG === 0) continue;
        const ratio = irtG > 0 ? gpuG / irtG : null;
        const relErr = ratio !== null ? Math.abs(ratio - 1) : null;
        const passed = strict ? (relErr ?? Infinity) < 0.20 : null;
        if (strict) {
          if (passed) nStrictPass++; else nStrictFail++;
        }
        rows.push({
          metric: `species_${k}_at_${gpuCp.label}`,
          t_ns: gpuCp.t_ns,
          G_gpu: gpuG,
          G_irt: irtG,
          ratio,
          relErr,
          strict,
          status: !strict ? 'informational' : passed ? 'pass' : 'fail',
        });
      }
    }

    rows.push({
      metric: 'gpu_walltime_ms',
      gpu_walltime_ms: gpuResult.walltimeMs,
      gpu_rad_n: gpuResult.radN,
      gpu_bin_bytes: gpuResult.binBytes,
      status: 'informational',
    });

    const status = nStrictFail === 0 ? 'pass' : 'fail';
    const totalStrict = nStrictPass + nStrictFail;
    let diagnosis = null;
    if (status === 'fail') {
      diagnosis = `${nStrictFail}/${totalStrict} strict (t ≤ ${STRICT_CHECKPOINT_MAX_NS} ns) species×checkpoint cells failed the 20% band`;
    }

    // Summary: per-species ratios at the latest checkpoint and at 1 μs (the documented gap point).
    const at1us = gpuResult.timeline.find((c) => c.label === '1 μs' || c.label === '1 us' || Math.abs(c.t_ns - 1000) < 1);
    const irtAt1us = irtTimeline.find((c) => Math.abs(c.t_ns - 1000) < 1);
    const gpuLast = gpuResult.timeline[gpuResult.timeline.length - 1];

    const summary = {
      nPrimaries: N_PRIMARIES,
      primaryEnergyEv: ENERGY_EV,
      nStrictPass,
      nStrictFail,
      gpuWalltimeMs: gpuResult.walltimeMs,
      gpu_at_1us: at1us
        ? {
            G_OH: at1us.G_OH, G_eaq: at1us.G_eaq, G_H: at1us.G_H,
            G_H2O2: at1us.G_H2O2, G_H2: at1us.G_H2,
          }
        : null,
      irt_at_1us: irtAt1us
        ? {
            G_OH: irtAt1us.G_OH, G_eaq: irtAt1us.G_eaq, G_H: irtAt1us.G_H,
            G_H2O2: irtAt1us.G_H2O2, G_H2: irtAt1us.G_H2,
          }
        : null,
      ratio_at_1us:
        at1us && irtAt1us && irtAt1us.G_OH > 0
          ? {
              OH: at1us.G_OH / irtAt1us.G_OH,
              eaq: at1us.G_eaq / irtAt1us.G_eaq,
              H: at1us.G_H / irtAt1us.G_H,
              H2O2: at1us.G_H2O2 / irtAt1us.G_H2O2,
              H2: at1us.G_H2 / irtAt1us.G_H2,
            }
          : null,
      headline:
        at1us && irtAt1us
          ? `Strict ≤ ${STRICT_CHECKPOINT_MAX_NS} ns: ${nStrictPass}/${totalStrict} pass. At 1 μs: G(OH) ${at1us.G_OH.toFixed(2)}/${irtAt1us.G_OH.toFixed(2)} (${(at1us.G_OH / irtAt1us.G_OH).toFixed(2)}×), G(eaq) ${at1us.G_eaq.toFixed(2)}/${irtAt1us.G_eaq.toFixed(2)} (${(at1us.G_eaq / irtAt1us.G_eaq).toFixed(2)}×)`
          : `Strict ≤ ${STRICT_CHECKPOINT_MAX_NS} ns: ${nStrictPass}/${totalStrict} pass.`,
    };

    return {
      meta,
      env: { ...env, adapter: gpuResult.adapter },
      status,
      diagnosis,
      summary,
      rows,
    };
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (!publicAlreadyStaged && existsSync(RAD_BIN_PUBLIC)) rmSync(RAD_BIN_PUBLIC);
  }
}
