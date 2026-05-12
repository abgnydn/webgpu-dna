struct P{
  n:u32,box:f32,ce:f32,ms:u32,
  be:f32,max_sec:u32,vc:u32,max_rad:u32,
  start_half:f32,dna_enable:u32,dna_grid_n:u32,_pad3:u32,
  // DNA grid params (same layout as JS buildDNATarget)
  dna_rise:f32,dna_spacing:f32,dna_x0:f32,dna_r_bb:f32,
};
// R layout: total_path, productive_path (until E<12eV), final_E, n_ions, n_exc, esc, max_r, _pad
struct R{path:f32,prod:f32,fE:f32,ni:u32,nx:u32,esc:u32,mx:f32,_pad:u32};
// Particle struct for secondary queue: 48 bytes, 16-byte aligned.
//   pos_E:     vec4 (px, py, pz, energy_eV)
//   dir_alive: vec4 (dx, dy, dz, alive_flag)  — alive: 1.0=alive, 0.0=dead
//   rng:       vec4u xorshift state
struct Particle{pos_E:vec4<f32>,dir_alive:vec4<f32>,rng:vec4<u32>};

@group(0)@binding(0) var<uniform> p:P;
@group(0)@binding(1) var<storage,read_write> results:array<R>;
@group(0)@binding(2) var<storage,read_write> rng:array<vec4u>;
@group(0)@binding(3) var<storage,read_write> dbg:array<atomic<u32>>;
// Radical position buffer: (x, y, z, kind) per radical, kind 0=OH, 1=eaq, 2=H
@group(0)@binding(4) var<storage,read_write> rad_buf:array<vec4<f32>>;
@group(0)@binding(5) var<storage,read_write> sec_buf:array<Particle>;
@group(0)@binding(6) var<storage,read_write> dose:array<atomic<u32>>;
// Shared atomic counters:
//   [0] OH count (V1 species)
//   [1] e-aq count
//   [2] H count
//   [3] H3O+ count
//   [4] kernel-level DNA direct-hit counter (events within r_bb+0.29 nm
//       of any DNA backbone across the full fiber grid; compare against
//       the JS post-processing scoreDirectSSB_events as a consistency check)
//   [5] unused
//   [6] secondary append index (atomic)
//   [7] radical append index (atomic)
@group(0)@binding(7) var<storage,read_write> counters:array<atomic<u32>>;

// Check whether a world-space position is within r_damage of any DNA
// backbone atom on the fiber grid. Returns 1u if within reach of either
// strand, else 0u. Grid layout matches JS buildDNATarget: NxN parallel
// fibers along X, uniform (y,z) spacing, straight B-DNA helix per fiber.
fn dna_near(px:f32,py:f32,pz:f32)->u32{
  if(p.dna_enable==0u){return 0u;}
  let r_damage:f32=0.29;
  let N=p.dna_grid_n;
  let spacing=p.dna_spacing;
  let grid_off = -(f32(N-1u)*spacing)*0.5;
  let inv_s = 1.0/spacing;
  // Snap (py,pz) to nearest fiber. Round to nearest integer index.
  let fi_raw = (py - grid_off) * inv_s;
  let fj_raw = (pz - grid_off) * inv_s;
  let fi = i32(round(fi_raw));
  let fj = i32(round(fj_raw));
  if(fi<0 || fi>=i32(N) || fj<0 || fj>=i32(N)){return 0u;}
  let fy = grid_off + f32(fi)*spacing;
  let fz = grid_off + f32(fj)*spacing;
  let y_rel = py - fy;
  let z_rel = pz - fz;
  let r2 = y_rel*y_rel + z_rel*z_rel;
  let R_reach = p.dna_r_bb + r_damage;
  if(r2 > R_reach*R_reach){return 0u;}
  // Snap to nearest bp along X
  let bp_est = i32(round((px - p.dna_x0)/p.dna_rise));
  // Check ±1 bp for helical offset tolerance
  let b0 = max(0,bp_est-1);
  let b1 = bp_est+1;
  let d_phase = 2.0*PI/10.5;
  let r_bb = p.dna_r_bb;
  for(var b:i32=b0;b<=b1;b=b+1){
    let bx = p.dna_x0 + f32(b)*p.dna_rise;
    let phi = f32(b)*d_phase;
    // Strand 0
    let s0y = r_bb*cos(phi);
    let s0z = r_bb*sin(phi);
    let dx = px - bx;
    let dy0 = y_rel - s0y;
    let dz0 = z_rel - s0z;
    if(dx*dx + dy0*dy0 + dz0*dz0 < r_damage*r_damage){return 1u;}
    // Strand 1
    let s1y = r_bb*cos(phi+PI);
    let s1z = r_bb*sin(phi+PI);
    let dy1 = y_rel - s1y;
    let dz1 = z_rel - s1z;
    if(dx*dx + dy1*dy1 + dz1*dz1 < r_damage*r_damage){return 1u;}
  }
  return 0u;
}

