// E40 — the EXPLICIT OH+deoxyribose channel (E39) scored against FOLDED CHROMATIN
// (E37 geometries). The explicit competition is REPLAYED offline: the worker
// exported per-OH (x,y,z,t_birth,t_death) via collectOHrec (pure-radical death
// times, explicitDna off); here an OH damages a sugar iff it would react with it
// BEFORE its radical death — t_birth + t_firstpassage(r0) < t_death — using the
// same sampleIRT_type0 first-passage the worker uses (σ from k=2.5e9 Buxton).
//
// Unlike E38's saturating encounter model (dR≈1.04), the explicit channel does
// NOT saturate, so folding may be a real lever again. Three geometries on the
// SAME central axis lattice (byte-identical placement; only the fold differs):
//   LINE / BUNDLE (30nm girth) / SOLENOID (wound chromatin fibre).
// Plus a full 21×21 straight-LINE control to validate the replay vs the worker's
// on-line explicit ratio (E39: 1.15 @3keV, 1.66 @10keV).
//
// Usage: node e40-explicit-chromatin.cjs <E_eV> <ohrec.bin>
const fs = require('fs');
const R = '/Users/ahmetbarisgunaydin/dev/webgpu-dna';
const E_LOW = 5, E_HIGH = 37.5, R_DIR = 0.29, R_IND = 1.0, P_IND = 0.13, r_bb = 1.0;
const SP = 150, XSPAN = 400, RISE = 0.34, TWIST = 2 * Math.PI / 10.5;

const E_eV = parseInt(process.argv[2] || '10000', 10);
const OHREC = process.argv[3];

