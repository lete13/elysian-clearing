#!/usr/bin/env node
// srv-boot.js — server release bootstrap (mirrors the fe/patches.json mechanism).
// Applies srv/patches.json to server.js at boot: ordered exact string replacements,
// gated by baseSha256 (the server.js the patches expect) and expectedSha256 (the
// result). ALL-OR-NOTHING: any failure (missing file, base drift, anchor count
// mismatch, result sha mismatch) logs the reason and starts the unpatched
// server.js instead, so the app never goes down on a bad patch set.
// Consolidation: upload the full patched server.js via GitHub web and reset
// srv/patches.json to {"patches":[]} in the same release — the base-drift gate
// makes a missed reset safe.
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

let src, cfg;
try { src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8'); }
catch (e) { return fallback('cannot read server.js: ' + e.message); }
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'srv', 'patches.json'), 'utf-8')); }
catch (e) { return fallback('cannot read srv/patches.json: ' + e.message); }

const patches = Array.isArray(cfg.patches) ? cfg.patches : [];
if (!patches.length) {
  console.log('[srv-boot] no server patches — starting server.js as-is');
  if (process.env.SRVBOOT_DRYRUN) process.exit(0);
  require(path.join(ROOT, 'server.js'));
  return;
}
if (cfg.baseSha256 && sha256(src) !== cfg.baseSha256)
  return fallback('base drift: server.js sha256 ' + sha256(src).slice(0, 12) + ' ≠ expected ' + String(cfg.baseSha256).slice(0, 12));

let out = src;
for (let i = 0; i < patches.length; i++) {
  const p = patches[i] || {};
  const parts = out.split(p.find);
  const n = parts.length - 1;
  if (typeof p.find !== 'string' || n !== (p.count || 1))
    return fallback('patch ' + (i + 1) + ' (' + String(p.note || '').slice(0, 60) + '): anchor count ' + n + ' ≠ ' + (p.count || 1));
  out = parts.join(p.replace);
}
if (cfg.expectedSha256 && sha256(out) !== cfg.expectedSha256)
  return fallback('result sha256 ' + sha256(out).slice(0, 12) + ' ≠ expected ' + String(cfg.expectedSha256).slice(0, 12));

const GEN = path.join(ROOT, 'server.gen.js');
try { fs.writeFileSync(GEN, out); }
catch (e) { return fallback('cannot write server.gen.js: ' + e.message); }
console.log('[srv-boot] ✓ applied ' + patches.length + ' server patches → sha256 ' + sha256(out).slice(0, 12) + ' (server.gen.js)');
if (process.env.SRVBOOT_DRYRUN) { console.log('[srv-boot] dry-run: success path'); process.exit(0); }
require(GEN);
