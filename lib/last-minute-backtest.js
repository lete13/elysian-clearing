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
 * Build aptId|dayKey → covering bookings index for [start, end).
 * Must be per-apartment — portfolio-level day keys falsely mark Attiki as
 * always occupied when any unit has a booking that night.
 */
function nightsIndex(bookings, start, end) {
  const map = new Map(); // `${aptId}|${dayKey}` -> [{b, rate}]
  for (const b of bookings) {
    if (!isRevenueBooking(b)) continue;
    const ci = parseD(b.checkIn), co = parseD(b.checkOut);
    if (!ci || !co) continue;
    const aptId = String(b.aptId || b.aptName || '');
    const rate = nightlyRate(b);
    let night = day0(ci);
    const co0 = day0(co);
    while (night < co0) {
      if (night >= start && night < end) {
        const k = `${aptId}|${dayKey(night)}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ b, rate, night: new Date(night) });
      }
      night.setDate(night.getDate() + 1);
    }
  }
  return map;
}

function wasBlockedAsOf(blocks, night, refMs, aptId) {
  const apt = String(aptId || '');
  for (const b of blocks) {
    if (apt && String(b.aptId || b.aptName || '') !== apt) continue;
    const existed = bookingExistedAsOf(b, refMs);
    if (existed !== true) continue;
    const ci = parseD(b.checkIn), co = parseD(b.checkOut);
    if (!ci || !co) continue;
    if (night >= day0(ci) && night < day0(co)) return true;
  }
  return false;
}

/**
 * Vacancy survival at each lead checkpoint — per apartment-night.
 * For each past sellable night on each property, ask: was it vacant L days before?
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
  const allRev = revenue;

  // Apartments present in this slice (skip empty aptId)
  const aptIds = [...new Set(bookings.map(b => String(b.aptId || b.aptName || '')).filter(Boolean))];
  // If no apt ids (synthetic fixtures), treat as a single unit
  const units = aptIds.length ? aptIds : [''];

  // Index revenue by apt for faster as-of occupancy checks
  const revByApt = new Map();
  for (const b of allRev) {
    const a = String(b.aptId || b.aptName || '');
    if (!revByApt.has(a)) revByApt.set(a, []);
    revByApt.get(a).push(b);
  }

  const leads = opts.leads || SURVIVAL_LEADS;
  const out = {};
  for (const L of leads) {
    out[L] = { vacant: 0, filled: 0, neverFilled: 0, clearingRates: [], fillLeads: [] };
  }

  let nightsScanned = 0;
  for (const aptId of units) {
    const aptRev = revByApt.get(aptId) || allRev;
    let night = new Date(start);
    while (night < end) {
      nightsScanned++;
      const k = `${aptId}|${dayKey(night)}`;
      const covers = (index.get(k) || []);
      const finalFill = covers.find(c => !c.b.cancelled) || null;

      for (const L of leads) {
        const asOf = new Date(night);
        asOf.setDate(asOf.getDate() - L);
        const refMs = asOf.getTime() + 86400000 - 1; // end of as-of day

        if (wasBlockedAsOf(blocks, night, refMs, aptId)) continue;

        let occupied = false;
        for (const b of aptRev) {
          const existed = bookingExistedAsOf(b, refMs);
          if (existed !== true) continue;
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

  return { lookbackDays, nightsScanned, apartments: units.length, byLead: summary };
}

/**
 * Share of booking sample that is last-minute (lead ≤7d), by booking count.
 * High LM dependency ⇒ empty near-term calendars are often normal, not a crisis.
 */
function lmDependency(curve) {
  if (!curve || !curve.buckets || !curve.sampleSize) return null;
  const lmN = (curve.buckets || [])
    .filter(b => b.key === '0-1' || b.key === '2-3' || b.key === '4-7')
    .reduce((a, b) => a + (b.n || 0), 0);
  return lmN / curve.sampleSize;
}

/**
 * Expected-revenue cut picker.
 * Maximises bottom line: EV(wait) = pFill × clearing vs EV(cut) = pFill' × target.
 * Empty forward fill alone does NOT force a deep critical cut — Pixie-class units
 * fill ~80%+ of vacant-at-D−7 nights at ~clearing ADR; cutting far below clearing
 * destroys revenue on nights that would have filled anyway.
 *
 * Elasticity (conservative): each 10% price cut below clearing converts ~20% of
 * remaining deaths (capped). Deep cuts must beat wait EV by ≥2% to recommend.
 */
function recommendCut(ctx) {
  const {
    category = 'default',
    refAdr,
    curve,
    survival,
    pricingLead,
    forwardFill,
  } = ctx;

  if (refAdr == null || refAdr < 15) return null;

  const horizon = PRICING_HORIZON[category] || PRICING_HORIZON.default;

  let clearing = null;
  let fillRate = null;
  let usedLead = null;
  let vacantAtLead = null;
  if (survival && survival.byLead) {
    const leads = Object.keys(survival.byLead).map(Number).sort((a, b) => a - b);
    const pick = leads.filter(L => L >= (pricingLead || 1)).sort((a, b) => a - b)[0]
              || leads.filter(L => L <= (pricingLead || 1)).sort((a, b) => b - a)[0];
    if (pick != null) {
      usedLead = pick;
      clearing = survival.byLead[pick].clearingAdr;
      fillRate = survival.byLead[pick].fillRate;
      vacantAtLead = survival.byLead[pick].vacantAtLead;
    }
  }
  if (clearing == null && curve && curve.lastMinuteAdr != null) {
    clearing = curve.lastMinuteAdr;
  }
  // Thin survival sample → fall back to curve LM ADR only; don't invent fill rates
  if (fillRate == null && vacantAtLead != null && vacantAtLead < 8) fillRate = null;

  const lmShare = lmDependency(curve);
  const pFill = (fillRate != null && fillRate >= 0) ? fillRate : null;
  const dieRate = pFill != null ? Math.max(0, 1 - pFill) : null;

  // Healthy forward fill and price already near clearing → nothing to do
  if (forwardFill != null && forwardFill >= (horizon.orange + 0.15)
      && (clearing == null || clearing >= refAdr * 0.97)) {
    return null;
  }

  // Anchor: what waiting historically earns per vacant night
  const waitPrice = clearing != null ? clearing : (curve && curve.lastMinuteAdr != null ? curve.lastMinuteAdr : refAdr);
  const waitP = pFill != null ? pFill : 0.55; // unknown → assume middling
  const evWait = waitP * waitPrice;

  // Candidate targets: never above ref; prefer clearing; only go deeper if EV wins
  const floor = Math.round(refAdr * 0.45);
  const candidates = new Set();
  candidates.add(Math.round(refAdr));
  if (clearing != null) {
    candidates.add(Math.round(clearing));
    candidates.add(Math.round(clearing * 0.95));
    candidates.add(Math.round(clearing * 0.90));
    candidates.add(Math.round(clearing * 0.85));
  }
  if (curve && curve.lastMinuteAdr != null) candidates.add(Math.round(curve.lastMinuteAdr));
  // Occupancy-only deep cuts (old behaviour) — evaluate but they must beat EV
  const urg = DEFAULT_URGENCY[category] || DEFAULT_URGENCY.default;
  candidates.add(Math.round(refAdr * (1 - urg.soft)));
  candidates.add(Math.round(refAdr * (1 - urg.hard)));
  candidates.add(Math.round(refAdr * (1 - urg.critical)));

  function evAt(target) {
    if (target == null || target < floor) return { ev: -Infinity, pFill: 0 };
    if (clearing == null || clearing <= 0) {
      // No clearing history: mild cut only helps if forward fill is truly dead
      const boost = (forwardFill != null && forwardFill < horizon.red) ? 0.15 : 0.05;
      const p = Math.min(0.95, waitP + boost);
      return { ev: p * target, pFill: p };
    }
    if (target >= clearing * 0.98) {
      // At/above clearing: same fill as wait (price not the bottleneck)
      return { ev: waitP * Math.min(target, refAdr), pFill: waitP };
    }
    const cutFrac = (clearing - target) / clearing;
    // 20% of remaining deaths converted per 10% cut below clearing
    const convert = Math.min(dieRate || 0, (dieRate || 0) * (cutFrac / 0.10) * 0.20);
    const p = Math.min(0.97, waitP + convert);
    return { ev: p * target, pFill: p };
  }

  let best = { target: Math.round(refAdr), ev: evWait, pFill: waitP, delta: 0 };
  for (const t of candidates) {
    const tt = Math.max(floor, Math.min(Math.round(refAdr), t));
    const { ev, pFill: p } = evAt(tt);
    const delta = ev - evWait;
    if (ev > best.ev + 0.01 || (Math.abs(ev - best.ev) < 0.01 && tt > best.target)) {
      best = { target: tt, ev, pFill: p, delta };
    }
  }

  // High-LM units that already clear near waitPrice: don't cut below clearing just
  // because the next week is empty — that's their normal booking pattern.
  const highLm = lmShare != null && lmShare >= 0.60;
  const strongSelfFill = pFill != null && pFill >= 0.75;
  if ((highLm || strongSelfFill) && clearing != null) {
    const capped = Math.max(best.target, Math.round(clearing));
    if (capped > best.target) {
      const { ev, pFill: p } = evAt(capped);
      best = { target: capped, ev, pFill: p, delta: ev - evWait };
    }
  }

  // If best is essentially "keep ref" and ref ≈ clearing → no action
  const cutPct = (refAdr - best.target) / refAdr;
  if (cutPct < 0.03 && best.delta < refAdr * 0.02) {
    // Still allow Sync Now nudge when empty AND die rate is material but price OK
    if (!(forwardFill != null && forwardFill < horizon.red && dieRate != null && dieRate >= 0.40)) {
      return null;
    }
    // Price OK but deaths high — recommend hold clearing + Sync Now, severity soft
    best.target = Math.round(Math.min(refAdr, clearing != null ? clearing : refAdr));
  }

  // Severity from REVENUE economics + death rate — not from empty calendar alone
  let severity = 'none';
  const die = dieRate != null ? dieRate : 0;
  if (best.delta >= refAdr * 0.08 && die >= 0.45) severity = 'critical';
  else if (best.delta >= refAdr * 0.04 && die >= 0.30) severity = 'hard';
  else if (best.delta >= refAdr * 0.02 || (clearing != null && clearing < refAdr * 0.92)) severity = 'soft';
  else if (forwardFill != null && forwardFill < horizon.red && die >= 0.40) severity = 'soft';

  // Empty calendar on a strong LM self-filler → soft/watch at most
  if ((highLm || strongSelfFill) && severity === 'critical' && die < 0.40) severity = 'soft';
  if ((highLm || strongSelfFill) && severity === 'hard' && die < 0.30) severity = 'soft';

  if (severity === 'none' && cutPct < 0.03) return null;

  // Recompute final cut after severity guardrails
  let target = best.target;
  target = Math.max(floor, Math.min(Math.round(refAdr), Math.round(target)));
  const refR = Math.round(refAdr);
  const finalCutPct = refR > 0 ? (refR - target) / refR : 0;
  const evWaitR = Math.round(evWait);
  const evCutR = Math.round(best.ev);
  const plImplied = PRICELABS.impliedDiscountAtLead(pricingLead != null ? pricingLead : usedLead);
  const exceedsPriceLabsDefault = plImplied == null || cutNeededExceeds(refAdr, target, plImplied);
  const nearArrival = pricingLead != null && pricingLead <= 2;

  // No meaningful price change → only keep as soft "hold + Sync Now" when deaths are bad
  if (finalCutPct < 0.03) {
    if (forwardFill != null && forwardFill < horizon.red && die >= 0.40) {
      const syncHold = 'Hold price; PriceLabs → Sync Now — deaths are high but dumping rate does not raise EV';
      return {
        refAdr: refR,
        targetAdr: refR,
        cutPct: 0,
        cutEur: 0,
        severity: 'soft',
        usedLead,
        fillRate: pFill,
        clearingAdr: clearing != null ? Math.round(clearing) : null,
        observedLmDiscount: curve ? curve.lastMinuteDiscount : null,
        lmShare,
        evWait: evWaitR,
        evCut: evWaitR,
        evDelta: 0,
        objective: 'revenue',
        priceLabsImpliedDiscount: plImplied,
        exceedsPriceLabsDefault: false,
        syncAction: syncHold,
        priceLabsNote: `PriceLabs default LM ≈ gradual ${Math.round(PRICELABS.defaultLastMinute.discount * 100)}% / ${PRICELABS.defaultLastMinute.windowDays}d`
          + `; channel sync ~every ${PRICELABS.channelSyncHoursDefault}h.`,
        reason: `Revenue-first: no EV-positive cut below €${refR}. Vacant-at-D−${usedLead != null ? usedLead : '?'} die rate ${Math.round(die * 100)}% — sync visibility, don't dump price. ${syncHold}.`,
      };
    }
    return null;
  }

  if (severity === 'none') return null;

  const syncAction = (severity === 'critical' || severity === 'hard' || (nearArrival && severity === 'soft'))
    ? 'PriceLabs → Sync Now (do not wait for the daily ~24h channel push)'
    : (strongSelfFill || highLm)
      ? 'Hold near clearing; Sync Now only if still empty at D−2/D−1 — do not dump price'
      : 'Will ride the next PriceLabs daily sync unless you need it live tonight';

  const reasonCore = strongSelfFill || highLm
    ? `Revenue-first: vacant-at-D−${usedLead != null ? usedLead : '?'} historically fills ${pFill != null ? Math.round(pFill * 100) + '%' : '—'} at ~€${clearing != null ? Math.round(clearing) : '—'}`
      + (lmShare != null ? ` (${Math.round(lmShare * 100)}% of bookings are ≤7d lead)` : '')
      + `. EV wait €${evWaitR}/night vs cut €${evCutR}; target €${target} protects bottom line.`
    : die >= 0.45
      ? `Vacant nights often die (${Math.round(die * 100)}%); EV-max target €${target} (wait €${evWaitR} → cut €${evCutR}).`
      : `Aim €${target} to match clearing (~€${clearing != null ? Math.round(clearing) : '—'}) where EV improves (Δ €${Math.round(best.delta)}/night).`;

  return {
    refAdr: refR,
    targetAdr: target,
    cutPct: finalCutPct,
    cutEur: refR - target,
    severity,
    usedLead,
    fillRate: pFill,
    clearingAdr: clearing != null ? Math.round(clearing) : null,
    observedLmDiscount: curve ? curve.lastMinuteDiscount : null,
    lmShare,
    evWait: evWaitR,
    evCut: evCutR,
    evDelta: Math.round(best.delta),
    objective: 'revenue',
    priceLabsImpliedDiscount: plImplied,
    exceedsPriceLabsDefault,
    syncAction,
    priceLabsNote: `PriceLabs default LM ≈ gradual ${Math.round(PRICELABS.defaultLastMinute.discount * 100)}% / ${PRICELABS.defaultLastMinute.windowDays}d`
      + (plImplied != null ? ` → ~${Math.round(plImplied * 100)}% at this lead` : '')
      + `; channel sync ~every ${PRICELABS.channelSyncHoursDefault}h.`,
    reason: `${reasonCore} ${syncAction}.`,
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
  lmDependency,
  recommendCut,
  priceLabsGapReport,
  runBacktest,
  portfolioBacktest,
  liveRecommendation,
};
