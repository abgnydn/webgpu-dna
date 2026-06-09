// Proton primary tracking — Geant4-DNA option2 ConstructDNAProtonPhysics.
// One GPU thread per proton; full history in a for loop. Energy loss by Rudd
// ionisation (<500 keV) / Born (>500 keV) and Miller-Green excitation
// (<500 keV) / Born (>500 keV). Protons are ~1836x heavier than electrons, so
// they travel essentially straight (no elastic deflection of the primary) —
// the track is a near-straight line; the physics is the energy-loss spectrum.
// Ejected electrons are emitted into sec_buf and handled by the EXISTING
// electron cascade (secondary.wgsl) + chemistry. Compiled with
// cross_sections.wgsl + proton_cross_sections.wgsl + helpers.wgsl.

// --- bindings + structs (same layout as primary.wgsl; compiled standalone) ---
struct P{
  n:u32,box:f32,ce:f32,ms:u32,
  be:f32,max_sec:u32,vc:u32,max_rad:u32,
  start_half:f32,dna_enable:u32,dna_grid_n:u32,_pad3:u32,
  dna_rise:f32,dna_spacing:f32,dna_x0:f32,dna_r_bb:f32,
};
struct R{path:f32,prod:f32,fE:f32,ni:u32,nx:u32,esc:u32,mx:f32,_pad:u32};
struct Particle{pos_E:vec4<f32>,dir_alive:vec4<f32>,rng:vec4<u32>};
@group(0)@binding(0) var<uniform> p:P;
@group(0)@binding(1) var<storage,read_write> results:array<R>;
@group(0)@binding(2) var<storage,read_write> rng:array<vec4u>;
@group(0)@binding(3) var<storage,read_write> dbg:array<atomic<u32>>;
@group(0)@binding(4) var<storage,read_write> rad_buf:array<vec4<f32>>;
@group(0)@binding(5) var<storage,read_write> sec_buf:array<Particle>;
@group(0)@binding(6) var<storage,read_write> dose:array<atomic<u32>>;
@group(0)@binding(7) var<storage,read_write> counters:array<atomic<u32>>;

// --- proton physics constants ---
const PROTON_BORN_E:f32 = 500000.0;       // eV — Rudd below, Born above (option2)
const PROTON_CE:f32     = 100.0;          // eV — proton tracking cutoff (Rudd data floor)
const M_E_OVER_M_P:f32  = 5.446170e-4;    // electron_mass / proton_mass
// Water ionisation energies (G4DNAWaterIonisationStructure) — energy deposited per shell
const PWION=array<f32,5>(10.79,13.39,16.05,32.30,539.0);
// Rudd binding Bj (Dingfelder priv. comm) used in the differential formula
const RBJ=array<f32,5>(12.60,14.70,18.40,32.20,540.0);
const RGJ=array<f32,5>(0.99,1.11,1.11,0.52,1.0);
// Miller-Green excitation (Dingfelder 2000 / Miller-Green 1973), proton zEff=1, nu=1
const MG_S0:f32 = 0.01;                   // 1e8 barn in nm^2
const MGA=array<f32,5>(876.0,2084.0,1373.0,692.0,900.0);
const MGJ=array<f32,5>(19820.0,23490.0,27770.0,30830.0,33080.0);
const MGW=array<f32,5>(0.85,0.88,0.88,0.78,0.78);
const MGE=array<f32,5>(8.17,10.13,11.31,12.91,14.50);  // Miller-Green liquid excitation levels

// Fixed-point dose deposit (same as primary.wgsl).
fn deposit(px:f32,py:f32,pz:f32,dep_eV:f32,box:f32,vc:u32){
  if(dep_eV<=0.0){return;}
  let vs=2.0*box/f32(vc);
  let ix=i32(floor((px+box)/vs));
  let iy=i32(floor((py+box)/vs));
  let iz=i32(floor((pz+box)/vs));
  let n=i32(vc);
  if(ix<0||ix>=n||iy<0||iy>=n||iz<0||iz>=n){return;}
  let vi=u32((iz*n+iy)*n+ix);
  atomicAdd(&dose[vi],u32(dep_eV*100.0));
}

