/**
 * Phase A (primaries) → Phase B (secondary wavefront) → readback orchestrator.
 * Direct port of runAtEnergy() from public/geant4dna.html.
 */

import { MAX_SEC, MAX_RAD, VC, MAX_SEC_STEPS } from '../physics/constants';
import type { GPUBuffers } from './buffers';
import type { Pipelines } from './pipelines';
import type { DNATarget, EnergyResult, ChemResult } from '../physics/types';
import { seedPrimaryRNG } from './buffers';

/** Write primary uniform struct P (64 bytes) */
function writePrimaryParams(
  device: GPUDevice,
  buf: GPUBuffer,
  np: number,
  boxNm: number,
  ceEV: number,
  E_eV: number,
  dna: DNATarget | null,
): void {
  const pbuf = new ArrayBuffer(64);
  const pu = new Uint32Array(pbuf);
  const pf = new Float32Array(pbuf);
  pu[0] = np;            // n
  pf[1] = boxNm;         // box (half-width)
  pf[2] = ceEV;          // ce (solvation cutoff)
  pu[3] = 65536;         // ms (max primary steps)
  pf[4] = E_eV;          // be (beam energy)
  pu[5] = MAX_SEC;
  pu[6] = VC;
  pu[7] = MAX_RAD;
  pf[8] = 0.0;           // start_half (0 = origin)
  pu[9] = (dna && E_eV === 10000) ? 1 : 0;   // dna_enable
  pu[10] = dna ? dna.grid_N : 0;             // dna_grid_n
  pu[11] = 0;                                // _pad3
  pf[12] = dna ? dna.rise : 0.0;
  pf[13] = dna ? dna.spacing_nm : 0.0;
  pf[14] = dna ? dna.x0 : 0.0;
  pf[15] = dna ? dna.r_bb : 0.0;
  device.queue.writeBuffer(buf, 0, pbuf);
}

/** Write secondary uniform struct SP (48 bytes) */
function writeSecondaryParams(
  device: GPUDevice,
  buf: GPUBuffer,
  secN: number,
  boxNm: number,
  ceEV: number,
  E_eV: number,
  dna: DNATarget | null,
): void {
  const sbuf = new ArrayBuffer(48);
  const su = new Uint32Array(sbuf);
  const sf = new Float32Array(sbuf);
  su[0] = secN;
  sf[1] = boxNm;
  sf[2] = ceEV;
  su[3] = VC;
  su[4] = MAX_RAD;
  su[5] = (dna && E_eV === 10000) ? 1 : 0;
  su[6] = dna ? dna.grid_N : 0;
  su[7] = MAX_SEC;   // max_sec — bound for tertiary-cascade emission into sec_buf
  sf[8] = dna ? dna.rise : 0.0;
  sf[9] = dna ? dna.spacing_nm : 0.0;
  sf[10] = dna ? dna.x0 : 0.0;
  sf[11] = dna ? dna.r_bb : 0.0;
  device.queue.writeBuffer(buf, 0, sbuf);
}

export interface RunAtEnergyExtras {
  /** Captured dose grid (128³ u32, ×100 units/eV). Only populated for 10 keV. */
  dose_arr: Uint32Array | null;
}

/**
 * Run one energy point.
 *
 * Optional `runChemistry` callback is invoked AFTER rad_buf readback when
 * E_eV === 10000 and there are radicals to process. Kept as a callback so
 * the GPU dispatch module doesn't have to depend on the chemistry worker
 * or the IRT fallback.
 */
