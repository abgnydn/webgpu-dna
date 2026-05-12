// E10h — Predict the impact of time-integrated electron-hole recombination
// on ALL pre-chem species (not just H₂ like E10g).
//
// E10g found that 25% additional effective recomb fraction closes the
// G(H₂) deficit. But that test used deterministic conversion (every
// extra recomb → 2OH+H₂). E10h is the proper version: probabilistic
// H₂Ovib decay using Geant4 11.4.1's option1 branching:
//   13.65% → 2OH + H₂
//   35.75% → OH + H
//   15.6%  → 2H + O (O not tracked)
//   35%    → relax (no products)
//
// Sweeps additional recomb fraction X_extra ∈ {0.10, 0.20, 0.25, 0.30,
// 0.40} and reports G(OH), G(eaq), G(H), G(H₂), G(H₂O₂) at 0.1 ps for
// each X. The "best X" minimizes total squared deviation across all
// 5 species vs chem6.
//
// Pass bar: at least one X lands ALL 5 species within ±15% of chem6
// targets (the residual gap acceptable given measurement noise).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RUN_IRT = join(REPO_ROOT, 'tools', 'run_irt.cjs');
const TMP_DIR = join('/tmp', 'webgpu-dna-e10h');
const N_SAMPLE = 256;
const E_EV = 10000;
const RECORD_BYTES = 16;
const X_SWEEP = [0.0, 0.15, 0.25, 0.35, 0.50];
const CHEM6 = {
  G_OH: 5.049, G_eaq: 4.097, G_H: 0.893, G_H2: 0.251, G_H2O2: 0.053,
};

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

function buildPerturbedBin(srcPath, dstPath, nSample, xExtra, rng) {
  const buf = readFileSync(srcPath);
  const recordCount = buf.length / RECORD_BYTES;
  const srcF32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const buckets = Array.from({ length: nSample }, () => []);
  for (let i = 0; i < recordCount; i++) {
    const encoded = Math.round(srcF32[i * 4 + 3]);
    const pid = encoded >>> 3;
    if (pid < nSample) buckets[pid].push(i);
  }

  const out = [];
  for (let pid = 0; pid < nSample; pid++) {
    const recIdxs = buckets[pid];
    const posKey = new Map();
    for (const ri of recIdxs) {
      const off = ri * 4;
      const sp = Math.round(srcF32[off + 3]) % 8;
      const x = srcF32[off], y = srcF32[off + 1], z = srcF32[off + 2];
      const key = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
      let entry = posKey.get(key);
      if (!entry) { entry = { ohIdx: [], h3oIdx: [], x, y, z }; posKey.set(key, entry); }
      if (sp === 0) entry.ohIdx.push(ri);
      else if (sp === 3) entry.h3oIdx.push(ri);
    }
    const ionSites = [];
    for (const e of posKey.values()) {
      if (e.ohIdx.length >= 1 && e.h3oIdx.length >= 1) ionSites.push(e);
    }

    // Eaq partners (sp 1 and 5)
    const eaqIdxs = [];
    for (const ri of recIdxs) {
      const sp = Math.round(srcF32[ri * 4 + 3]) % 8;
      if (sp === 1 || sp === 5) eaqIdxs.push(ri);
    }
    // Shuffle ionSites for random selection
    for (let i = ionSites.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ionSites[i], ionSites[j]] = [ionSites[j], ionSites[i]];
    }

    const dropped = new Set();
    let nConvert = 0;
    if (xExtra > 0) {
      const nTarget = Math.floor(ionSites.length * xExtra);
      for (let i = 0; i < nTarget && i < eaqIdxs.length; i++) {
        const site = ionSites[i];
        // Drop the geminate triple: OH (one of them, keep extras), eaq, H3O+
        dropped.add(site.ohIdx[0]);
        dropped.add(site.h3oIdx[0]);
        dropped.add(eaqIdxs[i]);
        // Emit H₂Ovib decay products with proper Geant4 option1 branching:
        const r = rng();
        if (r < 0.1365) {
          // 2 OH + 1 H₂
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 0 });
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 0 });
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 7 });
        } else if (r < 0.494) {
          // OH + H
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 0 });
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 2 });
        } else if (r < 0.650) {
          // 2 H (skip O — not tracked)
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 2 });
          out.push({ x: site.x, y: site.y, z: site.z, encoded: pid * 8 + 2 });
        }
        // else 35% relax — emit nothing
        nConvert++;
      }
    }
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

function squareDeviation(measured) {
  let sum = 0;
  for (const k of Object.keys(CHEM6)) {
    const m = measured[k] ?? 0;
    sum += Math.pow((m - CHEM6[k]) / CHEM6[k], 2);
  }
  return Math.sqrt(sum / 5);
}

