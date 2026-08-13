/**
 * Last-minute pricing backtest from Hosthub booking creation timestamps.
 *
 * Uses each booking's `created` (Unix seconds) vs check-in to measure:
 *  1) Lead-time ADR curve — what rates last-minute guests actually paid
 *  2) Vacancy survival — of nights still empty at D−L, how many eventually filled,
 *     and at what clearing ADR
 *
 * PriceLabs already soft-discounts toward arrival; this quantifies whether that
 * curve is deep enough for empty inventory, and recommends an overlay cut.
 *
 * Pure Node module — no DOM. The Performance tab mirrors these helpers inline.
 */

'use strict';

const BLOCK_NAMES = ['maintenance', 'owner block', 'block', 'owner stay', 'ιδιοκτητης', 'ιδιοχρηση'];

const LEAD_BUCKETS = [
  { key: '0-1',  min: 0,  max: 1 },
  { key: '2-3',  min: 2,  max: 3 },
  { key: '4-7',  min: 4,  max: 7 },
  { key: '8-14', min: 8,  max: 14 },
  { key: '15-30', min: 15, max: 30 },
  { key: '31+',  min: 31, max: Infinity },
];

/** Checkpoints (days before night) for vacancy-survival analysis. */
const SURVIVAL_LEADS = [14, 7, 3, 1];

/**
 * Default overlay vs early-book ADR when survival says vacant inventory dies.
 * Applied on top of observed last-minute clearing discount when fill rate is poor.
 * City units need faster, deeper cuts than escapes.
 */
const DEFAULT_URGENCY = {
  attiki:       { soft: 0.12, hard: 0.22, critical: 0.32 },
  thessaloniki: { soft: 0.12, hard: 0.22, critical: 0.32 },
  escape:       { soft: 0.08, hard: 0.15, critical: 0.25 },
  default:      { soft: 0.12, hard: 0.22, critical: 0.32 },
};

/** Pricing-horizon windows used for live recommendations (wider than vacancy alert). */
const PRICING_HORIZON = {
  attiki:       { window: 7,  orange: 0.50, red: 0.30 },
  thessaloniki: { window: 7,  orange: 0.50, red: 0.30 },
  escape:       { window: 21, orange: 0.40, red: 0.20 },
  default:      { window: 7,  orange: 0.50, red: 0.30 },
};

/**
 * PriceLabs methodology defaults (public docs / product behaviour).
 * - Algorithm recalculates recommendations daily (Hyper Local Pulse).
 * - Channel push: default sync every ~24h to PMS/channels (Hosthub → Airbnb/BDC);
 *   "Sync Now" pushes in ~10–15 min; Real-Time Sync add-on up to 24×/day.
 * - Default Last Minute Prices: gradual ~30% discount over next 15 days.
 * - Orphan gaps: default ~20% for ≤2-night gaps.
 * - Min price floors always win over % discounts.
 * Sources: PriceLabs algorithm overview Parts 1–2; Customizations guide;
 *          Automate Daily Pricing; sync/setup guides (2024–2026).
 */
const PRICELABS = {
  recalcCadenceHours: 24,
  channelSyncHoursDefault: 24,
  syncNowMinutes: 15,
  defaultLastMinute: { mode: 'gradual', discount: 0.30, windowDays: 15 },
  defaultOrphan: { discount: 0.20, maxGapNights: 2 },
  // Implied discount at D−L under a linear gradual 30%/15d curve (capped).
  impliedDiscountAtLead(daysBefore) {
    const { discount, windowDays } = PRICELABS.defaultLastMinute;
    if (daysBefore == null || daysBefore < 0) return null;
    if (daysBefore >= windowDays) return 0;
    // Gradual: full discount at D−0, none at D−window. Linear approximation.
    return discount * (1 - daysBefore / windowDays);
  },
};

function isRevenueBooking(b) {
  const n = String(b.guestName || '').toLowerCase().trim();
  return !BLOCK_NAMES.includes(n);
}

function parseD(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000));
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function day0(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d) {
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
}

function createdMs(b) {
  if (b.created != null) return b.created * 1000;
  if (b.createdOnChannel != null) return b.createdOnChannel * 1000;
  return null;
}

function bookingExistedAsOf(b, refMs) {
  const c = createdMs(b);
  if (c == null) return null;
  if (c > refMs) return false;
  const canc = b.cancelledAt != null ? b.cancelledAt * 1000 : null;
  if (canc != null && canc <= refMs) return false;
  return true;
}

