#!/usr/bin/env node
/**
 * Cross-primary (inter-track) IRT — runs the production IRT worker on a GLOBAL
 * radical pool instead of per-primary partitioning, to recover the inter-track
 * reactions (H+H, eaq+eaq, OH+OH across primary boundaries) that the per-primary
 * priMap loses. This is the structural fix from CROSS_PRIMARY_IRT_DESIGN.md and
 * the ~96%-of-the-1us-gap item from E10f.
 *
 * Mechanism (lowest-risk): the worker partitions by `pid = Math.floor(w/8)`.
 * Forcing pid=0 puts all radicals in one pool — the existing O(N^2) pairing,
 * heap scheduler, and reaction handling then run cross-primary, completely
 * unchanged. Production worker stays untouched; we patch a copy in memory.
 *
 * Runs BOTH per-primary and cross-primary on the SAME primary subset so the
 * inter-track delta is apples-to-apple. Naive O(N^2) is tractable at E10f's
 * scale (~128 primaries); the spatial-hash optimisation for full N is a
 * follow-up (the dense point-source core makes full-N compute-bound).
 *
 * Usage: node tools/run_irt_xprimary.cjs <dump> <K_primaries> <E_eV>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dumpFile = process.argv[2];
const K = parseInt(process.argv[3] || '128', 10);   // number of primaries to use
const E_eV = parseInt(process.argv[4] || '10000', 10);
if (!dumpFile) { console.error('usage: node tools/run_irt_xprimary.cjs <dump> <K_primaries> <E_eV>'); process.exit(1); }

// --- load dump, filter to the first K primaries (w = pid*8 + species) ---
const buf = fs.readFileSync(dumpFile);
const full = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const fullN = full.length / 4;
const sub = [];
for (let i = 0; i < fullN; i++) {
  const w = full[i * 4 + 3];
  const pid = Math.floor(w / 8);
  if (pid < K) { sub.push(full[i*4], full[i*4+1], full[i*4+2], w); }
}
const radSub = new Float32Array(sub);
const radN = radSub.length / 4;
console.error(`[xprimary] ${dumpFile}: ${radN} radicals from first ${K} primaries (of ${fullN} total)`);

const workerSrc = fs.readFileSync(path.resolve(__dirname, '../public/irt-worker.js'), 'utf8');

function runWorker(src, label) {
  let onmsg = null, result = null;
  const shim = { onmessage: null, postMessage(d) { if (d.type === 'result') result = d; else if (d.type === 'progress') process.stderr.write(`\r[${label}] ${d.msg}        `); } };
  Object.defineProperty(shim, 'onmessage', { set(fn){onmsg=fn;}, get(){return onmsg;} });
  global.self = shim;
  // eslint-disable-next-line no-eval
  eval(src);
  const t0 = require('perf_hooks').performance.now();
  onmsg({ data: { rad_buf: radSub.slice(), rad_n: radN, n_therm: K, E_eV } });
  process.stderr.write(`\n[${label}] done in ${((require('perf_hooks').performance.now()-t0)/1000).toFixed(1)}s\n`);
  return result;
}

// per-primary (unmodified) and cross-primary (pid forced to 0)
const perPrimary = runWorker(workerSrc, 'per-primary');
const xSrc = workerSrc.replace('const pid = Math.floor(w / 8);', 'const pid = 0; void w;');
if (xSrc === workerSrc) { console.error('[xprimary] FAILED to patch pid line'); process.exit(2); }
const crossPrimary = runWorker(xSrc, 'cross-primary');

const us = (r) => r.timeline.find(t => t.label === '1 us') || r.timeline[r.timeline.length-1];
const pp = us(perPrimary), xp = us(crossPrimary);
const sp = (k) => (xp[k]-pp[k]).toFixed(3);
const out = {
  type: 'xprimary', K_primaries: K, E_eV, radN,
  per_primary_1us:  { OH:+pp.G_OH.toFixed(3), eaq:+pp.G_eaq.toFixed(3), H:+pp.G_H.toFixed(3), H2O2:+pp.G_H2O2.toFixed(3), H2:+pp.G_H2.toFixed(3) },
  cross_primary_1us:{ OH:+xp.G_OH.toFixed(3), eaq:+xp.G_eaq.toFixed(3), H:+xp.G_H.toFixed(3), H2O2:+xp.G_H2O2.toFixed(3), H2:+xp.G_H2.toFixed(3) },
  delta_1us:        { OH:+sp('G_OH'), eaq:+sp('G_eaq'), H:+sp('G_H'), H2O2:+sp('G_H2O2'), H2:+sp('G_H2') },
  e10f_reference:   { dG_H2_at_128: 0.149, note: 'E10f measured ΔG(H2)=+0.149 closing 96% of the 1us gap' },
};
process.stdout.write(JSON.stringify(out) + '\n');
console.error(`\n=== cross-primary − per-primary @ 1us (K=${K}) ===`);
console.error(`ΔG(OH)=${sp('G_OH')} ΔG(eaq)=${sp('G_eaq')} ΔG(H)=${sp('G_H')} ΔG(H2O2)=${sp('G_H2O2')} ΔG(H2)=${sp('G_H2')}  [E10f: ΔG(H2)≈+0.149 @128]`);
