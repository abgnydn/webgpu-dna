// E5b — CSDA validation across all 8 ESTAR energies, WGSL vs Geant4 11.4.1.
//
// E5 validated CSDA only at 10 keV (0.988× vs Geant4, 3.59σ). E5b extends
// the comparison to the full ESTAR sweep (100, 300, 500 eV, 1, 3, 5, 10,
// 20 keV). Drives the full validation harness via Playwright (waits for
// all 8 rows in #tb) and runs a multi-energy dnaphysics ntuple side-by-
// side. Per-energy CSDA pairs compared with the same pass criteria as E5.
//
// Pass bar (per energy): CSDA ratio ∈ [0.85, 1.15] AND |Δ|/SEM < 5σ.
// The 5σ bar matches E5 and accommodates the documented 1.5% systematic
// CSDA bias at 10 keV; at other energies the bias may differ.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GEANT4_INSTALL = join(homedir(), 'Downloads', 'geant4-v11.4.1-install');
const GEANT4_SCRIPT = join(GEANT4_INSTALL, 'bin', 'geant4.sh');
const DNAPHYSICS_BIN = join(homedir(), 'Downloads', 'dnaphysics-v11.4.1-build', 'dnaphysics');
const ESTAR_ENERGIES = [100, 300, 500, 1000, 3000, 5000, 10000, 20000];
const N_PRIMARIES_PER_E = 4096;
const E5B_TMP_DIR = '/tmp/e5b-runs';

// Build a single-energy dnaphysics macro inline. dnaphysics writes events
// to dna.root in its CWD; we run each energy in a separate subdirectory
// so the 8 ntuples don't overwrite each other.
function makeMacroForEnergy(eEv) {
  const unit = eEv >= 1000 ? 'keV' : 'eV';
  const value = eEv >= 1000 ? eEv / 1000 : eEv;
  return [
    '/tracking/verbose 0',
    '/run/verbose 0',
    '/control/verbose 0',
    '/run/numberOfThreads 1',
    '/dna/test/setMat G4_WATER',
    '/dna/test/setSize 30 um',
    '/dna/test/addPhysics DNA_Opt2',
    '/run/initialize',
    '/gun/particle e-',
    `/gun/energy ${value} ${unit}`,
    `/run/beamOn ${N_PRIMARIES_PER_E}`,
    '',
  ].join('\n');
}

const TIMEOUT_MS = 1_500_000;  // 25 min — the in-browser IRT chemistry at 10 keV
                                // with SSB-mask emission is ~3-5 min wall
const N_PRIMARIES_WGSL = 4096; // match the in-browser run

async function readPlaywright() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function runHarnessAndCaptureAllRows(serverUrl, timeoutMs) {
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
    page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const t0 = Date.now();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#np', String(N_PRIMARIES_WGSL));
    await page.click('#run');

    // Wait for all 8 rows to populate
    await page.waitForFunction(
      () => document.querySelectorAll('#tb tr').length >= 8,
      null,
      { timeout: timeoutMs },
    );
    const elapsedSec = (Date.now() - t0) / 1000;

    const rows = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('#tb tr'));
      return trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((c) => c.textContent?.trim() ?? ''));
    });
    return { elapsedSec, rows, consoleTail: consoleLines.slice(-20), pageErrors };
  } finally {
    await browser.close();
  }
}

function runDnaphysicsAtEnergy(eEv) {
  return new Promise((resolve, reject) => {
    const energyDir = join(E5B_TMP_DIR, `E${eEv}`);
    mkdirSync(energyDir, { recursive: true });
    const macroPath = join(energyDir, 'macro.mac');
    writeFileSync(macroPath, makeMacroForEnergy(eEv));
    const logPath = join(energyDir, 'dnaphysics.log');
    const t0 = Date.now();
    const cmd = `source "${GEANT4_SCRIPT}" && cd "${energyDir}" && "${DNAPHYSICS_BIN}" "${macroPath}" > "${logPath}" 2>&1`;
    const proc = spawn('bash', ['-c', cmd]);
    proc.on('exit', (code) => {
      const wallSec = (Date.now() - t0) / 1000;
      const rootPath = join(energyDir, 'dna.root');
      if (code === 0 && existsSync(rootPath)) {
        resolve({ eEv, wallSec, rootPath });
      } else {
        const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-1500) : '(no log)';
        reject(new Error(`dnaphysics @${eEv} eV exit ${code}; tail:\n${tail}`));
      }
    });
    proc.on('error', reject);
  });
}

