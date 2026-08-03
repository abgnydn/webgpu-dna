/**
 * Analytical chromatin geometry — a realistic DNA target to replace the
 * concentrated 21×21 straight-fibre grid whose track-core sampling inflates
 * indirect SSB (E34). Built from first principles (no external molecularDNA
 * GDML): B-DNA base pairs → nucleosome superhelix → 30 nm chromatin fibre.
 *
 * A base pair contributes two sugar-phosphate backbone sites (strand 0/1),
 * which is all the SSB/DSB scorer needs. Positions are in nm, nucleus-centred.
 *
 * Nucleosome (1KX5-like): 147 bp wound in ~1.65 left-handed superhelical turns,
 * superhelix radius R_SH = 4.18 nm, axial pitch P_SH = 2.39 nm/turn. The duplex
 * itself is B-DNA: rise 0.34 nm/bp, backbone radius r_bb = 1.0 nm, 10.5 bp/turn.
 */

export const BP_RISE = 0.34; // nm/bp along the duplex
export const R_BB = 1.0; // nm, backbone radius from the duplex axis
export const BP_PER_TURN = 10.5; // duplex helical twist
const NUC_BP = 147; // bp per nucleosome core
const R_SH = 4.18; // nm, superhelix radius (duplex axis → nucleosome axis)
const P_SH = 2.39; // nm/turn, superhelix axial pitch
const NUC_TURNS = 1.65; // superhelical turns over the 147 bp

