// E10c — G(species, 1 μs) vs Geant4 11.4.1 chem6 at MATCHED 10 keV LET.
//
// E10 compared our IRT to Karamitros 2011's *low-LET reference* (~1 MeV
// equivalent), so the 0.62× G(OH) / 0.56× G(e⁻aq) deficits there are
// expected — track-core density at 10 keV drives higher radical
// recombination than ~1 MeV. The honest test is against a Geant4 IRT
// run at the SAME 10 keV. That's what this experiment closes.
//
// Method:
//   1. Run Geant4 11.4.1's chem6 example with our matched-LET macro
//      (validation/chem6_10keV.mac): 10 keV electrons, full energy
//      deposit (primary not killed), G4EmDNAPhysics_option2,
//      Meesungnoen2002 e-aq solvation, IRT time-step model, N
//      primaries.
//   2. Parse Gvalue0.root via Python+uproot to get per-species G/N and
//      SE at each timepoint. Pick the t = 1 μs row.
//   3. Compare per species to E10's 10 keV WebGPU IRT row.
//   4. Pass bar: per-species |G_wgsl - G_chem6| / sqrt(SE_chem6² +
//      SE_wgsl²) < 3 AND |ratio - 1| < 0.20 (loose because chem6 is
//      noisy at N=100 and our IRT has documented systematic biases).
//
// chem6 install: ~/Downloads/geant4-v11.4.1-install (built 2026-05-11).
// chem6 build:   ~/Downloads/chem6-build  (built 2026-05-11).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CHEM6_BIN = join(homedir(), 'Downloads', 'chem6-build', 'chem6');
const GEANT4_SCRIPT = join(homedir(), 'Downloads', 'geant4-v11.4.1-install', 'bin', 'geant4.sh');
const MACRO_PATH = join(REPO_ROOT, 'validation', 'chem6_10keV.mac');
const RUN_DIR = '/tmp/webgpu-dna-e10c';
const E10_ARTIFACT = join(
  REPO_ROOT,
  'experiments',
  'results',
  '2026-05-11',
  'level-4',
  'E10-irt-vs-karamitros.json',
);

const TARGET_TIME = '1 us'; // E10 checkpoint label to compare against
const N_PRIMARIES_DEFAULT = 100;

// chem6 species ID mapping (from chem6.out species table, line "Molecular Config | Diffusion …"):
//   0  = H3O+
//   1  = OH (°OH^0)
//   2  = OH- (OH^-1)
//   3  = e_aq
//   4  = H (H^0)
//   5  = H2
//   6  = H2O2
// E10 species names: OH, eaq, H, H2O2, H2 — we map chem6 IDs accordingly.
const CHEM6_TO_E10 = {
  1: 'OH',
  3: 'eaq',
  4: 'H',
  5: 'H2',
  6: 'H2O2',
};

function runChem6(nPrimaries) {
  // Build a runtime macro with the requested N (the committed macro is
  // the template; we just rewrite the /run/beamOn line).
  const macroTpl = readFileSync(MACRO_PATH, 'utf8');
  const macro = macroTpl.replace(
    /\/run\/beamOn\s+\d+/,
    `/run/beamOn ${nPrimaries}`,
  );

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  const macroOut = join(RUN_DIR, 'chem6_10keV.mac');
  writeFileSync(macroOut, macro);

  const cmd = `source "${GEANT4_SCRIPT}" && "${CHEM6_BIN}" "${macroOut}" > "${RUN_DIR}/chem6.log" 2>&1`;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', cmd], { cwd: RUN_DIR });
    proc.on('exit', (code) => {
      const elapsedSec = (Date.now() - t0) / 1000;
      if (code !== 0) {
        const log = existsSync(`${RUN_DIR}/chem6.log`)
          ? readFileSync(`${RUN_DIR}/chem6.log`, 'utf8').slice(-2000)
          : '(no log)';
        return reject(new Error(`chem6 exited with code ${code}; log tail:\n${log}`));
      }
      resolve(elapsedSec);
    });
    proc.on('error', reject);
  });
}

