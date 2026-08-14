#!/usr/bin/env node
// srv-boot.js — server release bootstrap (mirrors the fe/patches.json mechanism).
//
// FLOW: read server.js → apply srv/patches.json, then patches-2…N (gap stops the
// chain) → each file gated by baseSha256 + expectedSha256 → write server.gen.js
// → require it. ALL-OR-NOTHING: any failure logs the reason and starts the
// unpatched server.js so the site never goes down on a bad patch set.
//
// 2026-08-14 consolidation baked srv patches 1–68 into server.js; srv/patches.json
// is empty. New server releases can add patches again (or edit server.js directly).
// Empty patches.json → start server.js as-is (no server.gen.js).
//
// Dry-run: SRVBOOT_DRYRUN=1 exits after apply/fallback without listening.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fallback(reason) {
  console.error('[srv-boot] ✗ ' + reason + ' — starting unpatched server.js');
  if (process.env.SRVBOOT_DRYRUN) { console.log('[srv-boot] dry-run: fallback path'); process.exit(2); }
  require(path.join(ROOT, 'server.js'));
}

let src;
try { src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8'); }
catch (e) { return fallback('cannot read server.js: ' + e.message); }

const chain = [];
for (let n = 1; n <= 100; n++) {
  const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
  const file = path.join(ROOT, 'srv', name);
  if (!fs.existsSync(file)) {
    if (n === 1) return fallback('cannot read srv/patches.json: not found');
    break;
  }
  try { chain.push({ name: name, cfg: JSON.parse(fs.readFileSync(file, 'utf-8')) }); }
  catch (e) { return fallback('cannot read srv/' + name + ': ' + e.message); }
}

const total = chain.reduce((s, c) => s + (Array.isArray(c.cfg.patches) ? c.cfg.patches.length : 0), 0);
if (!total) {
  console.log('[srv-boot] no server patches — starting server.js as-is');
  if (process.env.SRVBOOT_DRYRUN) process.exit(0);
  require(path.join(ROOT, 'server.js'));
  return;
}

let out = src;
for (let c = 0; c < chain.length; c++) {
  const name = chain[c].name, cfg = chain[c].cfg;
  const patches = Array.isArray(cfg.patches) ? cfg.patches : [];
  if (cfg.baseSha256 && sha256(out) !== cfg.baseSha256)
    return fallback('srv/' + name + ' base drift: have ' + sha256(out).slice(0, 12) + ' ≠ expected ' + String(cfg.baseSha256).slice(0, 12));
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i] || {};
    const parts = out.split(p.find);
    const n = parts.length - 1;
    if (typeof p.find !== 'string' || n !== (p.count || 1))
      return fallback('srv/' + name + ' patch ' + (i + 1) + ' (' + String(p.note || '').slice(0, 60) + '): anchor count ' + n + ' ≠ ' + (p.count || 1));
    out = parts.join(p.replace);
  }
  if (cfg.expectedSha256 && sha256(out) !== cfg.expectedSha256)
    return fallback('srv/' + name + ' result sha256 ' + sha256(out).slice(0, 12) + ' ≠ expected ' + String(cfg.expectedSha256).slice(0, 12));
}

const GEN = path.join(ROOT, 'server.gen.js');
try { fs.writeFileSync(GEN, out); }
catch (e) { return fallback('cannot write server.gen.js: ' + e.message); }
console.log('[srv-boot] ✓ applied ' + total + ' server patches in ' + chain.length + ' file(s) → sha256 ' + sha256(out).slice(0, 12) + ' (server.gen.js)');
if (process.env.SRVBOOT_DRYRUN) { console.log('[srv-boot] dry-run: success path'); process.exit(0); }
require(GEN);
