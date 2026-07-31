struct CU{n:u32,dt:f32,stride:u32,rxn_mode:u32}; // rxn_mode: 0=all except eaq+H3O+, 1=eaq+H3O+ only

@group(0)@binding(0) var<uniform> cu:CU;
@group(0)@binding(1) var<storage,read_write> chem_pos:array<vec4<f32>>;
@group(0)@binding(2) var<storage,read_write> chem_alive:array<atomic<u32>>;
@group(0)@binding(3) var<storage,read_write> chem_rng:array<vec4u>;
// Per-step diagnostic counters (JS zeroes them before each step):
//   [0..2]  live radical count per species (OH, eaq, H) — see countAlive()
//   [3],[4] recombination product-event counters (product kind 1, 2)
@group(0)@binding(4) var<storage,read_write> chem_stats:array<atomic<u32>>;

const PI=3.14159265;
const D_OH=2.2;   // nm²/ns (Geant4: 2.8e-9 m²/s → 2.8 nm²/ns; using Karamitros value)
const D_EAQ=4.9;
const D_H=7.0;
const D_H3O=9.46;  // nm²/ns (G4Hydronium.cc 9.46e-9 m²/s; matches the production worker)

fn rl(x:u32,k:u32)->u32{return(x<<k)|(x>>(32u-k));}
fn rn(s:ptr<function,vec4u>)->u32{let r=rl((*s).x+(*s).w,7u)+(*s).x;let t=(*s).y<<9u;(*s).z^=(*s).x;(*s).w^=(*s).y;(*s).y^=(*s).z;(*s).x^=(*s).w;(*s).z^=t;(*s).w=rl((*s).w,11u);return r;}
fn rf(s:ptr<function,vec4u>)->f32{return f32(rn(s)>>1u)/2147483647.0;}

// Gaussian pair via Box-Muller, returns (g1, g2)
fn gauss2(s:ptr<function,vec4u>)->vec2<f32>{
  let u1=max(rf(s),1e-10);
  let u2=rf(s);
  let r=sqrt(-2.0*log(u1));
  return vec2<f32>(r*cos(2.0*PI*u2),r*sin(2.0*PI*u2));
}

@compute @workgroup_size(256)
fn diffuse(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=cu.n){return;}
  if(atomicLoad(&chem_alive[idx])==0u){return;}
  var pk=chem_pos[idx];
  chem_pos_old[idx]=pk;  // snapshot pre-step position for the bridge react
  // kind encoded as f32 in .w: 0=OH, 1=eaq, 2=H, 3=H3O+
  let kind=i32(round(pk.w));
  var D:f32=D_OH;
  if(kind==1){D=D_EAQ;}
  else if(kind==2){D=D_H;}
  else if(kind==3){D=D_H3O;}
  else if(kind!=0){return;}  // unknown species — skip

  let sigma=sqrt(2.0*D*cu.dt);
  var s=chem_rng[idx];
  let g01=gauss2(&s);
  let g23=gauss2(&s);
  let dx=sigma*g01.x;
  let dy=sigma*g01.y;
  let dz=sigma*g23.x;
  pk.x+=dx;
  pk.y+=dy;
  pk.z+=dz;
  chem_pos[idx]=pk;
  chem_rng[idx]=s;
}

// Radical source buffer for strided sampling at chemistry start.
@group(0)@binding(5) var<storage,read> rad_buf_src:array<vec4<f32>>;
// Spatial hash: cell_head[h] is the index of the first radical in bucket h,
// or -1 if empty. next_idx[i] is the next radical's index in the same bucket.
@group(0)@binding(6) var<storage,read_write> cell_head:array<atomic<i32>>;
@group(0)@binding(7) var<storage,read_write> next_idx:array<i32>;
// Pre-step positions, written by diffuse() before it moves each radical.
// react() uses (old, new) separation pairs for the Brownian-bridge probability.
@group(0)@binding(8) var<storage,read_write> chem_pos_old:array<vec4<f32>>;

const HASH_SIZE:u32=8388608u;  // 2^23 buckets, 32 MB (16M would exceed
                               // maxComputeWorkgroupsPerDimension=65535
                               // at workgroup_size=256 for clear_hash)
