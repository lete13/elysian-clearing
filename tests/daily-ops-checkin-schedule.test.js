'use strict';

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

assert(
  html.includes('const checkouts = S.bks.filter(b => !b.cancelled && onDay(b.checkOut));'),
  'cancelled checkouts are ignored when building Daily Ops rows'
);
assert(
  html.includes("out.people = '';"),
  'snapshot merge clears people when live bookings have no arrival'
);
assert(
  html.includes('function _opsHasArrival(row)'),
  'sofa and long-stay tags require a real check-in'
);
assert(
  html.includes("const suffix = (row.checkinSameDay === 'yes' && row.nextNights) ? ' ('+row.nextNights+' νύχτες)' : '';"),
  'nights suffix is not shown on Δεν ξέρουμε ακόμα'
);
assert(
  !html.includes('onclick="opsSaveSnapshot()"'),
  'Snapshot button is gone — check-ins come from live Hosthub'
);
assert(
  html.includes('Live Hosthub bookings are the source of check-ins/checkouts.'),
  'Daily Ops list starts from live bookings'
);

const sandbox = {
  console,
  window: {},
  S: { apts: [], bks: [], daily: { snapshots: {} } },
  _opsRows: [],
  _opsRentalInfo: null,
  _opsCleanExtras: [],
  OPS_TAG_SOFA1: 'Prepare 1 sofa bed',
  OPS_TAG_SOFA2: 'Prepare 2 sofa beds',
  OPS_LONG_RE: /^Long stay:\s*\d+\s*nights?$/i,
  OPS_KINDS: [
    { key: 'isMaintenance', manual: 'maintenanceManual' },
    { key: 'isPreparation', manual: 'preparationManual' },
    { key: 'isExtended', manual: 'extendedManual' },
  ],
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn(html, 'parseD'),
    extractFn(html, '_opsAptOf'),
    extractFn(html, '_opsAptHouseRules'),
    extractFn(html, '_opsNightsOf'),
    extractFn(html, '_opsLongStayTag'),
    extractFn(html, '_opsSplitComments'),
    extractFn(html, '_opsJoinComments'),
    extractFn(html, '_opsSetManagedComment'),
    extractFn(html, '_opsHasArrival'),
    extractFn(html, '_opsApplySofaComment'),
    extractFn(html, '_opsApplyLongStayComment'),
    extractFn(html, '_opsSofaExcessFor'),
    extractFn(html, '_opsArrivalNeedsSofa'),
    extractFn(html, '_opsCheckinOnlyScheduleExtras'),
    extractFn(html, '_opsExtraCleanRows'),
    extractFn(html, '_opsAutoRows'),
    extractFn(html, '_opsIsCleanStub'),
    extractFn(html, '_opsLoadData'),
    extractFn(html, '_opsCheckinCell'),
    'function _opsClassify() { return { isExtended: false, isPreparation: false, isMaintenance: false, isOwner: false }; }',
    'function _opsOrder(rows) { return rows; }',
    'function _opsEnsure() { S.daily = S.daily || {}; S.daily.snapshots = S.daily.snapshots || {}; }',
    'function _opsIsSpecial(row) { return !!(row && (row.isExtended || row.isPreparation || row.isMaintenance)); }',
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
sandbox._opsRentalInfo = { 'cedar-1': { houseRules: { base_capacity: 4 } } };

const cedarCheckout = {
  id: 'bk-out',
  aptId: 'cedar-1',
  aptName: 'The Athenian Cedar',
  guestName: 'Departing Guest',
  guests: 2,
  checkIn: '8/8/2026',
  checkOut: '15/8/2026',
  nights: 7,
  cancelled: false,
};

sandbox.S = {
  apts: [cedar],
  bks: [cedarCheckout],
  daily: { snapshots: {} },
};

const live = sandbox._opsAutoRows('2026-08-15');
assert.strictEqual(live.length, 1, 'checkout-only Cedar is on Daily Ops');
assert.strictEqual(live[0].aptName, 'The Athenian Cedar');
assert.strictEqual(live[0].isCheckinOnly, undefined);
assert.strictEqual(live[0].checkinSameDay, 'unknown');
assert.strictEqual(live[0].checkoutGuest, 'Departing Guest');
assert.strictEqual(live[0].nextNights, null);
assert.strictEqual(live[0].people, '');
assert.strictEqual(live[0].nextGuest, '');

sandbox.S.daily.snapshots['2026-08-15'] = {
  date: '2026-08-15',
  notes: '',
  savedAt: 'stale',
  rows: [{
    aptId: 'cedar-1',
    aptName: 'The Athenian Cedar',
    checkoutGuest: 'Departing Guest',
    checkinSameDay: 'yes',
    isCheckinOnly: false,
    nextNights: 7,
    people: 6,
    nextGuest: 'Phantom Arrival',
    comments: 'Prepare 2 sofa beds · Long stay: 7 nights',
    cleanerName: 'Maria',
  }],
};

const merged = sandbox._opsLoadData('2026-08-15').rows;
assert.strictEqual(merged.length, 1, 'live checkout keeps the turnover row');
assert.strictEqual(merged[0].checkinSameDay, 'unknown');
assert.strictEqual(merged[0].isCheckinOnly, false);
assert.strictEqual(merged[0].nextNights, null);
assert.strictEqual(merged[0].people, '');
assert.strictEqual(merged[0].nextGuest, '');
assert.strictEqual(merged[0].checkoutGuest, 'Departing Guest');
assert.strictEqual(merged[0].cleanerName, 'Maria', 'cleaner assignment still overlays from the day save');

sandbox._opsApplySofaComment(merged[0]);
sandbox._opsApplyLongStayComment(merged[0]);
assert.ok(!/sofa bed/i.test(merged[0].comments || ''), 'no sofa badge without a check-in');
assert.ok(!/Long stay/i.test(merged[0].comments || ''), 'no 7-night stay tag without a check-in');

const cell = sandbox._opsCheckinCell(merged[0], 0);
assert.ok(!cell.includes('νύχτες'), 'check-in cell does not print 7 nights when there is no arrival');
assert.ok(cell.includes('Δεν ξέρουμε ακόμα'), 'checkout with no next booking stays unknown');

sandbox._opsRows = merged;
assert.strictEqual(sandbox._opsCheckinOnlyScheduleExtras([]).length, 0, 'no sofa extra for a checkout with no arrival');

sandbox.S.daily.snapshots['2026-08-15'] = {
  date: '2026-08-15',
  notes: '',
  savedAt: 'stale',
  rows: [{
    aptId: 'cedar-1',
    aptName: 'The Athenian Cedar',
    checkoutGuest: '',
    checkinSameDay: 'checkin_only',
    isCheckinOnly: true,
    nextNights: 7,
    people: 6,
    nextGuest: 'Phantom Arrival',
  }],
};
sandbox.S.bks = [];
const gone = sandbox._opsLoadData('2026-08-15').rows;
assert.strictEqual(gone.length, 0, 'snapshot check-in-only with no live booking is dropped');

const sofaStudio = {
  id: 'sofa-1',
  aptId: 'sofa-1',
  aptName: 'Sofa Studio',
  guestName: 'Arriving Guest',
  guests: 6,
  checkIn: '15/8/2026',
  checkOut: '22/8/2026',
  nights: 7,
  cancelled: false,
};
sandbox.S = {
  apts: [{ id: 'sofa-1', name: 'Sofa Studio', baseCapacity: 4 }],
  bks: [sofaStudio],
  daily: { snapshots: {} },
};
sandbox._opsRentalInfo = { 'sofa-1': { houseRules: { base_capacity: 4 } } };
const arrivals = sandbox._opsAutoRows('2026-08-15');
assert.strictEqual(arrivals[0].isCheckinOnly, true);
assert.strictEqual(arrivals[0].nextNights, 7);
assert.strictEqual(arrivals[0].people, 6);
sandbox._opsRows = arrivals;
const extras = sandbox._opsCheckinOnlyScheduleExtras([]);
assert.strictEqual(extras.length, 1);
assert.strictEqual(extras[0].cleanType, 'sofa_bed');
assert.strictEqual(extras[0].nextNights, 7);

console.log('daily-ops-checkin-schedule: ok');
