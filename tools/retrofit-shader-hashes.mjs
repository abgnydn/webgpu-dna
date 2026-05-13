#!/usr/bin/env node
/**
 * Retrofit shaderHashes onto pre-2026-05-12 artifacts.
 *
 * Walks experiments/results/<date>/<level>/*.json and, for each
 * artifact that's missing env.shaderHashes, reads env.gitSha and
 * back-fills the per-file hashes by asking git for the blob hash
 * of each shader at that revision.
 *
 * Idempotent: skips artifacts that already have shaderHashes (so
 * future artifacts written by captureEnv() are left alone).
 *
 * Usage:
 *   node tools/retrofit-shader-hashes.mjs            # dry run
 *   node tools/retrofit-shader-hashes.mjs --write    # actually write
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_ROOT = join(REPO_ROOT, 'experiments', 'results');
const SHADER_PATHS = [
  ['helpers_wgsl', 'src/shaders/helpers.wgsl'],
  ['primary_wgsl', 'src/shaders/primary.wgsl'],
  ['secondary_wgsl', 'src/shaders/secondary.wgsl'],
  ['chemistry_wgsl', 'src/shaders/chemistry.wgsl'],
  ['irt_worker_js', 'public/irt-worker.js'],
];

const args = new Set(process.argv.slice(2));
const writeMode = args.has('--write');

function gitBlobHashAt(sha, path) {
  try {
    return execSync(`git rev-parse ${sha}:${path}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown-at-commit';
  }
}

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.json')) acc.push(p);
  }
  return acc;
}

const files = walk(RESULTS_ROOT, []);
let nWritten = 0;
let nSkippedHasHashes = 0;
let nSkippedNoSha = 0;
let nDryRunWould = 0;

for (const path of files) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.env?.shaderHashes) {
    nSkippedHasHashes++;
    continue;
  }
  const sha = json.env?.gitSha;
  if (!sha || sha === 'dev-unknown') {
    nSkippedNoSha++;
    continue;
  }
  const shaderHashes = {};
  for (const [key, srcPath] of SHADER_PATHS) {
    shaderHashes[key] = gitBlobHashAt(sha, srcPath);
  }
  if (!json.env) json.env = {};
  json.env.shaderHashes = shaderHashes;
  json.env.shaderHashesRetrofit = {
    retrofittedAt: new Date().toISOString(),
    method: 'git rev-parse <gitSha>:<shader-path>',
    note: 'Retrofit by tools/retrofit-shader-hashes.mjs — original artifact predated the shaderHashes audit fix (2026-05-12).',
  };
  if (writeMode) {
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    nWritten++;
    console.log(`[retrofit] wrote ${path.replace(REPO_ROOT + '/', '')}`);
  } else {
    nDryRunWould++;
    console.log(`[dry-run] would write ${path.replace(REPO_ROOT + '/', '')} (sha=${sha.slice(0, 7)})`);
  }
}

console.log(`\nsummary:`);
console.log(`  total artifacts: ${files.length}`);
console.log(`  already had shaderHashes: ${nSkippedHasHashes}`);
console.log(`  missing gitSha: ${nSkippedNoSha}`);
if (writeMode) {
  console.log(`  retrofitted (written): ${nWritten}`);
} else {
  console.log(`  would retrofit (dry run): ${nDryRunWould}`);
  console.log(`  re-run with --write to actually patch the files`);
}
