// CLI dispatcher: `node experiments/runner.mjs <experiment-id>`
//
// Looks up the experiment by ID, runs it, writes the artifact JSON to
// experiments/results/<today-utc>/level-N/<id>.json, prints a one-line
// summary to stdout, and exits 0 on pass / 1 on fail.

import { join } from 'node:path';
import { writeArtifact, todayUtcDate } from './lib/artifact.mjs';
import { runE1 } from './level-1-cross-sections/E1-ion-xs-match.mjs';
import { runE1b } from './level-1-cross-sections/E1b-per-shell-ion-xs.mjs';
import { runE1c } from './level-1-cross-sections/E1c-shell-fraction-closure.mjs';
import { runE2 } from './level-1-cross-sections/E2-exc-xs-match.mjs';
import { runE2b } from './level-1-cross-sections/E2b-per-level-exc-xs.mjs';
import { runE3 } from './level-1-cross-sections/E3-elastic-xs-match.mjs';
import { runE3b } from './level-1-cross-sections/E3b-champion-angular-cdf.mjs';
import { runE4 } from './level-1-cross-sections/E4-vib-xs-match.mjs';
import { runE4b } from './level-1-cross-sections/E4b-vib-mode-fractions.mjs';
import { runE5 } from './level-2-track-structure/E5-csda-vs-g4-ntuple.mjs';
import { runE6 } from './level-2-track-structure/E6-mfp-vs-g4-ntuple.mjs';
import { runE6b } from './level-2-track-structure/E6b-sigma-per-process-vs-g4.mjs';
import { runE7 } from './level-2-track-structure/E7-ions-per-primary-cascade.mjs';
import { runE8 } from './level-2-track-structure/E8-secondary-ke-spectrum.mjs';
import { runE10 } from './level-4-chemistry/E10-irt-vs-karamitros.mjs';
import { runE10b } from './level-4-chemistry/E10b-vshape-bootstrap-sigma.mjs';
import { runE10c } from './level-4-chemistry/E10c-vs-chem6-at-10keV.mjs';
import { runE10d } from './level-4-chemistry/E10d-vs-chem6-multi-energy.mjs';
import { runE9 } from './level-3-prechemistry/E9-prechem-vs-chem6.mjs';
import { runE15 } from './level-6-performance/E15-phase-a-alpha-beta.mjs';
import { runE15b } from './level-6-performance/E15b-vs-geant4-single-thread.mjs';
import { runE15c } from './level-6-performance/E15c-vs-geant4-multi-thread.mjs';
import { runE15d } from './level-6-performance/E15d-phase-a-energy-sweep.mjs';
import { runE16 } from './level-6-performance/E16-fused-vs-naive.mjs';
import { runE12 } from './level-5-dna-damage/E12-ssb-yield-vs-friedland.mjs';
import { runE13 } from './level-5-dna-damage/E13-indirect-vs-direct-ssb.mjs';
import { runE13b } from './level-5-dna-damage/E13b-ssb-radius-parametric.mjs';
import { runE13c } from './level-5-dna-damage/E13c-rerun-ssb-after-fix.mjs';
import { runE11 } from './level-4-chemistry/E11-gpu-chem-vs-irt.mjs';
import { runB0 } from './level-0-env/B0-browser-env.mjs';
import { runB1 } from './level-0-env/B1-harness-liveness.mjs';

