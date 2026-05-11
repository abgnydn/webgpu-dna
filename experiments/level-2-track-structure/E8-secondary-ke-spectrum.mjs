// E8 — Secondary-electron kinetic-energy spectrum at creation, WGSL vs
// Geant4 11.4.1 ntuple.
//
// Every ionization event in primary.wgsl creates a secondary electron with
// kinetic energy sampled from the Born differential cross-section CDF (the
// same one Geant4's G4DNABornIonisationModel1 uses). E8 measures whether
// our CDF sampling actually produces the right energy distribution.
//
// Method:
//   - WGSL side: bench.ts now supports `dumpSecBuf: true` which reads back
//     the sec_buf after Phase A and returns per-secondary KE at creation.
//     Drive at N=4096, E=10 keV via the existing bench harness.
//   - Geant4 side: parse ~/Downloads/dnaphysics-v11.4.1-build/dna.root for
//     stepNum=1 rows on tracks with trackID > 1 (secondaries at creation).
//     The ntuple's `kineticEnergy` field at the FIRST step of each secondary
//     track is the secondary's KE at birth.
//
// Comparison: log-binned histogram from 1 eV to 5 keV (12 bins per decade),
// normalized per primary. Pass bar: per-bin |WGSL_freq − G4_freq| /
// max(WGSL_freq, G4_freq) < 0.30 over bins with > 1% of total counts.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DNA_ROOT = join(homedir(), 'Downloads', 'dnaphysics-v11.4.1-build', 'dna.root');
const N_PRIMARIES = 4096;
const ENERGY_EV = 10000;

const BROWSER_ARGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--no-sandbox',
];

// Bin edges: log-spaced, 1 eV → 5 keV, 4 bins per decade = 14 bins.
const BIN_EDGES = (() => {
  const lo = 1, hi = 5000;
  const N = 14;
  const edges = [];
  for (let i = 0; i <= N; i++) edges.push(lo * (hi / lo) ** (i / N));
  return edges;
})();

function histogram(values, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  for (const v of values) {
    if (v < edges[0] || v >= edges[edges.length - 1]) continue;
    // Binary-search the bin index.
    let lo = 0, hi = counts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (edges[mid] <= v) lo = mid; else hi = mid - 1;
    }
    counts[lo]++;
  }
  return counts;
}

