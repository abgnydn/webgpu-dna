/**
 * runValidation() — full validation harness orchestrator.
 *
 * Direct port of runValidation() from public/geant4dna.html. One iteration
 * per ESTAR energy: primary Phase A → secondary Phase B → dose readback →
 * chemistry (10 keV only) → DSB scoring (10 keV only). Results stream to the
 * results table and the log; 10 keV dose grid is painted at the end.
 */

import { initGPU } from './gpu/device';
import { allocateBuffers, type GPUBuffers } from './gpu/buffers';
import { createPipelines, type Pipelines } from './gpu/pipelines';
import { runAtEnergy } from './gpu/dispatch';
import { buildDNATarget } from './physics/dna-geometry';
import { ESTAR } from './scoring/estar';
import { runChemistry as runChemistryGPU } from './chemistry/schedule';
import { runChemistryWorker } from './chemistry/worker';
import {
  scoreIndirectSSB,
  scoreDirectSSB_events,
  clusterDSB,
  combineHits,
  makeSsbRng,
} from './scoring/ssb-dsb';
import { SSB_R_DAMAGE_INDIRECT_NM, SSB_P_INDIRECT } from './physics/constants';
import { paintDoseProjection } from './ui/canvas';
import { appendResultRow, clearResults, type DamageRow } from './ui/table';
import type { ChemResult, LogFn } from './physics/types';
import {
  DNA_LENGTH_NM,
  DNA_GRID_N,
  DNA_SPACING_NM,
  KARAMITROS_2011,
} from './physics/constants';

import { DEFAULT_CHEM_BACKEND, type ChemBackend } from './chemistry/backend';

/** Re-exported for historical call sites. New code should import from
 *  `src/chemistry/backend`. */
export { DEFAULT_CHEM_BACKEND };
export type { ChemBackend };

export interface ValidationConfig {
  np: number;
  boxNm: number;
  ceEV: number;
  log: LogFn;
  chemBackend?: ChemBackend;
}

interface PipeCache {
  device: GPUDevice;
  buffers: GPUBuffers;
  pipelines: Pipelines;
  np: number;
}

let cache: PipeCache | null = null;

export type { PipeCache };

/**
 * Lazy-initialise GPU device + pipelines. Re-creates buffers/pipelines if
 * the primary count changes (matches makePipes() early-out in the HTML).
 */
export async function ensurePipelines(np: number, log: LogFn): Promise<PipeCache | null> {
  if (cache && cache.np === np) return cache;

  if (!cache) {
    const device = await initGPU(log);
    if (!device) return null;
    const buffers = allocateBuffers(device, np);
    const pipelines = await createPipelines(device, buffers);
    cache = { device, buffers, pipelines, np };
  } else if (cache.np !== np) {
    // For simplicity, rebuild all buffers + pipelines on size change. The HTML
    // has the same behaviour gated by the `G.np === np` early-return in makePipes.
    const buffers = allocateBuffers(cache.device, np);
    const pipelines = await createPipelines(cache.device, buffers);
    cache = { device: cache.device, buffers, pipelines, np };
  }

  log(`Shaders compiled, buffers allocated (np=${np})`, 'data');
  return cache;
}

/**
 * Run the full 8-energy sweep. Returns one EnergyResult per energy point.
 * DSB scoring + dose projections are only executed at 10 keV (the active
 * validation target — matches the HTML gate).
 */
