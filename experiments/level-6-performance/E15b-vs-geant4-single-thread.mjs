// E15b — Same-machine head-to-head: Geant4 11.3.0 single-thread vs WebGPU.
//
// Times the Geant4 dnaphysics extended-example binary on our exact
// `validation/run_validation.mac` (10 keV, 4096 primaries, DNA_Opt2,
// 30 μm cube), running 3 trials and taking the median wall-clock.
//
// Compares against three matched WebGPU quantities:
//   - Phase A (primary tracking only, from E15 N=4096 median)
//   - Phase A + Phase B (primary + secondary tracking, from
//     dumps/manifest.json `physics_ms`)
//   - Phase A + Phase B + IRT chemistry (end-to-end pre-DNA, from
//     dumps/manifest.json physics_ms + dumps/result_E10000.json `t_wall`)
//
// The most physically fair single-number comparison is **Phase A + B
// vs Geant4**: both are pure physics tracking, neither includes
// radiolysis chemistry (Geant4's dnaphysics example writes the per-event
// ntuple but does not run the radiochemistry stage).
//
// Pass bar (per L6 protocol thesis):
//   Phase A+B speedup vs Geant4 single-thread ≥ 100.
//
// Geant4 install: ~/Downloads/geant4-install (built fresh 2026-05-11
// from ~/Downloads/geant4-11.3.0 source). dnaphysics example built at
// ~/Downloads/dnaphysics-build (cmake + make). The runner sources
// geant4.sh to load the data-file env vars (G4LEDATA, G4LEVELGAMMADATA,
// etc.) before invoking dnaphysics.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GEANT4_INSTALL = join(homedir(), 'Downloads', 'geant4-v11.4.1-install');
const GEANT4_SCRIPT = join(GEANT4_INSTALL, 'bin', 'geant4.sh');
const DNAPHYSICS_BIN = join(homedir(), 'Downloads', 'dnaphysics-v11.4.1-build', 'dnaphysics');
const VALIDATION_MAC = join(REPO_ROOT, 'validation', 'run_validation.mac');
const WGSL_MANIFEST = join(REPO_ROOT, 'dumps', 'manifest.json');
const WGSL_IRT_E10K = join(REPO_ROOT, 'dumps', 'result_E10000.json');
const WGSL_E15_LATEST = join(
  REPO_ROOT,
  'experiments',
  'results',
  '2026-05-11',
  'level-6',
  'E15-phase-a-alpha-beta.json',
);

const N_TRIALS = 3;
const N_PRIMARIES = 4096;
const ENERGY_EV = 10000;