function nightlyRate(b) {
  const nights = parseInt(b.nights, 10) || (() => {
    const ci = parseD(b.checkIn), co = parseD(b.checkOut);
    if (!ci || !co) return 0;
    return Math.max(0, Math.round((co - ci) / 86400000));
  })();
  if (!nights) return null;
  const total = (typeof b.payout === 'number' && b.payout) ? b.payout
              : (typeof b.gross === 'number' ? b.gross : null);
  if (total == null || total <= 0) return null;
  const rate = total / nights;
  return rate >= 15 ? rate : null; // guard broken payout/nights
}

function leadDays(b) {
  const c = createdMs(b);
  const ci = parseD(b.checkIn);
  if (c == null || !ci) return null;
  const ci0 = day0(ci).getTime();
  const created0 = day0(new Date(c)).getTime();
  return Math.round((ci0 - created0) / 86400000);
}

function bucketFor(lead) {
  if (lead == null || lead < 0) return null;
  return LEAD_BUCKETS.find(b => lead >= b.min && lead <= b.max) || null;
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(vals) {
  if (!vals.length) return null;
  return vals.reduce((a, v) => a + v, 0) / vals.length;
}

function pctile(vals, p) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Lead-time ADR curve for a set of revenue bookings.
 * Returns per-bucket stats + early vs last-minute discount vs early (≥14d) ADR.
 */
function leadTimeAdrCurve(bookings) {
  const byBucket = {};
  for (const bkt of LEAD_BUCKETS) byBucket[bkt.key] = [];

  let skipped = 0;
  for (const b of bookings) {
    if (b.cancelled) { skipped++; continue; }
    if (!isRevenueBooking(b)) { skipped++; continue; }
    const lead = leadDays(b);
    const rate = nightlyRate(b);
    const bkt = bucketFor(lead);
    if (lead == null || rate == null || !bkt) { skipped++; continue; }
    byBucket[bkt.key].push({ lead, rate, nights: parseInt(b.nights, 10) || 1, aptId: b.aptId, checkIn: b.checkIn });
  }

  const earlyRates = [...byBucket['15-30'], ...byBucket['31+']].map(x => x.rate);
  const earlyAdr = median(earlyRates);

  const buckets = LEAD_BUCKETS.map(bkt => {
    const rates = byBucket[bkt.key].map(x => x.rate);
    const med = median(rates);
    return {
      key: bkt.key,
      min: bkt.min,
      max: bkt.max === Infinity ? null : bkt.max,
      n: rates.length,
      medianAdr: med,
      meanAdr: mean(rates),
      p25: pctile(rates, 0.25),
      p75: pctile(rates, 0.75),
      vsEarly: (earlyAdr != null && med != null && earlyAdr > 0) ? (med - earlyAdr) / earlyAdr : null,
    };
  });

  const lmRates = [...byBucket['0-1'], ...byBucket['2-3'], ...byBucket['4-7']].map(x => x.rate);
  const lmAdr = median(lmRates);

  return {
    earlyAdr,
    lastMinuteAdr: lmAdr,
    lastMinuteDiscount: (earlyAdr != null && lmAdr != null && earlyAdr > 0)
      ? (earlyAdr - lmAdr) / earlyAdr : null,
    buckets,
    sampleSize: LEAD_BUCKETS.reduce((a, b) => a + byBucket[b.key].length, 0),
    skipped,
  };
}

/**
 * Build a night → covering bookings index for [start, end).
 */
function nightsIndex(bookings, start, end) {
  const map = new Map(); // dayKey -> [{b, rate}]
  for (const b of bookings) {
    if (!isRevenueBooking(b)) continue;
    const ci = parseD(b.checkIn), co = parseD(b.checkOut);
    if (!ci || !co) continue;
    const rate = nightlyRate(b);
    let night = day0(ci);
    const co0 = day0(co);
    while (night < co0) {
      if (night >= start && night < end) {
        const k = dayKey(night);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ b, rate, night: new Date(night) });
      }
      night.setDate(night.getDate() + 1);
    }
  }
  return map;
}

function wasBlockedAsOf(blocks, night, refMs) {
  for (const b of blocks) {
    const existed = bookingExistedAsOf(b, refMs);
    if (existed !== true) continue;
    const ci = parseD(b.checkIn), co = parseD(b.checkOut);
    if (!ci || !co) continue;
    if (night >= day0(ci) && night < day0(co)) return true;
  }
  return false;
}

