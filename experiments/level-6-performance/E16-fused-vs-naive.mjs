// E16 — Fused single-dispatch vs naive per-step dispatch (kernel-fusion
// thesis closure).
//
// The whole project's marquee claim is that running the *entire* per-primary
// physics history inside one fused WGSL `for(s<ms)` loop is dramatically
// faster than the alternative architecture: one dispatch per physics step
// (the "naive" baseline). E15 measured the per-N latency of the fused path;
// E15b measured the speedup vs Geant4 single-thread. E16 closes the loop by
// measuring the within-WebGPU "naive vs fused" ratio directly.
//
// Method:
//   - The bench harness (src/bench.ts) now accepts an `ms` parameter that
//     overrides the primary kernel's max-steps-per-dispatch from the
//     production 65536 (fused) down to 1 (single-step naive).
//   - Run two N-sweeps at 10 keV:
//       (a) `ms=65536`: fused path — one dispatch advances each primary
//                       through its full thermalization history (typical
//                       ~414 steps at 10 keV per the Geant4 ntuple stats).
//       (b) `ms=1`:     naive baseline — each dispatch advances every
//                       primary by exactly one step. The harness measures
//                       a SINGLE such dispatch; to model the full naive
//                       wall-clock you multiply by mean_steps_per_primary
//                       (414 from `validation/g4_per_event.csv`-derived
//                       step count at 10 keV).
//   - Speedup = (mean_steps × T_naive_single_step) / T_fused.
//
// Pass bar (per L6 protocol):
//   `t_naive / t_fused ≥ 100` at N=4096, E=10 keV.

import { chromium } from 'playwright';

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const N_PRIMARIES = 4096;
const ENERGY_EV = 10000;
const WARMUPS = 5;
const TRIALS = 20;
// Mean primary-only step count per primary at 10 keV, sourced from the
// Geant4 11.4.1 ntuple `validation/g4_per_event.csv` companion stats
// (analyze_g4.py reports 413.9 ± 115.4). The naive baseline scales
// linearly with this multiplier.
const MEAN_STEPS_PER_PRIMARY_10KEV = 414;

const BROWSER_ARGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--no-sandbox',
];

