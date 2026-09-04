import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the rxn_info label bug (oxygen network).
 *
 * RXN_TABLE has 47 entries (9 Karamitros + 38 oxygen-network) while
 * rxn_labels only curated the first 9 — entries 9..46 went out with
 * `label: undefined`, crashing tools/run_irt.cjs (`padEnd` of undefined).
 * The worker now falls back to a generated `A+B [type]` label.
 */

type RxnInfo = { label: unknown; count: number; sigma: string; rc: string };
type IRTResult = { type: string; timeline: unknown[]; rxn_info: RxnInfo[] };
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

function runMinimal(): IRTResult {
  // Two radicals (OH pid0 + eaq pid0); rxn_info is emitted regardless of
  // whether any reaction fires, which is exactly the crash path.
  const rad_buf = new Float32Array([0, 0, 0, 0, 0.1, 0, 0, 1]);
  lastResult = null;
  if (!handler) throw new Error('irt-worker.js did not register self.onmessage');
  handler({ data: { rad_buf, rad_n: 2, n_therm: 1, E_eV: 10000 } });
  if (!lastResult) throw new Error('irt-worker.js did not post a result');
  return lastResult;
}

describe('IRT worker rxn_info labels', () => {
  const res = runMinimal();

  it('emits an rxn_info entry per reaction row (9 Karamitros + 38 oxygen = 47)', () => {
    expect(Array.isArray(res.rxn_info)).toBe(true);
    expect(res.rxn_info.length).toBe(47);
  });

  it('every entry has a non-empty string label (oxygen rows included)', () => {
    for (const rx of res.rxn_info) {
      expect(typeof rx.label).toBe('string');
      expect((rx.label as string).length).toBeGreaterThan(0);
    }
  });

  it('keeps the curated Karamitros labels for the first 9 rows', () => {
    expect(res.rxn_info[0].label).toBe('OH+OH→H2O2 [PDC]');
    expect(res.rxn_info[8].label).toBe('H3O++OH-→H2O [TDC]');
  });
});
