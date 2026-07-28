#!/usr/bin/env node
/**
 * Print the 1 us G-values from a run_irt.cjs result JSON, next to the
 * matched chem6 reference (README E10j). Used by the chemistry-validation CI
 * workflow to surface a human-readable summary above the uploaded artifact.
 *
 * Usage: node tools/irt-summary.cjs <irt_result.json>
 */
'use strict';
const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/irt-summary.cjs <irt_result.json>');
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const us = r.timeline.find((t) => t.label === '1 us') || r.timeline[r.timeline.length - 1];
const f = (x) => Number(x).toFixed(3);
console.log('=== IRT 1 us G-values ===');
console.log(
  `G(OH)=${f(us.G_OH)} G(eaq)=${f(us.G_eaq)} G(H)=${f(us.G_H)} ` +
    `G(H2O2)=${f(us.G_H2O2)} G(H2)=${f(us.G_H2)}`,
);
console.log(
  'chem6 @ 10 keV matched (E10j) -> ' +
    'G(OH)=1.710 G(eaq)=1.690 G(H)=0.710 G(H2O2)=0.850 G(H2)=0.622',
);
