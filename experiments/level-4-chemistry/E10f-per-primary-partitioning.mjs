// E10f — Test the per-primary IRT partitioning hypothesis (PHYSICS_DIAGNOSIS
// §1 hypothesis B, promoted to lead after E10e refuted hypothesis #4).
//
// Our IRT worker groups rad_buf records by pid and runs IRT chemistry
// PER PRIMARY (irt-worker.js:459 `priMap`). Chem6 runs all primaries
// together in one big chemistry pool. At early times (t < 1 ps),
// primaries emitted from a common origin still have overlapping cluster
// structure — cross-primary recombination (H+H → H₂, OH+OH → H₂O₂,
// e_aq+e_aq → H₂+2OH⁻) could fire in chem6 but not in our worker.
//
// Method:
//   1. Read dumps/rad_E10000_N4096.bin (the partitioned reference).
//   2. Generate a modified bin with all pids set to 0 (collapses 4096
//      partitions into one). This routes the entire rad_buf through
//      a single IRT chemistry call.
//   3. Run tools/run_irt.cjs on each bin, capture G(H₂) at 0.1 ps.
//   4. ΔG(H₂) = G(no-partition) - G(partitioned).
//
// Pass bar: ΔG(H₂) ≥ 0.06 (closes half of the E9 0.124 deficit) → strong
// support. ΔG(H₂) ≤ 0.02 → refuted. Mid-range → ambiguous.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RUN_IRT = join(REPO_ROOT, 'tools', 'run_irt.cjs');
const TMP_DIR = join('/tmp', 'webgpu-dna-e10f');
const N_PRIMARIES = 4096;
const N_SAMPLE = 128; // Subsample for tractable no-partition IRT
                     // (5.3M radicals in one pool is O(N²) intractable;
                     // 128 primaries ≈ 165K radicals is tractable.)
const E_EV = 10000;
const RECORD_BYTES = 16;

function subsampleAndMaybeCollapse(srcPath, dstPath, nSample, collapse) {
  const buf = readFileSync(srcPath);
  const recordCount = buf.length / RECORD_BYTES;
  const srcF32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  // Bucket records by pid
  const buckets = Array.from({ length: N_PRIMARIES }, () => []);
  for (let i = 0; i < recordCount; i++) {
    const encoded = Math.round(srcF32[i * 4 + 3]);
    const pid = encoded >>> 3;
    if (pid < N_PRIMARIES) buckets[pid].push(i);
  }
  // Take the first nSample primaries' records. (Deterministic subsample;
  // since pids are assigned by atomic dispatch order, the first nSample
  // is a uniform sample of the total.)
  const recIdxs = [];
  for (let pid = 0; pid < nSample; pid++) recIdxs.push(...buckets[pid]);
  const out = new Float32Array(recIdxs.length * 4);
  for (let k = 0; k < recIdxs.length; k++) {
    const off = recIdxs[k] * 4;
    out[k * 4] = srcF32[off];
    out[k * 4 + 1] = srcF32[off + 1];
    out[k * 4 + 2] = srcF32[off + 2];
    const encoded = Math.round(srcF32[off + 3]);
    if (collapse) {
      out[k * 4 + 3] = encoded % 8; // pid=0
    } else {
      // Renumber pids 0..nSample-1 so they're dense (no gaps)
      out[k * 4 + 3] = encoded;
    }
  }
  writeFileSync(dstPath, Buffer.from(out.buffer));
  return { path: dstPath, nRecords: recIdxs.length };
}

function runIrtAndExtract(binPath, nTherm) {
  const stdout = execFileSync('node', [RUN_IRT, binPath, String(nTherm), String(E_EV)], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1];
  return JSON.parse(lastLine);
}

function getCheckpointAt(timeline, label) {
  return timeline.find((cp) => cp.label === label);
}

