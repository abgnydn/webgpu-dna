#!/usr/bin/env node
/**
 * Version-consistency guard (runs inside `npm run check`, so CI blocks merges
 * on a mismatch). Prevents the recurring version-drift class: README said
 * "current release v0.6.0" while package.json was 0.7.0 and CITATION.cff
 * disagreed with itself (PR #1).
 *
 * Asserts a single source of truth — package.json `version` — equals:
 *   - every software `version:` field in CITATION.cff (top-level + preferred-citation;
 *     `cff-version:` is intentionally excluded — it is the CFF schema version), and
 *   - the README "current release is `vX.Y.Z`" string.
 *
 * Pure string parsing, offline, no deps. Exit 1 with a precise diff on mismatch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const errors = [];

// --- source of truth ---
const pkg = JSON.parse(read('package.json'));
const expected = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(expected)) {
  errors.push(`package.json version is not semver-shaped: "${expected}"`);
}

// --- CITATION.cff: every `version:` (NOT `cff-version:`) must match ---
const cff = read('CITATION.cff');
const cffVersions = [...cff.matchAll(/^[ \t]*version:[ \t]*["']?([^"'\s]+)/gm)].map((m) => m[1]);
if (cffVersions.length === 0) {
  errors.push('CITATION.cff: no `version:` field found');
}
cffVersions.forEach((v, i) => {
  if (v !== expected) {
    errors.push(`CITATION.cff version #${i + 1} is "${v}", expected "${expected}" (from package.json)`);
  }
});

// --- package-lock.json root version fields must match too (drifted to 0.3.0
// --- while package.json moved on — invisible because nothing checked it).
const lock = JSON.parse(read('package-lock.json'));
for (const [where, v] of [['package-lock.json top-level version', lock.version], ['package-lock.json packages[""].version', lock.packages?.['']?.version]]) {
  if (v !== expected) {
    errors.push(`${where} is "${v}", expected "${expected}" (from package.json)`);
  }
}
// --- README "current release is `vX.Y.Z`" must match ---
const readme = read('README.md');
const relMatch = readme.match(/current release is\s*`?v?(\d+\.\d+\.\d+)`?/i);
if (!relMatch) {
  errors.push('README.md: could not find a "current release is `vX.Y.Z`" line');
} else if (relMatch[1] !== expected) {
  errors.push(`README.md "current release" is "${relMatch[1]}", expected "${expected}" (from package.json)`);
}

if (errors.length) {
  console.error('✗ version-consistency check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nFix: make CITATION.cff and the README "current release" line match package.json (${expected}).`);
  process.exit(1);
}

console.log(`✓ version consistency: package.json, CITATION.cff (${cffVersions.length} fields), README all agree on ${expected}`);
