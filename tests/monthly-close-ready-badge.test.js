'use strict';
/**
 * Monthly Close "Ready to clear" badge: an apartment whose calendar for the
 * close month is fully covered (sold nights + owner/maintenance blocks) can be
 * cleared before the month ends.
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
  throw new Error('unclosed function ' + name);
}

const fe = applyKind('fe');
const srv = applyKind('srv');
assert.strictEqual(fe.last, 'patches-144.json', 'FE 144 is the tip');
assert.strictEqual(srv.last, 'patches-108.json', 'SRV 108 is the tip');
assert(fe.src.includes('mcbadge ready'), 'badge class in the patched frontend');
assert(fe.src.includes("statusFilter = 'ready'"), 'list can filter to ready apartments');
assert(srv.src.includes('cn <= 160'), 'server applies FE 141');

const fillSrc = [
  extractFn(fe.src, 'mcUpcomingYm'),
  extractFn(fe.src, 'mcNearMonthEnd'),
  extractFn(fe.src, 'mcMonthBounds'),
  extractFn(fe.src, 'mcBkUtc'),
  extractFn(fe.src, 'mcFillOne'),
  extractFn(fe.src, 'mcFill'),
  extractFn(fe.src, 'mcReady'),
  extractFn(fe.src, 'isRevenueBooking'),
].join('\n');

function ctxWith(bks, month) {
  const ctx = {
    S: { bks: bks },
    mcMonth: month || '2026-08',
    MC_READY_FROM_DAY: 20,
    parseD: function (v) {
      if (!v && v !== 0) return null;
      const s = String(v).trim();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
      const d = new Date(s);
      return isNaN(d) ? null : d;
    },
  };
  ctx.BLOCK_NAMES = ['maintenance', 'owner block', 'block', 'owner stay', 'ιδιοκτητης', 'ιδιοχρηση'];
  vm.runInNewContext(
    fillSrc +
      '\nthis.mcFillOne=mcFillOne; this.mcFill=mcFill; this.mcReady=mcReady;' +
      '\nthis.mcBkUtc=mcBkUtc; this.mcMonthBounds=mcMonthBounds;' +
      '\nthis.mcUpcomingYm=mcUpcomingYm; this.mcNearMonthEnd=mcNearMonthEnd;',
    ctx
  );
  return ctx;
}

function bk(aptId, checkIn, checkOut, extra) {
  return Object.assign({ aptId: aptId, checkIn: checkIn, checkOut: checkOut, cancelled: false, guestName: 'Guest' }, extra || {});
}

// August 2026 has 31 nights. A stay 1 Aug → 1 Sep covers them all.
const full = ctxWith([bk('a1', '01/08/2026', '01/09/2026')]);
assert.strictEqual(full.mcMonthBounds('2026-08').days, 31, 'August 2026 is 31 nights');
assert.strictEqual(full.mcFillOne('a1', '2026-08').sold, 31, '1 Aug→1 Sep sells all 31 nights');
assert.strictEqual(full.mcFillOne('a1', '2026-08').ready, true, 'full-month stay is ready to clear');
assert.strictEqual(full.mcReady('a1', '2026-08'), true, 'mcReady agrees');

// Checkout on 31 Aug does not cover the last night (31 Aug → 1 Sep).
const short = ctxWith([bk('a1', '01/08/2026', '31/08/2026')]);
assert.strictEqual(short.mcFillOne('a1').sold, 30, '1 Aug→31 Aug is 30 nights');
assert.strictEqual(short.mcFillOne('a1').ready, false, 'one empty night is not ready');

// Two adjoining stays cover the month.
const split = ctxWith([
  bk('a1', '01/08/2026', '15/08/2026'),
  bk('a1', '15/08/2026', '01/09/2026'),
]);
assert.strictEqual(split.mcFillOne('a1').sold, 31, 'adjoining stays cover 31 distinct nights');
assert.strictEqual(split.mcFillOne('a1').ready, true, 'adjoining stays are ready');

// Overlapping stays cannot count a night twice.
const overlap = ctxWith([
  bk('a1', '01/08/2026', '01/09/2026'),
  bk('a1', '10/08/2026', '20/08/2026'),
]);
assert.strictEqual(overlap.mcFillOne('a1').sold, 31, 'overlap still 31 distinct nights');
assert.strictEqual(overlap.mcFillOne('a1').ready, true, 'overlap is ready, not over 100%');

// Owner block fills unsellable nights so the calendar can still be complete.
const blocked = ctxWith([
  bk('a1', '01/08/2026', '28/08/2026'),
  bk('a1', '28/08/2026', '01/09/2026', { guestName: 'Owner stay' }),
]);
const fillB = blocked.mcFillOne('a1');
assert.strictEqual(fillB.sold, 27, 'guest stay 1–28 Aug is 27 nights');
assert.strictEqual(fillB.blocked, 4, 'owner block 28 Aug–1 Sep is 4 nights');
assert.strictEqual(fillB.covered, 31, 'sold + blocked cover the month');
assert.strictEqual(fillB.ready, true, 'blocked nights still make it ready to clear');

// Cancelled booking does not fill a night.
const cancelled = ctxWith([
  bk('a1', '01/08/2026', '01/09/2026', { cancelled: true }),
]);
assert.strictEqual(cancelled.mcFillOne('a1').sold, 0, 'cancelled stay covers nothing');
assert.strictEqual(cancelled.mcFillOne('a1').ready, false, 'cancelled stay is not ready');

// A stay that only grazes the month.
const graze = ctxWith([bk('a1', '30/07/2026', '03/08/2026')]);
assert.strictEqual(graze.mcFillOne('a1', '2026-08').sold, 2, '30 Jul→3 Aug contributes 1–2 Aug');
assert.strictEqual(graze.mcFillOne('a1', '2026-07').sold, 2, 'and 30–31 Jul in July');

// ISO dates parse the same as DD/MM/YYYY.
const iso = ctxWith([bk('a1', '2026-08-01', '2026-09-01')]);
assert.strictEqual(iso.mcFillOne('a1').sold, 31, 'ISO check-in/out covers August');
assert.strictEqual(iso.mcReady('a1'), true, 'ISO full month is ready');

// Clearing group: every member must be full.
const group = ctxWith([
  bk('m1', '01/08/2026', '01/09/2026'),
  bk('m2', '01/08/2026', '20/08/2026'),
]);
assert.strictEqual(group.mcReady({ id: 'm1', members: ['m1', 'm2'] }), false, 'group not ready if one member has gaps');
const groupFull = ctxWith([
  bk('m1', '01/08/2026', '01/09/2026'),
  bk('m2', '01/08/2026', '01/09/2026'),
]);
assert.strictEqual(groupFull.mcReady({ id: 'm1', members: ['m1', 'm2'] }), true, 'group ready when every member is full');
assert.strictEqual(groupFull.mcFill({ id: 'm1', members: ['m1', 'm2'] }).days, 62, 'group days are per-apartment');

// Upcoming-month banner window: from the 20th.
const dates = ctxWith([]);
assert.strictEqual(dates.mcNearMonthEnd(new Date(2026, 7, 19)), false, '19th is not near month-end');
assert.strictEqual(dates.mcNearMonthEnd(new Date(2026, 7, 20)), true, '20th opens the upcoming-month banner');
assert.strictEqual(dates.mcNearMonthEnd(new Date(2026, 7, 31)), true, '31st is near month-end');
assert.strictEqual(dates.mcUpcomingYm(new Date(2026, 7, 31)), '2026-08', '31 Aug → upcoming month is August');

console.log('monthly-close-ready-badge.test.js: ok');
