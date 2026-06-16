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

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
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
  console.log('  ⚠  DATABASE_URL not set — running in local mode (no shared DB)');
  console.log('     Set DATABASE_URL to enable shared team database.');
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

// ── /api/discover — server liveness + optional key check ─────────────────────
app.get('/api/discover', async (req, res) => {
  const key = SERVER_API_KEY || req.query.api_key || req.headers['x-api-key'] || '';
  let hosthubOk = false;
  if (key) {
    try {
      const r = await fetch(`${BASE}/users`, { headers: hhH(key) });
      hosthubOk = r.ok;
    } catch(e) {}
  }
  res.json({
    server:   'elysian-clearing',
    version:  '2.0',
    db:       !!pool,
    hosthub:  hosthubOk,
    keyHint:  key ? key.slice(0,8)+'…' : null,
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
app.post('/api/db/data', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured.' });
  try {
    const payload = req.body;
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
    const result = await pool.query("SELECT updated_at FROM app_data WHERE key = 'main'");
    res.json({ db: true, updatedAt: result.rows[0]?.updated_at || null });
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
app.post('/api/sync', async (req, res) => {
  const { apiKey: clientKey } = req.body;
  const apiKey = SERVER_API_KEY || clientKey || '';
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  const log  = (msg, type='info') => { try { res.write(JSON.stringify({ type, msg }) + '\n'); } catch(e) {} };
  const done = (payload)          => { try { res.write(JSON.stringify({ type:'done', ...payload }) + '\n'); res.end(); } catch(e) {} };

  // 1. Verify key
  log('Verifying API key…');
  try {
    const r = await fetch(`${BASE}/users`, { headers: hhH(apiKey) });
    if (r.status === 401) { log('API key rejected (401).', 'error'); return done({ rentals:[], bookings:[], error:true }); }
    if (!r.ok)            { log(`Unexpected ${r.status} from /users`, 'error'); return done({ rentals:[], bookings:[], error:true }); }
    const u = (await r.json())?.data?.[0];
    log(`Authenticated: ${u?.name || '?'} (${u?.email || '?'})`, 'ok');
  } catch(e) {
    log(`Network error: ${e.message}`, 'error');
    return done({ rentals:[], bookings:[], error:true });
  }

  // 2. Rentals
  log('Fetching properties…');
  const rentals = await fetchPages(`${BASE}/rentals`, apiKey).catch(() => []);
  const rName = {}; for (const r of rentals) rName[r.id] = r.name;
  log(`${rentals.length} properties loaded`, 'ok');

  // 3. Calendar events
  log('Fetching all bookings…');
  const allEvents = []; const seen = new Set();
  const addEvents = (evs) => { for (const e of evs) { if (!seen.has(e.id)) { seen.add(e.id); allEvents.push(e); } } };

  const globalEvs = await fetchPages(`${BASE}/calendar-events?is_visible=all`, apiKey,
    (total, pageLen, page) => { if (pageLen > 0) log(`  Global page ${page}: +${pageLen} (${total} total)`); }
  ).catch(() => []);
  addEvents(globalEvs);
  log(`  Global: ${allEvents.length} events`);

  log(`  Per-rental fetch for ${rentals.length} properties…`);
  for (const rental of rentals) {
    const evs = await fetchPages(`${BASE}/rentals/${rental.id}/calendar-events?is_visible=all`, apiKey).catch(() => []);
    const before = allEvents.length; addEvents(evs);
    const added = allEvents.length - before;
    if (added > 0) log(`  ${rental.name}: +${added}`);
  }

  const bookingEvs = allEvents.filter(e => {
    const t = (e.type || '').toLowerCase();
    return !t.includes('hold') && !t.includes('block') && e.is_visible !== false;
  });
  log(`${allEvents.length} total events → ${bookingEvs.length} active bookings`, 'ok');

  // 4. Greek taxes
  log(`Fetching Greek taxes for ${bookingEvs.length} bookings…`, 'warn');
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
    if (fetched % 100 === 0 || fetched === bookingEvs.length) {
      const pct = Math.round(fetched / bookingEvs.length * 100);
      log(`  ${fetched}/${bookingEvs.length} (${pct}%) — ${Object.keys(grTaxMap).length} with tax data`);
    }
  }
  log(`Greek taxes loaded for ${Object.keys(grTaxMap).length}/${bookingEvs.length} bookings`, 'ok');

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
    return {
      id:ev.id, aptId:'',
      aptName: ev.rental_unit?.name||ev.rental?.name||rName[ev.rental?.id]||'',
      platform: (()=>{
        const code=(ev.source?.channel_type_code||'').toLowerCase().replace(/[^a-z]/g,'');
        const n=(ev.source?.name||'').toLowerCase();
        const CODE={airbnb:'Airbnb',bookingcom:'Booking.com',booking:'Booking.com',expedia:'Expedia',vrbo:'VRBO',homeaway:'VRBO',tripadvisor:'TripAdvisor',directbooking:'Direct',direct:'Direct',hosthub:'Direct'};
        if(CODE[code]) return CODE[code];
        if(n.includes('airbnb')) return 'Airbnb';
        if(n.includes('booking')) return 'Booking.com';
        if(n.includes('expedia')) return 'Expedia';
        if(n.includes('vrbo')||n.includes('homeaway')) return 'VRBO';
        return ev.source?.name||code||'Direct';
      })(),
      guestName:ev.guest_name||ev.title||'', checkIn:ev.date_from||'', checkOut:ev.date_to||'', nights:ev.nights||0,
      bkv, cleanH:clf, othr:otf, taxTot:tax, gross, svc, pchg, platFee:svc+pchg, payout:pay,
      ct, bvPrevat:bvpv, vat, at, nbv:nbv||(gross-ct-vat-at), trHost:ct+vat+at, trChan:0, thHost:0,
      mo:d.getMonth(), yr:d.getFullYear(),
    };
  });

  log(`Sync complete — ${rentals.length} properties, ${bookings.length} bookings`, 'ok');
  done({ rentals, bookings });
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

// ── Catch-all: serve the app ──────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  ✓  Elysian Clearing  →  http://localhost:${PORT}`);
  console.log(`  ✓  Hosthub base URL  →  ${BASE}`);
  console.log(`  ✓  Server API key    →  ${SERVER_API_KEY ? 'SET (team mode)' : 'not set — enter in app'}`);
  console.log(`  ✓  Password          →  ${APP_PASSWORD ? 'enabled' : 'disabled'}`);
  console.log(`  ✓  Database          →  ${pool ? 'connected (PostgreSQL)' : 'local mode (no DATABASE_URL)'}\n`);
});