// Lower grid index for E on the proton log grid (for per-shell fractions).
fn p_idx(e:f32)->u32{
  if(e<=PE[0]){return 0u;}
  if(e>=PE[PN-1u]){return PN-1u;}
  let fi=(log(e)-PLOG0)*PINV_LOG_STEP;
  return u32(clamp(fi,0.0,f32(PN)-1.0));
}

// O(1) log-indexed interpolation on the proton grid (PE/PLOG0/PINV_LOG_STEP).
fn p_interp(idx:i32, e:f32)->f32{
  if(e<=PE[0]||e>=PE[PN-1u]){return 0.0;}
  let fi=(log(e)-PLOG0)*PINV_LOG_STEP;
  let i=u32(clamp(fi,0.0,f32(PN)-2.0));
  let f=fi-f32(i);
  // arrays: 0=PRI 1=PBI 2=PBX
  var a:f32; var b:f32;
  if(idx==0){a=PRI[i];b=PRI[i+1u];}
  else if(idx==1){a=PBI[i];b=PBI[i+1u];}
  else{a=PBX[i];b=PBX[i+1u];}
  return max(0.0,a+(b-a)*f);
}

// Miller-Green partial excitation cross section (nm^2), proton, level j.
fn mg_partial(t:f32,j:u32)->f32{
  if(t<=MGE[j]){return 0.0;}
  let pw=MGW[j]+1.0;                      // omegaj + nu (nu=1)
  let num=pow(10.0*MGA[j],MGW[j])*(t-MGE[j]);
  let den=pow(MGJ[j],pw)+pow(t,pw);
  return MG_S0*num/den;                   // zEff^2 = 1 for protons
}
fn mg_total(t:f32)->f32{
  var s=0.0;
  for(var j=0u;j<5u;j++){s+=mg_partial(t,j);}
  return s;
}

// Rudd differential ds/dw (un-normalised shape) for secondary KE sampling.
// w = secondary_KE / Bj[shell]; k = proton KE (eV).
fn rudd_shape(k:f32,w:f32,j:u32)->f32{
  if(w<0.0){return 0.0;}
  let bj=RBJ[j];
  // non-K-shell parameters (j<4); K shell (j==4) handled with its set
  var A1=1.02;var B1=82.0;var C1=0.45;var D1=-0.80;var E1=0.38;
  var A2=1.07;var B2=11.6;var C2=0.60;var D2=0.04;var al=0.64;
  if(j==4u){A1=1.25;B1=0.5;C1=1.0;D1=1.0;E1=3.0;A2=1.10;B2=1.30;C2=1.0;D2=0.0;al=0.66;}
  let Ry=13.6;
  let tau=M_E_OVER_M_P*k;
  let v2=tau/bj; let v=sqrt(v2);
  let wc=4.0*v2-2.0*v-(Ry/(4.0*bj));
  let L1=(C1*pow(v,D1))/(1.0+E1*pow(v,D1+4.0));
  let L2=C2*pow(v,D2);
  let H1=(A1*log(1.0+v2))/(v2+(B1/v2));
  let H2=(A2/v2)+(B2/(v2*v2));
  let F1=L1+H1;
  let F2=(L2*H2)/(L2+H2);
  let denom=pow(1.0+w,3.0)*(1.0+exp(al*(w-wc)/v));
  return max(0.0,(F1+w*F2)/denom);        // Gj*S/Bj factored out (shape only)
}

