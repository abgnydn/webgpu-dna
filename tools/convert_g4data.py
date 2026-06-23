#!/usr/bin/env python3
"""
Convert Geant4-DNA cross section data files (G4EMLOW) to WGSL constant arrays.

Usage:
    1. Download G4EMLOW: wget https://geant4-data.web.cern.ch/datasets/G4EMLOW8.6.1.tar.gz
    2. Extract: tar xzf G4EMLOW8.6.1.tar.gz
    3. Copy DNA data: cp -r G4EMLOW8.6.1/dna ../data/g4emlow/dna/
    4. Run: python3 convert_g4data.py
    
Output: WGSL shader fragment with cross section lookup tables.
"""

import os
import sys
import numpy as np
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "g4emlow" / "dna"

# Geant4-DNA scale factor (from G4DNABornIonisationModel.cc line 109)
# scaleFactor = (1.e-22 / 3.343) * m*m
# The data files contain values in internal Geant4 units.
# After LoadData with this scaleFactor, sigma is in Geant4 internal units (mm²).
# To convert to nm²: 1 mm² = 1e12 nm², but the data is per molecule.
# Actually: the .dat files have energy(eV) in col 0, then cross sections per shell
# The cross sections are in units that when multiplied by scaleFactor give mm².
# scaleFactor = 1e-22/3.343 m² = 2.993e-23 m² = 2.993e-5 nm²
SCALE_FACTOR = 2.993e-5  # converts raw data to nm² per molecule (Emfietzoglou models)
# Champion elastic uses a DIFFERENT scale factor:
# G4DNAChampionElasticModel.cc: scaleFactor = 1e-16*cm*cm = 1e-20 m² = 0.01 nm²
CHAMPION_SCALE = 0.01    # converts Champion elastic raw data to nm² per molecule

# Number of points to subsample for WGSL (keep it manageable for const arrays)
N_POINTS = 100


def load_sigma_file(filename, n_cols=None, scale=None):
    """Load a Geant4-DNA cross section data file.

    Two layouts appear in G4EMLOW:
      (a) one record per line: `E  s0 s1 ... sk`  (e.g. sigma_elastic_e_champion.dat)
      (b) the entire file on a single line, whitespace-delimited: a flat
          stream of (1 energy + k shells) tuples
          (e.g. sigma_ionisation_e_emfietzoglou.dat)

    If `n_cols` is given, the stream is reshaped to [N, n_cols]. Otherwise:
      - multi-line files infer n_cols from the first data line
      - single-line files try 6 (water: E + 5 shells/levels) then 2 (E, sigma)

    scale: override scale factor (default: SCALE_FACTOR for Emfietzoglou models)

    Returns: (energies_eV, sigmas_nm2 with shape [N_energies, N_shells])
    """
    filepath = DATA_DIR / filename
    if not filepath.exists():
        print(f"WARNING: {filepath} not found")
        return None, None

    with open(filepath) as f:
        raw = f.read()

    clean_lines = [ln for ln in raw.splitlines()
                   if ln.strip() and not ln.strip().startswith('#')]
    tokens_per_line = [len(ln.split()) for ln in clean_lines]

    if n_cols is None:
        if len(clean_lines) >= 10 and tokens_per_line[0] >= 2:
            n_cols = tokens_per_line[0]
        else:
            total = sum(tokens_per_line)
            for guess in (6, 2):
                if total % guess == 0:
                    n_cols = guess
                    break
            if n_cols is None:
                raise ValueError(
                    f"Cannot infer column count for {filename}: "
                    f"{total} tokens across {len(clean_lines)} lines"
                )

    flat = [float(x) for ln in clean_lines for x in ln.split()]
    if len(flat) % n_cols != 0:
        raise ValueError(
            f"{filename}: {len(flat)} tokens not divisible by n_cols={n_cols}"
        )

    data = np.array(flat).reshape(-1, n_cols)
    energies = data[:, 0]                    # eV
    sf = scale if scale is not None else SCALE_FACTOR
    sigmas = data[:, 1:] * sf                # nm^2 per molecule

    peak_tot = sigmas.sum(axis=1).max()
    peak_E = energies[sigmas.sum(axis=1).argmax()]
    print(f"  Loaded {filename}: {len(energies)} points, {sigmas.shape[1]} columns")
    print(f"  Energy range: {energies[0]:.1f} - {energies[-1]:.1f} eV")
    print(f"  Peak total sigma: {peak_tot:.6f} nm^2 at {peak_E:.1f} eV")

    return energies, sigmas