/** A DNA target as flat backbone-atom coordinates for the scorer. */
export interface ChromatinTarget {
  n_bp: number; // total base pairs
  bx: Float32Array; // strand-0 backbone x (length n_bp)
  by: Float32Array;
  bz: Float32Array;
  b1x: Float32Array; // strand-1 backbone x
  b1y: Float32Array;
  b1z: Float32Array;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Superhelix duplex-axis centre of base pair i (0..NUC_BP-1) in the nucleosome
 * local frame (nucleosome axis = z), before any rigid placement.
 */
function superhelixCenter(i: number): V3 {
  const phi = (i * 2 * Math.PI * NUC_TURNS) / NUC_BP;
  const z = (P_SH * NUC_TURNS * i) / NUC_BP;
  return [R_SH * Math.cos(phi), R_SH * Math.sin(phi), z];
}

/**
 * Backbone sites of one nucleosome (147 bp), in the nucleosome local frame.
 * Returns per-bp strand-0 and strand-1 positions. The two backbones sit at
 * ±r_bb in the plane ⟂ to the local duplex tangent, rotated by the B-DNA twist.
 */
function nucleosomeBackbone(): { s0: V3[]; s1: V3[] } {
  const s0: V3[] = [];
  const s1: V3[] = [];
  for (let i = 0; i < NUC_BP; i++) {
    const c = superhelixCenter(i);
    // Duplex-axis tangent from a central difference along the superhelix.
    const cp = superhelixCenter(Math.min(i + 1, NUC_BP - 1));
    const cm = superhelixCenter(Math.max(i - 1, 0));
    const T = norm(sub(cp, cm));
    // Frame ⟂ to T: N from the radial direction (nucleosome axis → c),
    // orthogonalised against T; B = T × N.
    const radial: V3 = [c[0], c[1], 0];
    const rDotT = radial[0] * T[0] + radial[1] * T[1] + radial[2] * T[2];
    const N = norm([radial[0] - rDotT * T[0], radial[1] - rDotT * T[1], radial[2] - rDotT * T[2]]);
    const B = norm(cross(T, N));
    const psi = (i * 2 * Math.PI) / BP_PER_TURN; // B-DNA twist phase
    const off = (a: number): V3 => [
      c[0] + R_BB * (Math.cos(a) * N[0] + Math.sin(a) * B[0]),
      c[1] + R_BB * (Math.cos(a) * N[1] + Math.sin(a) * B[1]),
      c[2] + R_BB * (Math.cos(a) * N[2] + Math.sin(a) * B[2]),
    ];
    s0.push(off(psi));
    s1.push(off(psi + Math.PI));
  }
  return { s0, s1 };
}

/** 3×3 rotation (row-major) that maps the local disc axis +z onto `t` (unit). */
function rotAlignZ(t: V3): number[] {
  const [x, y, z] = t;
  if (z > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (z < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1]; // 180° about x
  // Rodrigues for rotating +z onto t: axis = z×t (normalised), angle from z·t.
  const ax = -y, ay = x, az = 0; // z×t = (-y, x, 0)
  const s = Math.hypot(ax, ay, az);
  const ux = ax / s, uy = ay / s, uz = az / s;
  const c = z, k = 1 - c; // cosθ = z·t = z-component
  return [
    c + ux * ux * k, ux * uy * k - uz * s, ux * uz * k + uy * s,
    uy * ux * k + uz * s, c + uy * uy * k, uy * uz * k - ux * s,
    uz * ux * k - uy * s, uz * uy * k + ux * s, c + uz * uz * k,
  ];
}
const apply = (R: number[], v: V3): V3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];

// 30 nm chromatin fibre (solenoid): nucleosomes on a helix, disc axes radial.
const FIB_R = 11.0; // nm, nucleosome-centre → fibre axis (fibre Ø ≈ 2(11+5) ≈ 32 nm)
const NUC_PER_TURN = 6;
const FIB_PITCH = 11.0; // nm/turn axial

/**
 * Build a chromatin fibre of `nNuc` nucleosomes as a solenoid, centred at the
 * origin. Realistic folded DNA (vs the straight-fibre grid) for the re-scoring
 * experiment. ~147 bp/nucleosome; linker DNA is omitted (a solenoid-of-cores
 * approximation, sufficient for the OH/ionisation-proximity comparison).
 */
export function buildChromatinFibre(nNuc: number): ChromatinTarget {
  const { s0, s1 } = nucleosomeBackbone();
  const perNuc = s0.length;
  const n = nNuc * perNuc;
  const bx = new Float32Array(n), by = new Float32Array(n), bz = new Float32Array(n);
  const b1x = new Float32Array(n), b1y = new Float32Array(n), b1z = new Float32Array(n);
  const zTop = ((nNuc - 1) * FIB_PITCH) / NUC_PER_TURN;
  let w = 0;
  for (let k = 0; k < nNuc; k++) {
    const theta = (k * 2 * Math.PI) / NUC_PER_TURN;
    const zax = (k * FIB_PITCH) / NUC_PER_TURN - zTop / 2; // centre the fibre on z
    const C: V3 = [FIB_R * Math.cos(theta), FIB_R * Math.sin(theta), zax];
    const R = rotAlignZ([Math.cos(theta), Math.sin(theta), 0]); // disc axis → radial
    for (let i = 0; i < perNuc; i++, w++) {
      const p0 = apply(R, s0[i]); const p1 = apply(R, s1[i]);
      bx[w] = p0[0] + C[0]; by[w] = p0[1] + C[1]; bz[w] = p0[2] + C[2];
      b1x[w] = p1[0] + C[0]; b1y[w] = p1[1] + C[1]; b1z[w] = p1[2] + C[2];
    }
  }
  return { n_bp: n, bx, by, bz, b1x, b1y, b1z };
}

/**
 * Build a single nucleosome target (147 bp), centred at the origin. First real,
 * testable geometry unit; the fibre/nucleus assembly stacks these.
 */
export function buildNucleosome(): ChromatinTarget {
  const { s0, s1 } = nucleosomeBackbone();
  const n = s0.length;
  // Centre on the mean backbone position.
  const mean: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k] += (s0[i][k] + s1[i][k]) / (2 * n);
  const bx = new Float32Array(n), by = new Float32Array(n), bz = new Float32Array(n);
  const b1x = new Float32Array(n), b1y = new Float32Array(n), b1z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    bx[i] = s0[i][0] - mean[0]; by[i] = s0[i][1] - mean[1]; bz[i] = s0[i][2] - mean[2];
    b1x[i] = s1[i][0] - mean[0]; b1y[i] = s1[i][1] - mean[1]; b1z[i] = s1[i][2] - mean[2];
  }
  return { n_bp: n, bx, by, bz, b1x, b1y, b1z };
}
