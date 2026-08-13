#!/usr/bin/env node
/**
 * Run last-minute pricing backtest against Hosthub-shaped bookings.
 *
 * Usage:
 *   # Live Hosthub (same auth/pagination as server.js runSync):
 *   HOSTHUB_API_KEY=… node scripts/run-last-minute-backtest.js --hosthub
 *
 *   # Already-synced Postgres (what production uses):
 *   DATABASE_URL=… node scripts/run-last-minute-backtest.js --db
 *
 *   # Hit the deployed API (uses server's Hosthub key / DB):
 *   APP_PASSWORD=… node scripts/run-last-minute-backtest.js --api https://elysian-clearing-production.up.railway.app
 *   APP_PASSWORD=… node scripts/run-last-minute-backtest.js --api https://… --refresh
 *
 *   # Local file:
 *   node scripts/run-last-minute-backtest.js --file bookings.json
 *
 * Why --hosthub "wasn't working" in the cloud agent:
 *   The agent only had RAILWAY_TOKEN (invalid/expired), so it could not read
 *   Railway variables (HOSTHUB_API_KEY / DATABASE_URL / APP_PASSWORD). A bare
 *   HOSTHUB_API_KEY=bad call returns Hosthub 401 — that is auth, not a bug in
 *   the backtest math. Prefer --db or --api against production after sync.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  portfolioBacktest,
  liveRecommendation,
  PRICING_HORIZON,
  PRICELABS,
  priceLabsGapReport,
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
    if (Math.hypot(lat - 37.9838, lng - 23.7275) < 0.4) return 'attiki';
    if (Math.hypot(lat - 40.6401, lng - 22.9444) < 0.3) return 'thessaloniki';
    return 'escape';
  }
  return 'attiki';
}

const NAME_LISTS = {
  thess: ['elysian cornerstone', 'elysian hightower', 'le alex', 'le floor', 'le grace', 'le plaza', 'the skarlatos residence'],
  escape: ['ariti 7', 'ariti7', 'eclectic', 'seaside lavrio', 'sunset nest in fiskardo', 'villa liberty', 'p & g apartment'],
};

// ── Hosthub client (mirrors server.js exactly) ───────────────────────────────
const BASE = 'https://app.hosthub.com/api/2019-03-01';
const HH = 'https://app.hosthub.com';
const hhH = (key) => ({
  Authorization: key,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
function nextUrl(nav) {
  const n = nav?.next;
  if (!n) return null;
  return n.startsWith('http') ? n : `${HH}${n}`;
}
async function hhGet(url, key) {
  const r = await fetch(url, { headers: hhH(key) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { _err: true, status: r.status, text: text.slice(0, 200) };
  }
  return r.json();
}
async function fetchPages(startUrl, key, onPage) {
  const all = [];
  let url = startUrl;
  let page = 0;
  while (url) {
    page++;
    let obj;
    try { obj = await hhGet(url, key); } catch (e) {
      console.error('fetchPages network:', e.message);
      break;
    }
    if (obj._err) {
      throw new Error(`Hosthub HTTP ${obj.status} for ${url}${obj.text ? ' — ' + obj.text : ''}`);
    }
    const items = obj.data || [];
    all.push(...items);
    if (onPage) onPage(all.length, items.length, page);
    const next = nextUrl(obj.navigation);
    if (!next || items.length === 0) break;
    url = next;
  }
  return all;
}

async function loadFromHosthub(apiKey) {
  // Probe auth first with a clear error (this is what failed before with a dummy key)
  const who = await hhGet(`${BASE}/users`, apiKey);
  if (who._err) {
    throw new Error(
      `Hosthub auth failed (${who.status}). `
      + `Authorization header must be the raw API key (same as server.js hhH). `
      + `Get it from Hosthub → Settings → API Keys, or from Railway var HOSTHUB_API_KEY.`
    );
  }
  console.error(`Authenticated: ${who.data?.[0]?.name || who.data?.[0]?.email || 'ok'}`);

  const rentals = await fetchPages(`${BASE}/rentals`, apiKey, (t, n, p) => {
    if (p === 1 || n > 0) console.error(`  rentals page ${p}: +${n} (total ${t})`);
  });
  const rName = {};
  for (const r of rentals) rName[r.id] = r;

  // Same dual-fetch as runSync: global calendar-events + per-rental
  const seen = new Set();
  const allEvents = [];
  const add = (evs) => {
    for (const e of evs) {
      if (!seen.has(e.id)) { seen.add(e.id); allEvents.push(e); }
    }
  };
  add(await fetchPages(`${BASE}/calendar-events?is_visible=all`, apiKey, (t, n, p) => {
    if (n > 0) console.error(`  events page ${p}: +${n} (total ${t})`);
  }));
  console.error(`  Per-rental fetch for ${rentals.length} properties…`);
  for (const rental of rentals) {
    const evs = await fetchPages(`${BASE}/rentals/${rental.id}/calendar-events?is_visible=all`, apiKey).catch(() => []);
    const before = allEvents.length;
    add(evs);
    if (allEvents.length > before) console.error(`  ${rental.name}: +${allEvents.length - before}`);
  }

  const money = v => (v && typeof v === 'object') ? (v.cents || 0) / 100 : (parseFloat(v || 0) || 0);
  const fmt = (s) => {
    if (!s) return null;
    const d = new Date(String(s).slice(0, 10) + (String(s).includes('T') ? '' : 'T12:00:00Z'));
    if (isNaN(d)) return null;
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
  };

  const bookings = allEvents.filter(ev => {
    const t = (ev.type || '').toLowerCase();
    if (t.includes('hold') || t.includes('block')) return false;
    if (ev.is_visible !== false) return true;
    const gross = money(ev.total_price) || money(ev.guest_paid) || money(ev.total_reservation_price);
    return gross > 0;
  }).map(ev => {
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

  return {
    bookings,
    apartments: rentals.map(r => ({
      id: String(r.id), name: r.name, city: r.city, lat: r.latitude, lng: r.longitude,
    })),
  };
}

async function loadFromDb() {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL
    || process.env.POSTGRES_URL || process.env.POSTGRES_PRIVATE_URL;
  if (!url) throw new Error('DATABASE_URL required for --db');
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query("SELECT data FROM app_data WHERE key = 'main'");
    const data = r.rows[0]?.data;
    if (!data?.bks?.length) throw new Error('No bookings in app_data.main — run Hosthub sync first');
    return { bookings: data.bks, apartments: data.apts || [] };
  } finally {
    await client.end();
  }
}

async function loadFromApi(baseUrl, refresh) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) throw new Error('APP_PASSWORD required for --api (HTTP Basic Auth)');
  const auth = 'Basic ' + Buffer.from(':' + pw).toString('base64');
  const q = new URLSearchParams({ lookback: String(arg('--lookback', '90')) });
  if (refresh) q.set('refresh', '1');
  const url = `${baseUrl.replace(/\/$/, '')}/api/backtest/last-minute?${q}`;
  console.error('GET', url);
  const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`API ${r.status}: ${text.slice(0, 300)}`); }
  if (!r.ok) throw new Error(`API ${r.status}: ${j.error || text.slice(0, 300)}`);
  return j; // full report already computed
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
  console.log(`As of ${report.asOf}`);
  console.log(`PriceLabs: recalc daily · channel sync ~every ${PRICELABS.channelSyncHoursDefault}h · default LM gradual ${Math.round(PRICELABS.defaultLastMinute.discount * 100)}% / ${PRICELABS.defaultLastMinute.windowDays}d\n`);

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
    if (data.priceLabsGap) {
      console.log(`  vs PriceLabs default: ${data.priceLabsGap.verdict}`);
      for (const o of data.priceLabsGap.buckets.filter(x => x.n >= 5 && x.gap != null)) {
        console.log(`    ${o.leadBucket}: observed ${pct(o.observedDiscount)} vs PL ${pct(o.priceLabsDefault)} → gap ${pct(o.gap)}`);
      }
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
      if (r.priceLabsNote) console.log(`    ${r.priceLabsNote}`);
      if (r.exceedsPriceLabsDefault) console.log('    ⚠ Deeper than PriceLabs default LM curve — update Last Minute Prices customization');
    }
    console.log('');
  }
}

function buildPerProp(data, lookback) {
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
    const live = liveRecommendation(bks, { category: cat, forwardFill, lookbackDays: lookback });
    if (live.recommendation) {
      perProp.push({
        aptId, name: apt.name || aptId, category: cat, forwardFill,
        recommendation: live.recommendation,
      });
    }
  }
  perProp.sort((a, b) => (b.recommendation?.cutPct || 0) - (a.recommendation?.cutPct || 0));
  return perProp;
}

async function main() {
  const asJson = !!arg('--json', false);
  const lookback = parseInt(arg('--lookback', '90'), 10) || 90;

  // API path returns a finished report
  const apiBase = arg('--api', null);
  if (apiBase && apiBase !== true) {
    const j = await loadFromApi(apiBase, !!arg('--refresh', false));
    if (asJson) {
      console.log(JSON.stringify(j, null, 2));
    } else {
      printReport(j.report, j.recommendations || []);
      console.log(`Source: ${j.source} · bookings ${j.coverage?.bookings} · created coverage ${pct(j.coverage?.createdCoverage)}`);
      if (j.diagnosis) {
        console.log('\nDiagnosis:');
        console.log(' ', j.diagnosis.whyHosthubCliFailsWithoutKey);
        console.log(' ', j.diagnosis.priceLabsCadence);
      }
    }
    return;
  }

  let data;
  if (arg('--hosthub', false)) {
    const key = process.env.HOSTHUB_API_KEY;
    if (!key) {
      console.error('HOSTHUB_API_KEY required for --hosthub');
      console.error('Or use: --db (DATABASE_URL) / --api <url> (APP_PASSWORD)');
      process.exit(1);
    }
    console.error('Fetching Hosthub (server.js-compatible client)…');
    data = await loadFromHosthub(key);
  } else if (arg('--db', false)) {
    console.error('Loading synced bookings from Postgres…');
    data = await loadFromDb();
  } else {
    const file = arg('--file', null);
    if (!file || file === true) {
      console.error('Usage: --hosthub | --db | --api <url> [--refresh] | --file bookings.json');
      process.exit(1);
    }
    data = loadFile(path.resolve(file));
  }

  const withCreated = data.bookings.filter(b => b.created != null || b.createdOnChannel != null).length;
  console.error(`Loaded ${data.bookings.length} bookings (${withCreated} with created timestamps), ${data.apartments.length} apartments`);

  const byCat = groupByCategory(data.bookings, data.apartments);
  const report = portfolioBacktest(byCat, { lookbackDays: lookback });
  const perProp = buildPerProp(data, lookback);

  if (asJson) {
    console.log(JSON.stringify({
      report,
      recommendations: perProp,
      coverage: {
        bookings: data.bookings.length,
        withCreated,
        createdCoverage: data.bookings.length ? withCreated / data.bookings.length : 0,
      },
      priceLabs: PRICELABS,
    }, null, 2));
  } else {
    printReport(report, perProp.slice(0, 40));
    console.log(`Bookings: ${data.bookings.length} · created coverage ${pct(data.bookings.length ? withCreated / data.bookings.length : 0)} · cut recs: ${perProp.length}`);
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
  console.error(e.message || e);
  process.exit(1);
});