def subsample_logspace(energies, sigmas, n_points):
    """Subsample to n_points log-spaced energies with log-log interpolation."""
    log_e = np.log(energies)
    log_e_new = np.linspace(log_e[0], log_e[-1], n_points)
    e_new = np.exp(log_e_new)
    
    # Interpolate each column in log-log space
    n_cols = sigmas.shape[1] if sigmas.ndim > 1 else 1
    if sigmas.ndim == 1:
        sigmas = sigmas.reshape(-1, 1)
    
    s_new = np.zeros((n_points, n_cols))
    for j in range(n_cols):
        s = sigmas[:, j]
        # Handle zeros (can't take log of 0)
        mask = s > 0
        if mask.sum() < 2:
            continue
        s_new[:, j] = np.exp(np.interp(log_e_new, log_e[mask], np.log(s[mask]), 
                                        left=np.log(1e-15), right=np.log(1e-15)))
        # Zero out below threshold
        s_new[e_new < energies[mask][0], j] = 0
    
    return e_new, s_new


def to_wgsl_array(name, values, fmt=".8f"):
    """Convert numpy array to WGSL const array declaration."""
    n = len(values)
    vals = ",".join(f"{v:{fmt}}" for v in values)
    return f"const {name}=array<f32,{n}>({vals});"


