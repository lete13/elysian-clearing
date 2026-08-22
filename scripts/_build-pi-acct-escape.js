'use strict';
/**
 * Build fe/patches-140.json: HTML-escape the accountant card title in the
 * legacy Review-tab renderer. The Accountants sub-menu renderer already
 * escapes via piAcctEsc and overrides this one at runtime, but the stored
 * card name must never reach innerHTML unescaped from any code path.
 * Run: node scripts/_build-pi-acct-escape.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyFe(untilName) {
  let src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (name === untilName) break;
    const file = path.join(root, 'fe', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 && sha256(src) !== spec.baseSha256) throw new Error(name + ' base drift');
    for (const p of spec.patches || []) {
      const parts = src.split(p.find);
      if (parts.length - 1 !== (p.count || 1)) throw new Error(name + ' anchor: ' + p.note);
      src = parts.join(p.replace);
    }
    if (spec.expectedSha256 && sha256(src) !== spec.expectedSha256) throw new Error(name + ' expected sha');
  }
  return src;
}

const src = applyFe('patches-140.json');

const patches = [];

patches.push({
  note: 'Legacy accountant card title escapes the stored name',
  find:
    '          \'<div style="font-weight:600;margin-bottom:6px">\' + (c.name || c.email) + \'</div>\' +',
  replace:
    '          \'<div style="font-weight:600;margin-bottom:6px">\' + String(c.name || c.email).replace(/&/g, \'&amp;\').replace(/</g, \'&lt;\') + \'</div>\' +',
  count: 1,
});

let out = src;
for (const [i, p] of patches.entries()) {
  const parts = out.split(p.find);
  if (parts.length - 1 !== (p.count || 1)) {
    throw new Error('patch ' + (i + 1) + ' (' + p.note + '): anchor count ' + (parts.length - 1));
  }
  out = parts.join(p.replace);
}

const cfg = {
  baseSha256: sha256(src),
  expectedSha256: sha256(out),
  builtAt: '2026-08-22 Escape legacy accountant card title',
  patches: patches,
  assertions: [
    { has: "String(c.name || c.email).replace(/&/g, '&amp;').replace(/</g, '&lt;')", note: 'card title escaped' },
  ],
};

fs.writeFileSync(path.join(root, 'fe', 'patches-140.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote fe/patches-140.json', cfg.expectedSha256);
