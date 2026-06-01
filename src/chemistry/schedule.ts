/**
 * GPU chemistry driver — runs the 7-checkpoint schedule, calls
 * chemMeasure() at each step, and reads back chem_pos/chem_alive at the
 * end for DSB scoring.
 *
 * Direct port of runChemistry() from public/geant4dna.html.
 */

import type { GPUBuffers } from '../gpu/buffers';
import type { Pipelines } from '../gpu/pipelines';
import { CHEM_N, HASH_SIZE } from '../physics/constants';
import { seedChemRNG } from '../gpu/buffers';
import { chemMeasure } from './measure';
import type { ChemCheckpoint, ChemResult, ChemSnapshot } from '../physics/types';

/** Options accepted by runChemistry. Default: production behaviour (no snapshot). */
export interface RunChemistryOptions {
  /** When true, captures chem_pos + chem_alive at every checkpoint (t=0 plus
   *  the 7 schedule entries) into the returned `ChemResult.snapshots` field.
   *  Used by the 4D splat exporter; off by default to keep the validation
   *  hot path allocation-free. */
  dump_snapshots?: boolean;
  /** Number of leading radicals to dump per checkpoint. The full chem_pos
   *  buffer (~13 M radicals at 10 keV) is far too large for a browser blob,
   *  so we subsample. Default 50 000 → ~6.4 MB across 8 checkpoints. */
  snapshot_n?: number;
  /** Override the [dt_ns, n_steps, label] schedule. Used by the SBS
   *  step-count feasibility probe (E10L) to measure per-step wall-clock at
   *  gMicroMC/MPEXS-style fine step counts without touching the production
   *  default (CHEM_SCHEDULE). When omitted, CHEM_SCHEDULE is used. */
  scheduleOverride?: ReadonlyArray<readonly [number, number, string]>;
}

/**
 * Stage 5 V3e chemistry schedule — PM-IRT with deterministic pair hash.
 * [dt_ns, n_steps, label_at_end]
 */
export const CHEM_SCHEDULE: ReadonlyArray<readonly [number, number, string]> = [
  [0.0001, 10, '1 ps'],
  [0.001,  9,  '10 ps'],
  [0.005,  18, '100 ps'],
  [0.05,   18, '1 ns'],
  [0.5,    18, '10 ns'],
  [3.0,    30, '100 ns'],
  [30.0,   30, '1 μs'],
];

