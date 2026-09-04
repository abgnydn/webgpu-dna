// Artifact JSON writer. Shape mirrors webgpu-q exactly:
//   { meta, env, status, diagnosis, rows }
// `meta` carries the falsifiable claim (protocol, hypothesis, passBar, seed,
// warmup, trials). `rows` carries per-trial / per-cell observations.
// `status` is "pass" | "fail" | "noisy" at the run level. `diagnosis` is a
// short string explaining the failure when status != "pass".

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeArtifact(outPath, { meta, env, rows, status, diagnosis = null, summary = null }) {
  if (!meta?.protocol || !env?.gitSha || !status || !Array.isArray(rows)) {
    throw new Error(
      `writeArtifact: missing required fields (meta.protocol=${meta?.protocol}, env.gitSha=${env?.gitSha}, status=${status}, rows is array=${Array.isArray(rows)})`,
    );
  }
  const artifact = {
    meta,
    env,
    status,
    diagnosis,
    summary,
    rows,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  return outPath;
}

export function summarize(rows) {
  const total = rows.length;
  const fails = rows.filter((r) => r.status === 'fail').length;
  const noisy = rows.filter((r) => r.status === 'noisy').length;
  return { total, passes: total - fails - noisy, fails, noisy };
}

export function todayUtcDate() {
  // YYYY-MM-DD in UTC, matching webgpu-q's results directory layout.
  return new Date().toISOString().slice(0, 10);
}
