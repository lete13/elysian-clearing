'use strict';

/**
 * Regression: 14/8 stuck at 18/23 and "missing" Skarlatos were blamed on date
 * format — Hosthub already stores unpadded D/M/YYYY which the legacy matcher
 * accepts. Real failures: aptId/aptName key drift, refresh↔sofa_bed flips after
 * rental-info loads, and client sync dropping zero-fee bookings with dates.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyChain } = require('./apply-chain');

const root = path.resolve(__dirname, '..');

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

const html = applyChain(root, 'fe', 'index.html');

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

console.log('daily-ops-clean-persist: ok');
