#!/usr/bin/env node
// srv-boot.js — server release bootstrap (mirrors the fe/patches.json mechanism).
// Applies the srv/patches*.json chain to server.js at boot: ordered exact string
// replacements, gated by baseSha256 (the server.js the patches expect) and
// expectedSha256 (the result). Releases chain: srv/patches.json, then
// srv/patches-2.json, -3.json … each file starts where the previous one ended,
// so a release is a small new file instead of a rewrite of one ever-growing
// patches.json. ALL-OR-NOTHING: any failure (missing file, base drift, anchor
// count mismatch, result sha mismatch) logs the reason and starts the unpatched
// server.js instead, so the app never goes down on a bad patch set.
// Consolidation: upload the full patched server.js via GitHub web, reset
// srv/patches.json to {"patches":[]} and delete the chain files in the same
// release — the base-drift gate makes a missed reset safe.
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
try { src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8').replace(/\r\n/g, '\n'); }
catch (e) { return fallback('cannot read server.js: ' + e.message); }

const chain = [];
for (let n = 1; n <= 140; n++) { /* legacy note: n <= 100 */
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
