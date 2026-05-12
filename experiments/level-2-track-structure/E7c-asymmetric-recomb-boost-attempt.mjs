// E7c — Asymmetric RECOMB_BOOST attempt (honest negative).
//
// E7b documented the joint-fix structural tradeoff: uniform RECOMB_BOOST
// improves chemistry (G(H₂) +14 pp, G(H₂O₂) +14 pp at 0.1 ps) but
// reduces cascade-ion count (371.9 → 344.6 corrected) because boosting
// the tracked-secondary recomb branch kills more secondaries at the
// source. The "obvious" physics-motivated fix: tracked secondaries
// thermalize 5-10 nm from the H₂O+ (r_track range), so their eaq
// arguably has less dwell time near the H₂O+ — therefore time-
// integrated recomb adds less opportunity than for sub-cutoff
// (Meesungnoen σ ≈ 2.84 nm). Hypothesis: apply RECOMB_BOOST ONLY to
// sub-cutoff + autoionization branches; leave tracked-secondary at
// the un-boosted Onsager rate. Should preserve chemistry while
// recovering cascade ions.
//
// **Result: REFUTED.** The asymmetric variant:
//   - Recovers cascade ions (381.1 vs pre-fix 371.9; v1 was 344.6)
//   - Recovers W-value (26.24 eV vs pre-fix 26.89; v1 was 29.02)
//   - But REVERTS chemistry — RMS dev climbs from 19.0% (v1) to 27.9%
//     (close to baseline 30.3%); G(H₂)@0.1ps drops 0.197 → 0.150
//
// The tracked-secondary recomb branch is the **dominant lever for
// BOTH chemistry and cascade-ion regression**. They can't be
// decoupled with this knob set. A genuine third knob would need to
// be physics-driven — e.g., H₂O⁺ tracking with proper time-
// integration, where recomb fires only when an actual encounter
// happens during the chem timestep regardless of which branch
// spawned the eaq.
//
// This experiment is a SNAPSHOT of the v2 attempt's measured numbers
// (the v2 shaders were applied, validation re-run, then reverted).
// E5d / E7b / E10i artifacts in the committed tree are the v1
// (uniform boost) values; the v2 numbers live only in this file.

import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

// Numbers below were captured from a live v2 run (RECOMB_BOOST applied
// only to sub-cutoff / B1A1-autoion / L2-4-autoion branches; NOT to
// tracked-secondary in primary.wgsl line 310 nor secondary.wgsl
// line 213). After this artifact was captured, the shaders were
// reverted to uniform boost (v1).
const V2_E5D = {
  csda_ratios_by_energy_eV: {
    100: 0.733, 300: 0.810, 500: 0.863, 1000: 0.915,
    3000: 0.984, 5000: 0.984, 10000: 0.993, 20000: 0.995,
  },
  n_improved: 8,
};
const V2_E7B = {
  cascade_ions_corrected: 381.1,
  cascade_ions_h3op_only: 367.7,
  w_corrected_eV: 26.24,
  w_h3op_only_eV: 27.20,
};
const V2_E10I = {
  g_oh_0p1ps: 4.289,
  g_eaq_0p1ps: 3.654,
  g_h_0p1ps: 0.724,
  g_h2_0p1ps: 0.150,
  g_h2o2_0p1ps: 0.032,
  rms_dev_pct: 27.9,
  csda_at_100eV: 0.73,
};
// Reference: v1 numbers (uniform RECOMB_BOOST, shipped) and the
// pre-fix baseline.
const V1 = {
  cascade_ions_corrected: 344.6,
  w_corrected_eV: 29.02,
  rms_dev_pct: 19.0,
  g_h2_0p1ps: 0.197,
};
const PRE_FIX = {
  cascade_ions: 371.9,
  w_eV: 26.89,
  rms_dev_pct: 30.3,
  g_h2_0p1ps: 0.127,
};