/**
 * Vacancy survival at each lead checkpoint.
 * For each past sellable night, ask: was it vacant L days before?
 * If yes: did it eventually fill, and at what ADR / final lead?
 */
function vacancySurvival(bookings, opts = {}) {
  const lookbackDays = opts.lookbackDays || 90;
  const today = day0(opts.asOf || new Date());
  const start = new Date(today);
  start.setDate(start.getDate() - lookbackDays);
  // Exclude very recent nights (still filling) — need outcomes settled ≥1 day ago
  const end = new Date(today);
  end.setDate(end.getDate() - 1);

  const revenue = bookings.filter(b => isRevenueBooking(b));
  const blocks = bookings.filter(b => !b.cancelled && !isRevenueBooking(b));
  const index = nightsIndex(revenue.filter(b => !b.cancelled), start, end);
  // Also include cancelled for as-of reconstruction (they may have existed then)
  const allRev = revenue;

  const leads = opts.leads || SURVIVAL_LEADS;
  const out = {};
  for (const L of leads) {
    out[L] = { vacant: 0, filled: 0, neverFilled: 0, clearingRates: [], fillLeads: [] };
  }

  let night = new Date(start);
  let nightsScanned = 0;
  while (night < end) {
    nightsScanned++;
    const k = dayKey(night);
    const covers = (index.get(k) || []);
    const finalFill = covers.find(c => !c.b.cancelled) || null;

    for (const L of leads) {
      const asOf = new Date(night);
      asOf.setDate(asOf.getDate() - L);
      const refMs = asOf.getTime() + 86400000 - 1; // end of as-of day

      if (wasBlockedAsOf(blocks, night, refMs)) continue;

      // Was any booking covering this night already on the books as of ref?
      let occupied = false;
      for (const b of allRev) {
        const existed = bookingExistedAsOf(b, refMs);
        if (existed !== true) continue;
        // cancelled-after-ref still "occupied" as of ref (existed check handles cancel-by-ref)
        const ci = parseD(b.checkIn), co = parseD(b.checkOut);
        if (!ci || !co) continue;
        if (night >= day0(ci) && night < day0(co)) { occupied = true; break; }
      }
      if (occupied) continue;

      const row = out[L];
      row.vacant++;
      if (finalFill && finalFill.rate != null) {
        row.filled++;
        row.clearingRates.push(finalFill.rate);
        const fl = leadDays(finalFill.b);
        if (fl != null) row.fillLeads.push(fl);
      } else if (finalFill) {
        row.filled++;
      } else {
        row.neverFilled++;
      }
    }
    night.setDate(night.getDate() + 1);
  }

  const summary = {};
  for (const L of leads) {
    const r = out[L];
    const fillRate = r.vacant ? r.filled / r.vacant : null;
    summary[L] = {
      lead: L,
      vacantAtLead: r.vacant,
      filled: r.filled,
      neverFilled: r.neverFilled,
      fillRate,
      neverFillRate: r.vacant ? r.neverFilled / r.vacant : null,
      clearingAdr: median(r.clearingRates),
      clearingAdrP25: pctile(r.clearingRates, 0.25),
      medianFillLead: median(r.fillLeads),
    };
  }

  return { lookbackDays, nightsScanned, byLead: summary };
}

/**
 * Recommend a cut vs a reference ADR given survival + lead curve + category.
 * Returns null when data is too thin or no cut is warranted.
 */
