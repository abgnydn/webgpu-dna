/**
 * CPU IRT (Independent Reaction Times) chemistry.
 *
 * Two variants:
 *  - `irtChemistry()` — handoff from the GPU grid chemistry at t = 10 ns.
 *    Uses contact probability `pc`, cutoff = hash radius (4.5 nm).
 *  - `runChemistryIRT()` — standalone CPU post-processing over the full
 *    radical cloud with Onsager screening. Fallback when the worker is
 *    unavailable. (The production path uses public/irt-worker.js which is
 *    a self-contained Worker — see worker.ts.)
 */

import { IRT_D, IRT_REACTIONS } from '../physics/constants';
import { findReaction, erfcInv, sampleIRT } from './reactions';
import type { ChemCheckpoint, ChemResult, LogFn } from '../physics/types';

/** Simple binary min-heap over tuples whose first element is the priority. */
export class MinHeap<T extends [number, ...unknown[]]> {
  data: T[] = [];
  get size(): number { return this.data.length; }
  push(val: T): void {
    this.data.push(val);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p][0] <= this.data[i][0]) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop() as T;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      for (;;) {
        let s = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < this.data.length && this.data[l][0] < this.data[s][0]) s = l;
        if (r < this.data.length && this.data[r][0] < this.data[s][0]) s = r;
        if (s === i) break;
        [this.data[s], this.data[i]] = [this.data[i], this.data[s]];
        i = s;
      }
    }
    return top;
  }
}

export interface IrtHandoffResult {
  n_alive: number;
  n_pairs: number;
  n_reacted: number;
  prod_H2O2: number;
  prod_H2: number;
  alive_counts: [number, number, number]; // OH, eaq, H
}

/**
 * Handoff IRT — runs the long-time portion (10 ns → 1 μs by default) from
 * alive radical positions + species + alive flags. Uses the intra-track
 * cutoff (4.5 nm, matches the GPU spatial-hash search radius).
 */