// 1.5 nm cells → 4.5 nm search radius. Tested larger cells (3.0 nm → 9.0 nm
// search): same G(H2O2)/G(H2) yields, so those under-predictions aren't
// from missed pair encounters at long dt. They're algorithmic — grid
// diffusion fundamentally undercounts long-time reactions vs IRT.
const CELL_SZ:f32=1.5; // 1.5nm cells × 3-layer = 4.5nm search radius
fn CELL_SIZE()->f32{return CELL_SZ;}

fn hash3(ix:i32,iy:i32,iz:i32)->u32{
  // Teschner 2003 spatial hash (prime constants)
  let h:u32=u32(ix*73856093)^u32(iy*19349663)^u32(iz*83492791);
  return h%HASH_SIZE;
}

// Strided copy from rad_buf[i * stride] → chem_pos[i]. With stride=1 this
// is a plain first-N copy. Kept around for future uniform-sampling work.
//
// rad_buf encodes .w as `pid*8 + species_code` (see primary.wgsl line 254 and
// irt-worker.js line 383). Downstream kernels (diffuse, init_thermal,
// count_alive, match_react) read `.w` as a raw species id in [0..3], so we
// strip the pid with `(w % 8)` here to normalize. Without this, at np>1 only
// primary 0's radicals get recognized and G-values collapse to ~0.001.
@compute @workgroup_size(256)
fn sample_init(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=cu.n){return;}
  let src_idx=idx*cu.stride;
  let raw=rad_buf_src[src_idx];
  let sp=f32(u32(round(raw.w)) % 8u);
  chem_pos[idx]=vec4<f32>(raw.x,raw.y,raw.z,sp);
}

// Clear cell_head to -1. Dispatched over HASH_SIZE / 256 workgroups.
@compute @workgroup_size(256)
fn clear_hash(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=HASH_SIZE){return;}
  atomicStore(&cell_head[idx],-1);
}

// Build spatial hash: each radical atomically exchanges its own index into
// its cell's head pointer, chaining the previous head via next_idx.
@compute @workgroup_size(256)
fn build_hash(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=cu.n){return;}
  if(atomicLoad(&chem_alive[idx])==0u){next_idx[idx]=-1;return;}
  let p=chem_pos[idx];
  let ix=i32(floor(p.x/CELL_SIZE()));
  let iy=i32(floor(p.y/CELL_SIZE()));
  let iz=i32(floor(p.z/CELL_SIZE()));
  let h=hash3(ix,iy,iz);
  let prev=atomicExchange(&cell_head[h],i32(idx));
  next_idx[idx]=prev;
}

// ========== PM-IRT: Parallel Mutual-Minimum Independent Reaction Times ==========
// Novel GPU-native first-passage chemistry. No diffusion — positions fixed.
// Smoluchowski IRT sampled once per pair. Mutual-minimum matching for
// conflict-free parallel reaction processing.
//
// Geant4 reaction radii (Smoluchowski σ from k/(4πD)):
//   OH+OH   σ=0.44  → H2O2      OH+eaq  σ=0.57  → OH⁻
//   OH+H    σ=0.45  → H2O       eaq+eaq σ=0.54  → H2
//   eaq+H   σ=0.61  → H2        eaq+H3O+σ=0.47  → H (Onsager rc=0.71)
//   H+H     σ=0.34  → H2

fn react_sigma(ki:i32,kj:i32)->f32{
  let a=min(ki,kj); let b=max(ki,kj);
  if(a==0&&b==0){return 0.44;}
  if(a==0&&b==1){return 0.57;}
  if(a==0&&b==2){return 0.45;}
  if(a==1&&b==1){return 0.54;}
  if(a==1&&b==2){return 0.61;}
  if(a==1&&b==3){return 0.47;}
  if(a==2&&b==2){return 0.34;}
  return 0.0;
}
fn react_rc(ki:i32,kj:i32)->f32{
  let a=min(ki,kj); let b=max(ki,kj);
  // Onsager radius rc = z_a*z_b*e^2/(4*pi*eps*kT). r0e = rc/(exp(rc/r0)-1)
  // below expects the SIGNED rc: eaq(-1)+H3O(+1) is attractive (z_a*z_b<0), so
  // rc is NEGATIVE and r0e is enhanced. A positive rc suppressed it (ran as if
  // repulsive) — the likely cause of the E11 GPU-vs-worker divergence where
  // G(OH)/G(eaq) ran ~2.2x high at 1 us. Matches the production worker.
  if(a==1&&b==3){return -0.71;}
  return 0.0;
}
fn react_product(ki:i32,kj:i32)->u32{
  let a=min(ki,kj); let b=max(ki,kj);
  if(a==0&&b==0){return 1u;}
  if(a==1&&b==1){return 2u;}
  if(a==1&&b==2){return 2u;}
  if(a==1&&b==3){return 3u;}
  if(a==2&&b==2){return 2u;}
  return 0u;
}

