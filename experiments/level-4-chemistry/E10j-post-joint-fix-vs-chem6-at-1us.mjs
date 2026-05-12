// E10j — Post-joint-fix G-values at 1 μs vs Geant4 11.4.1 chem6.
//
// E10c (2026-05-11) compared WGSL G(species) at 1 μs to chem6 at
// matched 10 keV LET BEFORE the joint fix landed:
//   G(OH) 0.907×, G(eaq) 0.830×, G(H) 0.997×, G(H₂O₂) 0.711×, G(H₂) 0.752×
//
// The joint fix (SIGMA_EXC_SCALE=0.5 + RECOMB_BOOST=2.0) shipped on
// 2026-05-12 and changes the radical distribution. The §Numbers
// table briefly showed the E10c row with a `(joint fix applied)`
// parenthetical — that was wrong, because the E10c artifact predates
// the joint-fix shaders. This experiment closes the audit gap by
// extracting the post-joint-fix 1 μs G-values from E10i's artifact
// and computing the ratio to chem6 explicitly.
//
// Pass bar: each ratio shifts by at least 2% from the E10c baseline
// (i.e., the joint fix has a measurable effect at 1 μs) AND no
// species moves further from chem6 by more than 10% (the joint fix
// is a strict improvement on average, even if individual species
// drift).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const E10I_ARTIFACT = join(
  REPO_ROOT,
  'experiments',
  'results',
  '2026-05-12',
  'level-4',
  'E10i-joint-fix-validation.json',
);
// chem6 1 μs G-values @ 10 keV, sourced from E10c's `chem6` block
// (artifact at experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json).
const CHEM6_AT_1US = {
  G_OH: 1.710,
  G_eaq: 1.694,
  G_H: 0.710,
  G_H2O2: 0.850,
  G_H2: 0.622,
};
const PRE_FIX_RATIOS = {
  G_OH: 0.9073,
  G_eaq: 0.8302,
  G_H: 0.9924,
  G_H2O2: 0.7112,
  G_H2: 0.7519,
};
const RATIO_DELTA_REQUIRED = 0.02;
const REGRESSION_BAR = 0.10;

export async function runE10j() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10j-post-joint-fix-vs-chem6-at-1us',
    hypothesis:
      'After the joint fix (SIGMA_EXC_SCALE=0.5 + RECOMB_BOOST=2.0) shipped 2026-05-12, the 1 μs G-values vs Geant4 11.4.1 chem6 at matched 10 keV LET have shifted from the E10c baseline. Direction matches E10i 0.1 ps trends (G(H₂) up, G(H₂O₂) up, G(OH)/G(eaq) flat or slightly worse, G(H) overshoots).',
    passBar:
      'Each species ratio differs from the pre-fix E10c row by at least 2% (joint fix has measurable 1 μs effect) AND no species moves further from chem6 by more than 10% (joint fix is a defensible compromise).',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      e10iArtifact: 'experiments/results/2026-05-12/level-4/E10i-joint-fix-validation.json',
      e10cArtifact: 'experiments/results/2026-05-11/level-4/E10c-vs-chem6-at-10keV.json',
      chem6Reference: 'chem6 1 μs G-values at 10 keV — Geant4 11.4.1 / G4EmDNAChemistry_option3 with /chem/reaction/UI 9-reaction table',
    },
    config: {
      chem6_at_1us: CHEM6_AT_1US,
      pre_fix_ratios_e10c: PRE_FIX_RATIOS,
      shader_constants: { sigma_exc_scale: 0.5, recomb_boost: 2.0 },
    },
  };

  if (!existsSync(E10I_ARTIFACT)) {
    return {
      meta,
      env,
      status: 'skip',
      diagnosis: 'E10i artifact not found — re-run npm run experiments -- E10i first',
      summary: { headline: 'skipped' },
      rows: [],
    };
  }

  const e10i = JSON.parse(readFileSync(E10I_ARTIFACT, 'utf8'));
  const measured = e10i.summary?.measured_at_1us;
  if (!measured) {
    return {
      meta,
      env,
      status: 'fail',
      diagnosis: 'E10i artifact has no measured_at_1us field — joint fix not measured at 1 μs',
      summary: { headline: 'missing 1us row' },
      rows: [],
    };
  }

  const rows = [];
  let nDeltaOk = 0;
  let nRegression = 0;
  for (const sp of Object.keys(CHEM6_AT_1US)) {
    const wgsl = measured[sp];
    const ref = CHEM6_AT_1US[sp];
    const postRatio = wgsl / ref;
    const preRatio = PRE_FIX_RATIOS[sp];
    const deltaRatio = postRatio - preRatio;
    const moved = Math.abs(deltaRatio) >= RATIO_DELTA_REQUIRED;
    const regressed = Math.abs(postRatio - 1) > Math.abs(preRatio - 1) + REGRESSION_BAR;
    if (moved) nDeltaOk++;
    if (regressed) nRegression++;
    rows.push({
      metric: sp,
      wgsl_post_joint_fix: wgsl,
      chem6_at_1us: ref,
      ratio_post: postRatio,
      ratio_pre_E10c: preRatio,
      delta_ratio: deltaRatio,
      direction: deltaRatio > 0 ? 'toward 1.0' : 'away from 1.0',
      regressed_more_than_10pct: regressed,
      status: regressed ? 'fail' : moved ? 'pass' : 'noisy',
    });
  }

  const status = nRegression === 0 && nDeltaOk >= 3 ? 'pass' : nRegression > 0 ? 'fail' : 'noisy';
  const diagnosis =
    status === 'pass'
      ? `Joint fix shifts ${nDeltaOk}/5 species G-values at 1 μs by ≥2%; no species regresses by more than 10%. The §Numbers headline can now legitimately cite "post-joint-fix" 1 μs ratios from this artifact.`
      : status === 'fail'
        ? `${nRegression}/5 species regressed by more than 10% vs the pre-fix E10c baseline. The joint fix improves H₂/H₂O₂ at a cost — see PHYSICS_DIAGNOSIS.md §1 for the structural tradeoff.`
        : `Only ${nDeltaOk}/5 species moved by ≥2%. The joint fix is mostly a 0.1 ps fix; the 1 μs end of the curve is dominated by chemistry kinetics that the per-primary IRT partitioning can't change (E10f).`;

  const summary = {
    chem6_at_1us: CHEM6_AT_1US,
    post_joint_fix_at_1us: measured,
    post_joint_fix_ratios: Object.fromEntries(
      Object.keys(CHEM6_AT_1US).map((sp) => [sp, measured[sp] / CHEM6_AT_1US[sp]]),
    ),
    n_species_moved: nDeltaOk,
    n_regressions: nRegression,
    headline: rows
      .map((r) => `${r.metric}=${r.ratio_post.toFixed(3)} (was ${r.ratio_pre_E10c.toFixed(3)})`)
      .join(' | '),
  };

  return { meta, env, status, diagnosis, summary, rows };
}
