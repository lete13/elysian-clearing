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
 *   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
 *                     Owner-report e-mail (see 📧 section below)
 *   EMAIL_FROM / EMAIL_REPLY_TO / EMAIL_BCC   optional e-mail extras
 */

const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Frontend bootstrap (build v10) ───────────────────────────────────────────
// index.html is too large to push through the GitHub connector, so frontend
// releases ship as fe/patches.json: an ordered list of exact string
// replacements applied to the repo's index.html at boot (all-or-nothing,
// sha256-verified). If patches are absent, empty, or fail verification, the
// repo's index.html serves unchanged. GET /api/fe-info reports what is live.
// Consolidation: when patches accumulate, upload a fresh full index.html via
// GitHub web and reset patches.json to {"patches": []} in the same release.
const FE_INFO = { source: 'repo-file', patches: 0, bytes: 0, sha256: '', builtAt: '', error: '' };
(function feBootstrap() {
  const fsB = require('fs'), crypto = require('crypto');
  const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
  try {
    const idx = path.join(__dirname, 'index.html');
    const orig = fsB.readFileSync(idx, 'utf8');
    FE_INFO.bytes = Buffer.byteLength(orig);
    FE_INFO.sha256 = sha256(orig);
    const pf = path.join(__dirname, 'fe', 'patches.json');
    if (!fsB.existsSync(pf)) { console.log('  FE: no fe/patches.json — serving repo index.html as-is'); return; }
    const spec = JSON.parse(fsB.readFileSync(pf, 'utf8'));
    const ops = spec.patches || [];
    if (!ops.length) { console.log('  FE: fe/patches.json empty — serving repo index.html as-is'); return; }
    if (spec.baseSha256 && spec.baseSha256 !== FE_INFO.sha256) {
      throw new Error('base drifted: repo index.html sha256 ' + FE_INFO.sha256.slice(0, 12) + '… ≠ patch base ' + String(spec.baseSha256).slice(0, 12) + '… (a fresh full upload probably landed — reset patches.json to {"patches":[]})');
    }
    let html = orig;
    ops.forEach((p, i) => {
      const n = html.split(p.find).length - 1;
      const want = p.count || 1;
      if (n !== want) throw new Error('patch #' + (i + 1) + (p.note ? ' (' + p.note + ')' : '') + ': anchor found ' + n + 'x, expected ' + want + 'x');
      html = html.split(p.find).join(p.replace);
    });
    const sha = sha256(html);
    if (spec.expectedSha256 && spec.expectedSha256 !== sha) {
      throw new Error('patched result sha256 ' + sha.slice(0, 12) + '… ≠ expected ' + String(spec.expectedSha256).slice(0, 12) + '…');
    }
    fsB.writeFileSync(idx, html);
    Object.assign(FE_INFO, { source: 'repo-file+patches', patches: ops.length, bytes: Buffer.byteLength(html), sha256: sha, builtAt: spec.builtAt || '' });
    console.log('  FE: applied ' + ops.length + ' patch(es) to index.html (' + FE_INFO.bytes + ' bytes, sha256 ' + sha.slice(0, 12) + '…)');
  } catch (e) {
    FE_INFO.source = 'repo-file (patches FAILED)';
    FE_INFO.error = e.message;
    console.error('  FE: patch apply FAILED — serving repo index.html unpatched. ' + e.message);
  }
})();

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

  // Create tables on first run
  pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key         VARCHAR(50) PRIMARY KEY,
      data        JSONB       NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `).then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS proof_files (
      id          SERIAL PRIMARY KEY,
      month       VARCHAR(7)  NOT NULL,
      task_key    VARCHAR(60) NOT NULL,
      apt_id      TEXT        NOT NULL,
      apt_name    TEXT,
      filename    TEXT,
      mime        TEXT,
      size        INTEGER,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      data        TEXT        NOT NULL
    );
  `)).then(() => pool.query(
    `CREATE INDEX IF NOT EXISTS idx_proofs_month ON proof_files (month);`
  )).then(() => {
    _proofTableReady = true;
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
    if (req.path === '/health' || req.path === '/api/fe-info') return next();
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

// GET /api/history — rolling per-property daily snapshots for trend detection
app.get('/api/history', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await pool.query("SELECT data FROM app_data WHERE key = 'history'");
    res.json(Array.isArray(r.rows[0]?.data) ? r.rows[0].data : []);
  } catch (e) {
    console.error('[history] read error:', e.message);
    res.json([]);
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

      // ANTI-WIPE MONTHLY TASKS (proof-of-completion audit trail must survive
      // "Clear data" and stale clients that don't know about these keys)
      const dbMt = existing.monthlyTasks && typeof existing.monthlyTasks === 'object' ? Object.keys(existing.monthlyTasks).length : 0;
      const inMt = payload.monthlyTasks  && typeof payload.monthlyTasks  === 'object' ? Object.keys(payload.monthlyTasks).length  : 0;
      if (dbMt > 0 && inMt === 0) payload.monthlyTasks = existing.monthlyTasks;
      // Custom task definitions: restore only when the key is missing entirely
      // (stale client). An explicit empty array is a deliberate deletion.
      if (payload.monthlyTaskDefs === undefined && Array.isArray(existing.monthlyTaskDefs) && existing.monthlyTaskDefs.length)
        payload.monthlyTaskDefs = existing.monthlyTaskDefs;

      // ANTI-WIPE PAYMENTS CHECK (Viva reconciliation ticks — must survive
      // "Clear data" and stale clients that don't know about this key)
      const dbPc = existing.payChk && existing.payChk.marks && typeof existing.payChk.marks === 'object' ? Object.keys(existing.payChk.marks).length : 0;
      const inPc = payload.payChk  && payload.payChk.marks  && typeof payload.payChk.marks  === 'object' ? Object.keys(payload.payChk.marks).length  : 0;
      if (dbPc > 0 && inPc === 0) payload.payChk = existing.payChk;
    }

    await pool.query(
      `INSERT INTO app_data (key, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      ['main', JSON.stringify(payload)]
    );
    const ts = await pool.query("SELECT updated_at FROM app_data WHERE key = 'main'");
    // Also capture a trend snapshot from the saved data (covers manual refresh).
    if (Array.isArray(payload.bks) && payload.bks.length) {
      await saveSnapshot(pool, payload.bks, payload.apts || []);
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// MONTHLY-TASK PROOF ATTACHMENTS
// Evidence files (PDF / images) for the Monthly Accounting Tasks tab, stored in
// PostgreSQL so the manager can open them from any browser. Falls back to
// in-memory storage when no database is configured (lost on restart).
// ─────────────────────────────────────────────────────────────────────────────
const _memProofs = new Map();   // no-DB fallback
let   _memProofSeq = 1;
const PROOF_MAX_B64 = 30 * 1024 * 1024; // ~22 MB raw file

// Self-healing table creation: if the server booted before the database was
// reachable (fresh deploy, DB add-on restart), the startup DDL never ran.
// Each proofs endpoint re-ensures the table exists (no-op after first success).
let _proofTableReady = false;
async function ensureProofTable() {
  if (_proofTableReady || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proof_files (
      id          SERIAL PRIMARY KEY,
      month       VARCHAR(7)  NOT NULL,
      task_key    VARCHAR(60) NOT NULL,
      apt_id      TEXT        NOT NULL,
      apt_name    TEXT,
      filename    TEXT,
      mime        TEXT,
      size        INTEGER,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      data        TEXT        NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proofs_month ON proof_files (month);`);
  _proofTableReady = true;
}

// POST /api/proofs — upload one proof {month, task, aptId, aptName, name, mime, size, by, dataB64}
app.post('/api/proofs', async (req, res) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(b.month || ''))      return res.status(400).json({ error: 'Invalid month (YYYY-MM expected)' });
  if (!b.task || !b.aptId)                       return res.status(400).json({ error: 'Missing task / aptId' });
  if (!b.dataB64 || typeof b.dataB64 !== 'string') return res.status(400).json({ error: 'Missing file data' });
  if (b.dataB64.length > PROOF_MAX_B64)          return res.status(413).json({ error: 'File too large' });
  const meta = {
    month: b.month, task_key: String(b.task).slice(0, 60), apt_id: String(b.aptId),
    apt_name: b.aptName || '', filename: b.name || 'proof', mime: b.mime || 'application/octet-stream',
    size: parseInt(b.size) || null, uploaded_by: b.by || '',
  };
  if (pool) {
    try {
      await ensureProofTable();
      const r = await pool.query(
        `INSERT INTO proof_files (month, task_key, apt_id, apt_name, filename, mime, size, uploaded_by, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, uploaded_at`,
        [meta.month, meta.task_key, meta.apt_id, meta.apt_name, meta.filename, meta.mime, meta.size, meta.uploaded_by, b.dataB64]
      );
      return res.json({ ok: true, db: true, id: r.rows[0].id, uploadedAt: r.rows[0].uploaded_at });
    } catch (e) {
      console.error('[proofs] write error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  const id = 'm' + _memProofSeq++;
  _memProofs.set(id, { ...meta, id, uploaded_at: new Date().toISOString(), data: b.dataB64 });
  res.json({ ok: true, db: false, id });
});

// GET /api/proofs?month=YYYY-MM — list proof metadata (no file data)
app.get('/api/proofs', async (req, res) => {
  const month = req.query.month || '';
  if (pool) {
    try {
      await ensureProofTable();
      const r = month
        ? await pool.query(`SELECT id, month, task_key, apt_id, apt_name, filename, mime, size, uploaded_by, uploaded_at FROM proof_files WHERE month = $1 ORDER BY uploaded_at`, [month])
        : await pool.query(`SELECT id, month, task_key, apt_id, apt_name, filename, mime, size, uploaded_by, uploaded_at FROM proof_files ORDER BY uploaded_at`);
      return res.json({ db: true, proofs: r.rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const list = [..._memProofs.values()].filter(p => !month || p.month === month)
    .map(({ data, ...m }) => m);
  res.json({ db: false, proofs: list });
});

// GET /api/proofs/:id — stream the file for viewing / download
app.get('/api/proofs/:id', async (req, res) => {
  const id = req.params.id;
  let row = null;
  if (pool && /^\d+$/.test(id)) {
    try {
      await ensureProofTable();
      const r = await pool.query(`SELECT filename, mime, data FROM proof_files WHERE id = $1`, [parseInt(id)]);
      row = r.rows[0] || null;
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (!row && _memProofs.has(id)) row = _memProofs.get(id);
  if (!row) return res.status(404).send('Proof not found — it may have been deleted.');
  try {
    const buf = Buffer.from(row.data, 'base64');
    const safeName = encodeURIComponent(row.filename || 'proof');
    res.set('Content-Type', row.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${safeName}`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/proofs/:id
app.delete('/api/proofs/:id', async (req, res) => {
  const id = req.params.id;
  if (pool && /^\d+$/.test(id)) {
    try { await ensureProofTable(); await pool.query(`DELETE FROM proof_files WHERE id = $1`, [parseInt(id)]); return res.json({ ok: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  _memProofs.delete(id);
  res.json({ ok: true });
});

// ── AI schedule check (Daily Ops) ─────────────────────────────────────────────
// POST /api/ops/schedule-check  { dataB64, mime, date, expected:[{name,sameDay}] }
// Sends the cleaning-schedule photo plus the day's checkout list to the
// Anthropic API and returns which checkouts are missing from the photo.
// Stateless — nothing is stored. Requires ANTHROPIC_API_KEY (Railway → Variables).
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY || '';
const SCHEDULE_CHECK_MODEL = process.env.SCHEDULE_CHECK_MODEL || 'claude-sonnet-4-6';
const SCHED_MAX_B64        = 15 * 1024 * 1024; // ~11 MB raw image

app.post('/api/ops/schedule-check', async (req, res) => {
  const b = req.body || {};
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set on the server (Railway → Variables).' });
  if (!b.dataB64 || typeof b.dataB64 !== 'string') return res.status(400).json({ error: 'Missing image data' });
  if (b.dataB64.length > SCHED_MAX_B64) return res.status(413).json({ error: 'Image too large — retake the photo at lower resolution' });
  const expected = Array.isArray(b.expected) ? b.expected.filter(e => e && e.name).slice(0, 80) : [];
  if (!expected.length) return res.status(400).json({ error: 'No expected checkouts supplied' });

  const list = expected.map((e, i) => `${i}. ${String(e.name).slice(0, 120)}`).join('\n');
  const prompt = [
    `This photo/screenshot is a housekeeping schedule ("πρόγραμμα") for ${String(b.date || 'today').slice(0, 20)}. Row labels may be in Greek or English, abbreviated, or slightly different from the official names.`,
    `Here are the apartments that CHECK OUT that day (index. name):\n${list}`,
    `First carefully read every row visible in the schedule (do this silently — never include the transcription in your reply). Then match each indexed apartment against those rows. Treat a row as a match if it clearly refers to the same property, even with different wording, extra address text, abbreviations, or partial names.`,
    `CRITICAL: several listed apartments may share the same base name and differ ONLY in a trailing number (e.g. "Votsala 1", "Votsala 2", "Votsala 6" are different units). Read those digits with extra care and match each number to the apartment with the same number. A single schedule row can also cover MORE THAN ONE listed apartment (e.g. "ΒΟΤΣΑΛΑ 1 & 2" or "Votsala 1-2" covers both units) — in that case include every covered index in "found". If a digit or row is hard to read, still make your best match and mention the uncertainty in "notes".`,
    `Rows like laundry ("ΠΛΥΝΤΗΡΙΟ"), linen transfer ("ΜΕΤΑΦΟΡΑ ΙΜΑΤΙΣΜΟΥ") or preparation-only lines are not checkouts.`,
    `Your ENTIRE reply must be ONLY one JSON object — no explanation, no transcription, no markdown fences, no text before or after it. Exactly this shape:`,
    `{"found":[indices],"missing":[indices],"extra_rows":["schedule row text that matches none of the listed apartments (excluding laundry/transfer/prep lines)"],"notes":"one short sentence only if something is unreadable or ambiguous, otherwise an empty string"}`,
  ].join('\n\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: SCHEDULE_CHECK_MODEL,
        max_tokens: 2500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: b.mime || 'image/jpeg', data: b.dataB64 } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `Anthropic API ${r.status}: ${(d && d.error && d.error.message) || 'request failed'}` });
    const txt = ((d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') || '').replace(/```json|```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {
      const m = txt.match(/\{[\s\S]*\}/);   // salvage: first '{' through last '}'
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!parsed || typeof parsed !== 'object') {
      console.error('[sched-check] unparseable AI response (' + txt.length + ' chars): ' + txt.slice(0, 500));
      return res.status(502).json({ error: 'Could not parse the AI response — try again', raw: txt.slice(0, 400) });
    }
    const idx = a => (Array.isArray(a) ? a : []).map(n => parseInt(n)).filter(n => Number.isInteger(n) && n >= 0 && n < expected.length);
    const foundIdx = idx(parsed.found);
    const foundSet = new Set(foundIdx);
    const missing  = [];
    expected.forEach((e, i) => { if (!foundSet.has(i)) missing.push({ name: e.name, sameDay: !!e.sameDay }); });
    console.log(`[sched-check] ${b.date || ''} expected:${expected.length} found:${foundIdx.length} missing:${missing.length}`);
    res.json({
      ok: true, model: SCHEDULE_CHECK_MODEL,
      found: foundIdx.map(i => expected[i].name),
      missing,
      extraRows: (Array.isArray(parsed.extra_rows) ? parsed.extra_rows : []).slice(0, 30).map(x => String(x).slice(0, 160)),
      notes: String(parsed.notes || '').slice(0, 300),
    });
  } catch (e) {
    console.error('[sched-check] error:', e.message);
    res.status(500).json({ error: e.message });
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

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT HISTORY (for trend / deterioration detection)
// Stores one compact dated snapshot per property per day in app_data key='history'.
// Rolling window (HISTORY_MAX_DAYS) so it never grows unbounded.
// ─────────────────────────────────────────────────────────────────────────────
const HISTORY_MAX_DAYS = 60;

function snapParseD(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00`);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Owner/maintenance blocks are excluded from snapshots (same rule as the
// Performance tab client math) so trend baselines stay comparable.
const SNAP_BLOCK_NAMES = ['maintenance','owner block','block','owner stay','ιδιοκτητης','ιδιοχρηση'];
function snapIsBlock(b) { return SNAP_BLOCK_NAMES.includes(String(b.guestName||'').toLowerCase().trim()); }

function snapBookedNights(bks, start, end) {
  const nights = new Set();
  for (const b of bks) {
    if (b.cancelled || snapIsBlock(b)) continue;
    const ci = snapParseD(b.checkIn), co = snapParseD(b.checkOut);
    if (!ci || !co) continue;
    let night = new Date(ci);
    while (night < co) {
      if (night >= start && night < end) {
        nights.add(night.getFullYear() * 10000 + night.getMonth() * 100 + night.getDate());
      }
      night.setDate(night.getDate() + 1);
    }
  }
  return nights.size;
}

function snapAvgAdr(bks, start, end) {
  const vals = [];
  for (const b of bks) {
    if (b.cancelled || snapIsBlock(b)) continue;
    const ci = snapParseD(b.checkIn);
    if (!ci || ci < start || ci >= end) continue;
    const nights = parseInt(b.nights) || 1;
    const total = (typeof b.payout === 'number' && b.payout) ? b.payout
                : (typeof b.gross === 'number' ? b.gross : null);
    if (total != null && nights) vals.push(total / nights);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100;
}

function buildSnapshot(bookings, rentals) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const ahead = (n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d; };
  const byApt = {};
  for (const b of bookings) {
    const key = b.aptId || b.aptName || '—';
    (byApt[key] = byApt[key] || []).push(b);
  }
  const list = (rentals && rentals.length)
    ? rentals.map(r => ({ id: r.id, name: r.name }))
    : Object.keys(byApt).map(k => ({ id: k, name: k }));
  const dateStr = t.toISOString().slice(0, 10);
  const props = list.map(apt => {
    const _byId = byApt[apt.id] || [], _byName = (apt.name && apt.name !== apt.id) ? (byApt[apt.name] || []) : [];
    const set = _byId.concat(_byName);
    return {
      id: apt.id,
      occ7:  +(snapBookedNights(set, t, ahead(7)) / 7).toFixed(4),
      occ14: +(snapBookedNights(set, t, ahead(14)) / 14).toFixed(4),
      occ30: +(snapBookedNights(set, t, ahead(30)) / 30).toFixed(4),
      bn30:  snapBookedNights(set, t, ahead(30)),
      adr30: snapAvgAdr(set, ahead(-30), t),
    };
  });
  return { date: dateStr, props };
}

async function saveSnapshot(pool, bookings, rentals) {
  if (!pool) return;
  try {
    const snap = buildSnapshot(bookings, rentals);
    const existing = await pool.query("SELECT data FROM app_data WHERE key = 'history'").catch(() => ({ rows: [] }));
    let hist = existing.rows[0]?.data;
    if (!Array.isArray(hist)) hist = [];
    hist = hist.filter(s => s.date !== snap.date);   // last sync of the day wins
    hist.push(snap);
    hist.sort((a, b) => a.date.localeCompare(b.date));
    if (hist.length > HISTORY_MAX_DAYS) hist = hist.slice(hist.length - HISTORY_MAX_DAYS);
    await pool.query(
      `INSERT INTO app_data (key, data) VALUES ('history', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(hist)]
    );
    console.log(`[snapshot] saved ${snap.props.length} props for ${snap.date} (history: ${hist.length} days)`);
  } catch (e) {
    console.error('[snapshot] save error:', e.message);
  }
}

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
    // Cancelled booking: only include if there is financial value (owner keeps some payment).
    // NOTE: Hosthub money fields are { cents, currency } objects — parseFloat() on them
    // returns NaN, which silently dropped ALL cancelled bookings from this pipeline and
    // forced the (now removed) separate cancelled-sync workarounds that stored taxes as 0.
    const money = v => (v && typeof v === 'object') ? (v.cents || 0) / 100 : (parseFloat(v || 0) || 0);
    // Require actual GUEST-payment evidence (not booking_value): cancelled manual/direct
    // calendar entries (owner blocks, "extend" placeholders, offline bookings) carry a
    // booking_value but guest_paid = 0 — those are not retained revenue and must be dropped.
    const gross = money(e.total_price) || money(e.guest_paid) || money(e.total_reservation_price);
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
      created:ev.created||null, createdOnChannel:ev.created_on_channel||null,
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
    const loc = {
      city: r.city || null,
      lat: r.latitude != null ? parseFloat(r.latitude) : null,
      lng: r.longitude != null ? parseFloat(r.longitude) : null,
    };
    if (key && !byName[key]) {
      byName[key] = { id: r.id, name: r.name.trim(), ...loc };
    } else if (key && byName[key]) {
      // Normalize the name and refresh location fields from Hosthub
      byName[key].name = byName[key].name.trim();
      if (loc.city && !byName[key].city) byName[key].city = loc.city;
      if (loc.lat != null && byName[key].lat == null) byName[key].lat = loc.lat;
      if (loc.lng != null && byName[key].lng == null) byName[key].lng = loc.lng;
    }
  });
  return Object.values(byName).filter(a => a.name);
}

// ── Auto-sync scheduler (every 15 minutes: :00, :15, :30, :45) ───────────────
// The next run is scheduled only AFTER the current sync finishes, so a slow
// Hosthub sync can never overlap with itself — it simply lands on the next
// quarter-hour mark.
function scheduleAutoSync() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setSeconds(0, 0);
  nextRun.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15);   // rolls over hour/day automatically

  const msUntil = nextRun - now;
  const mLeft   = Math.floor(msUntil / 60000);
  const sLeft   = Math.round((msUntil % 60000) / 1000);

  console.log(`  ✓  Auto-sync scheduled → ${nextRun.toISOString()} (in ${mLeft}m ${sLeft}s)`);

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
        // Cancelled-but-paid bookings now flow through runSync's main pipeline
        // (with the full gr-taxes pass), so no separate cancelled merge is needed.
        const cancelledCount = result.bookings.filter(b => b.cancelled).length;
        if (cancelledCount) onLog(`  including ${cancelledCount} cancelled-but-paid booking(s) with tax data`);

        const merged   = {
          ...current,
          bks:  result.bookings,
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
        await saveSnapshot(pool, result.bookings, result.rentals);
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

// ── Deploy verification: which frontend build is live ────────────────────────
// Auth-exempt (leaks only a hash + byte count) so deploys can be verified
// without credentials: GET /api/fe-info
app.get('/api/fe-info', (req, res) => {
  res.json({ build: VIVA_BUILD, fe: FE_INFO, ts: Date.now() });
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


// ── Sync cancelled bookings — DEPRECATED ────────────────────────────────────
// Cancelled-but-paid bookings are now included in the main /api/sync pipeline,
// where they receive full Greek tax data (VAT, accommodation tax, climate tax)
// from the calendar-event-gr-taxes pass, exactly like active bookings.
// This route is kept as a no-op so older cached frontends don't hit a 404.
app.post('/api/sync-cancelled', async (req, res) => {
  res.json({ added: 0, message: 'Cancelled bookings are now included in the main sync with full tax data — run a normal sync instead.' });
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

// ═══════════════════════════════════════════════════════════════════════════════
// 📧 OWNER REPORT E-MAIL — sends clearing reports with the PDF attached
// ═══════════════════════════════════════════════════════════════════════════════
// The Reports tab renders the PDF client-side and POSTs it here together with an
// HTML body (page-1 preview + logo embedded as inline cid images). Sending uses
// plain SMTP via nodemailer, so it works with Google Workspace (app password),
// the domain host's mailbox, or any other provider.
//
// Credentials live ONLY in Railway environment variables:
//   SMTP_HOST / SMTP_PORT       e.g. smtp.gmail.com / 587 (default 587)
//   SMTP_SECURE                 'true' for implicit TLS on :465 (default false)
//   SMTP_USER / SMTP_PASS       mailbox login (Google: use an App Password)
//   EMAIL_FROM                  display From, e.g. "Elysian Properties <info@…>"
//                               (defaults to SMTP_USER)
//   EMAIL_REPLY_TO              optional Reply-To address
//   EMAIL_BCC                   optional — auto-BCC every send (keeps a copy)
//
// GET  /api/email/status  → { configured, from, host }   (behind app password)
// POST /api/email/send    → { ok, messageId } | { error } (behind app password)

let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch (e) { console.log('  EMAIL: nodemailer not installed — /api/email/send disabled until npm install runs'); }

const EMAIL = {
  host:    process.env.SMTP_HOST || '',
  port:    parseInt(process.env.SMTP_PORT || '587', 10),
  secure:  String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  user:    process.env.SMTP_USER || '',
  pass:    process.env.SMTP_PASS || '',
  from:    process.env.EMAIL_FROM || process.env.SMTP_USER || '',
  replyTo: process.env.EMAIL_REPLY_TO || '',
  bcc:     process.env.EMAIL_BCC || '',
};
const emailConfigured  = () => !!(nodemailer && EMAIL.host && EMAIL.user && EMAIL.pass);
const EMAIL_MAX_BYTES  = 20 * 1024 * 1024;   // total decoded attachment budget per send
const emailAddrOk      = s => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s || '').trim());
const emailSplitAddrs  = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);

if (emailConfigured()) console.log('  EMAIL: configured — ' + EMAIL.host + ':' + EMAIL.port + ' as ' + EMAIL.user);
else console.log('  EMAIL: not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS in Railway → Variables)');

app.get('/api/email/status', (req, res) => {
  res.json({ configured: emailConfigured(), from: EMAIL.from, host: EMAIL.host });
});

app.post('/api/email/send', async (req, res) => {
  try {
    if (!emailConfigured()) return res.status(503).json({ error: 'Email is not configured on the server (set SMTP_HOST / SMTP_USER / SMTP_PASS in Railway → Variables)' });
    const b  = req.body || {};
    const to = emailSplitAddrs(b.to), cc = emailSplitAddrs(b.cc);
    if (!to.length)         return res.status(400).json({ error: 'No recipient' });
    const bad = [...to, ...cc].filter(a => !emailAddrOk(a));
    if (bad.length)         return res.status(400).json({ error: 'Invalid address: ' + bad.join(', ') });
    if (!b.subject)         return res.status(400).json({ error: 'No subject' });
    if (!b.html && !b.text) return res.status(400).json({ error: 'Empty message' });

    const atts   = Array.isArray(b.attachments) ? b.attachments : [];
    const inline = Array.isArray(b.inline)      ? b.inline      : [];
    let bytes = 0;
    const mailAtts = [];
    for (const a of atts) {
      if (!a || !a.contentBase64 || !a.filename) return res.status(400).json({ error: 'Malformed attachment' });
      const buf = Buffer.from(a.contentBase64, 'base64'); bytes += buf.length;
      mailAtts.push({ filename: String(a.filename).replace(/[\r\n"]/g, ''), content: buf, contentType: a.contentType || 'application/octet-stream' });
    }
    for (const i of inline) {
      if (!i || !i.contentBase64 || !i.cid) continue;
      const buf = Buffer.from(i.contentBase64, 'base64'); bytes += buf.length;
      mailAtts.push({ filename: i.cid + (i.contentType === 'image/png' ? '.png' : '.jpg'), content: buf, contentType: i.contentType || 'image/jpeg', cid: i.cid, contentDisposition: 'inline' });
    }
    if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: 'Attachments too large (' + Math.round(bytes / 1048576) + ' MB > 20 MB)' });

    const transporter = nodemailer.createTransport({
      host: EMAIL.host, port: EMAIL.port, secure: EMAIL.secure,
      auth: { user: EMAIL.user, pass: EMAIL.pass },
    });
    const info = await transporter.sendMail({
      from: EMAIL.from,
      to: to.join(', '),
      cc: cc.length ? cc.join(', ') : undefined,
      bcc: EMAIL.bcc || undefined,
      replyTo: EMAIL.replyTo || undefined,
      subject: String(b.subject).slice(0, 300),
      text: b.text || undefined,
      html: b.html || undefined,
      attachments: mailAtts,
    });
    console.log('[email] sent "' + String(b.subject).slice(0, 80) + '" → ' + to.join(', ') + ' (' + Math.round(bytes / 1024) + ' KB, id ' + (info.messageId || '?') + ')');
    res.json({ ok: true, messageId: info.messageId || '' });
  } catch (e) {
    console.error('[email] send FAILED:', e.message);
    res.status(502).json({ error: 'Send failed: ' + e.message });
  }
});

// Diagnostic: which SMTP ports are reachable from Railway's network, and does a
// real login work? GET /api/email/probe (behind the app password). Safe: never
// returns the password; only connectivity + the server's own error messages.
app.get('/api/email/probe', async (req, res) => {
  const net = require('net');
  const host = req.query.host || EMAIL.host || 'localhost';
  const tryPort = port => new Promise(resolve => {
    const started = Date.now();
    const sock = net.connect({ host, port, timeout: 6000 });
    const done = result => { try { sock.destroy(); } catch (e) {} resolve({ port, ...result, ms: Date.now() - started }); };
    sock.once('connect', () => done({ open: true }));
    sock.once('timeout', () => done({ open: false, error: 'timeout' }));
    sock.once('error', e => done({ open: false, error: e.code || e.message }));
  });
  const ports = await Promise.all([25, 465, 587, 2525].map(tryPort));
  let verify = 'skipped (not configured)';
  if (emailConfigured()) {
    try {
      const transporter = nodemailer.createTransport({
        host: EMAIL.host, port: EMAIL.port, secure: EMAIL.secure,
        auth: { user: EMAIL.user, pass: EMAIL.pass },
        connectionTimeout: 8000, greetingTimeout: 8000,
      });
      await transporter.verify();
      verify = 'OK — connection + login succeeded with the current variables';
    } catch (e) { verify = 'FAILED: ' + e.message; }
  }
  res.json({ host, configuredPort: EMAIL.port, secure: EMAIL.secure, user: EMAIL.user ? EMAIL.user.replace(/^(..).*(@.*)$/, '$1…$2') : '', ports, verify });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ==== OXYGEN PELATOLOGIO — diagnostics (status + sandbox test-issue) ====
// Env: OXYGEN_API_KEY (from Oxygen support) · OXYGEN_API_BASE (defaults to the
// SANDBOX — switching to production is a deliberate, later change).
// GET /api/oxygen/status      → key check + contacts/sequences/taxes/payment lookups
// GET /api/oxygen/test-issue  → issues ONE test receipt, SANDBOX ONLY (403 otherwise)
//   query overrides for iteration: ?contact_id= &tax_id= &seq= &doc=rs|s &ctype=1 &pm= &mdt=

const OXY = {
  key:  process.env.OXYGEN_API_KEY || '',
  base: (process.env.OXYGEN_API_BASE || 'https://sandbox-api.oxygen.gr/v1').replace(/\/+$/, ''),
};
const oxySandbox = () => OXY.base.indexOf('sandbox') !== -1;
async function oxyFetch(path, opts) {
  const o = opts || {};
  const r = await fetch(OXY.base + path, {
    method: o.method || 'GET',
    body: o.body,
    headers: Object.assign({ Authorization: 'Bearer ' + OXY.key, Accept: 'application/json', 'Content-Type': 'application/json' }, o.headers || {}),
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, body: j };
}
const oxyArr = b => Array.isArray(b) ? b : ((b && (b.data || b.items)) || []);

app.get('/api/oxygen/status', async (req, res) => {
  if (!OXY.key) return res.json({ configured: false, hint: 'set OXYGEN_API_KEY in Railway → Variables' });
  const out = { configured: true, base: OXY.base, sandbox: oxySandbox() };
  const probes = [['contacts', '/contacts'], ['sequences', '/numbering-sequences'], ['taxes', '/taxes'], ['paymentMethods', '/payment-methods']];
  for (const pair of probes) {
    const name = pair[0];
    const r = await oxyFetch(pair[1]);
    if (!r.ok) { out[name] = 'HTTP ' + r.status + ' ' + JSON.stringify(r.body || {}).slice(0, 200); continue; }
    const arr = oxyArr(r.body);
    out[name + 'Count'] = arr.length;
    out[name] = arr.slice(0, 12).map(x => ({
      id: x.id,
      name: x.name || x.title || x.description || x.nickname || [x.company_name, x.surname].filter(Boolean).join(' ') || undefined,
      rate: (x.rate !== undefined ? x.rate : (x.percentage !== undefined ? x.percentage : x.value)),
    }));
    if (arr.length) out[name + 'Sample'] = arr[0];
  }
  res.json(out);
});

app.get('/api/oxygen/test-issue', async (req, res) => {
  try {
    if (!OXY.key) return res.status(503).json({ error: 'OXYGEN_API_KEY not set' });
    if (!oxySandbox()) return res.status(403).json({ error: 'test-issue is SANDBOX-only — refusing on ' + OXY.base });
    const q = req.query || {};

    // 1) test contact: ?contact_id, else find "ELYSIAN-TEST", else create it
    let contactId = q.contact_id || '';
    let contactNote = 'from query';
    if (!contactId) {
      const list = await oxyFetch('/contacts');
      const t = oxyArr(list.body).find(c => (c.nickname || '') === 'ELYSIAN-TEST');
      if (t) { contactId = t.id; contactNote = 'found existing ELYSIAN-TEST'; }
      else {
        const made = await oxyFetch('/contacts', { method: 'POST', body: JSON.stringify({
          type: parseInt(q.ctype || '1', 10), is_client: true, is_supplier: false,
          name: 'Test', surname: 'Owner', nickname: 'ELYSIAN-TEST', country: 'GR',
        }) });
        if (!made.ok) return res.status(502).json({ step: 'create-contact', status: made.status, body: made.body });
        const c = (made.body && (made.body.data || made.body)) || {};
        contactId = c.id; contactNote = 'created ELYSIAN-TEST';
      }
    }

    // 2) 24% VAT tax id: ?tax_id, else pick from /taxes
    let taxId = q.tax_id || '';
    if (!taxId) {
      const taxes = await oxyFetch('/taxes');
      const arr = oxyArr(taxes.body);
      const t24 = arr.find(t => parseFloat(t.rate !== undefined ? t.rate : (t.percentage !== undefined ? t.percentage : t.value)) === 24);
      if (!t24) return res.status(422).json({ step: 'find-tax-24', hint: 'no 24% tax found — pass ?tax_id=', taxes: arr.slice(0, 10) });
      taxId = t24.id;
    }

    // 2b) payment method: ?pm=, else first from /payment-methods
    let pmId = q.pm || '';
    if (!pmId) {
      const pms = await oxyFetch('/payment-methods');
      const arr = oxyArr(pms.body);
      if (!arr.length) return res.status(422).json({ step: 'find-payment-method', hint: 'no payment methods — pass ?pm=' });
      pmId = arr[0].id;
    }

    // 3) issue: agreed mapping — category1_3 everywhere; type + myDATA doc code per document
    const doc = q.doc === 's' ? 's' : 'rs';
    const cls = { mydata_classification_category: 'category1_3', mydata_classification_type: doc === 's' ? 'E3_561_001' : 'E3_561_003' };
    const line = (d, v) => Object.assign({ description: d, quantity: 1, unit_net_value: v, net_amount: v, vat_amount: Math.round(v * 24) / 100, tax_id: taxId }, cls);
    const payload = {
      issue_date: new Date().toISOString().slice(0, 10),
      document_type: doc, mydata_document_type: q.mdt || (doc === 's' ? '2.1' : '11.2'),
      language: 'el', contact_id: contactId, payment_method_id: pmId, is_paid: false,
      comments: 'TEST — Elysian Clearing sandbox check (safe to ignore)',
      items: [line('Αμοιβή διαχείρισης (TEST)', 100), line('Καθαριότητα (TEST)', 40), line('Software (TEST)', 10)],
    };
    if (q.seq) payload.numbering_sequence_id = q.seq;
    const made = await oxyFetch('/invoices', { method: 'POST', body: JSON.stringify(payload) });
    if (!made.ok) return res.status(502).json({ step: 'create-invoice', status: made.status, sent: payload, body: made.body });
    const inv = (made.body && (made.body.data || made.body)) || {};
    console.log('[oxygen] SANDBOX test document issued: ' + (inv.sequence || '') + ' ' + (inv.number || '') + ' total ' + (inv.total_amount || '?'));
    res.json({ ok: true, sandbox: true, contact: { id: contactId, note: contactNote },
      invoice: { id: inv.id, sequence: inv.sequence, number: inv.number, document_type: inv.document_type,
                 net: inv.net_amount, vat: inv.vat_amount, total: inv.total_amount, mydata: inv.mydata } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OXYGEN PELATOLOGIO - issuing engine (clearing report -> owner legal document)
// Turns a locked clearing report's Elysian-charges block into the owner's legal
// document on Oxygen (with myDATA transmission), then hands the identifiers back
// so the client can stamp S.rptLocks[key].oxygen and write the trackers.
//
// Agreed mapping (spec 5 Aug 2026):
//   Private -> Receipt  (ΑΠΥ)  document_type 'rs'  myDATA doc 11.2  cls E3_561_003
//   B2B     -> Invoice  (ΤΠΥ)  document_type 's'   myDATA doc 2.1   cls E3_561_001
//   Leased  -> NO document (the rental agreement is the paperwork) - skipped
//  Every line: mydata_classification_category category1_3 + 24% VAT.
//  One line per charge; the cleaning line is present ONLY when the client sends
//  it (the per-apartment "cleaning uncharged but in the mgmt base" toggle
//  suppresses it upstream). Figures come from buildPdfDoc, so the engine ASSERTS
//  sum(line net) == the report's Elysian-charges total and refuses on any drift -
//  the invoice equals the report by construction, never by re-computation.
//
// Endpoints (all behind the same APP_PASSWORD as the whole app):
//  POST /api/oxygen/issue          -> issue (or return the already-issued doc)
//  POST /api/oxygen/issue-preview  -> dry-run: build + assert, NEVER posts
//  GET  /api/oxygen/documents      -> the issued-document ledger (audit trail)
//
// SAFETY: like test-issue, issuing runs freely on the SANDBOX. On a PRODUCTION
// base the call is refused unless it carries an explicit confirmLive:true (the
// "one-click confirm" of the agreed rollout ramp) - the code path is identical,
// production merely needs the deliberate acknowledgement. Idempotency is keyed on
// aptId+period+base: resending the owner e-mail can never double-issue or
// double-count. On sandbox only, force:true bypasses the ledger so you can
// re-test the same apartment/period while iterating.

// -- Static mapping (pure)
const OXY_MYDATA = {
  private: { doc: 'rs', mdt: '11.2', cls: 'E3_561_003', label: 'ΑΠΥ (Receipt)' },
  b2b:     { doc: 's',  mdt: '2.1',  cls: 'E3_561_001', label: 'ΤΠΥ (Invoice)' },
  leased:  null,  // no document - the rental agreement is the paperwork
};
// Forgiving profile normalisation -> one of the three keys above, or '' if unknown.
function oxyProfileKey(p) {
  const s = String(p == null ? '' : p).toLowerCase().trim();
  if (['private', 'privat', 'idiotis', 'ιδιώτης', 'ιδιωτης', 'apy', 'rs'].includes(s)) return 'private';
  if (['b2b', 'business', 'company', 'invoice', 'tpy', 's'].includes(s)) return 'b2b';
  if (['leased', 'lease', 'misthosi', 'μίσθωση', 'μισθωση', 'rental', 'none'].includes(s)) return 'leased';
  return '';
}
const oxyMoney = v => Math.round((Number(v) || 0) * 100) / 100;
const OXY_VAT = 24;

// -- Line + payload builders (pure - the golden tests hit these directly)
function oxyLine(description, net, taxId, cls) {
  const n = oxyMoney(net);
  return {
    description: String(description || '').slice(0, 300),
    quantity: 1,
    unit_net_value: n,
    net_amount: n,
    vat_amount: Math.round(n * OXY_VAT) / 100,  // 24% - matches test-issue exactly
    tax_id: taxId,
    mydata_classification_category: 'category1_3',
    mydata_classification_type: cls,
  };
}

// Validate the incoming charge lines against the report total. Returns
// { ok, sum, error }. This is the "invoice == report" guard.
function oxyValidateLines(lines, reportTotal) {
  if (!Array.isArray(lines) || !lines.length) return { ok: false, sum: 0, error: 'no charge lines supplied' };
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i] || {};
    const net = Number(L.net != null ? L.net : L.net_amount != null ? L.net_amount : L.unit_net_value);
    if (!L.description || !String(L.description).trim()) return { ok: false, sum, error: 'line ' + (i + 1) + ' has no description' };
    if (!isFinite(net) || net <= 0) return { ok: false, sum, error: 'line ' + (i + 1) + ' (' + L.description + ') has a non-positive net amount' };
    sum += net;
  }
  sum = oxyMoney(sum);
  if (reportTotal != null && isFinite(Number(reportTotal))) {
    const rt = oxyMoney(reportTotal);
    if (Math.abs(sum - rt) > 0.01)
      return { ok: false, sum, error: 'line total EUR ' + sum.toFixed(2) + ' != report Elysian-charges total EUR ' + rt.toFixed(2) + ' - refusing so the invoice can never diverge from the report' };
  }
  return { ok: true, sum, error: '' };
}

// Build the full Oxygen /invoices payload for one apartment's report, OR signal
// a skip for Leased. Pure - no network, no state. Returns { skip, reason } or
// { payload, map }.
function oxyBuildInvoice(opts) {
  const o = opts || {};
  const key = oxyProfileKey(o.profile);
  if (!key) return { error: 'unknown apartment profile "' + o.profile + '" - expected private | b2b | leased' };
  const map = OXY_MYDATA[key];
  if (map === null) return { skip: true, reason: 'leased' };  // no document

  if (!o.contactId) return { error: 'no Oxygen contact linked for this apartment - link it in Configuration (never guessed)' };
  if (!o.taxId) return { error: 'no 24% tax id resolved' };
  if (!o.pmId) return { error: 'no payment method resolved' };

  const items = (o.lines || []).map(L => oxyLine(
    L.description,
    (L.net != null ? L.net : L.net_amount != null ? L.net_amount : L.unit_net_value),
    o.taxId, map.cls,
  ));
  const payload = {
    issue_date: o.issueDate || new Date().toISOString().slice(0, 10),
    document_type: map.doc,
    mydata_document_type: map.mdt,
    language: (String(o.language || 'el').toLowerCase() === 'en') ? 'en' : 'el',
    contact_id: o.contactId,
    payment_method_id: o.pmId,
    is_paid: !!o.isPaid,
    comments: o.comments || '',
    items,
  };
  if (o.seq) payload.numbering_sequence_id = o.seq;
  return { payload, map, profileKey: key };
}

// -- Live wiring (network + Postgres ledger)
// Resolve the 24% tax id and a payment-method id once, then memoise. Env
// overrides win (OXYGEN_TAX24_ID / OXYGEN_PM_ID); per-request overrides win over
// those. Numbering sequences are per document type (ΑΠΥ vs ΤΠΥ) from env.
const _oxyLookups = { tax24: process.env.OXYGEN_TAX24_ID || '', pm: process.env.OXYGEN_PM_ID || '' };
const OXY_SEQ = { rs: process.env.OXYGEN_SEQ_RS || '', s: process.env.OXYGEN_SEQ_S || '' };
async function oxyResolveTax24() {
  if (_oxyLookups.tax24) return _oxyLookups.tax24;
  const r = await oxyFetch('/taxes');
  const t = oxyArr(r.body).find(x => parseFloat(x.rate !== undefined ? x.rate : (x.percentage !== undefined ? x.percentage : x.value)) === OXY_VAT);
  if (t) _oxyLookups.tax24 = t.id;
  return _oxyLookups.tax24;
}
async function oxyResolvePaymentMethod() {
  if (_oxyLookups.pm) return _oxyLookups.pm;
  const r = await oxyFetch('/payment-methods');
  const arr = oxyArr(r.body);
  if (arr.length) _oxyLookups.pm = arr[0].id;
  return _oxyLookups.pm;
}

// Issued-document ledger - the exactly-once guarantee + a permanent audit trail
// of every legal document the pipeline has issued. Self-heals its table like the
// proofs table does.
let _oxyDocTableReady = false;
async function oxyEnsureDocTable() {
  if (_oxyDocTableReady || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oxygen_documents (
      id           SERIAL PRIMARY KEY,
      apt_id       TEXT        NOT NULL,
      apt_name     TEXT,
      period       VARCHAR(7)  NOT NULL,
      base         TEXT        NOT NULL,
      sandbox      BOOLEAN     NOT NULL DEFAULT TRUE,
      profile      TEXT,
      document_type TEXT,
      invoice_id   TEXT,
      sequence     TEXT,
      number       TEXT,
      mark         TEXT,
      net          NUMERIC,
      vat          NUMERIC,
      total        NUMERIC,
      mydata       JSONB,
      issued_by    TEXT,
      issued_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oxydoc_key ON oxygen_documents (apt_id, period, base);`);
  _oxyDocTableReady = true;
}
function oxyLedgerRow(r) {
  if (!r) return null;
  return {
    aptId: r.apt_id, aptName: r.apt_name, period: r.period, sandbox: r.sandbox, profile: r.profile,
    documentType: r.document_type, invoiceId: r.invoice_id, sequence: r.sequence, number: r.number,
    mark: r.mark, net: r.net != null ? Number(r.net) : null, vat: r.vat != null ? Number(r.vat) : null,
    total: r.total != null ? Number(r.total) : null, mydata: r.mydata, issuedBy: r.issued_by, issuedAt: r.issued_at,
  };
}
async function oxyLedgerGet(aptId, period) {
  if (!pool) return null;
  await oxyEnsureDocTable();
  const r = await pool.query('SELECT * FROM oxygen_documents WHERE apt_id=$1 AND period=$2 AND base=$3', [String(aptId), String(period), OXY.base]);
  return oxyLedgerRow(r.rows[0]);
}
async function oxyLedgerPut(rec) {
  if (!pool) return;
  await oxyEnsureDocTable();
  await pool.query(
    `INSERT INTO oxygen_documents
       (apt_id, apt_name, period, base, sandbox, profile, document_type, invoice_id, sequence, number, mark, net, vat, total, mydata, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
     ON CONFLICT (apt_id, period, base) DO NOTHING`,
    [String(rec.aptId), rec.aptName || '', String(rec.period), OXY.base, oxySandbox(), rec.profile || '',
     rec.documentType || '', String(rec.invoiceId || ''), String(rec.sequence || ''), String(rec.number || ''),
     rec.mark || '', rec.net, rec.vat, rec.total, JSON.stringify(rec.mydata || null), rec.issuedBy || ''],
  );
}

// Shared setup for issue + preview: normalise body, resolve lookups, build the
// payload, run the equality guard. Returns { error, status } | { built, ctx }.
async function oxyPrepare(body) {
  const b = body || {};
  const aptId = String(b.aptId || b.apt_id || '').trim();
  const period = String(b.period || '').trim();
  if (!aptId) return { status: 400, error: 'missing aptId' };
  if (!/^\d{4}-\d{2}$/.test(period)) return { status: 400, error: 'missing/invalid period (YYYY-MM expected)' };

  const profileKey = oxyProfileKey(b.profile);
  if (!profileKey) return { status: 400, error: 'unknown apartment profile "' + b.profile + '" - expected private | b2b | leased' };
  if (profileKey === 'leased') return { built: { skip: true, reason: 'leased' }, ctx: { aptId, period, profileKey } };

  const lines = Array.isArray(b.lines) ? b.lines : [];
  const check = oxyValidateLines(lines, b.reportTotal);
  if (!check.ok) return { status: 422, error: check.error, sum: check.sum };

  const taxId = b.taxId || await oxyResolveTax24();
  if (!taxId) return { status: 422, error: 'could not resolve the 24% tax id - pass taxId or set OXYGEN_TAX24_ID' };
  const pmId = b.pmId || b.paymentMethodId || await oxyResolvePaymentMethod();
  if (!pmId) return { status: 422, error: 'could not resolve a payment method - pass pmId or set OXYGEN_PM_ID' };

  const map = OXY_MYDATA[profileKey];
  const seq = b.seq || OXY_SEQ[map.doc] || '';
  const built = oxyBuildInvoice({
    profile: profileKey, lines, language: b.language, contactId: b.contactId || b.contact_id,
    taxId, pmId, seq, isPaid: !!b.isPaid,
    issueDate: b.issueDate || new Date().toISOString().slice(0, 10),
    comments: b.comments != null ? b.comments : ('Elysian Properties - ' + period + (b.aptName ? ' - ' + b.aptName : '')),
  });
  if (built.error) return { status: 422, error: built.error };
  return { built, ctx: { aptId, aptName: b.aptName || '', period, profileKey, sum: check.sum } };
}

// POST /api/oxygen/issue-preview - build + assert, NEVER touches Oxygen.
app.post('/api/oxygen/issue-preview', async (req, res) => {
  try {
    if (!OXY.key) return res.status(503).json({ error: 'OXYGEN_API_KEY not set' });
    const prep = await oxyPrepare(req.body);
    if (prep.error) return res.status(prep.status || 400).json({ error: prep.error, sum: prep.sum });
    if (prep.built.skip) return res.json({ ok: true, skipped: true, reason: prep.built.reason, apt: prep.ctx.aptId, period: prep.ctx.period });
    res.json({ ok: true, preview: true, sandbox: oxySandbox(), base: OXY.base,
      apt: prep.ctx.aptId, period: prep.ctx.period, profile: prep.ctx.profileKey,
      document: prep.built.map.label, chargesTotal: prep.ctx.sum, payload: prep.built.payload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/oxygen/issue - issue the owner document (or return the already-issued
// one). Body: { aptId, aptName, period:'YYYY-MM', profile:'private|b2b|leased',
// contactId, language:'el|en', lines:[{description,net}], reportTotal,
// issueDate?, confirmLive?, force?, by?, taxId?, pmId?, seq? }
app.post('/api/oxygen/issue', async (req, res) => {
  try {
    if (!OXY.key) return res.status(503).json({ error: 'OXYGEN_API_KEY not set' });
    const b = req.body || {};

    const prep = await oxyPrepare(b);
    if (prep.error) return res.status(prep.status || 400).json({ error: prep.error, sum: prep.sum });

   // Leased -> no document. Uniform trigger chain: the client always calls
   // issue; the server decides to skip so the caller needs no profile branching.
    if (prep.built.skip) return res.json({ ok: true, skipped: true, reason: prep.built.reason, apt: prep.ctx.aptId, period: prep.ctx.period });

    const { aptId, aptName, period, profileKey, sum } = prep.ctx;

   // PRODUCTION guard - deliberate acknowledgement required off-sandbox.
    if (!oxySandbox() && b.confirmLive !== true)
      return res.status(403).json({ error: 'PRODUCTION base (' + OXY.base + '): refusing to issue a real legal document without confirmLive:true' });

   // Exactly-once. Sandbox may re-test with force:true; production never can.
    const force = b.force === true && oxySandbox();
    if (!force) {
      const existing = await oxyLedgerGet(aptId, period);
      if (existing && existing.invoiceId)
        return res.json({ ok: true, alreadyIssued: true, sandbox: oxySandbox(), apt: aptId, period, document: existing });
    }

   // Issue.
    const made = await oxyFetch('/invoices', { method: 'POST', body: JSON.stringify(prep.built.payload) });
    if (!made.ok) return res.status(502).json({ step: 'create-invoice', status: made.status, sent: prep.built.payload, body: made.body });
    const inv = (made.body && (made.body.data || made.body)) || {};
    const md = inv.mydata || {};

    const rec = {
      aptId, aptName, period, profile: profileKey, documentType: inv.document_type || prep.built.map.doc,
      invoiceId: inv.id, sequence: inv.sequence, number: inv.number,
      mark: md.mark || md.Mark || '', net: inv.net_amount, vat: inv.vat_amount, total: inv.total_amount,
      mydata: inv.mydata || null, issuedBy: b.by || '',
    };
    try { await oxyLedgerPut(rec); } catch (e) { console.error('[oxygen] ledger write failed (document WAS issued):', e.message); }

    console.log('[oxygen] ' + (oxySandbox() ? 'SANDBOX' : 'LIVE') + ' ' + prep.built.map.label + ' issued for ' + (aptName || aptId) + ' ' + period +
      ' -> ' + (inv.sequence || '') + ' ' + (inv.number || '') + ' total ' + (inv.total_amount != null ? inv.total_amount : '?') +
      (md.mark ? ' mark ' + md.mark : '') + (md.status ? ' [myDATA ' + md.status + ']' : ''));

    res.json({ ok: true, issued: true, sandbox: oxySandbox(), apt: aptId, period,
      document: { invoiceId: inv.id, sequence: inv.sequence, number: inv.number, documentType: inv.document_type,
                  net: inv.net_amount, vat: inv.vat_amount, total: inv.total_amount, mydata: inv.mydata } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/oxygen/documents?period=YYYY-MM - issued-document ledger (audit trail)
app.get('/api/oxygen/lookups', async (req, res) => {
  if (!OXY.key) return res.json({ configured: false });
  const out = { configured: true, base: OXY.base, sandbox: oxySandbox() };
  const disp = c => ([c.name, c.surname].filter(Boolean).join(' ') || c.company_name || c.nickname || c.email || ('#' + c.id));
  const grab = async (p, map) => { const r = await oxyFetch(p); if (!r.ok) return { error: 'HTTP ' + r.status }; return oxyArr(r.body).map(map); };
  out.contacts = await grab('/contacts', c => ({ id: c.id, name: disp(c), afm: c.vat_number || '', email: c.email || '' }));
  out.paymentMethods = await grab('/payment-methods', p => ({ id: p.id, title: p.title_gr || p.title_en || p.title || '', code: p.mydata_code || '' }));
  out.sequences = await grab('/numbering-sequences', s => ({ id: s.id, name: s.name || s.title || '', doc: s.document_type || '' }));
  res.json(out);
});

app.get('/api/oxygen/documents', async (req, res) => {
  if (!pool) return res.json({ db: false, documents: [] });
  try {
    await oxyEnsureDocTable();
    const period = req.query.period || '';
    const r = period
      ? await pool.query('SELECT * FROM oxygen_documents WHERE period=$1 ORDER BY issued_at DESC', [period])
      : await pool.query('SELECT * FROM oxygen_documents ORDER BY issued_at DESC LIMIT 500');
    res.json({ db: true, base: OXY.base, sandbox: oxySandbox(), documents: r.rows.map(oxyLedgerRow) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// -- Offline golden tests: node server.js --oxygen-selftest
// Asserts the agreed mapping and the invoice==report guard as PURE functions -
// no network, no database. Mirrors the Viva self-test.
function oxygenSelfTest() {
  let n = 0, fail = 0;
  const ok = (name, cond) => { n++; if (!cond) { fail++; console.log('  X -', name); } else console.log('  ok -', name); };

  // Profile -> document mapping
  const priv = oxyBuildInvoice({ profile: 'private', contactId: 'c1', taxId: 't24', pmId: 'pm1', language: 'el',
    lines: [{ description: 'Αμοιβή διαχείρισης', net: 100 }, { description: 'Καθαριότητα', net: 40 }, { description: 'Software', net: 10 }] });
  ok('Private -> document_type rs', priv.payload.document_type === 'rs');
  ok('Private -> myDATA doc 11.2', priv.payload.mydata_document_type === '11.2');
  ok('Private lines -> classification E3_561_003', priv.payload.items.every(i => i.mydata_classification_type === 'E3_561_003'));

  const b2b = oxyBuildInvoice({ profile: 'b2b', contactId: 'c2', taxId: 't24', pmId: 'pm1', language: 'en',
    lines: [{ description: 'Management fee', net: 200 }] });
  ok('B2B -> document_type s', b2b.payload.document_type === 's');
  ok('B2B -> myDATA doc 2.1', b2b.payload.mydata_document_type === '2.1');
  ok('B2B lines -> classification E3_561_001', b2b.payload.items.every(i => i.mydata_classification_type === 'E3_561_001'));
  ok('language passes through (en)', b2b.payload.language === 'en');

  // Leased -> no document
  const leased = oxyBuildInvoice({ profile: 'leased', contactId: 'c3', taxId: 't24', pmId: 'pm1', lines: [{ description: 'x', net: 1 }] });
  ok('Leased -> skip (no document)', leased.skip === true && leased.reason === 'leased');

  // Every line: category1_3 + 24% VAT, computed exactly like test-issue
  ok('every line category1_3', priv.payload.items.every(i => i.mydata_classification_category === 'category1_3'));
  ok('VAT = round(net*24)/100 (100->24.00)', priv.payload.items[0].vat_amount === 24);
  ok('VAT on 40 -> 9.60', priv.payload.items[1].vat_amount === 9.6);
  ok('net_amount == unit_net_value', priv.payload.items.every(i => i.net_amount === i.unit_net_value));
  ok('tax_id stamped on every line', priv.payload.items.every(i => i.tax_id === 't24'));

  // Invoice == report guard
  ok('lines summing to report total -> ok', oxyValidateLines([{ description: 'a', net: 100 }, { description: 'b', net: 40 }, { description: 'c', net: 10 }], 150).ok === true);
  ok('sub-cent drift tolerated (<= EUR 0.01)', oxyValidateLines([{ description: 'a', net: 100.004 }], 100).ok === true);
  const drift = oxyValidateLines([{ description: 'a', net: 100 }, { description: 'b', net: 40 }], 150);
  ok('dropped/short line -> REFUSED', drift.ok === false && /!=/.test(drift.error));
  const extra = oxyValidateLines([{ description: 'a', net: 100 }, { description: 'b', net: 40 }, { description: 'c', net: 10 }, { description: 'stray', net: 5 }], 150);
  ok('extra stray line -> REFUSED', extra.ok === false);
  ok('cleaning suppressed (2 lines) still == its own total', oxyValidateLines([{ description: 'mgmt', net: 100 }, { description: 'software', net: 10 }], 110).ok === true);
  ok('empty lines -> refused', oxyValidateLines([], 0).ok === false);
  ok('non-positive line -> refused', oxyValidateLines([{ description: 'a', net: 0 }], 0).ok === false);
  ok('no-description line -> refused', oxyValidateLines([{ net: 10 }], 10).ok === false);

  // Contact must be linked, never guessed
  const noContact = oxyBuildInvoice({ profile: 'private', taxId: 't24', pmId: 'pm1', lines: [{ description: 'a', net: 10 }] });
  ok('missing Oxygen contact -> error (never guessed)', !!noContact.error && /contact/i.test(noContact.error));

  // Unknown profile -> error
  ok('unknown profile -> error', !!oxyBuildInvoice({ profile: 'mystery', contactId: 'c', taxId: 't', pmId: 'p', lines: [{ description: 'a', net: 1 }] }).error);

  // Profile normalisation (forgiving)
  ok('profile alias "ιδιώτης" -> private', oxyProfileKey('Ιδιώτης') === 'private');
  ok('profile alias "business" -> b2b', oxyProfileKey('business') === 'b2b');
  ok('profile alias "μίσθωση" -> leased', oxyProfileKey('Μίσθωση') === 'leased');

  // Full example: invoice items mirror the report block byte-for-byte in value
  const rep = [{ description: 'Αμοιβή διαχείρισης', net: 87.5 }, { description: 'Καθαριότητα', net: 45 }, { description: 'Software', net: 12 }, { description: 'Έξοδο: Λαμπτήρες', net: 8.4 }];
  const repTotal = 152.9;
  const full = oxyBuildInvoice({ profile: 'private', contactId: 'c1', taxId: 't24', pmId: 'pm1', lines: rep });
  ok('one Oxygen line per report charge', full.payload.items.length === rep.length);
  ok('sum(line net) === report total', oxyMoney(full.payload.items.reduce((s, i) => s + i.net_amount, 0)) === repTotal);
  ok('validate agrees with report total', oxyValidateLines(rep, repTotal).ok === true);

  console.log(fail ? `\nX - ${fail}/${n} OXYGEN SELF-TESTS FAILED` : `\nok - ALL ${n} OXYGEN SELF-TESTS PASSED`);
  process.exit(fail ? 1 : 0);
}
if (process.argv.includes('--oxygen-selftest')) oxygenSelfTest();

// 🏦 VIVA BANK BRIDGE — automatic payout reconciliation for the Payments Check tab
// ═══════════════════════════════════════════════════════════════════════════════
// Pulls real account movements from the Viva Account Transactions API
// (POST /dataservices/v1/accounttransactions/Search, self-serve credentials from
// Viva → Settings → API Access → Account Transactions Credentials) and matches
// incoming Booking.com / Airbnb credits against the expected payouts computed by
// the Payments Check tab. Clean single-candidate matches are auto-ticked as
// received (by: "Viva auto-check"); everything ambiguous is left for a human.
// Runs automatically every SATURDAY 08:00 Europe/Athens, and on demand via the
// tab's "Check now" button (POST /api/viva/check-now).
//
// Credentials live ONLY in Railway environment variables:
//   VIVA_TX_USER / VIVA_TX_PASS   Account Transactions credentials
//   VIVA_ENV                      'live' (default) or 'demo'

const VIVA_TX_USER = (process.env.VIVA_TX_USER || '').trim();
const VIVA_TX_PASS = (process.env.VIVA_TX_PASS || '').trim();
const VIVA_ENV     = (process.env.VIVA_ENV || 'live').toLowerCase();
// Probe evidence (24 Jul 2026): www.vivapayments.com answers 406/hangs on
// /dataservices (it's the website gateway, not the API), while the OAuth token
// from accounts.vivapayments.com is issued fine. The API host is
// api.vivapayments.com. We keep a candidate list and self-heal: the first
// host+auth combination that answers 2xx is locked in for the session.
const VIVA_HOSTS = process.env.VIVA_BASE_URL
  ? [process.env.VIVA_BASE_URL]
  : (VIVA_ENV === 'demo'
      ? ['https://demo-api.vivapayments.com', 'https://demo.vivapayments.com']
      : ['https://api.vivapayments.com', 'https://www.vivapayments.com']);
const VIVA_BASE     = VIVA_HOSTS[0];   // kept for the probe endpoint
const VIVA_ACCOUNTS = process.env.VIVA_ACCOUNTS_URL || (VIVA_ENV === 'demo' ? 'https://demo-accounts.vivapayments.com' : 'https://accounts.vivapayments.com');
const VIVA_HTTP_TIMEOUT = 20000;   // per-request; a hung connection can never freeze the check
const vivaConfigured = () => !!(VIVA_TX_USER && VIVA_TX_PASS);
const VIVA_BUILD = 'v10';          // shown in /api/viva/status + error diags so we know which build is live
let _vivaWorking = null;           // { base, authMode } — locked in after first success
const _vivaDiag = { scope: '', claims: '', persons: 0, aud: '' };

// ── Viva API client ───────────────────────────────────────────────────────────
// Every request is logged ([viva] lines in the Railway deploy logs) and hard-
// capped at 20 s. Auth: tries Basic (as documented for Account Transactions
// credentials); on 401/403 falls back to an OAuth2 client-credentials bearer
// token from accounts.vivapayments.com — Viva's docs are ambiguous between the
// two, so we support both.
async function vivaHttp(url, opts) {
  const t0 = Date.now();
  const method = (opts && opts.method) || 'GET';
  try {
    const r = await fetch(url, {
      timeout: VIVA_HTTP_TIMEOUT,
      ...opts,
      headers: { 'User-Agent': 'ElysianClearing/1.0', Accept: 'application/json', ...((opts && opts.headers) || {}) },
    });
    console.log(`[viva] ${method} ${url.split('?')[0]} → ${r.status} in ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    const timedOut = e.type === 'request-timeout' || /timeout/i.test(e.message || '');
    console.error(`[viva] ${method} ${url.split('?')[0]} FAILED after ${Date.now() - t0}ms: ${e.message}`);
    throw new Error(timedOut
      ? `Viva did not respond within ${VIVA_HTTP_TIMEOUT / 1000}s (${url.split('?')[0]}) — endpoint unreachable or blocking the request.`
      : `Viva request failed: ${e.message}`);
  }
}

// Scopes required by the Account Transactions API (developer.viva.com, Account
// API reference): access tokens need urn:viva:payments:biservices:internalapi
// (identity tokens would use ...:publicapi). Tokens are cached per scope.
const VIVA_SCOPE_INT = 'urn:viva:payments:biservices:internalapi';
const VIVA_SCOPE_PUB = 'urn:viva:payments:biservices:publicapi';
const _vivaTokens = {};   // scope → { token, exp }
async function vivaBearer(scope) {
  const key = scope || '_none';
  const c = _vivaTokens[key];
  if (c && c.exp > Date.now()) return c.token;
  const r = await vivaHttp(VIVA_ACCOUNTS + '/connect/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${VIVA_TX_USER}:${VIVA_TX_PASS}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials' + (scope ? '&scope=' + encodeURIComponent(scope) : ''),
  });
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).slice(0, 160);
    throw new Error('token HTTP ' + r.status + (scope ? ' for scope ' + scope : '') + (t ? ' — ' + t : ''));
  }
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Viva OAuth token response contained no access_token' + (scope ? ' (scope ' + scope + ')' : '') + '.');
  _vivaTokens[key] = { token: d.access_token, exp: Date.now() + Math.max(60, (+d.expires_in || 3600) - 120) * 1000 };
  console.log('[viva] OAuth bearer token obtained' + (scope ? ' with scope ' + scope : '') + ' (expires in ' + (d.expires_in || 3600) + 's)');
  return _vivaTokens[key].token;
}

function vivaSearchPage(base, auth, page, pageSize, body, personId) {
  const url = `${base}/dataservices/v1/accounttransactions/Search?PageSize=${pageSize}&Page=${page}&OrderBy=Ascending`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  if (personId) headers.PersonId = personId;   // required for client-credential access tokens (Viva docs)
  return vivaHttp(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function vivaAuthHeader(mode, scope) {
  if (mode === 'basic') return 'Basic ' + Buffer.from(`${VIVA_TX_USER}:${VIVA_TX_PASS}`).toString('base64');
  return 'Bearer ' + await vivaBearer(scope);
}

// ── PersonId discovery ────────────────────────────────────────────────────────
// The Account Transactions API demands a PersonId header alongside access
// tokens. We never ask the user for it — we mine candidates from (a) the JWT
// claims of the token itself and (b) the wallets endpoint, then let the
// candidate loop find the one Viva accepts.
function vivaDecodeJwt(token) {
  try {
    const p = String(token).split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return {}; }
}
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function vivaPersonCandidates() {
  const out = [];
  const push = v => { v = String(v == null ? '' : v).trim(); if (v && !out.includes(v)) out.push(v); };
  // (a) claims of the unscoped access token
  try {
    const claims = vivaDecodeJwt(await vivaBearer(''));
    _vivaDiag.claims = Object.keys(claims).join(',');
    _vivaDiag.scope = Array.isArray(claims.scope) ? claims.scope.join(' ') : String(claims.scope || '');
    _vivaDiag.aud = Array.isArray(claims.aud) ? claims.aud.join(' ') : String(claims.aud || '');
    console.log('[viva] token claim keys: ' + _vivaDiag.claims);
    if (claims.scope) console.log('[viva] token scope: ' + JSON.stringify(claims.scope));
    // any claim whose KEY mentions "person" wins, whatever shape its value has —
    // Viva puts it in urn:viva:payments:client_person_id
    Object.keys(claims).forEach(k => { if (/person/i.test(k)) (Array.isArray(claims[k]) ? claims[k] : [claims[k]]).forEach(push); });
    ['personId', 'PersonId', 'person_id', 'viva_person_id', 'sub', 'client_sub', 'merchantId', 'merchant_id'].forEach(k => { if (claims[k]) push(claims[k]); });
    Object.values(claims).forEach(v => { if (typeof v === 'string' && GUID_RE.test(v)) push(v); });
  } catch (e) { console.log('[viva] no token for claim mining: ' + e.message); }
  // (b) the wallets endpoint sometimes reveals the owner id
  for (const mode of ['bearer', 'basic']) {
    try {
      const auth = await vivaAuthHeader(mode, '');
      const r = await vivaHttp(VIVA_HOSTS[0] + '/walletaccounts/v1/wallets', { method: 'GET', headers: { Authorization: auth } });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        JSON.stringify(d || {}).replace(/"(personId|person_id|ownerId|clientId)"\s*:\s*"([^"]+)"/gi, (m, k, v) => { push(v); return m; });
        console.log(`[viva] wallets endpoint (${mode}) responded — person candidates now: ${out.length}`);
        break;
      }
    } catch (e) { /* keep going */ }
  }
  return out.slice(0, 6);
}

async function vivaFetchTransactions(fromISO, toISO) {
  // Strategy 1: merchants/v1/wallets + dataservices v2 Search (scope-correct).
  const wFailures = [];
  const viaMerchants = await vivaMerchantsStrategy(fromISO, toISO, wFailures);
  if (viaMerchants) return viaMerchants;
  console.log('[viva] merchants strategy failed — falling back to dataservices v1');

  // Strategy 2: the documented /dataservices Search (needs the biservices scope).
  const body = { DateFrom: fromISO, DateTo: toISO, AmountFrom: 0.01 };   // credits only — debits can never match a payout
  const pageSize = 100;

  // Candidate combinations, most likely first. Per the Viva docs the Search
  // endpoint wants a bearer ACCESS token + a PersonId header — the PersonId
  // candidates are auto-discovered from the token claims / wallets endpoint.
  let candidates;
  if (_vivaWorking) candidates = [_vivaWorking];
  else {
    const persons = await vivaPersonCandidates();
    _vivaDiag.persons = persons.length;
    console.log(`[viva] trying ${persons.length} PersonId candidate(s)`);
    const api = VIVA_HOSTS[0];
    candidates = [
      ...persons.map(p => ({ base: api, authMode: 'bearer', scope: '', personId: p })),
      ...persons.slice(0, 2).map(p => ({ base: api, authMode: 'basic', scope: '', personId: p })),
      { base: api, authMode: 'bearer', scope: VIVA_SCOPE_INT, personId: '' },
      { base: api, authMode: 'bearer', scope: VIVA_SCOPE_PUB, personId: '' },
      { base: api, authMode: 'bearer', scope: '', personId: '' },
      { base: api, authMode: 'basic', scope: '', personId: '' },
      ...VIVA_HOSTS.slice(1).map(base => ({ base, authMode: 'bearer', scope: '', personId: '' })),
    ];
  }

  let combo = null, firstPage = null;
  const failures = [];
  for (const c of candidates) {
    const tag = `${c.base.replace('https://', '')} (${c.authMode}${c.scope ? '+' + c.scope.split(':').pop() : ''}${c.personId ? '+PersonId' : ''})`;
    let auth;
    try { auth = await vivaAuthHeader(c.authMode, c.scope); }
    catch (e) { failures.push(`${tag}: ${e.message}`); continue; }
    try {
      const r = await vivaSearchPage(c.base, auth, 1, pageSize, body, c.personId);
      if (r.ok) { combo = { ...c, auth }; firstPage = r; break; }
      failures.push(`${tag}: HTTP ${r.status}`);
    } catch (e) { failures.push(`${tag}: ${e.message}`); }
  }
  if (!combo) {
    _vivaWorking = null;
    const walletsOk = wFailures.includes('WALLETS_OK');
    const wList = wFailures.filter(f => f !== 'WALLETS_OK').slice(0, 10).join(' · ');
    throw new Error((walletsOk
      ? 'Your credentials ARE valid — the wallets endpoint works — but Viva has not enabled the Account Transactions data API for them. Viva\'s docs gate that API behind "specific access credentials — speak to your sales representative" (OAuth scope biservices/datafileapi). ASK YOUR VIVA ACCOUNT MANAGER to enable the Account Transactions API for these credentials; nothing further can be fixed in code. — '
      : 'No Viva combination worked — ')
      + 'MERCHANTS: ' + wList + ' — DATASERVICES v1: ' + failures.join(' · ')
      + ` [diag ${VIVA_BUILD}: tokenScope="${_vivaDiag.scope || 'NONE'}", aud="${_vivaDiag.aud || '?'}"]`);
  }
  if (!_vivaWorking) {
    console.log(`[viva] LOCKED IN: ${combo.base} + ${combo.authMode}${combo.scope ? ' (scope ' + combo.scope + ')' : ''}${combo.personId ? ' + PersonId header' : ''}`);
  }
  _vivaWorking = { base: combo.base, authMode: combo.authMode, scope: combo.scope, personId: combo.personId };

  const all = [];
  let r = firstPage;
  for (let page = 1; page <= 50; page++) {
    if (page > 1) r = await vivaSearchPage(combo.base, combo.auth, page, pageSize, body, combo.personId);
    if (!r.ok) {
      _vivaWorking = null;   // stop trusting the combo if it stops working
      const t = (await r.text().catch(() => '')).slice(0, 300);
      throw new Error(`Viva API ${r.status} on page ${page}${t ? ': ' + t : ''}`);
    }
    const d = await r.json().catch(() => null);
    const items = Array.isArray(d) ? d : (d && (d.items || d.data || d.results || d.transactions)) || [];
    all.push(...items);
    console.log(`[viva] page ${page}: ${items.length} tx (running total ${all.length})`);
    if (items.length < pageSize) break;
  }
  return all;
}

// Isolated connectivity test:  node server.js --viva-fetch-test
if (process.argv.includes('--viva-fetch-test')) {
  (async () => {
    try {
      const to = new Date(); const from = new Date(to.getTime() - 7 * 86400000);
      const txs = await vivaFetchTransactions(from.toISOString(), to.toISOString());
      console.log('VIVA FETCH OK —', txs.length, 'transactions in the last 7 days');
      process.exit(0);
    } catch (e) { console.error('VIVA FETCH FAILED —', e.message); process.exit(1); }
  })();
}

// Normalize to incoming credits only (amount > 0) — field names cover both the
// dataservices shape and the wallets-API transaction shape.
function vivaNormalizeCredits(raw) {
  return (raw || []).map(t => ({
    id: String(t.accountTransactionId || t.AccountTransactionId || t.TransactionId || t.transactionId || t.Id || t.id || ''),
    date: new Date(t.created || t.Created || t.InsDate || t.insDate || t.dateCreated || t.Date || t.date || 0),
    amount: Math.round(((t.amount != null ? +t.amount : +t.Amount) || 0) * 100) / 100,
    counterpart: String(t.counterPart || t.CounterPart || t.counterpart || t.userDescription || t.Description || t.description || ''),
    typeId: t.typeId != null ? t.typeId : t.TypeId, subTypeId: t.subTypeId != null ? t.subTypeId : t.SubTypeId,
    walletId: t.walletId != null ? t.walletId : t.WalletId,
  })).filter(t => t.id && t.amount > 0 && !isNaN(t.date));
}

// ── Merchants/wallets strategy (matches the token's actual scopes) ────────────
// Verified against the live Payment API reference (Retrieve Wallets and
// Transactions): GET /merchants/v1/wallets requires exactly the scopes these
// credentials carry (core:api:merchants + core:api:merchants:wallets), while
// POST /dataservices/v2/accounttransactions/Search is documented to need
// urn:viva:payments:biservices:datafileapi ("specific access credentials …
// speak to your sales representative"). We list wallets first (proves the
// credentials), then attempt the v2 Search with every token we can mint.
async function vivaMerchantsStrategy(fromISO, toISO, failures) {
  let bearerH;
  try { bearerH = 'Bearer ' + await vivaBearer(''); } catch (e) { failures.push('token: ' + e.message); return null; }
  const base = VIVA_HOSTS[0];

  // 1) Wallets — nice-to-have context, but NEVER gates the transactions search
  //    (after Viva granted datafileapi, the wallets scope was dropped from the
  //    credentials — the search must run standalone, account-wide).
  let ids = [];
  try {
    const r = await vivaHttp(base + '/merchants/v1/wallets', { method: 'GET', headers: { Authorization: bearerH } });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      const ws = Array.isArray(d) ? d : (d && (d.wallets || d.items || d.data)) || [];
      ids = ws.map(w => w.walletId != null ? w.walletId : w.WalletId).filter(x => x != null);
      failures.push('WALLETS_OK');
      console.log(`[viva] ✓ merchants/v1/wallets — ${ids.length} wallet(s)`);
    } else {
      failures.push(`merchants/v1/wallets: HTTP ${r.status} (not gating — continuing to the Search)`);
    }
  } catch (e) { failures.push('merchants/v1/wallets: ' + e.message); }

  // 2) Transactions — v2 Search, account-wide (WalletId only when known), paged
  //    until HTTP 204 per the reference
  const fmtV = v => new Date(v).toISOString().replace('T', ' ').replace('Z', ' +00:00');
  const body0 = { DateFrom: fmtV(fromISO), DateTo: fmtV(toISO) };
  const tokens = [{ tag: '', h: bearerH }];
  try { tokens.push({ tag: '+datafileapi', h: 'Bearer ' + await vivaBearer('urn:viva:payments:biservices:datafileapi') }); }
  catch (e) { failures.push('datafileapi scope: ' + e.message); }
  const bodies = ids.length ? ids.map(id => ({ ...body0, WalletId: id })) : [body0];
  for (const tk of tokens) {
    const all = [];
    let ok = true;
    for (const bd of bodies) {
      for (let page = 1; page <= 40; page++) {
        const url = `${base}/dataservices/v2/accounttransactions/Search?PageSize=500&Page=${page}&OrderBy=Ascending`;
        const r = await vivaHttp(url, { method: 'POST', headers: { Authorization: tk.h, 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });
        if (r.status === 204) break;
        if (!r.ok) {
          const bt = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
          failures.push(`v2 Search${tk.tag}: HTTP ${r.status}${bt ? ' — ' + bt : ''}`);
          ok = false; break;
        }
        const d = await r.json().catch(() => null);
        const items = Array.isArray(d) ? d : (d && (d.items || d.data || d.results || d.transactions)) || [];
        if (!items.length) break;
        all.push(...items);
        console.log(`[viva] v2 Search${tk.tag} page ${page}: ${items.length} tx`);
        if (items.length < 500) break;
      }
      if (!ok) break;
    }
    if (ok) { console.log(`[viva] ✓ v2 Search${tk.tag} — ${all.length} transactions`); return all; }
  }
  return null;
}

// ── (kept as historical fallback) old wallets-path prober ─────────────────────
async function vivaWalletStrategy(fromISO, toISO, failures) {
  const dFrom = String(fromISO).slice(0, 10), dTo = String(toISO).slice(0, 10);
  let bearer = null;
  try { bearer = { mode: 'bearer', h: 'Bearer ' + await vivaBearer('') }; } catch (e) { failures.push('token: ' + e.message); }
  const basic = { mode: 'basic', h: 'Basic ' + Buffer.from(`${VIVA_TX_USER}:${VIVA_TX_PASS}`).toString('base64') };
  const persons = await vivaPersonCandidates();

  // Attempt list, most promising first: the 403 on walletaccounts+bearer showed
  // the token authenticates there — PersonId-header variants lead the queue.
  const attempts = [];
  if (bearer) persons.forEach(p => attempts.push({ base: VIVA_HOSTS[0], a: bearer, lp: '/walletaccounts/v1/wallets', extra: { PersonId: p }, xtag: '+PersonId' }));
  for (const base of VIVA_HOSTS) for (const a of [bearer, basic].filter(Boolean)) for (const lp of ['/walletaccounts/v1/wallets', '/api/wallets'])
    attempts.push({ base, a, lp, extra: {}, xtag: '' });

  for (const at of attempts) {
    const tag = `${at.base.replace('https://', '')}${at.lp} (${at.a.mode}${at.xtag})`;
    let wallets;
    try {
      const r = await vivaHttp(at.base + at.lp, { method: 'GET', headers: { Authorization: at.a.h, ...at.extra } });
      if (!r.ok) {
        const bt = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
        failures.push(`${tag}: HTTP ${r.status}${bt ? ' — ' + bt : ''}`);
        continue;
      }
      const d = await r.json().catch(() => null);
      wallets = Array.isArray(d) ? d : (d && (d.wallets || d.Wallets || d.items || d.data)) || null;
      if (!wallets || !wallets.length) { failures.push(`${tag}: no wallets in response`); continue; }
    } catch (e) { failures.push(`${tag}: ${e.message}`); continue; }
    const ids = wallets.map(w => w.walletId != null ? w.walletId : (w.WalletId != null ? w.WalletId : (w.Id != null ? w.Id : w.id))).filter(x => x != null);
    console.log(`[viva] ${ids.length} wallet(s) found via ${tag}`);
    const txUrls = [
      id => `${at.base}${at.lp}/${id}/transactions?DateFrom=${dFrom}&DateTo=${dTo}`,
      id => `${at.base}/api/wallets/${id}/transactions?datefrom=${dFrom}&dateto=${dTo}`,
    ];
    for (const mk of txUrls) {
      const all = [];
      let ok = true;
      for (const id of ids) {
        try {
          const r2 = await vivaHttp(mk(id), { method: 'GET', headers: { Authorization: at.a.h, ...at.extra } });
          if (!r2.ok) {
            const bt2 = (await r2.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
            failures.push(`walletTx ${mk(id).split('?')[0].replace(at.base, '')}: HTTP ${r2.status}${bt2 ? ' — ' + bt2 : ''}`);
            ok = false; break;
          }
          const d2 = await r2.json().catch(() => null);
          const items = Array.isArray(d2) ? d2 : (d2 && (d2.transactions || d2.Transactions || d2.items || d2.data)) || [];
          all.push(...items);
        } catch (e) { failures.push('walletTx: ' + e.message); ok = false; break; }
      }
      if (ok) { console.log(`[viva] WALLET STRATEGY OK — ${all.length} transactions from ${ids.length} wallet(s)`); return all; }
    }
  }
  return null;
}

// ── Expectation engine (MUST mirror the client's Payments Check tab exactly —
//    mark keys are shared, so key construction must byte-match index.html) ─────
const VIVA_BLOCK_NAMES = ['maintenance', 'owner block', 'block', 'owner stay', 'ιδιοκτητης', 'ιδιοχρηση'];
const pcvDay0  = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const pcvISO   = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const pcvAdd   = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const pcvNormApt = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const pcvNormG   = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function pcvParseDMY(v) {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(v); return isNaN(d) ? null : pcvDay0(d);
}
function pcvThursday(d) { let delta = (4 - d.getDay() + 7) % 7; if (!delta) delta = 7; return pcvAdd(pcvDay0(d), delta); }
function pcvChan(b) {
  const ch = String(b.platform || b.channel || '').toLowerCase();
  if (ch.includes('airbnb')) return 'abb';
  if (ch.includes('booking')) return 'bdc';
  return null;
}
function pcvAmt(b) {
  const tc = Math.max(0, +b.trChan || 0);
  const p = +b.payout;
  const base = (isFinite(p) && p > 0) ? p : Math.max(0, (+b.gross || 0) - (+b.svc || 0) - (+b.pchg || 0));
  return Math.max(0, base - tc);
}

// Build the pool of UNMARKED expected credits up to `today` (never future ones).
function vivaExpectedUnits(data, today) {
  const t = pcvDay0(today || new Date());
  const payChk = (data && data.payChk) || {};
  const marks  = payChk.marks || {};
  const cfg    = payChk.cfg || {};
  const from   = /^\d{4}-\d{2}-\d{2}$/.test(cfg.from || '') ? new Date(cfg.from) : new Date(2026, 0, 1);
  const bdc = {};
  const units = [];
  for (const b of (data && data.bks) || []) {
    if (!b || b.cancelled) continue;
    if (VIVA_BLOCK_NAMES.includes(String(b.guestName || '').toLowerCase().trim())) continue;
    const chan = pcvChan(b);
    if (!chan) continue;
    const amt = pcvAmt(b);
    if (!(amt > 0)) continue;
    if (chan === 'bdc') {
      const co = pcvParseDMY(b.checkOut); if (!co) continue;
      const thu = pcvThursday(co);
      if (thu < from || thu > t) continue;
      const aptKey = pcvNormApt(b.aptName) || b.aptId || '?';
      const key = 'bdc|' + pcvISO(thu) + '|' + aptKey;
      const u = bdc[key] || (bdc[key] = { key, chan: 'bdc', date: thu, exp: 0, label: (b.aptName || '?') + ' — Thu ' + pcvISO(thu) });
      u.exp += amt;
    } else {
      const ci = pcvParseDMY(b.checkIn); if (!ci) continue;
      const rel = pcvAdd(ci, 1);
      if (rel < from || rel > t) continue;
      const aptKey = pcvNormApt(b.aptName) || b.aptId || '?';
      const key = 'abb|' + aptKey + '|' + pcvISO(ci) + '|' + pcvNormG(b.guestName);
      units.push({ key, chan: 'abb', date: rel, exp: amt, label: (b.aptName || '?') + ' — ' + (b.guestName || '—') + ' (release ' + pcvISO(rel) + ')' });
    }
  }
  Object.values(bdc).forEach(u => units.push(u));
  units.forEach(u => { u.exp = Math.round(u.exp * 100) / 100; });
  return units.filter(u => !marks[u.key]);
}

// ── Credit classification & matching ─────────────────────────────────────────
function vivaClassify(counterpart) {
  const c = String(counterpart || '').toLowerCase().trim();
  if (/airbnb/.test(c)) return 'abb';
  if (/booking/.test(c)) return 'bdc';
  // Viva's v2 Search stores the counterparty IBAN, not the name (verified on
  // live data 29 Jul 2026). The channels' payout accounts:
  //   Airbnb Payments  — Bank of America Dublin   → IE..BOFA...
  //   Booking.com B.V. — Citibank Netherlands     → NL..CITI...
  if (/^ie\d{2}bofa/.test(c)) return 'abb';
  if (/^nl\d{2}citi/.test(c)) return 'bdc';
  return null;   // unknown counterparties (card settlements, transfers…) are NEVER matched
}

// Single-candidate rule: a credit auto-matches only when exactly ONE unmatched
// expected unit of the same channel fits the date window and amount. Exact
// amounts (≤ €0.011) win over tolerance matches. Anything ambiguous is skipped.
function vivaMatch(units, credits, tol) {
  const pool = units.slice();
  const matches = [], unmatchedCredits = [];
  const sorted = credits.slice().sort((a, b) => a.date - b.date);
  for (const cr of sorted) {
    const chan = vivaClassify(cr.counterpart);
    if (!chan) continue;
    const cd = pcvDay0(cr.date);
    const inWindow = u => u.chan === chan && cd >= pcvAdd(u.date, -1) && cd <= pcvAdd(u.date, 10);
    const exact = pool.filter(u => inWindow(u) && Math.abs(u.exp - cr.amount) <= 0.011);
    const close = pool.filter(u => inWindow(u) && Math.abs(u.exp - cr.amount) <= tol);
    let pick = null, kind = '';
    if (exact.length === 1) { pick = exact[0]; kind = 'exact'; }
    else if (exact.length === 0 && close.length === 1) { pick = close[0]; kind = 'tolerance'; }
    if (pick) {
      pool.splice(pool.indexOf(pick), 1);
      matches.push({ unit: pick, credit: cr, kind, diff: Math.round((cr.amount - pick.exp) * 100) / 100 });
    } else {
      unmatchedCredits.push({ credit: cr, candidates: close.length });
    }
  }
  return { matches, unmatchedCredits, leftover: pool };
}

// ── The check itself (used by the Saturday cron AND the Check-now button) ─────
const VIVA_LOOKBACK_DAYS = 35;
async function vivaRunCheck(trigger) {
  if (!vivaConfigured()) throw new Error('Viva credentials not configured (VIVA_TX_USER / VIVA_TX_PASS).');
  if (!pool) throw new Error('No database configured.');
  const cur = await pool.query("SELECT data FROM app_data WHERE key = 'main'");
  const data = cur.rows[0] && cur.rows[0].data;
  if (!data || !Array.isArray(data.bks) || !data.bks.length) throw new Error('No bookings in the database yet.');

  const now = new Date();
  const today = pcvDay0(now);
  const from = pcvAdd(today, -VIVA_LOOKBACK_DAYS);
  const tol = (() => { const v = parseFloat((data.payChk && data.payChk.cfg && data.payChk.cfg.tol) ?? 1); return isFinite(v) && v >= 0 ? v : 1; })();

  const raw = await vivaFetchTransactions(from.toISOString(), now.toISOString());
  const creditsAll = vivaNormalizeCredits(raw);
  // never reuse a bank transaction that already ticked something
  const usedTx = new Set(Object.values((data.payChk && data.payChk.marks) || {}).map(m => m && m.txId).filter(Boolean));
  const credits = creditsAll.filter(c => !usedTx.has(c.id));
  const classified = credits.filter(c => vivaClassify(c.counterpart));

  const units = vivaExpectedUnits(data, today);
  const { matches, unmatchedCredits, leftover } = vivaMatch(units, credits, tol);

  // Auto-tick the clean matches
  const nowIso = now.toISOString();
  const newMarks = {};
  for (const m of matches) {
    newMarks[m.unit.key] = {
      at: nowIso, by: 'Viva auto-check', auto: true,
      exp: Math.round(m.unit.exp * 100) / 100,
      amt: Math.round(m.credit.amount * 100) / 100,
      txId: m.credit.id, txAt: m.credit.date.toISOString(),
    };
  }
  const missingExpected = leftover
    .filter(u => u.date <= pcvAdd(today, -3))
    .sort((a, b) => a.date - b.date)
    .slice(0, 25)
    .map(u => ({ key: u.key, label: u.label, date: pcvISO(u.date), exp: u.exp }));

  // Diagnostics: what do the credits we could NOT classify look like?
  const unclass = credits.filter(c => !vivaClassify(c.counterpart));
  const typeHisto = {};
  unclass.forEach(c => { const k = (c.typeId != null ? c.typeId : '?') + '/' + (c.subTypeId != null ? c.subTypeId : '?'); typeHisto[k] = (typeHisto[k] || 0) + 1; });

  const report = {
    ranAt: nowIso, trigger, env: VIVA_ENV,
    window: { from: pcvISO(from), to: pcvISO(today) },
    creditsSeen: creditsAll.length, creditsChannel: classified.length,
    unclassifiedTypes: typeHisto,
    sampleUnclassified: unclass.slice(0, 15).map(c => ({ date: pcvISO(pcvDay0(c.date)), amount: c.amount, counterpart: String(c.counterpart || '').slice(0, 40) || '(empty)', typeId: c.typeId, subTypeId: c.subTypeId })),
    matched: matches.length,
    autoTicked: matches.map(m => ({ key: m.unit.key, label: m.unit.label, exp: m.unit.exp, amt: m.credit.amount, diff: m.diff, kind: m.kind, txAt: pcvISO(pcvDay0(m.credit.date)), counterpart: m.credit.counterpart.slice(0, 60) })),
    unmatchedCredits: unmatchedCredits.slice(0, 25).map(x => ({ date: pcvISO(pcvDay0(x.credit.date)), counterpart: x.credit.counterpart.slice(0, 60), amount: x.credit.amount, candidates: x.candidates })),
    missingExpected,
  };

  // Merge-safe write: re-read fresh state, touch ONLY payChk.marks + payChk.bank
  const fresh = await pool.query("SELECT data FROM app_data WHERE key = 'main'");
  const fdata = (fresh.rows[0] && fresh.rows[0].data) || data;
  fdata.payChk = fdata.payChk && typeof fdata.payChk === 'object' ? fdata.payChk : { marks: {}, cfg: {} };
  fdata.payChk.marks = Object.assign({}, fdata.payChk.marks || {}, newMarks);
  fdata.payChk.bank = Object.assign({}, fdata.payChk.bank || {}, { lastResult: report });
  await pool.query(
    `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
    ['main', JSON.stringify(fdata)]
  );
  console.log(`[viva] ${trigger} check: ${creditsAll.length} credits seen, ${matches.length} auto-ticked, ${report.unmatchedCredits.length} unmatched, ${missingExpected.length} expected-missing`);
  return report;
}

// ── Endpoints (behind the same APP_PASSWORD protection as the whole app) ──────
app.get('/api/viva/status', (req, res) => {
  res.json({ configured: vivaConfigured(), env: VIVA_ENV, schedule: 'Saturday 08:00 Europe/Athens', build: VIVA_BUILD });
});

// One-shot diagnostic: tries every likely request variant against the Viva API
// and reports what each returns. GET /api/viva/probe — safe: sends only the
// stored credentials to Viva itself, returns only statuses + response snippets.
app.get('/api/viva/probe', async (req, res) => {
  if (!vivaConfigured()) return res.status(400).json({ error: 'Viva credentials not configured.' });
  const basic = 'Basic ' + Buffer.from(`${VIVA_TX_USER}:${VIVA_TX_PASS}`).toString('base64');
  const to = new Date(); const from = new Date(to.getTime() - 7 * 86400000);
  const jsonBody = JSON.stringify({ DateFrom: from.toISOString(), DateTo: to.toISOString() });
  const S_URL = `${VIVA_BASE}/dataservices/v1/accounttransactions/Search`;
  const out = [];
  async function attempt(label, url, opts) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { timeout: 15000, ...opts });
      const txt = (await r.text().catch(() => '')).slice(0, 220);
      out.push({ label, status: r.status, ms: Date.now() - t0, snippet: txt });
      return { r, txt };
    } catch (e) {
      out.push({ label, status: 'ERR', ms: Date.now() - t0, snippet: String(e.message).slice(0, 220) });
      return null;
    }
  }
  const J = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ElysianClearing/1.0' };
  await attempt('A: POST Search+query, Basic, Accept json', S_URL + '?PageSize=5&Page=1&OrderBy=Descending', { method: 'POST', headers: { ...J, Authorization: basic }, body: jsonBody });
  await attempt('B: POST Search+query, Basic, NO Accept', S_URL + '?PageSize=5&Page=1&OrderBy=Descending', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: jsonBody });
  await attempt('C: POST Search no query, Basic', S_URL, { method: 'POST', headers: { ...J, Authorization: basic }, body: jsonBody });
  await attempt('D: POST Search empty body {}, Basic', S_URL + '?PageSize=5&Page=1', { method: 'POST', headers: { ...J, Authorization: basic }, body: '{}' });
  await attempt('E: GET Search-as-GET, Basic', S_URL + `?PageSize=5&Page=1&DateFrom=${encodeURIComponent(from.toISOString())}&DateTo=${encodeURIComponent(to.toISOString())}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: basic } });
  await attempt('F: GET collection (no /Search), Basic', `${VIVA_BASE}/dataservices/v1/accounttransactions?PageSize=5&Page=1`, { method: 'GET', headers: { Accept: 'application/json', Authorization: basic } });
  const tok = await attempt('G: OAuth token (accounts host)', VIVA_ACCOUNTS + '/connect/token', { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  let bearer = null;
  if (tok && tok.r && tok.r.status === 200) { try { bearer = JSON.parse(tok.txt).access_token || null; } catch (e) {} }
  if (!bearer && tok && tok.r && tok.r.status === 200) {
    // token body was truncated by the snippet — refetch cleanly
    try { const r2 = await fetch(VIVA_ACCOUNTS + '/connect/token', { timeout: 15000, method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }); const d2 = await r2.json(); bearer = d2.access_token || null; } catch (e) {}
  }
  if (bearer) {
    const B = { ...J, Authorization: 'Bearer ' + bearer };
    await attempt('H: POST Search+query, Bearer', S_URL + '?PageSize=5&Page=1&OrderBy=Descending', { method: 'POST', headers: B, body: jsonBody });
    await attempt('I: GET Search-as-GET, Bearer', S_URL + `?PageSize=5&Page=1&DateFrom=${encodeURIComponent(from.toISOString())}&DateTo=${encodeURIComponent(to.toISOString())}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer } });
    await attempt('J: GET collection, Bearer', `${VIVA_BASE}/dataservices/v1/accounttransactions?PageSize=5&Page=1`, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer } });
  } else {
    out.push({ label: 'H-J skipped', status: '-', ms: 0, snippet: 'no bearer token obtained' });
  }
  out.forEach(o => console.log(`[viva][probe] ${o.label} → ${o.status} (${o.ms}ms) ${o.snippet.slice(0, 120)}`));
  res.json({ probe: out });
});
app.post('/api/viva/check-now', async (req, res) => {
  try {
    const report = await Promise.race([
      vivaRunCheck('manual'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Viva check did not finish within 90 s — open the Railway deploy logs and look at the [viva] lines to see where it stopped.')), 90000)),
    ]);
    res.json({ ok: true, matched: report.matched, unmatchedCredits: report.unmatchedCredits.length, missingExpected: report.missingExpected.length, creditsSeen: report.creditsSeen });
  } catch (e) {
    console.error('[viva] check-now error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Saturday 08:00 Europe/Athens scheduler ────────────────────────────────────
function vivaAthensNow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Athens', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { day: g('weekday'), date: `${g('year')}-${g('month')}-${g('day')}`, hour: parseInt(g('hour'), 10) };
}
async function vivaCronTick() {
  try {
    if (!vivaConfigured() || !pool) return;
    const a = vivaAthensNow();
    if (a.day !== 'Sat' || a.hour !== 8) return;
    const cur = await pool.query("SELECT data FROM app_data WHERE key = 'main'");
    const data = cur.rows[0] && cur.rows[0].data;
    if (!data) return;
    const bank = (data.payChk && data.payChk.bank) || {};
    if (bank.lastCronDate === a.date) return;   // already ran this Saturday
    // claim the date first so a crash can't loop-fire
    data.payChk = data.payChk || { marks: {}, cfg: {} };
    data.payChk.bank = Object.assign({}, bank, { lastCronDate: a.date });
    await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`, ['main', JSON.stringify(data)]);
    await vivaRunCheck('saturday-auto');
  } catch (e) {
    console.error('[viva] cron error:', e.message);
  }
}
setInterval(vivaCronTick, 10 * 60 * 1000);   // checks every 10 min; fires once each Saturday 08:00–08:59 Athens

// ── Offline self-test: node server.js --viva-selftest ─────────────────────────
function vivaSelfTest() {
  const D = (y, m, d) => new Date(y, m - 1, d);
  let n = 0, fail = 0;
  const ok = (name, cond) => { n++; if (!cond) { fail++; console.log('  ✗', name); } else console.log('  ✓', name); };

  ok('classify booking', vivaClassify('BOOKING.COM B.V.') === 'bdc');
  ok('classify airbnb', vivaClassify('Airbnb Payments Luxembourg S.A.') === 'abb');
  ok('classify unknown → never matched', vivaClassify('CARD SETTLEMENT 1234') === null);
  ok('classify Airbnb payout IBAN (BOFA Dublin)', vivaClassify('IE93BOFA99006156923068') === 'abb');
  ok('classify Booking.com payout IBAN (Citi NL)', vivaClassify('NL15CITI2032301393') === 'bdc');
  ok('other IBANs stay unclassified', vivaClassify('GR1601101250000000012300695') === null);

  const data = {
    payChk: { marks: {}, cfg: { from: '2026-07-01', tol: 1 } },
    bks: [
      { platform: 'Booking.com', aptName: 'Birdhouse Apartment', guestName: 'A', checkIn: '15/7/2026', checkOut: '16/7/2026', gross: 81.71, svc: 11.01, pchg: 1.30, payout: 69.40 },
      { platform: 'Booking.com', aptName: 'Birdhouse Apartment', guestName: 'B', checkIn: '21/7/2026', checkOut: '22/7/2026', gross: 58.26, svc: 7.51, pchg: 0.93, payout: 49.82 },
      { platform: 'Booking.com', aptName: 'Skyline Loft', guestName: 'C', checkIn: '19/7/2026', checkOut: '21/7/2026', gross: 300, svc: 45, pchg: 5, payout: 250 },
      { platform: 'Airbnb', aptName: 'Skyline Loft', guestName: 'Georgia Pap', checkIn: '20/7/2026', checkOut: '24/7/2026', gross: 700, svc: 21, pchg: 0, payout: 679 },
      { platform: 'Direct', aptName: 'Skyline Loft', guestName: 'D', checkIn: '20/7/2026', checkOut: '22/7/2026', gross: 999, payout: 999 },
    ],
  };
  const today = D(2026, 7, 25); // Saturday after the 23 Jul payout Thursday
  const units = vivaExpectedUnits(data, today);
  ok('3 units built (2 BDC batches merged per property+Thursday, 1 ABB)', units.length === 3);
  const bird = units.find(u => u.key === 'bdc|2026-07-23|birdhouse apartment');
  ok('Birdhouse Thu-23 batch = 69.40+49.82 = 119.22, key matches client format', !!bird && Math.abs(bird.exp - 119.22) < 0.001);
  ok('Airbnb key matches client format', units.some(u => u.key === 'abb|skyline loft|2026-07-20|georgia pap'));

  const credits = [
    { id: 't1', date: D(2026, 7, 23), amount: 119.18, counterpart: 'BOOKING.COM B.V.' },          // Birdhouse, 4c rounding → tolerance match
    { id: 't2', date: D(2026, 7, 23), amount: 250.00, counterpart: 'Booking.com BV' },            // Skyline exact
    { id: 't3', date: D(2026, 7, 22), amount: 679.00, counterpart: 'AIRBNB PAYMENTS LUX' },       // Airbnb exact (release 21/7 + 1 day)
    { id: 't4', date: D(2026, 7, 23), amount: 500.00, counterpart: 'CARD SETTLEMENT' },           // unknown → ignored
    { id: 't5', date: D(2026, 7, 23), amount: 33.33,  counterpart: 'BOOKING.COM B.V.' },          // no candidate → unmatched
  ];
  const { matches, unmatchedCredits, leftover } = vivaMatch(units, credits, 1);
  ok('3 matches (incl. tolerance match on 4-cent rounding)', matches.length === 3);
  ok('rounding diff recorded (−0.04)', Math.abs(matches.find(m => m.unit.key.includes('birdhouse')).diff - (-0.04)) < 0.001);
  ok('unknown counterpart ignored, odd credit unmatched', unmatchedCredits.length === 1 && unmatchedCredits[0].credit.id === 't5');
  ok('nothing left expected', leftover.length === 0);

  // Ambiguity: two identical expected amounts in the same window → NO auto-tick
  const twin = [
    { key: 'bdc|2026-07-23|apt one', chan: 'bdc', date: D(2026, 7, 23), exp: 100, label: 'one' },
    { key: 'bdc|2026-07-23|apt two', chan: 'bdc', date: D(2026, 7, 23), exp: 100, label: 'two' },
  ];
  const amb = vivaMatch(twin, [{ id: 'x1', date: D(2026, 7, 23), amount: 100, counterpart: 'Booking.com' }], 1);
  ok('ambiguous twin amounts are NOT auto-matched', amb.matches.length === 0 && amb.unmatchedCredits[0].candidates === 2);
  // …but two credits for the two twins DO both match (one leaves the pool after the first match)
  const amb2 = vivaMatch(twin, [
    { id: 'x1', date: D(2026, 7, 23), amount: 100, counterpart: 'Booking.com' },
    { id: 'x2', date: D(2026, 7, 24), amount: 100, counterpart: 'Booking.com' },
  ], 1);
  ok('twin credits: still skipped while ambiguous (2 candidates each)', amb2.matches.length === 0);

  // Date window: credit far outside the window never matches
  const far = vivaMatch(
    [{ key: 'k', chan: 'bdc', date: D(2026, 7, 9), exp: 200, label: 'old' }],
    [{ id: 'y', date: D(2026, 7, 24), amount: 200, counterpart: 'Booking.com' }], 1);
  ok('credit 15 days after the Thursday does not match (window +10d)', far.matches.length === 0);

  // Marked units are excluded from the pool
  const dataMarked = JSON.parse(JSON.stringify(data));
  dataMarked.payChk.marks['bdc|2026-07-23|birdhouse apartment'] = { at: 'x', by: 'Lefteris' };
  ok('already-ticked units excluded', vivaExpectedUnits(dataMarked, today).length === 2);

  console.log(fail ? `\n✗ ${fail}/${n} VIVA SELF-TESTS FAILED` : `\n✓ ALL ${n} VIVA SELF-TESTS PASSED`);
  process.exit(fail ? 1 : 0);
}
if (process.argv.includes('--viva-selftest')) vivaSelfTest();

app.listen(PORT, () => {
  console.log(`\n  ✓  Elysian Clearing  →  http://localhost:${PORT}`);
  console.log(`  ✓  Hosthub base URL  →  ${BASE}`);
  console.log(`  ✓  Server API key    →  ${SERVER_API_KEY ? 'SET (team mode)' : 'not set — enter in app'}`);
  console.log(`  ✓  Password          →  ${APP_PASSWORD ? 'enabled' : 'disabled'}`);
  console.log(`  ✓  Database          →  ${pool ? 'connected (PostgreSQL)' : 'local mode (no DATABASE_URL)'}\n`);
});
