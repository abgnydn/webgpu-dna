// E10e — Synthetic test of the cross-event electron-hole recombination
// hypothesis (PHYSICS_DIAGNOSIS §1, candidate #4).
//
// E9 (2026-05-11) localized the G(H₂) / G(H₂O₂) deficit to pre-chemistry
// at 0.508× / 0.577× of chem6. PHYSICS_DIAGNOSIS named the leading
// hypothesis: Geant4's `G4DNAElectronHoleRecombination` finds the
// nearest eaq within 10·r_Onsager of each H₂O+ (not just the geminate
// pair). Our WGSL only checks the geminate eaq.
//
// This experiment quantifies the gap WITHOUT changing production
// WGSL/IRT. Method:
//   1. Read dumps/rad_E10000_N4096.bin (post-pre-chem rad_buf snapshot).
//   2. For each primary, find non-recombined ionization sites: OH (sp=0)
//      and H3O+ (sp=3) records at the same (x,y,z) — that point is the
//      mother-displaced H₂O+ position.
//   3. Build a per-primary list of eaq records (sp=1 + sp=5).
//   4. For each H₂O+ marker, find the NEAREST eaq within the same primary
//      (cross-event lookup) and compute P_recomb_cross = 1 - exp(-r_Onsager/r).
//      The GEMINATE eaq is the eaq spawned by the same ionization (we have
//      no marker for which eaq is geminate, so we estimate as
//      P_recomb_geminate ≈ mean of P_recomb for all eaqs within Meesungnoen σ
//      of mpos — but for the count, we compare the nearest-eaq P_recomb
//      against the model where ONLY the geminate would have been checked).
//   5. Report: additional H₂Ovib events / primary under cross-event model.
//      Each H₂Ovib gives 13.65% chance of 2OH+H₂.
//
// Pass bar: if mean P_recomb_cross − P_recomb_geminate ≥ 0.03 per
// ionization, the hypothesis is supported; an additional ~509 ions ×
// 0.03 × 0.1365 = ~2 extra H₂/primary, partially closing the ~12
// H₂/primary gap observed in E9.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureEnv } from '../lib/env.mjs';
import { SEEDS } from '../lib/seeds.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const N_PRIMARIES = 4096;
const E_EV = 10000;
const R_ONSAGER = 0.711; // nm (q1·q2·e² / 4πε₀·εr·kT at 293K, εr=80.1)
const R_SEARCH = 10 * R_ONSAGER; // 7.11 nm — same as G4DNAElectronHoleRecombination
const COLOC_TOL = 1e-4; // nm — OH/H3O+ co-location tolerance
const RECORD_BYTES = 16;

function partitionByPid(binPath) {
  const buf = readFileSync(binPath);
  const recordCount = buf.length / RECORD_BYTES;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const buckets = Array.from({ length: N_PRIMARIES }, () => []);
  for (let i = 0; i < recordCount; i++) {
    const encoded = Math.round(f32[i * 4 + 3]);
    const pid = encoded >>> 3;
    if (pid < N_PRIMARIES) buckets[pid].push(i);
  }
  return { f32, buckets, recordCount };
}

function speciesOf(encoded) {
  return Math.round(encoded) % 8;
}

// For a single primary's records, find ionization sites (mpos) where
// OH (sp=0) and H3O+ (sp=3) coexist at the same (x,y,z).
function findH2OpSites(f32, recordIdxs) {
  // Group by quantized position to find collisions
  const bucket = new Map();
  for (const ri of recordIdxs) {
    const off = ri * 4;
    const sp = speciesOf(f32[off + 3]);
    if (sp !== 0 && sp !== 3) continue;
    const x = f32[off], y = f32[off + 1], z = f32[off + 2];
    // Quantize to 0.001 nm grid — co-located records have identical bits
    const key = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
    let entry = bucket.get(key);
    if (!entry) { entry = { ohN: 0, h3oN: 0, x, y, z }; bucket.set(key, entry); }
    if (sp === 0) entry.ohN++;
    else if (sp === 3) entry.h3oN++;
  }
  const sites = [];
  for (const e of bucket.values()) {
    // A non-recombined ionization emits exactly 1 OH + 1 H3O+ at mpos.
    // Recombined ionizations emit 2 OH at mpos (no H3O+), so we only
    // pick OH+H3O+ pairs.
    if (e.ohN >= 1 && e.h3oN >= 1) sites.push([e.x, e.y, e.z]);
  }
  return sites;
}

