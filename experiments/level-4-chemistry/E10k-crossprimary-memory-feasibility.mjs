// E10k — Cross-primary IRT memory/tractability feasibility test.
//
// Tests the load-bearing claims in CROSS_PRIMARY_IRT_DESIGN.md (and its
// 2026-06-01 Option-5 addendum) against the real rad_buf snapshot:
//
//   1. Doc claims spatial-hash initial-pair scan is "tractable in seconds"
//      assuming ~23-50 radicals per cell. That estimate used cell_size =
//      5 nm. The ACTUAL R_CUT = 551.65 nm (verified). At 551 nm cells, what
//      is the real per-cell occupancy under the point-source geometry?
//   2. Doc claims ~50M heap entries / ~1 GB heap. The heap only holds pairs
//      where sampleIRT returns a valid t ∈ [0, 1000). Measure the true count.
//   3. From (2), compute the real peak heap memory and decide whether the
//      single-pool naive run actually exceeds a browser tab ceiling.
//
// Method: stage A (cheap, O(N)) measures geometry + 551 nm cell occupancy
// and DECIDES whether stage B (the actual sampleIRT push count) is tractable
// before attempting it. Honest-negative discipline: if stage A shows the
// dense core cell holds millions of radicals, the O(N·c) spatial hash is
// NOT tractable in-tab either, and that is the reportable result.
//
// Does NOT change production WGSL/IRT. Node-side synthetic, like E10e/E10f.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RECORD_BYTES = 16;
const R_CUT = 1.45 + 2 * Math.sqrt(8 * 9.46 * 1000); // 551.65 nm — verified actual value
const CELL = R_CUT;

if (!existsSync(BIN_PATH)) {
  console.error('missing', BIN_PATH);
  process.exit(1);
}

// species code (w % 8): 0=OH 1=eaq 2=H 3=H3O+ 4=H2O2(resv) 5=pretherm-eaq 6=OH- 7=H2marker
const SP_NAMES = ['OH', 'eaq', 'H', 'H3O+', '(H2O2)', 'pretherm-eaq', 'OH-', 'H2marker'];
// worker species index after remap (sp 5 -> eaq(1), 6 -> OH-(5)); reactive set
// excludes 4 (H2O2 product), 7 (H2 marker, not a particle).
function isParticle(sp) { return sp !== 4 && sp !== 7; }

console.log('Loading', BIN_PATH);
const buf = readFileSync(BIN_PATH);
const nRec = buf.length / RECORD_BYTES;
const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

// ---- Stage A: geometry, species histogram, bbox, 551 nm cell occupancy ----
const spCount = new Array(8).fill(0);
let nPart = 0;
let minx = Infinity, miny = Infinity, minz = Infinity;
let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
for (let i = 0; i < nRec; i++) {
  const off = i * 4;
  const sp = Math.round(f32[off + 3]) % 8;
  spCount[(sp + 8) % 8]++;
  if (!isParticle(sp)) continue;
  nPart++;
  const x = f32[off], y = f32[off + 1], z = f32[off + 2];
  if (x < minx) minx = x; if (x > maxx) maxx = x;
  if (y < miny) miny = y; if (y > maxy) maxy = y;
  if (z < minz) minz = z; if (z > maxz) maxz = z;
}

console.log(`\nRecords: ${nRec}  Particles (reactive): ${nPart}`);
console.log('Species histogram:');
for (let s = 0; s < 8; s++) if (spCount[s]) console.log(`  ${SP_NAMES[s].padEnd(14)} ${spCount[s]}`);
console.log(`\nBounding box (nm): x[${minx.toFixed(0)}, ${maxx.toFixed(0)}]  y[${miny.toFixed(0)}, ${maxy.toFixed(0)}]  z[${minz.toFixed(0)}, ${maxz.toFixed(0)}]`);
console.log(`Extent: ${(maxx-minx).toFixed(0)} × ${(maxy-miny).toFixed(0)} × ${(maxz-minz).toFixed(0)} nm`);