export async function runValidation(cfg: ValidationConfig): Promise<void> {
  const { np, boxNm, ceEV, log, chemBackend = DEFAULT_CHEM_BACKEND } = cfg;

  clearTable();

  const cc = await ensurePipelines(np, log);
  if (!cc) return;
  const { device, buffers, pipelines } = cc;

  log(`Running ${np} primaries at ${ESTAR.length} energies, box=${boxNm}nm, cutoff=${ceEV}eV`, 'data');

  const dna = buildDNATarget(DNA_LENGTH_NM, DNA_GRID_N, DNA_SPACING_NM);
  log(
    `DNA target: ${dna.n_fibers} fibers × ${dna.n_bp_per} bp = ${(dna.n_bp / 1e6).toFixed(2)} Mbp ` +
      `(${DNA_LENGTH_NM} nm, ${DNA_GRID_N}² grid, ${DNA_SPACING_NM} nm spacing)`,
    'data',
  );

  const ssbRng = makeSsbRng();

  // Chemistry callback is passed into runAtEnergy; dispatch only calls it when
  // E_eV === 10000 and there are radicals to process.
  // The worker accepts DNA + SSB scoring options to accumulate indirect SSBs
  // during the chemistry timeline (PHYSICS_DIAGNOSIS.md §3 option b) rather
  // than the original t=1μs-only scan in scoreIndirectSSB (which under-counted
  // because by then the IRT had consumed essentially all OHs near DNA).
  const ssbScoring = {
    r_indirect: SSB_R_DAMAGE_INDIRECT_NM,
    p_indirect: SSB_P_INDIRECT,
    seed: 0x53534231, // 'SSB1'
  };
  const chemCallback = chemBackend === 'none'
    ? undefined
    : async (radBuf: Float32Array, radN: number, nTherm: number, E_eV: number): Promise<ChemResult | null> => {
        if (chemBackend === 'worker') {
          return runChemistryWorker(radBuf, radN, nTherm, E_eV, log, undefined, dna ?? undefined, ssbScoring);
        }
        return runChemistryGPU(device, buffers, pipelines, radN, E_eV, nTherm);
      };

  let lastDose: Uint32Array | null = null;
  let lastDoseBox = boxNm;

  for (const ref of ESTAR) {
    const r = await runAtEnergy(device, buffers, pipelines, ref.E, np, boxNm, ceEV, dna, chemCallback);

    if (r.dose_arr) {
      lastDose = r.dose_arr;
      lastDoseBox = boxNm;
    }

    const csdaRatio = r.mean_total / ref.csda;
    let damage: DamageRow | null = null;

    if (r.chem_result && r.rad_buf_final && ref.E === 10000) {
      damage = scoreDamageAt10keV(dna, r.chem_result, r.rad_buf_final, r.rad_n_stored, r.total_deposited_eV, boxNm, ssbRng, log, r.kernel_dna_hits);
    }

    const tbody = document.getElementById('tb');
    if (tbody) appendResultRow(tbody, r, ref, damage);

    log(
      `  E=${r.E} eV: CSDA=${r.mean_total.toFixed(1)}nm (${csdaRatio.toFixed(2)}×) ` +
        `ions/pri=${r.mean_ions.toFixed(1)} sec/pri=${r.sec_per_pri.toFixed(1)} ` +
        `G_init(OH/eaq/H)=${r.G_OH.toFixed(2)}/${r.G_eaq.toFixed(2)}/${r.G_H.toFixed(2)} ` +
        `rad_n=${r.rad_n_stored}${r.rad_dropped > 0 ? ' ⚠' + r.rad_dropped + 'dropped' : ''} ` +
        `E_cons=${(r.cons_ratio * 100).toFixed(1)}%`,
      'data',
    );

    if (r.chem_result) logChemistryTimeline(r.chem_result, log);
  }

  log('Validation run complete.', 'ok');

  if (lastDose) {
    paintDoseProjection('dose_xy', lastDose, 'z', lastDoseBox);
    paintDoseProjection('dose_yz', lastDose, 'x', lastDoseBox);
  }
}

/**
 * Run indirect + direct-event SSB scoring + DSB clustering at 10 keV. Logs
 * the DAMAGE summary and returns numbers for the results-table cell.
 */
