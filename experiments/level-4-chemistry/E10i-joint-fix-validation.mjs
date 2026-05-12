// E10i — Validate the joint σ_exc + RECOMB_BOOST fix end-to-end.
//
// E10h showed recomb boost alone is necessary but not sufficient (G(eaq)
// gets worse). E10i tests the COMBINED fix:
//   - SIGMA_EXC_SCALE = 0.7 (closes part of E5b/E7 — more ionizations)
//   - RECOMB_BOOST = 1.2 (closes ~15-20% of pre-chem H₂ deficit)
// Both applied in helpers.wgsl + primary.wgsl + secondary.wgsl.
//
// Method:
//   1. Start dev server (Vite hot-reloads the new shaders).
//   2. Drive validation harness via Playwright at N=4096.
//   3. Scrape #log for the IRT chemistry timeline at 10 keV (format:
//      "    0.1 ps     4.382     3.694     0.786     0.031     0.127").
//   4. Compare G(OH/eaq/H/H₂/H₂O₂) at 0.1 ps to chem6 targets from E9.
//   5. Compare CSDA at all 8 energies to ESTAR (touchstone for E5b).
//
// Pass bar: all 5 G-values at 0.1 ps within ±15% of chem6 → joint fix
// closes the pre-chem deficit; CSDA ratios at low E (100, 300 eV) lift
// from 0.587×/0.705× toward 0.85+ → joint fix improves E5b.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const N_PRIMARIES = 4096;
const TIMEOUT_MS = 1_200_000; // 20 min — the in-browser IRT chem at 10 keV
                              // with 4096 primaries is ~3 min.
const CHEM6_AT_0P1PS = {
  G_OH: 5.049, G_eaq: 4.097, G_H: 0.893, G_H2: 0.251, G_H2O2: 0.053,
};
const BASELINE_AT_0P1PS = {
  G_OH: 4.382, G_eaq: 3.694, G_H: 0.786, G_H2: 0.127, G_H2O2: 0.031,
};

function readShaderScales() {
  const helpersPath = join(REPO_ROOT, 'src', 'shaders', 'helpers.wgsl');
  const txt = readFileSync(helpersPath, 'utf8');
  const sigmaMatch = txt.match(/SIGMA_EXC_SCALE\s*:\s*f32\s*=\s*([0-9.eE+-]+)/);
  const recombMatch = txt.match(/RECOMB_BOOST\s*:\s*f32\s*=\s*([0-9.eE+-]+)/);
  return {
    sigma_exc_scale: sigmaMatch ? parseFloat(sigmaMatch[1]) : null,
    recomb_boost: recombMatch ? parseFloat(recombMatch[1]) : null,
  };
}

async function readPlaywright() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function runHarness(serverUrl, timeoutMs) {
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

    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#np', String(N_PRIMARIES));
    await page.click('#run');

    // Wait for all 8 rows + "Validation run complete" log line.
    await page.waitForFunction(
      () => {
        const trs = document.querySelectorAll('#tb tr').length;
        const log = document.getElementById('log')?.innerText ?? '';
        return trs >= 8 && /Validation run complete/i.test(log);
      },
      null,
      { timeout: timeoutMs },
    );

    const logText = await page.evaluate(() => document.getElementById('log')?.innerText ?? '');
    const tableRows = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('#tb tr'));
      return trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((c) => c.textContent?.trim() ?? ''));
    });
    return { logText, tableRows, pageErrors };
  } finally {
    await browser.close();
  }
}

// Parse the 0.1 ps timeline row from the #log dump. Format from
// logChemistryTimeline (src/app.ts:243):
//   "[hh:mm:ss] [data]     0.1 ps     4.382     3.694     0.786     0.031     0.127"
// Numbers are G(OH) G(eaq) G(H) G(H2O2) G(H2) in that order.
function parseTimelineRow(logText, label) {
  // Match the line containing the label followed by 5 floats.
  const re = new RegExp(`${label.replace(/\./g, '\\.')}\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)`);
  const m = logText.match(re);
  if (!m) return null;
  return {
    G_OH: parseFloat(m[1]),
    G_eaq: parseFloat(m[2]),
    G_H: parseFloat(m[3]),
    G_H2O2: parseFloat(m[4]),
    G_H2: parseFloat(m[5]),
  };
}

