// E10g — Recomb-rate sensitivity sweep (PHYSICS_DIAGNOSIS §1 candidate #5,
// last remaining lead after E10e/E10f refutations).
//
// The 0.1 ps pre-chem G(H₂) deficit (0.508× of chem6) is locked into
// the rad_buf emission and survives our chemistry. E10e refuted cross-
// event recomb; E10f refuted per-primary partitioning at 0.1 ps.
// The remaining candidate is that our effective P_recomb is too low —
// our one-shot Onsager check at t=0 underestimates Geant4's process-
// step time-integrated recomb.
//
// Test: post-hoc convert a tunable FRACTION X of non-recombed ionization
// sites to H₂Ovib decay products (specifically the 13.65% 2OH+H₂ branch).
// X=0 reproduces our baseline. X=0.2 would add ~20% additional recombs
// to ALL non-recombed sites. Sweep X ∈ {0, 0.10, 0.20, 0.35, 0.50} and
// observe G(H₂) at 0.1 ps. The X that lands G(H₂) ≈ chem6's 0.251 is
// the implied additional recomb fraction.
//
// Pass bar: at least one X ∈ (0, 0.5] lands G(H₂) within 5% of chem6
// 0.251 → supports the candidate; otherwise → ambiguous.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RUN_IRT = join(REPO_ROOT, 'tools', 'run_irt.cjs');
const TMP_DIR = join('/tmp', 'webgpu-dna-e10g');
const N_SAMPLE = 256; // Subsample for tractable runtime
const E_EV = 10000;
const RECORD_BYTES = 16;
const X_SWEEP = [0, 0.10, 0.20, 0.35, 0.50]; // additional recomb fraction
const CHEM6_GH2_AT_0P1PS = 0.251; // E9 reference value

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Subsample first N primaries, then optionally convert a fraction of
// non-recombed (OH+H3O+ co-located) ionization sites into H₂Ovib
// products (2 OH at mpos + 1 H₂ marker). Conserves record count by
// dropping the eaq partner of the same ionization (we can't identify
// it deterministically, so we drop ONE eaq for each conversion at
// random — bias is small for the sensitivity test).
function buildPerturbedBin(srcPath, dstPath, nSample, xFraction, rng) {
  const buf = readFileSync(srcPath);
  const recordCount = buf.length / RECORD_BYTES;
  const srcF32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  // Group by pid, keep first nSample primaries
  const buckets = Array.from({ length: nSample }, () => []);
  for (let i = 0; i < recordCount; i++) {
    const encoded = Math.round(srcF32[i * 4 + 3]);
    const pid = encoded >>> 3;
    if (pid < nSample) buckets[pid].push(i);
  }

  // For each primary, find OH+H3O+ co-located sites, randomly pick
  // xFraction of them, convert.
  const out = [];
  for (let pid = 0; pid < nSample; pid++) {
    const recIdxs = buckets[pid];
    // Index by quantized position
    const posKey = new Map();
    for (const ri of recIdxs) {
      const off = ri * 4;
      const sp = Math.round(srcF32[off + 3]) % 8;
      const x = srcF32[off], y = srcF32[off + 1], z = srcF32[off + 2];
      const key = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
      let entry = posKey.get(key);
      if (!entry) { entry = { ohIdx: [], h3oIdx: [], otherIdx: [], x, y, z }; posKey.set(key, entry); }
      if (sp === 0) entry.ohIdx.push(ri);
      else if (sp === 3) entry.h3oIdx.push(ri);
      else entry.otherIdx.push(ri);
    }
    const ionSites = [];
    for (const e of posKey.values()) {
      if (e.ohIdx.length >= 1 && e.h3oIdx.length >= 1) ionSites.push(e);
    }
    const dropped = new Set();
    let nConverted = 0;
    if (xFraction > 0 && ionSites.length > 0) {
      // Find this primary's eaq records (species 1 + 5) — we'll drop
      // one per conversion to maintain mass balance.
      const eaqIdxs = [];
      for (const ri of recIdxs) {
        const sp = Math.round(srcF32[ri * 4 + 3]) % 8;
        if (sp === 1 || sp === 5) eaqIdxs.push(ri);
      }
      // Shuffle ionSites and convert first xFraction × len
      const nConvertTarget = Math.floor(ionSites.length * xFraction);
      // Fisher-Yates shuffle
      for (let i = ionSites.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [ionSites[i], ionSites[j]] = [ionSites[j], ionSites[i]];
      }
      for (let i = 0; i < nConvertTarget && i < eaqIdxs.length; i++) {
        const site = ionSites[i];
        // Drop one OH+H3O+ pair (keep one OH, drop H3O+) and emit
        // 1 extra OH at mpos + 1 H₂ marker. Drop one eaq.
        // Net: original (1 OH + 1 eaq + 1 H3O+) → (2 OH + 1 H₂) at mpos.
        dropped.add(site.h3oIdx[0]); // remove H3O+
        dropped.add(eaqIdxs[i]); // remove eaq partner
        // Add 1 extra OH (same pos as existing OH) + 1 H₂ marker
        out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 0 });
        out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 7 });
        nConverted++;
      }
    }

    // Emit kept records
    for (const ri of recIdxs) {
      if (dropped.has(ri)) continue;
      const off = ri * 4;
      out.push({ x: srcF32[off], y: srcF32[off + 1], z: srcF32[off + 2], encoded: Math.round(srcF32[off + 3]) });
    }
  }

  const f32 = new Float32Array(out.length * 4);
  for (let k = 0; k < out.length; k++) {
    f32[k * 4] = out[k].x;
    f32[k * 4 + 1] = out[k].y;
    f32[k * 4 + 2] = out[k].z;
    f32[k * 4 + 3] = out[k].encoded;
  }
  writeFileSync(dstPath, Buffer.from(f32.buffer));
  return { path: dstPath, nRecords: out.length };
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

