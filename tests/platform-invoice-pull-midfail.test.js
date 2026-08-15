'use strict';
/**
 * Reproduces: "Pull failed — Pulling Airbnb 194/316 · HM3TW2MMBX · 192 PDF(s) so far…"
 * That copy was the last progress line parsed as the worker result (no files array).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');
const srv70 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-70.json'), 'utf8'));
const fe103 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-103.json'), 'utf8'));

function parseWorkerResult(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (!j || j.event === 'progress' || j.event === 'saved') continue;
      return j;
    } catch (e) {}
  }
  return null;
}

const progressOnly = [];
for (let i = 1; i <= 194; i++) {
  progressOnly.push(JSON.stringify({
    event: 'progress',
    done: i,
    total: 316,
    saved: Math.min(i - 1, 192),
    code: i === 194 ? 'HM3TW2MMBX' : ('HMFAKE' + String(i).padStart(3, '0')),
  }));
}
const stdout = progressOnly.join('\n');
const lastLine = JSON.parse(progressOnly[progressOnly.length - 1]);
assert.strictEqual(lastLine.code, 'HM3TW2MMBX');
assert.strictEqual(lastLine.done, 194);
assert.strictEqual(lastLine.saved, 192);
assert.ok(!Array.isArray(lastLine.files));
assert.strictEqual(lastLine.error || 'Pull failed', 'Pull failed');
assert.strictEqual(parseWorkerResult(stdout), null, 'progress-only stdout is not a worker result');

assert(srv70.patches.some((p) => (p.replace || '').includes("j.event === 'progress' || j.event === 'saved'")));
assert(srv70.patches.some((p) => (p.replace || '').includes('piPullWalkPdfs')));
assert(fe103.patches.some((p) => (p.replace || '').includes('Pull interrupted')));
assert(!/Pull failed — Pulling Airbnb/.test((fe103.patches[0] || {}).replace || ''));

function extractBetween(source, startName, nextName) {
  const start = source.indexOf('function ' + startName + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start);
  assert(start >= 0 && end > start, 'missing ' + startName + ' .. ' + nextName);
  return source.slice(start, end);
}
const helperSrc =
  extractBetween(worker, 'airbnbHaveKey', 'loadAirbnbHaveSet') +
  extractBetween(worker, 'loadAirbnbHaveSet', 'airbnbResvAlreadyHave') +
  extractBetween(worker, 'airbnbResvAlreadyHave', 'requestPullStop');
const helpers = vm.runInNewContext(helperSrc + '\n({ airbnbHaveKey, loadAirbnbHaveSet, airbnbResvAlreadyHave })', {
  process: { env: { PI_AIRBNB_HAVE_JSON: JSON.stringify([
    'Airbnb/2026-07/Birdhouse/invoice-HMALREADY.pdf',
    'Airbnb/2026-07/Loft/credit_note-HMCREDIT1.pdf',
  ]) } },
});
assert.strictEqual(helpers.airbnbHaveKey('invoice', 'hm3tw2mmbx'), 'invoice:HM3TW2MMBX');
const have = helpers.loadAirbnbHaveSet();
assert(helpers.airbnbResvAlreadyHave({ code: 'HMALREADY', kind: 'invoice' }, have));
assert(!helpers.airbnbResvAlreadyHave({ code: 'HM3TW2MMBX', kind: 'invoice' }, have));
assert(helpers.airbnbResvAlreadyHave({ code: 'HMCREDIT1', kind: 'credit_note' }, have));
assert(!helpers.airbnbResvAlreadyHave({ code: 'HMCREDIT1', kind: 'invoice' }, have));

function walkPdfs(outDir) {
  const out = [];
  function walk(dir, rel) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
      const nextRel = rel ? rel + '/' + ent.name : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) return walk(abs, nextRel);
      if (!/\.pdf$/i.test(ent.name) || ent.name.charAt(0) === '_') return;
      const parts = nextRel.split('/');
      out.push({
        filename: nextRel,
        channel: /^booking/i.test(parts[0] || '') ? 'booking' : 'airbnb',
        partner: parts.length >= 4 ? parts[2] : '',
      });
    });
  }
  walk(outDir, '');
  return out;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-midfail-'));
const pdfRel = path.join(tmp, 'Airbnb', '2026-07', 'Birdhouse', 'invoice-HMKEEP01.pdf');
fs.mkdirSync(path.dirname(pdfRel), { recursive: true });
fs.writeFileSync(pdfRel, '%PDF-1.4 salvage');
const walked = walkPdfs(tmp);
assert.strictEqual(walked.length, 1);
assert.strictEqual(walked[0].partner, 'Birdhouse');
assert.strictEqual(walked[0].filename.replace(/\\/g, '/'), 'Airbnb/2026-07/Birdhouse/invoice-HMKEEP01.pdf');

assert(worker.includes('function emitJson'));
assert(worker.includes('uncaughtException'));
assert(worker.includes('PI_AIRBNB_HAVE_JSON'));

console.log('platform-invoice-pull-midfail.test.js: ok');
