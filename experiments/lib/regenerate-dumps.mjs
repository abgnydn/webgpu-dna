// Driver that re-generates dumps/rad_E*_N*.bin under the CURRENT shader
// constants. Used by the L2 post-joint-fix re-validation chain
// (E6 / E6b / E7 / E5c need fresh rad bins after the shader-side fix).
//
// Mechanism: starts the Vite dev server, opens the validation harness
// with ?dump=1 in the URL, intercepts every POST to /dump/<name> via
// Playwright's route handler, and writes the body to the local dumps/
// directory. No backend dump-server process needed.

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDevServer } from './dev-server.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DUMPS_DIR = join(REPO_ROOT, 'dumps');

export async function regenerateDumps(opts = {}) {
  const nPrimaries = opts.nPrimaries ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 1_200_000; // 20 min — IRT chem at 10 keV is the bottleneck

  const { chromium } = await import('playwright');
  mkdirSync(DUMPS_DIR, { recursive: true });

  let server;
  const writtenFiles = [];
  try {
    server = await startDevServer();
    const browser = await chromium.launch({
      headless: false,
      args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--no-sandbox'],
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Intercept POST /dump/<name>, write the body to dumps/<name>, return 200.
    await page.route('**/dump/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') {
        await route.fallback();
        return;
      }
      const url = new URL(req.url());
      const name = url.pathname.replace(/^.*\/dump\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const body = req.postDataBuffer();
      // Fulfill the route IMMEDIATELY so the browser moves on; flush
      // the body to disk asynchronously. Synchronous I/O on 50-200 MB
      // bodies inside the route handler was holding the browser long
      // enough that the next dispatch could OOM during 10 keV chem.
      await route.fulfill({ status: 200, body: '' });
      if (body && body.length > 0) {
        const path = join(DUMPS_DIR, name);
        await writeFile(path, body);
        writtenFiles.push({ name, bytes: body.length });
        console.error(`[regen] wrote ${path} (${(body.length / 1e6).toFixed(2)} MB)`);
      }
    });

    await page.goto(`${server.url}/?dump=1`, { waitUntil: 'domcontentloaded' });
    await page.fill('#np', String(nPrimaries));
    await page.click('#run');

    await page.waitForFunction(
      () => {
        const trs = document.querySelectorAll('#tb tr').length;
        const log = document.getElementById('log')?.innerText ?? '';
        return trs >= 8 && /Validation run complete/i.test(log);
      },
      null,
      { timeout: timeoutMs },
    );

    await browser.close();
    return { writtenFiles, pageErrors };
  } finally {
    if (server) {
      try {
        await new Promise((res) => {
          server.process.once('exit', res);
          server.stop();
          setTimeout(res, 3000);
        });
      } catch { /* nothing */ }
    }
  }
}
