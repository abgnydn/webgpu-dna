/**
 * IRT Chemistry Web Worker — per-primary processing.
 * Direct port of G4DNAIRT.cc + chem6 beam.in (Karamitros 2011 reaction table)
 *
 * 9 reactions: 4 TDC (Type 0) + 5 PDC (Type 1)
 * Uses G4ChemDissociationChannels_option1 diffusion coefficients + VDW radii
 * (matching chem6 example with G4EmDNAChemistry_option3)
 *
 * Tracks 6 species: OH, eaq, H, H3O+, H2O2, OH-
 *
 * Input:  { rad_buf: Float32Array, rad_n, n_therm, E_eV }
 * Output: { type:'result', timeline, n_reacted, chem_n, t_wall }
 */

// --- Geant4 thermalization (G4DNAWaterDissociationDisplacer) ---
function meesungnoen2002(k_eV) {
  const gCoeff = [
    -4.06217193e-08,  3.06848412e-06, -9.93217814e-05,
     1.80172797e-03, -2.01135480e-02,  1.42939448e-01,
    -6.48348714e-01,  1.85227848e+00, -3.36450378e+00,
     4.37785068e+00, -4.20557339e+00,  3.81679083e+00,
    -2.34069784e-01
  ];
  if (k_eV <= 0.1) return 0;
  let r_mean = 0;
  for (let i = 12; i >= 0; i--) r_mean += gCoeff[12 - i] * Math.pow(k_eV, i);
  return r_mean;
}

// --- Math helpers ---
function erfcinv(x) {
  if (x <= 0 || x >= 2) return 0;
  const p = x > 1 ? 2 - x : x;
  const t = Math.sqrt(-2 * Math.log(p / 2));
  let y = t - (2.515517 + 0.802853*t + 0.010328*t*t) /
              (1 + 1.432788*t + 0.189269*t*t + 0.001308*t*t*t);
  y *= 0.7071067811865475;
  return x > 1 ? -y : y;
}

function randn() {
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-30)) * Math.cos(6.2831853 * Math.random());
}

const F_CLF = Math.SQRT2;
function clf6() {
  return (Math.random()+Math.random()+Math.random()+Math.random()+Math.random()+Math.random()-3) * F_CLF;
}

// --- Scaled complementary error function: erfcx(x) = exp(x²)·erfc(x) ---
// Stable for all x ≥ 0 using Chebyshev rational approximation (Numerical Recipes)
// for small x, continued fraction for large x.
function erfcx(x) {
  if (x < 0) return 2 * Math.exp(x * x) - erfcx(-x);
  if (x >= 6) {
    // Continued fraction (Laplace form), fast convergence for large x
    let f = 0;
    for (let n = 30; n >= 1; n--) f = (0.5 * n) / (x + f);
    return 0.5641895835477563 / (x + f); // 1/√π
  }
  // For 0 ≤ x < 6: erfcx(x) = t × exp(0.5×(c0 + ty×d) - dd)
  // This avoids computing exp(x²) × exp(-x²) separately
  const t = 2.0 / (2.0 + x);
  const ty = 4 * t - 2;
  const c = [
    -1.3026537197817094, 6.4196979235649026e-1,
    1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6,
    1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9,
    -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13,
    3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15,
    -1.523e-15, -9.4e-17,
    1.21e-16, -2.8e-17
  ];
  let d = 0, dd = 0;
  for (let j = c.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + c[j];
    dd = tmp;
  }
  return t * Math.exp(0.5 * (c[0] + ty * d) - dd);
}

// --- PDC rejection sampling (G4DNAIRT::SamplePDC) ---
function SamplePDC(a, b) {
  const p = 2.0 * Math.sqrt(2.0 * b / a);
  const q = 2.0 / Math.sqrt(2.0 * b / a);
  const M = Math.max(1.0 / (a * a), 3.0 * b / a);
  for (let trial = 0; trial < 10000; trial++) {
    let U = Math.random();
    let X;
    if (U < p / (p + q * M)) {
      X = Math.pow(U * (p + q * M) / 2, 2);
    } else {
      X = Math.pow(2 / ((1 - U) * (p + q * M) / M), 2);
    }
    U = Math.random();
    const sqX = Math.sqrt(X);
    const lambdax = Math.exp(-b * b / X) *
      (1.0 - a * Math.sqrt(Math.PI * X) * erfcx(b / sqX + a * sqX));
    if ((X <= 2.0 * b / a && U <= lambdax) ||
        (X >= 2.0 * b / a && U * M / X <= lambdax)) {
      return X;
    }
  }
  return -1.0; // rejected
}

