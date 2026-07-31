/**
 * Pins the direct-SSB de-dup contract: direct damage is scored ONCE per
 * dissociation event, at the mother site — regardless of how many rad_buf
 * entries the event emits or where the ejected e-aq thermalizes.
 *
 * Regression target: the old "compare the next entry" de-dup assumed 2 entries
 * at one position. The shader emits up to 3 (OH, e-aq, H3O+) with the e-aq at a
 * DISPLACED point, so a single ionization was scored ~2-3x, inflating SSB_dir.
 */
import { describe, it, expect } from 'vitest';
import { buildDNATarget } from '../../src/physics/dna-geometry';
import { scoreDirectSSB_events } from '../../src/scoring/ssb-dsb';

// rad_buf .w packs pid*8 + species. Species: 0 OH, 1 eaq, 2 H, 3 H3O+, 4 O,
// 5 pre-therm eaq, 6 OH-, 7 H2 marker.
function w(species: number, pid = 0): number {
  return pid * 8 + species;
}

// Build a rad_buf (Float32Array of vec4s) from [x,y,z,species] rows.
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

describe('scoreDirectSSB_events de-dup', () => {
  const dna = buildDNATarget(3000, 3, 150);
  const alwaysBreak = () => 0; // rng() < p_break always → SSB whenever p_break > 0
  // Per-event deposited energy (eV), aligned 1:1 with rad_buf entries. 50 eV is
  // above SSB_E_HIGH (37.5) so the ramp gives p_break = 1 for these de-dup tests.
  const hiE = (n: number) => new Float32Array(n).fill(50);

  // Exact backbone-atom position for fiber 0, bp b, strand 0.
  function atom0(b: number): [number, number, number] {
    return [
      dna.x0 + b * dna.rise,
      dna.fy[0] + dna.rbb0[b * 2 + 0],
      dna.fz[0] + dna.rbb0[b * 2 + 1],
    ];
  }

  it('scores one SSB for a 3-entry ionization event (OH, displaced e-aq, H3O+)', () => {
    const [x, y, z] = atom0(10);
    // e-aq (species 5) is displaced off the site and interleaved between the
    // two mother-position entries — the exact shape that broke the old de-dup.
    const rad = radBuf([
      [x, y, z, 0], // OH @ mother
      [x + 3, y + 3, z + 3, 5], // pre-therm e-aq @ displaced
      [x, y, z, 3], // H3O+ @ mother
    ]);
    const r = scoreDirectSSB_events(dna, rad, hiE(3), 3, alwaysBreak);
    expect(r.candidates).toBe(1); // one site, not three
    expect(r.ssb_count).toBe(1);
  });

  it('skips the H2 marker and regular e-aq, still one SSB per event', () => {
    const [x, y, z] = atom0(10);
    const rad = radBuf([
      [x, y, z, 0], // OH @ mother
      [x, y, z, 7], // H2 marker @ mother (non-radical)
      [x + 2, y + 2, z + 2, 1], // regular e-aq @ displaced
    ]);
    const r = scoreDirectSSB_events(dna, rad, hiE(3), 3, alwaysBreak);
    expect(r.candidates).toBe(1);
    expect(r.ssb_count).toBe(1);
  });

  it('counts distinct events at distinct sites separately', () => {
    const a = atom0(10);
    const b = atom0(40); // far enough to be a different bp
    const rad = radBuf([
      [a[0], a[1], a[2], 0],
      [a[0], a[1], a[2], 3],
      [b[0], b[1], b[2], 0],
      [b[0], b[1], b[2], 3],
    ]);
    const r = scoreDirectSSB_events(dna, rad, hiE(4), 4, alwaysBreak);
    expect(r.candidates).toBe(2);
    expect(r.ssb_count).toBe(2);
  });

  it('two distinct sites snapping to the same bp/strand break it only once', () => {
    const [x, y, z] = atom0(10);
    // Two distinct positions, both within r_direct (0.29 nm) of the same atom,
    // so they are separate scoring passes but resolve to the same bp/strand.
    const rad = radBuf([
      [x, y, z, 0], // exactly on the atom
      [x + 0.05, y + 0.05, z, 0], // 0.07 nm away → same bp/strand
    ]);
    const r = scoreDirectSSB_events(dna, rad, hiE(2), 2, alwaysBreak);
    expect(r.candidates).toBe(2); // two distinct scoring passes
    expect(r.in_reach).toBe(2);
    expect(r.ssb_count).toBe(1); // but the same bp/strand breaks only once
  });

  it('energy ramp: a sub-E_low deposit is in reach but never breaks', () => {
    const [x, y, z] = atom0(10);
    const rad = radBuf([[x, y, z, 0]]);
    const lowE = new Float32Array([3]); // < SSB_E_LOW (5 eV) → p_break = 0
    const r = scoreDirectSSB_events(dna, rad, lowE, 1, alwaysBreak);
    expect(r.in_reach).toBe(1);
    expect(r.ssb_count).toBe(0);
  });

  it('accumulation: two sub-E_low deposits at one sugar sum to cross the threshold', () => {
    const [x, y, z] = atom0(10);
    // Two DISTINCT positions (not collapsed by the one-roll de-dup), both within
    // r_direct of the same atom, each 3 eV < SSB_E_LOW (5). Neither breaks alone
    // (see the test above), but the site accumulates E_acc = 6 eV > 5, giving
    // p_break = (6-5)/(37.5-5) ≈ 0.031 > 0 → one break. This pins the
    // accumulate-then-threshold-once contract: a regression to per-event
    // thresholding would score 0 here.
    const rad = radBuf([
      [x, y, z, 0],
      [x + 0.05, y + 0.05, z, 0],
    ]);
    const subE = new Float32Array([3, 3]);
    const r = scoreDirectSSB_events(dna, rad, subE, 2, alwaysBreak);
    expect(r.in_reach).toBe(2);
    expect(r.ssb_count).toBe(1);
  });

  it('energy ramp: a mid-range deposit breaks per the linear probability', () => {
    const [x, y, z] = atom0(10);
    const rad = radBuf([[x, y, z, 0]]);
    const midE = new Float32Array([21.25]); // midpoint of 5..37.5 → p_break = 0.5
    expect(scoreDirectSSB_events(dna, rad, midE, 1, () => 0.4).ssb_count).toBe(1);
    expect(scoreDirectSSB_events(dna, rad, midE, 1, () => 0.6).ssb_count).toBe(0);
  });
});