// Build 551 nm cell occupancy histogram (particles only).
const cellMap = new Map();
const cellKey = (cx, cy, cz) => `${cx},${cy},${cz}`;
for (let i = 0; i < nRec; i++) {
  const off = i * 4;
  const sp = Math.round(f32[off + 3]) % 8;
  if (!isParticle(sp)) continue;
  const cx = Math.floor(f32[off] / CELL);
  const cy = Math.floor(f32[off + 1] / CELL);
  const cz = Math.floor(f32[off + 2] / CELL);
  const k = cellKey(cx, cy, cz);
  cellMap.set(k, (cellMap.get(k) || 0) + 1);
}
const occ = [...cellMap.values()].sort((a, b) => b - a);
const nCells = occ.length;
const meanOcc = nPart / nCells;
const maxOcc = occ[0];
console.log(`\n551 nm cells occupied: ${nCells}`);
console.log(`Mean occupancy: ${meanOcc.toFixed(0)} radicals/cell  |  Max (densest core): ${maxOcc}`);
console.log(`Top 5 cell occupancies: ${occ.slice(0, 5).join(', ')}`);

// Estimate the 3×3×3 neighborhood pair-check cost for the densest cell.
// Worst case: the densest cell's 27-neighborhood scan is ~ (sum of occ in
// the 27 cells)². We approximate with the top cell's own occupancy² as a
// lower bound and report it — the real neighborhood is larger.
const densePairsLB = maxOcc * (maxOcc - 1) / 2;
console.log(`\nDensest-cell self-pair lower bound: ${densePairsLB.toExponential(2)} pairs`);
console.log('(the full 3×3×3 neighborhood scan around the core is larger still)');

// Total geometric pair-check work for the spatial hash: sum over cells of
// occ_cell × (occ in its 27-neighborhood). Compute exactly — cheap.
let totalChecks = 0;
// index cells for neighbor lookup
for (const [k, n] of cellMap) {
  const [cx, cy, cz] = k.split(',').map(Number);
  let neigh = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        neigh += cellMap.get(cellKey(cx + dx, cy + dy, cz + dz)) || 0;
  totalChecks += n * neigh;
}
totalChecks /= 2; // each pair counted twice
console.log(`\nTotal geometric pair-checks (3×3×3 spatial-hash scan): ${totalChecks.toExponential(3)}`);
console.log(`Doc's estimate was 6.75e9 ("tractable in seconds"). Ratio to doc: ${(totalChecks / 6.75e9).toFixed(1)}×`);

const TRACTABLE_CHECKS = 5e9; // rough ceiling for a seconds-to-low-minutes JS scan
const stageBFeasible = totalChecks < TRACTABLE_CHECKS;
console.log(`\nStage B (actual sampleIRT heap-push count) feasible? ${stageBFeasible ? 'YES' : 'NO — scan is intractable in-tab'}`);

// Memory implication for the geometric pair set if it had to be materialized.
const HEAP_BYTES_PER = 24; // Float64 t + Int32 a,b,ga,gb
console.log(`\n--- Memory implications ---`);
console.log(`If even 1% of geometric checks become heap pushes: ${(totalChecks * 0.01).toExponential(2)} entries → ${(totalChecks * 0.01 * HEAP_BYTES_PER / 1e9).toFixed(2)} GB heap`);
console.log(`Doc claimed ~50M entries → ${(50e6 * HEAP_BYTES_PER / 1e9).toFixed(2)} GB. Pool (7 arrays × ${nPart}×2) ≈ ${(nPart * 2 * (8*4+4*3) / 1e9).toFixed(2)} GB`);

const result = {
  records: nRec,
  particles: nPart,
  speciesHistogram: Object.fromEntries(SP_NAMES.map((n, s) => [n, spCount[s]]).filter(([, c]) => c)),
  R_CUT_nm: R_CUT,
  bbox_nm: { x: [minx, maxx], y: [miny, maxy], z: [minz, maxz] },
  cell_nm: CELL,
  cells_occupied: nCells,
  mean_occupancy: meanOcc,
  max_occupancy: maxOcc,
  top5_occupancy: occ.slice(0, 5),
  densest_cell_selfpair_lb: densePairsLB,
  total_geometric_pairchecks: totalChecks,
  doc_estimate_pairchecks: 6.75e9,
  ratio_to_doc_estimate: totalChecks / 6.75e9,
  stageB_feasible: stageBFeasible,
};
console.log('\nRESULT_JSON', JSON.stringify(result));

const outDir = join(REPO_ROOT, 'experiments', 'results', '2026-06-01', 'level-4');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'E10k-stageA.json'), JSON.stringify(result, null, 2));
console.log('\nWrote stage-A result to experiments/results/2026-06-01/level-4/E10k-stageA.json');
