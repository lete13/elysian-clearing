/**
 * Elysian Clearing — Server v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Local dev : npm install && npm start  →  http://localhost:3000
 * Production: push to GitHub → Railway auto-deploys
 *
 * Environment variables (set in Railway → Variables):
 *   HOSTHUB_API_KEY   Raw Hosthub API key (skips per-user entry)
 *   APP_PASSWORD      Password to protect the app (HTTP Basic Auth)
 *   DATABASE_URL      PostgreSQL connection string (auto-set by Railway DB add-on)
 *   PORT              Auto-set by Railway
 */

const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
let pool = null;

// Railway uses several possible variable names for the Postgres connection
const DB_URL = process.env.DATABASE_URL
            || process.env.POSTGRES_URL
            || process.env.PGDATABASE_URL
            || process.env.DATABASE_PRIVATE_URL
            || process.env.POSTGRES_PRIVATE_URL;

// Railway also exposes individual PG variables — build URL from those as fallback
const PG_URL = (!DB_URL && process.env.PGHOST)
  ? `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT||5432}/${process.env.PGDATABASE}`
  : null;

const connStr = DB_URL || PG_URL;

console.log('  DB_URL found:', connStr ? connStr.slice(0,30)+'…' : 'none');
console.log('  Env DB vars:', Object.keys(process.env).filter(k=>k.includes('PG')||k.includes('DATABASE')||k.includes('POSTGRES')).join(', '));

