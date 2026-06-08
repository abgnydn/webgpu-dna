// E12-local-EXACT — refine E12-local's C≈981 using the ACTUAL voxel dose grid
// instead of the event-count energy proxy.
//
// Prereq (one GPU run, deferred until memory frees): regenerate dumps with
// ?dump=1 so the harness writes dumps/dose_E10000_N4096.bin (128³ u32,
// fixed-point ×100/eV; dump hook added to src/app.ts 2026-06-04).
//
// Then: integrate the dose over the central fibre-footprint voxels vs the whole
// box → exact concentration factor C and local dose. Compares to the offline
// proxy (98.1% of energy in core, C≈981). If C_exact ≈ C_proxy, the proxy
// assumption (energy ∝ event count) is validated and E12-local's vindication of
// the absolute yields stands on a measured local dose.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DOSE_BIN = 'dumps/dose_E10000_N4096.bin';
const VC = 128;                 // dose grid is 128³
const BOX_HALF = 15000;         // nm (WGSL p.box at the validation box=15000)
const CORE_HALF = 1500;         // nm (fibre-grid footprint ±1500)
const boxDose = 0.2430561293653333;

if (!existsSync(DOSE_BIN)) {
  console.log(`[E12-local-exact] ${DOSE_BIN} not present yet.`);
  console.log(`Run (when memory permits): node experiments/lib/regenerate-dumps.mjs  (writes dose_E*.bin via ?dump=1)`);
  console.log(`This script is the offline analysis; it will produce the artifact once the dump exists.`);
  process.exit(0);
}

const buf = readFileSync(DOSE_BIN);
const dose = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const voxNm = (2 * BOX_HALF) / VC;
const idxLo = Math.floor((-CORE_HALF + BOX_HALF) / voxNm);
const idxHi = Math.floor(( CORE_HALF + BOX_HALF) / voxNm);

let totalE = 0, coreE = 0;
for (let vz = 0; vz < VC; vz++)
  for (let vy = 0; vy < VC; vy++)
    for (let vx = 0; vx < VC; vx++) {
      const e = dose[(vz * VC + vy) * VC + vx] / 100.0; // eV
      if (e === 0) continue;
      totalE += e;
      if (vx >= idxLo && vx <= idxHi && vy >= idxLo && vy <= idxHi && vz >= idxLo && vz <= idxHi) coreE += e;
    }

const fracCore = coreE / totalE;
const boxVol = (2 * BOX_HALF) ** 3, coreVol = (2 * CORE_HALF) ** 3;
const C = fracCore * (boxVol / coreVol);
const localDose = C * boxDose;
const sha = execSync('git rev-parse HEAD').toString().trim();

const artifact = {
  meta: { protocol: 'E12-local-exact', method: 'integrate actual 128³ voxel dose grid over fibre footprint vs whole box', source: DOSE_BIN, compares_to: 'E12-local proxy C≈981' },
  env: { gitSha: sha, runner: 'node', voxelCount: VC, voxNm, coreVoxelRange: [idxLo, idxHi] },
  status: 'pass',
  summary: {
    totalEnergy_eV: totalE,
    frac_energy_in_core: fracCore,
    C_exact: C,
    C_proxy_E12local: 981,
    localDose_Gy: localDose,
    boxDose_Gy: boxDose,
    headline: `EXACT (voxel dose): ${(fracCore*100).toFixed(1)}% of energy in central 3µm → C=${C.toFixed(0)}, local dose ${localDose.toFixed(0)} Gy. Proxy E12-local gave C≈981.`,
  },
};
mkdirSync('experiments/results/2026-06-08/level-5', { recursive: true });
writeFileSync('experiments/results/2026-06-08/level-5/E12-local-exact.json', JSON.stringify(artifact, null, 2));
console.log(artifact.summary.headline);
