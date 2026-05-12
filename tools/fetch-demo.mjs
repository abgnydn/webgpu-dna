#!/usr/bin/env node
/**
 * Build-time fetch for the bundled 4D viewer demo snapshot.
 *
 * The 8.4 MB `wgdna-default.bin` is hosted as a GitHub Release asset (so it
 * stays out of the repo's git history). Cloudflare Pages and any local
 * `npm run build` invokes this via the `prebuild` script — the file lands
 * in `public/` and Vite copies it into `dist/` so the viewer can fetch
 * it same-origin at `/wgdna-default.bin` (no CORS).
 *
 * Idempotent: skips the download if the local file already matches the
 * expected size.
 */
import { createWriteStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

// Pinned to the demo-v1 release tag (the asset's home). The /latest/
// alias points at v0.1.0 — the source-code release — which does NOT
// carry the binary asset, so /latest/download 404s on a clean build.
const RELEASE_URL =
  'https://github.com/abgnydn/webgpu-dna/releases/download/demo-v1/wgdna-default.bin';
const EXPECTED_SIZE = 8_803_686;

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, '..', 'public', 'wgdna-default.bin');

async function main() {
  if (existsSync(target) && statSync(target).size === EXPECTED_SIZE) {
    console.log(`[fetch-demo] up to date (${target})`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  console.log(`[fetch-demo] downloading ${RELEASE_URL}`);
  const resp = await fetch(RELEASE_URL, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('fetch returned no body');
  await pipeline(resp.body, createWriteStream(target));
  const size = statSync(target).size;
  console.log(`[fetch-demo] wrote ${target} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  if (size !== EXPECTED_SIZE) {
    console.warn(`[fetch-demo] WARNING: size ${size} != expected ${EXPECTED_SIZE}`);
  }
}

main().catch((err) => {
  console.error('[fetch-demo] failed:', err.message);
  process.exit(1);
});
