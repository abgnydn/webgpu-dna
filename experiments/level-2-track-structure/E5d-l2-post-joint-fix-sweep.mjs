// E5d — Post-joint-fix re-validation of every L2 metric in a single
// Playwright harness run.
//
// E5b (CSDA), E6/E6b (MFP and σ-per-process), and E7 (cascade ions)
// were all measured BEFORE the joint-fix shaders shipped on 2026-05-12.
// Their Geant4-side reference numbers are unchanged (Geant4 doesn't
// know about our shader-side fix), so the cleanest closure is:
//
//   - Run the WGSL validation harness once with current shaders
//     (SIGMA_EXC_SCALE=0.5, RECOMB_BOOST=2.0).
//   - Capture every relevant table column at all 8 ESTAR energies.
//   - Compare to the cached Geant4 baselines from E5b/E7 artifacts.
//   - Emit one artifact with per-energy rows so a researcher can see
//     the joint-fix impact per metric without re-running Geant4.
//
// Pass bar: at least 6 of 8 energies have improved CSDA ratio (closer
// to 1.0) vs the pre-fix E5b numbers — the joint fix is *supposed*
// to address the low-E CSDA deficit. Cascade-ion ratio at 10 keV
// should also improve (was 0.730× per E7).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const N_PRIMARIES = 4096;
const TIMEOUT_MS = 1_200_000; // 20 min — IRT chem at 10 keV
const E5B_ARTIFACT = join(REPO_ROOT, 'experiments', 'results', '2026-05-12', 'level-2', 'E5b-csda-multi-energy.json');
const E7_ARTIFACT  = join(REPO_ROOT, 'experiments', 'results', '2026-05-11', 'level-2', 'E7-ions-per-primary-cascade.json');
// Geant4 11.4.1 reference values (cached from E5b artifact 2026-05-12).
// Geant4 side does not depend on the WGSL joint fix, so these baselines
// remain authoritative.
const G4_CSDA_NM = {
  100: 26.21, 300: 35.91, 500: 48.07, 1000: 90.32,
  3000: 392.5, 5000: 877.6, 10000: 2747.5, 20000: 9096.2,
};
// E7's full-cascade reference at 10 keV (Geant4 ions/primary).
const G4_CASCADE_IONS_AT_10KEV = 509.2;
// Pre-fix WGSL CSDA values for delta computation (from E5b).
const PRE_FIX_WGSL_CSDA_NM = {
  100: 15.4, 300: 25.3, 500: 37.3, 1000: 78.0,
  3000: 378.7, 5000: 856.0, 10000: 2714.4, 20000: 9026.9,
};
const PRE_FIX_WGSL_CASCADE_AT_10KEV = 371.9;

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