const REGISTRY = {
  // Level 0 — env / infrastructure sanity
  B0:  { run: runB0,  level: 'level-0', id: 'B0-browser-env' },
  B1:  { run: runB1,  level: 'level-0', id: 'B1-harness-liveness' },

  // Level 1 — cross-section bit-match
  E1:  { run: runE1,  level: 'level-1', id: 'E1-ion-xs-match' },
  E1b: { run: runE1b, level: 'level-1', id: 'E1b-per-shell-ion-xs' },
  E1c: { run: runE1c, level: 'level-1', id: 'E1c-shell-fraction-closure' },
  E2:  { run: runE2,  level: 'level-1', id: 'E2-exc-xs-match' },
  E2b: { run: runE2b, level: 'level-1', id: 'E2b-per-level-exc-xs' },
  E3:  { run: runE3,  level: 'level-1', id: 'E3-elastic-xs-match' },
  E3b: { run: runE3b, level: 'level-1', id: 'E3b-champion-angular-cdf' },
  E4:  { run: runE4,  level: 'level-1', id: 'E4-vib-xs-match' },
  E4b: { run: runE4b, level: 'level-1', id: 'E4b-vib-mode-fractions' },

  // Level 2 — track structure
  E5:  { run: runE5,  level: 'level-2', id: 'E5-csda-vs-g4-ntuple' },
  E6:  { run: runE6,  level: 'level-2', id: 'E6-mfp-vs-g4-ntuple' },
  E6b: { run: runE6b, level: 'level-2', id: 'E6b-sigma-per-process-vs-g4' },
  E7:  { run: runE7,  level: 'level-2', id: 'E7-ions-per-primary-cascade' },
  E8:  { run: runE8,  level: 'level-2', id: 'E8-secondary-ke-spectrum' },

  // Level 4 — chemistry
  E10:  { run: runE10,  level: 'level-4', id: 'E10-irt-vs-karamitros' },
  E10b: { run: runE10b, level: 'level-4', id: 'E10b-vshape-bootstrap-sigma' },
  E10c: { run: runE10c, level: 'level-4', id: 'E10c-vs-chem6-at-10keV' },
  E10d: { run: runE10d, level: 'level-4', id: 'E10d-vs-chem6-multi-energy' },
  E11:  { run: runE11,  level: 'level-4', id: 'E11-gpu-chem-vs-irt' },

  // Level 3 — pre-chemistry
  E9:   { run: runE9,   level: 'level-3', id: 'E9-prechem-vs-chem6' },

  // Level 6 — performance
  E15:  { run: runE15,  level: 'level-6', id: 'E15-phase-a-alpha-beta' },
  E15b: { run: runE15b, level: 'level-6', id: 'E15b-vs-geant4-single-thread' },
  E15c: { run: runE15c, level: 'level-6', id: 'E15c-vs-geant4-multi-thread' },
  E15d: { run: runE15d, level: 'level-6', id: 'E15d-phase-a-energy-sweep' },
  E16:  { run: runE16,  level: 'level-6', id: 'E16-fused-vs-naive' },

  // Level 5 — DNA damage
  E12:  { run: runE12,  level: 'level-5', id: 'E12-ssb-yield-vs-friedland' },
  E13:  { run: runE13,  level: 'level-5', id: 'E13-indirect-vs-direct-ssb' },
  E13b: { run: runE13b, level: 'level-5', id: 'E13b-ssb-radius-parametric' },
  E13c: { run: runE13c, level: 'level-5', id: 'E13c-rerun-ssb-after-fix' },
};

const REPO_ROOT = join(import.meta.dirname, '..');

async function main() {
  const id = process.argv[2];
  if (!id || !REGISTRY[id]) {
    const known = Object.keys(REGISTRY).join(', ');
    console.error(`usage: node experiments/runner.mjs <id>   (known: ${known})`);
    process.exit(2);
  }

  const entry = REGISTRY[id];
  const result = await entry.run();
  const date = todayUtcDate();
  const outPath = join(REPO_ROOT, 'experiments', 'results', date, entry.level, `${entry.id}.json`);

  writeArtifact(outPath, {
    meta: result.meta,
    env: result.env,
    status: result.status,
    diagnosis: result.diagnosis,
    summary: result.summary,
    rows: result.rows,
  });

  // Print summary line — bit-match metrics if present, else fall back
  // to a generic per-experiment format.
  const s = result.summary ?? {};
  const tag = result.status === 'pass' ? '✓ PASS' : result.status === 'noisy' ? '⚠ NOISY' : '✗ FAIL';
  const headline =
    s.peakRatio !== undefined
      ? `rows=${s.nRows ?? result.rows.length}  peak_ratio=${s.peakRatio.toFixed(4)}  ` +
        `median=${s.medianRelErr.toExponential(2)}  ` +
        `p90=${s.p90RelErr.toExponential(2)}  max=${s.maxRelErrMeaningful.toExponential(2)}`
      : s.nEnergies !== undefined
        ? `energies=${s.nEnergies}  rows=${s.nRows}  failed=${s.nFailedRows ?? 0}  ` +
          `let_trend=OH:${s.letTrendMonotonic?.OH ? '✓' : '✗'} eaq:${s.letTrendMonotonic?.eaq ? '✓' : '✗'}`
        : s.headline !== undefined
          ? `metrics=${s.nMetrics ?? result.rows.length}  failed=${s.nFailedMetrics ?? 0}  ${s.headline}`
          : `rows=${result.rows.length}`;
  console.log(`[${id}] ${tag}  ${headline}  → ${outPath.replace(REPO_ROOT + '/', '')}`);
  if (result.diagnosis) console.log(`  diagnosis: ${result.diagnosis}`);

  process.exit(result.status === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