function findEaqPositions(f32, recordIdxs) {
  const eaqs = [];
  for (const ri of recordIdxs) {
    const off = ri * 4;
    const sp = speciesOf(f32[off + 3]);
    if (sp === 1 || sp === 5) eaqs.push([f32[off], f32[off + 1], f32[off + 2]]);
  }
  return eaqs;
}

export async function runE10e() {
  const env = captureEnv();
  const meta = {
    protocol: 'E10e-cross-event-recomb-synthetic',
    hypothesis:
      "PHYSICS_DIAGNOSIS §1 candidate #4: Geant4's G4DNAElectronHoleRecombination uses nearest-eaq within 10·r_Onsager of each H₂O+, not just the geminate pair. In dense ionization clusters, the nearest eaq is often NOT the geminate one — closer than r_geminate (Meesungnoen σ ≈ 1.78 nm at 1.7 eV) → higher P_recomb → more H₂Ovib events → more H₂/H₂O₂. Quantify the additional H₂Ovib events/primary under nearest-eaq lookup at 10 keV.",
    passBar:
      "Mean (P_recomb_nearest − P_recomb_geminate) > 0.03 per non-recombined ionization → hypothesis supported. Below 0.01 → refuted. In between → ambiguous/weak.",
    seed: `E10_IRT_G_VALUES=0x${SEEDS.E10_IRT_G_VALUES.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      radBin: 'dumps/rad_E10000_N4096.bin',
      onsagerRef: 'G4DNAElectronHoleRecombination.cc:248-308',
    },
    config: { energy_eV: E_EV, n_primaries: N_PRIMARIES, r_onsager: R_ONSAGER, r_search: R_SEARCH },
  };

  if (!existsSync(BIN_PATH)) {
    return { meta, env, status: 'skip', diagnosis: 'rad_E10000_N4096.bin missing', summary: { headline: 'skipped' }, rows: [] };
  }

  const { f32, buckets, recordCount } = partitionByPid(BIN_PATH);

  let totalSites = 0;
  let totalNearestRecomb = 0;
  let totalGeminateRecomb = 0;
  let sumPGeminate = 0;
  let sumPNearest = 0;
  let nearestDist = []; // for histogram
  let geminateDist = [];
  let nPrimariesWithData = 0;

  for (let pid = 0; pid < N_PRIMARIES; pid++) {
    const recs = buckets[pid];
    if (recs.length === 0) continue;
    const sites = findH2OpSites(f32, recs);
    const eaqs = findEaqPositions(f32, recs);
    if (sites.length === 0 || eaqs.length === 0) continue;
    nPrimariesWithData++;

    for (const [sx, sy, sz] of sites) {
      let r_nearest = Infinity;
      let r_geminate_est = 0;
      // Find nearest eaq across all of this primary's eaqs.
      for (const [ex, ey, ez] of eaqs) {
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < r_nearest) r_nearest = r;
      }
      // Geminate eaq estimate: among eaqs within 1.78 nm × 3 of mpos
      // (3σ Meesungnoen at 1.7 eV), the geminate one is one of them.
      // For the comparison we use the MEAN distance of close eaqs as a
      // proxy for the geminate distance, since multiple geminate
      // candidates exist within the cluster.
      let nClose = 0, rSum = 0;
      for (const [ex, ey, ez] of eaqs) {
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r <= 5.34) { nClose++; rSum += r; } // 3σ at σ=1.78 nm
      }
      r_geminate_est = nClose > 0 ? rSum / nClose : 5.34;

      const r_nearest_safe = Math.max(r_nearest, 1e-6);
      const r_geminate_safe = Math.max(r_geminate_est, 1e-6);

      const p_nearest = r_nearest_safe < R_SEARCH ? 1 - Math.exp(-R_ONSAGER / r_nearest_safe) : 0;
      const p_geminate = 1 - Math.exp(-R_ONSAGER / r_geminate_safe);

      sumPNearest += p_nearest;
      sumPGeminate += p_geminate;
      nearestDist.push(r_nearest);
      geminateDist.push(r_geminate_est);

      // Approximate recomb counts (deterministic expectations, no sampling)
      totalNearestRecomb += p_nearest;
      totalGeminateRecomb += p_geminate;
      totalSites++;
    }
  }

  const meanPNearest = totalSites > 0 ? sumPNearest / totalSites : 0;
  const meanPGeminate = totalSites > 0 ? sumPGeminate / totalSites : 0;
  const meanPDelta = meanPNearest - meanPGeminate;
  const additionalH2OvibPerSite = meanPDelta;
  const additionalH2PerPrimary = (totalSites / Math.max(nPrimariesWithData, 1)) * additionalH2OvibPerSite * 0.1365;

  const nearestStats = histogramStats(nearestDist);
  const geminateStats = histogramStats(geminateDist);

  const status = meanPDelta > 0.03 ? 'pass' : meanPDelta < 0.01 ? 'fail' : 'noisy';
  const diagnosis = status === 'pass'
    ? `Cross-event recomb adds ~${additionalH2PerPrimary.toFixed(2)} H₂/primary under nearest-eaq model — supports PHYSICS_DIAGNOSIS §1 candidate #4.`
    : status === 'fail'
      ? 'Mean ΔP < 0.01 — cross-event recomb effect is negligible; H₂ deficit comes from elsewhere.'
      : `Mean ΔP = ${meanPDelta.toFixed(3)} — weak/ambiguous evidence.`;

  const summary = {
    n_primaries_with_data: nPrimariesWithData,
    total_h2op_sites: totalSites,
    sites_per_primary: totalSites / Math.max(nPrimariesWithData, 1),
    mean_p_recomb_geminate: meanPGeminate,
    mean_p_recomb_nearest: meanPNearest,
    mean_p_recomb_delta: meanPDelta,
    additional_h2ovib_per_site: additionalH2OvibPerSite,
    additional_h2_per_primary: additionalH2PerPrimary,
    h2_deficit_per_primary_target: 12.4, // E9 chem6−WGSL ≈ (0.251−0.127)×100=12.4 per 10 keV primary
    nearest_dist_stats_nm: nearestStats,
    geminate_dist_stats_nm: geminateStats,
    headline: `delta_P=${meanPDelta.toFixed(4)} sites/pri=${(totalSites / Math.max(nPrimariesWithData, 1)).toFixed(1)} extra_H2/pri=${additionalH2PerPrimary.toFixed(2)} (target=12.4)`,
  };

  const rows = [
    { metric: 'mean_p_recomb_geminate', value: meanPGeminate, status: 'informational' },
    { metric: 'mean_p_recomb_nearest', value: meanPNearest, status: 'informational' },
    { metric: 'mean_p_recomb_delta', value: meanPDelta, threshold_pass: 0.03, status: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'noisy' },
    { metric: 'h2op_sites_per_primary', value: totalSites / Math.max(nPrimariesWithData, 1), status: 'informational' },
    { metric: 'additional_h2_per_primary_model', value: additionalH2PerPrimary, status: 'informational', note: 'Model: nearest-eaq within 10·r_Onsager. Compare to E9 deficit of 12.4 H₂/primary.' },
    { metric: 'nearest_dist_nm_median', value: nearestStats.p50, status: 'informational' },
    { metric: 'nearest_dist_nm_p10', value: nearestStats.p10, status: 'informational' },
    { metric: 'geminate_dist_nm_median', value: geminateStats.p50, status: 'informational' },
  ];

  return { meta, env, status, diagnosis, summary, rows };
}

function histogramStats(arr) {
  if (arr.length === 0) return { mean: 0, p10: 0, p50: 0, p90: 0, max: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { mean, p10: p(0.10), p50: p(0.50), p90: p(0.90), max: sorted[sorted.length - 1] };
}