// Diffusion coefficient by species kind (nm²/ns).
fn Dk(k:i32)->f32{
  if(k==1){return D_EAQ;}
  if(k==2){return D_H;}
  if(k==3){return D_H3O;}
  return D_OH;
}

// ============================================================================
// SBS reaction with Green's-function Brownian-bridge probability.
// (NOTE: gMicroMC/MPEXS-DNA themselves use the simpler Smoluchowski
// reaction-RADIUS contact test — react when r ≤ σ at a step — not this bridge.
// The bridge below is from the step-by-step / Green's-function chemistry
// literature, tried here as a refinement over that contact test.)
// 2026-06-01: replaces the naive end-position contact test (which needed
// dt ≲ 0.01 ns → ~8000 steps to 1 µs, 4.6× slower than IRT in E10L).
//
// For a pair whose relative separation went from r0 (pre-step) to r1 (post-
// step) over dt, the probability the path touched the encounter radius σ
// DURING the step is the absorbing Brownian-bridge hitting probability:
//   r1 ≤ σ                → reacted (contact)
//   else  W = (σ/r1)·exp[ -(r0-σ)(r1-σ) / (D·dt) ],  D = Di+Dj
// Unlike the cumulative first-passage CDF W(dt|r0) (which over-reacts when
// compounded across steps — E10M v1: 730 steps gave G(eaq) 0.19× vs IRT),
// the per-step bridge is the correct independent increment given endpoints,
// so the scheme CONVERGES as the step count rises. Charged pairs use the
// Onsager-screened separation for both endpoints.
// ============================================================================
@compute @workgroup_size(256)
fn react(@builtin(global_invocation_id) gid:vec3u){
  let i=gid.x;
  if(i>=cu.n){return;}
  if(atomicLoad(&chem_alive[i])==0u){return;}
  let pi=chem_pos[i];
  let ki=i32(round(pi.w));
  if(ki<0||ki>3){return;}

  var s=chem_rng[i];
  let ix=i32(floor(pi.x/CELL_SIZE()));
  let iy=i32(floor(pi.y/CELL_SIZE()));
  let iz=i32(floor(pi.z/CELL_SIZE()));

  for(var dz:i32=-1;dz<=1;dz=dz+1){
    for(var dy:i32=-1;dy<=1;dy=dy+1){
      for(var dx:i32=-1;dx<=1;dx=dx+1){
        let h=hash3(ix+dx,iy+dy,iz+dz);
        var j:i32=atomicLoad(&cell_head[h]);
        for(var iter:u32=0u;iter<1024u&&j>=0;iter=iter+1u){
          let ju=u32(j);
          let jnext=next_idx[ju];
          if(ju<=i){j=jnext;continue;}
          if(atomicLoad(&chem_alive[ju])==0u){j=jnext;continue;}
          let pj=chem_pos[ju];
          let kj=i32(round(pj.w));
          if(kj<0||kj>3){j=jnext;continue;}

          let R=react_sigma(ki,kj);
          if(R<=0.0){j=jnext;continue;}
          let rc=react_rc(ki,kj);
          let Dsum=Dk(ki)+Dk(kj);
          // r1 = post-step separation (current positions), r0 = pre-step (snapshot).
          let dnew=pi.xyz-pj.xyz;
          var r1=sqrt(dot(dnew,dnew));
          let dold=chem_pos_old[i].xyz-chem_pos_old[ju].xyz;
          var r0=sqrt(dot(dold,dold));
          // Onsager-screened effective separations for charged pairs.
          if(rc!=0.0){
            r0=-rc/(1.0-exp(rc/r0));
            r1=-rc/(1.0-exp(rc/r1));
          }
          // Brownian-bridge reaction probability for this step (see header).
          var W:f32;
          if(r1<=R||r0<=R){
            W=1.0;
          } else {
            W=(R/r1)*exp(-(r0-R)*(r1-R)/(Dsum*cu.dt));
          }
          if(rf(&s)>=W){j=jnext;continue;}

          let claim_i=atomicCompareExchangeWeak(&chem_alive[i],1u,0u);
          if(!claim_i.exchanged){chem_rng[i]=s;return;}
          let claim_j=atomicCompareExchangeWeak(&chem_alive[ju],1u,0u);
          if(!claim_j.exchanged){atomicStore(&chem_alive[i],1u);j=jnext;continue;}

          let prod=react_product(ki,kj);
          if(prod==1u){atomicAdd(&chem_stats[3],1u);}
          else if(prod==2u){atomicAdd(&chem_stats[4],1u);}
          else if(prod==3u){
            if(ki==1){var p=chem_pos[i];p.w=2.0;chem_pos[i]=p;atomicStore(&chem_alive[i],1u);}
            else{var p=chem_pos[ju];p.w=2.0;chem_pos[ju]=p;atomicStore(&chem_alive[ju],1u);}
          }
          chem_rng[i]=s;
          return;
        }
      }
    }
  }
  chem_rng[i]=s;
}

