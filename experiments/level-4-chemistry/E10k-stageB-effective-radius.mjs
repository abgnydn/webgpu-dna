// E10k stage B — effective reaction radius under cross-primary IRT.
//
// Stage A showed the 551 nm horizon makes the spatial-hash scan 758× the
// doc's estimate (5.1e12 checks) because the horizon spans the whole ~5 µm
// point-source blob, so hashing barely prunes. The deciding question:
//
//   Is the 551 nm horizon actually USED, or do ~all accepted reactions come
//   from short separations? sampleIRT rejects distant pairs stochastically
//   (survival prob ∝ ~σ/r0). If 99.9% of accepted reactions are < R_eff
//   with R_eff ≪ 551 nm, then an R_eff-cutoff initial-pair build is lossless
//   in practice, makes the hash tractable (blob = many R_eff cells), and
//   makes an R_eff-halo swarm viable.
//
// Method: faithfully reproduce the worker's displacement + reaction sampling
// (ported verbatim from public/irt-worker.js), sample K source radicals,
// scan their FULL 551 nm neighborhood, call sampleIRT on every reactive
// pair, and histogram the separation of ACCEPTED (t ∈ [0,1000)) reactions.
// Reports the cumulative capture fraction vs cutoff and the implied
// spatial-hash cost at the effective cutoff.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BIN_PATH = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RECORD_BYTES = 16;
const R_CUT = 1.45 + 2 * Math.sqrt(8 * 9.46 * 1000); // 551.65 nm
const R_CUT2 = R_CUT * R_CUT;
const CELL = R_CUT;
const K_SOURCES = 400;        // sampled source radicals
const SEED = 0xC0FFEE;        // named-ish seed for reproducibility

// ---- seeded RNG (mulberry32), installed as Math.random for determinism ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
Math.random = rng;

// ===================== ported verbatim from irt-worker.js =====================
function erfcinv(x){if(x<=0||x>=2)return 0;const p=x>1?2-x:x;const t=Math.sqrt(-2*Math.log(p/2));let y=t-(2.515517+0.802853*t+0.010328*t*t)/(1+1.432788*t+0.189269*t*t+0.001308*t*t*t);y*=0.7071067811865475;return x>1?-y:y;}
function randn(){return Math.sqrt(-2*Math.log(Math.random()+1e-30))*Math.cos(6.2831853*Math.random());}
const F_CLF=Math.SQRT2;
function clf6(){return (Math.random()+Math.random()+Math.random()+Math.random()+Math.random()+Math.random()-3)*F_CLF;}
function erfcx(x){if(x<0)return 2*Math.exp(x*x)-erfcx(-x);if(x>=6){let f=0;for(let n=30;n>=1;n--)f=(0.5*n)/(x+f);return 0.5641895835477563/(x+f);}const t=2.0/(2.0+x);const ty=4*t-2;const c=[-1.3026537197817094,6.4196979235649026e-1,1.9476473204185836e-2,-9.561514786808631e-3,-9.46595344482036e-4,3.66839497852761e-4,4.2523324806907e-5,-2.0278578112534e-5,-1.624290004647e-6,1.303655835580e-6,1.5626441722e-8,-8.5238095915e-8,6.529054439e-9,5.059343495e-9,-9.91364156e-10,-2.27365122e-10,9.6467911e-11,2.394038e-12,-6.886027e-12,8.94487e-13,3.13092e-13,-1.12708e-13,3.81e-16,7.106e-15,-1.523e-15,-9.4e-17,1.21e-16,-2.8e-17];let d=0,dd=0;for(let j=c.length-1;j>0;j--){const tmp=d;d=ty*d-dd+c[j];dd=tmp;}return t*Math.exp(0.5*(c[0]+ty*d)-dd);}
function SamplePDC(a,b){const p=2.0*Math.sqrt(2.0*b/a);const q=2.0/Math.sqrt(2.0*b/a);const M=Math.max(1.0/(a*a),3.0*b/a);for(let trial=0;trial<10000;trial++){let U=Math.random();let X;if(U<p/(p+q*M)){X=Math.pow(U*(p+q*M)/2,2);}else{X=Math.pow(2/((1-U)*(p+q*M)/M),2);}U=Math.random();const sqX=Math.sqrt(X);const lambdax=Math.exp(-b*b/X)*(1.0-a*Math.sqrt(Math.PI*X)*erfcx(b/sqX+a*sqX));if((X<=2.0*b/a&&U<=lambdax)||(X>=2.0*b/a&&U*M/X<=lambdax)){return X;}}return -1.0;}
function sampleIRT_type0(r0,sigma,rc,D){if(sigma<=0||D<=0)return -1;if(r0<=sigma)return 0;let r0e=r0;if(rc!==0)r0e=-rc/(1-Math.exp(rc/r0));if(r0e<=sigma)return 0;const Winf=sigma/r0e;const U=Math.random();if(U<=0||U>=Winf)return -1;const ei=erfcinv(r0e*U/sigma);if(Math.abs(ei)<1e-10)return -1;const dr=r0e-sigma;return 0.25*dr*dr/(D*ei*ei);}
function sampleIRT_type1(r0,ri,D){const sigma_c=rxnSigma[ri];const rc=rxnRc[ri];const kobs_nm=RXN_TABLE[ri].k*K_CONV;const kdif_nm=rxnKdif[ri];const kact_nm=rxnKact[ri];const prob=rxnProb[ri];let a,b;let sigma_check=sigma_c;let r0_check=r0;if(rc===0){a=(1.0/sigma_c)*kact_nm/kobs_nm;b=(r0-sigma_c)/2;}else{const v=kact_nm/(4*Math.PI*sigma_c*sigma_c*Math.exp(-rc/sigma_c));const alpha=v+rc*D/(sigma_c*sigma_c*(1-Math.exp(-rc/sigma_c)));const sinh_half=Math.sinh(rc/(2*sigma_c));a=4*sigma_c*sigma_c*alpha/(D*rc*rc)*sinh_half*sinh_half;b=rc/4*(Math.cosh(rc/(2*r0))/Math.sinh(rc/(2*r0))-Math.cosh(rc/(2*sigma_c))/Math.sinh(rc/(2*sigma_c)));r0_check=-rc/(1-Math.exp(rc/r0));sigma_check=rxnSigmaEff[ri];}if(sigma_check>r0_check){if(prob>Math.random())return 0;return -1;}const Winf=sigma_check/r0_check*kobs_nm/kdif_nm;if(Winf>Math.random()){const X=SamplePDC(a,b);if(X>0)return X/D;}return -1;}
function sampleIRT(r0,ri,D){if(RXN_TABLE[ri].type===0){return sampleIRT_type0(r0,rxnSigma[ri],rxnRc[ri],D);}else{return sampleIRT_type1(r0,ri,D);}}