// Meesungnoen2002: electron thermalization penetration → 1D Gaussian sigma (nm)
// Polynomial fit to mean radial distance, converted via sigma = r_mean * sqrt(pi/8)
fn meesungnoen_sigma(k:f32)->f32{
  if(k<=0.1){return 0.0;}
  var r=-4.06217193e-08;
  r=r*k+3.06848412e-06;r=r*k-9.93217814e-05;r=r*k+1.80172797e-03;
  r=r*k-2.01135480e-02;r=r*k+1.42939448e-01;r=r*k-6.48348714e-01;
  r=r*k+1.85227848e+00;r=r*k-3.36450378e+00;r=r*k+4.37785068e+00;
  r=r*k-4.20557339e+00;r=r*k+3.81679083e+00;r=r*k-2.34069784e-01;
  return max(r,0.0)*0.6267;
}

// Deposit energy (eV) at voxel containing world position (px,py,pz). Thread-safe.
// Dose is stored in fixed-point: 1000 units = 1 eV.
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
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid:vec3u){
  let idx=gid.x;
  if(idx>=p.n){return;}
  var s=rng[idx];

  var E=p.be;
  let pid=f32(gid.x)*8.0; // primary ID for rad_buf tagging
  // Start position: uniform in ±start_half cube if start_half>0, else origin.
  // Used to distribute tracks for unbiased bulk-dose yield measurements.
  var px=0.0;var py=0.0;var pz=0.0;
  let sh=p.start_half;
  if(sh>0.0){
    px=(rf(&s)*2.0-1.0)*sh;
    py=(rf(&s)*2.0-1.0)*sh;
    pz=(rf(&s)*2.0-1.0)*sh;
  }
  // Stash start_half in debug slot 2 for JS visibility
  if(idx==0u){atomicStore(&dbg[2],u32(sh));}
  let start_px=px;let start_py=py;let start_pz=pz;
  // Isotropic initial direction for unbiased CSDA measurement
  let u1=max(rf(&s),1e-10);
  let u2=rf(&s);
  let cos_i=1.0-2.0*u1;
  let sin_i=sqrt(max(0.0,1.0-cos_i*cos_i));
  let phi_i=2.0*PI*u2;
  var dx=sin_i*cos(phi_i);
  var dy=sin_i*sin(phi_i);
  var dz=cos_i;

  var total_path:f32=0.0;
  var productive_path:f32=0.0;  // accumulated only while E > 12 eV (above inelastic dead zone)
  var n_ions:u32=0u;
  var n_exc:u32=0u;
  var escaped:u32=0u;
  var max_r:f32=0.0;

  for(var step=0u;step<p.ms;step++){
    if(E<p.ce){break;}
    if(abs(px)>=p.box||abs(py)>=p.box||abs(pz)>=p.box){escaped=1u;break;}
    let productive=E>12.0;

    let xs=xs_all(E);
    let s_vib=xs_vib_total(E);
    let s_dea=xs_dea(E);
    let s_tot=xs.x+xs.y+xs.z+s_vib+s_dea;
    if(s_tot<=0.0){break;}

    let lambda=1.0/(NW*s_tot);
    let dist=-log(max(rf(&s),1e-10))*lambda;

    // Champion elastic scatter angle
    let r_el=rf(&s);
    let cos_el=xs_el_cos(E,r_el);
    let sin_el=sqrt(max(0.0,1.0-cos_el*cos_el));
    let phi_el=2.0*PI*rf(&s);let cp=cos(phi_el);let sp=sin(phi_el);
    if(abs(dz)>0.99999){let sw=select(-1.0,1.0,dz>0.0);dx=sin_el*cp;dy=sin_el*sp*sw;dz=cos_el*sw;}
    else{let q=sqrt(1.0-dz*dz);let inv=1.0/q;let nx=dx*cos_el+sin_el*(dx*dz*cp-dy*sp)*inv;let ny=dy*cos_el+sin_el*(dy*dz*cp+dx*sp)*inv;let nz=dz*cos_el-q*sin_el*cp;let len=sqrt(nx*nx+ny*ny+nz*nz);dx=nx/len;dy=ny/len;dz=nz/len;}

    px+=dx*dist;py+=dy*dist;pz+=dz*dist;
    total_path+=dist;
    if(productive){productive_path+=dist;}
    let rdx=px-start_px;let rdy=py-start_py;let rdz=pz-start_pz;
    let r=sqrt(rdx*rdx+rdy*rdy+rdz*rdz);
    if(r>max_r){max_r=r;}
    if(abs(px)>=p.box||abs(py)>=p.box||abs(pz)>=p.box){escaped=1u;break;}

    // Event type sampling
    let r_type=rf(&s)*s_tot;
    if(r_type<xs.x&&E>SB[0]){
      // Ionization: sample shell, then W_sec from Emfietzoglou differential CDF
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
        // Born differential CDF returns TOTAL energy transfer (bind + sec_KE).
        // Geant4: sec_KE = TransferedEnergy(random) - IonisationEnergy(shell)
        let r_w=rf(&s);
        let W_transfer_max=(E+bind)*0.5;  // max transfer for electrons
        var W_transfer=sample_W_sec(E,shell_idx,r_w);
        W_transfer=clamp(W_transfer,bind,W_transfer_max);
        let W_sec=max(W_transfer-bind,0.0);  // secondary KE
        E-=W_transfer;  // primary loses total transfer (NOT bind+W_sec)
        n_ions=n_ions+1u;
        atomicAdd(&dbg[4],u32(W_transfer*10.0)); // debug: sum of W_transfer × 10
        // Deposit the binding energy at this ionization site. W_sec is carried
        // away by the secondary (to be deposited where IT thermalizes), OR if
        // the secondary is below cutoff then deposit it here too.
        deposit(px,py,pz,bind,p.box,p.vc);
        if(W_sec<=p.ce){deposit(px,py,pz,W_sec,p.box,p.vc);}
        // Pre-chemistry: H2O+ products (OH + H3O+ or H2Ovib branches) emitted
        // inside the recomb-vs-no-recomb branch below. DNA hit counted here.
        if(dna_near(px,py,pz)==1u){atomicAdd(&counters[4],1u);}
        // Mother molecule displacement (G4DNAWaterDissociationDisplacer:
        // Ionisation RMS=2.0nm → sigma_1D = 2.0/sqrt(3) = 1.1547nm)
        let m_s=1.1547005;
        let mu1_i=max(rf(&s),1e-30);let mu2_i=rf(&s);
        let mr_i=sqrt(-2.0*log(mu1_i))*m_s;
        let mdx_i=mr_i*cos(6.2831853*mu2_i);let mdy_i=mr_i*sin(6.2831853*mu2_i);
        let mu3_i=max(rf(&s),1e-30);let mu4_i=rf(&s);
        let mdz_i=sqrt(-2.0*log(mu3_i))*m_s*cos(6.2831853*mu4_i);
        let mpx=px+mdx_i;let mpy=py+mdy_i;let mpz=pz+mdz_i;
        // eaq placement: if secondary electron is tracked (W_sec > cutoff),
        // defer eaq creation to secondary shader thermalization point.
        // If sub-cutoff, create eaq here with Meesungnoen displacement, then
        // apply G4DNAElectronHoleRecombination: H2O+ recombines with its own
        // eaq with probability 1 - exp(-r_Onsager / r) (r_Onsager ≈ 0.711 nm).
        // On recombination, OH + H3O+ + eaq are REPLACED by H2Ovib dissociation
        // products (13.65% 2OH+H2, 35.75% OH+H, 15.6% 2H+O, 35% relax).
        if(W_sec<=p.ce){
          let eaq_s=meesungnoen_sigma(W_sec);
          var epx=px;var epy=py;var epz=pz;
          if(eaq_s>0.0){
            let eu1=max(rf(&s),1e-30);let eu2=rf(&s);
            let er=sqrt(-2.0*log(eu1))*eaq_s;
            epx+=er*cos(6.2831853*eu2);epy+=er*sin(6.2831853*eu2);
            let eu3=max(rf(&s),1e-30);let eu4=rf(&s);
            epz+=sqrt(-2.0*log(eu3))*eaq_s*cos(6.2831853*eu4);
          }
          // Distance from H2O+ (mother-displaced site) to thermalized eaq
          let rdx=epx-mpx;let rdy=epy-mpy;let rdz=epz-mpz;
          let r_sep=max(sqrt(rdx*rdx+rdy*rdy+rdz*rdz),1e-6);
          let r_onsager:f32=0.711;  // q1*q2 * e^2/(4πε₀ε_r kT) at 298 K, ε=78
          let p_recomb=min(1.0,RECOMB_BOOST*(1.0-exp(-r_onsager/r_sep)));
          let r_recomb=rf(&s);
          if(r_recomb<p_recomb){
            // Electron-hole recombination: H2O+ + eaq → H2Ovib → dissociation
            let r_vd=rf(&s);
            if(r_vd<0.1365){
              // 13.65% → 2OH + H2
              atomicAdd(&counters[0],2u);
              atomicAdd(&counters[5],1u); // H2 counter
              let ri=atomicAdd(&counters[7],3u);
              if(ri+2u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+2u]=vec4<f32>(mpx,mpy,mpz,7.0+pid);
              }
            }else if(r_vd<0.494){
              // 35.75% → OH + H
              atomicAdd(&counters[0],1u);
              atomicAdd(&counters[2],1u);
              let ri=atomicAdd(&counters[7],2u);
              if(ri+1u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,2.0+pid);
              }
            }else if(r_vd<0.650){
              // 15.6% → 2H + O (O not tracked)
              atomicAdd(&counters[2],2u);
              let ri=atomicAdd(&counters[7],2u);
              if(ri+1u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,2.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,2.0+pid);
              }
            }
            // else: 35% relaxation — no products
          }else{
            // No recombination: normal pre-chem OH + H3O+ + eaq
            atomicAdd(&counters[0],1u);  // OH
            atomicAdd(&counters[1],1u);  // eaq
            atomicAdd(&counters[3],1u);  // H3O+
            let ri=atomicAdd(&counters[7],3u);
            if(ri+2u<p.max_rad){
              rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
              rad_buf[ri+1u]=vec4<f32>(epx,epy,epz,5.0+pid); // species=5: pre-thermalized eaq
              rad_buf[ri+2u]=vec4<f32>(mpx,mpy,mpz,3.0+pid);
            }
          }
        }else{
          // Tracked secondary (W_sec > p.ce): approximate the H2O+→eaq
          // separation with a simple track-length model, since the secondary
          // propagates through many steps before thermalizing and its final
          // position isn't known here.
          //   r_track ≈ 0.04 * W_sec^1.3 [nm] (empirical water CSDA-like fit:
          //     ~1 nm @ 10 eV, ~20 nm @ 100 eV, ~320 nm @ 1 keV)
          //   r_tail  = meesungnoen_sigma(min(W_sec, 7.4))  — post-propagation
          //     thermalization sigma (polynomial valid only up to ~7.4 eV, so
          //     clamp to avoid blow-up at higher energies)
          // P_recomb at r_sep is Onsager 1 - exp(-0.711 / r_sep). For low
          // energies (near cutoff) this is ~20% → real H2Ovib contribution;
          // for E>100 eV it drops below 5% and fades quickly. On recomb fire,
          // emit H2Ovib dissociation products; the tracked secondary still
          // propagates and creates its own eaq at thermalization (mild
          // overcounting since that eaq should be consumed, but we can't
          // kill the sec_buf entry without a dedicated flag field).
          let r_track=0.04*pow(W_sec,1.3);
          let r_tail=meesungnoen_sigma(min(W_sec,7.4));
          let r_sep_est=max(r_track+r_tail,1e-3);
          let r_onsager_t:f32=0.711;
          let p_recomb_t=min(1.0,RECOMB_BOOST*(1.0-exp(-r_onsager_t/r_sep_est)));
          let r_recomb_t=rf(&s);
          if(r_recomb_t<p_recomb_t){
            let r_vd=rf(&s);
            if(r_vd<0.1365){
              // 13.65% → 2OH + H2
              atomicAdd(&counters[0],2u);
              atomicAdd(&counters[5],1u);
              let ri=atomicAdd(&counters[7],3u);
              if(ri+2u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+2u]=vec4<f32>(mpx,mpy,mpz,7.0+pid);
              }
            }else if(r_vd<0.494){
              // 35.75% → OH + H
              atomicAdd(&counters[0],1u);
              atomicAdd(&counters[2],1u);
              let ri=atomicAdd(&counters[7],2u);
              if(ri+1u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,2.0+pid);
              }
            }else if(r_vd<0.650){
              // 15.6% → 2H + O (O not tracked)
              atomicAdd(&counters[2],2u);
              let ri=atomicAdd(&counters[7],2u);
              if(ri+1u<p.max_rad){
                rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,2.0+pid);
                rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,2.0+pid);
              }
            }
            // else: 35% relax — no products
          }else{
            // No recomb: emit OH + H3O+ (eaq created later by sec shader)
            atomicAdd(&counters[0],1u);  // OH
            atomicAdd(&counters[3],1u);  // H3O+
            let ri=atomicAdd(&counters[7],2u);
            if(ri+1u<p.max_rad){
              rad_buf[ri]   =vec4<f32>(mpx,mpy,mpz,0.0+pid);
              rad_buf[ri+1u]=vec4<f32>(mpx,mpy,mpz,3.0+pid);
            }
          }
        }

        // Emit secondary electron to sec_buf if energy is above cutoff.
        // G4DNABornAngle: secondary direction depends on W_sec:
        //   <50 eV: isotropic
        //   50-200 eV: 10% isotropic, 90% forward-peaked (cos=U*sqrt(2)/2)
        //   >200 eV: sin²θ = (1-Esec/Einc)/(1+Esec/(2*511keV)), cos = sqrt(1-sin²)
        // After emission, primary direction updated via momentum conservation:
        //   p_final = p_incident - p_secondary (Geant4 G4DNABornIonisationModel1)
        if(W_sec>p.ce){
          let sec_idx=atomicAdd(&counters[6],1u);
          if(sec_idx<p.max_sec){
            let E_before=E+bind+W_sec;
            // G4DNABornAngle secondary angular sampling
            var cos_s:f32;
            if(W_sec<50.0){
              cos_s=2.0*rf(&s)-1.0; // isotropic
            }else if(W_sec<=200.0){
              if(rf(&s)<=0.1){cos_s=2.0*rf(&s)-1.0;} // 10% isotropic
              else{cos_s=rf(&s)*0.70710678;} // 90% forward: cos in [0, sqrt(2)/2]
            }else{
              let sin2=clamp((1.0-W_sec/E_before)/(1.0+W_sec/1022000.0),0.0,1.0);
              cos_s=sqrt(max(0.0,1.0-sin2));
            }
            let sin_s=sqrt(max(0.0,1.0-cos_s*cos_s));
            let phi_s=2.0*PI*rf(&s);
            let cps=cos(phi_s);let sps=sin(phi_s);
            // Rotate (sin_s*cps, sin_s*sps, cos_s) from primary-local to world frame
            var sdx:f32;var sdy:f32;var sdz:f32;
            if(abs(dz)>0.99999){
              let sw=select(-1.0,1.0,dz>0.0);
              sdx=sin_s*cps;
              sdy=sin_s*sps*sw;
              sdz=cos_s*sw;
            }else{
              let q=sqrt(1.0-dz*dz);
              let inv=1.0/q;
              let nx=dx*cos_s+sin_s*(dx*dz*cps-dy*sps)*inv;
              let ny=dy*cos_s+sin_s*(dy*dz*cps+dx*sps)*inv;
              let nz=dz*cos_s-q*sin_s*cps;
              let len=sqrt(nx*nx+ny*ny+nz*nz);
              sdx=nx/len;sdy=ny/len;sdz=nz/len;
            }
            // Primary momentum conservation: p_final = p_inc - p_sec
            // Non-relativistic: p = sqrt(2mE), so p ∝ sqrt(E)
            let p_inc=sqrt(E_before);
            let p_sec=sqrt(W_sec);
            let p_fx=p_inc*dx-p_sec*sdx;
            let p_fy=p_inc*dy-p_sec*sdy;
            let p_fz=p_inc*dz-p_sec*sdz;
            let p_flen=sqrt(p_fx*p_fx+p_fy*p_fy+p_fz*p_fz);
            if(p_flen>1e-10){dx=p_fx/p_flen;dy=p_fy/p_flen;dz=p_fz/p_flen;}
            // Fresh RNG state for the child (4 draws from parent)
            let r0=rn(&s);let r1=rn(&s);let r2=rn(&s);let r3=rn(&s);
            var sec:Particle;
            sec.pos_E=vec4<f32>(px,py,pz,W_sec);
            sec.dir_alive=vec4<f32>(sdx,sdy,sdz,f32(gid.x+1u));
            sec.rng=vec4u(r0,r1,r2,r3);
            sec_buf[sec_idx]=sec;
          }
        }
      }
    }else if(r_type<xs.x+xs.y){
      // Electronic excitation (Born water levels, data-driven fractions)
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
      deposit(px,py,pz,dep,p.box,p.vc);
      n_exc=n_exc+1u;
      // Pre-chemistry from G4ChemDissociationChannels.cc:
      // Level 0 (A1B1): 65% OH+H, 35% relaxation
      // Level 1 (B1A1): 55% autoionization (OH+H3O++eaq), 15% 2OH+H2, 30% relax
      // Level 2-4:      50% autoionization, 50% relaxation
      let r_ch=rf(&s);
      if(exc_lvl==0u){
        // A1B1: 65% dissociation → OH + H
        if(r_ch<0.65){
          atomicAdd(&counters[0],1u);  // OH•
          atomicAdd(&counters[2],1u);  // H•
          let re=atomicAdd(&counters[7],2u);
          if(re+1u<p.max_rad){
            rad_buf[re]   =vec4<f32>(px,py,pz,0.0+pid);
            rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+pid);
          }
        }
      }else if(exc_lvl==1u){
        // B1A1 — 5 channels from G4ChemDissociationChannels_option1 (cumulative):
        //   17.5%  relax (no products)
        //   3.25%  → 2OH + H2
        //   50%    → OH + H3O+ + eaq (autoionization, mother disp RMS=2nm)
        //   25.35% → OH + H
        //   3.9%   → 2H + O (O not tracked, only emit 2 H)
        if(r_ch<0.175){
          // Relaxation, no products
        }else if(r_ch<0.2075){
          // B1A1 dissociation → 2OH + H2 (H2 marker code 7 in rad_buf)
          atomicAdd(&counters[0],2u);
          atomicAdd(&counters[5],1u); // initial H2 counter (UI display)
          let re=atomicAdd(&counters[7],3u);
          if(re+2u<p.max_rad){
            rad_buf[re]   =vec4<f32>(px,py,pz,0.0+pid);
            rad_buf[re+1u]=vec4<f32>(px,py,pz,0.0+pid);
            rad_buf[re+2u]=vec4<f32>(px,py,pz,7.0+pid);
          }
        }else if(r_ch<0.7075){
          // B1A1 autoionization → OH + H3O+ + eaq (mother disp RMS=2nm)
          // Geant4 DNA: H2O+ created here ALSO undergoes G4DNAElectronHoleRecombination
          // with the emitted eaq. Probability = 1 - exp(-r_Onsager/r_sep). On recomb,
          // replace OH+H3O++eaq with H2Ovib dissociation products (matches sub-cutoff
          // ionization recomb pathway). Meesungnoen at 1.7 eV is a reasonable proxy
          // for the autoionization eaq thermalization radius.
          let ms_b=1.1547005;
          let mb1=max(rf(&s),1e-30);let mb2=rf(&s);
          let mbr=sqrt(-2.0*log(mb1))*ms_b;
          let mbdx=mbr*cos(6.2831853*mb2);let mbdy=mbr*sin(6.2831853*mb2);
          let mb3=max(rf(&s),1e-30);let mb4=rf(&s);
          let mbdz=sqrt(-2.0*log(mb3))*ms_b*cos(6.2831853*mb4);
          let bpx=px+mbdx;let bpy=py+mbdy;let bpz=pz+mbdz;
          let eaq_s_b=meesungnoen_sigma(1.7);
          var aex=bpx;var aey=bpy;var aez=bpz;
          if(eaq_s_b>0.0){
            let ab1=max(rf(&s),1e-30);let ab2=rf(&s);
            let abr=sqrt(-2.0*log(ab1))*eaq_s_b;
            aex+=abr*cos(6.2831853*ab2);aey+=abr*sin(6.2831853*ab2);
            let ab3=max(rf(&s),1e-30);let ab4=rf(&s);
            aez+=sqrt(-2.0*log(ab3))*eaq_s_b*cos(6.2831853*ab4);
          }
          let abdx=aex-bpx;let abdy=aey-bpy;let abdz=aez-bpz;
          let abr_sep=max(sqrt(abdx*abdx+abdy*abdy+abdz*abdz),1e-6);
          let ab_onsager:f32=0.711;
          let abp_recomb=min(1.0,RECOMB_BOOST*(1.0-exp(-ab_onsager/abr_sep)));
          let abrr=rf(&s);
          if(abrr<abp_recomb){
            let abvd=rf(&s);
            if(abvd<0.1365){
              // 13.65% → 2OH + H2
              atomicAdd(&counters[0],2u);
              atomicAdd(&counters[5],1u);
              let abri=atomicAdd(&counters[7],3u);
              if(abri+2u<p.max_rad){
                rad_buf[abri]   =vec4<f32>(bpx,bpy,bpz,0.0+pid);
                rad_buf[abri+1u]=vec4<f32>(bpx,bpy,bpz,0.0+pid);
                rad_buf[abri+2u]=vec4<f32>(bpx,bpy,bpz,7.0+pid);
              }
            }else if(abvd<0.494){
              // 35.75% → OH + H
              atomicAdd(&counters[0],1u);
              atomicAdd(&counters[2],1u);
              let abri=atomicAdd(&counters[7],2u);
              if(abri+1u<p.max_rad){
                rad_buf[abri]   =vec4<f32>(bpx,bpy,bpz,0.0+pid);
                rad_buf[abri+1u]=vec4<f32>(bpx,bpy,bpz,2.0+pid);
              }
            }else if(abvd<0.650){
              // 15.6% → 2H + O (O not tracked)
              atomicAdd(&counters[2],2u);
              let abri=atomicAdd(&counters[7],2u);
              if(abri+1u<p.max_rad){
                rad_buf[abri]   =vec4<f32>(bpx,bpy,bpz,2.0+pid);
                rad_buf[abri+1u]=vec4<f32>(bpx,bpy,bpz,2.0+pid);
              }
            }
            // else 35% relax — no products
          }else{
            // No recomb: emit normal B1A1 autoionization products
            atomicAdd(&counters[0],1u);  // OH
            atomicAdd(&counters[1],1u);  // eaq
            atomicAdd(&counters[3],1u);  // H3O+
            let re=atomicAdd(&counters[7],3u);
            if(re+2u<p.max_rad){
              rad_buf[re]   =vec4<f32>(bpx,bpy,bpz,0.0+pid);  // OH at mother
              rad_buf[re+1u]=vec4<f32>(aex,aey,aez,1.0+pid);  // eaq displaced
              rad_buf[re+2u]=vec4<f32>(bpx,bpy,bpz,3.0+pid);  // H3O+ at mother
            }
          }
        }else if(r_ch<0.961){
          // B1A1 dissociation → OH + H
          atomicAdd(&counters[0],1u);  // OH
          atomicAdd(&counters[2],1u);  // H
          let re=atomicAdd(&counters[7],2u);
          if(re+1u<p.max_rad){
            rad_buf[re]   =vec4<f32>(px,py,pz,0.0+pid);
            rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+pid);
          }
        }else{
          // B1A1 dissociation → 2H + O (O atom not tracked, emit 2 H only)
          atomicAdd(&counters[2],2u);
          let re=atomicAdd(&counters[7],2u);
          if(re+1u<p.max_rad){
            rad_buf[re]   =vec4<f32>(px,py,pz,2.0+pid);
            rad_buf[re+1u]=vec4<f32>(px,py,pz,2.0+pid);
          }
        }
      }else{
        // Levels 2-4: 50% autoionization → OH + H3O+ + eaq (mother disp RMS=2nm)
        // Geant4 DNA: H2O+ here also undergoes G4DNAElectronHoleRecombination
        // with the eaq. Same treatment as B1A1 autoionization above.
        if(r_ch<0.50){
          let ms_h=1.1547005;
          let mh1=max(rf(&s),1e-30);let mh2=rf(&s);
          let mhr=sqrt(-2.0*log(mh1))*ms_h;
          let mhdx=mhr*cos(6.2831853*mh2);let mhdy=mhr*sin(6.2831853*mh2);
          let mh3=max(rf(&s),1e-30);let mh4=rf(&s);
          let mhdz=sqrt(-2.0*log(mh3))*ms_h*cos(6.2831853*mh4);
          let hpx=px+mhdx;let hpy=py+mhdy;let hpz=pz+mhdz;
          let eaq_s_h=meesungnoen_sigma(1.7);
          var hex=hpx;var hey=hpy;var hez=hpz;
          if(eaq_s_h>0.0){
            let ah1=max(rf(&s),1e-30);let ah2=rf(&s);
            let ahr=sqrt(-2.0*log(ah1))*eaq_s_h;
            hex+=ahr*cos(6.2831853*ah2);hey+=ahr*sin(6.2831853*ah2);
            let ah3=max(rf(&s),1e-30);let ah4=rf(&s);
            hez+=sqrt(-2.0*log(ah3))*eaq_s_h*cos(6.2831853*ah4);
          }
          let ahdx=hex-hpx;let ahdy=hey-hpy;let ahdz=hez-hpz;
          let ahr_sep=max(sqrt(ahdx*ahdx+ahdy*ahdy+ahdz*ahdz),1e-6);
          let ah_onsager:f32=0.711;
          let ahp_recomb=min(1.0,RECOMB_BOOST*(1.0-exp(-ah_onsager/ahr_sep)));
          let ahrr=rf(&s);
          if(ahrr<ahp_recomb){
            let ahvd=rf(&s);
            if(ahvd<0.1365){
              atomicAdd(&counters[0],2u);
              atomicAdd(&counters[5],1u);
              let ahri=atomicAdd(&counters[7],3u);
              if(ahri+2u<p.max_rad){
                rad_buf[ahri]   =vec4<f32>(hpx,hpy,hpz,0.0+pid);
                rad_buf[ahri+1u]=vec4<f32>(hpx,hpy,hpz,0.0+pid);
                rad_buf[ahri+2u]=vec4<f32>(hpx,hpy,hpz,7.0+pid);
              }
            }else if(ahvd<0.494){
              atomicAdd(&counters[0],1u);
              atomicAdd(&counters[2],1u);
              let ahri=atomicAdd(&counters[7],2u);
              if(ahri+1u<p.max_rad){
                rad_buf[ahri]   =vec4<f32>(hpx,hpy,hpz,0.0+pid);
                rad_buf[ahri+1u]=vec4<f32>(hpx,hpy,hpz,2.0+pid);
              }
            }else if(ahvd<0.650){
              atomicAdd(&counters[2],2u);
              let ahri=atomicAdd(&counters[7],2u);
              if(ahri+1u<p.max_rad){
                rad_buf[ahri]   =vec4<f32>(hpx,hpy,hpz,2.0+pid);
                rad_buf[ahri+1u]=vec4<f32>(hpx,hpy,hpz,2.0+pid);
              }
            }
            // else 35% relax
          }else{
            atomicAdd(&counters[0],1u);
            atomicAdd(&counters[1],1u);
            atomicAdd(&counters[3],1u);
            let re=atomicAdd(&counters[7],3u);
            if(re+2u<p.max_rad){
              rad_buf[re]   =vec4<f32>(hpx,hpy,hpz,0.0+pid);
              rad_buf[re+1u]=vec4<f32>(hex,hey,hez,1.0+pid);
              rad_buf[re+2u]=vec4<f32>(hpx,hpy,hpz,3.0+pid);
            }
          }
        }
        // else: 50% relaxation
      }
      if(dna_near(px,py,pz)==1u){atomicAdd(&counters[4],1u);}
    }else if(r_type<xs.x+xs.y+s_vib){
      // Sanche vibrational excitation (2-100 eV, 9 modes).
      // G4DNASancheExcitationModel::SampleSecondaries only deposits energy;
      // it does NOT create molecular products. H2Ovib comes from
      // G4DNAElectronHoleRecombination (H2O+ + eaq → H2Ovib → dissoc),
      // which is modeled separately at the ionization site below.
      let mode=sample_vib_mode(E,rf(&s));
      let dep=min(VIB_LEV[mode],E);
      E-=dep;
      deposit(px,py,pz,dep,p.box,p.vc);
    }else if(r_type<xs.x+xs.y+s_vib+s_dea){
      // Melton dissociative electron attachment (G4ChemDissociationChannels_option1):
      // e⁻ + H₂O → H₂ + OH⁻ + OH (DissociAttachment_ch1, single channel)
      // Electron is captured; deposit all energy.
      deposit(px,py,pz,E,p.box,p.vc);
      atomicAdd(&counters[0],1u);  // OH (counters[0])
      atomicAdd(&counters[5],1u);  // initial H2 (counters[5])
      // OH- is tracked via rad_buf species code 6 (worker species index 5)
      let re=atomicAdd(&counters[7],3u);
      if(re+2u<p.max_rad){
        rad_buf[re]   =vec4<f32>(px,py,pz,0.0+pid);  // OH (species 0)
        rad_buf[re+1u]=vec4<f32>(px,py,pz,6.0+pid);  // OH- (worker species 5)
        rad_buf[re+2u]=vec4<f32>(px,py,pz,7.0+pid);  // H2 marker (counted, not tracked)
      }
      E=0.0; // electron killed
    }
    // else: elastic, no energy loss
  }

  // Deposit residual energy at final position for energy conservation.
  // Skip if particle escaped (its remaining E left the simulation volume).
  if(escaped==0u&&E>0.0){deposit(px,py,pz,E,p.box,p.vc);}

  results[idx]=R(total_path,productive_path,E,n_ions,n_exc,escaped,max_r,0u);
  rng[idx]=s;
  atomicAdd(&dbg[0],n_ions);
  atomicAdd(&dbg[1],n_exc);
  atomicAdd(&dbg[2],escaped);
  atomicAdd(&dbg[3],1u);
}