export function irtChemistry(
  pos: Float32Array,
  alive_in: Uint32Array,
  n_total: number,
  t_start_ns: number,
  t_end_ns: number,
): IrtHandoffResult {
  const dt_remaining = t_end_ns - t_start_ns;
  const CUTOFF = 4.5;
  const CUTOFF2 = CUTOFF * CUTOFF;

  const alive = new Uint8Array(n_total);
  const species = new Int8Array(n_total);
  const px = new Float32Array(n_total);
  const py = new Float32Array(n_total);
  const pz = new Float32Array(n_total);
  let n_alive = 0;
  const compact = new Int32Array(n_total);
  compact.fill(-1);
  for (let i = 0; i < n_total; i++) {
    if (alive_in[i] === 0) continue;
    const sp = Math.round(pos[i * 4 + 3]);
    if (sp < 0 || sp > 2) continue;
    compact[i] = n_alive;
    species[n_alive] = sp;
    px[n_alive] = pos[i * 4 + 0];
    py[n_alive] = pos[i * 4 + 1];
    pz[n_alive] = pos[i * 4 + 2];
    alive[n_alive] = 1;
    n_alive++;
  }

  const CELL = 1.5;
  const inv_cell = 1 / CELL;
  const IRT_HASH = 1 << 20;   // 1M buckets
  const cell_head_js = new Int32Array(IRT_HASH);
  const next_idx_js = new Int32Array(n_alive);
  cell_head_js.fill(-1);

  const hash3 = (ix: number, iy: number, iz: number): number =>
    (((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) >>> 0) % IRT_HASH;

  for (let i = 0; i < n_alive; i++) {
    const cx = Math.floor(px[i] * inv_cell);
    const cy = Math.floor(py[i] * inv_cell);
    const cz = Math.floor(pz[i] * inv_cell);
    const h = hash3(cx, cy, cz);
    next_idx_js[i] = cell_head_js[h];
    cell_head_js[h] = i;
  }

  type Event = [t: number, i: number, j: number, prod: number];
  const heap = new MinHeap<Event>();
  let n_pairs = 0;

  const samplePair = (i: number, j: number): void => {
    const si = species[i];
    const sj = species[j];
    const a = Math.min(si, sj);
    const b = Math.max(si, sj);
    let rxn: readonly [number, number, number, number, number] | undefined;
    for (const r of IRT_REACTIONS) if (r[0] === a && r[1] === b) { rxn = r; break; }
    if (!rxn) return;
    const R = rxn[2];
    const pc = rxn[3];
    const prod = rxn[4];
    const D_rel = IRT_D[si] + IRT_D[sj];
    const dx = px[i] - px[j];
    const dy = py[i] - py[j];
    const dz = pz[i] - pz[j];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > CUTOFF2) return;
    const d = Math.sqrt(d2);
    if (d <= R) {
      if (Math.random() < pc) heap.push([t_start_ns + 0.001 * Math.random(), i, j, prod]);
      n_pairs++;
      return;
    }
    const u = Math.random();
    if (u > R / d) { n_pairs++; return; }
    const u_adj = u / pc;
    if (u_adj > R / d) { n_pairs++; return; }
    const arg = u_adj * d / R;
    if (arg >= 1.0) { n_pairs++; return; }
    const z = erfcInv(arg);
    if (z <= 0) { n_pairs++; return; }
    const t_fp = (d - R) * (d - R) / (4 * D_rel * z * z);
    if (t_fp > dt_remaining) { n_pairs++; return; }
    heap.push([t_start_ns + t_fp, i, j, prod]);
    n_pairs++;
  };

  for (let i = 0; i < n_alive; i++) {
    if (alive[i] === 0) continue;
    const ix = Math.floor(px[i] * inv_cell);
    const iy = Math.floor(py[i] * inv_cell);
    const iz = Math.floor(pz[i] * inv_cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = hash3(ix + dx, iy + dy, iz + dz);
          let j = cell_head_js[h];
          while (j >= 0) {
            if (j > i) samplePair(i, j);
            j = next_idx_js[j];
          }
        }
      }
    }
  }

  let n_reacted = 0;
  let prod_H2O2 = 0;
  let prod_H2 = 0;
  const alive_counts: [number, number, number] = [0, 0, 0];
  while (heap.size > 0) {
    const evt = heap.pop();
    if (!evt) break;
    const [t, i, j, prod] = evt;
    if (t > t_end_ns) break;
    if (alive[i] === 0 || alive[j] === 0) continue;
    alive[i] = 0;
    alive[j] = 0;
    n_reacted++;
    if (prod === 1) prod_H2O2++;
    else if (prod === 2) prod_H2++;
    else if (prod === 3) {
      const i_eaq = species[i] === 1 ? i : j;
      species[i_eaq] = 2;
      alive[i_eaq] = 1;
    }
  }

  for (let i = 0; i < n_alive; i++) {
    if (alive[i] === 1) alive_counts[species[i]]++;
  }

  return { n_alive, n_pairs, n_reacted, prod_H2O2, prod_H2, alive_counts };
}

/**
 * Standalone CPU IRT (fallback for when the Web Worker is unavailable).
 * Onsager-screened Smoluchowski first-passage time over the full radical
 * cloud with a 15 nm cutoff. Deterministic subsample via stride so we
 * don't blow up on 3 M+ radicals.
 */
