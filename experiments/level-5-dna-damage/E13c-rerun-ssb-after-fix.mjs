// E13c — Re-validate SSB scoring after the SSB_R_DAMAGE_NM fix (0.29 → 1.0 nm).
//
// E13b's Node-side parametric scorer predicted SSB_ind ≈ 174 at r=1.0 nm
// on pre-chemistry positions; with chemistry diffusion smearing (3-4×)
// the actual browser-harness number should land at ~50-70. E13c drives
// the real validation harness in headless Chromium, runs the full 8-energy
// validation (N=4096 primaries, IRT chemistry on at 10 keV, DNA scoring
// at 10 keV), and parses the "DAMAGE:" log line emitted by src/app.ts:199.
//
// Pass bar: refreshed SSB_ind ≥ 24 (matching observed SSB_dir at least),
// i.e. indirect/direct ratio ≥ 1.0. PARTRAC target is 2-3; honest bar is
// "much higher than the previous 0" with a sane lower bound.
//
// Timing: ~4-5 minutes wall (8 energies + IRT chem at 10 keV).

import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const TIMEOUT_MS = 600_000; // 10 minutes — IRT chemistry at 10 keV takes ~3 min CPU-side
const N_PRIMARIES = 4096;

async function readPlaywright() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function runFullValidationAndCaptureDamage(serverUrl, timeoutMs) {
  const chromium = await readPlaywright();
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--headless=new',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--no-sandbox',
    ],
  });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const t0 = Date.now();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#np', String(N_PRIMARIES));
    await page.click('#run');

    // Wait for the "DAMAGE:" line in #log. Per src/app.ts:199 the line is
    // emitted after chemistry + DSB scoring finishes at 10 keV — the last
    // step of runValidation.
    await page.waitForFunction(
      () => {
        const log = document.getElementById('log');
        return log && /DAMAGE:.*SSB_dir=/.test(log.textContent ?? '');
      },
      null,
      { timeout: timeoutMs },
    );
    const elapsedSec = (Date.now() - t0) / 1000;

    const captured = await page.evaluate(() => {
      const log = document.getElementById('log');
      const logText = log?.textContent ?? '';
      const damageMatch = logText.match(/DAMAGE:\s*SSB_dir=(\d+)\s+SSB_ind=(\d+)\s+DSB=(\d+)/);
      const rows = Array.from(document.querySelectorAll('#tb tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((c) => c.textContent?.trim() ?? ''),
      );
      return {
        damageLine: damageMatch ? damageMatch[0] : null,
        ssb_dir: damageMatch ? parseInt(damageMatch[1], 10) : null,
        ssb_ind: damageMatch ? parseInt(damageMatch[2], 10) : null,
        dsb: damageMatch ? parseInt(damageMatch[3], 10) : null,
        logTail: logText.slice(-3000),
        nRows: rows.length,
        rows,
      };
    });

    return {
      elapsedSec,
      ...captured,
      pageErrorCount: pageErrors.length,
      pageErrors: pageErrors.slice(0, 5),
      consoleLineCount: consoleLines.length,
    };
  } finally {
    await browser.close();
  }
}

