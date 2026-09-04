/**
 * Parity tests between the TypeScript SSB/DSB sources and the CommonJS mirror in
 * tools/scoring-common.cjs. Catches the manual-mirror drift that the refactor was
 * designed to eliminate.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  DNA_LENGTH_NM,
  DNA_GRID_N,
  DNA_SPACING_NM,
  SSB_R_DAMAGE_NM,
  SSB_R_DAMAGE_INDIRECT_NM,
  SSB_P_INDIRECT,
  SSB_E_LOW,
  SSB_E_HIGH,
  DSB_WINDOW_BP,
} from '../../src/physics/constants';
import { buildDNATarget } from '../../src/physics/dna-geometry';
import {
  scoreDirectSSB_events,
  clusterDSB,
  combineHits,
  makeSsbRng,
} from '../../src/scoring/ssb-dsb';

const require = createRequire(import.meta.url);
const cjs = require('../../tools/scoring-common.cjs');

function w(species: number, pid = 0): number {
  return pid * 8 + species;
}

function radBuf(rows: Array<[number, number, number, number]>): Float32Array {
  const b = new Float32Array(rows.length * 4);
  rows.forEach(([x, y, z, s], i) => {
    b[i * 4] = x;
    b[i * 4 + 1] = y;
    b[i * 4 + 2] = z;
    b[i * 4 + 3] = w(s);
  });
  return b;
}

function dep(rb: Float32Array): Float32Array {
  const d = new Float32Array(rb.length);
  for (let i = 0; i < rb.length / 4; i++) {
    d[i * 4] = rb[i * 4];
    d[i * 4 + 1] = rb[i * 4 + 1];
    d[i * 4 + 2] = rb[i * 4 + 2];
  }
  return d;
}

describe('SSB CJS/TS parity', () => {
  it('buildDNATarget matches byte-for-byte between TS and CJS', () => {
    const ts = buildDNATarget(3000, 3, 150);
    const cj = cjs.buildDNATarget(3000, 3, 150);
    expect(cj.rise).toBe(ts.rise);
    expect(cj.r_bb).toBe(ts.r_bb);
    expect(cj.n_bp_per).toBe(ts.n_bp_per);
    expect(cj.n_fibers).toBe(ts.n_fibers);
    expect(cj.n_bp).toBe(ts.n_bp);
    expect(cj.grid_N).toBe(ts.grid_N);
    expect(cj.spacing_nm).toBe(ts.spacing_nm);
    expect(cj.x0).toBe(ts.x0);
    expect(cj.L_nm).toBe(ts.L_nm);
    expect(Array.from(cj.fy)).toEqual(Array.from(ts.fy));
    expect(Array.from(cj.fz)).toEqual(Array.from(ts.fz));
    expect(Array.from(cj.rbb0)).toEqual(Array.from(ts.rbb0));
    expect(Array.from(cj.rbb1)).toEqual(Array.from(ts.rbb1));
  });

  it('scoreDirectSSB_events and clusterDSB are identical on synthetic events', () => {
    const tsDna = buildDNATarget(3000, 3, 150);
    const cjDna = cjs.buildDNATarget(3000, 3, 150);

    function atom0(bp: number): [number, number, number] {
      return [
        tsDna.x0 + bp * tsDna.rise,
        tsDna.fy[0] + tsDna.rbb0[bp * 2 + 0],
        tsDna.fz[0] + tsDna.rbb0[bp * 2 + 1],
      ];
    }
    function atom1(bp: number): [number, number, number] {
      return [
        tsDna.x0 + bp * tsDna.rise,
        tsDna.fy[0] + tsDna.rbb1[bp * 2 + 0],
        tsDna.fz[0] + tsDna.rbb1[bp * 2 + 1],
      ];
    }

    const [x0, y0, z0] = atom0(100);
    const [x1, y1, z1] = atom1(200);
    const rad = radBuf([
      // Event 1: OH + H3O+ + H2 marker at same site → one roll
      [x0, y0, z0, 0],
      [x0, y0, z0, 3],
      [x0, y0, z0, 7],
      // Event 2: OH + displaced pre-therm e-aq + H3O+ → one roll, strand 1
      [x1, y1, z1, 0],
      [x1 + 3, y1 + 3, z1 + 3, 5],
      [x1, y1, z1, 3],
      // Event 3: distinct nearby site on strand 0, low energy (does not break alone)
      [x0 + 0.05, y0 + 0.05, z0, 0],
    ]);
    const rad_e = new Float32Array([50, 50, 50, 50, 50, 50, 3]);
    const rad_dep = dep(rad);
    const rad_n = rad.length / 4;

    const seed = 0xbadcafe;
    const tsRng = makeSsbRng(seed);
    const cjRng = cjs.makeSsbRng(seed);

    const tsDirect = scoreDirectSSB_events(tsDna, rad, rad_e, rad_dep, rad_n, tsRng);
    const cjDirect = cjs.scoreDirectSSB_events(cjDna, rad, rad_e, rad_dep, rad_n, cjRng);

    expect(cjDirect.ssb_count).toBe(tsDirect.ssb_count);
    expect(cjDirect.candidates).toBe(tsDirect.candidates);
    expect(cjDirect.in_reach).toBe(tsDirect.in_reach);
    expect(Array.from(cjDirect.hits)).toEqual(Array.from(tsDirect.hits));

    const tsCluster = clusterDSB(tsDna, tsDirect.hits);
    const cjCluster = cjs.clusterDSB(cjDna, cjDirect.hits);
    expect(cjCluster.dsb).toBe(tsCluster.dsb);
    expect(cjCluster.ssb0).toBe(tsCluster.ssb0);
    expect(cjCluster.ssb1).toBe(tsCluster.ssb1);
  });

  it('combineHits is identical between TS and CJS', () => {
    const a = new Uint8Array([0, 1, 0, 1, 1, 0]);
    const b = new Uint8Array([1, 0, 0, 1, 0, 1]);
    expect(Array.from(cjs.combineHits(a, b))).toEqual(Array.from(combineHits(a, b)));
  });

  it('all shared constants match src/physics/constants.ts', () => {
    expect(cjs.DNA_LENGTH_NM).toBe(DNA_LENGTH_NM);
    expect(cjs.DNA_GRID_N).toBe(DNA_GRID_N);
    expect(cjs.DNA_SPACING_NM).toBe(DNA_SPACING_NM);
    expect(cjs.SSB_R_DAMAGE_NM).toBe(SSB_R_DAMAGE_NM);
    expect(cjs.SSB_R_DAMAGE_INDIRECT_NM).toBe(SSB_R_DAMAGE_INDIRECT_NM);
    expect(cjs.SSB_P_INDIRECT).toBe(SSB_P_INDIRECT);
    expect(cjs.SSB_E_LOW).toBe(SSB_E_LOW);
    expect(cjs.SSB_E_HIGH).toBe(SSB_E_HIGH);
    expect(cjs.DSB_WINDOW_BP).toBe(DSB_WINDOW_BP);
    // makeSsbRng not a constant, but seed-0 stream parity:
    const tsRng = makeSsbRng(0);
    const cjRng = cjs.makeSsbRng(0);
    for (let i = 0; i < 100; i++) {
      expect(cjRng()).toBe(tsRng());
    }
  });
});