// --- Type 0 IRT: fully diffusion-controlled (G4DNAIRT::GetIndependentReactionTime) ---
function sampleIRT_type0(r0, sigma, rc, D) {
  if (sigma <= 0 || D <= 0) return -1;
  if (r0 <= sigma) return 0;
  let r0e = r0;
  if (rc !== 0) r0e = -rc / (1 - Math.exp(rc / r0));
  if (r0e <= sigma) return 0;
  const Winf = sigma / r0e;
  const U = Math.random();
  if (U <= 0 || U >= Winf) return -1;
  const ei = erfcinv(r0e * U / sigma);
  if (Math.abs(ei) < 1e-10) return -1;
  const dr = r0e - sigma;
  return 0.25 * dr * dr / (D * ei * ei);
}

// --- Type 1 IRT: partially diffusion-controlled (G4DNAIRT::GetIndependentReactionTime) ---
// Uses SamplePDC rejection sampling for the PDC first-passage time distribution.
function sampleIRT_type1(r0, ri, D) {
  const sigma_c = rxnSigma[ri];   // contact radius
  const rc = rxnRc[ri];
  const kobs_nm = RXN_TABLE[ri].k * K_CONV;
  const kdif_nm = rxnKdif[ri];
  const kact_nm = rxnKact[ri];
  const prob = rxnProb[ri];

  let a, b;
  let sigma_check = sigma_c;
  let r0_check = r0;

  if (rc === 0) {
    // Type II (neutral)
    a = (1.0 / sigma_c) * kact_nm / kobs_nm;
    b = (r0 - sigma_c) / 2;
  } else {
    // Type IV (Coulomb-corrected)
    const v = kact_nm / (4 * Math.PI * sigma_c * sigma_c * Math.exp(-rc / sigma_c));
    const alpha = v + rc * D / (sigma_c * sigma_c * (1 - Math.exp(-rc / sigma_c)));
    const sinh_half = Math.sinh(rc / (2 * sigma_c));
    a = 4 * sigma_c * sigma_c * alpha / (D * rc * rc) * sinh_half * sinh_half;
    b = rc / 4 * (Math.cosh(rc / (2 * r0)) / Math.sinh(rc / (2 * r0)) -
                  Math.cosh(rc / (2 * sigma_c)) / Math.sinh(rc / (2 * sigma_c)));
    // Overwrite r0 and sigma with effective values (Geant4 convention)
    r0_check = -rc / (1 - Math.exp(rc / r0));
    sigma_check = rxnSigmaEff[ri];
  }

  // Contact reaction
  if (sigma_check > r0_check) {
    if (prob > Math.random()) return 0; // react with probability p
    return -1; // rejected
  }

  // Survival probability
  const Winf = sigma_check / r0_check * kobs_nm / kdif_nm;
  if (Winf > Math.random()) {
    const X = SamplePDC(a, b);
    if (X > 0) return X / D;
  }
  return -1;
}

// --- Unified IRT sampler ---
function sampleIRT(r0, ri, D) {
  if (RXN_TABLE[ri].type === 0) {
    return sampleIRT_type0(r0, rxnSigma[ri], rxnRc[ri], D);
  } else {
    return sampleIRT_type1(r0, ri, D);
  }
}

// ============================================================================
// Reaction table — chem6 beam.in (Karamitros 2011): 4 TDC + 5 PDC
// Diffusion coefficients & VDW radii from G4ChemDissociationChannels_option1
// ============================================================================

// Species: 0=OH, 1=eaq, 2=H, 3=H3O+, 4=H2O2, 5=OH-
const N_SPECIES = 6;

// Diffusion coefficients (nm²/ns) — G4ChemDissociationChannels_option1
// Source: chem6.out species table (confirmed against option1 source)
const IRT_D = [2.2, 4.9, 7.0, 9.46, 2.3, 5.3];

// Van der Waals radii (nm) — G4ChemDissociationChannels_option1
const VDW_R = [0.22, 0.50, 0.19, 0.25, 0.21, 0.33];

// Charges for Onsager radius
const CHARGE = [0, -1, 0, 1, 0, -1];

// Onsager radius: rc = q1*q2*e²/(4πε₀*kB*T*εr)
// At 293.15K, εr=80.1: rc = 1.44*q1*q2/(0.02527*80.1) nm
const ONSAGER_FACTOR = 1.44 / (0.02527 * 80.1); // ≈ 0.711 nm per unit charge product
const Rs_PDC = 0.29; // nm, Geant4 PDC parameter

// Rate constant unit conversion: L/(mol·s) → nm³/(entity·ns)
const K_CONV = 1e24 / (6.022e23 * 1e9); // = 1.6605e-9
// Inverse: nm³/(entity·ns) → L/(mol·s)
const K_INV = 1 / K_CONV;

