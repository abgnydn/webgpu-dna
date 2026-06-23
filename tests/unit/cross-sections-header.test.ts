import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard against the stale generated-header class (PR #1). The v0.7.0 change
 * swapped the excitation cross section Emfietzoglou -> Born and regenerated the
 * XC data, but the committed cross_sections.wgsl header still read
 * "Excitation: Emfietzoglou model" for a whole release. The converter now
 * derives the header from the actual source filename; this test asserts the
 * committed header is consistent with the XC data itself, so a header that
 * contradicts the cross section fails CI.
 */
const wgsl = readFileSync(join(__dirname, '../../public/cross_sections.wgsl'), 'utf-8');

function parseArr(name: string): number[] {
  const m = wgsl.match(new RegExp(`const ${name}=array<f32,\\d+>\\(([^)]+)\\)`));
  if (!m) throw new Error(`${name} not found in cross_sections.wgsl`);
  return m[1].split(',').map(Number);
}

describe('cross_sections.wgsl header <-> data consistency', () => {
  // Emfietzoglou excitation sigma peaks ~2.4-2.8x higher than Born (CLAUDE.md):
  // the committed Born XC peak is ~0.00106 nm^2; Emfietzoglou was ~0.00288 nm^2.
  const xcPeak = Math.max(...parseArr('XC'));
  const dataModel = xcPeak < 0.002 ? 'born' : 'emfietzoglou';
  const otherModel = dataModel === 'born' ? 'emfietzoglou' : 'born';
  const excLine = wgsl.split('\n').find((l) => /^\/\/\s*Excitation:/.test(l)) ?? '';

  it('has an "// Excitation:" header line', () => {
    expect(excLine).not.toBe('');
  });

  it('names the excitation model that matches the XC magnitude', () => {
    // The committed Born data (~0.00106 peak) must be described by a Born header,
    // never an Emfietzoglou one (the exact bug from PR #1), and vice versa.
    expect(excLine.toLowerCase()).toContain(dataModel);
    expect(excLine.toLowerCase()).not.toContain(otherModel);
  });
});