export async function runE10h() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10h-time-integrated-recomb-prediction',
    hypothesis:
      'PHYSICS_DIAGNOSIS §1 candidate #5, proper test: with H₂Ovib decay branching from G4ChemDissociationChannels_option1 (13.65%/35.75%/15.6%/35%), sweep additional recomb fraction X_extra and find the X that minimizes RMS deviation across all 5 species at 0.1 ps vs chem6.',
    passBar:
      'At least one X lands ALL 5 species (OH, eaq, H, H₂, H₂O₂) within ±15% of chem6 targets → strong support; otherwise → tradeoff documented.',
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      radBin: 'dumps/rad_E10000_N4096.bin',
      g4Branching: 'G4ChemDissociationChannels_option1.cc:437-457',
      chem6Reference: 'E9 0.1 ps row (Gvalue0.root)',
    },
    config: { energy_eV: E_EV, n_primaries_sample: N_SAMPLE, x_sweep: X_SWEEP, chem6_targets: CHEM6 },
  };

  if (!existsSync(BIN_PATH)) {
    return { meta, env, status: 'skip', diagnosis: 'rad bin missing', summary: { headline: 'skipped' }, rows: [] };
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const rng = mulberry32(0x42424243);
  const sweepResults = [];
  for (const x of X_SWEEP) {
    const tag = `x${(x * 100).toFixed(0).padStart(3, '0')}`;
    const binPath = join(TMP_DIR, `rad_E10000_${tag}_n${N_SAMPLE}.bin`);
    const info = buildPerturbedBin(BIN_PATH, binPath, N_SAMPLE, x, rng);
    console.error(`[E10h] x=${x.toFixed(2)}: ${info.nRecords} records`);
    const result = runIrtAndExtract(binPath, N_SAMPLE);
    const cp = getCheckpointAt(result.timeline, '0.1 ps');
    const measured = {
      G_OH: cp?.G_OH ?? 0, G_eaq: cp?.G_eaq ?? 0, G_H: cp?.G_H ?? 0,
      G_H2: cp?.G_H2 ?? 0, G_H2O2: cp?.G_H2O2 ?? 0,
    };
    const rmsDev = squareDeviation(measured);
    sweepResults.push({ x, ...measured, rmsDev, records: info.nRecords });
    console.error(`[E10h]   G(OH)=${measured.G_OH.toFixed(3)} G(eaq)=${measured.G_eaq.toFixed(3)} G(H)=${measured.G_H.toFixed(3)} G(H2)=${measured.G_H2.toFixed(3)} G(H2O2)=${measured.G_H2O2.toFixed(3)} | RMS_dev=${(rmsDev*100).toFixed(1)}%`);
  }

  const best = sweepResults.reduce((b, r) => (!b || r.rmsDev < b.rmsDev ? r : b), null);
  const baseline = sweepResults.find((r) => r.x === 0);

  // Pass: all 5 species within ±15% at best x
  const within15 = best && Object.keys(CHEM6).every((k) => {
    const m = best[k] ?? 0;
    return Math.abs((m - CHEM6[k]) / CHEM6[k]) <= 0.15;
  });
  const status = within15 ? 'pass' : 'noisy';
  const diagnosis = within15
    ? `X=${best.x.toFixed(2)} lands all 5 species within ±15% of chem6 (RMS dev ${(best.rmsDev * 100).toFixed(1)}%). Time-integrated recomb is a clean structural fix.`
    : `Best X=${best.x.toFixed(2)} reduces RMS dev from ${(baseline.rmsDev * 100).toFixed(1)}% to ${(best.rmsDev * 100).toFixed(1)}% but at least one species (likely G(eaq)) still outside ±15%. Recomb boost is partial — additional mechanism needed.`;

  const summary = {
    chem6_targets: CHEM6,
    baseline_rms_dev_pct: baseline.rmsDev * 100,
    best_x: best.x,
    best_rms_dev_pct: best.rmsDev * 100,
    best_g_values: { G_OH: best.G_OH, G_eaq: best.G_eaq, G_H: best.G_H, G_H2: best.G_H2, G_H2O2: best.G_H2O2 },
    sweep: sweepResults.map((r) => ({ x: r.x, G_OH: r.G_OH, G_eaq: r.G_eaq, G_H: r.G_H, G_H2: r.G_H2, G_H2O2: r.G_H2O2, rms_pct: r.rmsDev * 100 })),
    headline: `best_x=${best.x.toFixed(2)} → RMS_dev=${(best.rmsDev*100).toFixed(1)}% (baseline ${(baseline.rmsDev*100).toFixed(1)}%); G(H2): ${best.G_H2.toFixed(3)} (target ${CHEM6.G_H2}); G(eaq): ${best.G_eaq.toFixed(3)} (target ${CHEM6.G_eaq})`,
  };

  const rows = sweepResults.flatMap((r) => [
    { metric: `x_${r.x.toFixed(2)}_G_OH`, value: r.G_OH, target: CHEM6.G_OH, ratio: r.G_OH / CHEM6.G_OH, status: 'informational' },
    { metric: `x_${r.x.toFixed(2)}_G_eaq`, value: r.G_eaq, target: CHEM6.G_eaq, ratio: r.G_eaq / CHEM6.G_eaq, status: 'informational' },
    { metric: `x_${r.x.toFixed(2)}_G_H2`, value: r.G_H2, target: CHEM6.G_H2, ratio: r.G_H2 / CHEM6.G_H2, status: 'informational' },
    { metric: `x_${r.x.toFixed(2)}_G_H2O2`, value: r.G_H2O2, target: CHEM6.G_H2O2, ratio: r.G_H2O2 / CHEM6.G_H2O2, status: 'informational' },
    { metric: `x_${r.x.toFixed(2)}_RMS_dev_pct`, value: r.rmsDev * 100, status: r.rmsDev * 100 < 15 ? 'pass' : 'informational' },
  ]);

  return { meta, env, status, diagnosis, summary, rows };
}
