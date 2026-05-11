// E10d — G(species, 1 μs) at MATCHED LET vs Geant4 11.4.1 chem6, across
// all 5 primary energies in E10's V-shape sweep.
//
// E10c established WGSL vs chem6 agreement at 10 keV. E10d extends that
// to 1, 3, 5, 10, 20 keV — closes the question of whether the V-shape
// at 1→3 keV that E10 / E10b surfaced is also visible in chem6 (which
// would confirm it as real LET physics, not an IRT-side artifact of
// our worker), and whether the WGSL/chem6 agreement holds across the
// full LET range.
//
// Method: runs validation/chem6_multi_energy.mac (5 beamOn commands at
// different energies), parses Gvalue0.root through Gvalue4.root, reads
// G(species, 1 μs) at each energy, compares to E10's WGSL row.
//
// Pass bar (per species, per energy): |G_wgsl / G_chem6 - 1| < 0.30
// AND chem6 reproduces the WGSL G(eaq) V-shape direction at 1→3 keV.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CHEM6_BIN = join(homedir(), 'Downloads', 'chem6-build', 'chem6');
const GEANT4_SCRIPT = join(homedir(), 'Downloads', 'geant4-v11.4.1-install', 'bin', 'geant4.sh');
const MACRO = join(REPO_ROOT, 'validation', 'chem6_multi_energy.mac');
const RUN_DIR = '/tmp/webgpu-dna-e10d';
const E10_ARTIFACT = join(
  REPO_ROOT, 'experiments', 'results', '2026-05-11', 'level-4', 'E10-irt-vs-karamitros.json',
);

const ENERGIES = [1000, 3000, 5000, 10000, 20000];
const RUN_ID_OF_ENERGY = { 1000: 0, 3000: 1, 5000: 2, 10000: 3, 20000: 4 };
const TARGET_TIME_NS = 1000.0;

const CHEM6_TO_E10 = { 1: 'OH', 3: 'eaq', 4: 'H', 5: 'H2', 6: 'H2O2' };

function runChem6() {
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  const cmd = `source "${GEANT4_SCRIPT}" && "${CHEM6_BIN}" "${MACRO}" > "${RUN_DIR}/chem6.log" 2>&1`;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', cmd], { cwd: RUN_DIR });
    proc.on('exit', (code) => {
      const wallSec = (Date.now() - t0) / 1000;
      if (code !== 0) {
        const log = existsSync(`${RUN_DIR}/chem6.log`)
          ? readFileSync(`${RUN_DIR}/chem6.log`, 'utf8').slice(-1500) : '';
        return reject(new Error(`chem6 exited ${code}; log tail:\n${log}`));
      }
      resolve(wallSec);
    });
    proc.on('error', reject);
  });
}

