// E13 — Indirect/direct SSB ratio vs PARTRAC reference.
//
// At low-LET, PARTRAC and other published track-structure simulators
// report that INDIRECT SSBs (from OH attack on the DNA backbone via
// diffused water radicals) dominate over DIRECT SSBs (from primary
// ionization at the backbone). Friedland 2011 and earlier studies
// (Nikjoo 2001, Semenenko & Stewart 2004) put the indirect/direct
// SSB ratio at ~2-3 for 60Co γ in liquid water.
//
// Our WGSL run at N=4096 × 10 keV reports:
//   SSB_dir = 24
//   SSB_ind = 0
// → indirect/direct = 0/24 = 0   vs PARTRAC ~2-3
//
// Why our number lands at 0 (diagnostic, not a bug):
//   1. Tiny damage radius. `SSB_R_DAMAGE_NM = 0.29 nm` (Nikjoo/Karamitros
//      OH→backbone reaction radius). PARTRAC and most operational
//      scorers use larger effective radii (~1 nm + 1.0 nm sugar/phosphate
//      VdW radius) because they fold in OH diffusion within a few-ps
//      "encounter" window. Our scorer is purely geometric on the
//      post-IRT positions.
//   2. Late-time scoring. `scoreIndirectSSB` is invoked at t = 1 μs on
//      the IRT chemistry output. Per E10, only ~30% of initial OH
//      survives to 1 μs (G(OH) drops from 4.55 at 1 ps to 1.55 at 1 μs).
//      Most OH that WOULD have hit the backbone is consumed by gas-phase
//      chemistry before reaching it.
//   3. Geometry. The 21×21 fiber grid covers a 3 μm × 3 μm × 3 μm slab
//      in the 30 μm box. Surviving OHs are scattered throughout the box;
//      few land within 0.29 nm of any backbone atom in the grid.
//
// Pass bar: indirect/direct ratio ∈ [0.5, 5] (PARTRAC reports 2-3, so a
// factor-2 band around that range catches reasonable models). Honest
// expectation: fail at 0/24. The experiment documents WHY rather than
// claims a number.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDS } from '../lib/seeds.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WGSL_RESULTS = join(REPO_ROOT, 'validation', 'webgpu-results.json');

const PARTRAC_INDIRECT_OVER_DIRECT_LOW = 2.0; // Nikjoo 2001 / Friedland 2011 lower edge
const PARTRAC_INDIRECT_OVER_DIRECT_HIGH = 3.0; // upper edge

