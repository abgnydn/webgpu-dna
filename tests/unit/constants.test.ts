import { describe, it, expect } from 'vitest';
import { BIND, EXC_E, VIB_LEV, DIFFUSION, NW, IRT_REACTIONS, KARAMITROS_2011 } from '../../src/physics/constants';

describe('Physics constants', () => {
  it('has 5 ionization shells with correct binding energies', () => {
    expect(BIND).toHaveLength(5);
    expect(BIND[0]).toBeCloseTo(10.79, 2);  // 1b₁
    expect(BIND[1]).toBeCloseTo(13.39, 2);  // 3a₁
    expect(BIND[2]).toBeCloseTo(16.05, 2);  // 1b₂
    expect(BIND[3]).toBeCloseTo(32.30, 2);  // 2a₁
    expect(BIND[4]).toBeCloseTo(539.0, 1);  // 1a₁ (K-shell)
  });

  it('has 5 excitation levels', () => {
    expect(EXC_E).toHaveLength(5);
    expect(EXC_E[0]).toBeCloseTo(8.22, 2);   // A¹B₁
    expect(EXC_E[4]).toBeCloseTo(13.77, 2);  // Diffuse
  });

  it('has 9 vibrational modes', () => {
    expect(VIB_LEV).toHaveLength(9);
    expect(VIB_LEV[0]).toBeCloseTo(0.01, 3);
    expect(VIB_LEV[8]).toBeCloseTo(0.835, 3);
  });

  it('has correct water molecule density', () => {
    expect(NW).toBeCloseTo(33.4, 1);
  });

  it('has correct diffusion coefficients (nm²/ns)', () => {
    expect(DIFFUSION.OH).toBeCloseTo(2.2, 1);
    expect(DIFFUSION.eaq).toBeCloseTo(4.9, 1);
    expect(DIFFUSION.H).toBeCloseTo(7.0, 1);
    expect(DIFFUSION.H3O).toBeCloseTo(9.46, 1); // G4Hydronium.cc; matches the worker
  });

  it('has 7 reaction channels', () => {
    expect(IRT_REACTIONS).toHaveLength(7);
  });

  it('OH+OH reaction produces H2O2', () => {
    const ohoh = IRT_REACTIONS[0];
    expect(ohoh[0]).toBe(0); // OH
    expect(ohoh[1]).toBe(0); // OH
    expect(ohoh[4]).toBe(1); // product = H2O2
  });

  it('eaq+H3O+ reaction produces H (species conversion)', () => {
    const eaqh3o = IRT_REACTIONS[5];
    expect(eaqh3o[0]).toBe(1); // eaq
    expect(eaqh3o[1]).toBe(3); // H3O+
    expect(eaqh3o[4]).toBe(3); // product = convert eaq→H
  });

  it('Karamitros 2011 reference values are defined', () => {
    expect(KARAMITROS_2011.G_OH).toBeCloseTo(2.50, 2);
    expect(KARAMITROS_2011.G_eaq).toBeCloseTo(2.50, 2);
    expect(KARAMITROS_2011.G_H).toBeCloseTo(0.57, 2);
    expect(KARAMITROS_2011.G_H2O2).toBeCloseTo(0.73, 2);
    expect(KARAMITROS_2011.G_H2).toBeCloseTo(0.42, 2);
  });
});
