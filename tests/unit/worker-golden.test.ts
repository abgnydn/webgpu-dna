import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Golden regression test for the production IRT worker.
 *
 * This is CHARACTERIZATION, not oracle validation: it pins the current
 * deterministic behavior of public/irt-worker.js on a small synthetic cloud
 * so any unintentional change to reaction sampling, pairing, products, or
 * normalization breaks loudly here instead of silently shifting G-values.
 * Oracle correctness vs chem6 stays with the E10/E25 experiment artifacts.
 *
 * Determinism: the worker seeds its own RNG from `chemSeed` (fixed below),
 * so the same input yields the same timeline on any platform — G-values are
 * asserted with toBeCloseTo(6) (tolerance 5e-7, ~100x above typical <1e-15
 * last-ulp libm drift across engines) rather than exact equality; counts
 * and reaction indices are exact.
 */

type Checkpoint = Record<string, number>;
type IRTResult = {
  type: string;
  timeline: Checkpoint[];
  n_reacted: number;
  rxn_info: { label: string; count: number }[];
};
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

const workerSrc = readFileSync(join(__dirname, '../../public/irt-worker.js'), 'utf-8');
(0, eval)(workerSrc);

// Fixed 12-radical cloud: 3 primaries x (OH, eaq, H, H3O+), ~2 nm cluster.
function makeRadBuf(): { rad_buf: Float32Array; rad_n: number } {
  const rows: number[] = [];
  for (let pid = 0; pid < 3; pid++) {
    for (let s = 0; s < 4; s++) {
      const k = pid * 4 + s;
      rows.push(((k * 0.37) % 2) - 1, ((k * 0.53) % 2) - 1, ((k * 0.71) % 2) - 1, pid * 8 + s);
    }
  }
  return { rad_buf: new Float32Array(rows), rad_n: rows.length / 4 };
}

function runGolden(): IRTResult {
  const { rad_buf, rad_n } = makeRadBuf();
  lastResult = null;
  if (!handler) throw new Error('irt-worker.js did not register self.onmessage');
  handler({ data: { rad_buf, rad_n, n_therm: 3, E_eV: 10000, chemSeed: 0x43484d01 } });
  if (!lastResult) throw new Error('irt-worker.js did not post a result');
  return lastResult;
}

describe('IRT worker golden behavior (12-radical cloud, chemSeed 0x43484D01)', () => {
  const res = runGolden();
  const last = res.timeline[res.timeline.length - 1];

  it('fires exactly one reaction: eaq+H (rxn index 4)', () => {
    expect(res.n_reacted).toBe(1);
    expect(res.rxn_info[4].count).toBe(1);
    const total = res.rxn_info.reduce((a, r) => a + r.count, 0);
    expect(total).toBe(1);
  });

  it('pins the 1 us G-values', () => {
    expect(last.G_OH).toBeCloseTo(0.01, 6);
    expect(last.G_eaq).toBeCloseTo(0.006666666666666667, 6);
    expect(last.G_H).toBeCloseTo(0.006666666666666667, 6);
    expect(last.G_H2O2).toBeCloseTo(0, 6);
    expect(last.G_H2).toBeCloseTo(0.0033333333333333335, 6);
  });

  it('pins the checkpoint labels', () => {
    expect(res.timeline.map((c) => c.label)).toEqual([
      '0.1 ps', '1 ps', '10 ps', '100 ps', '1 ns', '10 ns', '100 ns', '1 us',
    ]);
  });
});