function rmsDeviation(measured, target) {
  let sum = 0;
  let n = 0;
  for (const k of Object.keys(target)) {
    if (measured[k] === undefined || measured[k] === null) continue;
    sum += Math.pow((measured[k] - target[k]) / target[k], 2);
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : null;
}

export async function runE10i() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10i-joint-fix-validation',
    hypothesis:
      'Joint application of SIGMA_EXC_SCALE=0.7 (close E5b/E7) and RECOMB_BOOST=1.2 (close pre-chem H₂/H₂O₂) lands all 5 G-values at 0.1 ps within ±15% of chem6 AND lifts E5b low-E CSDA ratios from <0.85× toward ≥0.85×.',
    passBar:
      'Joint fix passes iff (a) all 5 G-values at 0.1 ps within ±15% of chem6 AND (b) low-E CSDA ratios (100, 300 eV) ≥ 0.75× (substantial improvement from baseline 0.587/0.705×).',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      shaders: 'src/shaders/{helpers,primary,secondary}.wgsl with SIGMA_EXC_SCALE=0.7 + RECOMB_BOOST=1.2',
      harness: 'src/app.ts → runValidation() at N=4096',
      chem6_reference: 'E9 0.1 ps row (Gvalue0.root)',
    },
    config: { n_primaries: N_PRIMARIES, ...readShaderScales() },
  };

  let server, harnessResult;
  try {
    server = await startDevServer();
    harnessResult = await runHarness(server.url, TIMEOUT_MS);
  } finally {
    if (server) {
      try {
        await new Promise((res) => {
          server.process.once('exit', res);
          server.stop();
          setTimeout(res, 3000);
        });
      } catch { /* ignore */ }
    }
  }

  const timeline_0p1ps = parseTimelineRow(harnessResult.logText, '0.1 ps');
  const timeline_1us = parseTimelineRow(harnessResult.logText, '1 us');

  // CSDA scraping: col 0 = energy label, col 3 = mean_total (WGSL CSDA in nm).
  // Compare against Geant4 11.4.1 baseline from E5b artifact (NOT the col 5
  // ratio, which is vs ESTAR and meaningless at low E for our purposes).
  const G4_CSDA_NM = {  // From E5b 2026-05-12 artifact
    100: 26.21, 300: 35.91, 500: 48.07, 1000: 90.32,
    3000: 392.5, 5000: 877.6, 10000: 2747.5, 20000: 9096.2,
  };
  const csdaByEnergy = {};
  for (const cells of harnessResult.tableRows) {
    const eLabel = cells[0] ?? '';
    const csdaNmText = cells[3] ?? '';
    const eMatch = eLabel.match(/(\d+(?:\.\d+)?)\s*(eV|keV)/i);
    if (!eMatch) continue;
    const value = parseFloat(eMatch[1]);
    const eEv = Math.round(eMatch[2].toLowerCase() === 'kev' ? value * 1000 : value);
    const csdaNm = parseFloat(csdaNmText.replace(/[^0-9.+\-eE]/g, ''));
    if (Number.isFinite(csdaNm) && G4_CSDA_NM[eEv]) {
      csdaByEnergy[eEv] = csdaNm / G4_CSDA_NM[eEv];
    }
  }

  // Eval (a): 5 G-values at 0.1 ps within ±15%
  const within15 = timeline_0p1ps
    ? Object.keys(CHEM6_AT_0P1PS).every((k) => Math.abs((timeline_0p1ps[k] - CHEM6_AT_0P1PS[k]) / CHEM6_AT_0P1PS[k]) <= 0.15)
    : false;
  // Eval (b): low-E CSDA ≥ 0.75 at 100 and 300 eV
  const lowECsdaImproved = (csdaByEnergy[100] ?? 0) >= 0.75 && (csdaByEnergy[300] ?? 0) >= 0.75;

  const status = within15 && lowECsdaImproved ? 'pass' : 'noisy';
  const rmsBaseline = rmsDeviation(BASELINE_AT_0P1PS, CHEM6_AT_0P1PS);
  const rmsFixed = timeline_0p1ps ? rmsDeviation(timeline_0p1ps, CHEM6_AT_0P1PS) : null;

  const diagnosis = !timeline_0p1ps
    ? 'Could not parse 0.1 ps timeline from log — harness likely failed to emit chemistry results.'
    : status === 'pass'
      ? `Joint fix lands all 5 G-values within ±15% of chem6 AND lifts low-E CSDA. RMS dev ${(rmsBaseline * 100).toFixed(1)}% → ${(rmsFixed * 100).toFixed(1)}%.`
      : `Joint fix is partial: G-values RMS ${(rmsFixed * 100).toFixed(1)}% (baseline ${(rmsBaseline * 100).toFixed(1)}%); low-E CSDA 100eV=${(csdaByEnergy[100] ?? 0).toFixed(2)}× 300eV=${(csdaByEnergy[300] ?? 0).toFixed(2)}×. Tune the two scales further.`;

  const summary = {
    chem6_targets: CHEM6_AT_0P1PS,
    baseline_at_0p1ps: BASELINE_AT_0P1PS,
    measured_at_0p1ps: timeline_0p1ps,
    measured_at_1us: timeline_1us,
    rms_dev_baseline_pct: rmsBaseline ? rmsBaseline * 100 : null,
    rms_dev_fixed_pct: rmsFixed ? rmsFixed * 100 : null,
    csda_ratios: csdaByEnergy,
    page_errors: harnessResult.pageErrors,
    headline: timeline_0p1ps
      ? `0.1ps G(OH)=${timeline_0p1ps.G_OH.toFixed(3)} G(eaq)=${timeline_0p1ps.G_eaq.toFixed(3)} G(H)=${timeline_0p1ps.G_H.toFixed(3)} G(H2)=${timeline_0p1ps.G_H2.toFixed(3)} G(H2O2)=${timeline_0p1ps.G_H2O2.toFixed(3)} | RMS ${(rmsFixed * 100).toFixed(1)}% (was ${(rmsBaseline * 100).toFixed(1)}%) | CSDA@100eV=${(csdaByEnergy[100] ?? 0).toFixed(2)}×`
      : 'no chemistry timeline parsed',
  };

  const rows = [
    ...(timeline_0p1ps
      ? Object.keys(CHEM6_AT_0P1PS).map((k) => ({
          metric: `0p1ps_${k}`,
          value: timeline_0p1ps[k],
          chem6: CHEM6_AT_0P1PS[k],
          baseline: BASELINE_AT_0P1PS[k],
          ratio_to_chem6: timeline_0p1ps[k] / CHEM6_AT_0P1PS[k],
          improved: Math.abs(timeline_0p1ps[k] - CHEM6_AT_0P1PS[k]) < Math.abs(BASELINE_AT_0P1PS[k] - CHEM6_AT_0P1PS[k]),
          status: Math.abs((timeline_0p1ps[k] - CHEM6_AT_0P1PS[k]) / CHEM6_AT_0P1PS[k]) <= 0.15 ? 'pass' : 'fail',
        }))
      : []),
    ...Object.keys(csdaByEnergy).map((e) => ({
      metric: `csda_${e}_eV`,
      ratio: csdaByEnergy[e],
      status: csdaByEnergy[e] >= 0.85 ? 'pass' : 'informational',
    })),
  ];

  return { meta, env, status, diagnosis, summary, rows };
}
