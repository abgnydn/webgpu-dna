struct SP{
  n:u32,box:f32,ce:f32,vc:u32,
  max_rad:u32,dna_enable:u32,dna_grid_n:u32,_pad2:u32,
  dna_rise:f32,dna_spacing:f32,dna_x0:f32,dna_r_bb:f32,
};
struct Particle{pos_E:vec4<f32>,dir_alive:vec4<f32>,rng:vec4<u32>};

@group(0)@binding(0) var<uniform> sp:SP;
@group(0)@binding(1) var<storage,read_write> sec_buf:array<Particle>;
@group(0)@binding(2) var<storage,read_write> sec_stats:array<atomic<u32>>;
@group(0)@binding(3) var<storage,read_write> dose:array<atomic<u32>>;
// Shared counters with primary: slots [0]OH, [1]eaq, [2]H, [3]H3O+, [6]sec_idx, [7]rad_idx
@group(0)@binding(4) var<storage,read_write> counters:array<atomic<u32>>;
// Radical position buffer (same as primary)
@group(0)@binding(5) var<storage,read_write> rad_buf:array<vec4<f32>>;

// Meesungnoen2002: electron thermalization penetration → 1D Gaussian sigma (nm)
fn meesungnoen_sigma(k:f32)->f32{
  if(k<=0.1){return 0.0;}
  var r=-4.06217193e-08;
  r=r*k+3.06848412e-06;r=r*k-9.93217814e-05;r=r*k+1.80172797e-03;
  r=r*k-2.01135480e-02;r=r*k+1.42939448e-01;r=r*k-6.48348714e-01;
  r=r*k+1.85227848e+00;r=r*k-3.36450378e+00;r=r*k+4.37785068e+00;
  r=r*k-4.20557339e+00;r=r*k+3.81679083e+00;r=r*k-2.34069784e-01;
  return max(r,0.0)*0.6267;
}

