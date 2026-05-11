/**
 * Phase A α/β benchmark harness — exposes `window.runPhaseABench(opts)`.
 *
 * Drives the fused primary-tracking WGSL dispatch at user-specified batch
 * sizes N with warmup + timed-trial discipline. No Phase B, no chemistry,
 * no DNA scoring — isolates the kernel-fusion claim.
 *
 * Per-trial timing model:
 *   - reseed RNG (deterministic by seed + trial index)
 *   - zero counters + dose grid (so atomicAdd's don't pile up across trials)
 *   - t0 = performance.now()
 *   - encode + submit Phase A dispatch
 *   - await device.queue.onSubmittedWorkDone()  (forced GPU sync)
 *   - t1 = performance.now()
 *
 * The Phase A WGSL writes to rad_buf and sec_buf during the dispatch; we
 * don't read them back in the bench loop, so allocation cost is paid once
 * up-front and per-trial cost is dispatch + GPU compute + driver sync.
 *
 * The driver in `experiments/level-6-performance/E15-phase-a-alpha-beta.mjs`
 * collects medians and fits T(N) = α + β·N via OLS.
 */

import { initGPU } from './gpu/device';
import { allocateBuffers, seedPrimaryRNG } from './gpu/buffers';
import { createPipelines } from './gpu/pipelines';
import { MAX_SEC, MAX_RAD, VC } from './physics/constants';
import type { GPUBuffers } from './gpu/buffers';
import type { Pipelines } from './gpu/pipelines';

interface BenchOpts {
  Ns: number[];
  warmups: number;
  trials: number;
  energyEv: number;
  boxNm?: number;
  ceEV?: number;
  seed?: number;
}

interface BenchPerN {
  N: number;
  trialsMs: number[];
  median: number;
  mean: number;
  std: number;
  min: number;
  max: number;
}

interface BenchResult {
  energyEv: number;
  boxNm: number;
  ceEV: number;
  seed: number;
  adapter: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  perN: BenchPerN[];
}

declare global {
  interface Window {
    runPhaseABench?: (opts: BenchOpts) => Promise<BenchResult>;
    __benchReady?: boolean;
    __benchError?: string;
  }
}

function writePrimaryParams(
  device: GPUDevice,
  buf: GPUBuffer,
  np: number,
  boxNm: number,
  ceEV: number,
  energyEv: number,
): void {
  const pbuf = new ArrayBuffer(64);
  const pu = new Uint32Array(pbuf);
  const pf = new Float32Array(pbuf);
  pu[0] = np;
  pf[1] = boxNm;
  pf[2] = ceEV;
  pu[3] = 65536;
  pf[4] = energyEv;
  pu[5] = MAX_SEC;
  pu[6] = VC;
  pu[7] = MAX_RAD;
  pf[8] = 0.0;
  pu[9] = 0; // dna disabled in bench
  pu[10] = 0;
  pu[11] = 0;
  pf[12] = 0.0;
  pf[13] = 0.0;
  pf[14] = 0.0;
  pf[15] = 0.0;
  device.queue.writeBuffer(buf, 0, pbuf);
}

async function dispatchOnce(
  device: GPUDevice,
  pipelines: Pipelines,
  np: number,
): Promise<number> {
  const t0 = performance.now();
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipelines.primary);
  pass.setBindGroup(0, pipelines.primaryBG);
  pass.dispatchWorkgroups(Math.ceil(np / 256));
  pass.end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  return performance.now() - t0;
}

function stats(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const median =
    n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1
      ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
      : 0;
  return {
    median,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

interface CachedRig {
  device: GPUDevice;
  buffers: GPUBuffers;
  pipelines: Pipelines;
  npAlloc: number;
  adapter: GPUAdapter;
}

let cached: CachedRig | null = null;

async function setupRig(maxN: number): Promise<CachedRig> {
  const device = await initGPU();
  if (!device) throw new Error('initGPU returned null — no WebGPU device');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter returned null after device init (?)');
  const buffers = allocateBuffers(device, maxN);
  const pipelines = await createPipelines(device, buffers);
  return { device, buffers, pipelines, npAlloc: maxN, adapter };
}

async function runPhaseABench(opts: BenchOpts): Promise<BenchResult> {
  const boxNm = opts.boxNm ?? 15000;
  const ceEV = opts.ceEV ?? 7.4;
  const seed = opts.seed ?? 0x50455201; // E15_DISPATCH
  const maxN = Math.max(...opts.Ns);

  if (!cached || cached.npAlloc < maxN) {
    cached = await setupRig(maxN);
  }
  const { device, buffers, pipelines, adapter } = cached;
  const adapterInfo = (adapter as unknown as { info?: GPUAdapterInfo }).info ?? {
    vendor: '',
    architecture: '',
    device: '',
    description: '',
  };

  const doseSize = VC * VC * VC;
  const perN: BenchPerN[] = [];

  for (const N of opts.Ns) {
    // Warmups (discard)
    for (let w = 0; w < opts.warmups; w++) {
      seedPrimaryRNG(device, buffers.rng, N, seed + w);
      writePrimaryParams(device, buffers.params, N, boxNm, ceEV, opts.energyEv);
      device.queue.writeBuffer(buffers.counters, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.dbg, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.secStats, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.dose, 0, new Uint32Array(doseSize));
      await dispatchOnce(device, pipelines, N);
    }

    const trialsMs: number[] = [];
    for (let t = 0; t < opts.trials; t++) {
      seedPrimaryRNG(device, buffers.rng, N, seed + 1000 + t);
      writePrimaryParams(device, buffers.params, N, boxNm, ceEV, opts.energyEv);
      device.queue.writeBuffer(buffers.counters, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.dbg, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.secStats, 0, new Uint32Array(8));
      device.queue.writeBuffer(buffers.dose, 0, new Uint32Array(doseSize));
      const ms = await dispatchOnce(device, pipelines, N);
      trialsMs.push(ms);
    }

    perN.push({ N, trialsMs, ...stats(trialsMs) });
  }

  return {
    energyEv: opts.energyEv,
    boxNm,
    ceEV,
    seed,
    adapter: {
      vendor: adapterInfo.vendor ?? '',
      architecture: adapterInfo.architecture ?? '',
      device: adapterInfo.device ?? '',
      description: adapterInfo.description ?? '',
    },
    limits: {
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    },
    perN,
  };
}

if (typeof window !== 'undefined') {
  try {
    window.runPhaseABench = runPhaseABench;
    window.__benchReady = true;
    console.log('[bench] runPhaseABench ready');
  } catch (e) {
    window.__benchError = e instanceof Error ? e.message : String(e);
  }
}
