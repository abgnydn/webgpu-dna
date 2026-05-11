// E7 — Ions per primary, FULL CASCADE (primary + all secondaries).
//
// Closes the counting-convention question raised in E5: instead of the
// GPU-side `box_ions` atomic counter (which counts primary-track ions
// only, 194.1 at 10 keV), we reconstruct the full cascade count from
// the raw rad_buf dump. Every ionization writes one H3O+ to rad_buf at
// species_code = 3 (per irt-worker.js line 377: 0=OH, 1=eaq, 2=H,
// 3=H3O+, 5=pre-therm eaq). Grouping by primary id (encoded.w >> 3)
// gives the cascade ion count per primary, directly comparable to
// Geant4's ntuple "ions" column.
//
// Data sources:
//   - WebGPU side: dumps/rad_E10000_N4096.bin (gitignored; produced
//     by the browser harness "Dump radicals" path). If missing, the
//     experiment is reported as `skipped` with diagnosis, NOT silently
//     passed — that would defeat the discipline.
//   - Geant4 side: validation/g4_per_event.csv (4096 events × 5 cols:
//     event, ions, exc, path_nm, edep_eV), same file E5 uses.
//
// Hypothesis: WebGPU cascade ion count agrees with Geant4 ntuple within
// 15%. The pass bar is intentionally loose because (a) WebGPU uses
// Emfietzoglou excitation (E6b documented ~2.57× σ_exc → more energy
// to non-ionizing channels) and (b) the documented ~1.5% CSDA bias from
// E5 hints at a systematic difference in track structure.
//
// Expected outcome based on dumps/rad_E10000_N4096.bin (5.3M radicals):
//   H3O+ count → ~371.88 ± 32.3 ions/primary cascade.
//   Geant4 ntuple: 509.13 ± 0.13 SEM.
//   Ratio ≈ 0.73 → **likely fail with diagnosis** — surfaces a 27% real
//   physics gap, not a counting-convention artifact.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const RAD_BIN = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const G4_CSV = join(REPO_ROOT, 'validation', 'g4_per_event.csv');
const ENERGY_EV = 10000;
const N_PRIMARIES = 4096;

// rad_buf species codes (canonical mapping per public/irt-worker.js:377):
//   0 = OH, 1 = eaq, 2 = H, 3 = H3O+, 5 = pre-therm eaq, 7 = (rare)
const SPECIES_NAMES = {
  0: 'OH',
  1: 'eaq',
  2: 'H',
  3: 'H3O+',
  5: 'pre-therm eaq',
  7: 'other',
};
const SPECIES_H3O_PLUS = 3;

function readG4Ntuple(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const [header, ...data] = lines;
  const cols = header.split(',');
  return data.map((line) => {
    const fields = line.split(',').map(Number);
    const row = {};
    cols.forEach((c, i) => (row[c] = fields[i]));
    return row;
  });
}

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { mean: 0, std: 0, sem: 0, min: 0, max: 0, median: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    sum += x;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const mean = sum / n;
  let sq = 0;
  for (const x of xs) sq += (x - mean) ** 2;
  const variance = n > 1 ? sq / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const sorted = [...xs].sort((a, b) => a - b);
  const median =
    n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
  return { mean, std, sem: std / Math.sqrt(n), min, max, median };
}

function countH3OPerPrimary(binPath, nPrimaries) {
  const buf = readFileSync(binPath);
  // 16 B per record = (x, y, z, encoded) as float32. encoded = pid*8 + species_code.
  const recordCount = buf.length / 16;
  if (!Number.isInteger(recordCount)) {
    throw new Error(`rad_buf size ${buf.length} is not a multiple of 16`);
  }
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const perPri = new Uint32Array(nPrimaries);
  const speciesHist = new Uint32Array(8);
  let total = 0;
  let total_h3o = 0;
  for (let i = 0; i < recordCount; i++) {
    const wRaw = f32[i * 4 + 3];
    // Round to nearest integer — encoded values are exact integers in WGSL.
    const encoded = Math.round(wRaw);
    const species = encoded & 7;
    const pid = encoded >>> 3;
    speciesHist[species]++;
    total++;
    if (species === SPECIES_H3O_PLUS && pid < nPrimaries) {
      perPri[pid]++;
      total_h3o++;
    }
  }
  return { perPri, speciesHist, totalRecords: total, totalH3O: total_h3o };
}