// 9 reactions from chem6 beam.in (Karamitros 2011)
// type: 0 = TDC (totally diffusion-controlled), 1 = PDC (partially)
const RXN_TABLE = [
  { a: 0, b: 0, k: 0.55e10,  prods: [4],    type: 1 },  // 0: OH+OH → H2O2     [PDC]
  { a: 0, b: 1, k: 2.95e10,  prods: [5],    type: 1 },  // 1: eaq+OH → OH-     [PDC]
  { a: 0, b: 2, k: 1.55e10,  prods: [],     type: 1 },  // 2: OH+H → H2O      [PDC]
  { a: 1, b: 1, k: 0.636e10, prods: [5, 5], type: 0 },  // 3: eaq+eaq → 2OH-+H2 [TDC]
  { a: 1, b: 2, k: 2.50e10,  prods: [5],    type: 0 },  // 4: eaq+H → OH-+H2   [TDC]
  { a: 1, b: 3, k: 2.11e10,  prods: [2],    type: 1 },  // 5: eaq+H3O+ → H    [PDC]
  { a: 2, b: 2, k: 0.503e10, prods: [],     type: 0 },  // 6: H+H → H2        [TDC]
  { a: 1, b: 4, k: 1.10e10,  prods: [5, 0], type: 1 },  // 7: eaq+H2O2 → OH-+OH [PDC]
  { a: 3, b: 5, k: 1.13e11,  prods: [],     type: 0 },  // 8: H3O++OH- → H2O  [TDC]
];
// H2 counting: reactions 3, 4, 6 produce H2
const H2_PRODUCERS = new Set([3, 4, 6]);

const N_RXN = RXN_TABLE.length;

// Per-reaction precomputed parameters
const rxnSigma = new Float64Array(N_RXN);    // effective reaction radius (TDC) or contact (PDC)
const rxnSigmaEff = new Float64Array(N_RXN); // effective radius (Coulomb-corrected for PDC)
const rxnRc = new Float64Array(N_RXN);       // Onsager radius
const rxnKdif = new Float64Array(N_RXN);     // diffusion rate [nm³/(entity·ns)]
const rxnKact = new Float64Array(N_RXN);     // activation rate [nm³/(entity·ns)]
const rxnProb = new Float64Array(N_RXN);     // contact reaction probability (PDC)

for (let r = 0; r < N_RXN; r++) {
  const { a, b, k, type } = RXN_TABLE[r];
  const D_sum = IRT_D[a] + IRT_D[b];
  const is_self = (a === b);
  const rc = CHARGE[a] * CHARGE[b] * ONSAGER_FACTOR;
  rxnRc[r] = rc;
  const k_nm = k * K_CONV; // convert to nm³/(entity·ns)

  if (type === 0) {
    // TDC: σ_eff = kobs / (4π·D·NA) in nm
    let sig = k_nm / (4 * Math.PI * D_sum);
    if (is_self) sig *= 2;
    rxnSigma[r] = sig;
    rxnSigmaEff[r] = sig;
    rxnKdif[r] = 0; rxnKact[r] = 0; rxnProb[r] = 1;
  } else {
    // PDC: contact radius from VDW radii
    const sigma_c = VDW_R[a] + VDW_R[b];
    rxnSigma[r] = sigma_c;

    let sig_eff, kdif_nm;
    if (rc === 0) {
      // Type II (neutral-neutral)
      sig_eff = sigma_c;
      kdif_nm = 4 * Math.PI * D_sum * sigma_c;
      if (is_self) kdif_nm /= 2;
    } else {
      // Type IV (Coulomb-corrected)
      sig_eff = -rc / (1 - Math.exp(rc / sigma_c));
      kdif_nm = 4 * Math.PI * D_sum * sig_eff;
      if (is_self) kdif_nm /= 2;
    }
    rxnSigmaEff[r] = sig_eff;
    rxnKdif[r] = kdif_nm;

    const kact_nm = kdif_nm * k_nm / (kdif_nm - k_nm);
    rxnKact[r] = kact_nm;
    rxnProb[r] = Rs_PDC / (Rs_PDC + (kdif_nm / kact_nm) * (sig_eff + Rs_PDC));
  }
}

// Build reaction lookup: rxnMap[specA * N_SPECIES + specB] → reaction index (-1 if none)
const rxnMap = new Int8Array(N_SPECIES * N_SPECIES).fill(-1);
for (let r = 0; r < N_RXN; r++) {
  rxnMap[RXN_TABLE[r].a * N_SPECIES + RXN_TABLE[r].b] = r;
  rxnMap[RXN_TABLE[r].b * N_SPECIES + RXN_TABLE[r].a] = r;
}

