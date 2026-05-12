// Environment capture for experiment artifacts. Mirrors webgpu-q's `env`
// block: git SHA, timestamp, platform, plus Node-runtime metadata. GPU
// experiments (Level 2+) extend this with adapter info from
// `navigator.gpu.requestAdapter()` when run in a browser.

import { execSync } from 'node:child_process';
import { hostname, platform, arch, cpus, totalmem } from 'node:os';

function safeGitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'dev-unknown';
  }
}

function safeGitDirty() {
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

// Per-file blob hashes for the shader source. Lets a downstream consumer
// of the artifact JSON distinguish "this run is from before the joint
// fix" vs "this run is post joint-fix" without inspecting the parent
// commit — see PHYSICS_DIAGNOSIS.md and README § Numbers for why this
// matters. The hash is `git hash-object`, which is deterministic on
// the working-tree content (not influenced by uncommitted neighbors).
function safeShaderHash(path) {
  try {
    return execSync(`git hash-object ${path}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'dev-unknown';
  }
}

export function captureShaderHashes() {
  return {
    helpers_wgsl: safeShaderHash('src/shaders/helpers.wgsl'),
    primary_wgsl: safeShaderHash('src/shaders/primary.wgsl'),
    secondary_wgsl: safeShaderHash('src/shaders/secondary.wgsl'),
    chemistry_wgsl: safeShaderHash('src/shaders/chemistry.wgsl'),
    irt_worker_js: safeShaderHash('public/irt-worker.js'),
  };
}

export function captureEnv() {
  return {
    gitSha: safeGitSha(),
    gitDirty: safeGitDirty(),
    shaderHashes: captureShaderHashes(),
    timestamp: new Date().toISOString(),
    runner: 'node',
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
  };
}
