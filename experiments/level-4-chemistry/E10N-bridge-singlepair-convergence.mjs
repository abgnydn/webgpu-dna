// E10N — single-pair convergence test for the SBS bridge reaction model.
//
// E10M showed the GPU SBS reaction probability is non-convergent: more steps
// → more reaction (G(eaq)@1us: prod133 0.87× → fine 0.27× vs IRT). This
// isolates the REACTION MODEL from the multi-pair/spatial-hash machinery to
// decide WHERE the bug is:
//
//   Simulate ONE diffusing pair (relative coordinate, D_rel = Di+Dj) with the
//   exact bridge rule used in chemistry.wgsl:
//     per step: r0=|r|; displace each comp by N(0,√(2·D·dt)); r1=|r|;
//               if r1≤σ → react; else W=(σ/r1)·exp[-(r0-σ)(r1-σ)/(D·dt)]
//   over fixed T, many trials, at several dt. Compare reaction fraction to the
//   analytic totally-diffusion-controlled Smoluchowski value:
//     W_analytic(T|r0) = (σ/r0)·erfc[(r0-σ)/√(4·D·T)]
//
// CONVERGES across dt → reaction model is correct; GPU divergence is a
// density/hash artifact. DIVERGES → the bridge constant/convention is wrong
// (and the dt-trend tells us which way). Cheap, deterministic-ish, no GPU.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

// OH+OH → H2O2 parameters (matches react_sigma a==0,b==0 and Dk).
const SIGMA = 0.44;        // nm encounter radius
const D_REL = 2.2 + 2.2;   // nm²/ns relative diffusion (OH+OH)
const R0 = 1.0;            // nm initial separation
const T = 100.0;           // ns total time
const TRIALS = 200000;
const DTS = [4.0, 1.0, 0.25, 0.05, 0.01];

// seeded RNG
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function gauss(rng){return Math.sqrt(-2*Math.log(rng()+1e-30))*Math.cos(6.2831853*rng());}
function erfc(x){const z=Math.abs(x);const t=1/(1+0.5*z);const ans=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+t*(-0.82215223+t*0.17087277)))))))));return x>=0?ans:2-ans;}

const W_analytic = (SIGMA / R0) * erfc((R0 - SIGMA) / Math.sqrt(4 * D_REL * T));

function simulate(dt, rng) {
  const nSteps = Math.round(T / dt);
  const sd = Math.sqrt(2 * D_REL * dt);
  let reacted = 0;
  for (let tr = 0; tr < TRIALS; tr++) {
    let x = R0, y = 0, z = 0;
    for (let s = 0; s < nSteps; s++) {
      const r0 = Math.sqrt(x*x + y*y + z*z);
      x += gauss(rng) * sd; y += gauss(rng) * sd; z += gauss(rng) * sd;
      const r1 = Math.sqrt(x*x + y*y + z*z);
      if (r1 <= SIGMA || r0 <= SIGMA) { reacted++; break; }
      const W = (SIGMA / r1) * Math.exp(-(r0 - SIGMA) * (r1 - SIGMA) / (D_REL * dt));
      if (rng() < W) { reacted++; break; }
    }
  }
  return reacted / TRIALS;
}

console.log(`Single-pair SBS bridge convergence  (OH+OH, σ=${SIGMA}, D_rel=${D_REL}, r0=${R0} nm, T=${T} ns, ${TRIALS} trials)`);
console.log(`Analytic Smoluchowski W(T|r0) = ${W_analytic.toFixed(4)}\n`);
console.log(`  ${'dt (ns)'.padStart(9)} ${'nSteps'.padStart(8)} ${'P_react'.padStart(9)} ${'ratio'.padStart(7)}`);
const rng = mulberry32(0xBEEF);
const rows = [];
for (const dt of DTS) {
  const p = simulate(dt, rng);
  const ratio = p / W_analytic;
  rows.push({ dt, nSteps: Math.round(T/dt), p_react: p, ratio });
  console.log(`  ${dt.toString().padStart(9)} ${String(Math.round(T/dt)).padStart(8)} ${p.toFixed(4).padStart(9)} ${ratio.toFixed(3).padStart(7)}`);
}
const spread = Math.max(...rows.map(r=>r.ratio)) / Math.min(...rows.map(r=>r.ratio));
console.log(`\nratio spread across dt: ${spread.toFixed(2)}×  →  ${spread < 1.1 ? 'CONVERGENT (model OK; GPU divergence is a multi-pair/hash artifact)' : 'NON-CONVERGENT (bridge model itself is dt-dependent — constant/convention bug)'}`);

const result = { protocol:'E10N-bridge-singlepair-convergence', status:'measured', date:'2026-06-01',
  params:{ sigma:SIGMA, D_rel:D_REL, r0:R0, T_ns:T, trials:TRIALS }, W_analytic, rows, ratio_spread:spread,
  verdict: spread<1.1?'convergent':'non-convergent' };
console.log('\nRESULT_JSON', JSON.stringify(result));
const outDir = join(REPO_ROOT,'experiments','results','2026-06-01','level-4');
mkdirSync(outDir,{recursive:true});
writeFileSync(join(outDir,'E10N-bridge-singlepair.json'), JSON.stringify(result,null,2));
