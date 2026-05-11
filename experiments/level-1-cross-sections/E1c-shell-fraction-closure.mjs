// E1c — Per-shell ionization fractions XSF0..XSF4 sum to 1.0 at every
// energy where any shell is active.
//
// XSF_i(E) is defined as σ_shell_i(E) / σ_total_ion(E), so by construction
// Σ_i XSF_i(E) = 1 exactly. Any deviation > 5e-3 indicates either
// (a) the converter (tools/convert_g4data.py) introduced rounding loss in
// the WGSL float32 emission, or (b) the WGSL grid has an interpolation
// hole where σ_total > 0 but no shell is selected (would cause
// primary.wgsl to sample shell -1 or skip the event).
//
// This is a cheap internal-consistency check that complements E1b's
// per-shell bit-match — E1b shows each shell tracks G4EMLOW; E1c shows
// the shell selection probabilities are properly normalized.
//
// Pass bar: |Σ XSF_i(E) − 1.0| < 5e-3 for every energy bin where the
// total > 0. Energies where the total is 0 (sub-threshold) must have
// all fractions = 0 (no spurious activity).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';
import { parseWgslArray } from '../lib/xs-bitmatch.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

export async function runE1c() {
  const env = captureEnv();
  const meta = {
    protocol: 'E1c-shell-fraction-closure',
    hypothesis:
      'At every energy in the WGSL XE grid, the per-shell ionization fractions XSF_0..XSF_4 either all equal zero (sub-threshold, no ionization possible) or sum to 1.0 within 5e-3. Verifies that primary.wgsl\'s shell-selection sampling is properly normalized; a fraction-sum < 1.0 would cause occasional missed ionizations, > 1.0 would cause double-counting.',
    passBar:
      '|Σ_i XSF_i(E) - 1.0| < 5e-3 for every energy bin where any shell is active. Bins where all 5 fractions are exactly 0 must also have σ_total = 0 (no inconsistency).',
    seed: `E1_ION_XS=0x${SEEDS.E1_ION_XS.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgsl: 'public/cross_sections.wgsl',
      arrays: 'XE, XI, XSF0..XSF4',
    },
  };

  const wgslText = readFileSync(join(REPO_ROOT, 'public', 'cross_sections.wgsl'), 'utf8');
  const xe = parseWgslArray(wgslText, 'XE');
  const xi = parseWgslArray(wgslText, 'XI');
  const xsf = [];
  for (let i = 0; i < 5; i++) xsf.push(parseWgslArray(wgslText, `XSF${i}`));

  const rows = [];
  let nActive = 0;
  let nActiveOk = 0;
  let nInconsistent = 0;
  let worstDeviation = 0;
  let worstEnergyEv = 0;
  const deviations = [];

  for (let i = 0; i < xe.length; i++) {
    const E = xe[i];
    const sigmaTotal = xi[i];
    let sum = 0;
    for (let s = 0; s < 5; s++) sum += xsf[s][i];

    const allZero = sum === 0;
    const consistent = allZero ? sigmaTotal === 0 : sigmaTotal > 0;
    if (!consistent) nInconsistent++;

    if (sigmaTotal > 0) {
      nActive++;
      const dev = Math.abs(sum - 1.0);
      deviations.push(dev);
      if (dev < 5e-3) nActiveOk++;
      if (dev > worstDeviation) { worstDeviation = dev; worstEnergyEv = E; }
    }

    // Only emit per-energy rows for spot-check (one per decade-ish) to keep
    // the artifact compact.
    if (i % 10 === 0 || i === xe.length - 1) {
      rows.push({
        metric: `bin_${i}`,
        energyEv: E,
        sigma_total: sigmaTotal,
        fractions: xsf.map((arr) => arr[i]),
        sum,
        deviation: Math.abs(sum - 1.0),
        consistent,
        status: !consistent ? 'fail'
          : sigmaTotal === 0 ? 'informational' // sub-threshold, fractions all 0
          : Math.abs(sum - 1.0) < 5e-3 ? 'pass'
          : 'fail',
      });
    }
  }

  const sumPass = nActiveOk === nActive;
  const consistencyPass = nInconsistent === 0;
  const passed = sumPass && consistencyPass;
  const meanDev = deviations.length > 0
    ? deviations.reduce((a, b) => a + b, 0) / deviations.length : 0;
  const maxDev = deviations.length > 0 ? Math.max(...deviations) : 0;

  rows.push({
    metric: 'summary',
    n_energies: xe.length,
    n_active_energies: nActive,
    n_active_within_1em3: nActiveOk,
    n_active_outside_1em3: nActive - nActiveOk,
    n_inconsistent_zero_or_positive: nInconsistent,
    mean_abs_deviation: meanDev,
    max_abs_deviation: maxDev,
    max_dev_at_eV: worstEnergyEv,
    status: passed ? 'pass' : 'fail',
  });

  const status = passed ? 'pass' : 'fail';
  let diagnosis = null;
  if (!sumPass) diagnosis = `${nActive - nActiveOk}/${nActive} active bins have |Σ XSF − 1| > 5e-3 (max ${worstDeviation.toExponential(2)} at ${worstEnergyEv.toFixed(2)} eV)`;
  if (!consistencyPass) diagnosis = `${diagnosis ? diagnosis + '; ' : ''}${nInconsistent} bins have inconsistent zero/positive sigma_total vs fractions`;

  const summary = {
    nEnergyBins: xe.length,
    nActiveBins: nActive,
    nBinsInBand: nActiveOk,
    maxDeviation: maxDev,
    meanDeviation: meanDev,
    headline: `${nActiveOk}/${nActive} active bins in 5e-3 band; max |Σ XSF - 1| = ${maxDev.toExponential(2)} at ${worstEnergyEv.toFixed(1)} eV`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