// Same deposit() as primary — WGSL doesn't let us share non-helper fns between
// compiled modules cleanly, so we duplicate. (Move to HELPERS if this pattern
// grows.) Dose stored in fixed point: 100 units = 1 eV.
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
// Secondary-shader DNA hit check — same as primary dna_near but uses sp.
fn dna_near_sec(px:f32,py:f32,pz:f32)->u32{
  if(sp.dna_enable==0u){return 0u;}
  let r_damage:f32=0.29;
  let N=sp.dna_grid_n;
  let spacing=sp.dna_spacing;
  let grid_off = -(f32(N-1u)*spacing)*0.5;
  let inv_s = 1.0/spacing;
  let fi = i32(round((py - grid_off) * inv_s));
  let fj = i32(round((pz - grid_off) * inv_s));
  if(fi<0 || fi>=i32(N) || fj<0 || fj>=i32(N)){return 0u;}
  let fy = grid_off + f32(fi)*spacing;
  let fz = grid_off + f32(fj)*spacing;
  let y_rel = py - fy;
  let z_rel = pz - fz;
  let r2 = y_rel*y_rel + z_rel*z_rel;
  let R_reach = sp.dna_r_bb + r_damage;
  if(r2 > R_reach*R_reach){return 0u;}
  let bp_est = i32(round((px - sp.dna_x0)/sp.dna_rise));
  let b0 = max(0,bp_est-1);
  let b1 = bp_est+1;
  let d_phase = 2.0*PI/10.5;
  let r_bb = sp.dna_r_bb;
  for(var b:i32=b0;b<=b1;b=b+1){
    let bx = sp.dna_x0 + f32(b)*sp.dna_rise;
    let phi = f32(b)*d_phase;
    let s0y = r_bb*cos(phi);
    let s0z = r_bb*sin(phi);
    let dx = px - bx;
    let dy0 = y_rel - s0y;
    let dz0 = z_rel - s0z;
    if(dx*dx + dy0*dy0 + dz0*dz0 < r_damage*r_damage){return 1u;}
    let s1y = r_bb*cos(phi+PI);
    let s1z = r_bb*sin(phi+PI);
    let dy1 = y_rel - s1y;
    let dz1 = z_rel - s1z;
    if(dx*dx + dy1*dy1 + dz1*dz1 < r_damage*r_damage){return 1u;}
  }
  return 0u;
}
@compute @workgroup_size(256)
fn step(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=sp.n){return;}
  var particle=sec_buf[idx];
  if(particle.dir_alive.w<0.5){return;}  // dead
  let parent_pid=f32(u32(particle.dir_alive.w)-1u)*8.0;

  var px=particle.pos_E.x;
  var py=particle.pos_E.y;
  var pz=particle.pos_E.z;
  var E =particle.pos_E.w;
  var dx=particle.dir_alive.x;
  var dy=particle.dir_alive.y;
  var dz=particle.dir_alive.z;
  var s =particle.rng;

  // Termination checks
  if(E<sp.ce){
    // Deposit residual energy at final position (thermalized)
    deposit(px,py,pz,E,sp.box,sp.vc);
    // Create eaq at thermalization position with Meesungnoen displacement.
    // This electron was deferred from primary ionization — eaq appears HERE,
    // not at the ionization site, matching Geant4-DNA convention.
    atomicAdd(&counters[1],1u);  // e-aq count
    let eaq_s=meesungnoen_sigma(E);
    var epx=px;var epy=py;var epz=pz;
    if(eaq_s>0.0){
      let eu1=max(rf(&s),1e-30);let eu2=rf(&s);
      let er=sqrt(-2.0*log(eu1))*eaq_s;
      epx+=er*cos(6.2831853*eu2);epy+=er*sin(6.2831853*eu2);
      let eu3=max(rf(&s),1e-30);let eu4=rf(&s);
      epz+=sqrt(-2.0*log(eu3))*eaq_s*cos(6.2831853*eu4);
    }
    let re=atomicAdd(&counters[7],1u);
    if(re<sp.max_rad){
      rad_buf[re]=vec4<f32>(epx,epy,epz,5.0+parent_pid); // species=5: pre-thermalized eaq
    }
    particle.dir_alive.w=0.0;
    sec_buf[idx]=particle;
    atomicAdd(&sec_stats[1],1u);  // terminated via cutoff
    return;
  }
  if(abs(px)>=sp.box||abs(py)>=sp.box||abs(pz)>=sp.box){
    particle.dir_alive.w=0.0;
    sec_buf[idx]=particle;
    atomicAdd(&sec_stats[2],1u);  // terminated via bounds
    return;
  }

  // One physics step
  let xs=xs_all(E);
  let s_vib=xs_vib_total(E);
  let s_dea=xs_dea(E);
  let s_tot=xs.x+xs.y+xs.z+s_vib+s_dea;
  if(s_tot<=0.0){
    particle.dir_alive.w=0.0;
    sec_buf[idx]=particle;
    return;
  }

  let lambda=1.0/(NW*s_tot);
  let dist=-log(max(rf(&s),1e-10))*lambda;

  // Elastic scatter angle (Champion tabulated CDF)
  let r_el=rf(&s);
  let cos_el=xs_el_cos(E,r_el);
  let sin_el=sqrt(max(0.0,1.0-cos_el*cos_el));
  let phi_el=2.0*PI*rf(&s);let cp=cos(phi_el);let sp_phi=sin(phi_el);
  if(abs(dz)>0.99999){
    let sw=select(-1.0,1.0,dz>0.0);
    dx=sin_el*cp;dy=sin_el*sp_phi*sw;dz=cos_el*sw;
  }else{
    let q=sqrt(1.0-dz*dz);
    let inv=1.0/q;
    let nx=dx*cos_el+sin_el*(dx*dz*cp-dy*sp_phi)*inv;
    let ny=dy*cos_el+sin_el*(dy*dz*cp+dx*sp_phi)*inv;
    let nz=dz*cos_el-q*sin_el*cp;
    let len=sqrt(nx*nx+ny*ny+nz*nz);
    dx=nx/len;dy=ny/len;dz=nz/len;
  }

  px+=dx*dist;py+=dy*dist;pz+=dz*dist;
  atomicAdd(&sec_stats[3],1u);  // total steps taken

  // Event type sampling
  let r_type=rf(&s)*s_tot;
  if(r_type<xs.x&&E>SB[0]){
    // Ionization (tertiary secondary NOT emitted; absorbed in place)
    let sf=xs_shell_fracs(E);
    let fsum=max(sf[0]+sf[1]+sf[2]+sf[3]+sf[4],1e-12);
    let r_sh=rf(&s)*fsum;
    var bind:f32=SB[0];
    var shell_idx:u32=0u;
    if(r_sh<sf[0]){bind=SB[0];shell_idx=0u;}
    else if(r_sh<sf[0]+sf[1]){bind=SB[1];shell_idx=1u;}
    else if(r_sh<sf[0]+sf[1]+sf[2]){bind=SB[2];shell_idx=2u;}
    else if(r_sh<sf[0]+sf[1]+sf[2]+sf[3]){bind=SB[3];shell_idx=3u;}
    else{bind=SB[4];shell_idx=4u;}
    if(E>bind){
      // Born CDF returns total transfer (bind + sec_KE), same as primary
      let r_w=rf(&s);
      let W_transfer_max=(E+bind)*0.5;
      var W_transfer=sample_W_sec(E,shell_idx,r_w);
      W_transfer=clamp(W_transfer,bind,W_transfer_max);
      let W_sec=max(W_transfer-bind,0.0);
      E-=W_transfer;  // secondary loses total transfer
      atomicAdd(&sec_stats[4],1u);  // tertiary ionizations (absorbed)
      // Tertiary is absorbed in place, so total transfer deposits here.
      deposit(px,py,pz,W_transfer,sp.box,sp.vc);
      // Mother displacement for H2O+ products (RMS=2nm)
      let ms_s=1.1547005;
      let ms1=max(rf(&s),1e-30);let ms2=rf(&s);
      let msr=sqrt(-2.0*log(ms1))*ms_s;
      let msdx=msr*cos(6.2831853*ms2);let msdy=msr*sin(6.2831853*ms2);
      let ms3=max(rf(&s),1e-30);let ms4=rf(&s);
      let msdz=sqrt(-2.0*log(ms3))*ms_s*cos(6.2831853*ms4);
      let spx=px+msdx;let spy=py+msdy;let spz=pz+msdz;
      // Meesungnoen thermalization for the tertiary eaq
      let eaq_s_t=meesungnoen_sigma(W_sec);
      var epx_t=px;var epy_t=py;var epz_t=pz;
      if(eaq_s_t>0.0){
        let eu1=max(rf(&s),1e-30);let eu2=rf(&s);
        let er=sqrt(-2.0*log(eu1))*eaq_s_t;
        epx_t+=er*cos(6.2831853*eu2);epy_t+=er*sin(6.2831853*eu2);
        let eu3=max(rf(&s),1e-30);let eu4=rf(&s);
        epz_t+=sqrt(-2.0*log(eu3))*eaq_s_t*cos(6.2831853*eu4);
      }
      // Onsager electron-hole recombination: H2O+ + eaq → H2Ovib → dissoc
      let rdx_t=epx_t-spx;let rdy_t=epy_t-spy;let rdz_t=epz_t-spz;
      let r_sep_t=max(sqrt(rdx_t*rdx_t+rdy_t*rdy_t+rdz_t*rdz_t),1e-6);
      let r_onsager_t:f32=0.711;
      let p_recomb_t=min(1.0,RECOMB_BOOST*(1.0-exp(-r_onsager_t/r_sep_t)));
      let r_recomb_t=rf(&s);
      if(r_recomb_t<p_recomb_t){
        let r_vd=rf(&s);
        if(r_vd<0.1365){
          atomicAdd(&counters[0],2u);
          atomicAdd(&counters[5],1u);
          let ri=atomicAdd(&counters[7],3u);
          if(ri+2u<sp.max_rad){
            rad_buf[ri]   =vec4<f32>(spx,spy,spz,0.0+parent_pid);
            rad_buf[ri+1u]=vec4<f32>(spx,spy,spz,0.0+parent_pid);
            rad_buf[ri+2u]=vec4<f32>(spx,spy,spz,7.0+parent_pid);
          }
        }else if(r_vd<0.494){
          atomicAdd(&counters[0],1u);
          atomicAdd(&counters[2],1u);
          let ri=atomicAdd(&counters[7],2u);
          if(ri+1u<sp.max_rad){
            rad_buf[ri]   =vec4<f32>(spx,spy,spz,0.0+parent_pid);
            rad_buf[ri+1u]=vec4<f32>(spx,spy,spz,2.0+parent_pid);
          }
        }else if(r_vd<0.650){
          atomicAdd(&counters[2],2u);
          let ri=atomicAdd(&counters[7],2u);
          if(ri+1u<sp.max_rad){
            rad_buf[ri]   =vec4<f32>(spx,spy,spz,2.0+parent_pid);
            rad_buf[ri+1u]=vec4<f32>(spx,spy,spz,2.0+parent_pid);
          }
        }
        // else: 35% relaxation, no products
      }else{
        // Normal pre-chem: OH + H3O+ + eaq
        atomicAdd(&counters[0],1u);
        atomicAdd(&counters[1],1u);
        atomicAdd(&counters[3],1u);
        let ri=atomicAdd(&counters[7],3u);
        if(ri+2u<sp.max_rad){
          rad_buf[ri]   =vec4<f32>(spx,spy,spz,0.0+parent_pid);
          rad_buf[ri+1u]=vec4<f32>(epx_t,epy_t,epz_t,5.0+parent_pid); // species=5: pre-therm eaq
          rad_buf[ri+2u]=vec4<f32>(spx,spy,spz,3.0+parent_pid);
        }
      }
      // Secondary kernel-level DNA hit check
      if(dna_near_sec(px,py,pz)==1u){atomicAdd(&counters[4],1u);}
    }
  }else if(r_type<xs.x+xs.y){
    // Electronic excitation (Born, data-driven fractions — same as primary)
    let ef=xs_exc_fracs(E);
    let efsum=max(ef[0]+ef[1]+ef[2]+ef[3]+ef[4],1e-12);
    let r_ex=rf(&s)*efsum;
    var exc_E:f32;
    var exc_lvl:u32;
    if(r_ex<ef[0]){exc_E=EX[0];exc_lvl=0u;}
    else if(r_ex<ef[0]+ef[1]){exc_E=EX[1];exc_lvl=1u;}
    else if(r_ex<ef[0]+ef[1]+ef[2]){exc_E=EX[2];exc_lvl=2u;}
    else if(r_ex<ef[0]+ef[1]+ef[2]+ef[3]){exc_E=EX[3];exc_lvl=3u;}
    else{exc_E=EX[4];exc_lvl=4u;}
    let dep=min(exc_E,E);
    E-=dep;
    deposit(px,py,pz,dep,sp.box,sp.vc);
    // Same branching as primary (G4ChemDissociationChannels)
    let r_ch=rf(&s);
    if(exc_lvl==0u){
      if(r_ch<0.65){
        atomicAdd(&counters[0],1u);atomicAdd(&counters[2],1u);
        let re=atomicAdd(&counters[7],2u);
        if(re+1u<sp.max_rad){rad_buf[re]=vec4<f32>(px,py,pz,0.0+parent_pid);rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+parent_pid);}
      }
    }else if(exc_lvl==1u){
      // B1A1 — 5 channels from G4ChemDissociationChannels_option1 (cumulative)
      if(r_ch<0.175){
        // 17.5% relaxation, no products
      }else if(r_ch<0.2075){
        // 3.25% B1A1 → 2OH + H2 (H2 marker code 7 in rad_buf)
        atomicAdd(&counters[0],2u);
        atomicAdd(&counters[5],1u);
        let re=atomicAdd(&counters[7],3u);
        if(re+2u<sp.max_rad){
          rad_buf[re]   =vec4<f32>(px,py,pz,0.0+parent_pid);
          rad_buf[re+1u]=vec4<f32>(px,py,pz,0.0+parent_pid);
          rad_buf[re+2u]=vec4<f32>(px,py,pz,7.0+parent_pid);
        }
      }else if(r_ch<0.7075){
        // 50% B1A1 autoionization → OH + H3O+ + eaq (mother disp RMS=2nm).
        // Geant4 DNA: H2O+ created here ALSO undergoes G4DNAElectronHoleRecombination
        // with the emitted eaq. Same treatment as primary shader.
        let msb=1.1547005;let msb1=max(rf(&s),1e-30);let msb2=rf(&s);
        let msbr=sqrt(-2.0*log(msb1))*msb;let msbdx=msbr*cos(6.2831853*msb2);let msbdy=msbr*sin(6.2831853*msb2);
        let msb3=max(rf(&s),1e-30);let msb4=rf(&s);let msbdz=sqrt(-2.0*log(msb3))*msb*cos(6.2831853*msb4);
        let sbpx=px+msbdx;let sbpy=py+msbdy;let sbpz=pz+msbdz;
        let eaq_s_sb=meesungnoen_sigma(1.7);
        var sbex=sbpx;var sbey=sbpy;var sbez=sbpz;
        if(eaq_s_sb>0.0){
          let sab1=max(rf(&s),1e-30);let sab2=rf(&s);
          let sabr=sqrt(-2.0*log(sab1))*eaq_s_sb;
          sbex+=sabr*cos(6.2831853*sab2);sbey+=sabr*sin(6.2831853*sab2);
          let sab3=max(rf(&s),1e-30);let sab4=rf(&s);
          sbez+=sqrt(-2.0*log(sab3))*eaq_s_sb*cos(6.2831853*sab4);
        }
        let sabdx=sbex-sbpx;let sabdy=sbey-sbpy;let sabdz=sbez-sbpz;
        let sabr_sep=max(sqrt(sabdx*sabdx+sabdy*sabdy+sabdz*sabdz),1e-6);
        let sab_onsager:f32=0.711;
        let sabp_recomb=min(1.0,RECOMB_BOOST*(1.0-exp(-sab_onsager/sabr_sep)));
        let sabrr=rf(&s);
        if(sabrr<sabp_recomb){
          let sabvd=rf(&s);
          if(sabvd<0.1365){
            atomicAdd(&counters[0],2u);
            atomicAdd(&counters[5],1u);
            let sabri=atomicAdd(&counters[7],3u);
            if(sabri+2u<sp.max_rad){
              rad_buf[sabri]   =vec4<f32>(sbpx,sbpy,sbpz,0.0+parent_pid);
              rad_buf[sabri+1u]=vec4<f32>(sbpx,sbpy,sbpz,0.0+parent_pid);
              rad_buf[sabri+2u]=vec4<f32>(sbpx,sbpy,sbpz,7.0+parent_pid);
            }
          }else if(sabvd<0.494){
            atomicAdd(&counters[0],1u);
            atomicAdd(&counters[2],1u);
            let sabri=atomicAdd(&counters[7],2u);
            if(sabri+1u<sp.max_rad){
              rad_buf[sabri]   =vec4<f32>(sbpx,sbpy,sbpz,0.0+parent_pid);
              rad_buf[sabri+1u]=vec4<f32>(sbpx,sbpy,sbpz,2.0+parent_pid);
            }
          }else if(sabvd<0.650){
            atomicAdd(&counters[2],2u);
            let sabri=atomicAdd(&counters[7],2u);
            if(sabri+1u<sp.max_rad){
              rad_buf[sabri]   =vec4<f32>(sbpx,sbpy,sbpz,2.0+parent_pid);
              rad_buf[sabri+1u]=vec4<f32>(sbpx,sbpy,sbpz,2.0+parent_pid);
            }
          }
          // else 35% relax
        }else{
          atomicAdd(&counters[0],1u);atomicAdd(&counters[1],1u);atomicAdd(&counters[3],1u);
          let re=atomicAdd(&counters[7],3u);
          if(re+2u<sp.max_rad){rad_buf[re]=vec4<f32>(sbpx,sbpy,sbpz,0.0+parent_pid);rad_buf[re+1u]=vec4<f32>(sbex,sbey,sbez,1.0+parent_pid);rad_buf[re+2u]=vec4<f32>(sbpx,sbpy,sbpz,3.0+parent_pid);}
        }
      }else if(r_ch<0.961){
        // 25.35% B1A1 → OH + H
        atomicAdd(&counters[0],1u);atomicAdd(&counters[2],1u);
        let re=atomicAdd(&counters[7],2u);
        if(re+1u<sp.max_rad){rad_buf[re]=vec4<f32>(px,py,pz,0.0+parent_pid);rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+parent_pid);}
      }else{
        // 3.9% B1A1 → 2H + O (O not tracked, emit 2 H only)
        atomicAdd(&counters[2],2u);
        let re=atomicAdd(&counters[7],2u);
        if(re+1u<sp.max_rad){rad_buf[re]=vec4<f32>(px,py,pz,2.0+parent_pid);rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+parent_pid);}
      }
    }else{
      if(r_ch<0.50){
        // Levels 2-4 autoionization (mother disp RMS=2nm).
        // Geant4 DNA: H2O+ undergoes G4DNAElectronHoleRecombination with the
        // emitted eaq. Same treatment as primary shader.
        let msh=1.1547005;let msh1=max(rf(&s),1e-30);let msh2=rf(&s);
        let mshr=sqrt(-2.0*log(msh1))*msh;let mshdx=mshr*cos(6.2831853*msh2);let mshdy=mshr*sin(6.2831853*msh2);
        let msh3=max(rf(&s),1e-30);let msh4=rf(&s);let mshdz=sqrt(-2.0*log(msh3))*msh*cos(6.2831853*msh4);
        let shpx=px+mshdx;let shpy=py+mshdy;let shpz=pz+mshdz;
        let eaq_s_sh=meesungnoen_sigma(1.7);
        var shex=shpx;var shey=shpy;var shez=shpz;
        if(eaq_s_sh>0.0){
          let sah1=max(rf(&s),1e-30);let sah2=rf(&s);
          let sahr=sqrt(-2.0*log(sah1))*eaq_s_sh;
          shex+=sahr*cos(6.2831853*sah2);shey+=sahr*sin(6.2831853*sah2);
          let sah3=max(rf(&s),1e-30);let sah4=rf(&s);
          shez+=sqrt(-2.0*log(sah3))*eaq_s_sh*cos(6.2831853*sah4);
        }
        let sahdx=shex-shpx;let sahdy=shey-shpy;let sahdz=shez-shpz;
        let sahr_sep=max(sqrt(sahdx*sahdx+sahdy*sahdy+sahdz*sahdz),1e-6);
        let sah_onsager:f32=0.711;
        let sahp_recomb=min(1.0,RECOMB_BOOST*(1.0-exp(-sah_onsager/sahr_sep)));
        let sahrr=rf(&s);
        if(sahrr<sahp_recomb){
          let sahvd=rf(&s);
          if(sahvd<0.1365){
            atomicAdd(&counters[0],2u);
            atomicAdd(&counters[5],1u);
            let sahri=atomicAdd(&counters[7],3u);
            if(sahri+2u<sp.max_rad){
              rad_buf[sahri]   =vec4<f32>(shpx,shpy,shpz,0.0+parent_pid);
              rad_buf[sahri+1u]=vec4<f32>(shpx,shpy,shpz,0.0+parent_pid);
              rad_buf[sahri+2u]=vec4<f32>(shpx,shpy,shpz,7.0+parent_pid);
            }
          }else if(sahvd<0.494){
            atomicAdd(&counters[0],1u);
            atomicAdd(&counters[2],1u);
            let sahri=atomicAdd(&counters[7],2u);
            if(sahri+1u<sp.max_rad){
              rad_buf[sahri]   =vec4<f32>(shpx,shpy,shpz,0.0+parent_pid);
              rad_buf[sahri+1u]=vec4<f32>(shpx,shpy,shpz,2.0+parent_pid);
            }
          }else if(sahvd<0.650){
            atomicAdd(&counters[2],2u);
            let sahri=atomicAdd(&counters[7],2u);
            if(sahri+1u<sp.max_rad){
              rad_buf[sahri]   =vec4<f32>(shpx,shpy,shpz,2.0+parent_pid);
              rad_buf[sahri+1u]=vec4<f32>(shpx,shpy,shpz,2.0+parent_pid);
            }
          }
          // else 35% relax
        }else{
          atomicAdd(&counters[0],1u);atomicAdd(&counters[1],1u);atomicAdd(&counters[3],1u);
          let re=atomicAdd(&counters[7],3u);
          if(re+2u<sp.max_rad){rad_buf[re]=vec4<f32>(shpx,shpy,shpz,0.0+parent_pid);rad_buf[re+1u]=vec4<f32>(shex,shey,shez,1.0+parent_pid);rad_buf[re+2u]=vec4<f32>(shpx,shpy,shpz,3.0+parent_pid);}
        }
      }
    }
    if(dna_near_sec(px,py,pz)==1u){atomicAdd(&counters[4],1u);}
  }else if(r_type<xs.x+xs.y+s_vib){
    // Sanche vibrational excitation (energy deposit only, no molecular products).
    // G4DNASancheExcitationModel only proposes ProposeLocalEnergyDeposit —
    // H2Ovib dissociation is handled by G4DNAElectronHoleRecombination at the
    // ionization site, not here.
    let mode=sample_vib_mode(E,rf(&s));
    let dep=min(VIB_LEV[mode],E);
    E-=dep;
    deposit(px,py,pz,dep,sp.box,sp.vc);
  }else if(r_type<xs.x+xs.y+s_vib+s_dea){
    // Melton DEA (G4ChemDissociationChannels_option1 DissociAttachment_ch1):
    // e⁻ + H₂O → H₂ + OH⁻ + OH (electron captured, full deposit)
    deposit(px,py,pz,E,sp.box,sp.vc);
    atomicAdd(&counters[0],1u);  // OH
    atomicAdd(&counters[5],1u);  // initial H2
    let re=atomicAdd(&counters[7],3u);
    if(re+2u<sp.max_rad){
      rad_buf[re]   =vec4<f32>(px,py,pz,0.0+parent_pid);  // OH
      rad_buf[re+1u]=vec4<f32>(px,py,pz,6.0+parent_pid);  // OH-
      rad_buf[re+2u]=vec4<f32>(px,py,pz,7.0+parent_pid);  // H2 marker
    }
    E=0.0;
  }
  // else: elastic (no energy loss)

  particle.pos_E=vec4<f32>(px,py,pz,E);
  particle.dir_alive=vec4<f32>(dx,dy,dz,particle.dir_alive.w);
  particle.rng=s;
  sec_buf[idx]=particle;
}
