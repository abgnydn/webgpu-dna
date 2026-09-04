#!/usr/bin/env node
/**
 * Run the IRT chemistry worker on a saved rad_buf dump.
 *
 * Usage: node tools/run_irt.js <dump_file> <n_therm> <E_eV>
 *   dump_file: path to a .bin produced by POST /dump/<name>
 *   n_therm:   number of primaries that thermalized (for G-value normalization)
 *   E_eV:      primary energy in eV (typically 10000)
 *
 * Output: JSON line with timeline + reaction counts.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const dumpFile = process.argv[2];
const n_therm  = parseInt(process.argv[3] || '0', 10);
const E_eV     = parseInt(process.argv[4] || '10000', 10);
const o2_conc  = (parseFloat(process.argv[5] || '0')) * 1e-6;  // µM -> mol/L (dissolved O2 / OER)

if (!dumpFile || !n_therm) {
  console.error('usage: node tools/run_irt.js <dump_file> <n_therm> <E_eV>');
  process.exit(1);
}

const buf = fs.readFileSync(dumpFile);
const rad_buf = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const rad_n = rad_buf.length / 4;
console.error(`[run_irt] ${dumpFile}: ${rad_n} radicals (${(buf.length/1e6).toFixed(2)} MB)  n_therm=${n_therm}  E=${E_eV} eV`);

// Shim WebWorker globals so irt-worker.js runs unmodified.
let workerOnMessage = null;
const shim = {
  onmessage: null,
  postMessage(data) {
    if (data.type === 'progress') {
      console.error(`[worker] ${data.msg}`);
    } else if (data.type === 'result') {
      // Write JSON to stdout, summary to stderr.
      process.stdout.write(JSON.stringify(data) + '\n');
      console.error(`[worker] ${data.n_reacted} reactions in ${(data.t_wall/1000).toFixed(1)}s`);
      for (const cp of data.timeline) {
        console.error(`  ${cp.label.padEnd(8)} G(OH)=${cp.G_OH.toFixed(3).padStart(7)}  G(eaq)=${cp.G_eaq.toFixed(3).padStart(7)}  G(H)=${cp.G_H.toFixed(3).padStart(7)}  G(H2O2)=${cp.G_H2O2.toFixed(3).padStart(7)}  G(H2)=${cp.G_H2.toFixed(3).padStart(7)}`);
      }
      if (data.rxn_info) {
        console.error('  reactions fired:');
        for (const rx of data.rxn_info) {
          const lbl = String(rx.label ?? `rxn_?`);
          console.error(`    ${lbl.padEnd(28)} count=${String(rx.count).padStart(7)}  σ=${rx.sigma}nm  rc=${rx.rc}nm`);
        }
      }
    }
  },
};
Object.defineProperty(shim, 'onmessage', {
  set(fn) { workerOnMessage = fn; },
  get() { return workerOnMessage; },
});

// Make `self` resolve to shim inside the worker file.
global.self = shim;

// The worker file is parsed by Node as ESM (project has "type":"module"), so
// we can't require() it. Read it as text and eval in this CommonJS scope so
// `self.onmessage = ...` lands on our shim.
const workerPath = path.resolve(__dirname, '../public/irt-worker.js');
const src = fs.readFileSync(workerPath, 'utf8');
// eslint-disable-next-line no-eval
eval(src);

if (typeof workerOnMessage !== 'function') {
  console.error('[run_irt] worker did not register onmessage');
  process.exit(2);
}

// Trigger the worker.
const t0 = performance.now();
workerOnMessage({ data: { rad_buf, rad_n, n_therm, E_eV, o2_conc, noDisplace: process.env.NODISPLACE==="1" } });
console.error(`[run_irt] total wall: ${((performance.now()-t0)/1000).toFixed(1)}s`);
