// CLI dispatcher: `node experiments/runner.mjs <experiment-id>`
//
// Looks up the experiment by ID, runs it, writes the artifact JSON to
// experiments/results/<today-utc>/level-N/<id>.json, prints a one-line
// summary to stdout, and exits 0 on pass / 1 on fail.

import { join } from 'node:path';
import { writeArtifact, todayUtcDate } from './lib/artifact.mjs';
import { runE1 } from './level-1-cross-sections/E1-ion-xs-match.mjs';
import { runE2 } from './level-1-cross-sections/E2-exc-xs-match.mjs';
import { runE3 } from './level-1-cross-sections/E3-elastic-xs-match.mjs';
import { runE4 } from './level-1-cross-sections/E4-vib-xs-match.mjs';
import { runE4b } from './level-1-cross-sections/E4b-vib-mode-fractions.mjs';
import { runE5 } from './level-2-track-structure/E5-csda-vs-g4-ntuple.mjs';
import { runE6 } from './level-2-track-structure/E6-mfp-vs-g4-ntuple.mjs';
import { runE6b } from './level-2-track-structure/E6b-sigma-per-process-vs-g4.mjs';
import { runE7 } from './level-2-track-structure/E7-ions-per-primary-cascade.mjs';
import { runE10 } from './level-4-chemistry/E10-irt-vs-karamitros.mjs';
import { runE15 } from './level-6-performance/E15-phase-a-alpha-beta.mjs';
import { runE15b } from './level-6-performance/E15b-vs-geant4-single-thread.mjs';
import { runB0 } from './level-0-env/B0-browser-env.mjs';
import { runB1 } from './level-0-env/B1-harness-liveness.mjs';

const REGISTRY = {
  // Level 0 — env / infrastructure sanity
  B0:  { run: runB0,  level: 'level-0', id: 'B0-browser-env' },
  B1:  { run: runB1,  level: 'level-0', id: 'B1-harness-liveness' },

  // Level 1 — cross-section bit-match
  E1:  { run: runE1,  level: 'level-1', id: 'E1-ion-xs-match' },
  E2:  { run: runE2,  level: 'level-1', id: 'E2-exc-xs-match' },
  E3:  { run: runE3,  level: 'level-1', id: 'E3-elastic-xs-match' },
  E4:  { run: runE4,  level: 'level-1', id: 'E4-vib-xs-match' },
  E4b: { run: runE4b, level: 'level-1', id: 'E4b-vib-mode-fractions' },

  // Level 2 — track structure
  E5:  { run: runE5,  level: 'level-2', id: 'E5-csda-vs-g4-ntuple' },
  E6:  { run: runE6,  level: 'level-2', id: 'E6-mfp-vs-g4-ntuple' },
  E6b: { run: runE6b, level: 'level-2', id: 'E6b-sigma-per-process-vs-g4' },
  E7:  { run: runE7,  level: 'level-2', id: 'E7-ions-per-primary-cascade' },

  // Level 4 — chemistry
  E10: { run: runE10, level: 'level-4', id: 'E10-irt-vs-karamitros' },

  // Level 6 — performance
  E15:  { run: runE15,  level: 'level-6', id: 'E15-phase-a-alpha-beta' },
  E15b: { run: runE15b, level: 'level-6', id: 'E15b-vs-geant4-single-thread' },
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
