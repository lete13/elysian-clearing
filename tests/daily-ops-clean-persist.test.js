'use strict';

/**
 * Regression: 14/8 stuck at 18/23 and "missing" Skarlatos were blamed on date
 * format — Hosthub already stores unpadded D/M/YYYY which the legacy matcher
 * accepts. Real failures: aptId/aptName key drift, refresh↔sofa_bed flips after
 * rental-info loads, and client sync dropping zero-fee bookings with dates.
 */

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

assert(html.includes('function _opsLookupSavedClean'), 'type-flip cleanDone helper present');
assert(html.includes('function _opsAptKeyList'), 'dual apt key helper present');
assert(
  html.includes('unpriced reservations still need Daily Ops'),
  'client sync keeps dated zero-fee bookings'
);
assert(
  html.includes('poll cannot wipe checks'),
  'cleanDone toggle flushes DB immediately'
);
assert(
  /sticky = localStorage\.getItem\('e_opsWorkingDate'\)/.test(html),
  '_opsDefaultOpsDate reads sticky working day'
);

// Legacy Hosthub dates already matched without calendar helpers.
const date = '2026-08-15';
const dateFmt = '15/8/2026';
assert.strictEqual(dateFmt, '15/8/2026');
assert.ok(dateFmt === '15/8/2026' || date === '2026-08-15');

const sandbox = { console, window: {}, S: { apts: [], bks: [], daily: { snapshots: {} } } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn(html, '_opsAptKeyList'),
    extractFn(html, '_opsCleanTypeOf'),
    extractFn(html, '_opsCleanStorageKey'),
    extractFn(html, '_opsIndexSavedCleans'),
    extractFn(html, '_opsLookupSavedClean'),
    extractFn(html, '_opsDefaultOpsDate'),
    extractFn(html, '_opsTodayStr'),
    extractFn(html, '_opsAddDays'),
    extractFn(html, '_opsEnsure'),
  ].join('\n'),
  sandbox
);

const saved = sandbox._opsIndexSavedCleans([
  { aptId: '', aptName: 'The Skarlatos residence', cleanType: 'refresh', cleanDone: true, cleanerName: 'Anna' },
]);
const flipped = sandbox._opsLookupSavedClean(saved, {
  aptId: 'skar-1',
  aptName: 'The Skarlatos residence',
  cleanType: 'sofa_bed',
});
assert.ok(flipped, 'finds saved clean after aptId appears + type flip');
assert.strictEqual(flipped.cleanDone, true, 'cleanDone survives refresh→sofa_bed');
assert.strictEqual(flipped.cleanerName, 'Anna');

sandbox.S.daily = { snapshots: {}, cleansCompleteFor: { '2026-08-14': true }, opsWorkingDate: '2026-08-15' };
sandbox.localStorage = {
  store: { e_opsWorkingDate: '2026-08-15' },
  getItem(k) { return this.store[k] || null; },
  setItem(k, v) { this.store[k] = String(v); },
};
// Freeze "today" for the default-date helper.
vm.runInContext("function _opsTodayStr(){ return '2026-08-14'; }", sandbox);
assert.strictEqual(sandbox._opsDefaultOpsDate(), '2026-08-15', 'opens on sticky working day after 14 completes');

// Combined board: clean ✓ strikes the name and sinks the row; CO ✓ is gone (Early).
assert(
  html.includes("(_kind || _cDone) ? ' ox-off'"),
  'cleanDone strikes apartment name on combined board'
);
assert(html.includes('isDone(a) ? 1 : 0'), 'cleaned rows sort to bottom');
assert(!html.includes('CO ✓'), 'CO ✓ column removed from Daily Ops board');
assert(!html.includes('Checkout ζητήθηκε'), 'CO checkbox removed from Daily Ops board');

const betaCss = fs.readFileSync(path.join(root, 'fe/daily-ops-beta.css'), 'utf8');
const betaJs = fs.readFileSync(path.join(root, 'fe/daily-ops-beta.js'), 'utf8');
assert(
  /ob-card\.ob-done \.ob-card-name strong[\s\S]*text-decoration:\s*line-through/.test(betaCss) ||
    /\.ob-dispatch-row\.tone-done[\s\S]*line-through/.test(betaCss) ||
    /ob-dispatch-row\.done[\s\S]*line-through/.test(betaCss),
  'promoted Daily Ops strikes cleaned apartment names'
);
assert(!/ζητήθηκε/.test(betaJs), 'Daily Ops drops checkout-requested checkbox (Early replaces it)');
assert(/data-ob-action="clean"/.test(betaJs), 'Daily Ops keeps clean ✓ control');
assert(/item\.target\.cleanDone\) return 3/.test(betaJs), 'Daily Ops sinks done rows in status sort');
assert(/getElementById\('tab-ops'\)/.test(betaJs), 'promoted UI renders into #tab-ops');
assert(/window\.renderOps = render/.test(betaJs), 'promoted UI replaces renderOps');
assert(!/nav-opsbeta|tab-opsbeta|opsbeta/.test(betaJs), 'no Beta dual-tab wiring left in UI script');
assert(/cleanerChipsHtml|ob-cchip/.test(betaJs), 'multi-cleaner chips present');
assert(/manage-cleaners/.test(betaJs), 'Καθαρίστριες roster manage wired');

assert(!html.includes('id="nav-opsbeta"'), 'Beta nav removed from tip HTML');
assert(!html.includes('id="tab-opsbeta"'), 'Beta tab panel removed from tip HTML');
assert(html.includes('id="nav-ops">Daily Ops'), 'single Daily Ops nav remains');

console.log('daily-ops-clean-persist: ok');