// --- Min-heap with generation tracking ---
class MinHeap {
  constructor(capacity) {
    this.t = new Float64Array(capacity);
    this.a = new Int32Array(capacity);
    this.b = new Int32Array(capacity);
    this.ga = new Int32Array(capacity);
    this.gb = new Int32Array(capacity);
    this.n = 0;
    this.cap = capacity;
  }
  reset() { this.n = 0; }
  push(time, i, j, gi, gj) {
    if (this.n >= this.cap) {
      const nc = this.cap * 2;
      const nt = new Float64Array(nc); const na = new Int32Array(nc);
      const nb = new Int32Array(nc); const nga = new Int32Array(nc);
      const ngb = new Int32Array(nc);
      nt.set(this.t); na.set(this.a); nb.set(this.b);
      nga.set(this.ga); ngb.set(this.gb);
      this.t = nt; this.a = na; this.b = nb;
      this.ga = nga; this.gb = ngb; this.cap = nc;
    }
    let c = this.n++;
    this.t[c] = time; this.a[c] = i; this.b[c] = j;
    this.ga[c] = gi; this.gb[c] = gj;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.t[p] <= this.t[c]) break;
      this._swap(p, c); c = p;
    }
  }
  pop() {
    const time = this.t[0], i = this.a[0], j = this.b[0];
    const gi = this.ga[0], gj = this.gb[0];
    this.n--;
    if (this.n > 0) {
      this.t[0] = this.t[this.n]; this.a[0] = this.a[this.n]; this.b[0] = this.b[this.n];
      this.ga[0] = this.ga[this.n]; this.gb[0] = this.gb[this.n];
      let p = 0;
      while (true) {
        let s = p, l = 2*p+1, r = 2*p+2;
        if (l < this.n && this.t[l] < this.t[s]) s = l;
        if (r < this.n && this.t[r] < this.t[s]) s = r;
        if (s === p) break;
        this._swap(p, s); p = s;
      }
    }
    return { t: time, i, j, gi, gj };
  }
  _swap(a, b) {
    let tmp;
    tmp = this.t[a]; this.t[a] = this.t[b]; this.t[b] = tmp;
    tmp = this.a[a]; this.a[a] = this.a[b]; this.a[b] = tmp;
    tmp = this.b[a]; this.b[a] = this.b[b]; this.b[b] = tmp;
    tmp = this.ga[a]; this.ga[a] = this.ga[b]; this.ga[b] = tmp;
    tmp = this.gb[a]; this.gb[a] = this.gb[b]; this.gb[b] = tmp;
  }
}

// --- Thermalization constants (G4DNAWaterDissociationDisplacer.cc) ---
const r_mean_eaq = meesungnoen2002(1.7); // Geant4: autoionization eaq at 1.7 eV
const CONVERT_RMEAN_TO_SIGMA = 0.62665706865775006; // sqrt(pi) / 2^(3/2)

// Mother molecule displacement for ionisation/autoionisation: RMS = 2.0 nm
const SIGMA_MOTHER = 2.0 / Math.sqrt(3); // per-axis sigma = 1.155 nm

// Product displacements (applied AFTER mother displacement):
// Ionisation OH: 0.8 nm RMS (50% of the time; other 50% goes to H3O+)
const SIGMA_OH_PROD = 0.8 / Math.sqrt(3);
// A1B1 excitation H: 17/18 × 2.4 nm total RMS
const SIGMA_H_EXCITATION = (17/18) * 2.4 / Math.sqrt(3);
// Autoionisation eaq: meesungnoen2002(1.7 eV) thermalization
const SIGMA_EAQ_AUTO = r_mean_eaq * CONVERT_RMEAN_TO_SIGMA;

// R_CUT: Geant4 formula 1.45 + 2*sqrt(8*D_max*t_max), D_max=9.46, t_max=1000 ns
const R_CUT = 1.45 + 2 * Math.sqrt(8 * 9.46 * 1000); // ≈ 551 nm
const R_CUT2 = R_CUT * R_CUT;

