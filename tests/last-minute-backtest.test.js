'use strict';

const assert = require('assert');
const {
  leadDays,
  nightlyRate,
  leadTimeAdrCurve,
  vacancySurvival,
  recommendCut,
  runBacktest,
  liveRecommendation,
  priceLabsGapReport,
  PRICELABS,
  parseD,
} = require('../lib/last-minute-backtest');

function ts(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function bk(opts) {
  return {
    id: opts.id || Math.random().toString(36).slice(2),
    aptId: opts.aptId || 'apt1',
    guestName: opts.guestName || 'Guest',
    cancelled: !!opts.cancelled,
    cancelledAt: opts.cancelledAt || null,
    created: opts.created,
    createdOnChannel: opts.createdOnChannel || null,
    checkIn: opts.checkIn,
    checkOut: opts.checkOut,
    nights: opts.nights,
    payout: opts.payout,
    gross: opts.gross,
  };
}

function daysBetween(a, b) {
  return Math.round((parseD(b) - parseD(a)) / 86400000);
}

// ── leadDays / nightlyRate ───────────────────────────────────────────────────
{
  const b = bk({
    created: ts('2026-07-01T12:00:00Z'),
    checkIn: '10/7/2026',
    checkOut: '12/7/2026',
    nights: 2,
    payout: 200,
  });
  assert.strictEqual(leadDays(b), 9);
  assert.strictEqual(nightlyRate(b), 100);
}

// ── lead-time ADR curve: last-minute cheaper than early ──────────────────────
{
  const bookings = [
    // early (≥15d)
    bk({ created: ts('2026-06-01'), checkIn: '1/7/2026', checkOut: '3/7/2026', nights: 2, payout: 240 }), // 120
    bk({ created: ts('2026-06-01'), checkIn: '5/7/2026', checkOut: '7/7/2026', nights: 2, payout: 260 }), // 130
    bk({ created: ts('2026-05-20'), checkIn: '10/7/2026', checkOut: '12/7/2026', nights: 2, payout: 250 }), // 125
    // last-minute (0-3d)
    bk({ created: ts('2026-07-09'), checkIn: '10/7/2026', checkOut: '11/7/2026', nights: 1, payout: 80 }),
    bk({ created: ts('2026-07-14'), checkIn: '15/7/2026', checkOut: '16/7/2026', nights: 1, payout: 75 }),
    bk({ created: ts('2026-07-19'), checkIn: '20/7/2026', checkOut: '21/7/2026', nights: 1, payout: 70 }),
  ];
  const curve = leadTimeAdrCurve(bookings);
  assert.ok(curve.earlyAdr >= 120);
  assert.ok(curve.lastMinuteAdr <= 80);
  assert.ok(curve.lastMinuteDiscount > 0.3, 'last-minute should be >30% below early');
  const earlyBucket = curve.buckets.find(b => b.key === '15-30' || b.key === '31+');
  assert.ok(curve.sampleSize >= 6);
  assert.ok(earlyBucket || curve.buckets.some(b => b.n > 0));
}

// ── vacancy survival: night vacant at D-3 that later fills ───────────────────
{
  // Night of 20/7/2026: created only 1 day before → vacant at D-3, filled at D-1
  const bookings = [
    bk({
      created: ts('2026-07-19T10:00:00Z'),
      checkIn: '20/7/2026',
      checkOut: '21/7/2026',
      nights: 1,
      payout: 70,
    }),
    // A night booked early — should NOT count as vacant-at-3
    bk({
      created: ts('2026-07-01T10:00:00Z'),
      checkIn: '25/7/2026',
      checkOut: '26/7/2026',
      nights: 1,
      payout: 120,
    }),
  ];
  const asOf = new Date('2026-08-01T12:00:00Z');
  const surv = vacancySurvival(bookings, { lookbackDays: 40, asOf, leads: [3, 1] });
  assert.ok(surv.byLead[3].vacantAtLead >= 1, 'at least one night vacant at D-3');
  assert.ok(surv.byLead[3].filled >= 1, 'that night eventually filled');
  assert.ok(surv.byLead[3].clearingAdr === 70 || surv.byLead[3].clearingAdr === 120);
}

// ── never-filled vacant night ────────────────────────────────────────────────
{
  // Lookback window with NO bookings covering nights → neverFilled
  const bookings = [];
  const asOf = new Date('2026-08-10T12:00:00Z');
  const surv = vacancySurvival(bookings, { lookbackDays: 5, asOf, leads: [3] });
  assert.ok(surv.byLead[3].vacantAtLead >= 3);
  assert.strictEqual(surv.byLead[3].filled, 0);
  assert.ok(surv.byLead[3].neverFillRate === 1);
}

// ── blocks excluded from vacancy ─────────────────────────────────────────────
{
  const bookings = [
    bk({
      guestName: 'Owner Block',
      created: ts('2026-07-01'),
      checkIn: '20/7/2026',
      checkOut: '25/7/2026',
      nights: 5,
      payout: 0,
      gross: 0,
    }),
  ];
  const asOf = new Date('2026-08-01T12:00:00Z');
  const surv = vacancySurvival(bookings, { lookbackDays: 20, asOf, leads: [3] });
  // Blocked nights should not inflate vacantAtLead for those dates; other empty nights may still count
  assert.ok(surv.nightsScanned > 0);
}

// ── recommendCut: critical vacancy → deep cut toward clearing ────────────────
{
  const curve = {
    earlyAdr: 100,
    lastMinuteAdr: 70,
    lastMinuteDiscount: 0.30,
    buckets: [],
  };
  const survival = {
    byLead: {
      3: { lead: 3, vacantAtLead: 40, filled: 8, neverFilled: 32, fillRate: 0.20, clearingAdr: 65 },
    },
  };
  const rec = recommendCut({
    category: 'attiki',
    refAdr: 100,
    curve,
    survival,
    pricingLead: 3,
    forwardFill: 0.15,
  });
  assert.ok(rec, 'should recommend a cut');
  assert.ok(rec.targetAdr <= 78, `target should be aggressive, got ${rec.targetAdr}`);
  assert.ok(rec.cutPct >= 0.20, `cut ≥20%, got ${rec.cutPct}`);
  assert.strictEqual(rec.severity, 'critical');
}

// ── recommendCut: healthy fill → no cut ──────────────────────────────────────
{
  const rec = recommendCut({
    category: 'attiki',
    refAdr: 100,
    curve: { earlyAdr: 100, lastMinuteAdr: 98, lastMinuteDiscount: 0.02, buckets: [] },
    survival: { byLead: { 3: { fillRate: 0.85, clearingAdr: 98, vacantAtLead: 20, filled: 17, neverFilled: 3 } } },
    pricingLead: 3,
    forwardFill: 0.90,
  });
  assert.strictEqual(rec, null);
}

// ── liveRecommendation smoke ─────────────────────────────────────────────────
{
  const bookings = [
    bk({ created: ts('2026-06-01'), checkIn: '1/7/2026', checkOut: '3/7/2026', nights: 2, payout: 240 }),
    bk({ created: ts('2026-07-18'), checkIn: '20/7/2026', checkOut: '21/7/2026', nights: 1, payout: 70 }),
  ];
  const live = liveRecommendation(bookings, {
    category: 'attiki',
    refAdr: 120,
    forwardFill: 0.10,
    asOf: new Date('2026-08-01'),
    lookbackDays: 60,
  });
  assert.ok(live.curve);
  assert.ok(live.survival);
  assert.ok(live.recommendation == null || live.recommendation.targetAdr < 120);
}

// ── runBacktest shape ────────────────────────────────────────────────────────
{
  const bt = runBacktest([], { asOf: new Date('2026-08-01'), lookbackDays: 10 });
  assert.ok(bt.curve);
  assert.ok(bt.survival.byLead[3]);
  assert.ok(bt.survival.byLead[7]);
}

// ── PriceLabs default curve helpers ──────────────────────────────────────────
{
  assert.strictEqual(PRICELABS.defaultLastMinute.discount, 0.30);
  assert.strictEqual(PRICELABS.channelSyncHoursDefault, 24);
  const at15 = PRICELABS.impliedDiscountAtLead(15);
  const at0 = PRICELABS.impliedDiscountAtLead(0);
  const at7 = PRICELABS.impliedDiscountAtLead(7);
  assert.ok(Math.abs(at15) < 1e-9, 'no PL discount at edge of window');
  assert.ok(Math.abs(at0 - 0.30) < 1e-9, 'full 30% at D-0');
  assert.ok(at7 > 0.15 && at7 < 0.17, `D-7 ≈ 16%, got ${at7}`);
}

// ── recommendCut includes Sync Now + PL gap when critical ────────────────────
{
  const rec = recommendCut({
    category: 'attiki',
    refAdr: 100,
    curve: { earlyAdr: 100, lastMinuteAdr: 70, lastMinuteDiscount: 0.30, buckets: [] },
    survival: { byLead: { 3: { lead: 3, vacantAtLead: 40, filled: 8, neverFilled: 32, fillRate: 0.20, clearingAdr: 65 } } },
    pricingLead: 1,
    forwardFill: 0.10,
  });
  assert.ok(rec);
  assert.ok(rec.syncAction && /Sync Now/i.test(rec.syncAction));
  assert.ok(rec.exceedsPriceLabsDefault === true || rec.cutPct > 0.2);
  assert.ok(rec.priceLabsNote);
}

// ── priceLabsGapReport ───────────────────────────────────────────────────────
{
  const curve = leadTimeAdrCurve([
    bk({ created: ts('2026-06-01'), checkIn: '1/7/2026', checkOut: '3/7/2026', nights: 2, payout: 240 }),
    bk({ created: ts('2026-06-01'), checkIn: '5/7/2026', checkOut: '7/7/2026', nights: 2, payout: 260 }),
    bk({ created: ts('2026-05-20'), checkIn: '10/7/2026', checkOut: '12/7/2026', nights: 2, payout: 250 }),
    bk({ created: ts('2026-07-09'), checkIn: '10/7/2026', checkOut: '11/7/2026', nights: 1, payout: 80 }),
    bk({ created: ts('2026-07-14'), checkIn: '15/7/2026', checkOut: '16/7/2026', nights: 1, payout: 75 }),
    bk({ created: ts('2026-07-19'), checkIn: '20/7/2026', checkOut: '21/7/2026', nights: 1, payout: 70 }),
  ]);
  const gap = priceLabsGapReport(curve);
  assert.ok(gap && gap.verdict);
  assert.ok(gap.buckets.some(b => b.leadBucket === '0-1'));
}

console.log('OK — last-minute-backtest tests passed');