export async function runChemistry(
  device: GPUDevice,
  buffers: GPUBuffers,
  pipelines: Pipelines,
  rad_n_raw: number,
  E_eV: number,
  n_therm: number,
  options?: RunChemistryOptions,
): Promise<ChemResult | null> {
  const chem_n = Math.min(rad_n_raw, CHEM_N);
  if (chem_n === 0) return null;

  const dump = !!options?.dump_snapshots;
  const snap_n = dump ? Math.min(options?.snapshot_n ?? 50_000, chem_n) : 0;
  const SCHED = options?.scheduleOverride ?? CHEM_SCHEDULE;

  // Pre-allocate per-checkpoint readback buffers (1 t=0 + schedule entries).
  const NUM_SNAPS = 1 + SCHED.length;
  const snapPosRBs: GPUBuffer[] = [];
  const snapAliveRBs: GPUBuffer[] = [];
  if (dump && snap_n > 0) {
    for (let i = 0; i < NUM_SNAPS; i++) {
      snapPosRBs.push(
        device.createBuffer({
          size: snap_n * 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
      snapAliveRBs.push(
        device.createBuffer({
          size: snap_n * 4,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
    }
  }

  const captureSnapshot = (k: number): void => {
    if (!dump || snap_n === 0) return;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffers.chemPos, 0, snapPosRBs[k], 0, snap_n * 16);
    enc.copyBufferToBuffer(buffers.chemAlive, 0, snapAliveRBs[k], 0, snap_n * 4);
    device.queue.submit([enc.finish()]);
  };

  const stride = 1;

  // sample_init reads (chem_n, _, stride, _).
  {
    const ubuf = new ArrayBuffer(16);
    const uu = new Uint32Array(ubuf);
    uu[0] = chem_n;
    uu[2] = stride;
    device.queue.writeBuffer(buffers.chemUni, 0, ubuf);
  }

  const enc_sample = device.createCommandEncoder();
  const pass_sample = enc_sample.beginComputePass();
  pass_sample.setPipeline(pipelines.chemSample);
  pass_sample.setBindGroup(0, pipelines.chemBG);
  pass_sample.dispatchWorkgroups(Math.ceil(chem_n / 256));
  pass_sample.end();
  device.queue.submit([enc_sample.finish()]);

  const clear_wg = Math.ceil(HASH_SIZE / 256);

  // Initialize alive[] = 1 and seed per-radical RNG.
  const alive = new Uint32Array(chem_n);
  alive.fill(1);
  device.queue.writeBuffer(buffers.chemAlive, 0, alive);
  seedChemRNG(device, buffers.chemRng, chem_n);

  // Zero full chem_stats (128 B = 32 u32).
  device.queue.writeBuffer(buffers.chemStats, 0, new Uint32Array(32));

  const timeline: ChemCheckpoint[] = [];
  let t_accumulated_ns = 0;
  const t_wall_start = performance.now();

  // Pre-chemistry thermalization (Gaussian offsets, species-specific).
  {
    const enc_init = device.createCommandEncoder();
    const pass_init = enc_init.beginComputePass();
    pass_init.setPipeline(pipelines.chemInit);
    pass_init.setBindGroup(0, pipelines.chemBG);
    pass_init.dispatchWorkgroups(Math.ceil(chem_n / 256));
    pass_init.end();
    device.queue.submit([enc_init.finish()]);
  }

  // t=0 checkpoint (after thermalization).
  const t0_state = await chemMeasure(device, buffers, pipelines, chem_n);
  captureSnapshot(0);
  timeline.push({
    label: 't=0',
    t_ns: 0,
    G_OH: 0, G_eaq: 0, G_H: 0, G_H2O2: 0, G_H2: 0,
    alive_OH: t0_state.alive_OH,
    alive_eaq: t0_state.alive_eaq,
    alive_H: t0_state.alive_H,
    prod_H2O2: t0_state.prod_H2O2,
    prod_H2: t0_state.prod_H2,
  });

  for (const [dt_ns, n_steps, label] of SCHED) {
    const wg = Math.ceil(chem_n / 256);
    const ubuf = new ArrayBuffer(16);
    const uu = new Uint32Array(ubuf);
    const uf = new Float32Array(ubuf);
    uu[0] = chem_n;
    uf[1] = dt_ns;
    uu[2] = 1;
    uu[3] = 0;
    device.queue.writeBuffer(buffers.chemUni, 0, ubuf);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let step = 0; step < n_steps; step++) {
      pass.setPipeline(pipelines.chemDiffuse);
      pass.setBindGroup(0, pipelines.chemBG);
      pass.dispatchWorkgroups(wg);

      pass.setPipeline(pipelines.chemClearHash);
      pass.setBindGroup(0, pipelines.chemBG);
      pass.dispatchWorkgroups(clear_wg);

      pass.setPipeline(pipelines.chemBuildHash);
      pass.setBindGroup(0, pipelines.chemBG);
      pass.dispatchWorkgroups(wg);

      pass.setPipeline(pipelines.chemReact);
      pass.setBindGroup(0, pipelines.chemBG);
      pass.dispatchWorkgroups(wg);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();

    const state = await chemMeasure(device, buffers, pipelines, chem_n);
    t_accumulated_ns += dt_ns * n_steps;
    timeline.push({
      label,
      t_ns: t_accumulated_ns,
      G_OH: 0, G_eaq: 0, G_H: 0, G_H2O2: 0, G_H2: 0,
      alive_OH: state.alive_OH,
      alive_eaq: state.alive_eaq,
      alive_H: state.alive_H,
      prod_H2O2: state.prod_H2O2,
      prod_H2: state.prod_H2,
    });
    captureSnapshot(timeline.length - 1);
  }

  const t_wall = performance.now() - t_wall_start;

  // Readback for DSB scoring.
  const enc_rb = device.createCommandEncoder();
  enc_rb.copyBufferToBuffer(buffers.chemPos, 0, buffers.chemPosRB, 0, chem_n * 16);
  enc_rb.copyBufferToBuffer(buffers.chemAlive, 0, buffers.chemAliveRB, 0, chem_n * 4);
  device.queue.submit([enc_rb.finish()]);

  await Promise.all([
    buffers.chemPosRB.mapAsync(GPUMapMode.READ, 0, chem_n * 16),
    buffers.chemAliveRB.mapAsync(GPUMapMode.READ, 0, chem_n * 4),
  ]);
  const chem_pos_final = new Float32Array(
    buffers.chemPosRB.getMappedRange(0, chem_n * 16).slice(0) as ArrayBuffer,
  );
  const chem_alive_final = new Uint32Array(
    buffers.chemAliveRB.getMappedRange(0, chem_n * 4).slice(0) as ArrayBuffer,
  );
  buffers.chemPosRB.unmap();
  buffers.chemAliveRB.unmap();

  // G-value factor: per-100-eV scaling uses deposited energy proportional to chem_n
  // share of the full rad cloud.
  const deposited_eV = n_therm * E_eV * (chem_n / rad_n_raw);
  const per100 = deposited_eV / 100;
  for (const cp of timeline) {
    cp.G_OH   = per100 > 0 ? (cp.alive_OH ?? 0) / per100 : 0;
    cp.G_eaq  = per100 > 0 ? (cp.alive_eaq ?? 0) / per100 : 0;
    cp.G_H    = per100 > 0 ? (cp.alive_H ?? 0) / per100 : 0;
    cp.G_H2O2 = per100 > 0 ? (cp.prod_H2O2 ?? 0) / per100 : 0;
    cp.G_H2   = per100 > 0 ? (cp.prod_H2 ?? 0) / per100 : 0;
  }

  // Resolve per-checkpoint readbacks (if requested) and assemble snapshots[].
  let snapshots: ChemSnapshot[] | undefined;
  if (dump && snap_n > 0) {
    await Promise.all([
      ...snapPosRBs.map((b) => b.mapAsync(GPUMapMode.READ)),
      ...snapAliveRBs.map((b) => b.mapAsync(GPUMapMode.READ)),
    ]);
    snapshots = timeline.map((cp, k) => ({
      label: cp.label,
      t_ns: cp.t_ns,
      n: snap_n,
      pos: new Float32Array(snapPosRBs[k].getMappedRange().slice(0) as ArrayBuffer),
      alive: new Uint32Array(snapAliveRBs[k].getMappedRange().slice(0) as ArrayBuffer),
    }));
    snapPosRBs.forEach((b) => { b.unmap(); b.destroy(); });
    snapAliveRBs.forEach((b) => { b.unmap(); b.destroy(); });
  }

  return { chem_n, t_wall, timeline, chem_pos_final, chem_alive_final, deposited_eV, snapshots };
}
