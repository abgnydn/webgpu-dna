// E9 — Pre-chemistry initial G(species) at 0.1 ps vs Geant4 11.4.1 chem6.
//
// The H₂/H₂O₂ deficit surfaced by E10c (G(H₂) 0.75×, G(H₂O₂) 0.71× vs chem6
// at 1 μs and matched 10 keV LET) hypothetically originates in
// pre-chemistry: comparing the 0.1 ps initial G-values is the direct
// diagnostic. Specifically, the H deficit at very early time
// (chem6 ≈ 0.89 vs our IRT ≈ 0.33 at the nearest checkpoint) starves
// the H-producing channels for H₂, propagating to a deficit at 1 μs.
//
// Method:
//   1. Read WGSL IRT timeline at 0.1 ps from experiments/.cache/E10/
//      (the cache is populated by E10 with the freshly-added 0.1 ps
//      checkpoint in public/irt-worker.js; binMtimeMs-keyed against
//      dumps/rad_E10000_N4096.bin so the cache is fresh).
//   2. Read Geant4 chem6's Gvalue0.root from E10c's run (already on disk
//      at /tmp/webgpu-dna-e10c/Gvalue0.root). chem6 records 0.1 ps as
//      time=0.0001 (ntuple time unit is ns).
//   3. Compare per-species G(0.1 ps) at matched 10 keV.
//
// Pass bar: |ratio - 1| < 0.20 per species AND |G_wgsl - G_chem6| /
// sqrt(SE_chem6² + SE_wgsl_estimated²) < 5 per species. Loose because
// chem6 N=100 has substantial MC noise and the WGSL side reports a
// single-run value without SE.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WGSL_CACHE = join(REPO_ROOT, 'experiments', '.cache', 'E10', 'E10000-N4096.json');
const CHEM6_ROOT = '/tmp/webgpu-dna-e10c/Gvalue0.root';

const TARGET_LABEL = '0.1 ps';
const TARGET_TIME_NS = 0.0001;
const ENERGY_EV = 10000;
const N_PRIMARIES = 4096;

// chem6 species ID mapping (verified in E10c):
//   0 = H3O+, 1 = OH, 2 = OH-, 3 = e_aq, 4 = H, 5 = H2, 6 = H2O2.
// WGSL IRT timeline names: OH, eaq, H, H2O2, H2 (no H3O+ tracked downstream).
const CHEM6_TO_E10 = {
  1: 'OH',
  3: 'eaq',
  4: 'H',
  5: 'H2',
  6: 'H2O2',
};

