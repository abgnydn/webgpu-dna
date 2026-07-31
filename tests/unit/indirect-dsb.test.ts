/**
 * Coverage for the two headline scorers that had none:
 *  - scoreIndirectSSB — surviving OH within the (larger) indirect reach breaks a
 *    strand with probability SSB_P_INDIRECT.
 *  - clusterDSB — greedy ±DSB_WINDOW_BP pairing of strand-0/strand-1 SSBs.
 * Together these produce the headline indirect/direct ratio and DSB counts.
 */
import { describe, it, expect } from 'vitest';
import { buildDNATarget } from '../../src/physics/dna-geometry';
import { scoreIndirectSSB, clusterDSB } from '../../src/scoring/ssb-dsb';
import { SPECIES } from '../../src/physics/constants';

const dna = buildDNATarget(3000, 3, 150);
const alwaysBreak = () => 0; // rng() = 0 < SSB_P_INDIRECT (0.13) → always breaks

// A backbone atom on fiber 0, strand 0, bp b (same helper shape as the direct test).
function atom0(b: number): [number, number, number] {
  return [dna.x0 + b * dna.rise, dna.fy[0] + dna.rbb0[b * 2 + 0], dna.fz[0] + dna.rbb0[b * 2 + 1]];
}

// One chem_pos entry (Float32Array vec4) at pos with the given species.
function chem(pos: [number, number, number], species: number): Float32Array {
  return new Float32Array([pos[0], pos[1], pos[2], species]);
}

describe('scoreIndirectSSB', () => {
  it('an OH sitting on a backbone atom breaks a strand', () => {
    const pos = chem(atom0(10), SPECIES.OH);
    const r = scoreIndirectSSB(dna, pos, new Uint32Array([1]), 1, alwaysBreak);
    expect(r.candidates).toBe(1);
    expect(r.in_reach).toBe(1);
    expect(r.ssb0 + r.ssb1).toBe(1);
  });

  it('a dead OH is ignored', () => {
    const pos = chem(atom0(10), SPECIES.OH);
    const r = scoreIndirectSSB(dna, pos, new Uint32Array([0]), 1, alwaysBreak);
    expect(r.candidates).toBe(0);
    expect(r.ssb0 + r.ssb1).toBe(0);
  });

  it('a non-OH species (eaq) is ignored', () => {
    const pos = chem(atom0(10), SPECIES.eaq);
    const r = scoreIndirectSSB(dna, pos, new Uint32Array([1]), 1, alwaysBreak);
    expect(r.candidates).toBe(0);
  });

  it('an OH far from any fibre is out of reach', () => {
    const [x, y, z] = atom0(10);
    const pos = chem([x, y + 500, z + 500], SPECIES.OH); // 500 nm off the grid
    const r = scoreIndirectSSB(dna, pos, new Uint32Array([1]), 1, alwaysBreak);
    expect(r.in_reach).toBe(0);
    expect(r.ssb0 + r.ssb1).toBe(0);
  });
});

describe('clusterDSB', () => {
  const n = dna.n_bp;

  // hits[fi*n_per + b]        → strand 0, fibre fi, bp b
  // hits[fi*n_per + b + n]    → strand 1
  function hitsWith(pairs: Array<[number, 0 | 1]>): Uint8Array {
    const h = new Uint8Array(n * 2);
    for (const [b, strand] of pairs) h[b + (strand === 1 ? n : 0)] = 1;
    return h;
  }

  it('opposite-strand hits within ±10 bp form one DSB', () => {
    const r = clusterDSB(dna, hitsWith([[10, 0], [12, 1]])); // 2 bp apart
    expect(r.dsb).toBe(1);
    expect(r.ssb0).toBe(1);
    expect(r.ssb1).toBe(1);
  });

  it('opposite-strand hits more than 10 bp apart do NOT pair', () => {
    const r = clusterDSB(dna, hitsWith([[10, 0], [30, 1]])); // 20 bp apart
    expect(r.dsb).toBe(0);
    expect(r.ssb0).toBe(1);
    expect(r.ssb1).toBe(1);
  });

  it('same-strand hits never pair', () => {
    const r = clusterDSB(dna, hitsWith([[10, 0], [11, 0]]));
    expect(r.dsb).toBe(0);
    expect(r.ssb0).toBe(2);
    expect(r.ssb1).toBe(0);
  });

  it('greedy pairing consumes each strand-1 hit at most once', () => {
    // Two strand-0 hits both within ±10 of a single strand-1 hit → one DSB only.
    const r = clusterDSB(dna, hitsWith([[10, 0], [14, 0], [12, 1]]));
    expect(r.dsb).toBe(1);
    expect(r.ssb0).toBe(2);
    expect(r.ssb1).toBe(1);
  });
});