const N_SPECIES=6;
const IRT_D=[2.2,4.9,7.0,9.46,2.3,5.3];
const VDW_R=[0.22,0.50,0.19,0.25,0.21,0.33];
const CHARGE=[0,-1,0,1,0,-1];
const ONSAGER_FACTOR=1.44/(0.02527*80.1);
const Rs_PDC=0.29;
const K_CONV=1e24/(6.022e23*1e9);
const RXN_TABLE=[
  {a:0,b:0,k:0.55e10,prods:[4],type:1},{a:0,b:1,k:2.95e10,prods:[5],type:1},
  {a:0,b:2,k:1.55e10,prods:[],type:1},{a:1,b:1,k:0.636e10,prods:[5,5],type:0},
  {a:1,b:2,k:2.50e10,prods:[5],type:0},{a:1,b:3,k:2.11e10,prods:[2],type:1},
  {a:2,b:2,k:0.503e10,prods:[],type:0},{a:1,b:4,k:1.10e10,prods:[5,0],type:1},
  {a:3,b:5,k:1.13e11,prods:[],type:0},
];
const N_RXN=RXN_TABLE.length;
const rxnSigma=new Float64Array(N_RXN),rxnSigmaEff=new Float64Array(N_RXN),rxnRc=new Float64Array(N_RXN),rxnKdif=new Float64Array(N_RXN),rxnKact=new Float64Array(N_RXN),rxnProb=new Float64Array(N_RXN);
for(let r=0;r<N_RXN;r++){const{a,b,k,type}=RXN_TABLE[r];const D_sum=IRT_D[a]+IRT_D[b];const is_self=(a===b);const rc=CHARGE[a]*CHARGE[b]*ONSAGER_FACTOR;rxnRc[r]=rc;const k_nm=k*K_CONV;if(type===0){let sig=k_nm/(4*Math.PI*D_sum);if(is_self)sig*=2;rxnSigma[r]=sig;rxnSigmaEff[r]=sig;rxnKdif[r]=0;rxnKact[r]=0;rxnProb[r]=1;}else{const sigma_c=VDW_R[a]+VDW_R[b];rxnSigma[r]=sigma_c;let sig_eff,kdif_nm;if(rc===0){sig_eff=sigma_c;kdif_nm=4*Math.PI*D_sum*sigma_c;if(is_self)kdif_nm/=2;}else{sig_eff=-rc/(1-Math.exp(rc/sigma_c));kdif_nm=4*Math.PI*D_sum*sig_eff;if(is_self)kdif_nm/=2;}rxnSigmaEff[r]=sig_eff;rxnKdif[r]=kdif_nm;const kact_nm=kdif_nm*k_nm/(kdif_nm-k_nm);rxnKact[r]=kact_nm;rxnProb[r]=Rs_PDC/(Rs_PDC+(kdif_nm/kact_nm)*(sig_eff+Rs_PDC));}}
const rxnMap=new Int8Array(N_SPECIES*N_SPECIES).fill(-1);
for(let r=0;r<N_RXN;r++){rxnMap[RXN_TABLE[r].a*N_SPECIES+RXN_TABLE[r].b]=r;rxnMap[RXN_TABLE[r].b*N_SPECIES+RXN_TABLE[r].a]=r;}
const r_mean_eaq=(()=>{const g=[-4.06217193e-08,3.06848412e-06,-9.93217814e-05,1.80172797e-03,-2.01135480e-02,1.42939448e-01,-6.48348714e-01,1.85227848e+00,-3.36450378e+00,4.37785068e+00,-4.20557339e+00,3.81679083e+00,-2.34069784e-01];const k=1.7;let r=0;for(let i=12;i>=0;i--)r+=g[12-i]*Math.pow(k,i);return r;})();
const CONVERT_RMEAN_TO_SIGMA=0.62665706865775006;
const SIGMA_MOTHER=2.0/Math.sqrt(3);
const SIGMA_OH_PROD=0.8/Math.sqrt(3);
const SIGMA_H_EXCITATION=(17/18)*2.4/Math.sqrt(3);
const SIGMA_EAQ_AUTO=r_mean_eaq*CONVERT_RMEAN_TO_SIGMA;
// =============================================================================

