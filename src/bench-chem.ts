/**
 * GPU chemistry backend bench harness — exposes `window.runGpuChemBench(opts)`.
 *
 * Drives `src/shaders/chemistry.wgsl` (the GPU-resident pre-chemistry +
 * diffusion + reaction pipeline) on a rad_buf dump loaded from the dev
 * server, then returns the per-checkpoint G-values for comparison to the
 * IRT worker (`public/irt-worker.js`) running on the same rad bin.
 *
 * E11 driver in `experiments/level-4-chemistry/E11-gpu-chem-vs-irt.mjs`
 * Playwrights this page, calls runGpuChemBench, and compares to the
 * already-cached IRT result from `experiments/.cache/E10/`.
 */

import { initGPU } from './gpu/device';
import { allocateBuffers } from './gpu/buffers';
import { createPipelines } from './gpu/pipelines';
import { runChemistry } from './chemistry/schedule';
import { MAX_RAD } from './physics/constants';
import type { GPUBuffers } from './gpu/buffers';
import type { Pipelines } from './gpu/pipelines';

interface ChemBenchOpts {
  binUrl: string;
  energyEv: number;
  nTherm: number;
  np?: number;
}

interface ChemBenchResult {
  energyEv: number;
  nTherm: number;
  radN: number;
  binBytes: number;
  walltimeMs: number;
  adapter: { vendor: string; architecture: string; device: string; description: string };
  timeline: Array<{
    label: string;
    t_ns: number;
    G_OH: number;
    G_eaq: number;
    G_H: number;
    G_H2O2: number;
    G_H2: number;
    alive_OH: number;
    alive_eaq: number;
    alive_H: number;
    prod_H2O2: number;
    prod_H2: number;
  }>;
}

declare global {
  interface Window {
    runGpuChemBench?: (opts: ChemBenchOpts) => Promise<ChemBenchResult>;
    __chemBenchReady?: boolean;
    __chemBenchError?: string;
  }
}

let cached: {
  device: GPUDevice;
  buffers: GPUBuffers;
  pipelines: Pipelines;
  adapter: GPUAdapter;
} | null = null;

async function setupRig(np: number) {
  const device = await initGPU();
  if (!device) throw new Error('initGPU failed');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter failed');
  const buffers = allocateBuffers(device, np);
  const pipelines = await createPipelines(device, buffers);
  return { device, buffers, pipelines, adapter };
}

async function runGpuChemBench(opts: ChemBenchOpts): Promise<ChemBenchResult> {
  const np = opts.np ?? 4096;
  if (!cached) cached = await setupRig(np);
  const { device, buffers, pipelines, adapter } = cached;
  const adapterInfo =
    (adapter as unknown as { info?: GPUAdapterInfo }).info ?? ({} as GPUAdapterInfo);

  const resp = await fetch(opts.binUrl);
  if (!resp.ok) throw new Error(`bin fetch failed: ${resp.status} ${opts.binUrl}`);
  const ab = await resp.arrayBuffer();
  const f32 = new Float32Array(ab);
  const radN = Math.min(f32.length / 4, MAX_RAD);
  // Upload to rad_buf. We only need radN records (16 bytes each).
  device.queue.writeBuffer(buffers.radBuf, 0, f32, 0, radN * 4);

  const t0 = performance.now();
  const result = await runChemistry(
    device,
    buffers,
    pipelines,
    radN,
    opts.energyEv,
    opts.nTherm,
  );
  const walltimeMs = performance.now() - t0;

  if (!result) throw new Error('runChemistry returned null');

  // Convert alive counts to G-values: G(species) = count / (n_therm * E_eV / 100).
  const per100 = (opts.nTherm * opts.energyEv) / 100;
  const timeline = result.timeline.map((cp) => {
    const aOH = cp.alive_OH ?? 0;
    const aEaq = cp.alive_eaq ?? 0;
    const aH = cp.alive_H ?? 0;
    const pH2O2 = cp.prod_H2O2 ?? 0;
    const pH2 = cp.prod_H2 ?? 0;
    return {
      label: cp.label,
      t_ns: cp.t_ns,
      G_OH: per100 > 0 ? aOH / per100 : 0,
      G_eaq: per100 > 0 ? aEaq / per100 : 0,
      G_H: per100 > 0 ? aH / per100 : 0,
      G_H2O2: per100 > 0 ? pH2O2 / per100 : 0,
      G_H2: per100 > 0 ? pH2 / per100 : 0,
      alive_OH: aOH,
      alive_eaq: aEaq,
      alive_H: aH,
      prod_H2O2: pH2O2,
      prod_H2: pH2,
    };
  });

  return {
    energyEv: opts.energyEv,
    nTherm: opts.nTherm,
    radN,
    binBytes: ab.byteLength,
    walltimeMs,
    adapter: {
      vendor: adapterInfo.vendor ?? '',
      architecture: adapterInfo.architecture ?? '',
      device: adapterInfo.device ?? '',
      description: adapterInfo.description ?? '',
    },
    timeline,
  };
}

if (typeof window !== 'undefined') {
  try {
    window.runGpuChemBench = runGpuChemBench;
    window.__chemBenchReady = true;
    console.log('[chem-bench] runGpuChemBench ready');
  } catch (e) {
    window.__chemBenchError = e instanceof Error ? e.message : String(e);
  }
}