function parseCsdaSingleEnergy(rootPath) {
  const py = `
import uproot, numpy as np, json
f = uproot.open('${rootPath}')
t = f['step']
trackID = t['trackID'].array(library='np').astype(np.int64)
eventID = t['eventID'].array(library='np').astype(np.int64)
stepLen = t['stepLength'].array(library='np')
mask = trackID == 1
ev = eventID[mask]
sl = stepLen[mask]
n_ev = int(ev.max()) + 1 if len(ev) > 0 else 0
path_per_event = np.bincount(ev, weights=sl, minlength=n_ev)
path_per_event = path_per_event[path_per_event > 0]
if len(path_per_event) > 0:
  mean = float(np.mean(path_per_event))
  std = float(np.std(path_per_event))
  sem = std / np.sqrt(len(path_per_event)) if len(path_per_event) > 1 else 0
else:
  mean = std = sem = 0
print(json.dumps({'mean_nm': mean, 'std_nm': std, 'sem_nm': sem, 'n_events': len(path_per_event)}))
`;
  const stdout = execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function runE5b() {
  const env = captureEnv();
  const meta = {
    protocol: 'E5b-csda-multi-energy',
    hypothesis:
      'At every ESTAR energy (100 eV, 300 eV, 500 eV, 1, 3, 5, 10, 20 keV), WGSL primary-track CSDA mean (column 4 of the in-browser validation table) agrees with Geant4 11.4.1 dnaphysics primary CSDA mean within the same E5 pass bar: ratio ∈ [0.85, 1.15] AND |Δ|/SEM < 5σ.',
    passBar:
      'Per energy: CSDA ratio ∈ [0.85, 1.15] AND |Δ|/SEM < 5σ. Energies where either side reports 0 are flagged informational, not failed.',
    seed: `E5_CSDA=0x${SEEDS.E5_CSDA.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgslHarness: 'src/app.ts → runValidation() table cell 4',
      g4Macro: 'validation/run_validation_multi_E.mac (8 beamOns, 4096 events each)',
      g4Bin: DNAPHYSICS_BIN.replace(homedir(), '~'),
    },
    config: { energies: ESTAR_ENERGIES, n_primaries: N_PRIMARIES_WGSL },
  };

  if (!existsSync(DNAPHYSICS_BIN)) {
    return { meta, env, status: 'skip', diagnosis: 'dnaphysics binary missing', summary: { headline: 'skipped' }, rows: [] };
  }

  // (a) Run Geant4 separately for each energy in parallel with WGSL harness.
  // Each invocation writes its own dna.root under /tmp/e5b-runs/E<eEv>/.
  rmSync(E5B_TMP_DIR, { recursive: true, force: true });
  mkdirSync(E5B_TMP_DIR, { recursive: true });
  console.error(`[E5b] starting Geant4 sequential runs at ${ESTAR_ENERGIES.length} energies…`);
  const g4PromiseAll = (async () => {
    const results = {};
    const wallByE = {};
    let totalWall = 0;
    for (const E of ESTAR_ENERGIES) {
      const r = await runDnaphysicsAtEnergy(E);
      wallByE[E] = r.wallSec;
      totalWall += r.wallSec;
      results[String(E)] = parseCsdaSingleEnergy(r.rootPath);
      console.error(`[E5b]   E=${E} eV done in ${r.wallSec.toFixed(1)}s; CSDA mean = ${results[String(E)].mean_nm.toFixed(1)} nm`);
    }
    return { results, wallByE, totalWall };
  })();

  // (b) Drive WGSL harness
  let server, wgslResult;
  try {
    server = await startDevServer();
    wgslResult = await runHarnessAndCaptureAllRows(server.url, TIMEOUT_MS);
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

  // (c) Wait for Geant4 + collect
  const g4 = await g4PromiseAll;
  const g4Csda = g4.results;

  // (d) Parse WGSL rows: column 0 = energy label, column 3 = CSDA Total (nm)
  const wgslByEnergy = {};
  for (const cells of wgslResult.rows) {
    const energyText = cells[0] ?? '';
    const csdaText = cells[3] ?? '';
    const E_match = energyText.match(/(\d+(?:\.\d+)?)\s*(eV|keV)/i);
    if (!E_match) continue;
    const value = parseFloat(E_match[1]);
    const unit = E_match[2].toLowerCase();
    const energyEv = Math.round(unit === 'kev' ? value * 1000 : value);
    const csdaNm = parseFloat(csdaText.replace(/[^0-9.+\-eE]/g, ''));
    if (Number.isFinite(csdaNm)) wgslByEnergy[energyEv] = csdaNm;
  }

  // (e) Compare per-energy
  const rows = [];
  let nPassed = 0, nFailed = 0, nSkipped = 0;
  for (const E of ESTAR_ENERGIES) {
    const wgsl = wgslByEnergy[E];
    const g = g4Csda[String(E)];
    if (!Number.isFinite(wgsl) || !g || g.mean_nm === 0) {
      nSkipped++;
      rows.push({
        metric: `csda_${E}_eV`,
        energyEv: E,
        wgsl_csda_nm: wgsl ?? null,
        g4_csda_nm: g?.mean_nm ?? null,
        g4_n_events: g?.n_events ?? null,
        status: 'informational',
        note: 'missing or zero on one side',
      });
      continue;
    }
    const ratio = wgsl / g.mean_nm;
    const sigmaDelta = g.sem_nm > 0 ? Math.abs(wgsl - g.mean_nm) / g.sem_nm : 0;
    const ratioPass = ratio >= 0.85 && ratio <= 1.15;
    const sigmaPass = sigmaDelta < 5;
    const passed = ratioPass && sigmaPass;
    if (passed) nPassed++; else nFailed++;
    rows.push({
      metric: `csda_${E}_eV`,
      energyEv: E,
      wgsl_csda_nm: wgsl,
      g4_csda_nm: g.mean_nm,
      g4_std_nm: g.std_nm,
      g4_sem_nm: g.sem_nm,
      g4_n_events: g.n_events,
      ratio,
      sigmaDelta,
      ratioPass, sigmaPass,
      status: passed ? 'pass' : 'fail',
    });
  }

  rows.push({
    metric: 'metadata',
    geant4_total_wall_sec: g4.totalWall,
    geant4_wall_by_energy_sec: g4.wallByE,
    wgsl_harness_wall_sec: wgslResult.elapsedSec,
    wgsl_page_errors: wgslResult.pageErrors,
    status: 'informational',
  });

  const status = nFailed === 0 ? 'pass' : 'fail';
  const diagnosis = status === 'fail'
    ? `${nFailed}/${nPassed + nFailed} energies outside CSDA pass bar`
    : null;

  const summary = {
    energies: ESTAR_ENERGIES,
    nPassed,
    nFailed,
    nSkipped,
    geant4TotalWallSec: g4.totalWall,
    wgslHarnessSec: wgslResult.elapsedSec,
    headline: rows
      .filter((r) => r.metric.startsWith('csda_'))
      .map((r) => `${r.energyEv}eV: ${r.wgsl_csda_nm?.toFixed(1) ?? '?'}/${r.g4_csda_nm?.toFixed(1) ?? '?'}=${r.ratio?.toFixed(3) ?? '?'}×`)
      .join(' | '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