export async function runE13c() {
  const t0 = Date.now();
  const env = captureEnv();
  const meta = {
    protocol: 'E13c-rerun-ssb-after-fix',
    hypothesis:
      'After bumping SSB_R_DAMAGE_NM from 0.29 nm to 1.0 nm in src/physics/constants.ts (2026-05-11, per E13b), re-running the full validation harness at N=4096 primaries / 10 keV produces SSB_ind > 0 and ideally in the 24-72 range (1× - 3× the observed SSB_dir of 24, matching the PARTRAC indirect/direct ratio of 2-3 after chemistry diffusion smearing of E13b\'s Node-side prediction of 174).',
    passBar:
      'New SSB_ind ≥ SSB_dir (i.e. indirect/direct ratio ≥ 1) AND no page-level errors during the run AND finishes within timeoutMs.',
    seed: `E13_INDIRECT_SSB=0x${SEEDS.E13_INDIRECT_SSB.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      harness: 'src/app.ts → runValidation()',
      driver: 'experiments/level-5-dna-damage/E13c-rerun-ssb-after-fix.mjs',
      damageLineFormat: 'src/app.ts:199 — "DAMAGE: SSB_dir=N1 SSB_ind=N2 DSB=N3"',
      constantsHistory: 'src/physics/constants.ts SSB_R_DAMAGE_NM: 0.29 (committed 2026-04-21) → 1.0 (bumped 2026-05-11)',
    },
    config: { nPrimaries: N_PRIMARIES, timeoutMs: TIMEOUT_MS },
  };

  let serverInfo = null;
  let result = null;
  let error = null;
  try {
    serverInfo = await startDevServer();
    result = await runFullValidationAndCaptureDamage(serverInfo.url, TIMEOUT_MS);
  } catch (err) {
    error = err;
  } finally {
    if (serverInfo) {
      try {
        await new Promise((res) => {
          serverInfo.process.once('exit', res);
          serverInfo.stop();
          setTimeout(res, 3000);
        });
      } catch { /* nothing */ }
    }
  }

  const totalSec = (Date.now() - t0) / 1000;

  if (error || !result) {
    return {
      meta, env, status: 'fail',
      diagnosis: error ? error.message.slice(0, 800) : 'no result captured',
      summary: { totalSec, headline: 'harness error before DAMAGE line emitted' },
      rows: [],
    };
  }

  const ssb_dir = result.ssb_dir;
  const ssb_ind = result.ssb_ind;
  const dsb = result.dsb;
  const ratio = ssb_dir > 0 ? ssb_ind / ssb_dir : 0;

  const failures = [];
  if (ssb_dir === null) failures.push('DAMAGE line did not parse');
  if (ssb_ind !== null && ssb_dir !== null && ssb_ind < ssb_dir) {
    failures.push(`new SSB_ind=${ssb_ind} < SSB_dir=${ssb_dir} (ratio ${ratio.toFixed(2)} < 1.0); fix had less impact than predicted`);
  }
  if (result.pageErrorCount > 0) {
    failures.push(`page errors: ${result.pageErrors.slice(0, 2).join(' / ')}`);
  }

  const status = failures.length === 0 ? 'pass' : 'fail';
  const diagnosis = failures.length === 0 ? null : failures.join('; ');

  const previousSsbInd = 0; // from validation/webgpu-results.json at r=0.29
  const e13bPredictionAtR1nm = 174; // Node-side, no diffusion smearing
  const partracExpectedLow = 24 * 2;
  const partracExpectedHigh = 24 * 3;

  return {
    meta, env, status, diagnosis,
    summary: {
      totalSec,
      harnessElapsedSec: result.elapsedSec,
      nPrimaries: N_PRIMARIES,
      newSsbDir: ssb_dir,
      newSsbInd: ssb_ind,
      newDsb: dsb,
      previousSsbInd,
      e13bNodePrediction: e13bPredictionAtR1nm,
      partracExpectedRange: `[${partracExpectedLow}, ${partracExpectedHigh}]`,
      indirectOverDirectRatio: ratio,
      diffusionSmearingFactor: e13bPredictionAtR1nm > 0 && ssb_ind !== null ? e13bPredictionAtR1nm / ssb_ind : null,
      headline: `SSB_ind: ${previousSsbInd} (r=0.29) → ${ssb_ind} (r=1.0); ratio=${ratio.toFixed(2)}; PARTRAC target [${partracExpectedLow}, ${partracExpectedHigh}]; E13b Node prediction 174`,
    },
    rows: [
      {
        metric: 'damage_after_fix',
        damageLine: result.damageLine,
        ssb_dir, ssb_ind, dsb,
        previousSsbInd,
        ratio,
        status: ssb_ind !== null && ssb_ind > previousSsbInd ? 'pass' : 'fail',
      },
      {
        metric: 'logTail',
        logTail: result.logTail,
        status: 'informational',
      },
    ],
  };
}
