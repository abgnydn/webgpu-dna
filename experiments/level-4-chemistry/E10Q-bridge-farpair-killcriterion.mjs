// E10Q — kill criterion for HYBRID_IRT_SBS_DESIGN.md formulation B.
//
// The hybrid uses GPU-SBS only for the SPARSE, FAR-separated inter-track
// residual, betting that far pairs tolerate LARGE dt (few steps → cheap →
// hybrid beats IRT). E10N proved CLOSE pairs (r0=1 nm) need dt≈0.01 ns to
// converge to the analytic Smoluchowski value. THE question: does the
// convergent dt grow with separation? If far pairs (r0=30–100 nm) converge at
// dt orders larger than close pairs, the cheap C2 SBS phase is real. If they
// ALSO need tiny dt, formulation B is dead → native runtime is the only
// browser-feasible inter-track path.
//
// Single-pair bridge SBS vs analytic, swept over (r0, dt). Node, no GPU.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const REPO_ROOT = join(import.meta.dirname, '..', '..');

const SIGMA = 0.44, D_REL = 4.4;        // OH+OH
const T = 1000.0;                        // ns — the full chemistry window
const TRIALS = 150000;
const R0S = [1, 10, 30, 100];            // nm — close → far (inter-track)
const DTS = [4.0, 1.0, 0.25, 0.05];      // ns

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function gauss(rng){return Math.sqrt(-2*Math.log(rng()+1e-30))*Math.cos(6.2831853*rng());}
function erfc(x){const z=Math.abs(x);const t=1/(1+0.5*z);const ans=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+t*(-0.82215223+t*0.17087277)))))))));return x>=0?ans:2-ans;}
const analytic = (r0) => (SIGMA / r0) * erfc((r0 - SIGMA) / Math.sqrt(4 * D_REL * T));

function simulate(r0, dt, rng) {
  const nSteps = Math.round(T / dt), sd = Math.sqrt(2 * D_REL * dt);
  let reacted = 0;
  for (let tr = 0; tr < TRIALS; tr++) {
    let x = r0, y = 0, z = 0;
    for (let s = 0; s < nSteps; s++) {
      const a = Math.sqrt(x*x+y*y+z*z);
      x += gauss(rng)*sd; y += gauss(rng)*sd; z += gauss(rng)*sd;
      const b = Math.sqrt(x*x+y*y+z*z);
      if (b <= SIGMA || a <= SIGMA) { reacted++; break; }
      const W = (SIGMA/b)*Math.exp(-(a-SIGMA)*(b-SIGMA)/(D_REL*dt));
      if (rng() < W) { reacted++; break; }
    }
  }
  return reacted / TRIALS;
}

console.log(`Far-pair bridge convergence (OH+OH, σ=${SIGMA}, D_rel=${D_REL}, T=${T} ns, ${TRIALS} trials)\n`);
const rng = mulberry32(0x5EED);
const rows = [];
const header = `  ${'r0 (nm)'.padStart(8)} ${'analytic'.padStart(9)} ` + DTS.map(d=>`dt=${d}`.padStart(9)).join(' ') + '   (ratio SBS/analytic)';
console.log(header);
for (const r0 of R0S) {
  const W0 = analytic(r0);
  const ratios = DTS.map((dt) => simulate(r0, dt, rng) / W0);
  rows.push({ r0, analytic: W0, dt: DTS, ratios });
  console.log(`  ${String(r0).padStart(8)} ${W0.toFixed(5).padStart(9)} ` + ratios.map(r=>r.toFixed(2).padStart(9)).join(' '));
}
// Largest dt within 15% of analytic, per r0.
console.log(`\nLargest convergent dt (ratio∈[0.85,1.15]) per r0:`);
const conv = {};
for (const row of rows) {
  let best = null;
  for (let i = 0; i < DTS.length; i++) if (row.ratios[i] >= 0.85 && row.ratios[i] <= 1.15) { best = DTS[i]; break; }
  conv[row.r0] = best;
  console.log(`  r0=${String(row.r0).padStart(4)} nm → ${best === null ? 'none of the tested dt converges' : `dt ≤ ${best} ns`}`);
}
const closeDt = conv[1], farDt = conv[100] ?? conv[30];
const verdict = (farDt && (closeDt === null || farDt > closeDt))
  ? 'PASS — far pairs tolerate larger dt than close pairs; cheap C2 SBS is viable'
  : 'FAIL — far pairs need ~same small dt as close pairs; formulation B dead → native runtime';
console.log(`\nVERDICT: ${verdict}`);

const result = { protocol:'E10Q-bridge-farpair-killcriterion', status:'measured', date:'2026-06-01',
  params:{ sigma:SIGMA, D_rel:D_REL, T_ns:T, trials:TRIALS }, rows, convergent_dt:conv, verdict };
console.log('\nRESULT_JSON', JSON.stringify(result));
const outDir = join(REPO_ROOT,'experiments','results','2026-06-01','level-4');
mkdirSync(outDir,{recursive:true});
writeFileSync(join(outDir,'E10Q-farpair-killcriterion.json'), JSON.stringify(result,null,2));