if (connStr) {
  pool = new Pool({
    connectionString: connStr,
    ssl: connStr.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  // Create table on first run
  pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key         VARCHAR(50) PRIMARY KEY,
      data        JSONB       NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `).then(() => {
    console.log('  ✓  PostgreSQL ready');
  }).catch(e => {
    console.error('  ✗  PostgreSQL init error:', e.message);
  });
} else {
  console.log('  ⚠  No Postgres connection string found — running in local mode');
  console.log('     Checked: DATABASE_URL, POSTGRES_URL, PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
}

// ── Password protection (optional) ───────────────────────────────────────────
const APP_PASSWORD   = process.env.APP_PASSWORD   || '';
const SERVER_API_KEY = process.env.HOSTHUB_API_KEY || '';

if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const auth = req.headers['authorization'] || '';
    const b64  = auth.replace(/^Basic\s+/i, '');
    const [, pw] = Buffer.from(b64, 'base64').toString().split(':');
    if (pw === APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Elysian Clearing"');
    res.status(401).send('Authentication required');
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' }));

// ── Hosthub helpers ───────────────────────────────────────────────────────────
const BASE = 'https://app.hosthub.com/api/2019-03-01';
const HH   = 'https://app.hosthub.com';

const hhH = (key) => ({
  Authorization: key,
  Accept:        'application/json',
  'Content-Type':'application/json',
});
const eur = (m) => (m && m.cents != null ? m.cents / 100 : 0);
function nextUrl(nav) {
  const n = nav?.next;
  if (!n) return null;
  return n.startsWith('http') ? n : `${HH}${n}`;
}
async function hhGet(url, key) {
  const r = await fetch(url, { headers: hhH(key) });
  if (!r.ok) return { _err: true, status: r.status, text: await r.text().catch(() => '') };
  return r.json();
}
async function fetchPages(startUrl, key, onPage) {
  const all = []; let url = startUrl; let page = 0;
  while (url) {
    page++;
    let obj;
    try { obj = await hhGet(url, key); } catch(e) { console.error('fetchPages:', e.message); break; }
    if (obj._err) { console.error(`fetchPages HTTP ${obj.status}`); break; }
    const items = obj.data || [];
    all.push(...items);
    if (onPage) onPage(all.length, items.length, page);
    const next = nextUrl(obj.navigation);
    if (!next || items.length === 0) break;
    url = next;
  }
  return all;
}
async function batch(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = await Promise.all(items.slice(i, i + size).map(fn));
    results.push(...chunk);
  }
  return results;
}

// ── /api/discover — server liveness + Hosthub endpoint discovery ─────────────
app.get('/api/discover', async (req, res) => {
  const key = SERVER_API_KEY || req.query.api_key || req.headers['x-api-key'] || '';

  // Test a set of Hosthub endpoints and return results
  // Note: include a URL with "booking" in it so the frontend bookingsResult finder matches
  const endpoints = [
    `${BASE}/users`,
    `${BASE}/rentals`,
    `${BASE}/calendar-events?per_page=1`,
    `${BASE}/bookings?per_page=1`,          // may 404 but gives frontend a match target
  ];

  const results = await Promise.all(endpoints.map(async url => {
    if (!key) return { url, status: 401, data: null };
    try {
      const r    = await fetch(url, { headers: hhH(key) });
      const data = r.ok ? await r.json().catch(() => null) : null;
      return { url, status: r.status, data };
    } catch(e) {
      return { url, status: 0, error: e.message, data: null };
    }
  }));

  res.json({
    server:  'elysian-clearing',
    version: '2.0',
    db:      !!pool,
    keyHint: key ? key.slice(0, 8) + '…' : null,
    results,
  });
});

// ── /api/session — shared session (backed by DB when available) ───────────────
let _memSession = null; // fallback when no DB

app.get('/api/session', async (req, res) => {
  if (pool) {
    try {
      const r = await pool.query("SELECT data, updated_at FROM app_data WHERE key = 'session'");
      if (!r.rows.length) return res.status(404).json({ error: 'No session yet' });
      return res.json({ ...r.rows[0].data, _savedAt: r.rows[0].updated_at });
    } catch(e) { console.error('[session] read:', e.message); }
  }
  if (!_memSession) return res.status(404).json({ error: 'No session yet' });
  res.json(_memSession);
});

app.post('/api/session', async (req, res) => {
  const payload = { ...req.body, _pushedAt: new Date().toISOString() };
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO app_data (key, data) VALUES ('session', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(payload)]
      );
      return res.json({ ok: true, db: true });
    } catch(e) { console.error('[session] write:', e.message); }
  }
  _memSession = payload;
  res.json({ ok: true, db: false });
});



// GET /api/db/data — load the shared app state from PostgreSQL
app.get('/api/db/data', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured. Running in local mode.' });
  try {
    const result = await pool.query('SELECT data, updated_at FROM app_data WHERE key = $1', ['main']);
    if (result.rows.length === 0) return res.json(null);
    res.json({ ...result.rows[0].data, _savedAt: result.rows[0].updated_at });
  } catch(e) {
    console.error('[db] read error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/db/data — save the full app state to PostgreSQL
// SERVER-SIDE DATA PROTECTION: never allow overwriting real data with empty state
app.post('/api/db/data', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured.' });
  try {
    const payload = req.body;
    const inBks  = Array.isArray(payload.bks)  ? payload.bks.length  : 0;
    const inExps = Array.isArray(payload.exps) ? payload.exps.length : 0;

    // Read current DB state
    const cur = await pool.query("SELECT data FROM app_data WHERE key = 'main'");
    const existing = cur.rows[0]?.data;

    if (existing) {
      const dbBks  = Array.isArray(existing.bks)  ? existing.bks.length  : 0;
      const dbExps = Array.isArray(existing.exps) ? existing.exps.length : 0;
      const dbApts = Array.isArray(existing.apts) ? existing.apts : [];
      const inApts = Array.isArray(payload.apts)  ? payload.apts  : [];

      // ANTI-WIPE BOOKINGS
      if (dbBks > 10 && inBks === 0) {
        console.warn('[db] BLOCKED write: would wipe', dbBks, 'bookings');
        return res.status(409).json({ error: 'Write blocked: would delete ' + dbBks + ' bookings.', blocked: true });
      }
      // ANTI-WIPE EXPENSES
      if (dbExps > 0 && inExps === 0 && dbBks > 0) {
        console.warn('[db] BLOCKED write: would wipe', dbExps, 'expenses');
        return res.status(409).json({ error: 'Write blocked: would delete ' + dbExps + ' expenses.', blocked: true });
      }

      // MERGE APTS: only protect against startup resets, not user changes
      // A startup reset is detected when ALL (or nearly all) apts have the global default mgmtFee of 20
      // A user save will have mixed mgmtFee values — trust it fully
      if (dbApts.length > 0 && inApts.length > 0) {
        const inWith20 = inApts.filter(a => a.mgmtFee === 20 || (!a.mgmtFee)).length;
        const isStartupReset = inWith20 > inApts.length * 0.7; // >70% at default = startup reset

        if (isStartupReset) {
          console.warn('[db] Detected startup reset for apts (' + inWith20 + '/' + inApts.length + ' at default) — merging with DB configs');
          const dbByName = {};
          dbApts.forEach(a => { if (a.name) dbByName[a.name.trim()] = a; });
          payload.apts = inApts.map(apt => {
            const dbApt = dbByName[apt.name?.trim()];
            if (!dbApt) return apt;
            // Startup reset: restore all custom configs from DB
            return { ...apt, ...dbApt, id: apt.id || dbApt.id, name: apt.name || dbApt.name };
          });
        }
        // Otherwise: user intentionally saved — trust incoming values completely
      }

      // Fallback merges
      if (dbExps > 0 && inExps === 0) payload.exps = existing.exps;
      if (dbBks  > 0 && inBks  === 0) payload.bks  = existing.bks;
    }

    await pool.query(
      `INSERT INTO app_data (key, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      ['main', JSON.stringify(payload)]
    );
    const ts = await pool.query("SELECT updated_at FROM app_data WHERE key = 'main'");
    res.json({ ok: true, savedAt: ts.rows[0]?.updated_at });
  } catch(e) {
    console.error('[db] write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/db/status — returns last save time (for polling)
app.get('/api/db/status', async (req, res) => {
  if (!pool) return res.json({ db: false });
  try {
    const result = await pool.query("SELECT updated_at, data FROM app_data WHERE key = 'main'");
    if (!result.rows.length) return res.json({ db: true, updatedAt: null, _bksCount: 0, _expsCount: 0 });
    const data = result.rows[0].data;
    res.json({
      db: true,
      updatedAt:   result.rows[0].updated_at || null,
      _bksCount:   Array.isArray(data?.bks)  ? data.bks.length  : 0,
      _expsCount:  Array.isArray(data?.exps) ? data.exps.length : 0,
      _aptsCount:  Array.isArray(data?.apts) ? data.apts.length : 0,
    });
  } catch(e) {
    res.json({ db: false, error: e.message });
  }
});

// ── Hosthub Proxy ─────────────────────────────────────────────────────────────
app.all('/api/hosthub/*', async (req, res) => {
  const key = SERVER_API_KEY || req.query.api_key || req.headers['x-api-key'] || '';
  if (!key) return res.status(400).json({ error: 'Missing api_key' });
  const sub = req.path.replace(/^\/api\/hosthub/, '');
  const qs  = new URLSearchParams(req.query); qs.delete('api_key');
  const url = `${BASE}${sub}${qs.toString() ? '?' + qs : ''}`;
  console.log(`[proxy] ${req.method} ${url}`);
  try {
    const r    = await fetch(url, { method: req.method, headers: hhH(key) });
    const text = await r.text();
    res.status(r.status).set('Content-Type', 'application/json').send(text);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── Full Hosthub Sync ─────────────────────────────────────────────────────────
// ── Core sync function (shared by HTTP endpoint + auto-scheduler) ─────────────
async function runSync(apiKey, onLog) {
  const log  = (msg, type='info') => { onLog && onLog(msg, type); };
  const results = { rentals: [], bookings: [], error: false };

  // 1. Verify key
  log('Verifying API key…');
  try {
    const r = await fetch(`${BASE}/users`, { headers: hhH(apiKey) });
    if (r.status === 401) { log('API key rejected (401).', 'error'); results.error=true; return results; }
    if (!r.ok)            { log(`Unexpected ${r.status} from /users`, 'error'); results.error=true; return results; }
    const u = (await r.json())?.data?.[0];
    log(`Authenticated: ${u?.name || '?'} (${u?.email || '?'})`, 'ok');
  } catch(e) {
    log(`Network error: ${e.message}`, 'error');
    results.error=true; return results;
  }

  // 2. Rentals
  log('Fetching properties…');
  const rentals = await fetchPages(`${BASE}/rentals`, apiKey).catch(() => []);
  const rName = {}; for (const r of rentals) rName[r.id] = r.name;
  log(`${rentals.length} properties loaded`, 'ok');

  // 2b. Load current apts from DB for aptId matching
  let currentApts = [];
  if (pool) {
    try {
      const dbRow = await pool.query("SELECT data FROM app_data WHERE key='main'");
      currentApts = dbRow.rows[0]?.data?.apts || [];
    } catch(e) {}
  }

  // 3. Calendar events
  log('Fetching all bookings…');
  const allEvents = []; const seen = new Set();
  const addEvents = (evs) => { for (const e of evs) { if (!seen.has(e.id)) { seen.add(e.id); allEvents.push(e); } } };

  const globalEvs = await fetchPages(`${BASE}/calendar-events?is_visible=all`, apiKey,
    (total, pageLen, page) => { if (pageLen > 0) log(`  Global page ${page}: +${pageLen} (${total} total)`); }
  ).catch(() => []);
  addEvents(globalEvs);

  log(`  Per-rental fetch for ${rentals.length} properties…`);
  for (const rental of rentals) {
    const evs = await fetchPages(`${BASE}/rentals/${rental.id}/calendar-events?is_visible=all`, apiKey).catch(() => []);
    const before = allEvents.length; addEvents(evs);
    const added = allEvents.length - before;
    if (added > 0) log(`  ${rental.name}: +${added}`);
  }

  const bookingEvs = allEvents.filter(e => {
    const t = (e.type || '').toLowerCase();
    if (t.includes('hold') || t.includes('block')) return false; // exclude holds/blocks
    if (e.is_visible !== false) return true;  // active booking — always include
    // Cancelled booking: only include if there is financial value (owner keeps some payment)
    const gross = parseFloat(e.total_price || e.guest_paid || e.total_reservation_price || 0);
    return gross > 0;
  });
  log(`${allEvents.length} total events → ${bookingEvs.length} active bookings`, 'ok');

  // 4. Greek taxes
  log(`Fetching Greek taxes for ${bookingEvs.length} bookings…`);
  const grTaxMap = {}; const BATCH_SIZE = 20; let fetched = 0;
  for (let i = 0; i < bookingEvs.length; i += BATCH_SIZE) {
    const chunk = bookingEvs.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(async ev => {
      try {
        const r = await fetch(`${BASE}/calendar-events/${ev.id}/calendar-event-gr-taxes`, { headers: hhH(apiKey) });
        if (r.ok) grTaxMap[ev.id] = await r.json();
      } catch(e) {}
    }));
    fetched += chunk.length;
    if (fetched % 200 === 0 || fetched === bookingEvs.length)
      log(`  Taxes: ${fetched}/${bookingEvs.length} — ${Object.keys(grTaxMap).length} with data`);
  }

  // 5. Map bookings
  const bookings = bookingEvs.map(ev => {
    const bkv=eur(ev.booking_value), clf=eur(ev.cleaning_fee), otf=eur(ev.other_fees);
    const tax=eur(ev.taxes), svc=eur(ev.service_fee_host), pchg=eur(ev.payment_charges), pay=eur(ev.total_payout);
    const gr=grTaxMap[ev.id]||{};
    const ct=eur(gr.climate_tax), bvpv=eur(gr.booking_value_pre_vat), vat=eur(gr.vat), at=eur(gr.accommodation_tax), nbv=eur(gr.net_value);
    const grTotal=eur(gr.total_booking_value), guestPd=eur(ev.guest_paid)||eur(ev.total_reservation_price);
    const calcGross=bkv+clf+otf+tax;
    const gross=grTotal>0?grTotal:guestPd>0?guestPd:ct>0?calcGross+ct:calcGross;
    const d=ev.date_from?new Date(ev.date_from+'T00:00:00'):new Date();
    // Lookup internal aptId by matching rental name to existing apts
    const _aptName = ev.rental_unit?.name||ev.rental?.name||rName[ev.rental?.id]||'';
    const _aptNameNorm = _aptName.trim().toLowerCase();
    // Pass 1: exact match always wins (prevents "Veranda 2" grabbing "Veranda" bookings)
    let _aptMatch = (currentApts||[]).find(a => a.name && a.name.trim().toLowerCase() === _aptNameNorm);
    // Pass 2: partial match only if no exact match exists, guarded against numeric-suffix collisions
    // (e.g. "Veranda" must NOT match "Veranda 2" — different physical units)
    if (!_aptMatch && _aptNameNorm.length >= 3) {
      _aptMatch = (currentApts||[]).find(a => {
        if (!a.name) return false;
        const an = a.name.trim().toLowerCase();
        if (an.length <= 4) return false;
        if (_aptNameNorm.includes(an)) {
          const suffix = _aptNameNorm.slice(an.length).trim();
          return !/^\d/.test(suffix); // reject if suffix starts with a digit
        }
        if (an.includes(_aptNameNorm)) {
          const suffix = an.slice(_aptNameNorm.length).trim();
          return !/^\d/.test(suffix); // reject if suffix starts with a digit
        }
        return false;
      });
    }
    // Format date as D/M/YYYY (consistent with rest of app)
    const _fmtDate = iso => {
      if (!iso) return '';
      const p = iso.split('-');
      if (p.length === 3) return parseInt(p[2]) + '/' + parseInt(p[1]) + '/' + p[0];
      return iso;
    };
    return {
      id:ev.id, aptId:_aptMatch?.id||'', aptName:_aptName, cancelled:ev.is_visible===false, cancelledAt:ev.cancelled_at||null,
      platform: (()=>{
        const code=(ev.source?.channel_type_code||'').toLowerCase().replace(/[^a-z]/g,'');
        const n=(ev.source?.name||'').toLowerCase();
        const CODE={airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',expedia:'Expedia',vrbo:'VRBO',homeaway:'VRBO',tripadvisor:'TripAdvisor',directbooking:'Direct',direct:'Direct',hosthub:'Direct'};
        if(CODE[code]) return CODE[code];
        if(n.includes('airbnb')) return 'Airbnb';
        if(n.includes('booking')) return 'Booking.com';
        return ev.source?.name||code||'Direct';
      })(),
      guestName:ev.guest_name||ev.title||'', guests:ev.guest_number||ev.guest_adults||null, checkIn:_fmtDate(ev.date_from), checkOut:_fmtDate(ev.date_to), nights:ev.nights||0,
      bkv, cleanH:clf, othr:otf, taxTot:tax, gross, svc, pchg, platFee:svc+pchg, payout:pay,
      ct, bvPrevat:bvpv, vat, at, nbv:nbv||(gross-ct-vat-at), trHost:ct+vat+at, trChan:0, thHost:0,
      mo:d.getMonth(), yr:d.getFullYear(),
    };
  });

  results.rentals  = rentals;
  results.bookings = bookings;
  log(`Sync complete — ${rentals.length} properties, ${bookings.length} bookings`, 'ok');
  return results;
}

// ── /api/sync HTTP endpoint ───────────────────────────────────────────────────
app.post('/api/sync', async (req, res) => {
  const { apiKey: clientKey } = req.body;
  const apiKey = SERVER_API_KEY || clientKey || '';
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  const writeLine = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch(e) {} };

  const onLog = (msg, type='info') => writeLine({ type, msg });

  const result = await runSync(apiKey, onLog);
  writeLine({ type: 'done', rentals: result.rentals, bookings: result.bookings, error: result.error });
  res.end();
});

// ── Merge apt configs: preserve existing custom configs, deduplicate by trimmed name ─────
function mergeApts(existing, rentals) {
  // Index existing by trimmed lowercase name to preserve configs
  const byName = {};
  existing.forEach(a => {
    if (a.name) byName[a.name.trim().toLowerCase()] = a;
  });
  // Add any new rentals from Hosthub not already present
  rentals.forEach(r => {
    const key = r.name?.trim().toLowerCase();
    if (key && !byName[key]) {
      byName[key] = { id: r.id, name: r.name.trim() };
    } else if (key && byName[key]) {
      // Normalize the name (remove trailing spaces) but keep existing config
      byName[key].name = byName[key].name.trim();
    }
  });
  return Object.values(byName).filter(a => a.name);
}

// ── Auto-sync scheduler (every 2 hours: 00:00, 02:00, 04:00 ... 22:00) ───────
function scheduleAutoSync() {
  const now   = new Date();
  const hh    = now.getHours();
  const mm    = now.getMinutes();
  const ss    = now.getSeconds();

  // Next even hour (0, 2, 4, 6 ... 22)
  const nextHour = hh % 2 === 0 && mm === 0 && ss < 5
    ? hh                          // just hit an even hour — run now-ish handled below
    : (Math.floor(hh / 2) + 1) * 2; // next even hour

  const nextRun = new Date(now);
  if (nextHour >= 24) {
    // wrap to midnight next day
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(0, 0, 0, 0);
  } else {
    nextRun.setHours(nextHour, 0, 0, 0);
  }

  const msUntil = nextRun - now;
  const hLeft   = Math.floor(msUntil / 3600000);
  const mLeft   = Math.floor((msUntil % 3600000) / 60000);

  console.log(`  ✓  Auto-sync scheduled → ${nextRun.toISOString()} (in ${hLeft}h ${mLeft}m)`);

  setTimeout(async () => {
    const apiKey = SERVER_API_KEY || (pool ? await getStoredApiKey() : null);
    if (!apiKey) {
      console.log('[auto-sync] No API key — skipping');
      scheduleAutoSync();
      return;
    }

    const started = new Date();
    console.log(`[auto-sync] Starting sync at ${started.toISOString()}`);
    const onLog = msg => console.log('[auto-sync]', msg);

    try {
      const result = await runSync(apiKey, onLog);
      if (!result.error && pool) {
        const existing = await pool.query("SELECT data FROM app_data WHERE key = 'main'").catch(() => ({ rows: [] }));
        const current  = existing.rows[0]?.data || {};
        // Also fetch cancelled-but-paid bookings and merge them in
        const cancelledEvs = await fetchPages(`${BASE}/calendar-events?is_visible=false`, apiKey).catch(()=>[]);
        const centsToEur = v => v && typeof v === 'object' ? (v.cents||0)/100 : parseFloat(v||0);
        const existingIds = new Set(result.bookings.map(b=>b.id));
        const currentApts = current.apts || [];
        const aptByName = {};
        currentApts.forEach(a => { if (a.name) aptByName[a.name.trim().toLowerCase()] = a; });
        const fmtDate = iso => { if (!iso||iso.includes('/')) return iso; const p=iso.split('-'); return p.length===3?parseInt(p[2])+'/'+parseInt(p[1])+'/'+p[0]:iso; };
        const CODE = {airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',expedia:'Expedia',vrbo:'VRBO',direct:'Direct',directbooking:'Direct',hosthub:'Direct'};
        const cancelledBks = cancelledEvs
          .filter(e => {
            const t=(e.type||'').toLowerCase();
            if (t.includes('hold')||t.includes('block')) return false;
            const gross = centsToEur(e.guest_paid)||centsToEur(e.booking_value);
            return gross > 0 && !existingIds.has(e.id);
          })
          .map(e => {
            const aptName = e.rental_unit?.name||e.rental?.name||'';
            const apt = aptByName[aptName.trim().toLowerCase()];
            const d = e.date_from ? new Date(e.date_from+'T00:00:00') : new Date();
            const gross  = (e.guest_paid?.cents  || 0) / 100;
            const svc    = (e.service_fee_host?.cents  || 0) / 100;
            const pchg   = (e.payment_charges?.cents   || 0) / 100;
            const payout = (e.total_payout?.cents      || 0) / 100;
            const bkv    = gross - svc - pchg;
            const code = (e.source?.channel_type_code||'').toLowerCase().replace(/[^a-z]/g,'');
            const srcName = (e.source?.name||'').toLowerCase();
            const CODE = {airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',expedia:'Expedia',vrbo:'VRBO',direct:'Direct',directbooking:'Direct',hosthub:'Direct'};
            const platform = CODE[code]||(srcName.includes('airbnb')?'Airbnb':srcName.includes('booking')?'Booking.com':'Direct');
            return { id:e.id, aptId:apt?.id||'', aptName, cancelled:true, cancelledAt:e.cancelled_at||null,
              platform, guestName:e.guest_name||e.title||'',
              guests:e.guest_number||null, checkIn:fmtDate(e.date_from), checkOut:fmtDate(e.date_to),
              nights:e.nights||0, gross, mo:d.getMonth(), yr:d.getFullYear(),
              bkv, svc, pchg, payout, ct:0, vat:0, at:0 };
          });
        if (cancelledBks.length) onLog(`  + ${cancelledBks.length} cancelled-but-paid booking(s) merged`);

        const merged   = {
          ...current,
          bks:  [...result.bookings, ...cancelledBks],
          apts: mergeApts(current.apts || [], result.rentals),
          exps: current.exps || [],
          meta: { ...(current.meta || {}), lastAutoSync: started.toISOString(), lastSync: started.toISOString() },
        };
        await pool.query(
          `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
          ['main', JSON.stringify(merged)]
        );
        console.log(`[auto-sync] ✓ Done — ${result.bookings.length} bookings saved at ${started.toISOString()}`);
      } else if (result.error) {
        console.error('[auto-sync] Sync error:', result.error);
      }
    } catch (e) {
      console.error('[auto-sync] Unexpected error:', e.message);
    }

    scheduleAutoSync(); // schedule next run
  }, msUntil);
}

// Start the scheduler
scheduleAutoSync();

// ── /api/auto-sync-status — last auto-sync info ───────────────────────────────
app.get('/api/auto-sync-status', (req, res) => {
  const AUTO_SYNC_HOUR = parseInt(process.env.AUTO_SYNC_HOUR || '4');
  const now  = new Date();
  const next = new Date(now);
  next.setHours(AUTO_SYNC_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  res.json({
    lastSync: _lastAutoSync,
    nextSync: next.toISOString(),
    log: _autoSyncLog.slice(-20),
  });
});


// ── Server config (tells client what's available) ─────────────────────────────
app.get('/api/server-config', (req, res) => {
  res.json({
    hasServerKey: !!SERVER_API_KEY,
    hasPassword:  !!APP_PASSWORD,
    hasDatabase:  !!pool,
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  if (pool) {
    try { await pool.query('SELECT 1'); dbOk = true; } catch(e) {}
  }
  res.json({ status: 'ok', db: dbOk, ts: Date.now() });
});

// ── Catch-all: serve the app with injected DB-load guarantee ─────────────────
const fs = require('fs');
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    // Inject missing load() function if absent, and guarantee DB load on startup
    const loadFn = html.includes('function load()') ? '' : [
      'function load(){',
      '  try{var d=localStorage.getItem("e_v3")||localStorage.getItem("elysian_v2");',
      '  if(d){var p=JSON.parse(d);S.apts=p.apts||[];S.bks=p.bks||[];S.exps=p.exps||[];',
      '  S.meta=p.meta||{};S.revenue=p.revenue||{cleaning:{},mgmt:{}};S.daily=p.daily||{snapshots:{},tasks:[]};}}catch(e){}',
      '  if(S.bks&&S.bks.length)_dataInitialized=true;',
      '  if(typeof applyDefaults==="function")applyDefaults();',
      '}'
    ].join('\n');

    const injected = '<script>\n' + loadFn + '\n' +
      '(function(){var _r=0;function _go(){' +
      'if(typeof S==="undefined"||typeof loadFromDb!=="function"){if(_r++<30)setTimeout(_go,300);return;}' +
      'if(S.bks&&S.bks.length>0)return;' +
      '(async function(){try{var cfg=await fetch("/api/server-config").then(function(r){return r.json();});' +
      'if(cfg.hasDatabase){_dbAvailable=true;_dataInitialized=false;await loadFromDb();' +
      'if(typeof renderDash==="function")renderDash();' +
      'if(typeof renderCfg==="function")renderCfg();' +
      'if(typeof renderBk==="function")renderBk();' +
      'if(typeof renderExp==="function")renderExp();' +
      'if(typeof updBkBadge==="function")updBkBadge();' +
      'if(typeof startDbPoll==="function")startDbPoll();' +
      '}}catch(e){console.error("[init]",e.message);}})();}' +
      'setTimeout(_go,800);})();' +
      '\n<\/script>';

    html = html.replace('</body>', injected + '\n</body>');res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});


// ── Sync cancelled bookings (non-refundable) ────────────────────────────────
app.post('/api/sync-cancelled', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const apiKey = SERVER_API_KEY || req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'No API key' });

  try {
    // Fetch only cancelled events from Hosthub
    const evs = await fetchPages(`${BASE}/calendar-events?is_visible=false`, apiKey).catch(()=>[]);

    // Keep only those with financial value (owner keeps the money)
    // guest_paid is { cents: 6200, currency: "EUR" } format
    const centsToEur = v => v && typeof v === 'object' ? (v.cents||0)/100 : parseFloat(v||0);
    const paid = evs.filter(e => {
      const t = (e.type||'').toLowerCase();
      if (t.includes('hold') || t.includes('block')) return false;
      const gross = centsToEur(e.guest_paid) || centsToEur(e.booking_value) ||
                    centsToEur(e.total_booking_value) || parseFloat(e.total_price||0);
      return gross > 0;
    });

    if (!paid.length) return res.json({ added: 0, message: 'No cancelled-but-paid bookings found' });

    // Load existing data
    const cur = await pool.query("SELECT data FROM app_data WHERE key='main'");
    const current = cur.rows[0]?.data || {};
    // Remove ALL existing cancelled bookings — replace with fresh real data from Hosthub
    const nonCancelled = (current.bks||[]).filter(b => !b.cancelled);
    const existingIds = new Set(); // empty — always re-add all paid cancelled bookings
    const currentApts = current.apts || [];

    // Build apt name lookup
    const aptByName = {};
    currentApts.forEach(a => { if (a.name) aptByName[a.name.trim().toLowerCase()] = a; });

    const fmtDate = iso => {
      if (!iso || iso.includes('/')) return iso;
      const p = iso.split('-');
      return p.length===3 ? parseInt(p[2])+'/'+parseInt(p[1])+'/'+p[0] : iso;
    };

    const CODE = {airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',
      expedia:'Expedia',vrbo:'VRBO',direct:'Direct',directbooking:'Direct',hosthub:'Direct'};

    const newBks = paid
      .filter(e => !existingIds.has(e.id))
      .map(e => {
        const aptName = e.rental_unit?.name||e.rental?.name||'';
        const apt = aptByName[aptName.trim().toLowerCase()];
        const d = e.date_from ? new Date(e.date_from+'T00:00:00') : new Date();
        const gross  = (e.guest_paid?.cents || 0) / 100;
        const svc    = (e.service_fee_host?.cents  || 0) / 100;
        const pchg   = (e.payment_charges?.cents   || 0) / 100;
        const payout = (e.total_payout?.cents      || 0) / 100;
        const bkv    = gross - svc - pchg;
        const code = (e.source?.channel_type_code||'').toLowerCase().replace(/[^a-z]/g,'');
        const srcName = (e.source?.name||'').toLowerCase();
        const CODE = {airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',expedia:'Expedia',vrbo:'VRBO',direct:'Direct',directbooking:'Direct',hosthub:'Direct'};
        const platform = CODE[code]||(srcName.includes('airbnb')?'Airbnb':srcName.includes('booking')?'Booking.com':'Direct');
        return { id:e.id, aptId:apt?.id||'', aptName, cancelled:true, cancelledAt:e.cancelled_at||null,
          platform, guestName:e.guest_name||e.title||'',
          guests:e.guest_number||null, checkIn:fmtDate(e.date_from), checkOut:fmtDate(e.date_to),
          nights:e.nights||0, gross, mo:d.getMonth(), yr:d.getFullYear(),
          bkv, svc, pchg, payout, ct:0, vat:0, at:0 };
      });

    if (!newBks.length) return res.json({ added: 0, message: 'All cancelled bookings already in DB' });

    const merged = { ...current, bks: [...nonCancelled, ...newBks] };
    await pool.query(
      `INSERT INTO app_data (key,data) VALUES ($1,$2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data=$2::jsonb, updated_at=NOW()`,
      ['main', JSON.stringify(merged)]
    );

    res.json({ added: newBks.length, bookings: newBks.map(b=>({ guest:b.guestName, apt:b.aptName, checkIn:b.checkIn, checkOut:b.checkOut, gross:b.gross })) });
  } catch(e) {
    console.error('[sync-cancelled]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Debug: inspect raw cancelled events from Hosthub ────────────────────────
app.post('/api/debug-checkin', async (req, res) => {
  const apiKey = SERVER_API_KEY || req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'No API key' });
  const propertyNames = req.body?.propertyNames || [];
  const targetDate = req.body?.date; // 'YYYY-MM-DD'
  try {
    const evs = await fetchPages(`${BASE}/calendar-events?is_visible=true`, apiKey).catch(()=>[]);
    const matches = evs.filter(e => {
      const rentalName = (e.rental_unit?.name || e.rental?.name || '').toLowerCase();
      const nameMatch = propertyNames.some(n => rentalName.includes(n.toLowerCase()));
      if (!nameMatch) return false;
      if (targetDate) {
        return e.date_from === targetDate || e.date_to === targetDate ||
               (e.date_from <= targetDate && e.date_to >= targetDate);
      }
      return true;
    });
    res.json({
      total: evs.length,
      matchCount: matches.length,
      matches: matches.map(e => ({
        id: e.id, rental: e.rental_unit?.name || e.rental?.name,
        guest: e.guest_name, date_from: e.date_from, date_to: e.date_to,
        type: e.type, updated: e.updated, created: e.created,
      })),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/debug-cancelled', async (req, res) => {
  const apiKey = SERVER_API_KEY || req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'No API key' });
  try {
    const evs = await fetchPages(`${BASE}/calendar-events?is_visible=false`, apiKey).catch(()=>[]);
    // Return first 5 raw events with all financial fields
    // Find first paid cancelled event
    const paidEvs = evs.filter(e => (e.guest_paid?.cents||0) > 0 || (e.booking_value?.cents||0) > 0);
    const firstPaid = paidEvs[0];

    // Fetch the same event from per-rental endpoint to compare fields
    let perRentalEvent = null;
    if (firstPaid?.rental?.id) {
      const perRental = await fetchPages(
        `${BASE}/rentals/${firstPaid.rental.id}/calendar-events?is_visible=false`, apiKey
      ).catch(()=>[]);
      perRentalEvent = perRental.find(e => e.id === firstPaid.id);
    }

    const sample = paidEvs.slice(0,3).map(e => ({
      id: e.id, guest: e.guest_name, rental: e.rental?.name||e.rental_unit?.name,
      guest_paid:             e.guest_paid,
      service_fee_host:       e.service_fee_host,
      service_fee_host_base:  e.service_fee_host_base,
      service_fee_host_vat:   e.service_fee_host_vat,
      payment_charges:        e.payment_charges,
      total_payout:           e.total_payout,
      taxes:                  e.taxes,
      cancellation_fee:       e.cancellation_fee,
    }));
    res.json({
      total: evs.length,
      paidCount: paidEvs.length,
      globalEventKeys: firstPaid ? Object.keys(firstPaid) : [],
      perRentalEventKeys: perRentalEvent ? Object.keys(perRentalEvent) : ['not fetched'],
      globalSample: sample,
      perRentalComparison: perRentalEvent || null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✓  Elysian Clearing  →  http://localhost:${PORT}`);
  console.log(`  ✓  Hosthub base URL  →  ${BASE}`);
  console.log(`  ✓  Server API key    →  ${SERVER_API_KEY ? 'SET (team mode)' : 'not set — enter in app'}`);
  console.log(`  ✓  Password          →  ${APP_PASSWORD ? 'enabled' : 'disabled'}`);
  console.log(`  ✓  Database          →  ${pool ? 'connected (PostgreSQL)' : 'local mode (no DATABASE_URL)'}\n`);
});