// --- first-passage (mirror irt-worker.js sampleIRT_type0 + erfcinv) ---
const K_CONV = 1e24 / (6.022e23 * 1e9);
const D_OH = 2.2, SIG = (2.5e9 * K_CONV) / (4 * Math.PI * D_OH); // 0.1502 nm
function erfcinv(x) {
  if (x <= 0 || x >= 2) return 0;
  const p = x > 1 ? 2 - x : x;
  const t = Math.sqrt(-2 * Math.log(p / 2));
  let y = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) /
    (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  y *= 0.7071067811865475;
  return x > 1 ? -y : y;
}
// seeded RNG (mulberry32) so the replay is reproducible
let RNG = 0x40e40e40 >>> 0;
const rand = () => { RNG = (RNG + 0x6d2b79f5) >>> 0; let t = RNG; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function fpTime(r0) { // sampleIRT_type0(r0, SIG, rc=0, D_OH)
  if (r0 <= SIG) return 0;
  const Winf = SIG / r0;
  const U = rand();
  if (U <= 0 || U >= Winf) return -1;   // OH escapes the sugar
  const ei = erfcinv(r0 * U / SIG);
  if (Math.abs(ei) < 1e-10) return -1;
  const dr = r0 - SIG;
  return 0.25 * dr * dr / (D_OH * ei * ei);
}

// --- nucleosome backbone (local, disc axis = z) — identical to E37 ---
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
function rotZ(t) {
  const [x, y, z] = t;
  if (z > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (z < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const ax = -y, ay = x, s = Math.hypot(ax, ay), ux = ax / s, uy = ay / s, c = z, k = 1 - c;
  return [c + ux * ux * k, ux * uy * k, uy * s, uy * ux * k, c + uy * uy * k, -ux * s, -uy * s, ux * s, c];
}
const ap = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
function axes(half) { const a = []; for (let i = -half; i <= half; i++) for (let j = -half; j <= half; j++) a.push([i * SP, j * SP]); return a; }
function addLine(A, fy, fz) {
  for (let x = -XSPAN, b = 0; x <= XSPAN; x += RISE, b++) {
    const phi = b * TWIST;
    A.ax.push(x, x); A.ay.push(fy + r_bb * Math.cos(phi), fy + r_bb * Math.cos(phi + Math.PI));
    A.az.push(fz + r_bb * Math.sin(phi), fz + r_bb * Math.sin(phi + Math.PI));
  }
}
function hexOffsets() {
  const o = [[0, 0]];
  for (const r of [5, 10, 15]) { const n = Math.round(2 * Math.PI * r / 5); for (let k = 0; k < n; k++) o.push([r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n)]); }
  return o;
}
function addBundle(A, fy, fz) { for (const [dy, dz] of hexOffsets()) addLine(A, fy + dy, fz + dz); }
function addSolenoid(A, fy, fz, s0, s1) {
  const FIB_R = 11, NPT = 6, PITCH = 11;
  const nNuc = Math.floor(2 * XSPAN / (PITCH / NPT));
  for (let k = 0; k < nNuc; k++) {
    const th = k * 2 * Math.PI / NPT, xax = -XSPAN + k * PITCH / NPT;
    const cy = fy + FIB_R * Math.cos(th), cz = fz + FIB_R * Math.sin(th);
    const Rn = rotZ([0, Math.cos(th), Math.sin(th)]);
    for (let i = 0; i < NUC_BP; i++) for (const p of [s0[i], s1[i]]) { const q = ap(Rn, p); A.ax.push(q[0] + xax); A.ay.push(q[1] + cy); A.az.push(q[2] + cz); }
  }
}
function pack(A) { return { ax: new Float32Array(A.ax), ay: new Float32Array(A.ay), az: new Float32Array(A.az) }; }
function buildHash(at, cell) { const H = new Map(), inv = 1 / cell, key = (x, y, z) => x + y * 4001 + z * 4001 * 4001; for (let i = 0; i < at.ax.length; i++) { const cx = Math.floor(at.ax[i] * inv) + 2000, cy = Math.floor(at.ay[i] * inv) + 2000, cz = Math.floor(at.az[i] * inv) + 2000, k = key(cx, cy, cz); let a = H.get(k); if (!a) { a = []; H.set(k, a); } a.push(i); } return { H, inv, key }; }
function nearD(at, h, x, y, z, R2) { const { H, inv, key } = h, cx = Math.floor(x * inv) + 2000, cy = Math.floor(y * inv) + 2000, cz = Math.floor(z * inv) + 2000; let bd = Infinity, bi = -1; for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++)for (let dz = -1; dz <= 1; dz++) { const a = H.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue; for (const i of a) { const d = (at.ax[i] - x) ** 2 + (at.ay[i] - y) ** 2 + (at.az[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } } } return bd <= R2 ? { bi, r0: Math.sqrt(bd) } : { bi: -1, r0: Infinity }; }

// direct SSB (accumulated-volume threshold ramp) — identical to E37
function scoreDirect(at, h, rb, re, rd, rn) {
  const ns = at.ax.length, Eacc = new Float32Array(ns);
  let lx = NaN, ly = NaN, lz = NaN, ird = 0;
  for (let i = 0; i < rn; i++) { const sp = Math.round(rb[i * 4 + 3]) % 8; if (sp === 1 || sp === 5 || sp === 7) continue; const x = rd[i * 4], y = rd[i * 4 + 1], z = rd[i * 4 + 2]; if (x === lx && y === ly && z === lz) continue; lx = x; ly = y; lz = z; const q = nearD(at, h, x, y, z, R_DIR * R_DIR); if (q.bi >= 0) { Eacc[q.bi] += re[i]; ird++; } }
  let dir = 0; const es = E_HIGH - E_LOW; for (let s = 0; s < ns; s++) { const e = Eacc[s]; if (e > E_LOW) dir += e >= E_HIGH ? 1 : (e - E_LOW) / es; }
  return { dir, ird };
}
// EXPLICIT indirect: OH reacts with nearest sugar iff tb + fp(r0) < td (competition replay)
function scoreExplicit(at, h, rec, recN) {
  const ns = at.ax.length, K = new Int32Array(ns);
  let react = 0, inReach = 0;
  for (let i = 0; i < recN; i++) {
    const x = rec[i * 5], y = rec[i * 5 + 1], z = rec[i * 5 + 2], tb = rec[i * 5 + 3], td = rec[i * 5 + 4];
    const q = nearD(at, h, x, y, z, 6.25); // search nearest sugar within 2.5nm
    if (q.bi < 0) continue;
    inReach++;
    const t = fpTime(q.r0);
    if (t < 0) continue;            // OH escapes the sugar
    if (tb + t < td) { K[q.bi]++; react++; } // reacts with sugar before its radical death
  }
  let ind = 0; for (let s = 0; s < ns; s++) { const k = K[s]; if (k > 0) ind += 1 - (1 - P_IND) ** k; }
  return { ind, react, inReach };
}
// SURVIVAL indirect (E37-style, for context): OHs that survive (td large) within R_IND
function scoreSurvival(at, h, rec, recN) {
  const ns = at.ax.length, K = new Int32Array(ns);
  let iri = 0;
  for (let i = 0; i < recN; i++) { if (rec[i * 5 + 4] < 1e8) continue; const q = nearD(at, h, rec[i * 5], rec[i * 5 + 1], rec[i * 5 + 2], R_IND * R_IND); if (q.bi >= 0) { K[q.bi]++; iri++; } }
  let ind = 0; for (let s = 0; s < ns; s++) { const k = K[s]; if (k > 0) ind += 1 - (1 - P_IND) ** k; }
  return { ind, iri };
}

// --- main ---
const d = R + '/dumps';
const g = (f) => { const b = fs.readFileSync(d + '/' + f); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const rb = g(`rad_E${E_eV}_N4096.bin`), rn = rb.length / 4, re = g(`rade_E${E_eV}_N4096.bin`), rd = g(`raddep_E${E_eV}_N4096.bin`);
const recBuf = fs.readFileSync(OHREC); const rec = new Float32Array(recBuf.buffer, recBuf.byteOffset, recBuf.byteLength / 4); const recN = rec.length / 5;
const { s0, s1 } = nucBackbone();
const nSurv = (() => { let c = 0; for (let i = 0; i < recN; i++) if (rec[i * 5 + 4] >= 1e8) c++; return c; })();
console.log(`E=${E_eV}eV  radicals=${rn}  OH records=${recN} (${nSurv} survivors, ${recN - nSurv} radical-deaths)  σ_OH-DNA=${SIG.toFixed(4)}nm\n`);

function run(at, label) {
  const h = buildHash(at, 2.0);
  const dir = scoreDirect(at, h, rb, re, rd, rn);
  const exp = scoreExplicit(at, h, rec, recN);
  const sur = scoreSurvival(at, h, rec, recN);
  const rExp = exp.ind / dir.dir, rSur = sur.ind / dir.dir;
  console.log(`${label.padEnd(16)} atoms=${(at.ax.length / 1e6).toFixed(2)}M  dir=${dir.dir.toFixed(1)}  EXPLICIT ind=${exp.ind.toFixed(1)} ratio=${rExp.toFixed(3)} [rxn ${exp.react}]   survival ind=${sur.ind.toFixed(1)} ratio=${rSur.toFixed(3)}`);
  return { dir: dir.dir, ind: exp.ind, ratio: rExp, react: exp.react, ratioSurv: rSur };
}

// 1) full 21×21 straight-LINE control (validate replay vs worker on-line explicit)
const buildG = (half, fn) => { const A = { ax: [], ay: [], az: [] }; for (const [fy, fz] of axes(half)) fn(A, fy, fz); return pack(A); };
console.log('— full 21×21 straight grid (validation vs worker on-line explicit) —');
const full = run(buildG(10, (A, fy, fz) => addLine(A, fy, fz)), 'GRID-21x21');

// 2) folded-in-place 7×7: LINE / BUNDLE / SOLENOID
console.log('\n— folded-in-place, 7×7 identical axes —');
const res = {
  LINE: run(buildG(3, (A, fy, fz) => addLine(A, fy, fz)), 'LINE'),
  BUNDLE: run(buildG(3, (A, fy, fz) => addBundle(A, fy, fz)), 'BUNDLE'),
  SOLENOID: run(buildG(3, (A, fy, fz) => addSolenoid(A, fy, fz, s0, s1)), 'SOLENOID'),
};
const dR = res.SOLENOID.ratio / res.LINE.ratio, girth = res.BUNDLE.ratio / res.LINE.ratio, wind = res.SOLENOID.ratio / res.BUNDLE.ratio;
console.log(`\nEXPLICIT-channel folding:  dR(solenoid/line)=${dR.toFixed(3)}   girth(bundle/line)=${girth.toFixed(3)}   winding(solenoid/bundle)=${wind.toFixed(3)}`);
console.log(JSON.stringify({ E_eV, full_grid_explicit_ratio: full.ratio, fold: { LINE: res.LINE.ratio, BUNDLE: res.BUNDLE.ratio, SOLENOID: res.SOLENOID.ratio }, dR, girth, winding: wind }));
