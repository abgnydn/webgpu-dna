// E15d — Phase A α/β decomposition + peak throughput across all 8 ESTAR
// energies (100 eV, 300 eV, 500 eV, 1 keV, 3 keV, 5 keV, 10 keV, 20 keV).
//
// E15 measured α/β at 10 keV only. E15d sweeps the full ESTAR validation
// energy range — captures how the per-primary marginal cost β and peak
// throughput scale with primary energy. Higher energies → longer primary
// histories → more work per primary → smaller throughput per unit time.
//
// Drives bench.html via Playwright; reuses runPhaseABench(opts.energyEv)
// for each energy, runs an N-sweep, fits T(N) = α + β·N via OLS.

import { chromium } from 'playwright';

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const ENERGIES_EV = [100, 300, 500, 1000, 3000, 5000, 10000, 20000];
const NS = [256, 1024, 4096, 16384];
const WARMUPS = 3;
const TRIALS = 10;

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

export async function runE15d() {
  const env = captureEnv();
  let server;
  let browser;
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('[E15d pageerror]', e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[E15d console]', msg.text());
    });
    await page.goto(`${server.url}/bench.html`);
    await page.waitForFunction(
      () => window.__benchReady === true || typeof window.__benchError === 'string',
      null,
      { timeout: 60_000 },
    );

    const allResults = [];
    for (const energyEv of ENERGIES_EV) {
      console.error(`[E15d] energy=${energyEv} eV — running N sweep ${JSON.stringify(NS)}`);
      const result = await page.evaluate(
        async ({ Ns, warmups, trials, energyEv, seed, ms }) =>
          window.runPhaseABench({ Ns, warmups, trials, energyEv, seed, ms }),
        { Ns: NS, warmups: WARMUPS, trials: TRIALS, energyEv, seed: SEEDS.E15_DISPATCH, ms: 65536 },
      );
      const Nxs = result.perN.map((p) => p.N);
      const meds = result.perN.map((p) => p.median);
      const { alpha, beta, r2 } = ols(Nxs, meds);
      const peakThroughput = Math.max(
        ...result.perN.map((p) => (p.median > 0 ? p.N / (p.median / 1000) : 0)),
      );
      const tAtN4096 = result.perN.find((p) => p.N === 4096)?.median ?? null;
      allResults.push({ energyEv, perN: result.perN, alpha, beta, r2, peakThroughput, tAtN4096, adapter: result.adapter });
    }

    const rows = allResults.map((r) => ({
      metric: `energy_${r.energyEv}_eV`,
      energyEv: r.energyEv,
      alphaMs: r.alpha,
      alphaUs: r.alpha * 1000,
      betaMsPerPri: r.beta,
      betaUsPerPri: r.beta * 1000,
      r2: r.r2,
      peakThroughput_primaries_per_sec: r.peakThroughput,
      t_at_N4096_ms: r.tAtN4096,
      perN: r.perN.map((p) => ({ N: p.N, median_ms: p.median, std_ms: p.std })),
      status: 'informational',
    }));

    // Pass bar: β should increase monotonically with energy (longer tracks
    // → more work per primary). Allow some noise — at adjacent energies
    // (e.g. 100 vs 300 eV), tracks are short and the launch-bound floor
    // dominates, so β can be noisy. Require monotonic for E ≥ 1 keV
    // (where the kernel is in the variable-β bandwidth regime).
    const E_THRESHOLD = 1000;
    const overThreshold = allResults.filter((r) => r.energyEv >= E_THRESHOLD);
    let monotonic = true;
    for (let i = 1; i < overThreshold.length; i++) {
      if (overThreshold[i].beta < overThreshold[i - 1].beta * 0.9) {
        // allow 10% noise but flag if β actually decreases significantly
        monotonic = false;
        break;
      }
    }
    const status = monotonic ? 'pass' : 'fail';
    const diagnosis = monotonic
      ? null
      : `β is not monotonically increasing with energy above ${E_THRESHOLD} eV — expected longer histories at higher LET should increase β`;

    rows.push({
      metric: 'monotonicity_check',
      threshold_eV: E_THRESHOLD,
      betas_per_energy: overThreshold.map((r) => ({ E: r.energyEv, beta_us_per_pri: r.beta * 1000 })),
      monotonic_at_E_ge_threshold: monotonic,
      status: monotonic ? 'pass' : 'fail',
    });

    const summary = {
      energies: ENERGIES_EV,
      peakThroughput_by_energy: Object.fromEntries(allResults.map((r) => [r.energyEv, r.peakThroughput])),
      beta_us_per_pri_by_energy: Object.fromEntries(allResults.map((r) => [r.energyEv, r.beta * 1000])),
      t_at_N4096_ms_by_energy: Object.fromEntries(allResults.map((r) => [r.energyEv, r.tAtN4096])),
      headline: allResults
        .map((r) => `${r.energyEv}eV: β=${(r.beta * 1000).toFixed(2)} μs/pri, peak=${(r.peakThroughput / 1000).toFixed(0)}k pri/s`)
        .join(' | '),
    };

    const meta = {
      protocol: 'E15d-phase-a-energy-sweep',
      hypothesis:
        'Phase A α/β extracted via OLS on T(N) = α + β·N at 8 ESTAR energies (100 eV → 20 keV). The per-primary marginal cost β should increase monotonically with energy above 1 keV (longer histories = more compute per primary). Peak throughput should decrease correspondingly.',
      passBar:
        'β monotonically non-decreasing with energy for E ≥ 1 keV (allowing 10% MC noise tolerance).',
      seed: `E15_DISPATCH=0x${SEEDS.E15_DISPATCH.toString(16).toUpperCase()}`,
      warmup: WARMUPS,
      trials: TRIALS,
      sources: { harness: 'src/bench.ts', driver: 'experiments/level-6-performance/E15d-phase-a-energy-sweep.mjs' },
      config: { energies: ENERGIES_EV, Ns: NS, ms: 65536 },
    };

    return {
      meta,
      env: { ...env, adapter: allResults[0]?.adapter },
      status,
      diagnosis,
      summary,
      rows,
    };
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
  }
}