export async function runE10f() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10f-per-primary-partitioning',
    hypothesis:
      'PHYSICS_DIAGNOSIS §1 hypothesis B (newly promoted to lead post-E10e): our per-primary IRT partitioning loses cross-primary recombination chemistry that chem6 captures. Routing all 4096 primaries through one chemistry call should close part of the G(H₂) and G(H₂O₂) pre-chem deficits.',
    passBar:
      'ΔG(H₂) ≥ 0.06 at 0.1 ps (closes half of E9 deficit of 0.124) → strong support; ΔG(H₂) ≤ 0.02 → refuted; mid-range → ambiguous.',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      radBin: 'dumps/rad_E10000_N4096.bin',
      irtTool: 'tools/run_irt.cjs (shimmed WebWorker)',
      worker: 'public/irt-worker.js',
    },
    config: { energy_eV: E_EV, n_primaries_total: N_PRIMARIES, n_primaries_sample: N_SAMPLE },
  };

  if (!existsSync(BIN_PATH)) {
    return { meta, env, status: 'skip', diagnosis: 'rad_E10000_N4096.bin missing', summary: { headline: 'skipped' }, rows: [] };
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const partPath = join(TMP_DIR, `rad_E10000_part_n${N_SAMPLE}.bin`);
  const noPartPath = join(TMP_DIR, `rad_E10000_nopart_n${N_SAMPLE}.bin`);
  const partInfo = subsampleAndMaybeCollapse(BIN_PATH, partPath, N_SAMPLE, false);
  const noPartInfo = subsampleAndMaybeCollapse(BIN_PATH, noPartPath, N_SAMPLE, true);
  console.error(`[E10f] subsampled to ${N_SAMPLE} primaries: partitioned=${partInfo.nRecords} records, no_partition=${noPartInfo.nRecords} records`);

  console.error('[E10f] running IRT on PARTITIONED rad_buf …');
  const partitioned = runIrtAndExtract(partPath, N_SAMPLE);
  console.error('[E10f] running IRT on NO-PARTITION rad_buf …');
  const noPart = runIrtAndExtract(noPartPath, N_SAMPLE);

  const cpPart = getCheckpointAt(partitioned.timeline, '0.1ps');
  const cpNoPart = getCheckpointAt(noPart.timeline, '0.1ps');
  const cp1usPart = getCheckpointAt(partitioned.timeline, '1us');
  const cp1usNoPart = getCheckpointAt(noPart.timeline, '1us');

  const dGH2_0p1ps = (cpNoPart?.G_H2 ?? 0) - (cpPart?.G_H2 ?? 0);
  const dGH2O2_0p1ps = (cpNoPart?.G_H2O2 ?? 0) - (cpPart?.G_H2O2 ?? 0);
  const dGOH_0p1ps = (cpNoPart?.G_OH ?? 0) - (cpPart?.G_OH ?? 0);
  const dGeaq_0p1ps = (cpNoPart?.G_eaq ?? 0) - (cpPart?.G_eaq ?? 0);
  const dGH_0p1ps = (cpNoPart?.G_H ?? 0) - (cpPart?.G_H ?? 0);

  const status = dGH2_0p1ps >= 0.06 ? 'pass' : dGH2_0p1ps <= 0.02 ? 'fail' : 'noisy';
  const diagnosis = status === 'pass'
    ? `Per-primary partitioning costs G(H₂)=${dGH2_0p1ps.toFixed(3)} at 0.1 ps — supports hypothesis B, closing ~${(dGH2_0p1ps / 0.124 * 100).toFixed(0)}% of E9 deficit.`
    : status === 'fail'
      ? `ΔG(H₂) = ${dGH2_0p1ps.toFixed(3)} at 0.1 ps — partitioning is NOT the major source of the deficit.`
      : `ΔG(H₂) = ${dGH2_0p1ps.toFixed(3)} — weak/ambiguous evidence.`;

  const summary = {
    G_H2_partitioned_0p1ps: cpPart?.G_H2 ?? null,
    G_H2_no_partition_0p1ps: cpNoPart?.G_H2 ?? null,
    delta_G_H2_0p1ps: dGH2_0p1ps,
    delta_G_H2O2_0p1ps: dGH2O2_0p1ps,
    delta_G_OH_0p1ps: dGOH_0p1ps,
    delta_G_eaq_0p1ps: dGeaq_0p1ps,
    delta_G_H_0p1ps: dGH_0p1ps,
    G_H2_partitioned_1us: cp1usPart?.G_H2 ?? null,
    G_H2_no_partition_1us: cp1usNoPart?.G_H2 ?? null,
    target_deficit: 0.124,
    headline: `dG(H2)@0.1ps=${dGH2_0p1ps.toFixed(3)} dG(H2O2)@0.1ps=${dGH2O2_0p1ps.toFixed(3)} (target=0.124/0.022)`,
  };

  const rows = [
    { metric: 'G_H2_at_0p1ps_partitioned', value: cpPart?.G_H2 ?? null, status: 'informational' },
    { metric: 'G_H2_at_0p1ps_no_partition', value: cpNoPart?.G_H2 ?? null, status: 'informational' },
    { metric: 'delta_G_H2_at_0p1ps', value: dGH2_0p1ps, threshold_pass: 0.06, status: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'noisy' },
    { metric: 'delta_G_H2O2_at_0p1ps', value: dGH2O2_0p1ps, status: 'informational' },
    { metric: 'delta_G_OH_at_0p1ps', value: dGOH_0p1ps, status: 'informational' },
    { metric: 'delta_G_eaq_at_0p1ps', value: dGeaq_0p1ps, status: 'informational' },
    { metric: 'delta_G_H_at_0p1ps', value: dGH_0p1ps, status: 'informational' },
    { metric: 'G_H2_at_1us_partitioned', value: cp1usPart?.G_H2 ?? null, status: 'informational' },
    { metric: 'G_H2_at_1us_no_partition', value: cp1usNoPart?.G_H2 ?? null, status: 'informational' },
  ];

  return { meta, env, status, diagnosis, summary, rows };
}
