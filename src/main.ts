/**
 * Entry point — wires the "Run validation" button to `runValidation()` and
 * binds the Reset button. Mirrors the final block of public/geant4dna.html.
 */

import { runValidation } from './app';
import {
  generateSnapshotAt10keV,
  openInViewer,
  downloadBlob,
  exportSnapshotAt10keV,
} from './splat/export';
import { createLogger } from './ui/log';

const lg = createLogger('log');

const $ = (id: string): HTMLElement | null =>
  typeof document !== 'undefined' ? document.getElementById(id) : null;

function readNumber(id: string, fallback: number): number {
  const el = $(id) as HTMLInputElement | null;
  const v = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function main(): void {
  if (typeof document === 'undefined') return;

  const runBtn = $('run') as HTMLButtonElement | null;
  const resetBtn = $('reset') as HTMLButtonElement | null;

  if (runBtn) {
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      if (resetBtn) resetBtn.disabled = true;
      // When the page is opened with ?dump=1, the run is for rad_buf
      // extraction (see src/app.ts) — chemistry is irrelevant and the
      // 10 keV IRT step takes ~3 min and risks an OOM under the
      // accumulated dump traffic. Skip chemistry for dump runs.
      const params = new URLSearchParams(window.location.search);
      const isDumpRun = params.has('dump');
      try {
        await runValidation({
          np: Math.round(readNumber('np', 4096)),
          boxNm: readNumber('box', 15000),
          ceEV: readNumber('cut', 7.4),
          log: lg,
          ...(isDumpRun ? { chemBackend: 'none' } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lg(`Error: ${msg}`, 'err');
        console.error(e);
      } finally {
        runBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
      }
    };
  }

  if (resetBtn) {
    resetBtn.onclick = () => {
      const tb = $('tb');
      const log = $('log');
      if (tb) tb.innerHTML = '';
      if (log) log.innerHTML = '';
    };
  }

  // "🌌 Visualize chemistry" — primary CTA. Runs one 10 keV pass with snapshot
  // capture, then opens the 4D viewer in a new tab and hands the blob over via
  // postMessage. No download/upload step.
  const vizBtn = $('visualize-4d') as HTMLButtonElement | null;
  if (vizBtn) {
    vizBtn.onclick = async () => {
      vizBtn.disabled = true;
      if (runBtn) runBtn.disabled = true;
      if (resetBtn) resetBtn.disabled = true;
      try {
        const r = await generateSnapshotAt10keV({
          np: Math.round(readNumber('np', 4096)),
          boxNm: readNumber('box', 15000),
          ceEV: readNumber('cut', 7.4),
          log: lg,
        });
        if (r) {
          openInViewer(r.blob, lg);
          lg(`Opened viewer with ${r.numCheckpoints} checkpoints (${r.sizeMB} MB).`, 'ok');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lg(`Visualize error: ${msg}`, 'err');
        console.error(e);
      } finally {
        vizBtn.disabled = false;
        if (runBtn) runBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
      }
    };
  }

  // "⬇ Save .bin" — secondary CTA. Runs the same pass but downloads the file
  // for offline use (e.g. shipping it as the demo default in /public/).
  const exportBtn = $('export-4d') as HTMLButtonElement | null;
  if (exportBtn) {
    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      if (runBtn) runBtn.disabled = true;
      if (resetBtn) resetBtn.disabled = true;
      try {
        await exportSnapshotAt10keV({
          np: Math.round(readNumber('np', 4096)),
          boxNm: readNumber('box', 15000),
          ceEV: readNumber('cut', 7.4),
          log: lg,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lg(`Export error: ${msg}`, 'err');
        console.error(e);
      } finally {
        exportBtn.disabled = false;
        if (runBtn) runBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
      }
    };
  }

  // Silence unused-import warning for downloadBlob (kept exported for callers).
  void downloadBlob;

  lg('Geant4-DNA validation harness (TypeScript modular build)');
  lg('Click "Run validation" to measure CSDA range and stopping power vs NIST ESTAR.');
}

main();
