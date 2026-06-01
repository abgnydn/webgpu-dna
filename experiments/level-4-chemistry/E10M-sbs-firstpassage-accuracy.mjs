// E10M — GPU SBS chemistry with first-passage reaction probability vs IRT.
//
// E10L showed naive uniform fine-stepping (~8000 steps) is 4.6× slower than
// IRT. The fix (gMicroMC/MPEXS2.1): replace the kernel's end-position contact
// test with the first-passage probability W(dt|r0)=(σ/reff)·erfc[(reff-σ)/
// √(4Ddt)], which → Winf as dt→∞ (IRT limit). Implemented in chemistry.wgsl
// 2026-06-01. THE test: does first-passage hit IRT-grade G-values at a LOW
// step count where naive contact undercounted?
//
// Runs several [dt,n_steps] schedules, compares per-species G-values to the
// cached IRT reference (experiments/.cache/E10/E10000-N4096.json) at each
// matching checkpoint, and reports max deviation + wall-clock + total steps.
//
// Pure prototype measurement. The GPU kernel models a reduced reaction set
// (7 reactions, no eaq+H2O2 / H3O++OH-), so exact IRT parity isn't expected;
// the question is whether the long-time undercount is FIXED and how many
// steps it takes.

import { chromium } from 'playwright';
import { existsSync, copyFileSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startDevServer } from '../lib/dev-server.mjs';
import { captureEnv } from '../lib/env.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RAD_BIN_SRC = join(REPO_ROOT, 'dumps', 'rad_E10000_N4096.bin');
const RAD_BIN_PUBLIC = join(REPO_ROOT, 'public', 'rad_E10000_N4096.bin');
const IRT_CACHE = join(REPO_ROOT, 'experiments', '.cache', 'E10', 'E10000-N4096.json');
const ENERGY_EV = 10000;
const N_THERM = 4096;
const BROWSER_ARGS = ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--no-sandbox'];

function gitSha() { try { return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); } catch { return '?'; } }

// Schedules: [label, [[dt_ns, n_steps, cp_label], ...]]
// "prod133" = the production CHEM_SCHEDULE. "fine" subdivides the late blocks
// (where dt was largest) to test whether more late steps improve 100ns/1us.
const SCHEDULES = {
  prod133: [
    [0.0001, 10, '1 ps'], [0.001, 9, '10 ps'], [0.005, 18, '100 ps'],
    [0.05, 18, '1 ns'], [0.5, 18, '10 ns'], [3.0, 30, '100 ns'], [30.0, 30, '1 us'],
  ],
  fine: [
    [0.0001, 10, '1 ps'], [0.001, 9, '10 ps'], [0.005, 18, '100 ps'],
    [0.05, 18, '1 ns'], [0.2, 45, '10 ns'], [0.5, 180, '100 ns'], [2.0, 450, '1 us'],
  ],
};

const CP_TIMES = { '1 ps': 0.001, '10 ps': 0.01, '100 ps': 0.1, '1 ns': 1, '10 ns': 10, '100 ns': 100, '1 us': 1000 };
const SPECIES = ['G_OH', 'G_eaq', 'G_H', 'G_H2', 'G_H2O2'];

async function main() {
  const env = captureEnv();
  if (!existsSync(RAD_BIN_SRC) || !existsSync(IRT_CACHE)) { console.error('missing bin or IRT cache'); process.exit(1); }
  const irt = JSON.parse(readFileSync(IRT_CACHE, 'utf8')).irtResult.timeline;
  const irtAt = (t) => irt.find((c) => Math.abs(c.t_ns - t) / t < 0.01);

  const stagedHere = !existsSync(RAD_BIN_PUBLIC);
  if (stagedHere) copyFileSync(RAD_BIN_SRC, RAD_BIN_PUBLIC);
  let server, browser;
  const out = {};
  try {
    server = await startDevServer();
    browser = await chromium.launch({ headless: false, args: BROWSER_ARGS });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[E10M pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[E10M console]', m.text()); });
    await page.goto(`${server.url}/bench-chem.html`);
    await page.waitForFunction(() => window.__chemBenchReady === true || window.__chemBenchError, null, { timeout: 60000 });

    for (const [name, sched] of Object.entries(SCHEDULES)) {
      const steps = sched.reduce((s, b) => s + b[1], 0);
      const r = await page.evaluate(async ({ sched, energyEv, nTherm }) => {
        return await window.runGpuChemBench({
          binUrl: '/rad_E10000_N4096.bin', energyEv, nTherm, np: 4096, scheduleOverride: sched,
        });
      }, { sched, energyEv: ENERGY_EV, nTherm: N_THERM });

      console.log(`\n=== ${name}: ${steps} steps, t_wall=${(r.walltimeMs/1000).toFixed(1)}s, radN=${r.radN} ===`);
      console.log(`  ${'cp'.padEnd(8)} ${SPECIES.map(s=>s.replace('G_','').padStart(7)).join(' ')}   (GPU / IRT)`);
      const rows = [];
      let maxDev = 0, maxDevAt = '';
      for (const cp of r.timeline) {
        if (cp.t_ns === 0) continue;
        const ref = irtAt(cp.t_ns);
        if (!ref) continue;
        const cells = SPECIES.map((sp) => {
          const g = cp[sp] ?? 0, gi = ref[sp] ?? 0;
          const ratio = gi > 0 ? g / gi : 0;
          if (gi > 0.05 && Math.abs(ratio - 1) > maxDev) { maxDev = Math.abs(ratio - 1); maxDevAt = `${cp.label}/${sp}`; }
          return { sp, gpu: g, irt: gi, ratio };
        });
        rows.push({ label: cp.label, t_ns: cp.t_ns, cells });
        console.log(`  ${cp.label.padEnd(8)} ${cells.map(c=>`${c.ratio.toFixed(2)}×`.padStart(7)).join(' ')}`);
      }
      // show absolute G at 1us
      const last = r.timeline[r.timeline.length - 1];
      const ref1us = irtAt(1000);
      console.log(`  1us abs: ` + SPECIES.map(s=>`${s.replace('G_','')}=${(last[s]??0).toFixed(2)}(irt ${(ref1us[s]??0).toFixed(2)})`).join(' '));
      out[name] = { steps, walltime_ms: r.walltimeMs, radN: r.radN, maxDev, maxDevAt, rows, adapter: r.adapter };
      console.log(`  → max deviation ${(maxDev*100).toFixed(0)}% at ${maxDevAt}`);
    }

    const result = { protocol: 'E10M-sbs-firstpassage-accuracy', status: 'measured', git: gitSha(), date: '2026-06-01',
      config: { energyEv: ENERGY_EV, nTherm: N_THERM, np: 4096 }, env, irt_reference: 'experiments/.cache/E10/E10000-N4096.json', schedules: out };
    console.log('\nRESULT_JSON', JSON.stringify(result));
    const outDir = join(REPO_ROOT, 'experiments', 'results', '2026-06-01', 'level-4');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'E10M-firstpassage-accuracy.json'), JSON.stringify(result, null, 2));
    console.log('\nWrote E10M-firstpassage-accuracy.json');
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop?.();
    if (stagedHere && existsSync(RAD_BIN_PUBLIC)) rmSync(RAD_BIN_PUBLIC);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
