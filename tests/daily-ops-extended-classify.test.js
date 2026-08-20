'use strict';
/**
 * Daily Ops EXTENDED must mean "same guest continuing today", not a Hosthub
 * checkout labelled "extend Name" when a different guest arrives.
 * Live false-positive: Elysian Lycabettus Resilience, 21/8/2026
 *   out: Hosthub calendar title "extend <first name>" (extra nights of the departing stay)
 *   in:  a different Booking.com guest — needs a turnover clean.
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
      assert.strictEqual(count, patch.count || 1, `${kind}/${name} patch ${index + 1} (${patch.note})`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(sha, spec.expectedSha256, `${kind}/${name} effective hash`);
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
assert(html.includes('function _opsGuestCore('), 'extend-keyword strip helper shipped');
assert(html.includes("if (k.key === 'isExtended') continue;"), 'departing extend keyword is not a skip-clean');

const kindsStart = html.indexOf('var OPS_KINDS = [');
const loadStart = html.indexOf('function _opsLoadData(');
assert(kindsStart >= 0 && loadStart > kindsStart, 'classifier block present');

const sandbox = { console, window: {}, S: { apts: [], bks: [] }, Math, parseFloat, isFinite };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn(html, 'parseD'),
    extractFn(html, 'normAptName'),
    extractFn(html, 'findApt'),
    extractFn(html, 'aptById'),
    extractFn(html, '_opsDateParts'),
    extractFn(html, '_opsOnOpsDate'),
    extractFn(html, '_opsNightsOf'),
    extractFn(html, '_opsAptOf'),
    extractFn(html, '_opsAptKeyList'),
    extractFn(html, '_opsSameOpsApt'),
    extractFn(html, '_opsMarkSeenApt'),
    html.slice(kindsStart, loadStart),
    extractFn(html, '_opsAutoRows'),
  ].join('\n'),
  sandbox
);

function ext(outName, inName) {
  return !!sandbox._opsClassify(outName, inName).isExtended;
}

assert.strictEqual(
  ext('extend Maria ', 'Nikos Ioannou'),
  false,
  'Resilience 21/8: departing Hosthub "extend Maria" + new guest is a turnover'
);
assert.strictEqual(
  ext('Maria', 'extend Maria '),
  true,
  'incoming "extend Maria" still means the arrival is a continuation'
);
assert.strictEqual(
  ext('extend Maria ', 'Maria'),
  true,
  'same person after stripping the Hosthub extend label'
);
assert.strictEqual(ext('extend Maria ', 'extend Maria '), true, 'both sides labelled extend');
assert.strictEqual(ext('John Smith', 'John Smith'), true, 'identical guest names');
assert.strictEqual(ext('Anna', 'Anna-Maria'), false, 'short names never auto-match');
assert.strictEqual(ext('', 'extend Maria '), true, 'check-in-only extend block is not a fresh arrival');
assert.strictEqual(ext('extend Maria ', ''), false, 'departing extend into a gap is still a checkout');
assert.strictEqual(ext('Elysian Lycabettus Resilience', ''), false, 'listing name Resilience is not EXTENDED');
assert.strictEqual(ext('παράταση Μαρία', 'Γιάννης'), false, 'departing παράταση + different guest is a turnover');
assert.strictEqual(ext('Μαρία', 'παράταση Μαρία'), true, 'incoming παράταση still means no turnover');

const prep = sandbox._opsClassify('preparation block', 'Nikos Ioannou');
assert.strictEqual(prep.isPreparation, true, 'PREPARATION still detects from either name');
assert.strictEqual(prep.isExtended, false);

assert.strictEqual(sandbox._opsGuestCore('extend Maria '), 'maria');
assert.strictEqual(sandbox._opsSameGuest('extend Maria ', 'Maria'), true);

const apt = { id: 'p19epb68s8', name: 'Elysian Lycabettus Resilience' };
sandbox.S = {
  apts: [apt],
  bks: [
    {
      id: 'bk-out-extend',
      aptId: apt.id,
      aptName: apt.name,
      guestName: 'extend Maria ',
      guests: '',
      checkIn: '19/8/2026',
      checkOut: '21/8/2026',
      nights: 2,
      cancelled: false,
    },
    {
      id: 'bk-in-new',
      aptId: apt.id,
      aptName: apt.name,
      guestName: 'Nikos Ioannou',
      guests: '2',
      checkIn: '21/8/2026',
      checkOut: '22/8/2026',
      nights: 1,
      cancelled: false,
    },
  ],
};

const rows = sandbox._opsAutoRows('2026-08-21');
assert.strictEqual(rows.length, 1, 'one Resilience row on 21/8');
assert.strictEqual(rows[0].aptName, apt.name);
assert.strictEqual(rows[0].checkoutGuest, 'extend Maria ');
assert.strictEqual(rows[0].nextGuest, 'Nikos Ioannou');
assert.strictEqual(rows[0].checkinSameDay, 'yes');
assert.strictEqual(rows[0].isExtended, false, 'must not suppress the new-guest turnover clean');
assert.strictEqual(rows[0].isPreparation, false);
assert.strictEqual(rows[0].isMaintenance, false);
assert.strictEqual(String(rows[0].people), '2');

console.log('daily-ops-extended-classify: ok');