if(!existsSync(BIN_PATH)){console.error('missing',BIN_PATH);process.exit(1);}
console.log('Loading',BIN_PATH);
const buf=readFileSync(BIN_PATH);
const nRec=buf.length/RECORD_BYTES;
const f32=new Float32Array(buf.buffer,buf.byteOffset,buf.byteLength/4);

// Build displaced global pool (worker Phase-3 displacement logic, all primaries).
const px=new Float64Array(nRec),py=new Float64Array(nRec),pz=new Float64Array(nRec);
const sp=new Int8Array(nRec); // worker species index, or -1 to skip
let nPart=0;
for(let i=0;i<nRec;i++){
  const off=i*4;let x=f32[off],y=f32[off+1],z=f32[off+2];const s=Math.round(f32[off+3])%8;
  let ws=-1;
  if(s===5){ws=1;}
  else if(s===0){ws=0;if(Math.random()<0.5){x+=SIGMA_OH_PROD*clf6();y+=SIGMA_OH_PROD*clf6();z+=SIGMA_OH_PROD*clf6();}}
  else if(s===3){ws=3;if(Math.random()<0.5){x+=SIGMA_OH_PROD*clf6();y+=SIGMA_OH_PROD*clf6();z+=SIGMA_OH_PROD*clf6();}}
  else if(s===1){ws=1;x+=SIGMA_EAQ_AUTO*clf6();y+=SIGMA_EAQ_AUTO*clf6();z+=SIGMA_EAQ_AUTO*clf6();}
  else if(s===2){ws=2;x+=SIGMA_H_EXCITATION*clf6();y+=SIGMA_H_EXCITATION*clf6();z+=SIGMA_H_EXCITATION*clf6();}
  else if(s===6){ws=5;}
  sp[i]=ws;px[i]=x;py[i]=y;pz[i]=z;
  if(ws>=0)nPart++;
}
console.log(`Pool built: ${nPart} particles (displaced).`);

// Spatial hash at 551 nm.
const cellKey=(cx,cy,cz)=>cx*73856093^cy*19349663^cz*83492791;
const hash=new Map();
for(let i=0;i<nRec;i++){if(sp[i]<0)continue;const cx=Math.floor(px[i]/CELL),cy=Math.floor(py[i]/CELL),cz=Math.floor(pz[i]/CELL);const k=cellKey(cx,cy,cz)>>>0;let arr=hash.get(k);if(!arr){arr=[];hash.set(k,arr);}arr.push(i);}