export async function runE13() {
  const env = captureEnv();
  const meta = {
    protocol: 'E13-indirect-vs-direct-ssb',
    hypothesis:
      'The WGSL indirect/direct SSB ratio at 10 keV agrees with the low-LET literature consensus (indirect ~ 2-3× direct, from Nikjoo 2001 / Friedland 2011 / Semenenko & Stewart 2004) within a factor of 2.',
    passBar:
      'indirect / direct ∈ [1.0, 6.0] (factor-2 band around PARTRAC\'s 2-3).',
    seed: `E13_INDIRECT_SSB=0x${SEEDS.E13_INDIRECT_SSB.toString(16).toUpperCase()}`,
    warmup: 0,
    trials: 1,
    sources: {
      wgslResults: WGSL_RESULTS.replace(REPO_ROOT + '/', ''),
      partracRef:
        'Friedland W. et al (2011) Mut Res 711, 28-40 — PARTRAC low-LET DNA damage. Nikjoo H. et al (2001) Int J Radiat Biol 77, 1067-1083 — semi-analytical indirect/direct breakdown.',
      scoringCode: 'src/scoring/ssb-dsb.ts',
      constants:
        'src/physics/constants.ts — SSB_R_DAMAGE_NM=0.29, SSB_P_INDIRECT=0.4, SSB_P_DIRECT=0.15',
    },
    referenceCaveats: [
      'PARTRAC scores indirect SSBs from OH-backbone encounters during the full IRT timeline, not from OH survivors at t=1 μs. Our scoreIndirectSSB only sees t=1 μs survivors → systematic undercount.',
      'PARTRAC effective indirect-SSB radius is ~1 nm (includes diffusion-to-encounter), ours is 0.29 nm (Nikjoo reaction radius only).',
      'PARTRAC simulates a full chromatin cell; we use a 21×21 fiber grid (3.89 Mbp) concentrated in the track core. Sub-cellular geometry is documented as a known limitation in CLAUDE.md.',
    ],
  };

  if (!existsSync(WGSL_RESULTS)) {
    return {
      meta, env, status: 'skip',
      diagnosis: `WGSL results missing: ${WGSL_RESULTS}`,
      summary: { headline: 'skipped' }, rows: [],
    };
  }

  const wgsl = JSON.parse(readFileSync(WGSL_RESULTS, 'utf8'));
  const dmg = wgsl.dnaDamage ?? wgsl;
  const ssb_dir = dmg.SSB_dir ?? 0;
  const ssb_ind = dmg.SSB_ind ?? 0;
  const ratio = ssb_dir > 0 ? ssb_ind / ssb_dir : 0;

  const ratioPass = ratio >= 1.0 && ratio <= 6.0;
  const status = ratioPass ? 'pass' : 'fail';

  const rows = [
    {
      metric: 'indirect_over_direct_ratio',
      ssb_dir,
      ssb_ind,
      ratio,
      partrac_low: PARTRAC_INDIRECT_OVER_DIRECT_LOW,
      partrac_high: PARTRAC_INDIRECT_OVER_DIRECT_HIGH,
      passBar: 'ratio ∈ [1.0, 6.0] (factor-2 around PARTRAC 2-3)',
      status: ratioPass ? 'pass' : 'fail',
    },
    {
      metric: 'wgsl_constants',
      SSB_R_DAMAGE_NM: 0.29,
      SSB_P_INDIRECT: 0.4,
      SSB_P_DIRECT: 0.15,
      scoring_time_ns: 1000,
      G_OH_at_1us: wgsl.chemistry1Us?.G_OH ?? null,
      G_OH_at_1ps_init: wgsl.preChemistry?.G_OH_init ?? null,
      OH_survival_at_1us_pct:
        wgsl.preChemistry?.G_OH_init && wgsl.chemistry1Us?.G_OH
          ? (100 * wgsl.chemistry1Us.G_OH) / wgsl.preChemistry.G_OH_init
          : null,
      note: 'OH survives ~34% from initial G(OH)=4.51 to G(OH)=1.55 at 1 μs. Only the survivors are seen by scoreIndirectSSB — early OH-backbone encounters are not counted.',
      status: 'informational',
    },
    {
      metric: 'diagnosis',
      problem: 'WGSL SSB_ind = 0 → ratio 0 vs PARTRAC 2-3',
      root_cause_candidates: [
        '(a) Late-time scoring: scoreIndirectSSB sees only 1 μs OH survivors (~34% of initial); PARTRAC scores encounters during the full IRT',
        '(b) Small damage radius: 0.29 nm vs PARTRAC effective ~1 nm (folds in diffusion-to-encounter)',
        '(c) Geometry: 21×21 fiber grid samples only the track core; PARTRAC has full-cell DNA',
      ],
      fix_candidates_per_PHYSICS_DIAGNOSIS_md: [
        'Move indirect-SSB scoring into the IRT worker so it sees per-step OH-backbone encounters',
        'Raise SSB_R_DAMAGE_NM to ~1 nm to bracket PARTRAC',
        'Run on a full-cell DNA target geometry (deferred to E14)',
      ],
      status: 'informational',
    },
  ];

  const diagnosis = ratioPass
    ? null
    : `indirect/direct = ${ratio.toFixed(3)} ∉ [1.0, 6.0]; PARTRAC reports 2-3. See diagnosis row + PHYSICS_DIAGNOSIS.md for root-cause candidates and concrete fix paths.`;

  const summary = {
    ssb_dir,
    ssb_ind,
    indirect_over_direct: ratio,
    partrac_ref_range: `[${PARTRAC_INDIRECT_OVER_DIRECT_LOW}, ${PARTRAC_INDIRECT_OVER_DIRECT_HIGH}]`,
    headline: `WGSL indirect/direct = ${ssb_ind}/${ssb_dir} = ${ratio.toFixed(2)} vs PARTRAC 2-3 → ratio underestimate (root cause: late-time scoring + small damage radius)`,
  };

  return { meta, env, status, diagnosis, summary, rows };
}