function readChem6Ntuple(rootPath) {
  // Parse via inline Python (uproot is on the user-pip install path).
  const py = `
import json, uproot
f = uproot.open('${rootPath}')
tree = f['species']
arr = {k: tree[k].array(library='np').tolist() for k in tree.keys()}
print(json.dumps(arr))
`;
  const out = execFileSync('python3', ['-c', py], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function readE10TenKeV() {
  if (!existsSync(E10_ARTIFACT)) return null;
  const d = JSON.parse(readFileSync(E10_ARTIFACT, 'utf8'));
  const r = d.summary.perEnergyHeadline.find((p) => p.eEv === 10000);
  return r ? r.g : null;
}

function findChem6GAtTime(ntuple, targetSec) {
  // ntuple has columns: speciesID, number, nEvent, speciesName, time, sumG, sumG2
  // For each (speciesID, time) we want G/N = sumG/N and SE = sqrt((sumG2/N - (sumG/N)^2)/(N-1)).
  // chem6 stores TIME in seconds (ROOT default). Filter to rows matching targetSec.
  const sid = ntuple.speciesID;
  const numbers = ntuple.number;
  const nEvent = ntuple.nEvent;
  const names = ntuple.speciesName;
  const times = ntuple.time;
  const sumG = ntuple.sumG;
  const sumG2 = ntuple.sumG2;
  // Build per-(species, time) summary
  const map = new Map();
  for (let i = 0; i < sid.length; i++) {
    if (Math.abs(times[i] - targetSec) > targetSec * 0.05) continue;
    const key = `${sid[i]}|${names[i]}`;
    if (!map.has(key)) {
      map.set(key, { sid: sid[i], name: names[i], N: nEvent[i], sumG: sumG[i], sumG2: sumG2[i], number: numbers[i] });
    } else {
      const v = map.get(key);
      v.sumG += sumG[i];
      v.sumG2 += sumG2[i];
      v.number += numbers[i];
      // nEvent is total events for the run, should be same across entries
    }
  }
  // Compute mean + SE
  const out = [];
  for (const v of map.values()) {
    const N = v.N;
    const mean = v.sumG / N;
    const variance = N > 1 ? Math.max(0, v.sumG2 / N - mean ** 2) : 0;
    const se = N > 1 ? Math.sqrt(variance / (N - 1)) : 0;
    out.push({ chem6_sid: v.sid, name: v.name, N, mean, se, number: v.number });
  }
  return out;
}

export async function runE10c({ nPrimaries = N_PRIMARIES_DEFAULT } = {}) {
  const env = captureEnv();
  const meta = {
    protocol: 'E10c-vs-chem6-at-10keV',
    hypothesis:
      'WebGPU IRT G(species, 1 μs) at 10 keV agrees with Geant4 11.4.1 chem6 (matched LET, G4EmDNAPhysics_option2, Meesungnoen2002 solvation, IRT time-step model) within 20% per species AND within 3σ of chem6 MC noise. Tests whether the 0.62× / 0.56× deficit vs Karamitros 2011 is real LET-deficit physics (this experiment passes) or a chemistry bug (this fails).',
    passBar:
      'Per species: |ratio − 1| < 0.20 AND |G_wgsl − G_chem6| / sqrt(SE_wgsl² + SE_chem6²) < 3. Reported informationally if chem6 N < 50.',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      chem6Bin: CHEM6_BIN.replace(homedir(), '~'),
      geant4Env: GEANT4_SCRIPT.replace(homedir(), '~'),
      chem6Macro: MACRO_PATH.replace(REPO_ROOT + '/', ''),
      wgslReference: E10_ARTIFACT.replace(REPO_ROOT + '/', ''),
      speciesMap: 'chem6 species table (chem6.out): 0=H3O+, 1=OH, 2=OH-, 3=eaq, 4=H, 5=H2, 6=H2O2',
    },
    config: { nPrimaries, targetTime: TARGET_TIME, primaryEnergyEv: 10000 },
  };

  if (!existsSync(CHEM6_BIN) || !existsSync(GEANT4_SCRIPT)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `chem6 binary or Geant4 env script missing: ${CHEM6_BIN} / ${GEANT4_SCRIPT}`,
      summary: { headline: 'skipped (chem6 not installed)' }, rows: [],
    };
  }

  const wgslG = readE10TenKeV();
  if (!wgslG) {
    return {
      meta, env, status: 'skip',
      diagnosis: `E10 reference artifact missing: ${E10_ARTIFACT}`,
      summary: { headline: 'skipped (E10 artifact missing)' }, rows: [],
    };
  }

  console.error(`[E10c] running chem6 at 10 keV with N=${nPrimaries} primaries…`);
  const elapsedSec = await runChem6(nPrimaries);
  console.error(`[E10c]   chem6 wall: ${elapsedSec.toFixed(1)}s`);

  const rootPath = join(RUN_DIR, 'Gvalue0.root');
  if (!existsSync(rootPath)) {
    return {
      meta, env, status: 'fail',
      diagnosis: `chem6 did not produce ${rootPath}. Check ${RUN_DIR}/chem6.log`,
      summary: { headline: 'chem6 produced no ROOT output' }, rows: [],
    };
  }

  const ntuple = readChem6Ntuple(rootPath);
  // chem6 stores time in NANOSECONDS in the ntuple (verified empirically:
  // checkpoints land at [0.0001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0]
  // which corresponds to the macro's addTimeToRecord values [0.1ps, 1ps,
  // 10ps, 100ps, 1ns, 10ns, 100ns, 1 microsecond]). So 1 μs = 1000.0 ns.
  const targetTimeNs = 1000.0;
  const chem6At1us = findChem6GAtTime(ntuple, targetTimeNs);

  // SE on WGSL IRT side: E10 stores single-run G-values without per-sample SE
  // — use a conservative MC SE estimate scaled from N=4096 (the rad_buf dump).
  // For an order-of-magnitude G uncertainty at our N: σ_G ≈ G / sqrt(N), so
  // SE ≈ G / sqrt(4096) ≈ G / 64.
  const seWgslEstimate = (g) => g / Math.sqrt(4096);

  const rows = [];
  let nPassed = 0;
  let nFailed = 0;
  const speciesResults = [];

  for (const [chem6Sid, e10Name] of Object.entries(CHEM6_TO_E10)) {
    const sidNum = parseInt(chem6Sid, 10);
    const chem6Row = chem6At1us.find((r) => r.chem6_sid === sidNum);
    const wgslVal = wgslG[e10Name];
    if (chem6Row === undefined || wgslVal === undefined) {
      rows.push({ metric: `species_${e10Name}`, status: 'fail', note: `missing chem6 sid=${chem6Sid} or wgsl ${e10Name}` });
      nFailed++;
      continue;
    }
    const gWgsl = wgslVal;
    const gChem6 = chem6Row.mean;
    const seChem6 = chem6Row.se;
    const seWgsl = seWgslEstimate(gWgsl);
    const ratio = gWgsl / gChem6;
    const sigma = Math.abs(gWgsl - gChem6) / Math.sqrt(seWgsl ** 2 + seChem6 ** 2);
    const ratioPass = Math.abs(ratio - 1) < 0.20;
    const sigmaPass = sigma < 3;
    const passed = ratioPass && sigmaPass;
    if (passed) nPassed++;
    else nFailed++;

    speciesResults.push({ name: e10Name, gWgsl, gChem6, ratio, sigma });
    rows.push({
      metric: `species_${e10Name}`,
      gWgsl,
      gChem6,
      seChem6,
      seWgsl_estimated: seWgsl,
      ratio,
      delta: gWgsl - gChem6,
      sigma,
      passBar: '|ratio - 1| < 0.20 AND sigma < 3',
      status: passed ? 'pass' : 'fail',
    });
  }

  rows.push({
    metric: 'chem6_run_metadata',
    nPrimaries,
    chem6_wall_sec: elapsedSec,
    chem6_nEvents_in_ntuple: chem6At1us[0]?.N ?? null,
    chem6Bin: CHEM6_BIN.replace(homedir(), '~'),
    status: 'informational',
  });

  const status = nFailed === 0 ? 'pass' : 'fail';
  let diagnosis = null;
  if (status === 'fail') {
    diagnosis = speciesResults
      .filter((s) => Math.abs(s.ratio - 1) >= 0.2 || s.sigma >= 3)
      .map((s) => `${s.name}: WGSL ${s.gWgsl.toFixed(3)} vs chem6 ${s.gChem6.toFixed(3)} (ratio ${s.ratio.toFixed(3)}, ${s.sigma.toFixed(1)}σ)`)
      .join('; ');
  }

  const summary = {
    nPrimaries,
    chem6WallSec: elapsedSec,
    nPassed,
    nFailed,
    perSpecies: speciesResults.map((s) => ({
      name: s.name,
      wgsl: s.gWgsl,
      chem6: s.gChem6,
      ratio: s.ratio,
      sigma: s.sigma,
    })),
    headline: speciesResults
      .map((s) => `G(${s.name})=${s.gWgsl.toFixed(2)}/${s.gChem6.toFixed(2)} (${s.ratio.toFixed(2)}×)`)
      .join('  '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