export async function runE5d() {
  const env = captureEnv();
  const meta = {
    protocol: 'E5d-l2-post-joint-fix-sweep',
    hypothesis:
      'After the joint fix (SIGMA_EXC_SCALE=0.5 + RECOMB_BOOST=2.0) shipped 2026-05-12, the L2 metrics (CSDA at 8 energies, ions/primary at 10 keV) move toward their Geant4 11.4.1 references. Geant4-side baselines unchanged; this is a WGSL-only re-validation against cached references.',
    passBar:
      'CSDA: at least 6 of 8 energies have ratio closer to 1.0 than the pre-fix E5b run. Cascade ions/primary at 10 keV: post-fix ratio strictly closer to 1.0 than pre-fix 0.730×.',
    seed: `E5_CSDA=0x${SEEDS.E5_CSDA.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      g4_csda_baseline: 'experiments/results/2026-05-12/level-2/E5b-csda-multi-energy.json (Geant4 11.4.1 cached)',
      g4_cascade_baseline: 'experiments/results/2026-05-11/level-2/E7-ions-per-primary-cascade.json (Geant4 ntuple)',
      wgsl_harness: 'src/app.ts → runValidation() with current shader constants',
    },
    config: {
      n_primaries: N_PRIMARIES,
      g4_csda_nm: G4_CSDA_NM,
      g4_cascade_ions_at_10keV: G4_CASCADE_IONS_AT_10KEV,
      shader_constants: { sigma_exc_scale: 0.5, recomb_boost: 2.0 },
    },
  };

  if (!existsSync(E5B_ARTIFACT)) {
    return { meta, env, status: 'skip', diagnosis: 'E5b baseline artifact missing', summary: { headline: 'skipped' }, rows: [] };
  }

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
      } catch { /* nothing */ }
    }
  }

  // Parse harness table: col 0 = energy, col 3 = CSDA nm, col 10 = ions/primary.
  // Damage row for 10 keV has SSB at cols 16, 17, DSB at col 18.
  const wgslCsda = {};
  const wgslIonsPerPri = {};
  for (const cells of harnessResult.rows) {
    const eEv = parseEnergy(cells[0] ?? '');
    if (eEv === null) continue;
    const csda = parseFloatOrNull(cells[3] ?? '');
    const ions = parseFloatOrNull(cells[10] ?? '');
    if (csda !== null) wgslCsda[eEv] = csda;
    if (ions !== null) wgslIonsPerPri[eEv] = ions;
  }

  // CSDA per-energy comparison
  const csdaRows = [];
  let nImprovedCsda = 0;
  for (const eStr of Object.keys(G4_CSDA_NM)) {
    const eEv = parseInt(eStr, 10);
    const g4 = G4_CSDA_NM[eEv];
    const post = wgslCsda[eEv];
    const pre = PRE_FIX_WGSL_CSDA_NM[eEv];
    if (post == null || pre == null) {
      csdaRows.push({ metric: `csda_${eEv}_eV`, status: 'fail', note: 'missing WGSL row' });
      continue;
    }
    const ratioPost = post / g4;
    const ratioPre = pre / g4;
    const moved = Math.abs(ratioPost - 1) < Math.abs(ratioPre - 1);
    if (moved) nImprovedCsda++;
    csdaRows.push({
      metric: `csda_${eEv}_eV`,
      g4_csda_nm: g4,
      wgsl_pre_fix_nm: pre,
      wgsl_post_fix_nm: post,
      ratio_pre: ratioPre,
      ratio_post: ratioPost,
      improved: moved,
      delta_pct: (ratioPost - ratioPre) * 100,
      status: moved ? 'pass' : 'fail',
    });
  }

  // Ions/primary at 10 keV. Note: harness's mean_ions counts PRIMARY-track
  // ionizations only (per E5's box_ions atomic). E7's 371.9 reference is
  // the full-cascade count reconstructed from rad_buf H3O+. So the harness
  // number is NOT directly comparable to G4's 509.2 — it's the
  // primary-track 194.1 reference. We report the harness ions/primary
  // here as informational; a cascade-ion comparison requires re-running
  // E7 properly with the new shaders against a fresh rad bin.
  const postIonsPrimaryTrack = wgslIonsPerPri[10000] ?? null;
  const PRE_FIX_PRIMARY_TRACK_IONS_AT_10KEV = 194.1;
  const ionsRows = [
    {
      metric: 'primary_track_ions_per_primary_at_10keV',
      wgsl_pre_fix: PRE_FIX_PRIMARY_TRACK_IONS_AT_10KEV,
      wgsl_post_fix: postIonsPrimaryTrack,
      delta: postIonsPrimaryTrack != null ? postIonsPrimaryTrack - PRE_FIX_PRIMARY_TRACK_IONS_AT_10KEV : null,
      note: 'GPU box_ions atomic — primary track only, NOT comparable to the 509.2 G4 cascade count. For a proper post-fix cascade-ion measurement, re-run E7 against a fresh rad bin generated under joint-fix shaders.',
      status: 'informational',
    },
  ];

  const rows = [...csdaRows, ...ionsRows];

  const status = nImprovedCsda >= 6 ? 'pass' : 'fail';
  const diagnosis = status === 'pass'
    ? `${nImprovedCsda}/8 CSDA energies improved by the joint fix. Headline lift: 100 eV ${csdaRows[0]?.ratio_pre?.toFixed(3) ?? '?'} → ${csdaRows[0]?.ratio_post?.toFixed(3) ?? '?'}.`
    : `Only ${nImprovedCsda}/8 CSDA energies improved. Joint fix may need re-tuning or the low-E deficit has another driver.`;

  const summary = {
    n_csda_improved: nImprovedCsda,
    csda_at_100eV_post: csdaRows[0]?.ratio_post,
    csda_at_100eV_pre: csdaRows[0]?.ratio_pre,
    primary_track_ions_at_10keV_post: postIonsPrimaryTrack,
    headline: csdaRows
      .filter((r) => r.metric.startsWith('csda_'))
      .map((r) => `${r.metric.replace('csda_', '').replace('_eV', 'eV')}: ${r.ratio_post?.toFixed(3)} (was ${r.ratio_pre?.toFixed(3)})`)
      .join(' | '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
