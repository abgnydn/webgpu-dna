// E15 — Phase A wall-clock decomposition T(N) = α + β·N.
//
// Drives bench.html via Playwright + headless Chromium WebGPU. The page
// exposes window.runPhaseABench, which dispatches the production primary
// WGSL kernel at N ∈ {1, 4, 16, 64, 256, 1024, 4096, 16384}, with
// WARMUPS warmup trials (discarded) and TRIALS measured trials per N.
//
// Per-trial timing = one full encode + submit + onSubmittedWorkDone
// (Phase A only — no Phase B, no chemistry, no DNA readback). Each trial
// reseeds the RNG and zeros the atomic counters / dose grid, so the
// measured cost is the dispatch + GPU compute + driver sync, not buffer
// allocation.
//
// We then OLS-fit T(N) = α + β·N on the per-N medians and report (α, β, R²).
//
// Pass bar (per experiments/level-6-performance/protocol.md):
//   α ∈ [10, 500] μs  AND  β > 0  AND  R² ≥ 0.85
// "Noisy" if > 50% of cells have std/median > 0.10.

import { chromium } from 'playwright';

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const NS_DEFAULT = [1, 4, 16, 64, 256, 1024, 4096, 16384];
const WARMUPS = 5;
const TRIALS = 20;
const ENERGY_EV = 10000;
const BENCH_PATH = '/bench.html';

const BROWSER_ARGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--no-sandbox',
];

function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return { alpha: NaN, beta: NaN, r2: NaN };
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xbar) * (ys[i] - ybar);
    den += (xs[i] - xbar) ** 2;
  }
  const beta = den === 0 ? 0 : num / den;
  const alpha = ybar - beta * xbar;
  const yhat = xs.map((x) => alpha + beta * x);
  const ssRes = ys.reduce((s, y, i) => s + (y - yhat[i]) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - ybar) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { alpha, beta, r2 };
}

export async function runE15({
  Ns = NS_DEFAULT,
  warmups = WARMUPS,
  trials = TRIALS,
  energyEv = ENERGY_EV,
} = {}) {
  const env = captureEnv();
  let server;
  let browser;
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('pageerror', (err) => {
      console.error('[bench page error]', err.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[bench console]', msg.text());
    });

    await page.goto(`${server.url}${BENCH_PATH}`);
    await page.waitForFunction(
      () => window.__benchReady === true || typeof window.__benchError === 'string',
      null,
      { timeout: 60_000 },
    );
    const errMsg = await page.evaluate(() => window.__benchError);
    if (errMsg) throw new Error(`bench page failed to initialize: ${errMsg}`);

    const result = await page.evaluate(
      async ({ Ns, warmups, trials, energyEv, seed }) => {
        return window.runPhaseABench({ Ns, warmups, trials, energyEv, seed });
      },
      { Ns, warmups, trials, energyEv, seed: SEEDS.E15_DISPATCH },
    );

    // OLS fit on medians
    const Nxs = result.perN.map((p) => p.N);
    const meds = result.perN.map((p) => p.median);
    const { alpha, beta, r2 } = ols(Nxs, meds);

    const alphaUs = alpha * 1000;
    const betaUsPerPri = beta * 1000;

    const alphaPass = alphaUs >= 10 && alphaUs <= 500;
    const betaPass = beta > 0;
    const r2Pass = r2 >= 0.85;
    const noisyCells = result.perN.filter((p) => p.median > 0 && p.std / p.median > 0.10).length;
    const isNoisy = noisyCells / result.perN.length > 0.5;

    let status = 'pass';
    let diagnosis = null;
    if (isNoisy) {
      status = 'noisy';
      diagnosis = `${noisyCells}/${result.perN.length} cells flagged std/median > 0.10`;
    } else if (!alphaPass || !betaPass || !r2Pass) {
      status = 'fail';
      const parts = [];
      if (!alphaPass) parts.push(`α=${alphaUs.toFixed(1)} μs ∉ [10, 500]`);
      if (!betaPass) parts.push(`β=${beta.toExponential(3)} (must be > 0)`);
      if (!r2Pass) parts.push(`R²=${r2.toFixed(3)} < 0.85`);
      diagnosis = parts.join('; ');
    }

    const rows = result.perN.map((p) => ({
      N: p.N,
      median_ms: p.median,
      mean_ms: p.mean,
      std_ms: p.std,
      min_ms: p.min,
      max_ms: p.max,
      cv: p.median > 0 ? p.std / p.median : null,
      trialsMs: p.trialsMs,
    }));

    const artifact = {
      meta: {
        protocol: 'E15-phase-a-alpha-beta',
        hypothesis:
          'Phase A wall-clock decomposes as T(N) = α + β·N. With WARMUPS=5 warmups + TRIALS=20 measured trials per N and a fused-dispatch primary kernel, α ∈ [10, 500] μs and β > 0 and the OLS fit on per-N medians has R² ≥ 0.85.',
        passBar:
          'α ∈ [10, 500] μs AND β > 0 AND R² ≥ 0.85; noisy if > 50% of cells have std/median > 0.10.',
        seed: `E15_DISPATCH=0x${SEEDS.E15_DISPATCH.toString(16).toUpperCase()}`,
        warmup: warmups,
        trials,
        sources: {
          harness: 'src/bench.ts',
          page: 'bench.html',
          driver: 'experiments/level-6-performance/E15-phase-a-alpha-beta.mjs',
        },
        config: { Ns, energyEv, boxNm: 15000, ceEV: 7.4 },
      },
      env: {
        ...env,
        adapter: result.adapter,
        limits: result.limits,
      },
      status,
      diagnosis,
      summary: {
        energyEv,
        Ns,
        alphaMs: alpha,
        alphaUs,
        betaMsPerPrimary: beta,
        betaUsPerPrimary: betaUsPerPri,
        r2,
        headline: `α=${alphaUs.toFixed(1)} μs, β=${betaUsPerPri.toFixed(3)} μs/primary, R²=${r2.toFixed(3)}`,
        peakThroughputPrimariesPerSec: (() => {
          let best = 0;
          for (const p of result.perN) {
            if (p.median > 0) {
              const tp = p.N / (p.median / 1000);
              if (tp > best) best = tp;
            }
          }
          return best;
        })(),
      },
      rows,
    };

    return artifact;
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
  }
}
