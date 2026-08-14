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

assert(
  html.includes('const checkouts = S.bks.filter(b => !b.cancelled && (b.checkOut === date || b.checkOut === dateFmt));'),
  'cancelled checkouts are ignored when building Daily Ops rows'
);
assert(
  html.includes('const occupied = new Set(turnovers.map(function (r) { return String(r.aptId || r.aptName); }));'),
  'cleaning extras treat only turnovers as occupied'
);
assert(
  html.includes('_opsCheckinOnlyScheduleExtras(Array.from(occupied).concat(Array.from(extraApts)))'),
  'check-in-only sofa arrivals land on the cleaning schedule'
);

const sandbox = {
  console,
  window: {},
  S: { apts: [], bks: [] },
  _opsRows: [],
  _opsRentalInfo: null,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn(html, 'parseD'),
    extractFn(html, '_opsAptOf'),
    extractFn(html, '_opsAptHouseRules'),
    extractFn(html, '_opsNightsOf'),
    extractFn(html, '_opsSofaExcessFor'),
    extractFn(html, '_opsArrivalNeedsSofa'),
    extractFn(html, '_opsCheckinOnlyScheduleExtras'),
    extractFn(html, '_opsExtraCleanRows'),
    extractFn(html, '_opsAutoRows'),
    'function _opsClassify() { return { isExtended: false, isPreparation: false, isMaintenance: false, isOwner: false }; }',
    'function _opsOrder(rows) { return rows; }',
  ].join('\n'),
  sandbox
);

const cedar = {
  id: 'cedar-1',
  name: 'The Athenian Cedar',
  baseCapacity: 4,
  city: 'Athens',
  address: 'Athens',
};
const emptyHouse = {
  id: 'empty-1',
  name: 'Empty House',
  baseCapacity: 2,
  city: 'Athens',
};
const cedarStay = {
  id: 'bk-cedar',
  aptId: 'cedar-1',
  aptName: 'The Athenian Cedar',
  guestName: 'Long Stay Guest',
  guests: 6,
  checkIn: '15/8/2026',
  checkOut: '21/10/2026',
  nights: 67,
  cancelled: false,
};
const cancelledOut = {
  id: 'bk-cancel',
  aptId: 'cedar-1',
  aptName: 'The Athenian Cedar',
  guestName: 'Cancelled Checkout',
  checkIn: '10/8/2026',
  checkOut: '15/8/2026',
  cancelled: true,
};

sandbox.S = { apts: [cedar, emptyHouse], bks: [cancelledOut, cedarStay] };
sandbox._opsRentalInfo = {
  'cedar-1': { houseRules: { base_capacity: 4 } },
  'empty-1': { houseRules: { base_capacity: 2 } },
};

const rows = sandbox._opsAutoRows('2026-08-15');
assert.strictEqual(rows.length, 1, 'cancelled checkout does not create a turnover');
assert.strictEqual(rows[0].aptName, 'The Athenian Cedar');
assert.strictEqual(rows[0].isCheckinOnly, true);
assert.strictEqual(rows[0].checkinSameDay, 'checkin_only');
assert.strictEqual(rows[0].checkoutGuest, '');
assert.strictEqual(rows[0].nextNights, 67);
assert.strictEqual(rows[0].people, 6);
assert.strictEqual(rows[0].nextGuest, 'Long Stay Guest');

assert.strictEqual(sandbox._opsNightsOf(cedarStay), 67);
assert.strictEqual(sandbox._opsSofaExcessFor(6, rows[0]), 2);
assert.strictEqual(sandbox._opsArrivalNeedsSofa(rows[0]), true);
assert.strictEqual(sandbox._opsArrivalNeedsSofa(cedarStay), true);

sandbox._opsRows = rows;
const extras = sandbox._opsCheckinOnlyScheduleExtras([]);
assert.strictEqual(extras.length, 1, 'check-in-only sofa arrival is scheduled');
assert.strictEqual(extras[0].cleanType, 'sofa_bed');
assert.strictEqual(extras[0].aptName, 'The Athenian Cedar');
assert.strictEqual(extras[0].people, 6);
assert.strictEqual(extras[0].nextNights, 67);
assert.strictEqual(extras[0].cleanTask, 'prepare_sofa');
assert.strictEqual(extras[0].isCheckinOnly, true);

const skipped = sandbox._opsCheckinOnlyScheduleExtras(['cedar-1']);
assert.strictEqual(skipped.length, 0, 'turnover on the same apartment still blocks the extra');

const fromBookings = sandbox._opsExtraCleanRows('2026-08-15', []);
assert.ok(
  fromBookings.some(r => r.aptName === 'The Athenian Cedar' && r.cleanType === 'sofa_bed'),
  'sofa extra is also produced from the booking guest count vs base capacity'
);
assert.strictEqual(
  sandbox._opsExtraCleanRows('2026-08-15', ['cedar-1']).filter(r => r.aptName === 'The Athenian Cedar').length,
  0,
  'occupied turnover key still blocks the booking extra'
);

sandbox.S.bks = [
  { id: 'out', aptId: 'empty-1', aptName: 'Empty House', checkOut: '10/8/2026', cancelled: false },
  { id: 'in', aptId: 'empty-1', aptName: 'Empty House', checkIn: '15/8/2026', checkOut: '16/8/2026', guests: 2, cancelled: false },
];
const refresh = sandbox._opsExtraCleanRows('2026-08-15', []);
assert.ok(refresh.some(r => r.cleanType === 'refresh' && r.aptName === 'Empty House'));

console.log('daily-ops-checkin-schedule: ok');
