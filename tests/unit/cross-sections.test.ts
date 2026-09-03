import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function parseWgslArray(wgsl: string, name: string): number[] {
  const re = new RegExp(`const ${name}=array<f32,\\d+>\\(([^)]+)\\)`);
  const m = wgsl.match(re);
  if (!m) throw new Error(`Array ${name} not found in WGSL`);
  return m[1].split(',').map(Number);
}

function parseWgslConst(wgsl: string, name: string): number {
  const re = new RegExp(`const ${name}=(\\d+)u?`);
  const m = wgsl.match(re);
  if (!m) throw new Error(`Const ${name} not found`);
  return Number(m[1]);
}

const wgsl = readFileSync(join(__dirname, '../../public/cross_sections.wgsl'), 'utf-8');
const XE = parseWgslArray(wgsl, 'XE');
const XI = parseWgslArray(wgsl, 'XI');
const XC = parseWgslArray(wgsl, 'XC');
const XL = parseWgslArray(wgsl, 'XL');
const XN = parseWgslConst(wgsl, 'XN');

// Geant4 reference (from ntuple analysis, narrow energy bins)
const G4_REF = {
  100:  { ion: 0.024, el: 0.024, total: 0.053 },
  300:  { ion: 0.016, el: 0.011, total: 0.028 },
  1000: { ion: 0.007, el: 0.005, total: 0.012 },
  5000: { ion: 0.002, el: 0.001, total: 0.003 },
  10000:{ ion: 0.001144, el: 0.000622, total: 0.001780 },
};

function interp(E: number): { ion: number; exc: number; el: number } {
  const LOG_XE0 = Math.log(XE[0]);
  const step = (Math.log(XE[XN - 1]) - LOG_XE0) / (XN - 1);
  const t = (Math.log(E) - LOG_XE0) / step;
  const i = Math.min(Math.max(Math.floor(t), 0), XN - 2);
  const f = t - i;
  return {
    ion: Math.max(0, XI[i] + (XI[i + 1] - XI[i]) * f),
    exc: Math.max(0, XC[i] + (XC[i + 1] - XC[i]) * f),
    el:  Math.max(0, XL[i] + (XL[i + 1] - XL[i]) * f),
  };
}

describe('Cross section tables', () => {
  it('has correct array length', () => {
    expect(XE).toHaveLength(XN);
    expect(XI).toHaveLength(XN);
    expect(XC).toHaveLength(XN);
    expect(XL).toHaveLength(XN);
  });

  it('energy range covers 8 eV to 30 keV', () => {
    expect(XE[0]).toBeCloseTo(8, 0);
    expect(XE[XN - 1]).toBeGreaterThan(10000);
    expect(XE[XN - 1]).toBeLessThan(50000);
  });

  it('ionization cross section is zero below threshold', () => {
    const xs = interp(9);
    expect(xs.ion).toBe(0);
  });

  it('ionization cross section peaks near 100 eV', () => {
    const xs50 = interp(50);
    const xs100 = interp(100);
    const xs500 = interp(500);
    expect(xs100.ion).toBeGreaterThan(xs50.ion);
    expect(xs100.ion).toBeGreaterThan(xs500.ion);
  });

  // Bands are ~1.7x the measured margins on the committed table
  // (ion worst 1.035x @1 keV; total worst 1.097x @5 keV, 0.924x @100 eV —
  // measured 2026-09-03) so a real conversion/interpolation regression fails
  // instead of hiding inside the old 15%/20% bands.
  for (const [E, ref] of Object.entries(G4_REF)) {
    const eV = Number(E);
    it(`matches Geant4 σ_ion at ${E} eV within 6%`, () => {
      const xs = interp(eV);
      expect(xs.ion / ref.ion).toBeGreaterThan(0.94);
      expect(xs.ion / ref.ion).toBeLessThan(1.06);
    });

    it(`matches Geant4 σ_total at ${E} eV within 12%`, () => {
      const xs = interp(eV);
      const total = xs.ion + xs.exc + xs.el;
      expect(total / ref.total).toBeGreaterThan(0.88);
      expect(total / ref.total).toBeLessThan(1.12);
    });
  }

  it('elastic dominates below 50 eV', () => {
    const xs = interp(20);
    expect(xs.el).toBeGreaterThan(xs.ion);
    expect(xs.el).toBeGreaterThan(xs.exc);
  });

  it('ionization dominates above 100 eV', () => {
    const xs = interp(500);
    expect(xs.ion).toBeGreaterThan(xs.el);
    expect(xs.ion).toBeGreaterThan(xs.exc);
  });
});
