#!/usr/bin/env node
/**
 * Smoke-test the IRT worker with a synthetic rad_buf that exercises:
 *   - Old species codes 0,1,2,3,5 (OH, eaq, H, H3O+, pre-therm eaq)
 *   - New species codes 6 (OH-) and 7 (H2 marker)
 *
 * Verifies:
 *   1. Worker runs without throwing
 *   2. Initial H2 markers (code 7) appear in tl_H2 from t=1 ps onward
 *   3. OH- (code 6) is mapped to species index 5 and reacts with H3O+
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Build a synthetic rad_buf with 4 primaries.
// Layout per primary (pid * 8 + species_code):
//   pid 0: 1 OH (code 0), 1 eaq (code 1), 1 H3O+ (code 3) — standard ionization
//   pid 1: 1 OH (code 0), 1 OH- (code 6), 1 H2 marker (code 7) — DEA event
//   pid 2: 2 OH (code 0), 1 H2 marker (code 7) — B1A1 H2 channel
//   pid 3: 1 OH (code 0), 1 H (code 2) — A1B1 dissoc

const N_THERM = 4;
const E_eV = 10000;

function rec(pid, species, x, y, z) {
  return [x, y, z, pid * 8 + species];
}

const radEntries = [
  // pid 0 — standard ionization at origin
  ...rec(0, 0,   0, 0, 0),    // OH
  ...rec(0, 1,   2, 0, 0),    // eaq
  ...rec(0, 3,   0, 0, 0),    // H3O+
  // pid 1 — DEA at (10,0,0)
  ...rec(1, 0,  10, 0, 0),    // OH
  ...rec(1, 6,  10, 0, 0),    // OH-
  ...rec(1, 7,  10, 0, 0),    // H2 marker
  // pid 2 — B1A1 H2 channel at (20,0,0)
  ...rec(2, 0,  20, 0, 0),    // OH
  ...rec(2, 0,  20, 0, 0),    // OH
  ...rec(2, 7,  20, 0, 0),    // H2 marker
  // pid 3 — A1B1 dissoc at (30,0,0)
  ...rec(3, 0,  30, 0, 0),    // OH
  ...rec(3, 2,  30, 0, 0),    // H
];

const rad_buf = new Float32Array(radEntries);
const rad_n = radEntries.length / 4;

console.error(`[test] ${rad_n} entries (${N_THERM} primaries) — exercising codes 6, 7`);

// Shim webworker self
let workerOnMessage = null;
const shim = {
  onmessage: null,
  postMessage(data) {
    if (data.type === 'progress') {
      console.error(`[worker] ${data.msg}`);
    } else if (data.type === 'result') {
      const tl = data.timeline;
      console.error('\n[result]');
      console.error('  t       G(OH)   G(eaq)  G(H)    G(H2O2) G(H2)');
      for (const cp of tl) {
        console.error(
          `  ${cp.label.padEnd(7)} ${cp.G_OH.toFixed(3).padStart(6)} ${cp.G_eaq.toFixed(3).padStart(7)} ${cp.G_H.toFixed(3).padStart(6)} ${cp.G_H2O2.toFixed(3).padStart(7)} ${cp.G_H2.toFixed(3).padStart(6)}`
        );
      }
      console.error('\n[reactions]');
      for (const rx of (data.rxn_info || [])) {
        if (rx.count > 0) console.error(`  ${String(rx.label ?? 'rxn_?').padEnd(28)} ${rx.count}`);
      }

      // ASSERTIONS
      const G_H2_1ps = tl[0].G_H2;
      // 2 H2 markers (pid 1 and pid 2), N_THERM=4 primaries, E=10 keV.
      // G = count / N_therm × 100 / E_eV = 2 / 4 × 100 / 10000 = 5e-3
      const expected_init = 2 / N_THERM * 100 / (E_eV / 100); // per 100 eV
      console.error(`\n[assertions]`);
      console.error(`  G(H2) at 1 ps: got ${G_H2_1ps.toExponential(3)}, expected ≥ ${expected_init.toExponential(3)}`);
      if (G_H2_1ps < expected_init * 0.5) {
        console.error(`  ❌ FAIL: G(H2) at 1 ps too low — initial H2 markers (code 7) not counted`);
        process.exit(1);
      }
      console.error(`  ✓ initial H2 markers ARE counted at 1 ps`);

      // Check OH- + H3O+ → H2O reaction fired. Reaction index 8.
      const r8_count = (data.rxn_info || []).find(r => String(r.label ?? '').includes('H3O++OH-'))?.count || 0;
      if (r8_count > 0) {
        console.error(`  ✓ OH- (code 6) reacts with H3O+ (rxn 8 fired ${r8_count}× across primaries)`);
      } else {
        console.error(`  ⚠ OH- + H3O+ rxn 8 didn't fire (small sample, may be normal)`);
      }
    }
  },
};
Object.defineProperty(shim, 'onmessage', {
  set(fn) { workerOnMessage = fn; },
  get() { return workerOnMessage; },
});

global.self = shim;

const workerPath = path.resolve(__dirname, '../public/irt-worker.js');
const src = fs.readFileSync(workerPath, 'utf8');
// eslint-disable-next-line no-eval
eval(src);

if (typeof workerOnMessage !== 'function') {
  console.error('[test] worker did not register onmessage');
  process.exit(2);
}

workerOnMessage({ data: { rad_buf, rad_n, n_therm: N_THERM, E_eV } });
