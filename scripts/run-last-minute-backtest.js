#!/usr/bin/env node
/**
 * Run last-minute pricing backtest against Hosthub-shaped bookings.
 *
 * Usage:
 *   node scripts/run-last-minute-backtest.js --file bookings.json
 *   HOSTHUB_API_KEY=… node scripts/run-last-minute-backtest.js --hosthub
 *   node scripts/run-last-minute-backtest.js --file bookings.json --json > report.json
 *
 * Input JSON: { bookings: [...], apartments?: [{id,name,city,lat,lng}] }
 * or a bare array of bookings (Hosthub-synced shape from Elysian Clearing).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  portfolioBacktest,
  liveRecommendation,
  PRICING_HORIZON,
} = require('../lib/last-minute-backtest');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  if (!n || n.startsWith('--')) return true;
  return n;
}

function pct(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v * 100) + '%';
}

function eur(v) {
  if (v == null || isNaN(v)) return '—';
  return '€' + Math.round(v);
}

function categorize(apt, nameLists) {
  const n = String((apt && apt.name) || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (nameLists.thess.some(f => n.includes(f))) return 'thessaloniki';
  if (nameLists.escape.some(f => n.includes(f))) return 'escape';
  const city = String((apt && apt.city) || '').toLowerCase();
  if (/thessaloniki|salonika/.test(city)) return 'thessaloniki';
  if (/athens|athina|piraeus|pireas|zografou|kallithea/.test(city)) return 'attiki';
  if (apt && apt.lat != null && apt.lng != null) {
    const lat = +apt.lat, lng = +apt.lng;
    const dAth = Math.hypot(lat - 37.9838, lng - 23.7275);
    const dThess = Math.hypot(lat - 40.6401, lng - 22.9444);
    if (dAth < 0.4) return 'attiki';
    if (dThess < 0.3) return 'thessaloniki';
    return 'escape';
  }
  return 'attiki';
}

const NAME_LISTS = {
  thess: ['elysian cornerstone', 'elysian hightower', 'le alex', 'le floor', 'le grace', 'le plaza', 'the skarlatos residence'],
  escape: ['ariti 7', 'ariti7', 'eclectic', 'seaside lavrio', 'sunset nest in fiskardo', 'villa liberty', 'p & g apartment'],
};

async function loadFromHosthub(apiKey) {
  const BASE = 'https://app.hosthub.com/api/2019-03-01';
  const headers = { Authorization: apiKey, Accept: 'application/json' };
  async function pages(url) {
    const out = [];
    let next = url;
    while (next) {
      const r = await fetch(next.startsWith('http') ? next : BASE + next, { headers });
      if (!r.ok) throw new Error(`Hosthub ${r.status} for ${next}`);
      const j = await r.json();
      const data = j.data || j || [];
      out.push(...data);
      next = j.next_page_url || j.links?.next || null;
      if (typeof next === 'string' && next.includes('app.hosthub.com')) {
        // full URL ok
      } else if (next && !String(next).startsWith('/')) {
        next = null;
      }
      if (!j.next_page_url && !j.links?.next) break;
      if (data.length === 0) break;
    }
    return out;
  }
  // Prefer simpler single-page + pagination via ?page=
  async function fetchAll(pathSuffix) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const sep = pathSuffix.includes('?') ? '&' : '?';
      const r = await fetch(`${BASE}${pathSuffix}${sep}page=${page}`, { headers });
      if (!r.ok) throw new Error(`Hosthub ${r.status}`);
      const j = await r.json();
      const data = j.data || [];
      out.push(...data);
      if (!data.length || data.length < 50) break;
    }
    return out;
  }

  const rentals = await fetchAll('/rentals');
  const events = await fetchAll('/calendar-events?is_visible=all');
  const rName = {};
  for (const r of rentals) rName[r.id] = r;

  const money = v => (v && typeof v === 'object') ? (v.cents || 0) / 100 : (parseFloat(v || 0) || 0);
  const fmt = (s) => {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d)) return null;
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  };

  const bookings = events.map(ev => {
    const rental = rName[ev.rental_id] || {};
    const gross = money(ev.total_price) || money(ev.guest_paid) || money(ev.booking_value);
    const pay = money(ev.total_payout) || money(ev.host_payout) || gross;
    return {
      id: ev.id,
      aptId: String(ev.rental_id || ''),
      aptName: rental.name || '',
      cancelled: ev.is_visible === false,
      cancelledAt: ev.cancelled_at || null,
      created: ev.created || null,
      createdOnChannel: ev.created_on_channel || null,
      guestName: ev.guest_name || ev.title || '',
      checkIn: fmt(ev.date_from),
      checkOut: fmt(ev.date_to),
      nights: ev.nights || 0,
      payout: pay,
      gross,
      city: rental.city || '',
      lat: rental.latitude,
      lng: rental.longitude,
    };
  });

  const apartments = rentals.map(r => ({
    id: String(r.id),
    name: r.name,
    city: r.city,
    lat: r.latitude,
    lng: r.longitude,
  }));

  return { bookings, apartments };
}

function loadFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw)) return { bookings: raw, apartments: [] };
  return {
    bookings: raw.bookings || raw.bks || [],
    apartments: raw.apartments || raw.apts || [],
  };
}

function groupByCategory(bookings, apartments) {
  const aptMap = {};
  for (const a of apartments) aptMap[String(a.id)] = a;
  const byCat = { attiki: [], thessaloniki: [], escape: [] };
  for (const b of bookings) {
    const apt = aptMap[String(b.aptId)] || { name: b.aptName, city: b.city, lat: b.lat, lng: b.lng };
    const cat = categorize(apt, NAME_LISTS);
    byCat[cat].push(b);
  }
  return byCat;
}

function printReport(report, perProp) {
  console.log('\n══ Last-minute pricing backtest (Hosthub creation dates) ══\n');
  console.log(`As of ${report.asOf}\n`);

  for (const [cat, data] of Object.entries(report.byCat)) {
    const c = data.curve;
    const s = data.survival;
    console.log(`── ${cat.toUpperCase()} ──`);
    console.log(`  Samples: ${c.sampleSize} priced bookings`);
    console.log(`  Early ADR (≥15d):     ${eur(c.earlyAdr)}`);
    console.log(`  Last-minute ADR (≤7d): ${eur(c.lastMinuteAdr)}  (discount ${pct(c.lastMinuteDiscount)} vs early)`);
    console.log('  Lead-time ADR curve:');
    for (const b of c.buckets) {
      if (!b.n) continue;
      console.log(`    ${b.key.padEnd(6)} n=${String(b.n).padStart(4)}  med ${eur(b.medianAdr).padStart(5)}  vs early ${pct(b.vsEarly)}`);
    }
    console.log('  Vacancy survival (nights still empty at lead → eventual fill):');
    for (const L of [14, 7, 3, 1]) {
      const row = s.byLead[L];
      if (!row) continue;
      console.log(`    D−${String(L).padStart(2)}  vacant ${String(row.vacantAtLead).padStart(5)}  fill ${pct(row.fillRate).padStart(4)}  never ${pct(row.neverFillRate).padStart(4)}  clearing ${eur(row.clearingAdr)}`);
    }
    console.log('  Suggested PriceLabs overlay (observed % below early ADR):');
    for (const o of data.overlay || []) {
      if (o.n < 3) continue;
      console.log(`    lead ${o.leadBucket}: cut ~${pct(o.observedDiscount)} (n=${o.n})`);
    }
    console.log('');
  }

  if (perProp && perProp.length) {
    console.log('── Live recommendations (empty / soft forward fill) ──');
    for (const p of perProp) {
      const r = p.recommendation;
      if (!r) continue;
      console.log(`  ${p.name}: cut €${r.cutEur} → €${r.targetAdr}/night (${pct(r.cutPct)} off €${r.refAdr}) [${r.severity}]`);
      console.log(`    ${r.reason}`);
    }
    console.log('');
  }
}

async function main() {
  const asJson = !!arg('--json', false);
  const lookback = parseInt(arg('--lookback', '90'), 10) || 90;
  let data;

  if (arg('--hosthub', false)) {
    const key = process.env.HOSTHUB_API_KEY;
    if (!key) {
      console.error('HOSTHUB_API_KEY required for --hosthub');
      process.exit(1);
    }
    console.error('Fetching Hosthub…');
    data = await loadFromHosthub(key);
  } else {
    const file = arg('--file', null);
    if (!file) {
      console.error('Usage: --file bookings.json | --hosthub');
      process.exit(1);
    }
    data = loadFile(path.resolve(file));
  }

  const byCat = groupByCategory(data.bookings, data.apartments);
  const report = portfolioBacktest(byCat, { lookbackDays: lookback });

  // Per-property live recs when apartments provided
  const aptMap = {};
  for (const a of data.apartments) aptMap[String(a.id)] = a;
  const byApt = {};
  for (const b of data.bookings) {
    const k = String(b.aptId || b.aptName || '');
    (byApt[k] = byApt[k] || []).push(b);
  }
  const perProp = [];
  for (const [aptId, bks] of Object.entries(byApt)) {
    const apt = aptMap[aptId] || { id: aptId, name: bks[0]?.aptName || aptId };
    const cat = categorize(apt, NAME_LISTS);
    const horizon = PRICING_HORIZON[cat] || PRICING_HORIZON.default;
    // Crude forward fill: share of next horizon.window nights booked (from today)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + horizon.window);
    const booked = new Set();
    for (const b of bks) {
      if (b.cancelled) continue;
      const guest = String(b.guestName || '').toLowerCase();
      if (['maintenance', 'owner block', 'block', 'owner stay'].includes(guest)) continue;
      const ci = parseDSafe(b.checkIn), co = parseDSafe(b.checkOut);
      if (!ci || !co) continue;
      let n = new Date(ci);
      while (n < co) {
        if (n >= today && n < end) booked.add(n.toISOString().slice(0, 10));
        n.setDate(n.getDate() + 1);
      }
    }
    const forwardFill = booked.size / horizon.window;
    const live = liveRecommendation(bks, {
      category: cat,
      forwardFill,
      lookbackDays: lookback,
      refAdr: undefined,
    });
    if (live.recommendation) {
      perProp.push({
        aptId,
        name: apt.name || aptId,
        category: cat,
        forwardFill,
        recommendation: live.recommendation,
      });
    }
  }
  perProp.sort((a, b) => (b.recommendation?.cutPct || 0) - (a.recommendation?.cutPct || 0));

  if (asJson) {
    console.log(JSON.stringify({ report, recommendations: perProp }, null, 2));
  } else {
    printReport(report, perProp.slice(0, 40));
    console.log(`Bookings: ${data.bookings.length} · Properties with cut recs: ${perProp.length}`);
  }
}

function parseDSafe(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