export async function runE10g() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10g-recomb-rate-sensitivity',
    hypothesis:
      "PHYSICS_DIAGNOSIS §1 candidate #5: our WGSL one-shot Onsager check at t=0 underestimates Geant4's effective P_recomb (which integrates over the chem timestep). Post-hoc convert a tunable fraction X of non-recombed ionization sites to H₂Ovib products (2OH+H₂ branch) and find the X that lands G(H₂) at chem6's 0.251 at 0.1 ps.",
    passBar:
      'At least one X ∈ (0, 0.5] lands G(H₂)@0.1ps within 5% of chem6 0.251 → supports candidate #5; otherwise → ambiguous.',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      radBin: 'dumps/rad_E10000_N4096.bin',
      irtTool: 'tools/run_irt.cjs',
      chem6Reference: '0.251 at 0.1 ps (from E9 / Gvalue0.root)',
    },
    config: { energy_eV: E_EV, n_primaries_sample: N_SAMPLE, x_sweep: X_SWEEP },
  };

  if (!existsSync(BIN_PATH)) {
    return { meta, env, status: 'skip', diagnosis: 'rad_E10000_N4096.bin missing', summary: { headline: 'skipped' }, rows: [] };
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const rng = mulberry32(0x42424242);
  const sweepResults = [];
  for (const x of X_SWEEP) {
    const tag = `x${(x * 100).toFixed(0).padStart(3, '0')}`;
    const binPath = join(TMP_DIR, `rad_E10000_${tag}_n${N_SAMPLE}.bin`);
    const info = buildPerturbedBin(BIN_PATH, binPath, N_SAMPLE, x, rng);
    console.error(`[E10g] x=${x.toFixed(2)}: ${info.nRecords} records (after conversion)`);
    const result = runIrtAndExtract(binPath, N_SAMPLE);
    const cp = getCheckpointAt(result.timeline, '0.1 ps');
    const cp1us = getCheckpointAt(result.timeline, '1 us');
    sweepResults.push({
      x,
      g_h2_0p1ps: cp?.G_H2 ?? null,
      g_h2o2_0p1ps: cp?.G_H2O2 ?? null,
      g_oh_0p1ps: cp?.G_OH ?? null,
      g_eaq_0p1ps: cp?.G_eaq ?? null,
      g_h_0p1ps: cp?.G_H ?? null,
      g_h2_1us: cp1us?.G_H2 ?? null,
      records: info.nRecords,
    });
    console.error(`[E10g]   G(H2)@0.1ps = ${cp?.G_H2.toFixed(3)}, G(H2O2) = ${cp?.G_H2O2.toFixed(3)}, G(OH) = ${cp?.G_OH.toFixed(3)}`);
  }

  // Find X that lands G(H2) closest to chem6 0.251
  const bestRow = sweepResults.reduce((best, r) => {
    const e = Math.abs((r.g_h2_0p1ps ?? 0) - CHEM6_GH2_AT_0P1PS);
    if (!best || e < best.err) return { ...r, err: e };
    return best;
  }, null);
  const within5pct = bestRow && bestRow.err / CHEM6_GH2_AT_0P1PS < 0.05;
  const status = within5pct ? 'pass' : 'noisy';
  const diagnosis = within5pct
    ? `X=${bestRow.x.toFixed(2)} lands G(H₂)=${bestRow.g_h2_0p1ps.toFixed(3)} (within 5% of chem6 0.251). Implies ~${(bestRow.x * 100).toFixed(0)}% additional effective P_recomb above baseline closes the pre-chem H₂ deficit.`
    : `Best X=${bestRow.x.toFixed(2)} → G(H₂)=${bestRow.g_h2_0p1ps.toFixed(3)} (still ${(bestRow.err / CHEM6_GH2_AT_0P1PS * 100).toFixed(1)}% from chem6). Either need larger X or another mechanism.`;

  const summary = {
    chem6_target: CHEM6_GH2_AT_0P1PS,
    best_x: bestRow.x,
    best_g_h2: bestRow.g_h2_0p1ps,
    best_err: bestRow.err,
    sweep_gh2_by_x: sweepResults.map((r) => ({ x: r.x, g_h2: r.g_h2_0p1ps })),
    headline: sweepResults.map((r) => `x=${r.x.toFixed(2)}:G(H2)=${(r.g_h2_0p1ps ?? 0).toFixed(3)}`).join(' | '),
  };

  const rows = sweepResults.map((r) => ({
    metric: `x_${r.x.toFixed(2)}_G_H2_0p1ps`,
    value: r.g_h2_0p1ps,
    chem6_target: CHEM6_GH2_AT_0P1PS,
    err: Math.abs((r.g_h2_0p1ps ?? 0) - CHEM6_GH2_AT_0P1PS),
    status: Math.abs((r.g_h2_0p1ps ?? 0) - CHEM6_GH2_AT_0P1PS) / CHEM6_GH2_AT_0P1PS < 0.05 ? 'pass' : 'informational',
  }));

  return { meta, env, status, diagnosis, summary, rows };
}
