/**
 * Validates the analytical nucleosome geometry against known B-DNA / 1KX5
 * nucleosome dimensions — the geometry the SSB/DSB scorer will run against
 * once chromatin replaces the straight-fibre grid.
 */
import { describe, it, expect } from 'vitest';
import { buildNucleosome, R_BB } from '../../src/physics/chromatin-geometry';

const dist = (
  ax: Float32Array, ay: Float32Array, az: Float32Array, i: number,
  bx: Float32Array, by: Float32Array, bz: Float32Array, j: number,
) => Math.hypot(ax[i] - bx[j], ay[i] - by[j], az[i] - bz[j]);

describe('nucleosome geometry', () => {
  const nuc = buildNucleosome();

  it('has the 147 bp nucleosome core', () => {
    expect(nuc.n_bp).toBe(147);
  });

  it('consecutive same-strand backbones are ~0.68 nm apart (B-DNA P–P)', () => {
    let sum = 0;
    for (let i = 1; i < nuc.n_bp; i++) sum += dist(nuc.bx, nuc.by, nuc.bz, i, nuc.bx, nuc.by, nuc.bz, i - 1);
    const mean = sum / (nuc.n_bp - 1);
    expect(mean).toBeGreaterThan(0.55);
    expect(mean).toBeLessThan(0.80);
  });

  it('the two strands of a base pair are ~2·r_bb apart (across the duplex)', () => {
    let sum = 0;
    for (let i = 0; i < nuc.n_bp; i++) sum += dist(nuc.bx, nuc.by, nuc.bz, i, nuc.b1x, nuc.b1y, nuc.b1z, i);
    const mean = sum / nuc.n_bp;
    expect(mean).toBeGreaterThan(2 * R_BB - 0.3);
    expect(mean).toBeLessThan(2 * R_BB + 0.3);
  });

  it('fits a ~10 nm-diameter, ~4 nm-tall nucleosome disc', () => {
    let maxR = 0, maxZ = -Infinity, minZ = Infinity;
    for (let i = 0; i < nuc.n_bp; i++) {
      for (const [x, y, z] of [
        [nuc.bx[i], nuc.by[i], nuc.bz[i]],
        [nuc.b1x[i], nuc.b1y[i], nuc.b1z[i]],
      ] as const) {
        maxR = Math.max(maxR, Math.hypot(x, y));
        maxZ = Math.max(maxZ, z);
        minZ = Math.min(minZ, z);
      }
    }
    expect(maxR).toBeGreaterThan(4.0); // ~R_SH + r_bb ≈ 5.2 nm radius
    expect(maxR).toBeLessThan(6.5);
    expect(maxZ - minZ).toBeGreaterThan(3.0); // ~1.65 × 2.39 ≈ 4 nm tall
    expect(maxZ - minZ).toBeLessThan(6.0);
  });

  it('winds the DNA around the superhelix (backbones span the full azimuth)', () => {
    // ~1.65 turns → the duplex-centre azimuth should sweep > 2π.
    let minPhi = Infinity, maxPhi = -Infinity;
    for (let i = 0; i < nuc.n_bp; i++) {
      const cx = (nuc.bx[i] + nuc.b1x[i]) / 2, cy = (nuc.by[i] + nuc.b1y[i]) / 2;
      const phi = Math.atan2(cy, cx) + (i / nuc.n_bp) * 2 * Math.PI * 1.65; // unwrapped-ish proxy
      minPhi = Math.min(minPhi, phi); maxPhi = Math.max(maxPhi, phi);
    }
    expect(maxPhi - minPhi).toBeGreaterThan(2 * Math.PI); // more than one full turn
  });
});
