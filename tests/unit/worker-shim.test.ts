import { describe, it, expect } from 'vitest';
import { runWorkerSync } from '../../tools/worker-shim.cjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke test for the shared worker-shim harness.
 *
 * Uses the exact 2-radical synthetic input that exercises the post-#19/#25
 * rxn_info label invariant: timeline has 8 checkpoints, rxn_info has 47 rows,
 * and no label is undefined.
 */

type Checkpoint = { label: string };
type RxnInfo = { label: unknown; count: number };
type IRTResult = {
  type: string;
  timeline: Checkpoint[];
  rxn_info: RxnInfo[];
};

const workerPath = join(__dirname, '../../public/irt-worker.js');
const workerSrc = readFileSync(workerPath, 'utf-8');

function runMinimal(): IRTResult {
  const rad_buf = new Float32Array([0, 0, 0, 0, 0.1, 0, 0, 1]);
  let lastResult: IRTResult | null = null;

  runWorkerSync(
    workerPath,
    { rad_buf, rad_n: 2, n_therm: 1, E_eV: 10000 },
    (data: IRTResult & { type?: string }) => {
      if (data && data.type === 'result') lastResult = data;
    },
    workerSrc
  );

  if (!lastResult) throw new Error('irt-worker.js did not post a result');
  return lastResult;
}

describe('worker-shim harness smoke test', () => {
  const res = runMinimal();

  it('runs the worker and returns a result object', () => {
    expect(res.type).toBe('result');
  });

  it('emits the 8 checkpoint timeline', () => {
    expect(res.timeline).toHaveLength(8);
    expect(res.timeline.map((c) => c.label)).toEqual([
      '0.1 ps', '1 ps', '10 ps', '100 ps', '1 ns', '10 ns', '100 ns', '1 us',
    ]);
  });

  it('emits rxn_info with 47 rows (9 Karamitros + 38 oxygen)', () => {
    expect(Array.isArray(res.rxn_info)).toBe(true);
    expect(res.rxn_info.length).toBe(47);
  });

  it('has zero undefined labels', () => {
    for (const rx of res.rxn_info) {
      expect(typeof rx.label).toBe('string');
      expect(rx.label).not.toBeUndefined();
    }
  });
});