def main():
    print("=== Geant4-DNA → WGSL Cross Section Converter ===\n")
    
    if not DATA_DIR.exists():
        print(f"ERROR: Data directory not found: {DATA_DIR}")
        print(f"\nPlease download G4EMLOW and copy the dna/ folder:")
        print(f"  wget https://geant4-data.web.cern.ch/datasets/G4EMLOW8.6.1.tar.gz")
        print(f"  tar xzf G4EMLOW8.6.1.tar.gz")
        print(f"  mkdir -p {DATA_DIR}")
        print(f"  cp -r G4EMLOW8.6.1/dna/* {DATA_DIR}/")
        sys.exit(1)
    
    print(f"Data directory: {DATA_DIR}\n")
    
    # ===== IONIZATION =====
    print("--- Ionization ---")
    # DNA_Opt2 uses Born ionization (NOT Emfietzoglou).
    # Born covers 11 eV - 1 MeV; Emfietzoglou covers 8 - 10000 eV.
    # G4EmDNABuilder: opt=2 → G4DNABornIonisationModel1 → sigma_ionisation_e_born
    ion_src = "sigma_ionisation_e_born.dat"
    e_ion, s_ion = load_sigma_file(ion_src)
    if e_ion is None:
        ion_src = "sigma_ionisation_e_emfietzoglou.dat"
        e_ion, s_ion = load_sigma_file(ion_src)

    # ===== EXCITATION =====
    print("\n--- Excitation ---")
    # Born excitation (9 - 10000 eV) — matches G4EmDNAPhysics_option2, which uses
    # G4DNABornExcitationModel for ALL electron energies (emaxE=0 for opt2, so the
    # Emfietzoglou block is never registered). This replaces the earlier
    # Emfietzoglou×SIGMA_EXC_SCALE=0.39 approximation: a flat scale can't match
    # Born's energy dependence (Emf/Born ≈ 2.5× at keV but ≈10× at ~10 eV), which
    # left the low-energy secondary cascade over-excited. Same 5 water levels
    # (8.22/10.0/11.24/12.61/13.77 eV, G4DNAWaterExcitationStructure) as before.
    # Scale factor: (1e-22 / 3.343) * m*m = 2.993e-5 nm².
    exc_src = "sigma_excitation_e_born.dat"
    e_exc, s_exc = load_sigma_file(exc_src)
    if e_exc is None:
        exc_src = "sigma_excitation_e_emfietzoglou.dat"
        e_exc, s_exc = load_sigma_file(exc_src)
    
    # ===== ELASTIC =====
    print("\n--- Elastic ---")
    # Elastic is analytical (Screened Rutherford), but Champion data exists
    e_el, s_el = load_sigma_file("sigma_elastic_e_champion.dat", scale=CHAMPION_SCALE)
    
    if e_ion is None:
        print("\nERROR: No ionization data found. Check data directory.")
        sys.exit(1)
    
    # ===== SUBSAMPLE AND GENERATE WGSL =====
    E_MAX_WGSL = 30000.0  # eV
    print(f"\n--- Generating WGSL ({N_POINTS} points) ---")

    # Total ionization (sum all shells)
    ion_total = s_ion.sum(axis=1)
    e_cap = e_ion[e_ion <= E_MAX_WGSL]
    s_cap = ion_total[e_ion <= E_MAX_WGSL]
    e_sub, ion_sub = subsample_logspace(e_cap, s_cap, N_POINTS)
    ion_sub = ion_sub[:, 0]

    # Per-shell ionization (for shell selection probabilities)
    s_ion_cap = s_ion[e_ion <= E_MAX_WGSL]
    _, ion_shells_sub = subsample_logspace(e_cap, s_ion_cap, N_POINTS)
    
    # Excitation: interpolate onto same e_sub grid as ionization
    if e_exc is not None:
        # Different grid — interpolate
        exc_total = s_exc.sum(axis=1)
        log_e_exc = np.log(e_exc)
        mask_exc = exc_total > 0
        exc_sub = np.exp(np.interp(
            np.log(e_sub), log_e_exc[mask_exc], np.log(exc_total[mask_exc]),
            left=np.log(1e-15), right=np.log(1e-15)
        ))
        exc_sub[e_sub < e_exc[mask_exc][0]] = 0
    else:
        exc_sub = np.zeros(N_POINTS)
    
    # Elastic: MUST interpolate onto the SAME e_sub grid as ionization.
    # Champion elastic data spans 7.4 eV - 10 MeV on its own energy grid.
    # We interpolate it onto e_sub (8 - 10000 eV from Emfietzoglou range)
    # using log-log interpolation.
    if e_el is not None:
        el_total = s_el.sum(axis=1) if s_el.ndim > 1 else s_el
        log_e_el = np.log(e_el)
        mask = el_total > 0
        if mask.sum() >= 2:
            el_sub = np.exp(np.interp(
                np.log(e_sub), log_e_el[mask], np.log(el_total[mask]),
                left=np.log(1e-15), right=np.log(1e-15)
            ))
            # Zero out energies below Champion's lowest tabulated point
            el_sub[e_sub < e_el[mask][0]] = 0
        else:
            el_sub = np.zeros(N_POINTS)
    else:
        el_sub = None

    # ===== CHAMPION ANGULAR DIFFERENTIAL CDF =====
    # File format: col0=E_eV  col1=cumulative_CDF  col2=theta_deg
    # The file is ALREADY the inverted CDF: for each E, a 181-point table giving
    # theta at 181 cumulative-probability values (0 to 1).
    # 101 unique energies, 181 CDF samples per energy.
    print("\n--- Champion angular differential CDF ---")
    ang_file = DATA_DIR / "sigmadiff_cumulated_elastic_e_champion.dat"
    el_ae = None   # energies for angular table
    el_ac = None   # cos(theta) values, shape [N_AE, N_AC]
    if ang_file.exists():
        rows = np.loadtxt(ang_file)
        energies = np.unique(rows[:, 0])
        print(f"  Loaded {len(rows)} rows, {len(energies)} unique energies")
        # Group: E -> list of (cdf, theta_deg)
        groups = {}
        for E, cdf, th in rows:
            groups.setdefault(E, []).append((cdf, th))
        for E in groups:
            groups[E].sort(key=lambda x: x[0])
        # For each target E, build a 25-bin (cdf -> cos(theta)) table
        N_AE = 25     # subsampled primary energies
        N_AC = 25     # CDF bins
        log_E = np.log(energies)
        E_sub = np.exp(np.linspace(log_E[0], log_E[-1], N_AE))
        cdf_query = np.linspace(0.0, 1.0, N_AC)
        table = np.zeros((N_AE, N_AC), dtype=np.float32)
        for i_E, E_target in enumerate(E_sub):
            idx = int(np.argmin(np.abs(energies - E_target)))
            entries = groups[energies[idx]]
            cd = np.array([e[0] for e in entries])
            th = np.array([e[1] for e in entries])
            # Enforce monotonic CDF (numerical cleanup)
            for k in range(1, len(cd)):
                if cd[k] < cd[k-1]:
                    cd[k] = cd[k-1]
            cmax = cd[-1] if cd[-1] > 0 else 1.0
            for j, r in enumerate(cdf_query):
                theta_deg = float(np.interp(r * cmax, cd, th))
                table[i_E, j] = np.cos(np.deg2rad(theta_deg))
        el_ae = E_sub.astype(np.float32)
        el_ac = table
        print(f"  Built inverted CDF: {N_AE} E x {N_AC} CDF bins = {N_AE*N_AC} floats")
        print(f"  E range: {el_ae[0]:.1f} - {el_ae[-1]:.1f} eV")
        # Validation: show median-angle behavior vs energy
        for probe_idx in [0, 5, 10, 15, 20, 24]:
            cos_vals = table[probe_idx]
            import math as _m
            theta_mid = _m.degrees(_m.acos(max(-1, min(1, float(cos_vals[N_AC//2])))))
            theta_end = _m.degrees(_m.acos(max(-1, min(1, float(cos_vals[-1])))))
            print(f"  E={el_ae[probe_idx]:11.1f}eV median_theta={theta_mid:6.2f}deg max_theta={theta_end:6.2f}deg")
    else:
        print(f"  WARNING: {ang_file} not found, skipping angular CDF")
    
    # ===== OUTPUT WGSL =====
    n = N_POINTS
    output = []
    output.append(f"// === GEANT4-DNA CROSS SECTIONS (ported from G4EMLOW data) ===")
    # Header names the ACTUAL source file loaded above (not a hardcoded model
    # literal) so it cannot drift from the data — the v0.7.0 Emfietzoglou->Born
    # swap left a stale "Excitation: Emfietzoglou model" header for a release (PR #1).
    output.append(f"// Ionization: from {ion_src}")
    output.append(f"// Excitation: from {exc_src}")
    output.append(f"// Elastic: Champion model (if available)")
    output.append(f"// {n} energy points, log-log interpolation")
    output.append(f"// Generated by convert_g4data.py from G4EMLOW data package")
    output.append(f"// License: Geant4 Software License (cite Geant4-DNA collaboration)")
    output.append(f"")
    output.append(f"const XN={n}u;")
    output.append(to_wgsl_array("XE", e_sub, ".4f"))
    output.append(to_wgsl_array("XI", ion_sub))
    output.append(to_wgsl_array("XC", exc_sub))
    if el_sub is not None:
        output.append(to_wgsl_array("XL", el_sub))
    # Log-space indexing constants for O(1) bin lookup
    log_xe0 = float(np.log(e_sub[0]))
    log_xe_step = float((np.log(e_sub[-1]) - np.log(e_sub[0])) / (n - 1))
    output.append(f"const LOG_XE0={log_xe0:.8f};")
    output.append(f"const INV_LOG_XE_STEP={1.0/log_xe_step:.8f};")
    
    # Per-shell fractions (for shell selection during ionization)
    output.append(f"")
    output.append(f"// Per-shell ionization fractions (for sampling which shell is ionized)")
    for shell_idx in range(min(5, ion_shells_sub.shape[1])):
        frac = np.where(ion_sub > 0, ion_shells_sub[:, shell_idx] / np.maximum(ion_sub, 1e-30), 0)
        output.append(to_wgsl_array(f"XSF{shell_idx}", frac))

    # Per-level excitation fractions (interpolated onto e_sub grid)
    if e_exc is not None and s_exc.shape[1] >= 5:
        output.append(f"")
        output.append(f"// Per-level excitation fractions (from {exc_src}, 5 levels)")
        exc_levels = s_exc[e_exc <= E_MAX_WGSL]
        log_e_exc_cap = np.log(e_exc[e_exc <= E_MAX_WGSL])
        for lev in range(min(5, exc_levels.shape[1])):
            s_lev = exc_levels[:, lev]
            mask_lev = s_lev > 0
            if mask_lev.sum() >= 2:
                lev_sub = np.exp(np.interp(
                    np.log(e_sub), log_e_exc_cap[mask_lev], np.log(s_lev[mask_lev]),
                    left=np.log(1e-15), right=np.log(1e-15)
                ))
                lev_sub[e_sub < e_exc[e_exc <= E_MAX_WGSL][mask_lev][0]] = 0
            else:
                lev_sub = np.zeros(N_POINTS)
            frac = np.where(exc_sub > 0, lev_sub / np.maximum(exc_sub, 1e-30), 0)
            output.append(to_wgsl_array(f"XEF{lev}", frac))

    # Champion angular differential (inverted CDF -> cos(theta) lookup)
    if el_ae is not None and el_ac is not None:
        N_AE, N_AC = el_ac.shape
        output.append(f"")
        output.append(f"// === CHAMPION ELASTIC ANGULAR CDF (inverted) ===")
        output.append(f"// XAE[i] = primary energy (eV), XAC[i*N_AC + j] = cos(theta) at CDF bin j")
        output.append(f"// Sample: given uniform r in [0,1], find E bin i, bilinear interp in (E, r)")
        output.append(f"const N_AE={N_AE}u;")
        output.append(f"const N_AC={N_AC}u;")
        output.append(to_wgsl_array("XAE", el_ae, ".4f"))
        output.append(to_wgsl_array("XAC", el_ac.flatten(), ".6f"))
        log_xae0 = float(np.log(el_ae[0]))
        log_xae_step = float((np.log(el_ae[-1]) - np.log(el_ae[0])) / (N_AE - 1))
        output.append(f"const LOG_XAE0={log_xae0:.8f};")
        output.append(f"const INV_LOG_XAE_STEP={1.0/log_xae_step:.8f};")

    # Emfietzoglou differential ionization (inverted CDF -> W_sec lookup)
    print("\n--- Born differential ionization ---")
    diff_file = DATA_DIR / "sigmadiff_cumulated_ionisation_e_born.dat"
    if diff_file.exists():
        rows = np.loadtxt(diff_file)
        unique_Ep = np.unique(rows[:, 0])
        print(f"  Loaded {len(rows)} rows, {len(unique_Ep)} unique E_primary "
              f"({unique_Ep[0]:.1f} - {unique_Ep[-1]:.1f} eV)")

        # Group by E_primary -> list of (E_transfer, cdf[5]) tuples
        groups = {}
        for row in rows:
            groups.setdefault(row[0], []).append((row[1], row[2:7]))
        for E in groups:
            groups[E].sort(key=lambda x: x[0])

        # Use all energies below E_MAX_WGSL; subsample CDF entries to N_WR.
        # Store PAIRED arrays: CDF values + E_transfer values per (shell, energy).
        # Shader does binary search in CDF array (replicates Geant4's algorithm).
        Ep_used = unique_Ep[unique_Ep <= E_MAX_WGSL]
        N_WE = len(Ep_used)
        N_WR = 250   # more breakpoints to capture CDF tail accurately
        N_SHELL = 5

        # Tables: CDF_table[shell][i_E][j] = CDF value, W_table[shell][i_E][j] = E_transfer
        CDF_table = np.zeros((N_SHELL, N_WE, N_WR), dtype=np.float32)
        W_table   = np.zeros((N_SHELL, N_WE, N_WR), dtype=np.float32)

        for i_E, E_target in enumerate(Ep_used):
            entries = groups[E_target]
            E_sec_arr = np.array([e[0] for e in entries])
            cdf_arr   = np.array([e[1] for e in entries])

            for sh in range(N_SHELL):
                cd = cdf_arr[:, sh].copy()
                for k in range(1, len(cd)):
                    if cd[k] < cd[k-1]:
                        cd[k] = cd[k-1]
                cmax = cd[-1] if cd[-1] > 0 else 0.0
                if cmax <= 0.0:
                    continue
                # CDF goes 0→2 (symmetric); we sample [0, min(cmax,1)]
                cmax_sec = min(cmax, 1.0)
                # Mask to secondary half only
                sec_mask = cd <= cmax_sec
                if sec_mask.sum() < 2:
                    continue
                cd_sec = cd[sec_mask]
                es_sec = E_sec_arr[sec_mask]
                # Subsample raw breakpoints to N_WR (preserve CDF shape)
                if len(cd_sec) > N_WR:
                    idx = np.round(np.linspace(0, len(cd_sec)-1, N_WR)).astype(int)
                    cd_sub = cd_sec[idx]
                    es_sub = es_sec[idx]
                else:
                    # Pad to N_WR by repeating last value
                    cd_sub = np.zeros(N_WR)
                    es_sub = np.zeros(N_WR)
                    cd_sub[:len(cd_sec)] = cd_sec
                    es_sub[:len(cd_sec)] = es_sec
                    cd_sub[len(cd_sec):] = cd_sec[-1]
                    es_sub[len(cd_sec):] = es_sec[-1]
                CDF_table[sh, i_E] = cd_sub
                W_table[sh, i_E]   = es_sub

        output.append("")
        output.append("// === BORN DIFFERENTIAL IONIZATION (paired CDF + E_transfer) ===")
        output.append(f"// Shader does binary search in CDF array (same as Geant4).")
        output.append(f"// XWE[i] = primary energy (eV), N_WE = {N_WE} (all Born energies ≤ {E_MAX_WGSL:.0f} eV)")
        output.append(f"// XWC{{k}}[i*N_WR+j] = CDF value at breakpoint j for shell k")
        output.append(f"// XWE_T{{k}}[i*N_WR+j] = E_transfer (eV) at breakpoint j for shell k")
        output.append(f"// Usage: given random r, binary search XWC for r, interpolate XWE_T")
        output.append(f"const N_WE={N_WE}u;")
        output.append(f"const N_WR={N_WR}u;")
        output.append(to_wgsl_array("XWE", Ep_used.astype(np.float32), ".4f"))
        log_xwe0 = float(np.log(Ep_used[0]))
        log_xwe_step = float((np.log(Ep_used[-1]) - np.log(Ep_used[0])) / (N_WE - 1))
        output.append(f"const LOG_XWE0={log_xwe0:.8f};")
        output.append(f"const INV_LOG_XWE_STEP={1.0/log_xwe_step:.8f};")
        for sh in range(N_SHELL):
            output.append(to_wgsl_array(f"XWC{sh}", CDF_table[sh].flatten(), ".6f"))
            output.append(to_wgsl_array(f"XWT{sh}", W_table[sh].flatten(), ".4f"))

        total_floats = N_SHELL * N_WE * N_WR * 2
        print(f"  Built paired CDF: {N_SHELL} shells × {N_WE} E_p × {N_WR} breakpoints × 2 = {total_floats} floats ({total_floats*4//1024} KB)")
        # Validation: sample and compute mean W_transfer
        for ep_test in [100, 1000, 10000]:
            i_E = int(np.argmin(np.abs(Ep_used - ep_test)))
            for sh in [0]:
                cd = CDF_table[sh, i_E]
                es = W_table[sh, i_E]
                cmax = cd[cd > 0][-1] if (cd > 0).any() else 0
                if cmax > 0:
                    r = np.random.uniform(0, cmax, 10000)
                    W = np.interp(r, cd, es)
                    print(f"  E_p={Ep_used[i_E]:.0f} sh0: mean_transfer={np.mean(W):.1f} eV (cmax={cmax:.3f})")
    else:
        print(f"  WARNING: {diff_file} not found, skipping")

    # Sanche vibrational excitation (2 - 100 eV range)
    # Source: sigma_excitationvib_e_sanche.dat (37 points × 9 modes)
    # Scale factor: 1e-16 cm² = 0.01 nm² per raw unit (from G4DNASancheExcitationModel.cc)
    print("\n--- Sanche vibrational excitation ---")
    vib_file = DATA_DIR / "sigma_excitationvib_e_sanche.dat"
    if vib_file.exists():
        VIB_SCALE = 0.01  # 1e-16 cm² / unit → 0.01 nm² / unit
        # Geant4 G4DNASancheExcitationModel applies 2× factor for liquid phase
        VIB_LIQUID_FACTOR = 2.0
        raw = np.loadtxt(vib_file)  # shape (37, 10)
        vib_E = raw[:, 0].astype(np.float32)     # eV
        vib_modes_raw = raw[:, 1:]               # (37, 9) raw cross sections
        vib_modes = vib_modes_raw * VIB_SCALE * VIB_LIQUID_FACTOR  # nm² per molecule (liquid)
        vib_total = vib_modes.sum(axis=1)        # (37,)  total σ_vib(E)
        vib_fracs = np.where(
            vib_total[:, None] > 0,
            vib_modes / np.maximum(vib_total[:, None], 1e-30),
            0.0
        )
        print(f"  Loaded {len(vib_E)} points from {vib_E[0]} to {vib_E[-1]} eV")
        print(f"  Peak total σ_vib: {vib_total.max():.6f} nm² at E={vib_E[vib_total.argmax()]:.1f} eV")

        output.append("")
        output.append("// === SANCHE VIBRATIONAL EXCITATION (2 - 100 eV) ===")
        output.append(f"// Source: sigma_excitationvib_e_sanche.dat, scale = 1e-16 cm² / unit")
        output.append(f"// XVE[i] = energy (eV), XVS[i] = total σ_vib(E) [nm²]")
        output.append(f"// XVMF[i*9 + k] = fraction of total σ from mode k at energy XVE[i]")
        output.append(f"// VIB_LEV[k] = energy lost per event for mode k (eV)")
        output.append(f"const N_VIB={len(vib_E)}u;")
        output.append(to_wgsl_array("XVE", vib_E, ".3f"))
        output.append(to_wgsl_array("XVS", vib_total.astype(np.float32)))
        output.append(to_wgsl_array("XVMF", vib_fracs.astype(np.float32).flatten()))
        # Threshold energies per mode from G4DNASancheExcitationModel.cc
        vib_lev = np.array([0.01, 0.024, 0.061, 0.092, 0.204, 0.417, 0.460, 0.500, 0.835], dtype=np.float32)
        output.append(f"const VIB_LEV=array<f32,9>({','.join(f'{v:.3f}' for v in vib_lev)});")
    else:
        print(f"  WARNING: {vib_file} not found, skipping")

    wgsl_text = "\n".join(output)

    # Single authoritative location: public/ is served by Vite at /cross_sections.wgsl
    # and fetched by src/shaders/loader.ts. No other copies.
    pub_out = Path(__file__).parent.parent / "public" / "cross_sections.wgsl"
    pub_out.parent.mkdir(exist_ok=True)
    with open(pub_out, 'w') as f:
        f.write(wgsl_text)
    print(f"\nWrote: {pub_out} ({len(wgsl_text)} bytes)")
    
    # Also print validation
    print(f"\n--- Validation ---")
    print(f"{'E(eV)':>8} {'σ_ion(nm²)':>12} {'σ_exc(nm²)':>12} {'σ_el(nm²)':>12} {'MFP_tot(nm)':>12}")
    for i in range(0, n, n//10):
        st = ion_sub[i] + exc_sub[i] + (el_sub[i] if el_sub is not None else 0)
        mfp = 1/(33.4*st) if st > 0 else 999
        print(f"{e_sub[i]:8.1f} {ion_sub[i]:12.6f} {exc_sub[i]:12.6f} "
              f"{el_sub[i] if el_sub is not None else 0:12.6f} {mfp:12.2f}")
    
    print(f"\n✓ Done. Paste the contents of {outpath} into the PHYSICS shader,")
    print(f"  replacing the existing XE/XI/XC/XL arrays.")


if __name__ == "__main__":
    main()