// Sample K source radicals, scan full 551 nm neighborhood, sample reactions.
const partIdx=[];for(let i=0;i<nRec;i++)if(sp[i]>=0)partIdx.push(i);
const bins=[0.5,1,2,5,10,20,50,100,200,551.65]; // upper edges (nm)
const acc=new Float64Array(bins.length); // accepted reactions per bin
const totReactivePairs=new Float64Array(bins.length);
let nAccepted=0,nReactiveChecks=0;
const t0=performance.now();
for(let s=0;s<K_SOURCES;s++){
  const i=partIdx[Math.floor(Math.random()*partIdx.length)];
  const si=sp[i],Di=IRT_D[si];if(Di===0)continue;
  const cx=Math.floor(px[i]/CELL),cy=Math.floor(py[i]/CELL),cz=Math.floor(pz[i]/CELL);
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){
    const arr=hash.get(cellKey(cx+dx,cy+dy,cz+dz)>>>0);if(!arr)continue;
    for(const j of arr){
      if(j===i||sp[j]<0)continue;const sj=sp[j];const ri=rxnMap[si*N_SPECIES+sj];if(ri<0)continue;
      const ddx=px[i]-px[j],ddy=py[i]-py[j],ddz=pz[i]-pz[j];const r2=ddx*ddx+ddy*ddy+ddz*ddz;
      if(r2>R_CUT2)continue;const r0=Math.sqrt(r2);
      // bin index
      let bi=bins.length-1;for(let b=0;b<bins.length;b++){if(r0<=bins[b]){bi=b;break;}}
      totReactivePairs[bi]++;nReactiveChecks++;
      const t=sampleIRT(r0,ri,Di+IRT_D[sj]);
      if(t>=0&&t<1000){acc[bi]++;nAccepted++;}
    }
  }
}
const wall=performance.now()-t0;

console.log(`\nSampled ${K_SOURCES} sources, ${nReactiveChecks} reactive-pair checks, ${nAccepted} accepted reactions (${wall.toFixed(0)} ms)`);
console.log(`\nAccepted-reaction separation distribution:`);
let cum=0;const cumFrac=[];
console.log(`  ${'<= nm'.padStart(8)} ${'accepted'.padStart(10)} ${'cum %'.padStart(8)} ${'reactive-pairs'.padStart(15)} ${'accept-rate'.padStart(12)}`);
for(let b=0;b<bins.length;b++){
  cum+=acc[b];const frac=nAccepted>0?cum/nAccepted:0;cumFrac.push(frac);
  const rate=totReactivePairs[b]>0?acc[b]/totReactivePairs[b]:0;
  console.log(`  ${bins[b].toString().padStart(8)} ${acc[b].toString().padStart(10)} ${(frac*100).toFixed(2).padStart(8)} ${totReactivePairs[b].toString().padStart(15)} ${(rate*100).toFixed(3).padStart(11)}%`);
}

// Effective cutoff capturing 99% and 99.9% of accepted reactions.
function cutoffFor(target){for(let b=0;b<bins.length;b++)if(cumFrac[b]>=target)return bins[b];return bins[bins.length-1];}
const R99=cutoffFor(0.99),R999=cutoffFor(0.999);
console.log(`\nEffective cutoff: R(99%) = ${R99} nm, R(99.9%) = ${R999} nm  (vs R_CUT = 551.65 nm)`);

// Implied spatial-hash scan cost at R_eff: scan cost ~ N × density × (4/3 π R_eff³).
// Use mean density from stage A blob volume.
const blobVol=(2539-(-2461))*(2144-(-2665))*(2181-(-2245)); // nm³
const meanDensity=nPart/blobVol;
function scanCostAt(R){const cellsAcross=5000/R;return nPart*meanDensity*(4/3)*Math.PI*R*R*R;}
console.log(`\nImplied 3×3×3 scan cost (mean-density estimate):`);
console.log(`  at 551 nm: ${scanCostAt(551.65).toExponential(2)} checks (measured exact in stage A: 5.11e12)`);
console.log(`  at R(99.9%)=${R999} nm: ${scanCostAt(R999).toExponential(2)} checks`);
console.log(`  speedup from using R_eff: ${(scanCostAt(551.65)/scanCostAt(R999)).toExponential(1)}×`);

const result={
  k_sources:K_SOURCES,seed:SEED,reactive_checks:nReactiveChecks,accepted:nAccepted,wall_ms:wall,
  bins_nm:bins,accepted_per_bin:[...acc],reactive_pairs_per_bin:[...totReactivePairs],cum_fraction:cumFrac,
  R_eff_99_nm:R99,R_eff_999_nm:R999,R_CUT_nm:R_CUT,
  scan_cost_at_R_CUT:scanCostAt(551.65),scan_cost_at_R999:scanCostAt(R999),
};
console.log('\nRESULT_JSON',JSON.stringify(result));
const outDir=join(REPO_ROOT,'experiments','results','2026-06-01','level-4');
mkdirSync(outDir,{recursive:true});
writeFileSync(join(outDir,'E10k-stageB.json'),JSON.stringify(result,null,2));
console.log('\nWrote stage-B result.');