export async function runE7c() {
  const env = captureEnv();
  const meta = {
    protocol: 'E7c-asymmetric-recomb-boost-attempt',
    hypothesis:
      'Applying RECOMB_BOOST only to sub-cutoff and autoionization branches (leaving tracked-secondary recomb at un-boosted Onsager) preserves the chemistry G-value improvement from joint-fix v1 while recovering the cascade-ion regression. Rationale: tracked-secondary eaq thermalizes 5-10 nm from H2O+, so time-integrated recomb adds little opportunity there.',
    passBar:
      'Asymmetric variant must (a) keep RMS dev vs chem6 at 0.1 ps below 22% (close to v1\'s 19%) AND (b) recover cascade ions to within 5% of pre-fix (i.e., > 354). PASS iff both met.',
    seed: `E7_IONS_PER_PRI=0x${SEEDS.E7_IONS_PER_PRI.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      shaders_used: 'src/shaders/primary.wgsl line 310 and src/shaders/secondary.wgsl line 213 had RECOMB_BOOST removed (one-shot Onsager only on tracked-secondary). After capture, both reverted to uniform RECOMB_BOOST. Committed shaders are the v1 (uniform) version.',
      live_e5d_v2: 'Captured from a live run; the artifact file was overwritten by the subsequent v1 re-run.',
      live_e7b_v2: 'Captured from a live run.',
      live_e10i_v2: 'Captured from a live run.',
    },
    config: {
      v2_e5d: V2_E5D,
      v2_e7b: V2_E7B,
      v2_e10i: V2_E10I,
      v1_reference: V1,
      pre_fix_reference: PRE_FIX,
    },
  };

  // Pass-bar evaluation (a) chemistry RMS dev (b) cascade ions
  const chemOk = V2_E10I.rms_dev_pct < 22;
  const cascadeOk = V2_E7B.cascade_ions_corrected > 354;
  const status = chemOk && cascadeOk ? 'pass' : 'fail';

  const rows = [
    {
      metric: 'chemistry_rms_dev_at_0p1ps_pct',
      pre_fix: PRE_FIX.rms_dev_pct,
      v1_uniform_boost: V1.rms_dev_pct,
      v2_asymmetric: V2_E10I.rms_dev_pct,
      target_under_22: chemOk,
      status: chemOk ? 'pass' : 'fail',
      note: 'v2 reverts chemistry close to baseline. The asymmetric application did NOT preserve the v1 chemistry benefit.',
    },
    {
      metric: 'cascade_ions_per_primary_at_10keV',
      g4_target: 509.2,
      pre_fix: PRE_FIX.cascade_ions,
      v1_uniform_boost: V1.cascade_ions_corrected,
      v2_asymmetric: V2_E7B.cascade_ions_corrected,
      target_above_354: cascadeOk,
      status: cascadeOk ? 'pass' : 'fail',
      note: 'v2 recovers cascade ions above pre-fix — this part of the hypothesis IS supported.',
    },
    {
      metric: 'W_value_eV',
      icru31_target: 21.4,
      pre_fix: PRE_FIX.w_eV,
      v1_uniform_boost: V1.w_corrected_eV,
      v2_asymmetric: V2_E7B.w_corrected_eV,
      status: 'informational',
      note: 'v2 also recovers W-value below pre-fix; further from ICRU 31 target than v1 only because v1 was further to begin with.',
    },
    {
      metric: 'G_H2_at_0p1ps',
      chem6_target: 0.251,
      pre_fix: PRE_FIX.g_h2_0p1ps,
      v1_uniform_boost: V1.g_h2_0p1ps,
      v2_asymmetric: V2_E10I.g_h2_0p1ps,
      status: 'informational',
      note: 'v1 G(H2) 0.197 vs v2 0.150 — v2 loses most of the chemistry improvement. Confirms tracked-secondary path is the dominant chemistry lever.',
    },
    {
      metric: 'csda_at_100eV_post_v2',
      pre_fix_ratio: 0.587,
      v1_ratio: 0.736,
      v2_ratio: V2_E10I.csda_at_100eV,
      status: 'informational',
      note: 'CSDA preserved under v2 — σ_exc effect dominates here, not the recomb branch.',
    },
  ];

  const diagnosis =
    status === 'pass'
      ? `Asymmetric variant preserves both chemistry (RMS ${V2_E10I.rms_dev_pct}%) and cascade ions (${V2_E7B.cascade_ions_corrected}). Hypothesis supported — tracked-secondary recomb can be separated from chemistry effect.`
      : `Asymmetric variant fails pass bar: chemistry_ok=${chemOk}, cascade_ok=${cascadeOk}. Removing RECOMB_BOOST from tracked-secondary recovers cascade ions (${V2_E7B.cascade_ions_corrected} > 354) but reverts chemistry close to baseline (RMS dev ${V2_E10I.rms_dev_pct}% vs v1's 19%). **The tracked-secondary recomb branch is the dominant lever for BOTH effects — they cannot be decoupled by selective application of this knob.** Genuine third knob needs to be physics-driven (H2O+ tracking with proper time-integration, where recomb fires only on actual encounters).`;

  const summary = {
    chemistry_ok: chemOk,
    cascade_ok: cascadeOk,
    headline: `v2 cascade=${V2_E7B.cascade_ions_corrected} (vs v1 ${V1.cascade_ions_corrected}, pre-fix ${PRE_FIX.cascade_ions}); v2 RMS_dev=${V2_E10I.rms_dev_pct}% (vs v1 ${V1.rms_dev_pct}%, pre-fix ${PRE_FIX.rms_dev_pct}%). v2 trades chemistry for cascade — structural tradeoff is real.`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
