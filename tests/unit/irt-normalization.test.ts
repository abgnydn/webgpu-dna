import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Golden normalization guard for the IRT worker.
 *
 * The E22-E24 "over-recombination" phantom (corrected in E25) was a units bug:
 * run_irt was invoked with n_therm=10000 instead of 4096, silently scaling every
 * G-value by 0.41x and making a working fix look broken across three experiments.
 *
 * The worker normalizes G = count / (n_therm * E_eV / 100) (irt-worker.js:864),
 * so every G-value must scale as 1/n_therm exactly. With a deterministic
 * (seeded) Math.random the physics is identical across two runs, so doubling
 * n_therm must halve every G — a contract a normalization bug breaks. This
 * mirrors the eval-shim harness in tools/run_irt.cjs.
 */

// Deterministic worker RNG so the physics is identical across runs,
// isolating n_therm (the only varied input) as the cause of any G change.
// NOTE: the worker draws from its own seeded `_rngState` (mulberry32,
// default seed when no chemSeed is passed — see irt-worker.js rand()), NOT
// Math.random, so overriding Math.random below is belt-and-braces only.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed tiny radical cloud: 3 primaries x 4 species (OH/eaq/H/H3O+), clustered
// within ~2 nm so reactions fire. w = pid*8 + species_code (irt-worker.js:510).
function makeRadBuf(): { rad_buf: Float32Array; rad_n: number } {
  const speciesCodes = [0, 1, 2, 3];
  const rows: number[] = [];
  for (let pid = 0; pid < 3; pid++) {
    for (let s = 0; s < speciesCodes.length; s++) {
      const k = pid * speciesCodes.length + s;
      rows.push(((k * 0.37) % 2) - 1, ((k * 0.53) % 2) - 1, ((k * 0.71) % 2) - 1, pid * 8 + speciesCodes[s]);
    }
  }
  return { rad_buf: new Float32Array(rows), rad_n: rows.length / 4 };
}

type Checkpoint = Record<string, number>;
type IRTResult = { type: string; timeline: Checkpoint[] };
type IRTHandler = (e: { data: Record<string, unknown> }) => void;

let handler: IRTHandler | null = null;
let lastResult: IRTResult | null = null;
const shim = {
  postMessage(data: { type?: string }): void {
    if (data && data.type === 'result') lastResult = data as IRTResult;
  },
};
Object.defineProperty(shim, 'onmessage', {
  set(fn: IRTHandler): void { handler = fn; },
  get(): IRTHandler | null { return handler; },
});
(globalThis as unknown as { self: unknown }).self = shim;

// Indirect eval -> sloppy-mode global scope, matching tools/run_irt.cjs's eval.
const workerSrc = readFileSync(join(__dirname, '../../public/irt-worker.js'), 'utf-8');
(0, eval)(workerSrc);

function runIRT(n_therm: number, E_eV = 10000): IRTResult {
  const { rad_buf, rad_n } = makeRadBuf();
  const realRandom = Math.random;
  Math.random = mulberry32(0x00c0ffee);
  lastResult = null;
  try {
    if (!handler) throw new Error('irt-worker.js did not register self.onmessage');
    handler({ data: { rad_buf, rad_n, n_therm, E_eV } });
  } finally {
    Math.random = realRandom;
  }
  if (!lastResult) throw new Error('irt-worker.js did not post a result');
  return lastResult;
}

describe('IRT G-value normalization (n_therm contract)', () => {
  const SPECIES = ['G_OH', 'G_eaq', 'G_H', 'G_H2O2', 'G_H2'];
  const r1 = runIRT(3);
  const r2 = runIRT(6);
  const last = (r: IRTResult): Checkpoint => r.timeline[r.timeline.length - 1];

  it('produces finite, non-trivial G-values', () => {
    const cp = last(r1);
    for (const sp of SPECIES) expect(Number.isFinite(cp[sp])).toBe(true);
    expect(SPECIES.some((sp) => last(r1)[sp] > 0)).toBe(true);
  });

  it('scales G exactly as 1/n_therm (doubling n_therm halves every G)', () => {
    const a = last(r1);
    const b = last(r2);
    for (const sp of SPECIES) {
      if (a[sp] === 0) continue;
      expect(b[sp]).toBeCloseTo(a[sp] / 2, 6);
    }
  });
});
