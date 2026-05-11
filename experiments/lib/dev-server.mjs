// Vite dev-server lifecycle helper for browser-runner experiments.
//
// Spawns `npm run dev` (vite on http://localhost:8765 per the project's
// vite.config.ts), waits for the "ready" log line, and returns a
// disposer that kills the process group on cleanup.
//
// Usage:
//   const server = await startDevServer();
//   try {
//     // navigate Playwright to server.url, run experiment
//   } finally {
//     await server.stop();
//   }

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

// Vite typically picks 8765 per vite.config.ts; if taken, it'll bump.
// We capture the actual URL from the ready log line.
//
// Vite emits ANSI escapes (color + bold) around "Local" and the URL —
// strip them before regex matching, otherwise `Local:` becomes
// `Local\x1b[22m:` and the regex misses (silently falling back to
// localhost:8765 = wrong port when 8765 is held by another tool).
const VITE_READY_REGEX = /Local:\s+(https?:\/\/\S+?)\/?\s*$/im;
const VITE_READY_FALLBACK_REGEX = /ready in/i;
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_REGEX, '');

export async function startDevServer({ readyTimeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', CI: '1' },
      detached: true, // own process group so we can kill children too
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let resolvedUrl = null;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      stop();
      reject(new Error(`vite dev server did not signal ready within ${readyTimeoutMs}ms.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    }, readyTimeoutMs);

    function maybeReady(_chunk) {
      if (resolved) return;
      const clean = stripAnsi(stdout);
      // Match against accumulated, ANSI-stripped stdout — the "Local: URL"
      // line may arrive in a different chunk than "ready in Xms", and we
      // MUST commit to the actual URL vite picked (port shifts to 8766+
      // when 8765 is held by another tool).
      const m = clean.match(VITE_READY_REGEX);
      if (m) {
        resolvedUrl = m[1];
        finish();
        return;
      }
      // We have a "ready in" signal but no Local: line yet. Wait briefly
      // (Local: arrives within a few hundred ms on every vite we test),
      // then fall back. The fallback URL should NEVER be used in practice;
      // it exists only so a vite version that drops the Local: line
      // entirely doesn't deadlock.
      if (VITE_READY_FALLBACK_REGEX.test(clean) && !resolvedUrl) {
        setTimeout(() => {
          if (resolved) return;
          const m2 = stripAnsi(stdout).match(VITE_READY_REGEX);
          if (m2) {
            resolvedUrl = m2[1];
            finish();
            return;
          }
          resolvedUrl = 'http://localhost:8765';
          finish();
        }, 2000);
      }
    }

    function finish() {
      resolved = true;
      clearTimeout(timer);
      resolve({
        url: resolvedUrl,
        process: proc,
        stdout: () => stdout,
        stderr: () => stderr,
        stop,
      });
    }

    function stop() {
      try {
        // Kill the whole process group (-pid) — vite spawns child workers.
        if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try { proc.kill('SIGTERM'); } catch { /* nothing */ }
      }
    }

    proc.stdout.on('data', (b) => {
      const s = b.toString();
      stdout += s;
      maybeReady(s);
    });
    proc.stderr.on('data', (b) => {
      const s = b.toString();
      stderr += s;
      maybeReady(s);
    });
    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(`vite dev server exited prematurely (code=${code}).\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    });
  });
}