function readChem6Ntuple(rootPath) {
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

function findChem6GAtTime(ntuple, targetTimeNs) {
  const sid = ntuple.speciesID;
  const numbers = ntuple.number;
  const nEvent = ntuple.nEvent;
  const names = ntuple.speciesName;
  const times = ntuple.time;
  const sumG = ntuple.sumG;
  const sumG2 = ntuple.sumG2;
  const map = new Map();
  for (let i = 0; i < sid.length; i++) {
    if (Math.abs(times[i] - targetTimeNs) > targetTimeNs * 0.05) continue;
    const key = `${sid[i]}|${names[i]}`;
    if (!map.has(key)) {
      map.set(key, { sid: sid[i], name: names[i], N: nEvent[i], sumG: sumG[i], sumG2: sumG2[i] });
    } else {
      const v = map.get(key);
      v.sumG += sumG[i];
      v.sumG2 += sumG2[i];
    }
  }
  const out = [];
  for (const v of map.values()) {
    const N = v.N;
    const mean = v.sumG / N;
    const variance = N > 1 ? Math.max(0, v.sumG2 / N - mean ** 2) : 0;
    const se = N > 1 ? Math.sqrt(variance / (N - 1)) : 0;
    out.push({ chem6_sid: v.sid, name: v.name, N, mean, se });
  }
  return out;
}

export async function runE9() {
  const env = captureEnv();
  const meta = {
    protocol: 'E9-prechem-vs-chem6',
    hypothesis:
      'At MATCHED 10 keV LET, WebGPU IRT initial G(species) at 0.1 ps agrees with Geant4 11.4.1 chem6 within 20% per species. A failure here localizes the H₂/H₂O₂ deficit at 1 μs (E10c) to a pre-chemistry stage discrepancy (different OH/H/eaq starting populations) rather than to the IRT reaction rates (which are identical between our worker and chem6 — confirmed line-by-line).',
    passBar:
      'Per species: |ratio − 1| < 0.20 AND |G_wgsl − G_chem6| / sqrt(SE_chem6² + SE_wgsl_estimated²) < 5.',
    seed: `E9_PRECHEM_G_INIT=0x${SEEDS.E9_PRECHEM_G_INIT.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgslCache: WGSL_CACHE.replace(REPO_ROOT + '/', ''),
      chem6Root: CHEM6_ROOT,
      chem6Macro: 'validation/chem6_10keV.mac (same as E10c)',
      irtWorkerTimelineChange:
        'public/irt-worker.js — added 0.0001 ns (0.1 ps) checkpoint 2026-05-11',
      speciesMap: 'chem6 species table: 0=H3O+, 1=OH, 2=OH-, 3=eaq, 4=H, 5=H2, 6=H2O2',
    },
    config: { targetLabel: TARGET_LABEL, targetTimeNs: TARGET_TIME_NS, primaryEnergyEv: ENERGY_EV, nPrimaries: N_PRIMARIES },
  };

  if (!existsSync(WGSL_CACHE)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `WGSL IRT cache missing: ${WGSL_CACHE}. Run "npm run experiments -- E10" first to populate.`,
      summary: { headline: 'skipped (E10 cache missing)' }, rows: [],
    };
  }
  if (!existsSync(CHEM6_ROOT)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `chem6 ROOT output missing: ${CHEM6_ROOT}. Run "npm run experiments -- E10c" first.`,
      summary: { headline: 'skipped (chem6 ROOT output missing)' }, rows: [],
    };
  }

  const cache = JSON.parse(readFileSync(WGSL_CACHE, 'utf8'));
  const timeline = cache.irtResult.timeline;
  const wgslPt = timeline.find((t) => t.label === TARGET_LABEL);
  if (!wgslPt) {
    return {
      meta, env, status: 'fail',
      diagnosis: `WGSL IRT cache has no "${TARGET_LABEL}" timepoint. Found labels: ${timeline.map((t) => t.label).join(', ')}. Delete the cache and re-run E10.`,
      summary: { headline: 'wgsl missing 0.1 ps' }, rows: [],
    };
  }
  const wgslG = {
    OH: wgslPt.G_OH,
    eaq: wgslPt.G_eaq,
    H: wgslPt.G_H,
    H2O2: wgslPt.G_H2O2,
    H2: wgslPt.G_H2,
  };

  const ntuple = readChem6Ntuple(CHEM6_ROOT);
  const chem6At = findChem6GAtTime(ntuple, TARGET_TIME_NS);

  const seWgslEstimate = (g) => Math.abs(g) / Math.sqrt(N_PRIMARIES);
  const rows = [];
  const perSpecies = [];
  let nPassed = 0;
  let nFailed = 0;

  for (const [chem6Sid, e10Name] of Object.entries(CHEM6_TO_E10)) {
    const sidNum = parseInt(chem6Sid, 10);
    const chem6Row = chem6At.find((r) => r.chem6_sid === sidNum);
    const gWgsl = wgslG[e10Name];
    if (chem6Row === undefined || gWgsl === undefined) {
      rows.push({ metric: `species_${e10Name}`, status: 'fail', note: 'missing chem6 or wgsl entry' });
      nFailed++;
      continue;
    }
    const gChem6 = chem6Row.mean;
    const seChem6 = chem6Row.se;
    const seWgsl = seWgslEstimate(gWgsl);
    const ratio = gChem6 > 0 ? gWgsl / gChem6 : NaN;
    const sigma = Math.abs(gWgsl - gChem6) / Math.sqrt(seWgsl ** 2 + seChem6 ** 2);
    const ratioPass = Math.abs(ratio - 1) < 0.20;
    const sigmaPass = sigma < 5;
    const passed = ratioPass && sigmaPass;
    if (passed) nPassed++; else nFailed++;
    perSpecies.push({ name: e10Name, gWgsl, gChem6, ratio, sigma });
    rows.push({
      metric: `species_${e10Name}`,
      gWgsl,
      gChem6,
      seChem6,
      seWgsl_estimated: seWgsl,
      ratio,
      delta: gWgsl - gChem6,
      sigma,
      passBar: '|ratio - 1| < 0.20 AND sigma < 5',
      status: passed ? 'pass' : 'fail',
    });
  }

  rows.push({
    metric: 'wgsl_timeline_metadata',
    label: wgslPt.label,
    t_ns: wgslPt.t_ns,
    n_primaries: N_PRIMARIES,
    energyEv: ENERGY_EV,
    status: 'informational',
  });

  rows.push({
    metric: 'chem6_run_metadata',
    rootPath: CHEM6_ROOT,
    chem6_nEvents: chem6At[0]?.N ?? null,
    status: 'informational',
  });

  const status = nFailed === 0 ? 'pass' : 'fail';
  let diagnosis = null;
  if (status === 'fail') {
    diagnosis = perSpecies
      .filter((s) => Math.abs(s.ratio - 1) >= 0.2 || s.sigma >= 5)
      .map((s) => `${s.name}: WGSL ${s.gWgsl.toFixed(3)} vs chem6 ${s.gChem6.toFixed(3)} (ratio ${s.ratio.toFixed(3)}, ${s.sigma.toFixed(1)}σ)`)
      .join('; ');
  }

  const summary = {
    targetLabel: TARGET_LABEL,
    energyEv: ENERGY_EV,
    nPrimaries: N_PRIMARIES,
    nPassed,
    nFailed,
    perSpecies: perSpecies.map((s) => ({
      name: s.name,
      wgsl: s.gWgsl,
      chem6: s.gChem6,
      ratio: s.ratio,
      sigma: s.sigma,
    })),
    headline: perSpecies
      .map((s) => `G(${s.name})=${s.gWgsl.toFixed(2)}/${s.gChem6.toFixed(2)} (${s.ratio.toFixed(2)}×)`)
      .join('  '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