export async function runAtEnergy(
  device: GPUDevice,
  buffers: GPUBuffers,
  pipelines: Pipelines,
  E_eV: number,
  np: number,
  boxNm: number,
  ceEV: number,
  dna: DNATarget | null,
  runChemistry?: (radBuf: Float32Array, radN: number, nTherm: number, E_eV: number) => Promise<ChemResult | null>,
): Promise<EnergyResult & RunAtEnergyExtras> {
  const doseSize = VC * VC * VC;

  seedPrimaryRNG(device, buffers.rng, np, Math.floor(E_eV));
  device.queue.writeBuffer(buffers.dbg, 0, new Uint32Array(8));
  device.queue.writeBuffer(buffers.secStats, 0, new Uint32Array(8));
  device.queue.writeBuffer(buffers.dose, 0, new Uint32Array(doseSize));
  device.queue.writeBuffer(buffers.counters, 0, new Uint32Array(8));

  writePrimaryParams(device, buffers.params, np, boxNm, ceEV, E_eV, dna);

  const t0 = performance.now();

  // ---- Phase A: primaries ----
  const enc1 = device.createCommandEncoder();
  const pass1 = enc1.beginComputePass();
  pass1.setPipeline(pipelines.primary);
  pass1.setBindGroup(0, pipelines.primaryBG);
  pass1.dispatchWorkgroups(Math.ceil(np / 256));
  pass1.end();
  enc1.copyBufferToBuffer(buffers.counters, 0, buffers.countersRB, 0, 32);
  device.queue.submit([enc1.finish()]);
  await device.queue.onSubmittedWorkDone();
  const t_prim = performance.now() - t0;

  // Read sec_n + rad_n after phase A.
  await buffers.countersRB.mapAsync(GPUMapMode.READ);
  const countersA = new Uint32Array(buffers.countersRB.getMappedRange().slice(0) as ArrayBuffer);
  buffers.countersRB.unmap();
  const sec_n_raw = countersA[6];
  const sec_n = Math.min(sec_n_raw, MAX_SEC);
  const sec_dropped = Math.max(0, sec_n_raw - MAX_SEC);

  // ---- Phase B: secondary wavefront (with tertiary-cascade growth) ----
  // The secondary shader now emits tertiary electrons into sec_buf (counters[6]
  // grows). We process in chunks, re-reading the wavefront size between chunks
  // so newly-emitted tertiaries (gen3+) get tracked — recovering the cascade
  // ionisations Geant4 produces (E21).
  let t_sec = 0;
  if (sec_n > 0) {
    const t1 = performance.now();
    const CHUNK = 100; // steps per chunk while the cascade wavefront is growing
    let cur_sec_n = sec_n;
    let base = 0;
    // Phase B-1: track cascade growth, re-reading the wavefront size each chunk
    // UNTIL it stabilises. Particle energies only decrease, so once a chunk emits
    // no new tertiaries (counter unchanged) none ever will — the readbacks (the
    // expensive GPU syncs) can then stop.
    while (base < MAX_SEC_STEPS) {
      const steps = Math.min(CHUNK, MAX_SEC_STEPS - base);
      writeSecondaryParams(device, buffers.secParams, cur_sec_n, boxNm, ceEV, E_eV, dna);
      const enc2 = device.createCommandEncoder();
      const pass2 = enc2.beginComputePass();
      pass2.setPipeline(pipelines.secondary);
      pass2.setBindGroup(0, pipelines.secondaryBG);
      const wg = Math.ceil(cur_sec_n / 256);
      for (let step = 0; step < steps; step++) pass2.dispatchWorkgroups(wg);
      pass2.end();
      enc2.copyBufferToBuffer(buffers.counters, 0, buffers.countersRB, 0, 32);
      device.queue.submit([enc2.finish()]);
      await device.queue.onSubmittedWorkDone();
      await buffers.countersRB.mapAsync(GPUMapMode.READ);
      const grown = Math.min(new Uint32Array(buffers.countersRB.getMappedRange().slice(0) as ArrayBuffer)[6], MAX_SEC);
      buffers.countersRB.unmap();
      base += steps;
      if (grown === cur_sec_n) break; // wavefront stable — cascade emission complete
      cur_sec_n = grown;
    }
    // Phase B-2: thermalise the (now-fixed) wavefront for the remaining steps in a
    // single submitted pass — no per-chunk readbacks needed.
    if (base < MAX_SEC_STEPS) {
      writeSecondaryParams(device, buffers.secParams, cur_sec_n, boxNm, ceEV, E_eV, dna);
      const encR = device.createCommandEncoder();
      const passR = encR.beginComputePass();
      passR.setPipeline(pipelines.secondary);
      passR.setBindGroup(0, pipelines.secondaryBG);
      const wg = Math.ceil(cur_sec_n / 256);
      for (let step = base; step < MAX_SEC_STEPS; step++) passR.dispatchWorkgroups(wg);
      passR.end();
      device.queue.submit([encR.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    const encS = device.createCommandEncoder();
    encS.copyBufferToBuffer(buffers.secStats, 0, buffers.secStatsRB, 0, 32);
    device.queue.submit([encS.finish()]);
    await device.queue.onSubmittedWorkDone();
    t_sec = performance.now() - t1;
  }

  // ---- Readbacks ----
  const enc3 = device.createCommandEncoder();
  enc3.copyBufferToBuffer(buffers.results, 0, buffers.resultsRB, 0, np * 32);
  enc3.copyBufferToBuffer(buffers.dose, 0, buffers.doseRB, 0, doseSize * 4);
  enc3.copyBufferToBuffer(buffers.counters, 0, buffers.countersRB, 0, 32);
  device.queue.submit([enc3.finish()]);
  await device.queue.onSubmittedWorkDone();

  await buffers.resultsRB.mapAsync(GPUMapMode.READ);
  const rsBuf = buffers.resultsRB.getMappedRange().slice(0) as ArrayBuffer;
  const rsU32 = new Uint32Array(rsBuf);
  const rsF32 = new Float32Array(rsBuf);
  buffers.resultsRB.unmap();

  let secStats = new Uint32Array(8);
  if (sec_n > 0) {
    await buffers.secStatsRB.mapAsync(GPUMapMode.READ);
    secStats = new Uint32Array(buffers.secStatsRB.getMappedRange().slice(0) as ArrayBuffer);
    buffers.secStatsRB.unmap();
  }

  await buffers.doseRB.mapAsync(GPUMapMode.READ);
  const doseArr = new Uint32Array(buffers.doseRB.getMappedRange().slice(0) as ArrayBuffer);
  buffers.doseRB.unmap();

  // Sum voxels; dose grid is u32 ×100 units/eV, use a Float64 accumulator.
  let dose_sum = 0;
  for (let i = 0; i < doseArr.length; i++) dose_sum += doseArr[i];
  const total_deposited_eV = dose_sum / 100.0;

  await buffers.countersRB.mapAsync(GPUMapMode.READ);
  const countersB = new Uint32Array(buffers.countersRB.getMappedRange().slice(0) as ArrayBuffer);
  buffers.countersRB.unmap();
  const rad_OH = countersB[0];
  const rad_eaq = countersB[1];
  const rad_H = countersB[2];
  const kernel_dna_hits = countersB[4];
  const rad_n_raw = countersB[7];
  const rad_n_stored = Math.min(rad_n_raw, MAX_RAD);
  const rad_dropped = Math.max(0, rad_n_raw - MAX_RAD);

  const per100 = total_deposited_eV / 100.0;
  const G_OH = per100 > 0 ? rad_OH / per100 : 0;
  const G_eaq = per100 > 0 ? rad_eaq / per100 : 0;
  const G_H = per100 > 0 ? rad_H / per100 : 0;

  // Per-primary aggregation: only count thermalized particles.
  let total_sum = 0;
  let prod_sum = 0;
  let sp_sum = 0;
  let ions_sum = 0;
  let n_therm = 0;
  let n_esc = 0;
  for (let i = 0; i < np; i++) {
    const path = rsF32[i * 8 + 0];
    const prod = rsF32[i * 8 + 1];
    const finalE = rsF32[i * 8 + 2];
    const ni = rsU32[i * 8 + 3];
    const esc = rsU32[i * 8 + 5];
    if (esc === 1) { n_esc++; continue; }
    n_therm++;
    total_sum += path;
    prod_sum += prod;
    if (path > 0) sp_sum += (E_eV - finalE) / path;
    ions_sum += ni;
  }

  const mean_total = n_therm > 0 ? total_sum / n_therm : 0;
  const mean_prod = n_therm > 0 ? prod_sum / n_therm : 0;
  const mean_sp = n_therm > 0 ? sp_sum / n_therm : 0;
  const mean_ions = n_therm > 0 ? ions_sum / n_therm : 0;

  const expected_deposited_eV = n_therm * E_eV;
  const cons_ratio = expected_deposited_eV > 0 ? total_deposited_eV / expected_deposited_eV : 0;

  // ---- rad_buf readback (for DSB + chemistry) ----
  let rad_buf_final: Float32Array | null = null;
  if (rad_n_stored > 0) {
    const bytes = rad_n_stored * 16;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffers.radBuf, 0, buffers.radBufRB, 0, bytes);
    device.queue.submit([enc.finish()]);
    await buffers.radBufRB.mapAsync(GPUMapMode.READ, 0, bytes);
    rad_buf_final = new Float32Array(
      buffers.radBufRB.getMappedRange(0, bytes).slice(0) as ArrayBuffer,
    );
    buffers.radBufRB.unmap();
  }

  // ---- rad_e readback (per-event deposited energy, aligned to rad_buf) ----
  let rad_e_final: Float32Array | null = null;
  if (rad_n_stored > 0) {
    const ebytes = rad_n_stored * 4;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffers.radE, 0, buffers.radERB, 0, ebytes);
    device.queue.submit([enc.finish()]);
    await buffers.radERB.mapAsync(GPUMapMode.READ, 0, ebytes);
    rad_e_final = new Float32Array(
      buffers.radERB.getMappedRange(0, ebytes).slice(0) as ArrayBuffer,
    );
    buffers.radERB.unmap();
  }

  // ---- rad_dep readback (true deposit site (x,y,z,_) per rad_buf entry) ----
  let rad_dep_final: Float32Array | null = null;
  if (rad_n_stored > 0) {
    const dbytes = rad_n_stored * 16;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffers.radDep, 0, buffers.radDepRB, 0, dbytes);
    device.queue.submit([enc.finish()]);
    await buffers.radDepRB.mapAsync(GPUMapMode.READ, 0, dbytes);
    rad_dep_final = new Float32Array(
      buffers.radDepRB.getMappedRange(0, dbytes).slice(0) as ArrayBuffer,
    );
    buffers.radDepRB.unmap();
  }

  // ---- Chemistry (only at 10 keV) ----
  let chem_result: ChemResult | null = null;
  if (E_eV === 10000 && rad_buf_final && rad_n_stored > 0 && runChemistry) {
    chem_result = await runChemistry(rad_buf_final, rad_n_stored, n_therm, E_eV);
  }

  const dt = performance.now() - t0;

  return {
    E: E_eV,
    n_therm,
    n_esc,
    mean_total,
    mean_prod,
    mean_sp,
    mean_ions,
    dt,
    t_prim,
    t_sec,
    sec_n,
    sec_dropped,
    sec_per_pri: sec_n / np,
    sec_terminated_cutoff: secStats[1] ?? 0,
    sec_terminated_bounds: secStats[2] ?? 0,
    sec_steps: secStats[3] ?? 0,
    sec_tertiary_ions: secStats[4] ?? 0,
    total_deposited_eV,
    expected_deposited_eV,
    cons_ratio,
    rad_OH,
    rad_eaq,
    rad_H,
    G_OH,
    G_eaq,
    G_H,
    rad_n_raw,
    rad_n_stored,
    rad_dropped,
    kernel_dna_hits,
    chem_result,
    rad_buf_final,
    rad_e_final,
    rad_dep_final,
    dose_arr: E_eV === 10000 ? doseArr : null,
  };
}
