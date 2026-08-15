'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function applyChain(kind, baseFile) {
  let source = fs.readFileSync(path.join(root, baseFile), 'utf8').replace(/\r\n/g, '\n');
  let sha = crypto.createHash('sha256').update(source).digest('hex');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : `patches-${n}.json`;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, `${kind}/${name} continues the chain`);
    for (const [index, patch] of spec.patches.entries()) {
      const count = source.split(patch.find).length - 1;
      assert.strictEqual(count, patch.count || 1, `${kind}/${name} patch ${index + 1} anchor count`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(spec.expectedSha256, sha, `${kind}/${name} effective hash`);
  }
  return source;
}

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

const html = applyChain('fe', 'index.html');

assert(html.includes('function _opsSetView('), 'view toggle exists');
assert(html.includes('function _opsCrewBoardHtml('), 'in-app crew board exists');
assert(html.includes('>Ημέρα</th>'), 'clustered Ημέρα column');
assert(html.includes('>Συνεργείο</th>'), 'clustered Συνεργείο column');
assert(html.includes('textarea[data-field]'), 'auto-save reads comment textareas');
assert(!html.includes('CO ✓'), 'CO ✓ stays gone');
assert(html.includes('_opsFlowCell(row, i)'), 'ops rows use the day cell');
assert(html.includes('_opsCrewCol(_ct)'), 'ops rows use the stacked crew column');
assert(html.includes('_opsNotesCell(row, i, _cRed, _cBlue)'), 'ops rows use notes textarea');
assert(html.includes('_opsFlowExtraCell(ex)'), 'extra rows use the day cell');
assert(html.includes('colspan="8"'), 'empty board is 8 columns');

const sandbox = {
  console,
  window: {},
  document: {
    getElementById() { return null; },
  },
  S: { daily: { extra: {} } },
  localStorage: {
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = String(v); },
  },
  _opsDate: '2026-08-15',
  _opsRows: [],
  _opsCleanExtras: [],
  renderOpsCalls: 0,
};
sandbox.window = sandbox;
sandbox.renderOps = function () { sandbox.renderOpsCalls++; };
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn(html, '_opsEscHtml'),
    extractFn(html, '_opsTdUnwrap'),
    extractFn(html, '_opsTdInner'),
    extractFn(html, '_opsSetView'),
    extractFn(html, '_opsCurrentView'),
    extractFn(html, '_opsHasArrival'),
    extractFn(html, '_opsCleanerList'),
    extractFn(html, '_opsNormCleanerName'),
    extractFn(html, '_opsAttentionHtml'),
    extractFn(html, '_opsFlowCell'),
    extractFn(html, '_opsCrewBoardHtml'),
    extractFn(html, '_opsCombinedBoardHtml'),
    'function _opsCheckoutDateCell() { return \'<td class="ox-c">15/8/2026</td>\'; }',
    'function _opsCheckinCell() { return \'<td class="ox-c"><div class="opsx-pill">Ναι</div></td>\'; }',
    'function _opsCleanDayInfo() { return window._day || { done: 0, total: 0, extras: [], clean: [] }; }',
    'function _opsBoardRowsHtml() { return \'<tr data-ri="0"><td>row</td></tr>\'; }',
    'function _opsDatalistsHtml() { return \'<datalist id="ops-cleaners-datalist"></datalist>\'; }',
    'function _opsDayLabel() { return \'Σάββατο 15 Αυγούστου 2026\'; }',
    'function _opsFmtDate() { return \'15/8/2026\'; }',
    'function _opsCrewShareRows() { return _opsRows.concat(_opsCleanExtras || []); }',
    'function _opsAptLines(r) { return { name: r.aptName || \'\', addr: r.address || \'\' }; }',
    'function _opsAptOf() { return {}; }',
    'function _opsCleanTickCell() { return \'<td class="ox-c ox-cd"><input type="checkbox" class="opsx-chk"></td>\'; }',
    'function _opsCleanerCell(t) { return \'<td data-cleaners-cell="1" class="opsx-clean-cell"><input class="opsx-cname"></td>\'; }',
    'function _opsCleanTaskCell() { return \'<td class="ox-tsk"><select class="opsx-sel"></select></td>\'; }',
    'function _opsCleanTypeChip() { return \'<span class="opsx-bdg">TURNOVER</span>\'; }',
    'function _opsCommentChips() { return \'\'; }',
    'function _opsCleanStorageKey(r) { return String(r.aptId || r.aptName || \'\') + \'::\' + String(r.cleanType || \'turnover\'); }',
    'function _opsCleanKeyJs(r) { return JSON.stringify(_opsCleanStorageKey(r)).replace(/"/g, \'&quot;\'); }',
    'function _opsNamesInDailyBlock(block) { const bag = (S.daily.extra && S.daily.extra[_opsDate]) || {}; const o = bag[block] || {}; return Object.keys(o).map(function (k) { return String(o[k] || \'\').trim(); }).filter(Boolean); }',
  ].join('\n'),
  sandbox
);