function recommendCut(ctx) {
  const {
    category = 'default',
    refAdr,                 // recent / early ADR to cut from
    curve,                  // leadTimeAdrCurve result
    survival,               // vacancySurvival result
    pricingLead,            // urgency of the live hole (days)
    forwardFill,            // 0..1 fill of pricing horizon
  } = ctx;

  if (refAdr == null || refAdr < 15) return null;

  const urg = DEFAULT_URGENCY[category] || DEFAULT_URGENCY.default;
  const horizon = PRICING_HORIZON[category] || PRICING_HORIZON.default;

  // Observed market clearing: prefer survival clearing ADR at closest lead ≥ pricingLead
  let clearing = null;
  let fillRate = null;
  let usedLead = null;
  if (survival && survival.byLead) {
    const leads = Object.keys(survival.byLead).map(Number).sort((a, b) => a - b);
    const pick = leads.filter(L => L >= (pricingLead || 1)).sort((a, b) => a - b)[0]
              || leads.filter(L => L <= (pricingLead || 1)).sort((a, b) => b - a)[0];
    if (pick != null) {
      usedLead = pick;
      clearing = survival.byLead[pick].clearingAdr;
      fillRate = survival.byLead[pick].fillRate;
    }
  }
  if (clearing == null && curve && curve.lastMinuteAdr != null) {
    clearing = curve.lastMinuteAdr;
  }

  // Severity from forward fill vs pricing horizon thresholds
  let severity = 'none';
  if (forwardFill != null) {
    if (forwardFill < horizon.red) severity = 'critical';
    else if (forwardFill < horizon.orange) severity = 'hard';
    else if (forwardFill < horizon.orange + 0.15) severity = 'soft';
  }
  // Also escalate when historical vacant-at-lead rarely fills
  if (fillRate != null && fillRate < 0.45 && severity === 'none') severity = 'soft';
  if (fillRate != null && fillRate < 0.30 && severity === 'soft') severity = 'hard';
  if (fillRate != null && fillRate < 0.20) severity = 'critical';

  if (severity === 'none' && (clearing == null || clearing >= refAdr * 0.97)) {
    return null;
  }

  const urgencyCut = severity === 'critical' ? urg.critical
                   : severity === 'hard' ? urg.hard
                   : severity === 'soft' ? urg.soft
                   : 0;

  // Target = min(observed clearing, ref * (1 - urgency)) — never above ref
  let target = refAdr;
  if (clearing != null) target = Math.min(target, clearing);
  if (urgencyCut > 0) target = Math.min(target, refAdr * (1 - urgencyCut));

  // Floor: don't recommend absurdly low (below 40% of ref) — likely data glitch
  target = Math.max(target, refAdr * 0.40);
  target = Math.round(target);

  const plImplied = PRICELABS.impliedDiscountAtLead(pricingLead != null ? pricingLead : usedLead);

  // Sync lag: with daily channel push, a cut decided now may not hit OTAs for up to ~24h.
  // Nights inside the sync horizon need Sync Now + deeper cut (lose a full recalculation cycle).
  const syncLagBoost = (pricingLead != null && pricingLead <= PRICELABS.channelSyncHoursDefault / 24 + 1)
    ? 0.05 : 0;
  if (syncLagBoost > 0 && severity !== 'none') {
    const curCut = (refAdr - target) / refAdr;
    target = Math.round(refAdr * (1 - Math.min(0.60, curCut + syncLagBoost)));
    target = Math.max(target, Math.round(refAdr * 0.40));
  }

  const exceedsPriceLabsDefault = plImplied == null || cutNeededExceeds(refAdr, target, plImplied);

  const cutPct = (refAdr - target) / refAdr;
  if (cutPct < 0.03) return null; // <3% not worth acting

  const syncAction = (severity === 'critical' || severity === 'hard' || syncLagBoost > 0)
    ? 'PriceLabs → Sync Now (do not wait for the daily ~24h channel push)'
    : 'Will ride the next PriceLabs daily sync unless you need it live tonight';

  return {
    refAdr: Math.round(refAdr),
    targetAdr: target,
    cutPct,
    cutEur: Math.round(refAdr) - target,
    severity,
    usedLead,
    fillRate,
    clearingAdr: clearing != null ? Math.round(clearing) : null,
    observedLmDiscount: curve ? curve.lastMinuteDiscount : null,
    priceLabsImpliedDiscount: plImplied,
    exceedsPriceLabsDefault,
    syncAction,
    priceLabsNote: `PriceLabs default LM ≈ gradual ${Math.round(PRICELABS.defaultLastMinute.discount * 100)}% / ${PRICELABS.defaultLastMinute.windowDays}d`
      + (plImplied != null ? ` → ~${Math.round(plImplied * 100)}% at this lead` : '')
      + `; channel sync ~every ${PRICELABS.channelSyncHoursDefault}h.`,
    reason: (severity === 'critical'
      ? `Vacant inventory historically clears ~€${clearing != null ? Math.round(clearing) : '—'} at this lead; PriceLabs soft curve is not deep enough — cut now.`
      : severity === 'hard'
      ? `Forward fill is soft and last-minute guests paid ~€${clearing != null ? Math.round(clearing) : '—'}; deepen the near-arrival discount.`
      : `Nudge last-minute price toward historical clearing (~€${clearing != null ? Math.round(clearing) : '—'}).`)
      + ` ${syncAction}.`,
  };
}

function cutNeededExceeds(refAdr, targetAdr, plImpliedFrac) {
  if (refAdr == null || targetAdr == null || plImpliedFrac == null) return true;
  const needed = (refAdr - targetAdr) / refAdr;
  return needed > plImpliedFrac + 0.03; // >3pts deeper than PL default at this lead
}

