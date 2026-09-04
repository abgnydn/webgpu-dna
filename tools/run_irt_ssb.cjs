#!/usr/bin/env node
/**
 * Run the IRT chemistry WITH SSB/DSB scoring on a saved rad_buf dump.
 *
 * Extends tools/run_irt.cjs: builds the DNA target, passes it + ssbScoring to
 * the worker (which accumulates indirect SSB during the timeline), then scores
 * direct SSB from rad_buf and clusters DSBs — the same pipeline as
 * src/app.ts scoreDamageAt10keV, ported to CJS so it runs GPU-free on a CI
 * runner (the chemistry heap OOMs a memory-pressured laptop).
 *
 * Used to revalidate SSB/DSB after a shader change (e.g. RECOMB_BOOST 2.0->1.0,
 * E7d) without the local memory wall.
 *
 * Usage: node tools/run_irt_ssb.cjs <dump_file> <n_therm> <E_eV>
 * Output: JSON line { type:'damage', ssb_dir, ssb_ind, dsb, ratio, ... } on stdout.
 *
 * Scoring helpers are shared via tools/scoring-common.cjs (mirrors
 * src/physics/constants.ts, src/physics/dna-geometry.ts, src/scoring/ssb-dsb.ts).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  DNA_LENGTH_NM,
  DNA_GRID_N,
  SSB_R_DAMAGE_INDIRECT_NM,
  SSB_P_INDIRECT,
  SSB_E_LOW,
  SSB_E_HIGH,
  makeSsbRng,
  buildDNATarget,
  scoreDirectSSB_events,
  clusterDSB,
  combineHits,
} = require('./scoring-common.cjs');

// Fibre spacing is the 4th optional arg (default 150 nm) — lets E27 sweep the
// DNA-target geometry to measure how sensitive the SSB/DSB ratio is to it.
const DNA_SPACING_NM = parseInt(process.argv[5] || '150', 10);

// --- main ---
const dumpFile = process.argv[2];
const n_therm = parseInt(process.argv[3] || '0', 10);
const E_eV = parseInt(process.argv[4] || '10000', 10);
const o2_conc = (parseFloat(process.argv[6] || '0')) * 1e-6;  // µM -> mol/L (OER)
if (!dumpFile || !n_therm) { console.error('usage: node tools/run_irt_ssb.cjs <dump> <n_therm> <E_eV>'); process.exit(1); }

const buf = fs.readFileSync(dumpFile);
const rad_buf = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const rad_n = rad_buf.length / 4;
console.error(`[run_irt_ssb] ${dumpFile}: ${rad_n} radicals  n_therm=${n_therm}  E=${E_eV} eV`);

// Per-event deposited energy for the direct-SSB energy-threshold ramp. Written
// by the shaders (rad_e) and dumped as rade_E<E>_N<np>.bin alongside rad_buf.
const radeFile = dumpFile.replace(/rad_E/, 'rade_E');
if (!fs.existsSync(radeFile)) {
  console.error(`[run_irt_ssb] missing rad_e dump ${radeFile} — regenerate the dump with the current shaders (they emit rad_e).`);
  process.exit(4);
}
const ebuf = fs.readFileSync(radeFile);
const rad_e = new Float32Array(ebuf.buffer, ebuf.byteOffset, ebuf.byteLength / 4);
if (rad_e.length < rad_n) { console.error(`[run_irt_ssb] rad_e length ${rad_e.length} < rad_n ${rad_n}`); process.exit(4); }

// True energy-deposit site (px,py,pz) per rad_buf entry — direct-SSB scores
// against this, not the mother-displaced radical position in rad_buf. Dumped as
// raddep_E<E>_N<np>.bin.
const raddepFile = dumpFile.replace(/rad_E/, 'raddep_E');
if (!fs.existsSync(raddepFile)) {
  console.error(`[run_irt_ssb] missing rad_dep dump ${raddepFile} — regenerate the dump with the current shaders (they emit rad_dep).`);
  process.exit(4);
}
const dbuf = fs.readFileSync(raddepFile);
const rad_dep = new Float32Array(dbuf.buffer, dbuf.byteOffset, dbuf.byteLength / 4);
if (rad_dep.length < rad_n * 4) { console.error(`[run_irt_ssb] rad_dep length ${rad_dep.length} < rad_n*4 ${rad_n * 4}`); process.exit(4); }

const dna = buildDNATarget(DNA_LENGTH_NM, DNA_GRID_N, DNA_SPACING_NM);
const dnaForWorker = {
  fy: dna.fy, fz: dna.fz, rbb0: dna.rbb0, rbb1: dna.rbb1,
  n_bp_per: dna.n_bp_per, grid_N: dna.grid_N, spacing_nm: dna.spacing_nm,
  x0: dna.x0, x_half: -dna.x0, r_bb: dna.r_bb,
};
// EXPLICIT_DNA=1 → the explicit OH+deoxyribose IRT reaction channel (sugar as a
// competing reactant) instead of the encounter/survival OH-near-backbone proxy.
const explicitDnaReaction = !!process.env.EXPLICIT_DNA;
const ssbScoring = { r_indirect: SSB_R_DAMAGE_INDIRECT_NM, p_indirect: SSB_P_INDIRECT, seed: 0x53534231, explicitDnaReaction };

// Shim WebWorker globals so irt-worker.js runs unmodified (as in run_irt.cjs).
let workerOnMessage = null;
let workerResult = null;
const shim = {
  onmessage: null,
  postMessage(data) {
    if (data.type === 'progress') console.error(`[worker] ${data.msg}`);
    else if (data.type === 'result') workerResult = data;
  },
};
Object.defineProperty(shim, 'onmessage', { set(fn) { workerOnMessage = fn; }, get() { return workerOnMessage; } });
global.self = shim;
const src = fs.readFileSync(path.resolve(__dirname, '../public/irt-worker.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(src);
if (typeof workerOnMessage !== 'function') { console.error('[run_irt_ssb] worker did not register onmessage'); process.exit(2); }

// COLLECT_OHREC=<path> → export per-OH (x,y,z,t_birth,t_death) for the E40 offline
// explicit-channel replay against folded chromatin. Uses the encounter/pure-radical
// run (explicitDna stays off) so t_death is the radical-death time.
const ohrecPath = process.env.COLLECT_OHREC || '';
workerOnMessage({ data: { rad_buf, rad_n, n_therm, E_eV, dna: dnaForWorker, ssbScoring, o2_conc, collectOHrec: !!ohrecPath } });
if (!workerResult || !workerResult.ssb_indirect) { console.error('[run_irt_ssb] no ssb_indirect from worker'); process.exit(3); }
if (ohrecPath && workerResult.oh_records) {
  fs.writeFileSync(ohrecPath, Buffer.from(workerResult.oh_records.buffer));
  console.error(`[run_irt_ssb] wrote ${workerResult.oh_records.length / 5} OH records → ${ohrecPath}`);
}

const ind = workerResult.ssb_indirect;
const ssb_ind = ind.total;
const indirectHits = ind.hits;
const rng = makeSsbRng();
const direct = scoreDirectSSB_events(dna, rad_buf, rad_e, rad_dep, rad_n, rng);
const ssb_dir = direct.ssb_count;
const combined = combineHits(direct.hits, indirectHits);
const dsbRes = clusterDSB(dna, combined);

const ratio = ssb_dir > 0 ? ssb_ind / ssb_dir : null;
const us = workerResult.timeline.find((t) => t.label === '1 us') || workerResult.timeline[workerResult.timeline.length - 1];
const out = {
  type: 'damage', E_eV, ssb_dir, ssb_ind, dsb: dsbRes.dsb,
  indirect_over_direct_ratio: ratio,
  in_reach_direct: direct.in_reach, in_reach_indirect: ind.in_reach, candidates_indirect: ind.candidates,
  indirect_model: ind.explicit ? 'explicit_OH+deoxyribose' : 'encounter_proxy',
  dna_reactions: ind.dna_reactions, sig_oh_dna_nm: ind.sig_oh_dna,
  G_OH_1us: us.G_OH, G_eaq_1us: us.G_eaq,
  config: { RECOMB_BOOST: 'from dump', SSB_P_INDIRECT, SSB_E_LOW, SSB_E_HIGH, SSB_R_DAMAGE_INDIRECT_NM },
};
process.stdout.write(JSON.stringify(out) + '\n');
console.error(`[run_irt_ssb] SSB_dir=${ssb_dir} SSB_ind=${ssb_ind} DSB=${dsbRes.dsb} ratio=${ratio ? ratio.toFixed(2) : 'n/a'} (PARTRAC 2-3) | G(OH)@1us=${us.G_OH.toFixed(3)}`);