// ============================================================================
// Main worker
// ============================================================================
self.onmessage = function(e) {
  const { rad_buf, rad_n, n_therm, E_eV, dna, ssbScoring } = e.data;
  const t0 = performance.now();

  // ─── IRT-side indirect-SSB scoring (PHYSICS_DIAGNOSIS.md §3 option b) ───
  // 2026-05-12: previously scoreIndirectSSB ran in app.ts on chem_pos at
  // t=1μs, missing all the OH-backbone encounters that happen DURING the
  // chemistry timeline (E13c surfaced this — SSB_ind = 0 even with the
  // generous PARTRAC-effective r=1.0 nm). Now: when an OH gets consumed
  // in a reaction (or survives to 1 μs), check if its position was within
  // r_indirect of any backbone atom. If yes, Bernoulli P_indirect → SSB
  // hit (dedup at (bp, strand)).
  //
  // DNA geometry is optional — if `dna` is undefined the scoring is
  // skipped (worker stays backwards-compatible).
  const ssbEnabled = !!dna && !!ssbScoring;
  let ssb0 = 0;            // strand-0 SSBs (deduped)
  let ssb1 = 0;            // strand-1 SSBs (deduped)
  let ssb_candidates = 0;  // OHs that died/survived within r_indirect of any backbone
  let ssb_in_reach = 0;    // candidates that actually passed the Bernoulli
  let ssbHits = null;
  let dnaSsbCheck = null;  // function(x, y, z) → { hit_bp, hit_strand, in_reach }
  if (ssbEnabled) {
    const r_indirect = ssbScoring.r_indirect;
    const r_indirect2 = r_indirect * r_indirect;
    const p_indirect = ssbScoring.p_indirect;
    const ssbSeed = ssbScoring.seed | 0;
    // Seedable RNG for SSB sampling (independent of chemistry RNG)
    let ssbRngState = ssbSeed === 0 ? 0x9e3779b9 : ssbSeed >>> 0;
    const ssbRng = () => {
      ssbRngState = (ssbRngState + 0x6d2b79f5) >>> 0;
      let t = ssbRngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { fy, fz, rbb0, rbb1, n_bp_per, grid_N, spacing_nm, x0, x_half, r_bb } = dna;
    const inv_spacing = 1 / spacing_nm;
    const rise_inv = 1 / 0.34;
    const grid_off = -((grid_N - 1) * spacing_nm) * 0.5;
    const outer2 = (r_bb + r_indirect) * (r_bb + r_indirect);
    ssbHits = new Uint8Array(n_bp_per * grid_N * grid_N * 2);
    dnaSsbCheck = (x, y, z) => {
      if (x < -x_half - r_indirect || x > x_half + r_indirect) return;
      const fi = Math.round((y - grid_off) * inv_spacing);
      const fj = Math.round((z - grid_off) * inv_spacing);
      if (fi < 0 || fi >= grid_N || fj < 0 || fj >= grid_N) return;
      const fiber_idx = fi * grid_N + fj;
      const y_rel = y - fy[fiber_idx];
      const z_rel = z - fz[fiber_idx];
      const r2 = y_rel * y_rel + z_rel * z_rel;
      if (r2 > outer2) return;
      ssb_candidates++;
      const bp_est = Math.round((x + x_half) * rise_inv);
      const bp0 = Math.max(0, bp_est - 2);
      const bp1 = Math.min(n_bp_per - 1, bp_est + 2);
      let best_d2 = Infinity;
      let best_bp = -1, best_strand = -1;
      for (let b = bp0; b <= bp1; b++) {
        const dx = x - (x0 + b * 0.34);
        const dy0 = y_rel - rbb0[b * 2 + 0];
        const dz0 = z_rel - rbb0[b * 2 + 1];
        const d20 = dx * dx + dy0 * dy0 + dz0 * dz0;
        if (d20 < best_d2) { best_d2 = d20; best_bp = b; best_strand = 0; }
        const dy1 = y_rel - rbb1[b * 2 + 0];
        const dz1 = z_rel - rbb1[b * 2 + 1];
        const d21 = dx * dx + dy1 * dy1 + dz1 * dz1;
        if (d21 < best_d2) { best_d2 = d21; best_bp = b; best_strand = 1; }
      }
      if (best_d2 < r_indirect2) {
        ssb_in_reach++;
        if (ssbRng() < p_indirect) {
          const global_bp = fiber_idx * n_bp_per + best_bp;
          const idx = global_bp + best_strand * (n_bp_per * grid_N * grid_N);
          if (ssbHits[idx] === 0) {
            ssbHits[idx] = 1;
            if (best_strand === 0) ssb0++; else ssb1++;
          }
        }
      }
    };
  }

  // --- Phase 1: Group radicals by primary ID ---
  // rad_buf w-component encodes both primary id and species:
  //   w = pid * 8 + species_code
  //   species_code: 0=OH, 1=eaq, 2=H, 3=H3O+, 5=pre-therm eaq (→ eaq w/ Meesungnoen),
  //                 6=OH-, 7=H2 marker (counted, not added to particle list)
  // Initial H2 markers (code 7) come from B1A1 (3.25%) and DEA (100%) channels.
  const priMap = new Map();
  const initH2 = new Map(); // pid → count of initial H2 markers
  for (let i = 0; i < rad_n; i++) {
    const w = Math.round(rad_buf[i*4+3]);
    const sp = w % 8;
    if (sp < 0 || sp === 4) continue; // sp=4 reserved for H2O2 (chemistry product only)
    const pid = Math.floor(w / 8);
    if (sp === 7) {
      initH2.set(pid, (initH2.get(pid) || 0) + 1);
      continue;
    }
    let arr = priMap.get(pid);
    if (!arr) { arr = []; priMap.set(pid, arr); }
    arr.push(i);
  }

  const nPrimaries = priMap.size;
  let maxN = 0;
  for (const arr of priMap.values()) if (arr.length > maxN) maxN = arr.length;

  self.postMessage({ type: 'progress',
    msg: `${rad_n} radicals, ${nPrimaries} primaries (max ${maxN}/pri), per-primary IRT...` });

  // --- Phase 2: Pre-allocate reusable arrays ---
  // Products can be created, so allocate 2× initial capacity
  const CAP = maxN * 2 + 512;
  const px = new Float64Array(CAP);
  const py = new Float64Array(CAP);
  const pz = new Float64Array(CAP);
  const species = new Int32Array(CAP);
  const alive = new Uint8Array(CAP);
  const gen = new Int32Array(CAP);
  const tbirth = new Float64Array(CAP);  // birth time (ns) for diffusion sync
  const heap = new MinHeap(CAP * 8);

  // Timeline accumulators. 0.1 ps added 2026-05-11 to align with Geant4 chem6's
  // earliest checkpoint (chem6 default macro records 0.1 ps too), enabling
  // E9 pre-chemistry G-value comparison.
  const checkpoints = [0.0001, 0.001, 0.01, 0.1, 1, 10, 100, 1000];
  const labels = ['0.1 ps', '1 ps', '10 ps', '100 ps', '1 ns', '10 ns', '100 ns', '1 us'];
  const nCP = checkpoints.length;
  const tl_oh = new Float64Array(nCP);
  const tl_eaq = new Float64Array(nCP);
  const tl_h = new Float64Array(nCP);
  const tl_H2O2 = new Float64Array(nCP);
  const tl_H2 = new Float64Array(nCP);
  let total_reacted = 0;
  const rxn_counts = new Int32Array(N_RXN);  // per-reaction-type counter

  // Helper: pair a new/changed particle at index `idx` with all alive particles.
  // Geant4 G4DNAIRT::Sampling diffuses the EXISTING radical forward by
  // dt = t_new - t_existing (Brownian synchronization) before computing r0.
  function pairWithAlive(idx, n_total, t_new) {
    const si = species[idx];
    const Di = IRT_D[si];
    if (Di === 0) return;
    for (let jj = 0; jj < n_total; jj++) {
      if (jj === idx || !alive[jj]) continue;
      const sj = species[jj];
      const ri = rxnMap[si * N_SPECIES + sj];
      if (ri < 0) continue;
      const Dj = IRT_D[sj];

      // Geant4 diffusion synchronization: if existing radical (jj) was born
      // earlier, diffuse it forward by dt to match product's birth time
      const dt = t_new - tbirth[jj];
      let xj = px[jj], yj = py[jj], zj = pz[jj];
      if (dt > 0) {
        const sig = Math.sqrt(2.0 * Dj * dt);
        xj += randn() * sig;
        yj += randn() * sig;
        zj += randn() * sig;
      }

      const ddx = px[idx]-xj, ddy = py[idx]-yj, ddz = pz[idx]-zj;
      const r2 = ddx*ddx + ddy*ddy + ddz*ddz;
      if (r2 > R_CUT2) continue;
      const r0 = Math.sqrt(r2);
      const t = sampleIRT(r0, ri, Di + Dj);
      if (t >= 0) {
        const ta = t_new + t;
        if (ta < 1000) {
          const aa = Math.min(idx, jj), bb = Math.max(idx, jj);
          heap.push(ta, aa, bb, gen[aa], gen[bb]);
        }
      }
    }
  }

  // --- Phase 3: Process each primary independently ---
  let priDone = 0;

  for (const [pid, indices] of priMap) {
    const n = indices.length;
    let n_total = n; // grows as products are created

    // Load positions and apply Geant4 thermalization displacements
    for (let k = 0; k < n; k++) {
      const bi = indices[k];
      let x = rad_buf[bi*4];
      let y = rad_buf[bi*4+1];
      let z = rad_buf[bi*4+2];
      let s = Math.round(rad_buf[bi*4+3]) % 8;

      alive[k] = 1;
      gen[k] = 0;
      tbirth[k] = 0;  // all initial radicals born at t=0

      if (s === 5) {
        // Pre-thermalized eaq (tracked by GPU shader) — no displacement
        species[k] = 1;
      } else if (s === 0) {
        // OH from ionisation or excitation.
        // Ionisation/autoionisation: shader already applied 2.0 nm mother displacement.
        // A1B1 excitation: shader stores at excitation site (no mother, correct per Geant4).
        // Product displacement: 0.8 nm RMS (50% chance, shared with H3O+)
        species[k] = 0;
        if (Math.random() < 0.5) {
          x += SIGMA_OH_PROD * clf6();
          y += SIGMA_OH_PROD * clf6();
          z += SIGMA_OH_PROD * clf6();
        }
      } else if (s === 3) {
        // H3O+ from ionisation or autoionisation.
        // Shader already applied 2.0 nm mother displacement.
        // Product displacement: 0.8 nm RMS (50% chance, other half of OH/H3O+ split)
        species[k] = 3;
        if (Math.random() < 0.5) {
          x += SIGMA_OH_PROD * clf6();
          y += SIGMA_OH_PROD * clf6();
          z += SIGMA_OH_PROD * clf6();
        }
      } else if (s === 1) {
        // eaq from autoionisation (B1A1 excitation)
        // Shader already applied 2.0 nm mother displacement.
        // Only thermalization displacement needed here.
        species[k] = 1;
        x += SIGMA_EAQ_AUTO * clf6();
        y += SIGMA_EAQ_AUTO * clf6();
        z += SIGMA_EAQ_AUTO * clf6();
      } else if (s === 2) {
        // H from A1B1 excitation (OH+H channel)
        // Geant4: mother displacement 0 nm + product displacement 17/18 × 2.4 nm
        species[k] = 2;
        x += SIGMA_H_EXCITATION * clf6();
        y += SIGMA_H_EXCITATION * clf6();
        z += SIGMA_H_EXCITATION * clf6();
      } else if (s === 6) {
        // OH- from DEA (DissociAttachment_ch1)
        // Worker species index 5 = OH-. No additional displacement (deposit at site).
        species[k] = 5;
      } else {
        alive[k] = 0;
        species[k] = s;
      }

      px[k] = x;
      py[k] = y;
      pz[k] = z;
    }

    // Build initial IRT pairs: O(n²) direct scan with R_CUT
    heap.reset();
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const si = species[i];
      const Di = IRT_D[si];
      if (Di === 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const sj = species[j];
        const ri = rxnMap[si * N_SPECIES + sj];
        if (ri < 0) continue;
        const ddx=px[i]-px[j], ddy=py[i]-py[j], ddz=pz[i]-pz[j];
        const r2 = ddx*ddx+ddy*ddy+ddz*ddz;
        if (r2 > R_CUT2) continue;
        const r0 = Math.sqrt(r2);
        const t = sampleIRT(r0, ri, Di+IRT_D[sj]);
        if (t >= 0 && t < 1000) heap.push(t, i, j, 0, 0);
      }
    }

    // Process reactions in time order. Pre-load pri_H2 with the count of
    // initial H2 markers (code 7 in rad_buf) for this primary — these come
    // from B1A1 (3.25%) and DEA channels and exist from t=0.
    let pri_H2O2 = 0, pri_H2 = (initH2.get(pid) || 0);
    let cp_idx = 0;

    while (heap.n > 0) {
      const evt = heap.pop();

      // Record checkpoints
      while (cp_idx < nCP && evt.t >= checkpoints[cp_idx]) {
        let oh=0, eq=0, hh=0, h2o2=0;
        for (let k = 0; k < n_total; k++) {
          if (!alive[k]) continue;
          if (species[k]===0) oh++;
          else if (species[k]===1) eq++;
          else if (species[k]===2) hh++;
          else if (species[k]===4) h2o2++;
        }
        tl_oh[cp_idx] += oh; tl_eaq[cp_idx] += eq; tl_h[cp_idx] += hh;
        tl_H2O2[cp_idx] += pri_H2O2 + h2o2; tl_H2[cp_idx] += pri_H2;
        cp_idx++;
      }

      // Validate event
      if (!alive[evt.i] || !alive[evt.j]) continue;
      if (gen[evt.i] !== evt.gi || gen[evt.j] !== evt.gj) continue;

      const si = species[evt.i], sj = species[evt.j];
      const ri = rxnMap[Math.min(si,sj) * N_SPECIES + Math.max(si,sj)];
      if (ri < 0) continue;

      // Indirect-SSB scoring: check whether either reactant is an OH that
      // happened to be within r_indirect of a backbone at consumption.
      // This is the per-event check (OH dies in chemistry — its position
      // at death is the encounter site).
      if (dnaSsbCheck) {
        if (si === 0) dnaSsbCheck(px[evt.i], py[evt.i], pz[evt.i]);
        if (sj === 0) dnaSsbCheck(px[evt.j], py[evt.j], pz[evt.j]);
      }

      // Kill reactants
      alive[evt.i] = 0;
      alive[evt.j] = 0;
      total_reacted++;
      rxn_counts[ri]++;

      // Count H2
      if (H2_PRODUCERS.has(ri)) pri_H2++;

      // Create products and re-pair them
      const prods = RXN_TABLE[ri].prods;
      if (prods.length === 0) {
        // No tracked products (OH+H→water, H+H→H2, H3O++OH-→water)
        continue;
      }

      // Product placement (G4DNAIRT::MakeReaction):
      // 1 product → at reaction site (D-weighted midpoint)
      // 2 products → at posA and posB
      const sqDi = Math.sqrt(IRT_D[si]), sqDj = Math.sqrt(IRT_D[sj]);
      const w = sqDi + sqDj;
      // Midpoint (weighted by partner's sqrt(D))
      const mx = (sqDj*px[evt.i] + sqDi*px[evt.j]) / w;
      const my = (sqDj*py[evt.i] + sqDi*py[evt.j]) / w;
      const mz = (sqDj*pz[evt.i] + sqDi*pz[evt.j]) / w;

      for (let p = 0; p < prods.length; p++) {
        const newSp = prods[p];
        const idx = n_total;
        if (idx >= CAP) break; // safety

        species[idx] = newSp;
        alive[idx] = 1;
        gen[idx] = 0;
        tbirth[idx] = evt.t;  // product born at reaction time

        if (prods.length === 1) {
          // Single product at midpoint
          px[idx] = mx; py[idx] = my; pz[idx] = mz;
        } else {
          // 2 products: first at posA (evt.i), second at posB (evt.j)
          if (p === 0) {
            px[idx] = px[evt.i]; py[idx] = py[evt.i]; pz[idx] = pz[evt.i];
          } else {
            px[idx] = px[evt.j]; py[idx] = py[evt.j]; pz[idx] = pz[evt.j];
          }
        }

        n_total++;

        // Pair new product with all alive radicals
        pairWithAlive(idx, n_total, evt.t);
      }
    }

    // Final checkpoints
    while (cp_idx < nCP) {
      let oh=0, eq=0, hh=0, h2o2=0;
      for (let k = 0; k < n_total; k++) {
        if (!alive[k]) continue;
        if (species[k]===0) oh++;
        else if (species[k]===1) eq++;
        else if (species[k]===2) hh++;
        else if (species[k]===4) h2o2++;
      }
      tl_oh[cp_idx] += oh; tl_eaq[cp_idx] += eq; tl_h[cp_idx] += hh;
      tl_H2O2[cp_idx] += pri_H2O2 + h2o2; tl_H2[cp_idx] += pri_H2;
      cp_idx++;
    }

    // Indirect-SSB scoring: also count OHs that SURVIVE to end-of-time
    // (they made it to 1 μs without reacting; their final position is the
    // closest they ever got to whatever DNA they were near). This mirrors
    // the original scoreIndirectSSB scan at t=1μs.
    if (dnaSsbCheck) {
      for (let k = 0; k < n_total; k++) {
        if (!alive[k]) continue;
        if (species[k] !== 0) continue;
        dnaSsbCheck(px[k], py[k], pz[k]);
      }
    }

    priDone++;
    if (priDone % 500 === 0) {
      self.postMessage({ type: 'progress',
        msg: `  ${priDone}/${nPrimaries} primaries (${total_reacted} reactions)...` });
    }
  }

  // --- Phase 4: Build output ---
  const dep = n_therm * E_eV;
  const per100 = dep / 100;
  const timeline = [];
  for (let c = 0; c < nCP; c++) {
    timeline.push({
      label: labels[c], t_ns: checkpoints[c],
      G_OH:   per100 > 0 ? tl_oh[c]   / per100 : 0,
      G_eaq:  per100 > 0 ? tl_eaq[c]  / per100 : 0,
      G_H:    per100 > 0 ? tl_h[c]    / per100 : 0,
      G_H2O2: per100 > 0 ? tl_H2O2[c] / per100 : 0,
      G_H2:   per100 > 0 ? tl_H2[c]   / per100 : 0,
    });
  }

  const t_wall = performance.now() - t0;
  const rxn_labels = [
    'OH+OH→H2O2 [PDC]', 'eaq+OH→OH- [PDC]', 'OH+H→H2O [PDC]',
    'eaq+eaq→2OH-+H2 [TDC]', 'eaq+H→OH-+H2 [TDC]', 'eaq+H3O+→H [PDC]',
    'H+H→H2 [TDC]', 'eaq+H2O2→OH-+OH [PDC]', 'H3O++OH-→H2O [TDC]'
  ];
  const rxn_info = [];
  for (let r = 0; r < N_RXN; r++) {
    rxn_info.push({ label: rxn_labels[r], count: rxn_counts[r],
      sigma: rxnSigma[r].toFixed(4), rc: rxnRc[r].toFixed(3) });
  }
  // Indirect-SSB scoring summary — empty if dna/ssbScoring was not provided.
  // Also returns the per-bp hit mask (ssbHits Uint8Array, length =
  // n_bp_per * grid_N * grid_N * 2) so the DSB clusterer sees both direct
  // and indirect hits when combining masks. Without this, clusterDSB sees
  // only the direct-SSB mask and misses indirect→direct co-localized DSBs.
  const ssb_indirect = ssbEnabled
    ? {
        ssb0,
        ssb1,
        total: ssb0 + ssb1,
        candidates: ssb_candidates,
        in_reach: ssb_in_reach,
        r_indirect: ssbScoring.r_indirect,
        p_indirect: ssbScoring.p_indirect,
        hits: ssbHits,  // Uint8Array, transferred via postMessage
        note: 'Accumulated during IRT timeline: every OH death event AND every t=1μs survivor checked for backbone proximity. Replaces the original t=1μs-only scoreIndirectSSB scan. `hits` is the per-bp hit mask suitable for clusterDSB.',
      }
    : null;

  self.postMessage({
    type: 'result', timeline, n_reacted: total_reacted,
    chem_n: rad_n, t_wall, n_repaired: 0, rxn_info,
    ssb_indirect,
  });
};