function readNtuple(rootPath) {
  const py = `
import json, uproot
f = uproot.open('${rootPath}')
t = f['species']
arr = {k: t[k].array(library='np').tolist() for k in t.keys()}
print(json.dumps(arr))
`;
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function findGAt(ntuple, targetTimeNs) {
  const map = new Map();
  for (let i = 0; i < ntuple.speciesID.length; i++) {
    if (Math.abs(ntuple.time[i] - targetTimeNs) > targetTimeNs * 0.05) continue;
    const key = `${ntuple.speciesID[i]}|${ntuple.speciesName[i]}`;
    const N = ntuple.nEvent[i];
    const sumG = ntuple.sumG[i];
    const sumG2 = ntuple.sumG2[i];
    const prior = map.get(key);
    if (prior) {
      prior.sumG += sumG;
      prior.sumG2 += sumG2;
    } else {
      map.set(key, { sid: ntuple.speciesID[i], N, sumG, sumG2 });
    }
  }
  const out = {};
  for (const v of map.values()) {
    const e10name = CHEM6_TO_E10[v.sid];
    if (!e10name) continue;
    const mean = v.sumG / v.N;
    const variance = v.N > 1 ? Math.max(0, v.sumG2 / v.N - mean ** 2) : 0;
    const se = v.N > 1 ? Math.sqrt(variance / (v.N - 1)) : 0;
    out[e10name] = { mean, se, N: v.N };
  }
  return out;
}

export async function runE10d() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10d-vs-chem6-multi-energy',
    hypothesis:
      'WGSL IRT G(species, 1 μs) agrees with Geant4 11.4.1 chem6 within 30% at every species × every energy ∈ {1, 3, 5, 10, 20} keV, AND chem6 reproduces the WGSL G(e⁻aq) V-shape direction at 1→3 keV (G drops from 1 keV to 3 keV, recovers at 5 keV). Confirms the V-shape is real LET physics rather than an IRT-side artifact.',
    passBar:
      'Per species × per energy: |G_wgsl - G_chem6| / G_chem6 < 0.30. AND chem6 G(eaq) drops from 1 keV to 3 keV (V-shape sign).',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      chem6Bin: CHEM6_BIN.replace(homedir(), '~'),
      macro: MACRO.replace(REPO_ROOT + '/', ''),
      wgslReference: E10_ARTIFACT.replace(REPO_ROOT + '/', ''),
    },
    config: { energies: ENERGIES, nPrimariesPerEnergy: '100 (50 at 20 keV)' },
  };

  if (!existsSync(CHEM6_BIN) || !existsSync(GEANT4_SCRIPT)) {
    return { meta, env, status: 'skip', diagnosis: 'chem6 not installed', summary: { headline: 'skipped' }, rows: [] };
  }

  const wgsl = JSON.parse(readFileSync(E10_ARTIFACT, 'utf8'));
  const wgslByEnergy = {};
  for (const r of wgsl.summary.perEnergyHeadline) wgslByEnergy[r.eEv] = r.g;

  const elapsedSec = await runChem6();

  const chem6ByEnergy = {};
  for (const eEv of ENERGIES) {
    const runId = RUN_ID_OF_ENERGY[eEv];
    const rootPath = join(RUN_DIR, `Gvalue${runId}.root`);
    if (!existsSync(rootPath)) throw new Error(`missing ${rootPath}`);
    const ntuple = readNtuple(rootPath);
    chem6ByEnergy[eEv] = findGAt(ntuple, TARGET_TIME_NS);
  }

  const rows = [];
  let nPassed = 0;
  let nFailed = 0;
  const perEnergyPerSpecies = [];
  const speciesNames = ['OH', 'eaq', 'H', 'H2', 'H2O2'];

  for (const eEv of ENERGIES) {
    const wgslG = wgslByEnergy[eEv];
    const chem6G = chem6ByEnergy[eEv];
    if (!wgslG || !chem6G) continue;
    for (const sp of speciesNames) {
      const gW = wgslG[sp];
      const gC = chem6G[sp]?.mean;
      const seC = chem6G[sp]?.se;
      if (gW === undefined || gC === undefined) continue;
      const ratio = gC > 0 ? gW / gC : null;
      const relErr = ratio !== null ? Math.abs(ratio - 1) : null;
      const passed = (relErr ?? Infinity) < 0.30;
      if (passed) nPassed++; else nFailed++;
      perEnergyPerSpecies.push({ eEv, sp, gW, gC, ratio });
      rows.push({
        metric: `species_${sp}_at_E${eEv}`,
        eEv,
        species: sp,
        gWgsl: gW,
        gChem6: gC,
        seChem6: seC,
        ratio,
        passBar: '|ratio - 1| < 0.30',
        status: passed ? 'pass' : 'fail',
      });
    }
  }

  // V-shape check: does chem6 G(eaq) drop from 1 keV to 3 keV?
  const eaq1k = chem6ByEnergy[1000]?.eaq?.mean;
  const eaq3k = chem6ByEnergy[3000]?.eaq?.mean;
  const eaq5k = chem6ByEnergy[5000]?.eaq?.mean;
  const chem6VshapeSign = eaq1k !== undefined && eaq3k !== undefined
    ? eaq3k < eaq1k : null;
  const chem6VshapeDrop = eaq1k !== undefined && eaq3k !== undefined
    ? eaq1k - eaq3k : null;
  const chem6Recovery = eaq3k !== undefined && eaq5k !== undefined
    ? eaq5k > eaq3k : null;
  const vShapePass = chem6VshapeSign === true && chem6Recovery === true;

  rows.push({
    metric: 'chem6_vshape_check',
    chem6_eaq_1keV: eaq1k,
    chem6_eaq_3keV: eaq3k,
    chem6_eaq_5keV: eaq5k,
    drop_1_to_3: chem6VshapeDrop,
    vshape_dropAt1to3: chem6VshapeSign,
    vshape_recoveryAt3to5: chem6Recovery,
    passBar: 'chem6 G(eaq) drops 1→3 keV AND recovers 3→5 keV',
    status: vShapePass ? 'pass' : 'fail',
    note: 'If chem6 reproduces the V-shape, it confirms the WGSL finding (E10/E10b) is real LET physics, not an IRT-side artifact.',
  });

  rows.push({
    metric: 'chem6_run_metadata',
    walltimeSec: elapsedSec,
    nEnergies: ENERGIES.length,
    status: 'informational',
  });

  const status = nFailed === 0 && vShapePass ? 'pass' : 'fail';
  let diagnosis = null;
  if (status === 'fail') {
    const parts = [];
    if (nFailed > 0) parts.push(`${nFailed}/${nPassed + nFailed} species×energy cells outside 30% band`);
    if (!vShapePass) parts.push(`chem6 V-shape not reproduced (drop:${chem6VshapeSign}, recovery:${chem6Recovery})`);
    diagnosis = parts.join('; ');
  }

  const summary = {
    energies: ENERGIES,
    nPassed,
    nFailed,
    chem6_walltime_sec: elapsedSec,
    vshape_chem6_reproduces: vShapePass,
    chem6_eaq: { '1keV': eaq1k, '3keV': eaq3k, '5keV': eaq5k },
    headline: `${nPassed}/${nPassed + nFailed} species×energy cells in 30% band. chem6 V-shape: ${vShapePass ? 'REPRODUCED' : 'NOT reproduced'} (eaq 1keV ${eaq1k?.toFixed(2)} → 3keV ${eaq3k?.toFixed(2)} → 5keV ${eaq5k?.toFixed(2)})`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