// match_react stub (unused in diffusion mode, needed for pipeline)
@compute @workgroup_size(256)
fn match_react(@builtin(global_invocation_id) gid:vec3u){}

// Count alive radicals per species into chem_stats[0..2]. JS zeros those
// slots before dispatch, reads back after. Call once per checkpoint.
@compute @workgroup_size(256)
fn count_alive(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=cu.n){return;}
  if(atomicLoad(&chem_alive[idx])==0u){return;}
  let kind=i32(round(chem_pos[idx].w));
  if(kind<0||kind>3){return;}
  if(kind<=2){atomicAdd(&chem_stats[u32(kind)],1u);}
  // H3O+ (kind=3) not counted in G-value stats — it's an intermediate
}

// Pre-chemistry thermalization: apply species-specific Gaussian offsets to
// each radical's initial position. In Geant4-DNA:
//   e⁻aq: hot electron diffuses several nm before hydrating (~6 nm RMS)
//   OH•:  small recoil from H3O+ decomposition (~0.3 nm)
//   H•:   from dissociative excitation, small offset (~0.3 nm)
// Without this step, OH and e⁻aq born at the same coordinate from a single
// ionization react immediately (pc~0.98), annihilating e⁻aq completely.
@compute @workgroup_size(256)
fn init_thermal(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=cu.n){return;}
  if(atomicLoad(&chem_alive[idx])==0u){return;}
  var p=chem_pos[idx];
  var kind=i32(round(p.w));
  var s=chem_rng[idx];
  // Geant4 G4DNAWaterDissociationDisplacer: Gaussian with sigma_1D per axis
  // gauss2() returns N(0,1), so sigma values here = per-axis std directly.
  var sigma:f32=0.0;
  if(kind==0){sigma=0.462;}      // OH: RMS=0.8nm, sigma_1D=0.8/sqrt(3)
  else if(kind==1){sigma=1.764;} // eaq: Meesungnoen2002 at ke=1.7eV, r_mean=2.815nm
  else if(kind==2){sigma=1.309;} // H: A1B1, 17/18 * 2.4/sqrt(3)
  else if(kind==3){              // H3O+: 50% displaced, 50% at origin
    if(rf(&s)<0.5){sigma=0.462;}else{sigma=0.0;}
  }
  else if(kind==5){              // pre-thermalized eaq (primary.wgsl stores at
    kind=1;                      // already-displaced epx/epy/epz) — just promote
    sigma=0.0;                   // to kind=1 with zero extra displacement, matching
  }                              // irt-worker.js line 486-488
  else{return;}
  // eaq + H3O+ → H + H2O is a diffusion-controlled reaction in Geant4
  // (k=2.11e10 L/mol/s), NOT a prompt pre-chemistry step. Removing the
  // fake V3g Bernoulli conversion. The reaction will be handled by the
  // chemistry stage once H3O+ is tracked as a diffusing species.
  // For now, without H3O+ tracking, this reaction is missing — G(eaq)
  // will be slightly high and G(H) slightly low vs Karamitros.
  if(false){
    if(rf(&s)<0.0){
      kind=2;        // disabled: was fake V3g conversion
      sigma=0.3;     // H thermalization distance
    }
  }
  let g01=gauss2(&s);
  let g23=gauss2(&s);
  p.x=p.x+sigma*g01.x;
  p.y=p.y+sigma*g01.y;
  p.z=p.z+sigma*g23.x;
  p.w=f32(kind);  // persist possibly-changed species
  chem_pos[idx]=p;
  chem_rng[idx]=s;
}
