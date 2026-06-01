// E10P — SBS per-step cost vs radical count (compaction lever).
//
// E10L measured ~110 ms/step over the full 4.97 M radical set. Lever #1 for
// making GPU-SBS beat IRT is cutting per-step cost — chiefly by NOT paying
// for dead radicals at late times (compaction) and NOT clearing all 8 M hash
// buckets every step. This experiment decides how much compaction alone can
// buy by measuring per-step cost as a function of live radical count N:
//
//   per_step(N) ≈ fixed + slope·N
//
// where `fixed` is the N-independent floor (clear_hash over 8 M buckets +
// dispatch overhead) and `slope` is the per-radical dispatch+react cost.
// If `fixed` dominates, compaction barely helps and the hash must shrink too.
// If `slope` dominates, late-time compaction (≈2× fewer alive at 1 µs)
// directly cuts late-step cost.
//
// Method: fixed 200-step single-block schedule, sweep maxRad. Pure cost probe.

import { chromium } from 'playwright';
import { existsSync, copyFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RAD_BIN_SRC = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RAD_BIN_PUBLIC = join(REPO_ROOT, 'public', 'rad_E10000_N4096.bin');
const ENERGY_EV = 10000, N_THERM = 4096, STEPS = 200, DT = 0.02;
const RAD_CAPS = [500000, 1500000, 3000000, 5000000];
const BROWSER_ARGS = ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--no-sandbox'];
function gitSha(){try{return execSync('git rev-parse --short HEAD',{cwd:REPO_ROOT}).toString().trim();}catch{return'?';}}

async function main() {
  const env = captureEnv();
  if (!existsSync(RAD_BIN_SRC)) { console.error('missing bin'); process.exit(1); }
  const stagedHere = !existsSync(RAD_BIN_PUBLIC);
  if (stagedHere) copyFileSync(RAD_BIN_SRC, RAD_BIN_PUBLIC);
  let server, browser;
  const rows = [];
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[E10P pageerror]', e.message));
    await page.goto(`${server.url}/bench-chem.html`);
    await page.waitForFunction(() => window.__chemBenchReady === true || window.__chemBenchError, null, { timeout: 60000 });

    console.log(`\nSBS per-step cost vs radical count  (${STEPS} steps, dt=${DT} ns)\n`);
    console.log(`  ${'maxRad'.padStart(9)} ${'radN'.padStart(9)} ${'t_wall'.padStart(8)} ${'ms/step'.padStart(8)}`);
    for (const cap of RAD_CAPS) {
      const r = await page.evaluate(async ({ cap, steps, dt, energyEv, nTherm }) => {
        return await window.runGpuChemBench({ binUrl: '/rad_E10000_N4096.bin', energyEv, nTherm, np: 4096, maxRad: cap, scheduleOverride: [[dt, steps, 'end']] });
      }, { cap, steps: STEPS, dt: DT, energyEv: ENERGY_EV, nTherm: N_THERM });
      const perStep = r.walltimeMs / STEPS;
      rows.push({ maxRad: cap, radN: r.radN, walltime_ms: r.walltimeMs, ms_per_step: perStep });
      console.log(`  ${String(cap).padStart(9)} ${String(r.radN).padStart(9)} ${(r.walltimeMs/1000).toFixed(1).padStart(7)}s ${perStep.toFixed(1).padStart(8)}`);
    }

    // Fit ms/step = fixed + slope·N  (least squares on radN).
    const n = rows.length;
    const sx = rows.reduce((s,r)=>s+r.radN,0), sy = rows.reduce((s,r)=>s+r.ms_per_step,0);
    const sxx = rows.reduce((s,r)=>s+r.radN*r.radN,0), sxy = rows.reduce((s,r)=>s+r.radN*r.ms_per_step,0);
    const slope = (n*sxy - sx*sy)/(n*sxx - sx*sx);     // ms per radical
    const fixed = (sy - slope*sx)/n;                   // ms floor (clear_hash+overhead)
    const fixedShareAt5M = fixed / (fixed + slope*5e6);
    console.log(`\nFit: ms/step = ${fixed.toFixed(1)} (fixed floor) + ${(slope*1e6).toFixed(1)} ms/Mrad × N`);
    console.log(`Fixed floor is ${(fixedShareAt5M*100).toFixed(0)}% of the 5M per-step cost.`);
    // Project: if late-time alive ≈ 2.5M (half reacted) and the floor stays,
    // late per-step ≈ fixed + slope·2.5e6. With a 32× smaller hash the floor
    // shrinks toward overhead-only (~unknown; report both bounds).
    const perStep25 = fixed + slope*2.5e6;
    console.log(`Projected per-step @ 2.5M alive (late-time, current 8M hash): ${perStep25.toFixed(1)} ms`);
    console.log(`IRT-parity budget = 194000 ms. At ${perStep25.toFixed(0)} ms/step → ${Math.round(194000/perStep25)} steps before parity.`);

    const result = { protocol:'E10P-sbs-perstep-scaling', status:'measured', git:gitSha(), date:'2026-06-01',
      config:{ steps:STEPS, dt_ns:DT, energyEv:ENERGY_EV, nTherm:N_THERM }, env, rows,
      fit:{ fixed_floor_ms:fixed, ms_per_Mrad:slope*1e6, fixed_share_at_5M:fixedShareAt5M, perstep_at_2p5M_ms:perStep25 } };
    console.log('\nRESULT_JSON', JSON.stringify(result));
    const outDir = join(REPO_ROOT,'experiments','results','2026-06-01','level-4');
    mkdirSync(outDir,{recursive:true});
    writeFileSync(join(outDir,'E10P-perstep-scaling.json'), JSON.stringify(result,null,2));
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop?.();
    if (stagedHere && existsSync(RAD_BIN_PUBLIC)) rmSync(RAD_BIN_PUBLIC);
  }
}
main().catch((e)=>{console.error(e);process.exit(1);});
