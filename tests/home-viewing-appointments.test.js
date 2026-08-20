'use strict';
/**
 * Home Open-leads chip + Book a viewing appointments (FE 124 / SRV 88).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyKind(kind, max) {
  const baseName = kind === 'fe' ? 'index.html' : 'server.js';
  let src = fs.readFileSync(path.join(root, baseName), 'utf8');
  if (kind === 'fe') src = src.replace(/\r\n/g, '\n');
  let sha = sha256(src);
  const files = [];
  for (let n = 1; n <= max; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, kind + '/' + name + ' continues the chain');
    for (const [i, p] of (spec.patches || []).entries()) {
      const count = src.split(p.find).length - 1;
      assert.strictEqual(count, p.count || 1, kind + '/' + name + ' patch ' + (i + 1));
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    assert.strictEqual(sha, spec.expectedSha256, kind + '/' + name + ' hash');
    files.push(name);
  }
  return { src, sha, files };
}

const fe123 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-123.json'), 'utf8'));
const fe124 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-124.json'), 'utf8'));
const srv87 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-87.json'), 'utf8'));
const srv88 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-88.json'), 'utf8'));
assert.strictEqual(fe124.baseSha256, fe123.expectedSha256, 'FE 124 continues FE 123');
assert.strictEqual(srv88.baseSha256, srv87.expectedSha256, 'SRV 88 continues SRV 87');

const fe = applyKind('fe', 140);
const srv = applyKind('srv', 100);
assert(fe.files.includes('patches-124.json'), 'FE 124 is in the chain');
assert(srv.files.includes('patches-88.json'), 'SRV 88 is in the chain');

assert(fe.src.includes('<div class="l">Open leads</div>'), 'Home chip says Open leads');
assert(!fe.src.includes('<div class="l">Open lead tasks</div>'), 'Home chip is not Open lead tasks');
assert(!fe.src.includes('Extended view: full assigned open-lead list'), 'no full assigned-lead dump');
assert(!fe.src.includes("done: 'Mark viewing'"), 'Mark viewing is gone');
assert(fe.src.includes("done: 'Book a viewing'"), 'qualified button is Book a viewing');
assert(fe.src.includes('window.ldBookViewing'), 'Book a viewing picker exists');
assert(fe.src.includes('inspectionAt: when.toISOString()'), 'picker sends inspectionAt');
assert(fe.src.includes('Property Inspection · '), 'inspection row title');
assert(fe.src.includes('function homeIsOpenLead(l)'), 'open-lead count helper');
assert(fe.src.includes("if (stage === 'viewing') { window.ldBookViewing(id); return; }"), 'viewing stage opens picker');
assert(fe.src.includes('id="home-week-cal"'), 'week strip slot');
assert(srv.src.includes('ADD COLUMN IF NOT EXISTS inspection_at TIMESTAMPTZ'), 'inspection_at column');
assert(srv.src.includes("b.inspectionAt"), 'PATCH inspectionAt');
assert(srv.src.includes('Book a viewing with a date and time.'), 'viewing requires datetime');

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const helpers = [
  extractFn(fe.src, 'homeIsOpenLead'),
  extractFn(fe.src, 'homeInspectWhen'),
  extractFn(fe.src, 'homeWhoLabel'),
  extractFn(fe.src, 'homeInspectionTitle'),
].join('\n');
const ctx = {};
vm.runInNewContext(
  helpers +
    '\nthis.homeIsOpenLead = homeIsOpenLead;' +
    '\nthis.homeInspectWhen = homeInspectWhen;' +
    '\nthis.homeWhoLabel = homeWhoLabel;' +
    '\nthis.homeInspectionTitle = homeInspectionTitle;',
  ctx
);

const openQualified = {
  id: 101, owner: 'kostas', status: 'open', stage: 'qualified', archived_at: null,
  full_name: 'Nikos Papadopoulos', inspection_at: null,
};
const openContacted = {
  id: 102, owner: 'george', status: 'open', stage: 'contacted', archived_at: null,
};
const bookedWhen = new Date(2026, 8, 12, 10, 0, 0);
const booked = {
  id: 101, owner: 'kostas', status: 'open', stage: 'viewing', archived_at: null,
  inspection_at: bookedWhen.toISOString(), inspection_by: 'kostas',
};
assert.strictEqual(ctx.homeIsOpenLead(openQualified), true);
assert.strictEqual(ctx.homeIsOpenLead({ owner: 'kostas', status: 'open', stage: 'on_hold' }), false);
assert.ok(!ctx.homeInspectWhen(openQualified));
assert.ok(ctx.homeInspectWhen(booked));

const leads = [openQualified, openContacted, booked];
const open = leads.filter(ctx.homeIsOpenLead);
assert.strictEqual(open.length, 3, 'chip counts every assigned open lead');
const rows = open.filter((l) => ctx.homeInspectWhen(l));
assert.strictEqual(rows.length, 1, 'Home lists only dated inspections');
assert.strictEqual(
  ctx.homeInspectionTitle(booked, {}),
  'Property Inspection · Kostas · 12 Sep'
);

const inspectSrc = extractFn(srv.src, 'leadApplyInspection');
const inspCtx = { row: { inspection_at: null, inspection_by: null } };
vm.runInNewContext(
  inspectSrc + '\nthis.leadApplyInspection = leadApplyInspection;',
  inspCtx
);
const denied = inspCtx.leadApplyInspection({ inspection_at: null }, { stage: 'viewing' });
assert.strictEqual(denied.error, 'Book a viewing with a date and time.');
const row = { inspection_at: null, inspection_by: null };
const ok = inspCtx.leadApplyInspection(row, {
  stage: 'viewing',
  inspectionAt: '2026-09-12T07:00:00.000Z',
  inspectionBy: 'kostas',
});
assert.ok(ok.ok);
assert.strictEqual(row.inspection_by, 'kostas');
assert.ok(String(row.inspection_at).startsWith('2026-09-12'));

const scripts = [...fe.src.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.trim());
scripts.forEach((source, i) => new vm.Script(source, { filename: 'home-viewing-script-' + (i + 1) + '.js' }));
new vm.Script(srv.src, { filename: 'server.effective.js' });

console.log('home-viewing-appointments.test.js: ok');