function scoreDamageAt10keV(
  dna: ReturnType<typeof buildDNATarget>,
  chem: ChemResult,
  radBuf: Float32Array,
  radN: number,
  totalDepositedEV: number,
  boxNm: number,
  rng: () => number,
  log: LogFn,
  kernelDnaHits: number,
): DamageRow {
  // Prefer the IRT-side accumulated SSB count (PHYSICS_DIAGNOSIS.md §3
  // option b, instrumented 2026-05-12 in public/irt-worker.js). It captures
  // OH-backbone encounters during the chemistry timeline, not just at
  // t=1μs survivors — closes the E13c finding that radius alone can't
  // lift SSB_ind from 0.
  //
  // Fallback to the t=1μs scan when:
  //   • chem.ssb_indirect is missing (older worker / GPU backend), AND
  //   • chem_pos_final / chem_alive_final are present (otherwise we have
  //     literally no signal).
  let ssb_ind: number;
  let indirectHits: Uint8Array;
  if (chem.ssb_indirect) {
    // IRT worker did the scoring. It now returns the per-bp hit mask
    // alongside the count, so the DSB clusterer sees both direct AND
    // indirect hits — co-located strand-0/strand-1 damage clusters
    // into a DSB correctly.
    ssb_ind = chem.ssb_indirect.total;
    indirectHits = chem.ssb_indirect.hits ?? new Uint8Array(dna.n_bp * 2);
  } else if (chem.chem_pos_final && chem.chem_alive_final) {
    const fallback = scoreIndirectSSB(dna, chem.chem_pos_final, chem.chem_alive_final, chem.chem_n, rng);
    ssb_ind = fallback.ssb0 + fallback.ssb1;
    indirectHits = fallback.hits;
  } else {
    ssb_ind = 0;
    indirectHits = new Uint8Array(dna.n_bp * 2);
  }

  const direct = scoreDirectSSB_events(dna, radBuf, radN, rng);

  const hitsCombined = combineHits(direct.hits, indirectHits);
  const clust = clusterDSB(dna, hitsCombined);

  const ssb_dir = direct.ssb_count;
  const dsb = clust.dsb;

  // box_nm is HALF-WIDTH (matches WGSL p.box). Full edge length = 2 × boxNm.
  const dose_box_Gy = (totalDepositedEV * 1.602e-19) / (Math.pow(2 * boxNm * 1e-9, 3) * 1000);
  const target_Gbp = dna.n_bp * 1e-9;
  const dsb_per_gy_gbp = dose_box_Gy > 0 ? dsb / (dose_box_Gy * target_Gbp) : 0;
  const ssbTot = ssb_dir + ssb_ind;
  const dsbFrac = ssbTot > 0 ? dsb / ssbTot : 0;

  log(
    `    DAMAGE: SSB_dir=${ssb_dir}  SSB_ind=${ssb_ind}  DSB=${dsb}  ` +
      `(DSB/SSB=${dsbFrac.toFixed(3)})  box_dose=${dose_box_Gy.toFixed(3)} Gy  ` +
      `target=${(dna.n_bp / 1e6).toFixed(1)} Mbp  reach_dir=${direct.in_reach} reach_ind=${chem.ssb_indirect?.in_reach ?? 0}  ` +
      `kernel_hits=${kernelDnaHits || 0}`,
    'data',
  );

  return { ssb_dir, ssb_ind, dsb, dsb_per_gy_gbp };
}

/** Log the chem-worker / GPU-chemistry timeline table (matches HTML format). */
function logChemistryTimeline(cr: ChemResult, log: LogFn): void {
  log(`    chemistry V3b: N=${cr.chem_n} radicals, ${cr.t_wall.toFixed(0)}ms total`, 'data');
  log(
    `    ${'t'.padEnd(8)} ${'G(OH)'.padStart(7)} ${'G(eaq)'.padStart(7)} ${'G(H)'.padStart(7)} ${'G(H2O2)'.padStart(8)} ${'G(H2)'.padStart(7)}`,
    'data',
  );
  for (const cp of cr.timeline) {
    log(
      `    ${cp.label.padEnd(8)} ` +
        `${cp.G_OH.toFixed(3).padStart(7)} ` +
        `${cp.G_eaq.toFixed(3).padStart(7)} ` +
        `${cp.G_H.toFixed(3).padStart(7)} ` +
        `${cp.G_H2O2.toFixed(3).padStart(8)} ` +
        `${cp.G_H2.toFixed(3).padStart(7)}`,
      'data',
    );
  }
  log(
    `    Karamitros 2011 reference (1 μs): G(OH)=${KARAMITROS_2011.G_OH} G(eaq)=${KARAMITROS_2011.G_eaq} ` +
      `G(H)=${KARAMITROS_2011.G_H} G(H2O2)=${KARAMITROS_2011.G_H2O2} G(H2)=${KARAMITROS_2011.G_H2}`,
    'data',
  );
}

function clearTable(): void {
  if (typeof document === 'undefined') return;
  const tb = document.getElementById('tb');
  if (tb) clearResults(tb);
  const logEl = document.getElementById('log');
  if (logEl) logEl.innerHTML = '';
}
