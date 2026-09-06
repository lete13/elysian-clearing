'use strict';

/**
 * Regression: Property Info → Law 5170 issued-on / due dates were inputted
 * and not kept. Picking a date rebuilt the whole tab (native date pickers
 * fire an empty change as the input is destroyed) and dates never auto-saved.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyKind(kind) {
  const baseName = kind === 'fe' ? 'index.html' : 'server.js';
  let src = fs.readFileSync(path.join(root, baseName), 'utf8').replace(/\r\n/g, '\n');
  let sha = sha256(src);
  let last = 'base';
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, kind + '/' + name + ' continues the chain');
    for (const [i, p] of (spec.patches || []).entries()) {
      const count = src.split(p.find).length - 1;
      assert.strictEqual(count, p.count || 1, kind + '/' + name + ' patch ' + (i + 1) + ' (' + p.note + ')');
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    assert.strictEqual(sha, spec.expectedSha256, kind + '/' + name + ' hash');
    last = name;
  }
  return { src, sha, last };
}

function extractFn(source, name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

const fe142 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-142.json'), 'utf8'));
const fe141 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-141.json'), 'utf8'));
assert.strictEqual(fe142.baseSha256, fe141.expectedSha256, 'FE 142 continues FE 141');

const fe = applyKind('fe');
const srv = applyKind('srv');
assert.strictEqual(fe.last, 'patches-144.json', 'FE 144 is the tip of the chain');
assert.strictEqual(srv.last, 'patches-108.json', 'SRV 108 is the tip of the chain');

assert(fe.src.includes('function _pinfoAddMonthsISO(iso, months)'), 'calendar-safe due date helper');
assert(fe.src.includes('_pinfoSaveSoon()'), 'dates persist without waiting for Save');
assert(fe.src.includes('function _pinfoPaintCompliance(itemId)'), 'date row updates in place');
assert(fe.src.includes("id=\"pinfo-issued-' + it.id"), 'issued-on input has a stable id');
assert(fe.src.includes("id=\"pinfo-due-' + it.id"), 'due date input has a stable id');
assert(fe.src.includes('if (silent) _markClean();'), 'silent save does not rebuild the tab');
assert(fe.src.includes('Issued-on and due dates save as soon as you pick them.'), 'copy says dates persist');
assert(fe.src.includes('cn <= 160') === false, 'FE html does not carry the server chain cap');
assert(srv.src.includes('cn <= 160'), 'FE bootstrap walks through 160');
assert(
  !fe.src.includes("_dirty = true; renderPropInfo();\n  };\n  window.pinfoCompDate"),
  'date pick no longer destroys the form'
);
assert(
  !/d\.toISOString\(\)\.slice\(0, 10\); rec\.dueAuto = true/.test(fe.src),
  'UTC toISOString no longer shifts the due date'
);

const addMonths = extractFn(fe.src, '_pinfoAddMonthsISO');
const paint = extractFn(fe.src, '_pinfoPaintCompliance');
const issuedStart = fe.src.indexOf('window.pinfoIssued = function');
assert(issuedStart >= 0, 'pinfoIssued present');
const issuedEnd = fe.src.indexOf('window.pinfoAddFaq', issuedStart);
const handlers = fe.src.slice(issuedStart, issuedEnd);

const sandbox = {
  _cur: { compliance: {} },
  CADENCE: { liability_insurance: 12, disinfection: 12, fire_extinguisher: 12, smoke_detector: 12 },
  _dirty: false,
  _pill: function (st) { return 'PILL:' + st.level + ':' + (st.label || ''); },
  _complianceStatus: function (due) {
    return due ? { level: 'green', label: 'valid' } : { level: 'none', label: 'no date' };
  },
  _markDirty: function () { sandbox.markedDirty = true; },
  _pinfoSaveSoon: function () { sandbox.saveSoon += 1; },
  saveSoon: 0,
  markedDirty: false,
  renderCount: 0,
  renderPropInfo: function () { sandbox.renderCount += 1; },
  els: {},
  document: {
    getElementById: function (id) {
      sandbox.els[id] = sandbox.els[id] || { id: id, value: '', innerHTML: '' };
      return sandbox.els[id];
    },
  },
  window: null,
  String: String,
  Math: Math,
  Date: Date,
  parseInt: parseInt,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  addMonths + '\n' +
  'window._pinfoAddMonthsISO = _pinfoAddMonthsISO;\n' +
  paint + '\n' +
  handlers,
  sandbox
);

assert.strictEqual(sandbox._pinfoAddMonthsISO('2026-03-31', 12), '2027-03-31', '31 Mar + 12 months stays on the 31st');
assert.strictEqual(sandbox._pinfoAddMonthsISO('2026-01-31', 1), '2026-02-28', '31 Jan + 1 month clamps to Feb 28');
assert.strictEqual(sandbox._pinfoAddMonthsISO('2024-01-31', 1), '2024-02-29', '31 Jan + 1 month in a leap year is Feb 29');
assert.strictEqual(sandbox._pinfoAddMonthsISO('not-a-date', 12), '', 'garbage issued-on does not invent a due date');

// The old toISOString path shifted a day west of UTC (Greece is UTC+2/+3).
const oldShift = (function () {
  const d = new Date('2026-03-31T00:00:00');
  d.setMonth(d.getMonth() + 12);
  return d.toISOString().slice(0, 10);
})();
if (oldShift !== '2027-03-31') {
  assert.notStrictEqual(oldShift, sandbox._pinfoAddMonthsISO('2026-03-31', 12), 'new helper does not follow the UTC-shifted date');
}

sandbox.pinfoIssued('liability_insurance', '2026-04-15');
assert.strictEqual(sandbox._cur.compliance.liability_insurance.issuedOn, '2026-04-15', 'issued on is kept in memory');
assert.strictEqual(sandbox._cur.compliance.liability_insurance.due, '2027-04-15', 'due date auto-fills one year later, same calendar day');
assert.strictEqual(sandbox._cur.compliance.liability_insurance.dueAuto, true, 'auto due is flagged');
assert.strictEqual(sandbox.els['pinfo-issued-liability_insurance'].value, '2026-04-15', 'issued input shows the picked date');
assert.strictEqual(sandbox.els['pinfo-due-liability_insurance'].value, '2027-04-15', 'due input shows the auto date');
assert.ok(sandbox.els['pinfo-pill-liability_insurance'].innerHTML.indexOf('PILL:green') === 0, 'status pill updates in place');
assert.strictEqual(sandbox.renderCount, 0, 'picking a date does not rebuild the tab');
assert.ok(sandbox.saveSoon >= 1, 'picking a date schedules a persist');
assert.ok(sandbox.markedDirty, 'save button lights up');

sandbox.pinfoCompDate('first_aid', '2026-12-01');
assert.strictEqual(sandbox._cur.compliance.first_aid.due, '2026-12-01', 'manual due date is kept');
assert.strictEqual(sandbox._cur.compliance.first_aid.dueAuto, false, 'manual due is not marked auto');
assert.strictEqual(sandbox.els['pinfo-due-first_aid'].value, '2026-12-01', 'manual due input shows the picked date');
assert.strictEqual(sandbox.renderCount, 0, 'manual due date does not rebuild the tab either');

const payload = JSON.parse(JSON.stringify({
  amenities: {},
  faqs: [],
  houseRules: {},
  compliance: sandbox._cur.compliance,
}));
const riShape = extractFn(srv.src, 'riShape');
const shapeBox = { riShape: null };
vm.createContext(shapeBox);
vm.runInContext(riShape + '\nthis.riShape = riShape;', shapeBox);
const shaped = shapeBox.riShape(payload);
assert.strictEqual(shaped.compliance.liability_insurance.issuedOn, '2026-04-15', 'server keeps issued on');
assert.strictEqual(shaped.compliance.liability_insurance.due, '2027-04-15', 'server keeps due date');
assert.strictEqual(shaped.compliance.first_aid.due, '2026-12-01', 'server keeps a manual due date');

const loaded = shapeBox.riShape(JSON.parse(JSON.stringify(shaped)));
assert.deepStrictEqual(loaded.compliance, shaped.compliance, 'a reload round-trip keeps the same dates');

console.log('pinfo-compliance-dates.test.js: ok');
