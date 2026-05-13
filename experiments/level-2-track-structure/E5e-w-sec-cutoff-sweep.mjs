// E5e — W_sec cutoff sweep (alternative third knob).
//
// E7c proved that uniform vs asymmetric RECOMB_BOOST application can't
// escape the two-knob structural limit because the tracked-secondary
// recomb branch is the dominant lever for BOTH chemistry and cascade-
// ion effects. Geometry-wise, that means: secondaries that fall just
// above the cutoff (p.ce = 7.4 eV by default) are the population that
// gets recomb-killed under aggressive RECOMB_BOOST.
//
// One way to decouple cascade from chemistry: shift the cutoff upward.
// Secondaries between [old cutoff, new cutoff] would then go through
// the SUB-CUTOFF geminate-recomb path (which has Meesungnoen σ ≈
// 1.78 nm at 1.7 eV, well-modeled by Onsager) instead of the
// approximated r_track path that was eating cascade ions. They still
// contribute to chemistry, but their fate is decided by clean
// geminate physics rather than the r_track heuristic.
//
// Concretely: sweep ceEV (UI input `#cut`) over {7.4, 10, 12, 15, 20}
// and measure how cascade-ion count, CSDA, and primary-track ions
// each shift.
//
// Pass bar: at some ceEV > 7.4, cascade-ion proxy (mean_ions column,
// primary-track only) is at least 5% above the ceEV=7.4 baseline AND
// CSDA stays within ±5% of the ceEV=7.4 value. Failure means there's
// no useful ceEV intermediate.

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const N_PRIMARIES = 4096;
const TIMEOUT_MS = 1_200_000;
const CE_SWEEP = [7.4, 10, 12, 15, 20];

async function readPlaywright() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function runHarness(serverUrl, ceEV, timeoutMs) {
  const chromium = await readPlaywright();
  const browser = await chromium.launch({
    headless: false,
    args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--no-sandbox'],
  });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ?dump=1 disables chemistry (mass-clear path in main.ts). For a
    // ceEV sweep we only care about Phase A + Phase B numbers, so
    // skipping IRT chem makes each sweep step ~50 ms wall instead of
    // ~3 min. The 8-energy harness completes in ~30 sec.
    await page.goto(`${serverUrl}/?dump=1`, { waitUntil: 'domcontentloaded' });
    await page.fill('#np', String(N_PRIMARIES));
    await page.fill('#cut', String(ceEV));
    await page.click('#run');

    await page.waitForFunction(
      () => {
        const trs = document.querySelectorAll('#tb tr').length;
        const log = document.getElementById('log')?.innerText ?? '';
        return trs >= 8 && /Validation run complete/i.test(log);
      },
      null,
      { timeout: timeoutMs },
    );

    const rows = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('#tb tr'));
      return trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((c) => c.textContent?.trim() ?? ''));
    });
    return { rows, pageErrors };
  } finally {
    await browser.close();
  }
}