function stats(xs) {
  if (xs.length === 0) return { median: 0, mean: 0, std: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.length > 1
    ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
    : 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  return { median, mean, std: Math.sqrt(v), min: s[0], max: s[n - 1] };
}

export async function runE16({
  Ns = [N_PRIMARIES],
  warmups = WARMUPS,
  trials = TRIALS,
  energyEv = ENERGY_EV,
  meanStepsPerPrimary = MEAN_STEPS_PER_PRIMARY_10KEV,
} = {}) {
  const env = captureEnv();
  let server;
  let browser;
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[E16 pageerror]', e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[E16 console]', msg.text());
    });

    await page.goto(`${server.url}/bench.html`);
    await page.waitForFunction(
      () => window.__benchReady === true || typeof window.__benchError === 'string',
      null,
      { timeout: 60_000 },
    );
    const errMsg = await page.evaluate(() => window.__benchError);
    if (errMsg) throw new Error(`bench page failed: ${errMsg}`);

    // (a) Fused path: ms = 65536, the production setting.
    const fused = await page.evaluate(
      async ({ Ns, warmups, trials, energyEv, seed, ms }) =>
        window.runPhaseABench({ Ns, warmups, trials, energyEv, seed, ms }),
      { Ns, warmups, trials, energyEv, seed: SEEDS.E16_FUSED_VS_NAIVE, ms: 65536 },
    );

    // (b) Naive per-step: ms = 1, one inner-loop iteration per dispatch.
    const naive = await page.evaluate(
      async ({ Ns, warmups, trials, energyEv, seed, ms }) =>
        window.runPhaseABench({ Ns, warmups, trials, energyEv, seed, ms }),
      { Ns, warmups, trials, energyEv, seed: SEEDS.E16_FUSED_VS_NAIVE + 1, ms: 1 },
    );

    const rows = [];
    let speedup = null;
    let passed = false;

    for (let i = 0; i < Ns.length; i++) {
      const N = Ns[i];
      const fusedRow = fused.perN.find((p) => p.N === N);
      const naiveRow = naive.perN.find((p) => p.N === N);
      if (!fusedRow || !naiveRow) continue;
      const tFusedMs = fusedRow.median;
      const tNaiveSingleStepMs = naiveRow.median;
      const tNaiveTotalMs = tNaiveSingleStepMs * meanStepsPerPrimary;
      const ratio = tNaiveTotalMs / tFusedMs;
      const passedThisN = ratio >= 100;
      if (N === N_PRIMARIES) {
        speedup = ratio;
        passed = passedThisN;
      }
      rows.push({
        metric: `speedup_at_N${N}`,
        N,
        t_fused_ms_median: tFusedMs,
        t_naive_per_step_ms_median: tNaiveSingleStepMs,
        mean_steps_per_primary: meanStepsPerPrimary,
        t_naive_total_ms_modeled: tNaiveTotalMs,
        speedup_naive_over_fused: ratio,
        passBar: 'speedup ≥ 100 (L6 thesis)',
        status: passedThisN ? 'pass' : 'fail',
      });
    }

    rows.push({
      metric: 'trial_distribution_fused',
      ms: 65536,
      ...stats(fused.perN.find((p) => p.N === N_PRIMARIES)?.trialsMs ?? []),
      status: 'informational',
    });
    rows.push({
      metric: 'trial_distribution_naive_per_step',
      ms: 1,
      ...stats(naive.perN.find((p) => p.N === N_PRIMARIES)?.trialsMs ?? []),
      status: 'informational',
    });
    rows.push({
      metric: 'naive_model_assumption',
      mean_steps_per_primary_at_10keV: meanStepsPerPrimary,
      source: 'Geant4 11.4.1 dnaphysics ntuple, primary trackID=1 step count, 4096 events',
      note:
        'The modeled naive wall-clock = N_steps × T(ms=1). This assumes per-dispatch overhead dominates each step (consistent with E15: α ≈ 10.5 ms vs β·N ≈ 5 ms at N=4096). A real per-step implementation would also need a primary-state buffer to persist between dispatches, costing an additional read/write per step; the modeled number is a LOWER bound on the actual naive cost.',
      status: 'informational',
    });

    const meta = {
      protocol: 'E16-fused-vs-naive',
      hypothesis:
        'The production fused primary-tracking dispatch is ≥ 100× faster than a naive baseline that submits one dispatch per physics step. At N=4096 primaries, E=10 keV, the naive total wall-clock = mean_steps_per_primary × T(ms=1, N=4096), where mean_steps_per_primary = 414 from the Geant4 11.4.1 ntuple.',
      passBar:
        'speedup_naive_over_fused = (414 × T_single_step) / T_fused ≥ 100 at N=4096, 10 keV.',
      seed: `E16_FUSED_VS_NAIVE=0x${SEEDS.E16_FUSED_VS_NAIVE.toString(16).toUpperCase()}`,
      warmup: warmups,
      trials,
      sources: {
        harness: 'src/bench.ts (extended 2026-05-11 with ms parameter)',
        driver: 'experiments/level-6-performance/E16-fused-vs-naive.mjs',
        nStepsReference: 'validation/g4_per_event.csv (derived: primary trackID=1 step count)',
      },
      config: {
        Ns,
        energyEv,
        meanStepsPerPrimary,
        msFused: 65536,
        msNaive: 1,
      },
    };

    return {
      meta,
      env: {
        ...env,
        adapter: fused.adapter,
        limits: fused.limits,
      },
      status: passed ? 'pass' : 'fail',
      diagnosis: passed
        ? null
        : `speedup ${speedup?.toFixed(1)}× < 100× at N=${N_PRIMARIES}, 10 keV`,
      summary: {
        N: N_PRIMARIES,
        energyEv,
        meanStepsPerPrimary,
        t_fused_ms: fused.perN.find((p) => p.N === N_PRIMARIES)?.median ?? null,
        t_naive_single_step_ms: naive.perN.find((p) => p.N === N_PRIMARIES)?.median ?? null,
        t_naive_total_ms_modeled: speedup
          ? (naive.perN.find((p) => p.N === N_PRIMARIES)?.median ?? 0) * meanStepsPerPrimary
          : null,
        speedup_naive_over_fused: speedup,
        headline: speedup
          ? `T_fused=${(fused.perN.find((p) => p.N === N_PRIMARIES)?.median ?? 0).toFixed(2)} ms vs modeled T_naive=${((naive.perN.find((p) => p.N === N_PRIMARIES)?.median ?? 0) * meanStepsPerPrimary).toFixed(0)} ms (${meanStepsPerPrimary} steps × ${(naive.perN.find((p) => p.N === N_PRIMARIES)?.median ?? 0).toFixed(2)} ms/step) → ${speedup.toFixed(0)}× speedup`
          : 'no data',
      },
      rows,
    };
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
  }
}