assert.strictEqual(sandbox._opsTdInner('<td class="x">hello</td>'), 'hello');
assert.strictEqual(sandbox._opsTdUnwrap('<td data-cleaners-cell="1">x</td>').attrs.includes('data-cleaners-cell'), true);

sandbox._opsSetView('crew');
assert.strictEqual(sandbox.window._opsView, 'crew');
assert.strictEqual(sandbox.localStorage.getItem('e_opsView'), 'crew');
assert.strictEqual(sandbox.renderOpsCalls, 1);
sandbox.window._opsView = null;
assert.strictEqual(sandbox._opsCurrentView(), 'crew');

const sameDay = {
  id: 'bk-1',
  aptName: 'Votsala 1',
  address: 'Nikis',
  checkinSameDay: 'yes',
  people: '',
  arrivalTime: '',
  cleanerName: '',
  comments: '',
};
sandbox._opsRows = [sameDay];
sandbox.window._day = {
  done: 0,
  total: 1,
  extras: [],
  clean: [sameDay],
};
const attn = sandbox._opsAttentionHtml();
assert.ok(attn.includes('unassigned'), 'attention lists unassigned cleans');
assert.ok(attn.includes('same-day missing time'), 'attention lists missing arrival time');
assert.ok(attn.includes('missing people'), 'attention lists missing people');

sameDay.people = 4;
sameDay.arrivalTime = '15:00';
sameDay.cleanerName = 'Maria';
sandbox.window._day.clean = [sameDay];
assert.strictEqual(sandbox._opsAttentionHtml(), '', 'quiet day has no attention strip');

const flow = sandbox._opsFlowCell({
  checkinSameDay: 'yes',
  people: 4,
  arrivalTime: '15:00',
}, 0);
assert.ok(flow.includes('ox-flow'), 'flow cell class');
assert.ok(flow.includes('15/8/2026'), 'checkout date inside Ημέρα');
assert.ok(flow.includes('Ναι'), 'same-day pill inside Ημέρα');
assert.ok(flow.includes('data-field="people"'), 'people stays editable');
assert.ok(flow.includes('data-field="arrivalTime"'), 'arrival stays editable');
assert.ok(!flow.includes('ox-miss'), 'filled same-day is not flagged');

const miss = sandbox._opsFlowCell({ checkinSameDay: 'yes', people: '', arrivalTime: '' }, 0);
assert.ok(miss.includes('ox-miss'), 'missing time/people highlighted');

sandbox.window._opsView = 'ops';
const opsHtml = sandbox._opsCombinedBoardHtml();
assert.ok(opsHtml.includes('id="ops-shot-ops"'), 'ops mode captures the board');
assert.ok(opsHtml.includes('>Ημέρα</th>'), 'ops table has Ημέρα');
assert.ok(opsHtml.includes('>Συνεργείο</th>'), 'ops table has Συνεργείο');
assert.ok(!opsHtml.includes('id="ops-shot-crew"'), 'ops mode does not render the crew sheet');
assert.ok(opsHtml.includes('Check in ίδιας') === false, 'old CI column header is gone from ops table');

sandbox.window._opsView = 'crew';
const crewHtml = sandbox._opsCombinedBoardHtml();
assert.ok(crewHtml.includes('id="ops-shot-crew"'), 'crew mode captures the job sheet');
assert.ok(crewHtml.includes('ΠΡΟΓΡΑΜΑ ΣΥΝΕΡΓΕΙΟΥ'), 'crew board title');
assert.ok(crewHtml.includes('Votsala 1'), 'crew sheet lists the apartment');
assert.ok(crewHtml.includes('Maria'), 'crew sheet groups by cleaner');
assert.ok(!crewHtml.includes('id="ops-shot-ops"'), 'crew mode does not render the ops table');
assert.ok(crewHtml.includes('Ιματισμός'), 'crew footer has linen');
assert.ok(crewHtml.includes('Οδηγοί / Διαδρομές'), 'crew footer has drivers');

console.log('daily-ops-two-mode: ok');