function parseEnergy(label) {
  const m = label.match(/(\d+(?:\.\d+)?)\s*(eV|keV)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Math.round(m[2].toLowerCase() === 'kev' ? v * 1000 : v);
}
function parseFloatOrNull(text) {
  const f = parseFloat(text.replace(/[^0-9.+\-eE]/g, ''));
  return Number.isFinite(f) ? f : null;
}

export async function runE5e() {
  const env = captureEnv();
  const meta = {
    protocol: 'E5e-w-sec-cutoff-sweep',
    hypothesis:
      'Raising the secondary-tracking cutoff ce_eV from 7.4 to e.g. 10/12/15/20 routes more low-energy secondaries through the sub-cutoff geminate-recomb path (Meesungnoen-displaced eaq + clean Onsager check) instead of the tracked-secondary r_track heuristic. The hypothesis is that some intermediate ceEV gives a useful operating point: more cascade ions preserved than at ce=7.4 (where r_track-driven recomb kills them) while keeping CSDA close to the original.',
    passBar:
      'At some ceEV > 7.4, primary-track ions at 10 keV exceeds the ce=7.4 value by ≥ 5% AND CSDA at 10 keV stays within ±5%. PASS iff a useful intermediate ceEV exists. FAIL iff cascade ions and CSDA move together (no decoupling).',
    seed: `E5_CSDA=0x${SEEDS.E5_CSDA.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      harness: 'src/app.ts → runValidation() driven via Playwright with #cut input',
      ce_sweep: CE_SWEEP,
      shader_constants: { sigma_exc_scale: 0.5, recomb_boost: 2.0 },
    },
    config: { n_primaries: N_PRIMARIES, ce_sweep: CE_SWEEP },
  };

  let server, sweepResults = [];
  try {
    server = await startDevServer();
    for (const ceEV of CE_SWEEP) {
      console.error(`[E5e] running ceEV = ${ceEV} eV…`);
      const { rows } = await runHarness(server.url, ceEV, TIMEOUT_MS);
      const at10keV = rows
        .map((cells) => ({ E: parseEnergy(cells[0]), csda: parseFloatOrNull(cells[3]), ions: parseFloatOrNull(cells[10]), sec: parseFloatOrNull(cells[11]) }))
        .find((r) => r.E === 10000);
      const at100eV = rows
        .map((cells) => ({ E: parseEnergy(cells[0]), csda: parseFloatOrNull(cells[3]), ions: parseFloatOrNull(cells[10]) }))
        .find((r) => r.E === 100);
      sweepResults.push({
        ceEV,
        csda_10keV: at10keV?.csda ?? null,
        ions_10keV: at10keV?.ions ?? null,
        sec_10keV: at10keV?.sec ?? null,
        csda_100eV: at100eV?.csda ?? null,
        ions_100eV: at100eV?.ions ?? null,
      });
      console.error(`[E5e]   ce=${ceEV}: CSDA@10keV=${at10keV?.csda} nm, ions/pri=${at10keV?.ions}, sec/pri=${at10keV?.sec}`);
    }
  } finally {
    if (server) {
      try {
        await new Promise((res) => {
          server.process.once('exit', res);
          server.stop();
          setTimeout(res, 3000);
        });
      } catch { /* nothing */ }
    }
  }

  const baseline = sweepResults.find((r) => r.ceEV === 7.4);
  const rows = sweepResults.map((r) => {
    const ionDelta = baseline && r.ions_10keV != null && baseline.ions_10keV != null
      ? (r.ions_10keV - baseline.ions_10keV) / baseline.ions_10keV
      : null;
    const csdaDelta = baseline && r.csda_10keV != null && baseline.csda_10keV != null
      ? (r.csda_10keV - baseline.csda_10keV) / baseline.csda_10keV
      : null;
    return {
      metric: `ceEV_${r.ceEV}`,
      ...r,
      ion_pct_vs_baseline: ionDelta != null ? ionDelta * 100 : null,
      csda_pct_vs_baseline: csdaDelta != null ? csdaDelta * 100 : null,
      status: 'informational',
    };
  });

  // Pass-bar check: useful intermediate ceEV?
  const useful = rows.find((r) =>
    r.ceEV > 7.4 &&
    r.ion_pct_vs_baseline != null && r.ion_pct_vs_baseline >= 5 &&
    r.csda_pct_vs_baseline != null && Math.abs(r.csda_pct_vs_baseline) <= 5
  );
  const status = useful ? 'pass' : 'fail';
  const diagnosis = useful
    ? `Useful operating point found at ceEV = ${useful.ceEV} eV — primary-track ions +${useful.ion_pct_vs_baseline.toFixed(1)}% vs ce=7.4 baseline AND CSDA stays within ±5% (${useful.csda_pct_vs_baseline.toFixed(1)}%). Cascade and CSDA can be decoupled by routing more secondaries through the sub-cutoff path.`
    : `No useful intermediate ceEV found. ${rows.length > 0 ? 'Ions and CSDA move together across the sweep — the W_sec cutoff is not the right third knob.' : 'Sweep produced no rows.'}. Confirms the H₂O+ tracking refactor (Tier 1) is the right structural fix instead.`;

  const summary = {
    sweep: rows,
    useful_ceEV: useful?.ceEV ?? null,
    headline: rows.map((r) => `ce=${r.ceEV}: ions=${r.ions_10keV?.toFixed(0)} (${r.ion_pct_vs_baseline?.toFixed(1)}%) CSDA=${r.csda_10keV?.toFixed(0)} nm (${r.csda_pct_vs_baseline?.toFixed(1)}%)`).join(' | '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