function runGeant4Once() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    // Source the geant4.sh env-vars script in bash, then exec dnaphysics
    // with the validation macro. The data-file env vars are required for
    // physics tables to load.
    const cmd = `source "${GEANT4_SCRIPT}" && "${DNAPHYSICS_BIN}" "${VALIDATION_MAC}" >/dev/null 2>&1`;
    const proc = spawn('bash', ['-c', cmd], { cwd: '/tmp' });
    proc.on('exit', (code) => {
      const wallSec = (Date.now() - t0) / 1000;
      if (code === 0) resolve(wallSec);
      else reject(new Error(`dnaphysics exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

function stats(xs) {
  if (xs.length === 0) return { median: 0, mean: 0, std: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.length > 1
      ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
      : 0;
  return {
    median: median(xs),
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

function readWgslBaselines() {
  // WebGPU Phase A median from E15 (most recent artifact)
  let phaseAMs = null;
  if (existsSync(WGSL_E15_LATEST)) {
    const a = JSON.parse(readFileSync(WGSL_E15_LATEST, 'utf8'));
    const row = a.rows.find((r) => r.N === N_PRIMARIES);
    if (row) phaseAMs = row.median_ms;
  }

  // Phase A + Phase B from dumps/manifest.json
  let phaseABMs = null;
  if (existsSync(WGSL_MANIFEST)) {
    const m = JSON.parse(readFileSync(WGSL_MANIFEST, 'utf8'));
    const entry = m.find((e) => e.E === ENERGY_EV && e.n_therm === N_PRIMARIES);
    if (entry) phaseABMs = entry.physics_ms;
  }

  // IRT chemistry wall from dumps/result_E10000.json
  let irtMs = null;
  if (existsSync(WGSL_IRT_E10K)) {
    const r = JSON.parse(readFileSync(WGSL_IRT_E10K, 'utf8'));
    if (typeof r.t_wall === 'number') irtMs = r.t_wall;
  }

  return { phaseAMs, phaseABMs, irtMs };
}

export async function runE15b() {
  const env = captureEnv();
  const meta = {
    protocol: 'E15b-vs-geant4-single-thread',
    hypothesis:
      'For matched 10 keV × N=4096 primaries × DNA_Opt2 physics, the WebGPU Phase A + Phase B (primary + secondary tracking, not including radiolysis chemistry) wall-clock is ≥ 100× faster than Geant4 11.3.0 single-thread on the same machine (M2 Pro).',
    passBar:
      'speedup_AB_vs_geant4 = T_geant4_median / T_wgsl_phaseAB ≥ 100. Reports the same ratio for Phase A only (upper-bound speedup of fused dispatch alone) and for Phase A+B+IRT (end-to-end pre-DNA pipeline) as additional context, but the pass condition is on Phase A+B (matched scope).',
    seed: `E15_DISPATCH=0x${SEEDS.E15_DISPATCH.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: N_TRIALS,
    sources: {
      geant4Bin: DNAPHYSICS_BIN.replace(homedir(), '~'),
      geant4Env: GEANT4_SCRIPT.replace(homedir(), '~'),
      geant4Macro: VALIDATION_MAC.replace(REPO_ROOT + '/', ''),
      wgslPhaseA: WGSL_E15_LATEST.replace(REPO_ROOT + '/', ''),
      wgslPhaseAB: WGSL_MANIFEST.replace(REPO_ROOT + '/', ''),
      wgslIrt: WGSL_IRT_E10K.replace(REPO_ROOT + '/', ''),
    },
  };

  // Sanity check: Geant4 installed
  if (!existsSync(GEANT4_SCRIPT) || !existsSync(DNAPHYSICS_BIN)) {
    return {
      meta,
      env,
      status: 'skip',
      diagnosis: `Geant4 install or dnaphysics binary missing: ${GEANT4_SCRIPT}, ${DNAPHYSICS_BIN}. Build via the geant4-build / dnaphysics-build cmake instructions in CLAUDE.md.`,
      summary: { headline: 'skipped (Geant4 not installed)' },
      rows: [],
    };
  }

  // Run Geant4 N_TRIALS times
  const trialsSec = [];
  for (let i = 0; i < N_TRIALS; i++) {
    const t = await runGeant4Once();
    trialsSec.push(t);
  }
  const g4Stats = stats(trialsSec);

  // Read WebGPU baselines from existing artifacts
  const wgsl = readWgslBaselines();

  const rows = [];
  let phaseABRatio = null;
  let phaseARatio = null;
  let phaseABCIrtRatio = null;

  if (wgsl.phaseAMs !== null) {
    phaseARatio = (g4Stats.median * 1000) / wgsl.phaseAMs;
    rows.push({
      metric: 'speedup_vs_geant4_phaseA',
      scope: 'WebGPU Phase A (primary tracking only) vs Geant4 (full physics)',
      t_geant4_median_ms: g4Stats.median * 1000,
      t_wgsl_ms: wgsl.phaseAMs,
      speedup: phaseARatio,
      note: 'Upper bound — scopes do not match (Phase A is primary-only, Geant4 simulates primaries + cascade). Reported for context, not pass-bar.',
      status: 'informational',
    });
  }

  if (wgsl.phaseABMs !== null) {
    phaseABRatio = (g4Stats.median * 1000) / wgsl.phaseABMs;
    rows.push({
      metric: 'speedup_vs_geant4_phaseAB',
      scope: 'WebGPU Phase A + Phase B (primary + secondary tracking, no chemistry) vs Geant4 (primary + secondary tracking, no chemistry)',
      t_geant4_median_ms: g4Stats.median * 1000,
      t_wgsl_ms: wgsl.phaseABMs,
      speedup: phaseABRatio,
      passBar: 'speedup ≥ 100 (the L6 thesis)',
      status: phaseABRatio !== null && phaseABRatio >= 100 ? 'pass' : 'fail',
    });
  }

  if (wgsl.phaseABMs !== null && wgsl.irtMs !== null) {
    const endToEndMs = wgsl.phaseABMs + wgsl.irtMs;
    phaseABCIrtRatio = (g4Stats.median * 1000) / endToEndMs;
    rows.push({
      metric: 'speedup_vs_geant4_end_to_end',
      scope: 'WebGPU Phase A + B + IRT chemistry (end-to-end pre-DNA pipeline) vs Geant4 single-thread physics tracking',
      t_geant4_median_ms: g4Stats.median * 1000,
      t_wgsl_phaseAB_ms: wgsl.phaseABMs,
      t_wgsl_irt_ms: wgsl.irtMs,
      t_wgsl_total_ms: endToEndMs,
      speedup: phaseABCIrtRatio,
      note: 'Scopes match for the physics tracking (both include primary + cascade), but WebGPU additionally runs IRT chemistry on CPU. Geant4 here does NOT run chemistry — would require chem6 / dnaChem example. Reported informationally — surfaces that IRT chemistry on CPU is the system bottleneck.',
      status: 'informational',
    });
  }

  rows.push({
    metric: 'geant4_trial_distribution',
    trialsSec,
    median_sec: g4Stats.median,
    mean_sec: g4Stats.mean,
    std_sec: g4Stats.std,
    min_sec: g4Stats.min,
    max_sec: g4Stats.max,
    status: 'informational',
  });

  // Status: pass on the AB comparison (matched scope), informational otherwise.
  const passRow = rows.find((r) => r.metric === 'speedup_vs_geant4_phaseAB');
  let status = 'pass';
  let diagnosis = null;
  if (!passRow) {
    status = 'fail';
    diagnosis = 'WebGPU Phase A+B baseline missing (dumps/manifest.json does not contain a 10 keV / 4096 entry). Cannot compute matched-scope speedup.';
  } else if (passRow.speedup < 100) {
    status = 'fail';
    diagnosis = `Phase A+B speedup = ${passRow.speedup.toFixed(1)}× < 100 (L6 thesis pass bar)`;
  }

  const summary = {
    nPrimaries: N_PRIMARIES,
    primaryEnergyEv: ENERGY_EV,
    nGeant4Trials: N_TRIALS,
    geant4MedianSec: g4Stats.median,
    wgslPhaseAMs: wgsl.phaseAMs,
    wgslPhaseABMs: wgsl.phaseABMs,
    wgslIrtMs: wgsl.irtMs,
    speedupPhaseA: phaseARatio,
    speedupPhaseAB: phaseABRatio,
    speedupEndToEnd: phaseABCIrtRatio,
    headline:
      phaseABRatio !== null
        ? `Geant4 median ${g4Stats.median.toFixed(1)}s vs WGSL Phase A+B ${wgsl.phaseABMs} ms → ${phaseABRatio.toFixed(0)}× speedup (physics tracking, matched scope)`
        : `Geant4 median ${g4Stats.median.toFixed(1)}s; WGSL Phase A+B baseline missing`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
