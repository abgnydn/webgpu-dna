// Dual-geometry SSB scoring: score the SAME dump (direct = rad_dep, indirect =
// surviving OH) against (a) the straight 21x21 fibre grid and (b) a chromatin
// fill of the same region at matched bp. Tests E34's claim that the concentrated
// grid inflates indirect. First-order; design caveats noted in the report.
const fs = require('fs');
const R = '/Users/ahmetbarisgunaydin/dev/webgpu-dna';
const E_LOW = 5.0, E_HIGH = 37.5, R_DIR = 0.29, R_IND = 1.0, P_IND = 0.13;

// ---- geometry: straight 21x21 grid backbone atoms (port of buildDNATarget) ----
function gridAtoms(L = 3000, GN = 21, SP = 150) {
  const rise = 0.34, r_bb = 1.0, npr = Math.floor(L / rise), x0 = -(npr - 1) * rise * 0.5, go = -((GN - 1) * SP) * 0.5;
  const dp = 2 * Math.PI / 10.5;
  const ax = [], ay = [], az = [];
  for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) {
    const fy = go + i * SP, fz = go + j * SP;
    for (let b = 0; b < npr; b++) {
      const x = x0 + b * rise, phi = b * dp;
      ax.push(x, x); ay.push(fy + r_bb * Math.cos(phi), fy + r_bb * Math.cos(phi + Math.PI));
      az.push(fz + r_bb * Math.sin(phi), fz + r_bb * Math.sin(phi + Math.PI));
    }
  }
  return { ax: new Float32Array(ax), ay: new Float32Array(ay), az: new Float32Array(az) };
}

// ---- geometry: chromatin fill (nucleosome superhelix -> fibre -> scattered) ----
const NUC_BP = 147, R_SH = 4.18, P_SH = 2.39, NUC_TURNS = 1.65, r_bb = 1.0;
function nucBackbone() {
  const s0 = [], s1 = [];
  const C = (i) => { const phi = i * 2 * Math.PI * NUC_TURNS / NUC_BP, z = P_SH * NUC_TURNS * i / NUC_BP; return [R_SH * Math.cos(phi), R_SH * Math.sin(phi), z]; };
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (let i = 0; i < NUC_BP; i++) {
    const c = C(i), cp = C(Math.min(i + 1, NUC_BP - 1)), cm = C(Math.max(i - 1, 0));
    const T = nrm([cp[0] - cm[0], cp[1] - cm[1], cp[2] - cm[2]]);
    const rad = [c[0], c[1], 0], d = rad[0] * T[0] + rad[1] * T[1];
    const N = nrm([rad[0] - d * T[0], rad[1] - d * T[1], rad[2] - d * T[2]]), B = nrm(crs(T, N));
    const psi = i * 2 * Math.PI / 10.5;
    const off = (a) => [c[0] + r_bb * (Math.cos(a) * N[0] + Math.sin(a) * B[0]), c[1] + r_bb * (Math.cos(a) * N[1] + Math.sin(a) * B[1]), c[2] + r_bb * (Math.cos(a) * N[2] + Math.sin(a) * B[2])];
    s0.push(off(psi)); s1.push(off(psi + Math.PI));
  }
  return { s0, s1 };
}
function rand(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function randRot(rng) { // random rotation matrix (axis-angle)
  const u1 = rng(), u2 = rng(), u3 = rng();
  const q0 = Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), q1 = Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), q2 = Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), q3 = Math.sqrt(u1) * Math.cos(2 * Math.PI * u3);
  return [1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2), 2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1), 2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2)];
}
function chromatinAtoms(targetBp, half) {
  const { s0, s1 } = nucBackbone();
  const nucPerFibre = 40; // ~5880 bp/fibre
  const rng = rand(0x0f1b2c3d);
  const ax = [], ay = [], az = [];
  let bp = 0;
  while (bp < targetBp) {
    const cx = (rng() * 2 - 1) * half, cy = (rng() * 2 - 1) * half, cz = (rng() * 2 - 1) * half;
    const Rm = randRot(rng);
    // fibre solenoid axis oriented by Rm; place nucPerFibre nucleosomes
    for (let k = 0; k < nucPerFibre && bp < targetBp; k++) {
      const th = k * 2 * Math.PI / 6, zax = k * 11.0 / 6 - (nucPerFibre - 1) * 11.0 / 12;
      const fc = [11.0 * Math.cos(th), 11.0 * Math.sin(th), zax];
      const discR = [Math.cos(th), Math.sin(th), 0];
      // nucleosome disc-axis -> radial, then whole fibre rotated by Rm, translated to (cx,cy,cz)
      const rz = discR; const s = Math.hypot(-rz[1], rz[0]) || 1; const ux = -rz[1] / s, uy = rz[0] / s;
      const c = rz[2], kk = 1 - c;
      const Rn = [c + ux * ux * kk, ux * uy * kk, uy * s, uy * ux * kk, c + uy * uy * kk, -ux * s, -uy * s, ux * s, c];
      for (let i = 0; i < NUC_BP; i++) {
        for (const p of [s0[i], s1[i]]) {
          // local nucleosome -> disc-radial (Rn) + fibre centre
          const a = [Rn[0] * p[0] + Rn[1] * p[1] + Rn[2] * p[2] + fc[0], Rn[3] * p[0] + Rn[4] * p[1] + Rn[5] * p[2] + fc[1], Rn[6] * p[0] + Rn[7] * p[1] + Rn[8] * p[2] + fc[2]];
          // fibre -> world (Rm) + fibre translation
          ax.push(Rm[0] * a[0] + Rm[1] * a[1] + Rm[2] * a[2] + cx);
          ay.push(Rm[3] * a[0] + Rm[4] * a[1] + Rm[5] * a[2] + cy);
          az.push(Rm[6] * a[0] + Rm[7] * a[1] + Rm[8] * a[2] + cz);
        }
      }
      bp += NUC_BP;
    }
  }
  return { ax: new Float32Array(ax), ay: new Float32Array(ay), az: new Float32Array(az) };
}

