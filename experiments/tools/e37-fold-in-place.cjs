// E37 — "folded-in-place, matched-length" chromatin vs grid, the rigorous design.
// Three DNA geometries on the SAME central axis lattice (identical placement =>
// identical track-dose sampling; only the FOLD differs):
//   LINE     — one straight B-DNA duplex per axis (baseline)
//   BUNDLE   — 19 hex-packed straight duplexes per axis (30 nm girth, no winding)
//   SOLENOID — a wound nucleosome chromatin fibre per axis (full folding)
// dR = ratio_solenoid/ratio_line is the folding effect; bundle/line = girth,
// solenoid/bundle = pure winding. Ratio is intra-geometry so bp need not match.
const fs = require('fs');
const R = '/Users/ahmetbarisgunaydin/dev/webgpu-dna';
const E_LOW = 5, E_HIGH = 37.5, R_DIR = 0.29, R_IND = 1.0, P_IND = 0.13, r_bb = 1.0;
const SP = 150, XSPAN = 400, RISE = 0.34, TWIST = 2 * Math.PI / 10.5;
const AXES_HALF = 3; // 7x7 central axes (±3)

// --- nucleosome backbone (local, disc axis = z) ---
const NUC_BP = 147, R_SH = 4.18, P_SH = 2.39, NUC_TURNS = 1.65;
function nucBackbone() {
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const C = (i) => { const p = i * 2 * Math.PI * NUC_TURNS / NUC_BP, z = P_SH * NUC_TURNS * i / NUC_BP; return [R_SH * Math.cos(p), R_SH * Math.sin(p), z]; };
  const s0 = [], s1 = [];
  for (let i = 0; i < NUC_BP; i++) {
    const c = C(i), cp = C(Math.min(i + 1, NUC_BP - 1)), cm = C(Math.max(i - 1, 0));
    const T = nrm([cp[0] - cm[0], cp[1] - cm[1], cp[2] - cm[2]]);
    const rad = [c[0], c[1], 0], dd = rad[0] * T[0] + rad[1] * T[1];
    const N = nrm([rad[0] - dd * T[0], rad[1] - dd * T[1], rad[2] - dd * T[2]]), B = nrm(crs(T, N));
    const psi = i * TWIST;
    const off = (a) => [c[0] + r_bb * (Math.cos(a) * N[0] + Math.sin(a) * B[0]), c[1] + r_bb * (Math.cos(a) * N[1] + Math.sin(a) * B[1]), c[2] + r_bb * (Math.cos(a) * N[2] + Math.sin(a) * B[2])];
    s0.push(off(psi)); s1.push(off(psi + Math.PI));
  }
  return { s0, s1 };
}
// rotation mapping local +z onto unit t
function rotZ(t) {
  const [x, y, z] = t;
  if (z > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (z < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const ax = -y, ay = x, s = Math.hypot(ax, ay), ux = ax / s, uy = ay / s, c = z, k = 1 - c;
  return [c + ux * ux * k, ux * uy * k, uy * s, uy * ux * k, c + uy * uy * k, -ux * s, -uy * s, ux * s, c];
}
const ap = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

function axes() { const a = []; for (let i = -AXES_HALF; i <= AXES_HALF; i++) for (let j = -AXES_HALF; j <= AXES_HALF; j++) a.push([i * SP, j * SP]); return a; }

// LINE: straight duplex along x at (fy,fz)
function addLine(A, fy, fz) {
  for (let x = -XSPAN, b = 0; x <= XSPAN; x += RISE, b++) {
    const phi = b * TWIST;
    A.ax.push(x, x); A.ay.push(fy + r_bb * Math.cos(phi), fy + r_bb * Math.cos(phi + Math.PI));
    A.az.push(fz + r_bb * Math.sin(phi), fz + r_bb * Math.sin(phi + Math.PI));
  }
}
// hex offsets within r<15nm (rings at 5,10,15 nm)
function hexOffsets() {
  const o = [[0, 0]];
  for (const r of [5, 10, 15]) { const n = Math.round(2 * Math.PI * r / 5); for (let k = 0; k < n; k++) o.push([r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n)]); }
  return o;
}
function addBundle(A, fy, fz) { for (const [dy, dz] of hexOffsets()) addLine(A, fy + dy, fz + dz); }
// SOLENOID: chromatin fibre with solenoid axis along x at (fy,fz)
function addSolenoid(A, fy, fz, s0, s1) {
  const FIB_R = 11, NPT = 6, PITCH = 11;
  const nNuc = Math.floor(2 * XSPAN / (PITCH / NPT));
  for (let k = 0; k < nNuc; k++) {
    const th = k * 2 * Math.PI / NPT, xax = -XSPAN + k * PITCH / NPT;
    // nucleosome centre on solenoid around the x-axis; disc axis radial in (y,z)
    const cy = fy + FIB_R * Math.cos(th), cz = fz + FIB_R * Math.sin(th);
    const Rn = rotZ([0, Math.cos(th), Math.sin(th)]); // local z -> radial (0,cosθ,sinθ)
    for (let i = 0; i < NUC_BP; i++) {
      for (const p of [s0[i], s1[i]]) {
        const q = ap(Rn, p);
        A.ax.push(q[0] + xax); A.ay.push(q[1] + cy); A.az.push(q[2] + cz);
      }
    }
  }
}
function pack(A) { return { ax: new Float32Array(A.ax), ay: new Float32Array(A.ay), az: new Float32Array(A.az) }; }

// --- spatial hash + scoring (same as E36) ---
function buildHash(at, cell) { const H = new Map(), inv = 1 / cell, key = (x, y, z) => x + y * 4001 + z * 4001 * 4001; for (let i = 0; i < at.ax.length; i++) { const cx = Math.floor(at.ax[i] * inv) + 2000, cy = Math.floor(at.ay[i] * inv) + 2000, cz = Math.floor(at.az[i] * inv) + 2000, k = key(cx, cy, cz); let a = H.get(k); if (!a) { a = []; H.set(k, a); } a.push(i); } return { H, inv, key }; }
function near(at, h, x, y, z, R2) { const { H, inv, key } = h, cx = Math.floor(x * inv) + 2000, cy = Math.floor(y * inv) + 2000, cz = Math.floor(z * inv) + 2000; let bd = Infinity, bi = -1; for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++)for (let dz = -1; dz <= 1; dz++) { const a = H.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue; for (const i of a) { const d = (at.ax[i] - x) ** 2 + (at.ay[i] - y) ** 2 + (at.az[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } } } return bd <= R2 ? bi : -1; }
function score(at, rb, re, rd, rn, oh, ohN) {
  const ns = at.ax.length, Eacc = new Float32Array(ns), K = new Int32Array(ns), h = buildHash(at, 2.0);
  let lx = NaN, ly = NaN, lz = NaN, ird = 0;
  for (let i = 0; i < rn; i++) { const sp = Math.round(rb[i * 4 + 3]) % 8; if (sp === 1 || sp === 5 || sp === 7) continue; const x = rd[i * 4], y = rd[i * 4 + 1], z = rd[i * 4 + 2]; if (x === lx && y === ly && z === lz) continue; lx = x; ly = y; lz = z; const bi = near(at, h, x, y, z, R_DIR * R_DIR); if (bi >= 0) { Eacc[bi] += re[i]; ird++; } }
  let dir = 0; const es = E_HIGH - E_LOW; for (let s = 0; s < ns; s++) { const e = Eacc[s]; if (e > E_LOW) dir += e >= E_HIGH ? 1 : (e - E_LOW) / es; }
  let iri = 0; for (let i = 0; i < ohN; i++) { const bi = near(at, h, oh[i * 3], oh[i * 3 + 1], oh[i * 3 + 2], R_IND * R_IND); if (bi >= 0) { K[bi]++; iri++; } }
  let ind = 0; for (let s = 0; s < ns; s++) { const k = K[s]; if (k > 0) ind += 1 - (1 - P_IND) ** k; }
  return { dir, ind, ratio: ind / dir, ird, iri, atoms: ns, capture: iri / ird };
}

// --- main ---
const d = R + '/dumps';
const g = (f, sz) => { const b = fs.readFileSync(d + '/' + f); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const rb = g('rad_E10000_N4096.bin'), rn = rb.length / 4, re = g('rade_E10000_N4096.bin'), rd = g('raddep_E10000_N4096.bin'), oh = g('oh_survivors_E10000.bin'), ohN = oh.length / 3;
const AX = axes(); const { s0, s1 } = nucBackbone();
console.log(`axes=${AX.length} (7x7) xspan=±${XSPAN}nm  radicals=${rn} OH=${ohN}\n`);
const build = (fn) => { const A = { ax: [], ay: [], az: [] }; for (const [fy, fz] of AX) fn(A, fy, fz); return pack(A); };
const geoms = {
  LINE: build((A, fy, fz) => addLine(A, fy, fz)),
  BUNDLE: build((A, fy, fz) => addBundle(A, fy, fz)),
  SOLENOID: build((A, fy, fz) => addSolenoid(A, fy, fz, s0, s1)),
};
const res = {};
for (const [name, at] of Object.entries(geoms)) { const r = score(at, rb, re, rd, rn, oh, ohN); res[name] = r; console.log(`${name.padEnd(9)} atoms=${(r.atoms / 1e6).toFixed(1)}M  direct=${r.dir.toFixed(1)} indirect=${r.ind.toFixed(1)} ratio=${r.ratio.toFixed(2)}  capture(ind/dir in_reach)=${r.capture.toFixed(2)} [dir ${r.ird}/ind ${r.iri}]`); }
console.log(`\ndR (solenoid/line) = ${(res.SOLENOID.ratio / res.LINE.ratio).toFixed(3)}   girth (bundle/line) = ${(res.BUNDLE.ratio / res.LINE.ratio).toFixed(3)}   winding (solenoid/bundle) = ${(res.SOLENOID.ratio / res.BUNDLE.ratio).toFixed(3)}`);
