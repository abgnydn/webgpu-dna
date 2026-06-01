// E10L — WebGPU SBS chemistry step-count feasibility probe.
//
// Question (from the inter-track-chemistry pivot): the existing GPU SBS
// kernel (src/shaders/chemistry.wgsl) runs the production CHEM_SCHEDULE = 133
// steps in ~14 s (E11) but undercounts at long times because dt=30 ns lets
// H3O+ move ~24 nm/step past the 4.5 nm search radius. The field-standard
// gMicroMC/MPEXS method uses many fine adaptive steps (per-step displacement
// ≤ ~1 cell). Can laptop WebGPU handle that step count at N=4096 (or reduced N)?
//
// Method: drive bench-chem.html's runGpuChemBench with single-block schedule
// overrides [[dt, S, 'end']] for several S, measure wall-clock, linear-fit
// t_wall = a + b·S to get per-step cost b and fixed overhead a. Extrapolate
// to the gMicroMC-scale step count. Repeat at np=4096 and a reduced np.
//
// Pure performance probe — does NOT assert accuracy (that's a follow-up once
// the per-step reaction-probability term is added). Does not change the
// production default schedule.
//
// CLI: node E10L-...mjs [np] [stepsCSV] [dt_ns]
//   e.g. node E10L-...mjs 4096 200,600,1500 0.02

import { chromium } from 'playwright';
import { existsSync, copyFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RAD_BIN_SRC = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RAD_BIN_PUBLIC = join(REPO_ROOT, 'public', 'rad_E10000_N4096.bin');
const ENERGY_EV = 10000;
const N_THERM = 4096;

const NP = Number(process.argv[2] ?? 4096);
const STEPS = (process.argv[3] ?? '200,600,1500').split(',').map(Number);
const DT_NS = Number(process.argv[4] ?? 0.02);
const TARGET_STEPS = 8000; // gMicroMC-scale extrapolation target

const BROWSER_ARGS = ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--no-sandbox'];

function gitSha() { try { return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); } catch { return 'unknown'; } }

async function main() {
  const env = captureEnv();
  if (!existsSync(RAD_BIN_SRC)) { console.error('missing', RAD_BIN_SRC); process.exit(1); }
  const stagedHere = !existsSync(RAD_BIN_PUBLIC);
  if (stagedHere) copyFileSync(RAD_BIN_SRC, RAD_BIN_PUBLIC);

  let server, browser;
  const rows = [];
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[E10L pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[E10L console]', m.text()); });

    await page.goto(`${server.url}/bench-chem.html`);
    await page.waitForFunction(() => window.__chemBenchReady === true || window.__chemBenchError, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__chemBenchError);
    if (err) throw new Error('bench init: ' + err);

    console.log(`\nnp=${NP}  dt=${DT_NS} ns  steps=${STEPS.join(',')}  (extrapolate to ${TARGET_STEPS})\n`);
    for (const S of STEPS) {
      const out = await page.evaluate(async ({ S, dt, np, energyEv, nTherm }) => {
        const r = await window.runGpuChemBench({
          binUrl: '/rad_E10000_N4096.bin', energyEv, nTherm, np,
          scheduleOverride: [[dt, S, 'end']],
        });
        return { walltimeMs: r.walltimeMs, radN: r.radN, adapter: r.adapter };
      }, { S, dt: DT_NS, np: NP, energyEv: ENERGY_EV, nTherm: N_THERM });
      const perStep = out.walltimeMs / S;
      rows.push({ steps: S, walltime_ms: out.walltimeMs, radN: out.radN, ms_per_step: perStep });
      console.log(`  steps=${String(S).padStart(5)}  radN=${out.radN}  t_wall=${(out.walltimeMs/1000).toFixed(2)}s  → ${perStep.toFixed(2)} ms/step`);
    }

    // Linear fit t = a + b*S (least squares).
    const n = rows.length;
    const sx = rows.reduce((s, r) => s + r.steps, 0);
    const sy = rows.reduce((s, r) => s + r.walltime_ms, 0);
    const sxx = rows.reduce((s, r) => s + r.steps * r.steps, 0);
    const sxy = rows.reduce((s, r) => s + r.steps * r.walltime_ms, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); // ms/step
    const a = (sy - b * sx) / n;                          // ms fixed overhead
    const extrapMs = a + b * TARGET_STEPS;
    const adapter = await page.evaluate(() => navigator.gpu ? 'webgpu' : 'none');

    console.log(`\nLinear fit: t_wall(S) = ${(a/1000).toFixed(2)}s + ${b.toFixed(3)} ms/step × S`);
    console.log(`Extrapolated wall-clock @ ${TARGET_STEPS} steps: ${(extrapMs/1000).toFixed(1)}s  (${(extrapMs/60000).toFixed(2)} min)`);
    console.log(`IRT reference (E15b): 194 s. GPU-SBS @ ${TARGET_STEPS} steps is ${(194000/extrapMs).toFixed(2)}× ${extrapMs<194000?'FASTER':'SLOWER'} than IRT.`);

    const result = {
      protocol: 'E10L-sbs-stepcount-feasibility', status: 'measured',
      git: gitSha(), date: '2026-06-01',
      config: { np: NP, dt_ns: DT_NS, energyEv: ENERGY_EV, nTherm: N_THERM, target_steps: TARGET_STEPS },
      env, rows,
      fit: { fixed_overhead_ms: a, ms_per_step: b, extrap_ms_at_target: extrapMs },
      irt_reference_s: 194,
      speedup_vs_irt_at_target: 194000 / extrapMs,
    };
    console.log('\nRESULT_JSON', JSON.stringify(result));
    const outDir = join(REPO_ROOT, 'experiments', 'results', '2026-06-01', 'level-4');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `E10L-stepcount-np${NP}.json`), JSON.stringify(result, null, 2));
    console.log(`\nWrote experiments/results/2026-06-01/level-4/E10L-stepcount-np${NP}.json`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop?.();
    if (stagedHere && existsSync(RAD_BIN_PUBLIC)) rmSync(RAD_BIN_PUBLIC);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