// ---- spatial hash over backbone atoms ----
function buildHash(atoms, cell) {
  const H = new Map(), inv = 1 / cell, n = atoms.ax.length;
  const key = (cx, cy, cz) => cx + cy * 4001 + cz * 4001 * 4001;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(atoms.ax[i] * inv) + 2000, cy = Math.floor(atoms.ay[i] * inv) + 2000, cz = Math.floor(atoms.az[i] * inv) + 2000;
    const k = key(cx, cy, cz); let a = H.get(k); if (!a) { a = []; H.set(k, a); } a.push(i);
  }
  return { H, inv, key };
}
function nearest(atoms, hash, x, y, z, R2) { // return {sugar index, d2} of nearest atom within R
  const { H, inv, key } = hash;
  const cx = Math.floor(x * inv) + 2000, cy = Math.floor(y * inv) + 2000, cz = Math.floor(z * inv) + 2000;
  let bd = Infinity, bi = -1;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const a = H.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue;
    for (const i of a) { const d2 = (atoms.ax[i] - x) ** 2 + (atoms.ay[i] - y) ** 2 + (atoms.az[i] - z) ** 2; if (d2 < bd) { bd = d2; bi = i; } }
  }
  return bd <= R2 ? { i: bi, d2: bd } : null;
}

// ---- score direct (rad_dep) + indirect (OH) against a geometry ----
function score(atoms, rad_buf, rad_e, rad_dep, rad_n, oh, ohN) {
  const nsug = atoms.ax.length;
  const Eacc = new Float32Array(nsug), ohK = new Int32Array(nsug);
  const dh = buildHash(atoms, 2.0);
  // DIRECT
  let lx = NaN, ly = NaN, lz = NaN, in_reach_dir = 0;
  for (let i = 0; i < rad_n; i++) {
    const sp = Math.round(rad_buf[i * 4 + 3]) % 8; if (sp === 1 || sp === 5 || sp === 7) continue;
    const x = rad_dep[i * 4], y = rad_dep[i * 4 + 1], z = rad_dep[i * 4 + 2];
    if (x === lx && y === ly && z === lz) continue; lx = x; ly = y; lz = z;
    const hit = nearest(atoms, dh, x, y, z, R_DIR * R_DIR); if (hit) { Eacc[hit.i] += rad_e[i]; in_reach_dir++; }
  }
  let direct = 0; const es = E_HIGH - E_LOW;
  for (let s = 0; s < nsug; s++) { const e = Eacc[s]; if (e > E_LOW) direct += e >= E_HIGH ? 1 : (e - E_LOW) / es; }
  // INDIRECT
  let in_reach_ind = 0;
  for (let i = 0; i < ohN; i++) {
    const hit = nearest(atoms, dh, oh[i * 3], oh[i * 3 + 1], oh[i * 3 + 2], R_IND * R_IND);
    if (hit) { ohK[hit.i]++; in_reach_ind++; }
  }
  let indirect = 0;
  for (let s = 0; s < nsug; s++) { const k = ohK[s]; if (k > 0) indirect += 1 - (1 - P_IND) ** k; }
  return { direct, indirect, ratio: indirect / direct, in_reach_dir, in_reach_ind, n_atoms: nsug };
}

// ---- main ----
const d = R + '/dumps';
const rb = fs.readFileSync(d + '/rad_E10000_N4096.bin'); const rad_buf = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4); const rad_n = rad_buf.length / 4;
const eb = fs.readFileSync(d + '/rade_E10000_N4096.bin'); const rad_e = new Float32Array(eb.buffer, eb.byteOffset, eb.byteLength / 4);
const db = fs.readFileSync(d + '/raddep_E10000_N4096.bin'); const rad_dep = new Float32Array(db.buffer, db.byteOffset, db.byteLength / 4);
const ob = fs.readFileSync(d + '/oh_survivors_E10000.bin'); const oh = new Float32Array(ob.buffer, ob.byteOffset, ob.byteLength / 4); const ohN = oh.length / 3;
console.log(`radicals=${rad_n}  OH survivors=${ohN}`);
const grid = gridAtoms();
const nGridBp = grid.ax.length / 2;
console.log(`grid: ${grid.ax.length} atoms (${nGridBp} bp)`);
const chrom = chromatinAtoms(nGridBp, 1500);
console.log(`chromatin: ${chrom.ax.length} atoms (${chrom.ax.length / 2} bp)`);
console.log('\n--- scoring (same dump, both geometries) ---');
for (const [name, at] of [['GRID (21x21 straight)', grid], ['CHROMATIN (matched bp)', chrom]]) {
  const r = score(at, rad_buf, rad_e, rad_dep, rad_n, oh, ohN);
  console.log(`${name}: direct=${r.direct.toFixed(1)} indirect=${r.indirect.toFixed(1)} ratio=${r.ratio.toFixed(2)}  (in_reach dir=${r.in_reach_dir} ind=${r.in_reach_ind})`);
}