/**
 * Compare portfolio observed last-minute discounts to PriceLabs default curve.
 */
function priceLabsGapReport(curve) {
  if (!curve || !curve.buckets) return null;
  const rows = curve.buckets.map(b => {
    const midLead = b.max == null ? 45 : (b.min + b.max) / 2;
    const pl = PRICELABS.impliedDiscountAtLead(midLead);
    const observed = b.vsEarly != null ? -b.vsEarly : null; // positive = below early
    return {
      leadBucket: b.key,
      n: b.n,
      observedDiscount: observed,
      priceLabsDefault: pl,
      gap: (observed != null && pl != null) ? observed - pl : null, // >0 ⇒ market cleared deeper than PL default
      medianAdr: b.medianAdr,
    };
  });
  const tight = rows.filter(r => r.n >= 5 && r.gap != null && r.gap > 0.05);
  return {
    priceLabs: PRICELABS,
    buckets: rows,
    verdict: tight.length
      ? `Observed clearing is deeper than PriceLabs default gradual ${Math.round(PRICELABS.defaultLastMinute.discount * 100)}%/15d in ${tight.map(t => t.leadBucket).join(', ')} — raise Last Minute Prices customization (and Sync Now on empty near-term).`
      : `Observed last-minute discounts are within ~PriceLabs default band; focus on Sync Now timing + occupancy-based / orphan customizations for empty units.`,
  };
}

/**
 * Full backtest for one property or a portfolio slice.
 */
function runBacktest(bookings, opts = {}) {
  const curve = leadTimeAdrCurve(bookings);
  const survival = vacancySurvival(bookings, {
    lookbackDays: opts.lookbackDays || 90,
    asOf: opts.asOf,
    leads: opts.leads || SURVIVAL_LEADS,
  });
  return {
    asOf: day0(opts.asOf || new Date()).toISOString().slice(0, 10),
    lookbackDays: opts.lookbackDays || 90,
    curve,
    survival,
  };
}

/**
 * Portfolio rollup: per-category curves + survival + recommended PriceLabs overlay.
 */
function portfolioBacktest(bookingsByCat, opts = {}) {
  const cats = Object.keys(bookingsByCat);
  const byCat = {};
  for (const cat of cats) {
    const bt = runBacktest(bookingsByCat[cat] || [], opts);
    const early = bt.curve.earlyAdr;
    // Overlay suggestion: for each near-arrival bucket, how much deeper than "no cut"
    // Relative to early ADR — this is what to layer on PriceLabs base.
    const overlay = (bt.curve.buckets || [])
      .filter(b => b.max == null || b.max <= 14)
      .map(b => ({
        leadBucket: b.key,
        observedDiscount: b.vsEarly != null ? -b.vsEarly : null, // positive = % below early
        n: b.n,
        medianAdr: b.medianAdr,
      }));
    byCat[cat] = { ...bt, earlyAdr: early, overlay, priceLabsGap: priceLabsGapReport(bt.curve) };
  }
  return { asOf: day0(opts.asOf || new Date()).toISOString().slice(0, 10), byCat };
}

/**
 * Live recommendation for one property given its bookings + forward fill.
 */
function liveRecommendation(bookings, opts = {}) {
  const category = opts.category || 'default';
  const horizon = PRICING_HORIZON[category] || PRICING_HORIZON.default;
  const bt = runBacktest(bookings, opts);
  const refAdr = opts.refAdr != null ? opts.refAdr
               : (bt.curve.earlyAdr || bt.curve.lastMinuteAdr);
  const rec = recommendCut({
    category,
    refAdr,
    curve: bt.curve,
    survival: bt.survival,
    pricingLead: opts.pricingLead != null ? opts.pricingLead : Math.min(horizon.window, 7),
    forwardFill: opts.forwardFill,
  });
  return { ...bt, recommendation: rec, horizon };
}

module.exports = {
  LEAD_BUCKETS,
  SURVIVAL_LEADS,
  DEFAULT_URGENCY,
  PRICING_HORIZON,
  PRICELABS,
  isRevenueBooking,
  parseD,
  createdMs,
  bookingExistedAsOf,
  nightlyRate,
  leadDays,
  leadTimeAdrCurve,
  vacancySurvival,
  recommendCut,
  priceLabsGapReport,
  runBacktest,
  portfolioBacktest,
  liveRecommendation,
};