function fetchG4SecondaryKEs() {
  // Use Python+uproot to extract the first-step KE of every PRIMARY-EMITTED
  // secondary AT OR ABOVE the WGSL 7.4 eV solvation cutoff. The WGSL stores
  // these in sec_buf for Phase B tracking; sub-cutoff secondaries are
  // deposited directly into rad_buf as pre-thermalized eaq (species code 5)
  // without per-particle KE. So filtering Geant4 to KE ≥ 7.4 eV is the
  // apples-to-apples comparison.
  const py = `
import json, uproot, numpy as np
f = uproot.open('${DNA_ROOT}')
tr = f['track']
parentID = tr['parentID'].array(library='np')
ke = tr['kineticEnergy'].array(library='np')
flagP = tr['flagParticle'].array(library='np')
# Primary-emitted electron secondaries with KE >= 7.4 eV (matches WGSL's
# above-cutoff scope).
mask = (parentID == 1) & (flagP == 1) & (ke >= 7.4)
print(json.dumps([float(k) for k in ke[mask]]))
`;
  const out = execFileSync('python3', ['-c', py], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export async function runE8() {
  const env = captureEnv();
  const meta = {
    protocol: 'E8-secondary-ke-spectrum',
    hypothesis:
      'WGSL Born-differential CDF sampling for ionization secondaries produces a creation-time KE distribution that matches Geant4 11.4.1\'s ntuple within 30% per bin (over bins with > 1% of counts) at 10 keV primary energy. Bins span 1 eV to 5 keV log-spaced (4/decade).',
    passBar:
      'Per significant bin (> 1% of counts): |freq_wgsl - freq_g4| / max(freq_wgsl, freq_g4) < 0.30.',
    seed: `E8_E_SPECTRUM=0x${SEEDS.E8_E_SPECTRUM.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgsl: 'src/bench.ts (extended 2026-05-11 with dumpSecBuf option)',
      g4Root: DNA_ROOT.replace(homedir(), '~'),
      g4Macro: 'validation/run_validation.mac (10 keV, 4096 primaries, DNA_Opt2)',
    },
    config: { primaryEnergyEv: ENERGY_EV, nPrimaries: N_PRIMARIES, bins: BIN_EDGES.length - 1 },
  };

  if (!existsSync(DNA_ROOT)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `Geant4 dna.root missing: ${DNA_ROOT}. Rebuild dnaphysics and re-run validation/run_validation.mac.`,
      summary: { headline: 'skipped (no G4 ntuple)' }, rows: [],
    };
  }

  // (a) WGSL: dispatch Phase A, dump sec_buf, get KE list.
  let server, browser;
  let wgslKEs;
  let wgslSecN, wgslAdapter;
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('[E8 pageerror]', e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[E8 console]', msg.text());
    });
    await page.goto(`${server.url}/bench.html`);
    await page.waitForFunction(
      () => window.__benchReady === true || typeof window.__benchError === 'string',
      null,
      { timeout: 60_000 },
    );
    const err = await page.evaluate(() => window.__benchError);
    if (err) throw new Error(`bench-page failed: ${err}`);

    const benchOut = await page.evaluate(
      async ({ Ns, warmups, trials, energyEv, seed }) =>
        window.runPhaseABench({
          Ns,
          warmups,
          trials,
          energyEv,
          seed,
          ms: 65536,
          dumpSecBuf: true,
        }),
      { Ns: [N_PRIMARIES], warmups: 1, trials: 1, energyEv: ENERGY_EV, seed: SEEDS.E8_E_SPECTRUM },
    );
    wgslKEs = benchOut.secKEs ?? [];
    wgslSecN = benchOut.secN ?? 0;
    wgslAdapter = benchOut.adapter;
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
  }

  // (b) Geant4: parse dna.root.
  const g4KEs = fetchG4SecondaryKEs();

  // (c) Histogram both, normalize to fraction of total.
  const wgslCounts = histogram(wgslKEs, BIN_EDGES);
  const g4Counts = histogram(g4KEs, BIN_EDGES);
  const wgslTotal = wgslCounts.reduce((a, b) => a + b, 0);
  const g4Total = g4Counts.reduce((a, b) => a + b, 0);

  const rows = [];
  let nSignificant = 0;
  let nPassed = 0;
  const significantThreshold = 0.01;

  for (let i = 0; i < wgslCounts.length; i++) {
    const eLo = BIN_EDGES[i];
    const eHi = BIN_EDGES[i + 1];
    const fWgsl = wgslTotal > 0 ? wgslCounts[i] / wgslTotal : 0;
    const fG4 = g4Total > 0 ? g4Counts[i] / g4Total : 0;
    const significant = Math.max(fWgsl, fG4) > significantThreshold;
    if (!significant) {
      rows.push({
        metric: `bin_${eLo.toFixed(1)}_${eHi.toFixed(1)}_eV`,
        eLo, eHi,
        wgsl_count: wgslCounts[i], g4_count: g4Counts[i],
        wgsl_frac: fWgsl, g4_frac: fG4,
        status: 'informational',
        note: 'below significance threshold (< 1%)',
      });
      continue;
    }
    nSignificant++;
    const denom = Math.max(fWgsl, fG4);
    const relDiff = denom > 0 ? Math.abs(fWgsl - fG4) / denom : 0;
    const passed = relDiff < 0.30;
    if (passed) nPassed++;
    rows.push({
      metric: `bin_${eLo.toFixed(1)}_${eHi.toFixed(1)}_eV`,
      eLo, eHi,
      wgsl_count: wgslCounts[i], g4_count: g4Counts[i],
      wgsl_frac: fWgsl, g4_frac: fG4,
      rel_diff: relDiff,
      passBar: '|Δfreq| / max(freq) < 0.30',
      status: passed ? 'pass' : 'fail',
    });
  }

  rows.push({
    metric: 'totals',
    wgsl_secondaries: wgslTotal,
    wgsl_sec_per_primary: wgslTotal / N_PRIMARIES,
    g4_secondaries: g4Total,
    g4_sec_per_primary: g4Total / N_PRIMARIES,
    g4_total_raw_secondaries: g4KEs.length,
    wgsl_sec_n_raw: wgslSecN,
    note: 'g4_secondaries here counts ONLY those falling within the [1 eV, 5 keV] histogram range; raw count is g4_total_raw_secondaries.',
    status: 'informational',
  });

  const status = nPassed === nSignificant ? 'pass' : 'fail';
  const diagnosis = status === 'fail'
    ? `${nSignificant - nPassed}/${nSignificant} significant bins failed the 30% band`
    : null;

  const summary = {
    nPrimaries: N_PRIMARIES,
    primaryEnergyEv: ENERGY_EV,
    nSignificantBins: nSignificant,
    nBinsPassed: nPassed,
    wgslSecondaries: wgslTotal,
    wgslSecPerPri: wgslTotal / N_PRIMARIES,
    g4Secondaries: g4Total,
    g4SecPerPri: g4Total / N_PRIMARIES,
    headline: `${nPassed}/${nSignificant} significant bins in 30% band. Sec/pri: WGSL ${(wgslTotal / N_PRIMARIES).toFixed(1)} vs G4 ${(g4Total / N_PRIMARIES).toFixed(1)}`,
  };

  return { meta, env: { ...env, adapter: wgslAdapter }, status, diagnosis, summary, rows };
}