// Sample secondary electron KE (eV) from the Rudd differential.
// Factor the dominant 1/(1+w)^3 into the envelope (samplable by inverse CDF) and
// reject against the smooth residual (F1+w*F2)/(1+exp(...)) — high acceptance at
// all proton energies (uniform-w rejection fails ~99% at high E where wmax is large).
fn sample_rudd_ke(k:f32,j:u32,s:ptr<function,vec4<u32>>)->f32{
  let bj=RBJ[j];
  var A1=1.02;var B1=82.0;var C1=0.45;var D1=-0.80;var E1=0.38;
  var A2=1.07;var B2=11.6;var C2=0.60;var D2=0.04;var al=0.64;
  if(j==4u){A1=1.25;B1=0.5;C1=1.0;D1=1.0;E1=3.0;A2=1.10;B2=1.30;C2=1.0;D2=0.0;al=0.66;}
  let Ry=13.6;
  let tau=M_E_OVER_M_P*k;
  let v2=tau/bj; let v=sqrt(v2);
  let wc=4.0*v2-2.0*v-(Ry/(4.0*bj));
  let L1=(C1*pow(v,D1))/(1.0+E1*pow(v,D1+4.0));
  let L2=C2*pow(v,D2);
  let H1=(A1*log(1.0+v2))/(v2+(B1/v2));
  let H2=(A2/v2)+(B2/(v2*v2));
  let F1=L1+H1;
  let F2=(L2*H2)/(L2+H2);
  let wmax=max(0.0,4.0*M_E_OVER_M_P*k)/bj + 2.0;
  let umax=1.0-1.0/(1.0+wmax);
  // 1/(1+w)^2 envelope (heavier tail — the mean energy loss falls only as ~1/(1+w),
  // dominated by hard collisions near the wc cutoff). Reject against the residual
  // (F1+w*F2)/(1+w), bounded by max(F1,F2) (monotone in w until the cutoff).
  let Cmax=max(F1,F2)*1.3+1e-9;
  for(var t=0u;t<48u;t++){
    let u=rf(s)*umax;
    let w=u/(1.0-u);                       // ~ 1/(1+w)^2 envelope
    let val=(F1+w*F2)/((1.0+w)*(1.0+exp(al*(w-wc)/v)));
    if(rf(s)*Cmax<=val){return w*bj;}
  }
  return 0.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
  let id=gid.x;
  if(id>=p.n){return;}
  var s=rng[id];
  // proton starts at origin, +x direction (matches electron primary convention)
  var px=0.0; var py=0.0; var pz=0.0;
  let off=p.start_half;
  if(off>0.0){px=(rf(&s)*2.0-1.0)*off;py=(rf(&s)*2.0-1.0)*off;pz=(rf(&s)*2.0-1.0)*off;}
  var dx=1.0; var dy=0.0; var dz=0.0;
  var E=p.be;                              // proton initial KE (eV), passed in p.be
  var path=0.0; var nion=0u; var nexc=0u; var dep=0.0;

  for(var step=0u;step<p.ms;step++){
    if(E<PROTON_CE){break;}
    if(abs(px)>=p.box||abs(py)>=p.box||abs(pz)>=p.box){results[id].esc=1u;break;}

    var sig_ion:f32; var sig_exc:f32;
    if(E<PROTON_BORN_E){ sig_ion=p_interp(0,E); sig_exc=mg_total(E); }
    else{ sig_ion=p_interp(1,E); sig_exc=p_interp(2,E); }
    let sig_tot=sig_ion+sig_exc;
    if(sig_tot<=0.0){break;}

    let lambda=1.0/(NW*sig_tot);
    let dist=-log(max(rf(&s),1e-10))*lambda;
    px+=dx*dist; py+=dy*dist; pz+=dz*dist; path+=dist;

    if(rf(&s)*sig_tot<sig_ion){
      // ---- ionisation: pick shell (Rudd per-shell fractions) ----
      let pidx=p_idx(E);
      let rs=rf(&s);
      var sh=0u; var acc=0.0;
      for(var k=0u;k<5u;k++){
        var fr:f32;
        if(k==0u){fr=PRF0[pidx];}else if(k==1u){fr=PRF1[pidx];}
        else if(k==2u){fr=PRF2[pidx];}else if(k==3u){fr=PRF3[pidx];}
        else{fr=PRF4[pidx];}
        acc+=fr; if(rs<=acc){sh=k;break;}
      }
      let bind=PWION[sh];
      let ke=sample_rudd_ke(E,sh,&s);      // ejected electron KE (eV)
      E-=(bind+ke);
      dep+=bind;
      nion++;
      deposit(px,py,pz,bind,p.box,p.vc);
      // ionisation products: OH + H3O+ at the proton site (mother displacement
      // handled in chemistry); defer eaq to the ejected electron's thermalisation
      atomicAdd(&dbg[0],1u);
      atomicAdd(&counters[0],1u);          // OH
      atomicAdd(&counters[3],1u);          // H3O+
      let ri=atomicAdd(&counters[7],2u);
      if(ri+1u<p.max_rad){
        rad_buf[ri]   =vec4<f32>(px,py,pz,0.0+f32(id));
        rad_buf[ri+1u]=vec4<f32>(px,py,pz,3.0+f32(id));
      }
      // emit the ejected electron into sec_buf with the G4DNARuddAngle distribution:
      // cosθ = √(KE/W_max) for energetic deltas (>100 eV, forward-peaked), isotropic
      // below — relative to the proton direction (W_max ≈ 4·(m_e/m_p)·E).
      if(ke>p.ce){
        let sidx=atomicAdd(&counters[6],1u);
        if(sidx<p.max_sec){
          let wmaxA=4.0*M_E_OVER_M_P*E;
          var ct:f32;
          if(ke>100.0 && ke<=wmaxA){ct=sqrt(ke/wmaxA);}else{ct=2.0*rf(&s)-1.0;}
          let st=sqrt(max(0.0,1.0-ct*ct)); let ph=2.0*PI*rf(&s);
          let cph=cos(ph); let sph=sin(ph);
          // rotate (st·cph, st·sph, ct) onto the proton direction (dx,dy,dz)
          var edx:f32; var edy:f32; var edz:f32;
          if(abs(dz)>0.99999){let sw=select(-1.0,1.0,dz>0.0);edx=st*cph;edy=st*sph*sw;edz=ct*sw;}
          else{let q=sqrt(1.0-dz*dz);let inv=1.0/q;let nx=dx*ct+st*(dx*dz*cph-dy*sph)*inv;let ny=dy*ct+st*(dy*dz*cph+dx*sph)*inv;let nz=dz*ct-q*st*cph;let len=sqrt(nx*nx+ny*ny+nz*nz);edx=nx/len;edy=ny/len;edz=nz/len;}
          var sp:Particle;
          sp.pos_E=vec4<f32>(px,py,pz,ke);
          sp.dir_alive=vec4<f32>(edx,edy,edz,1.0+f32(id));
          sp.rng=vec4u(rn(&s),rn(&s),rn(&s),rn(&s));
          sec_buf[sidx]=sp;
        }
      }else{
        // sub-cutoff ejected electron: thermalises in place -> eaq
        let ri2=atomicAdd(&counters[7],1u);
        if(ri2<p.max_rad){rad_buf[ri2]=vec4<f32>(px,py,pz,1.0+f32(id));}
        atomicAdd(&counters[1],1u);
        deposit(px,py,pz,ke,p.box,p.vc);
      }
    }else{
      // ---- excitation: pick Miller-Green level, deposit its energy ----
      let rs=rf(&s)*sig_exc;
      var lv=0u; var acc=0.0;
      for(var k=0u;k<5u;k++){
        var pe:f32;
        if(E<PROTON_BORN_E){pe=mg_partial(E,k);}else{pe=1.0;}
        acc+=pe; if(rs<=acc){lv=k;break;}
      }
      let exE=MGE[lv];
      E-=exE; dep+=exE; nexc++;
      deposit(px,py,pz,exE,p.box,p.vc);
      // dissociative excitation -> OH + H (level-dependent branching as electrons)
      atomicAdd(&dbg[1],1u);
    }
  }
  results[id].path=path;
  results[id].fE=E;
  results[id].ni=nion;
  results[id].nx=nexc;
}