export async function runChemistryIRT(
  rad_buf_f32: Float32Array,
  rad_n: number,
  n_therm: number,
  E_eV: number,
  log?: LogFn,
): Promise<ChemResult> {
  const t0 = performance.now();
  const N = Math.min(rad_n, 2_000_000);

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  const species = new Int32Array(N);
  const alive = new Uint8Array(N).fill(1);

  const stride = Math.max(1, Math.floor(rad_n / N));
  for (let i = 0; i < N; i++) {
    const si = (i * stride) % rad_n;
    px[i] = rad_buf_f32[si * 4];
    py[i] = rad_buf_f32[si * 4 + 1];
    pz[i] = rad_buf_f32[si * 4 + 2];
    species[i] = Math.round(rad_buf_f32[si * 4 + 3]);
    if (species[i] < 0 || species[i] > 3) alive[i] = 0;
  }

  // Geant4 WaterDissociationDisplacer thermalization.
  const sigmas = [0.462, 1.764, 1.309]; // OH, eaq, H (σ₁D per axis, nm)
  const f_clf = Math.SQRT2;
  for (let i = 0; i < N; i++) {
    if (!alive[i]) continue;
    const s = species[i];
    let sigma: number;
    if (s <= 2) sigma = sigmas[s];
    else if (s === 3) sigma = Math.random() < 0.5 ? 0.462 : 0;
    else continue;
    if (sigma > 0) {
      const clf6 = (): number =>
        (Math.random() + Math.random() + Math.random() + Math.random() +
         Math.random() + Math.random() - 3) * f_clf;
      px[i] += sigma * clf6();
      py[i] += sigma * clf6();
      pz[i] += sigma * clf6();
    }
  }

  // Spatial hash.
  const CELL = 5.0;
  const hash = new Map<string, number[]>();
  const cellKey = (x: number, y: number, z: number): string =>
    `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (let i = 0; i < N; i++) {
    if (!alive[i]) continue;
    const k = cellKey(px[i], py[i], pz[i]);
    let bucket = hash.get(k);
    if (!bucket) { bucket = []; hash.set(k, bucket); }
    bucket.push(i);
  }

  type Evt = { t: number; i: number; j: number };
  const heap: Evt[] = [];
  const heapPush = (item: Evt): void => {
    heap.push(item);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].t <= heap[c].t) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const heapPop = (): Evt | undefined => {
    if (heap.length <= 1) return heap.pop();
    const top = heap[0];
    heap[0] = heap.pop() as Evt;
    let p = 0;
    for (;;) {
      let s = p;
      const l = 2 * p + 1;
      const r = 2 * p + 2;
      if (l < heap.length && heap[l].t < heap[s].t) s = l;
      if (r < heap.length && heap[r].t < heap[s].t) s = r;
      if (s === p) break;
      [heap[p], heap[s]] = [heap[s], heap[p]];
      p = s;
    }
    return top;
  };

  log?.(`  IRT: ${N} radicals, building pair table...`, 'data');

  // Build pair list.
  const IRT_D_JS = [2.2, 4.9, 7.0, 9.0];
  const IRT_RXN = [
    [0, 0, 0.44, 0,    1],
    [0, 1, 0.57, 0,    0],
    [0, 2, 0.45, 0,    0],
    [1, 1, 0.54, 0,    2],
    [1, 2, 0.61, 0,    2],
    [1, 3, 0.47, -0.71, 3], // Onsager rc SIGNED negative (attractive eaq+H3O+)
    [2, 2, 0.34, 0,    2],
  ];
  const findRxn = (sa: number, sb: number): number[] | null => {
    const a = Math.min(sa, sb);
    const b = Math.max(sa, sb);
    for (const r of IRT_RXN) if (r[0] === a && r[1] === b) return r;
    return null;
  };

  let n_pairs = 0;
  const yieldEvery = 200_000;
  for (let i = 0; i < N; i++) {
    if (i > 0 && i % yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
    if (!alive[i]) continue;
    const si = species[i];
    const Di = IRT_D_JS[si] ?? 0;
    if (Di === 0) continue;
    const cx = Math.floor(px[i] / CELL);
    const cy = Math.floor(py[i] / CELL);
    const cz = Math.floor(pz[i] / CELL);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${cx + dx},${cy + dy},${cz + dz}`;
          const bucket = hash.get(k);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            if (!alive[j]) continue;
            const sj = species[j];
            const rxn = findRxn(si, sj);
            if (!rxn) continue;
            const ddx = px[i] - px[j];
            const ddy = py[i] - py[j];
            const ddz = pz[i] - pz[j];
            const r0 = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (r0 > 15) continue;
            const Dj = IRT_D_JS[sj] ?? 0;
            const t = sampleIRT(r0, rxn[2], rxn[3], Di + Dj);
            if (t >= 0 && t < 1000) {
              heapPush({ t, i, j });
              n_pairs++;
            }
          }
        }
      }
    }
  }
  log?.(`  IRT: ${n_pairs} reactive pairs queued`, 'data');

  // Process in time order, record checkpoints.
  let prod_H2O2 = 0;
  let prod_H2 = 0;
  let n_reacted = 0;
  const checkpoints = [0.001, 0.01, 0.1, 1, 10, 100, 1000];
  const labels = ['1 ps', '10 ps', '100 ps', '1 ns', '10 ns', '100 ns', '1 μs'];
  const timeline: ChemCheckpoint[] = [];
  let cp_idx = 0;

  const countSpecies = (): ChemCheckpoint => {
    let oh = 0;
    let eaq = 0;
    let h = 0;
    for (let i = 0; i < N; i++) {
      if (!alive[i]) continue;
      if (species[i] === 0) oh++;
      else if (species[i] === 1) eaq++;
      else if (species[i] === 2) h++;
    }
    const dep = n_therm * E_eV * (N / rad_n);
    const per100 = dep / 100;
    return {
      label: labels[cp_idx],
      t_ns: checkpoints[cp_idx],
      G_OH: per100 > 0 ? oh / per100 : 0,
      G_eaq: per100 > 0 ? eaq / per100 : 0,
      G_H: per100 > 0 ? h / per100 : 0,
      G_H2O2: per100 > 0 ? prod_H2O2 / per100 : 0,
      G_H2: per100 > 0 ? prod_H2 / per100 : 0,
    };
  };

  while (heap.length > 0) {
    const evt = heapPop();
    if (!evt) break;
    while (cp_idx < checkpoints.length && evt.t >= checkpoints[cp_idx]) {
      const g = countSpecies();
      timeline.push(g);
      log?.(`  ${labels[cp_idx]} ${g.G_OH.toFixed(3)} ${g.G_eaq.toFixed(3)} ${g.G_H.toFixed(3)} ${g.G_H2O2.toFixed(3)} ${g.G_H2.toFixed(3)}`, 'data');
      cp_idx++;
    }
    if (!alive[evt.i] || !alive[evt.j]) continue;
    const si = species[evt.i];
    const sj = species[evt.j];
    const rxn = findRxn(si, sj);
    if (!rxn) continue;
    alive[evt.i] = 0;
    alive[evt.j] = 0;
    n_reacted++;
    const prod = rxn[4];
    if (prod === 1) prod_H2O2++;
    else if (prod === 2) prod_H2++;
    else if (prod === 3) {
      const i_eaq = si === 1 ? evt.i : evt.j;
      species[i_eaq] = 2;
      alive[i_eaq] = 1;
    }
  }

  while (cp_idx < checkpoints.length) {
    const g = countSpecies();
    timeline.push(g);
    log?.(`  ${labels[cp_idx]} ${g.G_OH.toFixed(3)} ${g.G_eaq.toFixed(3)} ${g.G_H.toFixed(3)} ${g.G_H2O2.toFixed(3)} ${g.G_H2.toFixed(3)}`, 'data');
    cp_idx++;
  }

  const t_wall = performance.now() - t0;
  log?.(`  IRT chemistry: ${n_reacted} reactions in ${(t_wall / 1000).toFixed(1)}s`, 'data');

  return { chem_n: N, t_wall, timeline, chem_pos_final: null, chem_alive_final: null };
}

// Silence unused import linter in builds that skip this path.
void findReaction;
