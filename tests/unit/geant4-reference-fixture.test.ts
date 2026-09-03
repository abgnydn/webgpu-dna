import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins tests/fixtures/geant4-reference.json so it cannot drift silently.
 *
 * The fixture is a historical Geant4 11.3.0 reference snapshot (track
 * structure + chem6 timeline + Karamitros anchor) — no test imported it, so
 * it was dead weight. This test asserts its shape and key values, documenting
 * it as the historical baseline (not the 11.4.1 oracle in README §Numbers).
 */

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/geant4-reference.json'), 'utf-8'),
);

describe('geant4-reference fixture', () => {
  it('describes the Geant4 11.3.0 DNA_Opt2 10 keV baseline', () => {
    expect(fixture.description).toMatch(/Geant4 11\.3\.0/);
    expect(fixture.track_structure.csda_nm).toBeCloseTo(2756.5, 0);
    expect(fixture.track_structure.ions_per_primary).toBeCloseTo(196.5, 0);
  });

  it('carries a chem6 timeline with the five scored species', () => {
    const cps = fixture.chemistry_timeline.checkpoints;
    expect(cps.length).toBeGreaterThan(0);
    for (const cp of cps) {
      for (const k of ['G_OH', 'G_eaq', 'G_H', 'G_H2O2', 'G_H2']) {
        expect(Number.isFinite(cp[k])).toBe(true);
      }
    }
  });

  it('carries the Karamitros 2011 low-LET anchor', () => {
    expect(fixture.karamitros_2011.G_OH).toBeCloseTo(2.5, 2);
    expect(fixture.karamitros_2011.G_eaq).toBeCloseTo(2.5, 2);
  });
});