export async function runE7() {
  const env = captureEnv();
  const meta = {
    protocol: 'E7-ions-per-primary-cascade',
    hypothesis:
      'WebGPU cascade ion count per primary (reconstructed from H3O+ records in rad_buf, species_code = 3) agrees with the Geant4 11.3.0 ntuple "ions" column within 15% at 10 keV, N = 4096. Loose because Emfietzoglou σ_exc is ~2.57× Born (E6b) so we expect *fewer* ionizations relative to Geant4 DNA_Opt2.',
    passBar:
      '|ratio - 1| < 0.15 AND |Δ| / SEM < 5; status reported as fail with diagnosis otherwise (an honest negative — closes the open question from E5).',
    seed: `E7_IONS_PER_PRI=0x${SEEDS.E7_IONS_PER_PRI.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgsl: 'dumps/rad_E10000_N4096.bin (browser-harness dump, gitignored)',
      g4Ntuple: 'validation/g4_per_event.csv (Geant4 11.3.0 dnaphysics, 4096 events at 10 keV)',
      speciesMap: 'public/irt-worker.js:377 — { 0:OH, 1:eaq, 2:H, 3:H3O+, 5:pre-therm eaq }',
    },
  };

  // Skip path — keeps the artifact honest if the dump is missing.
  if (!existsSync(RAD_BIN)) {
    return {
      meta,
      env,
      status: 'skip',
      diagnosis: `rad_buf dump not on disk: ${RAD_BIN} — regenerate via the browser harness ("Dump radicals" button or POST /dump/<name> in dev mode).`,
      summary: { headline: 'skipped (rad_buf dump missing)' },
      rows: [],
    };
  }

  // WGSL side
  const binStat = statSync(RAD_BIN);
  const wgsl = countH3OPerPrimary(RAD_BIN, N_PRIMARIES);
  const wgslPerPri = Array.from(wgsl.perPri);
  const wgslStats = stats(wgslPerPri);

  // Geant4 side
  const g4 = readG4Ntuple(G4_CSV);
  const g4Ions = g4.map((r) => r.ions);
  const g4Stats = stats(g4Ions);

  // Per-primary delta (only when array lengths match exactly)
  const nPairable = Math.min(wgslPerPri.length, g4Ions.length);
  const ratio = wgslStats.mean / g4Stats.mean;
  const delta = wgslStats.mean - g4Stats.mean;
  // SE on the difference of two independent means: sqrt(sem_a^2 + sem_b^2)
  const seDelta = Math.sqrt(wgslStats.sem ** 2 + g4Stats.sem ** 2);
  const sigmaDelta = Math.abs(delta) / seDelta;

  const ratioPass = Math.abs(ratio - 1) < 0.15;
  const sigmaPass = sigmaDelta < 5;
  const status = ratioPass && sigmaPass ? 'pass' : 'fail';
  let diagnosis = null;
  if (!ratioPass)
    diagnosis = `cascade ions ratio ${ratio.toFixed(4)} — WGSL undercounts by ${((1 - ratio) * 100).toFixed(1)}% vs Geant4 (|ratio − 1| ≥ 0.15)`;
  if (!sigmaPass) {
    const sigStr = `|Δ|/SEM = ${sigmaDelta.toFixed(2)}σ (≥ 5σ — statistically significant gap)`;
    diagnosis = diagnosis ? `${diagnosis}; ${sigStr}` : sigStr;
  }

  // Per-energy-bin not applicable here (single energy 10 keV).
  // Rows: (a) one summary row, (b) species histogram for transparency.
  const rows = [
    {
      metric: 'ions_per_primary_cascade',
      wgslMean: wgslStats.mean,
      wgslStd: wgslStats.std,
      wgslSem: wgslStats.sem,
      wgslMedian: wgslStats.median,
      wgslMin: wgslStats.min,
      wgslMax: wgslStats.max,
      g4Mean: g4Stats.mean,
      g4Std: g4Stats.std,
      g4Sem: g4Stats.sem,
      ratio,
      delta,
      seDelta,
      sigmaDelta,
      passBar:
        'ratio ∈ [0.85, 1.15] AND |Δ|/SEM < 5 (5σ accommodates the documented Emfietzoglou-inflated σ_exc which channels energy away from ionization).',
      status: ratioPass && sigmaPass ? 'pass' : 'fail',
    },
    {
      metric: 'species_histogram_wgsl',
      bins: Array.from(wgsl.speciesHist).map((count, code) => ({
        code,
        name: SPECIES_NAMES[code] ?? 'unmapped',
        count,
        perPrimary: count / N_PRIMARIES,
      })),
      totalRecords: wgsl.totalRecords,
      note: 'Reference: irt-worker.js:377 species map. Species 7 is occasional — flag if >>1% of total.',
      status: 'informational',
    },
  ];

  const summary = {
    nPrimaries: N_PRIMARIES,
    primaryEnergyEv: ENERGY_EV,
    binPath: RAD_BIN.replace(REPO_ROOT + '/', ''),
    binBytes: binStat.size,
    nRecords: wgsl.totalRecords,
    wgslIonsPerPriMean: wgslStats.mean,
    g4IonsPerPriMean: g4Stats.mean,
    ratio,
    sigmaDelta,
    headline: `WGSL cascade ions/primary: ${wgslStats.mean.toFixed(2)} vs Geant4 ${g4Stats.mean.toFixed(2)} → ratio ${ratio.toFixed(4)} (Δ/SEM = ${sigmaDelta.toFixed(1)}σ)`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
