/**
 * Dose grid readback helpers + 2D projection renderer.
 *
 * Direct port of renderDoseProjection() from public/geant4dna.html. The
 * WGSL dose grid is a 128³ `atomic<u32>` grid of fixed-point ×100 units/eV.
 * We project along one axis, log-scale, zoom to the non-empty bounding box,
 * and paint with a magma-ish colormap.
 */

import { VC } from '../physics/constants';

/** Summed energy (eV) across the 128³ grid — used for E-conservation check. */
export function sumDoseEV(dose_arr: Uint32Array): number {
  let sum = 0;
  for (let i = 0; i < dose_arr.length; i++) sum += dose_arr[i];
  return sum / 100.0;
}

export type ProjectionAxis = 'z' | 'x';

export interface DoseProjectionOptions {
  /** Half-width of the simulation volume in nm (matches WGSL `p.box`). */
  box_nm: number;
  /** Bounding-box crop threshold (fraction of peak). Default 0.1 %. */
  bboxThreshold?: number;
  /** Pixel padding around the bounding box. Default 4 voxels. */
  pad?: number;
}

/**
 * Render a 2D projection of the 128³ dose voxel grid onto a canvas element.
 *
 *   axis='z' → sum over Z → XY image (row = Y, col = X)
 *   axis='x' → sum over X → YZ image (row = Z, col = Y)
 *
 * The projection is log-scaled to compress the ~6 orders of magnitude between
 * track-core dose and halo dose, and zoomed so the dose cluster fills the
 * canvas.
 */
export function renderDoseProjection(
  canvas: HTMLCanvasElement,
  dose: Uint32Array,
  axis: ProjectionAxis,
  opts: DoseProjectionOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const vc = VC;
  const box_nm = opts.box_nm;
  const vox_nm = (2 * box_nm) / vc;
  const proj = new Float32Array(vc * vc);

  let max_v = 0;
  let row_label: string;
  let col_label: string;

  if (axis === 'z') {
    row_label = 'Y';
    col_label = 'X';
    for (let y = 0; y < vc; y++) {
      for (let x = 0; x < vc; x++) {
        let s = 0;
        for (let z = 0; z < vc; z++) s += dose[(z * vc + y) * vc + x];
        proj[y * vc + x] = s;
        if (s > max_v) max_v = s;
      }
    }
  } else {
    row_label = 'Z';
    col_label = 'Y';
    for (let z = 0; z < vc; z++) {
      for (let y = 0; y < vc; y++) {
        let s = 0;
        for (let x = 0; x < vc; x++) s += dose[(z * vc + y) * vc + x];
        proj[z * vc + y] = s;
        if (s > max_v) max_v = s;
      }
    }
  }

  if (max_v === 0) {
    ctx.fillStyle = '#8888a0';
    ctx.font = '10px monospace';
    ctx.fillText('(no dose)', 10, 30);
    return;
  }

  // Bounding-box crop around non-empty voxels.
  const thr = max_v * (opts.bboxThreshold ?? 0.001);
  let r0 = vc;
  let r1 = -1;
  let c0 = vc;
  let c1 = -1;
  for (let r = 0; r < vc; r++) {
    for (let c = 0; c < vc; c++) {
      if (proj[r * vc + c] > thr) {
        if (r < r0) r0 = r;
        if (r > r1) r1 = r;
        if (c < c0) c0 = c;
        if (c > c1) c1 = c;
      }
    }
  }
  if (r1 < 0) {
    r0 = 0;
    r1 = vc - 1;
    c0 = 0;
    c1 = vc - 1;
  }

  // Pad and make square so aspect ratio is preserved.
  const pad = opts.pad ?? 4;
  r0 = Math.max(0, r0 - pad);
  r1 = Math.min(vc - 1, r1 + pad);
  c0 = Math.max(0, c0 - pad);
  c1 = Math.min(vc - 1, c1 + pad);
  const rh = r1 - r0 + 1;
  const cw = c1 - c0 + 1;
  const side = Math.max(rh, cw);
  const rc = Math.floor((r0 + r1) / 2);
  const cc = Math.floor((c0 + c1) / 2);
  const rs = Math.max(0, Math.min(vc - side, rc - (side >> 1)));
  const cs = Math.max(0, Math.min(vc - side, cc - (side >> 1)));

  // Log scale + magma-ish colormap.
  const log_max = Math.log(max_v + 1);
  const img = ctx.createImageData(side, side);
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const src = (rs + r) * vc + (cs + c);
      const v = rs + r < vc && cs + c < vc ? proj[src] : 0;
      const t = v > 0 ? Math.log(v + 1) / log_max : 0;
      let rr: number;
      let gg: number;
      let bb: number;
      if (t < 0.25) {
        const s = t / 0.25;
        rr = Math.round(s * 90);
        gg = Math.round(s * 10);
        bb = Math.round(s * 120 + 10);
      } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25;
        rr = Math.round(90 + s * 130);
        gg = Math.round(10 + s * 30);
        bb = Math.round(130 - s * 40);
      } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25;
        rr = Math.round(220 + s * 30);
        gg = Math.round(40 + s * 120);
        bb = Math.round(90 - s * 80);
      } else {
        const s = (t - 0.75) / 0.25;
        rr = Math.round(250 + s * 5);
        gg = Math.round(160 + s * 95);
        bb = Math.round(10 + s * 245);
      }
      const i = (r * side + c) * 4;
      img.data[i] = rr;
      img.data[i + 1] = gg;
      img.data[i + 2] = bb;
      img.data[i + 3] = 255;
    }
  }

  const off = document.createElement('canvas');
  off.width = side;
  off.height = side;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;
  offCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, W, H);

  // Overlay scale info.
  const crop_nm = side * vox_nm;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, 14);
  ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle = '#cfe';
  ctx.font = '10px monospace';
  ctx.fillText(`${col_label}↔${row_label}  ${crop_nm.toFixed(0)} nm`, 4, 10);
  ctx.fillText(`peak ${(max_v / 100).toFixed(0)} eV/col  log`, 4, H - 4);
}
