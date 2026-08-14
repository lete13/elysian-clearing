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
let FE_HTML = '';
let FE_HTML_GZ = null;
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
    // Release chain: fe/patches-2.json, fe/patches-3.json ... Each file starts
    // where the previous one ended (its baseSha256 is the previous file's
    // expectedSha256), so a release is a small new file instead of a rewrite of
    // one ever-growing patches.json. Any mismatch throws and the whole set is
    // discarded, exactly as before.
    let chainSha = sha, chainOps = ops.length, chainBuilt = spec.builtAt || '';
    for (let cn = 2; cn <= 100; cn++) { /* legacy note: cn <= 40 */ /* cn <= 80 */ /* cn <= 90 */
      const cf = path.join(__dirname, 'fe', 'patches-' + cn + '.json');
      if (!fsB.existsSync(cf)) break;
      const cs = JSON.parse(fsB.readFileSync(cf, 'utf8'));
      const cops = cs.patches || [];
      if (cs.baseSha256 && cs.baseSha256 !== chainSha) throw new Error('fe/patches-' + cn + '.json base ' + String(cs.baseSha256).slice(0, 12) + ' does not continue the chain (' + chainSha.slice(0, 12) + ')');
      cops.forEach((p, i) => {
        const n = html.split(p.find).length - 1;
        const want = p.count || 1;
        if (n !== want) throw new Error('fe/patches-' + cn + '.json patch #' + (i + 1) + (p.note ? ' (' + p.note + ')' : '') + ': anchor found ' + n + 'x, expected ' + want + 'x');
        html = html.split(p.find).join(p.replace);
      });
      chainSha = sha256(html);
      if (cs.expectedSha256 && cs.expectedSha256 !== chainSha) throw new Error('fe/patches-' + cn + '.json result ' + chainSha.slice(0, 12) + ' does not match its expected ' + String(cs.expectedSha256).slice(0, 12));
      chainOps += cops.length;
      if (cs.builtAt) chainBuilt = cs.builtAt;
    }
    FE_HTML = html;
    try { FE_HTML_GZ = require('zlib').gzipSync(Buffer.from(html)); } catch (e) { FE_HTML_GZ = null; }
    fsB.writeFileSync(idx, html);
    Object.assign(FE_INFO, { source: 'repo-file+patches', patches: chainOps, bytes: Buffer.byteLength(html), sha256: chainSha, builtAt: chainBuilt });
    console.log('  FE: applied ' + chainOps + ' patch(es) to index.html (' + FE_INFO.bytes + ' bytes, sha256 ' + chainSha.slice(0, 12) + '…)');
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

function parseUsers(raw) {
  try {
    const j = JSON.parse(raw || '[]');
    const TABS = {
      management: 'all',
      accountant: ['home','dash','leads','mt','rpt','exp','ann','perf','pinfo','imports','pay','platinv'],
      operator:   ['home','dash','leads','ops','perf','pinfo','co'],
    };
    function normProfile(p) {
      p = String(p || '').toLowerCase();
      if (p === 'admin' || p === 'management') return 'management';
      if (p === 'accounting' || p === 'accountant') return 'accountant';
      if (p === 'operations' || p === 'operator') return 'operator';
      return '';
    }
    return Array.isArray(j) ? j.filter(u => u && u.user && u.pass).map(u => {
      let profiles = [];
      if (Array.isArray(u.profiles) && u.profiles.length) {
        profiles = u.profiles.map(normProfile).filter(Boolean);
      } else {
        const one = normProfile(u.profile || u.role) || (u.access === 'all' ? 'management' : 'operator');
        profiles = [one];
      }
      const seen = {};
      profiles = profiles.filter(function (p) { if (seen[p]) return false; seen[p] = 1; return true; });
      if (!profiles.length) profiles = ['operator'];
      const profile = profiles[0];
      let access = 'all';
      if (profiles.indexOf('management') < 0) {
        const tabs = [];
        profiles.forEach(function (p) {
          const t = TABS[p];
          if (Array.isArray(t)) t.forEach(function (x) { if (tabs.indexOf(x) < 0) tabs.push(x); });
        });
        access = tabs;
      }
      // John (operations) also runs Platform Invoices — grant accountant tabs incl. platinv.
      if (/^john$/i.test(String(u.user))) {
        if (profiles.indexOf('accountant') < 0) profiles.push('accountant');
        if (access !== 'all') {
          if (!Array.isArray(access)) access = [];
          (TABS.accountant || []).forEach(function (x) {
            if (access.indexOf(x) < 0) access.push(x);
          });
          if (access.indexOf('platinv') < 0) access.push('platinv');
        }
      }
      return { user: String(u.user), pass: String(u.pass), profile: profile, profiles: profiles, access: access };
    }) : [];
  } catch (e) { console.error('[auth] USERS_JSON parse error:', e.message); return []; }
}
const USERS = parseUsers(process.env.USERS_JSON);
if (USERS.length) console.log('  ✓  Accounts:', USERS.map(u => u.user + ' (' + (u.profiles || [u.profile]).join('+') + ')').join(', '));

// ── Session auth (cookie) ─────────────────────────────────────────────────────
// Basic Auth cannot be cleared in Chrome, so Log out can never work while the
// browser keeps sending cached Authorization. Access is gated by an httpOnly
// session cookie instead. /login is a normal form; /api/logout clears the cookie.
const cryptoAuth = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD || 'elysian-dev-session';
const SESSION_COOKIE = 'elysian_sess';
const SESSION_DAYS = 14;

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(/;\s*/).forEach(function (part) {
    if (!part) return;
    const i = part.indexOf('=');
    if (i < 0) out[part] = '';
    else out[part.slice(0, i)] = part.slice(i + 1);
  });
  return out;
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
function signSession(payload) {
  const body = b64urlJson(payload);
  const sig = cryptoAuth.createHmac('sha256', SESSION_SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return body + '.' + sig;
}
function readSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const parts = String(raw).split('.');
  if (parts.length !== 2) return null;
  const expect = cryptoAuth.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (expect !== parts[1]) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[0]));
    if (!payload || !payload.user || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}
function cookieSecure(req) {
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '');
  return proto === 'https' || !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN);
}
function setSessionCookie(res, payload, req) {
  const token = signSession(payload);
  const maxAge = SESSION_DAYS * 86400;
  const secure = cookieSecure(req);
  res.append('Set-Cookie', SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : ''));
}
function clearSessionCookie(res, req) {
  const secure = cookieSecure(req);
  res.append('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : ''));
  res.append('Set-Cookie', 'elysian_reauth=; Path=/; Max-Age=0; SameSite=Lax');
  res.append('Set-Cookie', 'elysian_realm=; Path=/; Max-Age=0; SameSite=Lax');
}
function lookupAccount(user, pass) {
  const u = String(user || '');
  const pw = String(pass || '');
  const acct = USERS.find(x => x.user.toLowerCase() === u.toLowerCase() && x.pass === pw);
  if (acct) return { user: acct.user, access: acct.access, profile: acct.profile, profiles: acct.profiles, mode: USERS.length ? 'users' : 'legacy' };
  if (APP_PASSWORD && pw === APP_PASSWORD) {
    return { user: u || 'admin', access: 'all', profile: 'management', profiles: ['management'], mode: USERS.length ? 'users' : 'legacy' };
  }
  return null;
}
function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  if (req.path === '/' || req.path === '/index.html') return true;
  return accept.includes('text/html') && !String(req.path || '').startsWith('/api/');
}
function loginPage(err) {
  const msg = err ? '<div style="color:#f87171;font-size:13px;margin:0 0 12px">' + String(err).replace(/</g, '&lt;') + '</div>' : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Elysian Command Center</title>
<style>
  html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif;background:#0f1720;color:#e5e7eb}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:380px;background:#16283A;border:1px solid #C9A84C44;border-radius:14px;padding:28px 26px 24px;box-shadow:0 18px 50px #0006}
  .brand{color:#C9A84C;font-weight:700;font-size:20px;letter-spacing:.02em;margin:0 0 4px}
  .sub{color:#94a3b8;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#94a3b8;margin:0 0 6px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f1720;color:#e5e7eb;font-size:14px;margin:0 0 14px}
  input:focus{outline:none;border-color:#C9A84C}
  button{width:100%;padding:11px 14px;border:0;border-radius:8px;background:#C9A84C;color:#111;font-weight:700;font-size:14px;cursor:pointer}
  button:hover{filter:brightness(1.05)}
  button:disabled{opacity:.75;cursor:wait;filter:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  #boot{display:none;position:fixed;inset:0;background:#0f1720;z-index:20;align-items:center;justify-content:center;flex-direction:column;gap:14px}
</style></head><body><div id="boot"><div class="brand">Elysian Command Center</div><div style="width:32px;height:32px;border:3px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div><div class="sub">Opening workspace…</div></div><div class="wrap"><form class="card" method="POST" action="/api/login" autocomplete="username" onsubmit="var b=this.querySelector('button'); if(b.disabled) return false; b.disabled=true; b.textContent='Opening Command Center…'; var o=document.getElementById('boot'); if(o) o.style.display='flex';">
  <div class="brand">Elysian Command Center</div>
  <p class="sub">Sign in with your account</p>
  ${msg}
  <label for="user">Username</label>
  <input id="user" name="user" required autocomplete="username" autofocus>
  <label for="pass">Password</label>
  <input id="pass" name="pass" type="password" required autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></div></body></html>`;
}

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.status(200).type('html').send(loginPage(''));
});

app.post('/api/login', express.urlencoded({ extended: false }), (req, res) => {
  const body = req.body || {};
  const acct = lookupAccount(body.user, body.pass);
  if (!acct) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('html').send(loginPage('Wrong username or password.'));
  }
  const payload = {
    user: acct.user,
    access: acct.access,
    profile: acct.profile,
    profiles: acct.profiles,
    mode: acct.mode,
    exp: Date.now() + SESSION_DAYS * 86400 * 1000,
  };
  setSessionCookie(res, payload, req);
  res.set('Cache-Control', 'no-store');
  return res.redirect('/');
});

app.get('/api/logout', (req, res) => {
  clearSessionCookie(res, req);
  res.set('Cache-Control', 'no-store');
  // Drop client storage so the SPA cannot look "still signed in" from bfcache/localStorage.
  res.set('Clear-Site-Data', '"storage"');
  res.status(200).type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed out</title>
<meta http-equiv="refresh" content="0;url=/login?signedout=1">
</head><body style="margin:0;font-family:system-ui,sans-serif;background:#0f1720;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="text-align:center;padding:32px">
  <div style="font-size:18px;font-weight:600;margin-bottom:8px">Signed out</div>
  <a href="/login?signedout=1" style="color:#C9A84C">Sign in again</a>
</div>
<script>
try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
location.replace('/login?signedout=1');
</script>
</body></html>`);
});

if (APP_PASSWORD || USERS.length) {
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/api/fe-info' || req.path === '/api/logout'
      || req.path === '/login' || req.path === '/api/login') return next();
    const sess = readSession(req);
    if (sess) {
      req.acctUser = sess.user;
      req.acctAccess = sess.access || 'all';
      req.acctProfile = sess.profile || 'management';
      req.acctProfiles = sess.profiles || [sess.profile || 'management'];
      return next();
    }
    // Do NOT fall back to Basic Auth — Chrome would keep the previous user forever.
    res.set('Cache-Control', 'no-store');
    if (wantsHtml(req)) return res.redirect('/login');
    return res.status(401).json({ error: 'Authentication required', login: '/login' });
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
function sendAppHtml(req, res) {
  const html = FE_HTML || require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
  const etag = FE_INFO.sha256 ? '"' + FE_INFO.sha256 + '"' : undefined;
  if (etag && String(req.headers['if-none-match'] || '') === etag) {
    res.status(304).end();
    return;
  }
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');
  if (etag) res.set('ETag', etag);
  const ae = String(req.headers['accept-encoding'] || '');
  if (FE_HTML_GZ && /\bgzip\b/.test(ae)) {
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.type('html');
    res.send(FE_HTML_GZ);
    return;
  }
  res.type('html').send(html);
}
app.get('/', sendAppHtml);
app.get('/index.html', sendAppHtml);
app.use((req, res, next) => {
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(ae)) return next();
  const origJson = res.json.bind(res);
  res.json = function (obj) {
    try {
      const raw = JSON.stringify(obj === undefined ? null : obj);
      if (Buffer.byteLength(raw) < 2048) return origJson(obj);
      const gz = require('zlib').gzipSync(raw);
      res.set('Content-Encoding', 'gzip');
      res.set('Vary', 'Accept-Encoding');
      res.type('json');
      return res.send(gz);
    } catch (e) { return origJson(obj); }
  };
  next();
});
app.use(express.static(__dirname, { index: false }));
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
        logEvent(req, 'data', '⚠ blocked wipe', 'write would have deleted ' + dbBks + ' bookings');
        return res.status(409).json({ error: 'Write blocked: would delete ' + dbBks + ' bookings.', blocked: true });
      }
      // ANTI-WIPE EXPENSES
      if (dbExps > 0 && inExps === 0 && dbBks > 0) {
        console.warn('[db] BLOCKED write: would wipe', dbExps, 'expenses');
        logEvent(req, 'data', '⚠ blocked wipe', 'write would have deleted ' + dbExps + ' expenses');
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

      // Stale-client last-write-wins: a Daily Ops save from a laptop that had not
      // yet polled can drop rptLocks keys (email stamps), ownerRemit rows, and
      // blank out apartment emails / Business tax. Union-merge those maps and
      // restore non-empty config fields the incoming blob cleared.
      payload.rptLocks = mergeKeepMap(existing.rptLocks, payload.rptLocks, mergeRptLock);
      payload.ownerRemit = mergeKeepMap(existing.ownerRemit, payload.ownerRemit);
      payload.monthlyClose = mergeMonthlyClose(existing.monthlyClose, payload.monthlyClose);
      if (existing.revenue || payload.revenue) {
        const er = existing.revenue || {}, pr = payload.revenue || {};
        payload.revenue = Object.assign({}, er, pr, {
          cleaning: mergeKeepMap(er.cleaning, pr.cleaning),
          mgmt: mergeKeepMap(er.mgmt, pr.mgmt)
        });
      }
      if (Array.isArray(existing.apts) && Array.isArray(payload.apts) && payload.apts.length) {
        payload.apts = mergeAptsProtect(existing.apts, payload.apts);
      }
    }

    await pool.query(
      `INSERT INTO app_data (key, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      ['main', JSON.stringify(payload)]
    );
    const ts = await pool.query("SELECT updated_at FROM app_data WHERE key = 'main'");
    logEvent(req, 'data', 'save', diffSummary(existing, payload));
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

// ── Property Info: amenities, guest FAQs, house rules, Law 5170 compliance ───
// One row per rental so two people saving different apartments cannot clobber
// each other. Compliance file blobs stay in proof_files; this table holds only
// the references. Self-healing DDL, same pattern as the proofs table below.
let _rentalInfoReady = false;
async function ensureRentalInfoTable() {
  if (_rentalInfoReady || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rental_info (
      rental_id   TEXT PRIMARY KEY,
      data        JSONB       NOT NULL,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  _rentalInfoReady = true;
}
function riShape(b) {
  const o = (b && typeof b === 'object') ? b : {};
  return {
    amenities:  (o.amenities  && typeof o.amenities  === 'object') ? o.amenities  : {},
    faqs:       Array.isArray(o.faqs) ? o.faqs : [],
    houseRules: (o.houseRules && typeof o.houseRules === 'object') ? o.houseRules : {},
    compliance: (o.compliance && typeof o.compliance === 'object') ? o.compliance : {},
  };
}
// GET /api/rental-info — the whole portfolio as { rentalId: record }
app.get('/api/rental-info', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureRentalInfoTable();
    const r = await pool.query('SELECT rental_id, data FROM rental_info');
    const out = {};
    r.rows.forEach(row => { out[row.rental_id] = row.data || {}; });
    res.json(out);
  } catch (e) { console.error('[rental-info] list failed:', e.message); res.status(500).json({ error: e.message }); }
});
// GET /api/rental-info/:id — one apartment ({} when it was never saved)
app.get('/api/rental-info/:id', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureRentalInfoTable();
    const r = await pool.query('SELECT data FROM rental_info WHERE rental_id = $1', [String(req.params.id)]);
    res.json((r.rows[0] && r.rows[0].data) || {});
  } catch (e) { console.error('[rental-info] read failed:', e.message); res.status(500).json({ error: e.message }); }
});
// POST /api/rental-info/:id — replace one apartment's record
app.post('/api/rental-info/:id', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing rental id.' });
    await ensureRentalInfoTable();
    const by = String((req.body && req.body._by) || req.headers['x-user'] || '').slice(0, 80) || null;
    const shaped = riShape(req.body);
    const r = await pool.query(
      `INSERT INTO rental_info (rental_id, data, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (rental_id) DO UPDATE SET data = $2::jsonb, updated_by = $3, updated_at = NOW()
       RETURNING updated_at`,
      [id, JSON.stringify(shaped), by]
    );
    logEvent(req, 'pinfo', 'save', id + ' · ' +
      Object.values(shaped.amenities || {}).filter(a => a && a.on).length + ' amenities · ' +
      (shaped.faqs || []).length + ' FAQs · ' + Object.keys(shaped.compliance || {}).length + ' compliance items');
    res.json({ ok: true, updatedAt: r.rows[0] && r.rows[0].updated_at });
  } catch (e) { console.error('[rental-info] save failed:', e.message); res.status(500).json({ error: e.message }); }
});
// GET /api/whoami — who this browser is signed in as. Without APP_PASSWORD there
// is no sign-in at all, so report nobody rather than inventing an identity.
// Meta lead ads pull. Guarded exactly like Viva: without credentials every
// endpoint answers politely and the cron does nothing, so the rest of the
// pipeline is fully usable before Meta access is sorted out.
const META_TOKEN = process.env.META_PAGE_TOKEN || '';
// Graph API versions last about two and a half years and then stop existing -
// and a call to a dead version does not fail, it silently falls back to the
// oldest one still alive, which is how an integration starts behaving oddly
// with nothing in the logs. v21.0 expires 2027-01-21; v25.0 runs to 2028-07-29.
// The env var means the next bump is a Railway variable, not a release.
const META_API = 'https://graph.facebook.com/' + (process.env.META_API_VERSION || 'v25.0');
const metaConfigured = () => !!META_TOKEN;
function metaFieldsToLead(l, form) {
  const f = {};
  (l.field_data || []).forEach(function (fd) {
    const k = String(fd.name || '').toLowerCase();
    const v = Array.isArray(fd.values) ? fd.values.join(', ') : String(fd.values || '');
    f[k] = v;
  });
  const pick = function (keys) { for (const k of keys) if (f[k]) return f[k]; return ''; };
  return {
    source: 'meta', metaLeadId: String(l.id), createdTime: l.created_time || null,
    formId: (form && form.id) || l.form_id || null, formName: (form && form.name) || null,
    campaign: l.campaign_name || null, adset: l.adset_name || null, adId: l.ad_id || null,
    fullName: pick(['full_name', 'name', 'first_name']) + (f.last_name && !f.full_name ? ' ' + f.last_name : ''),
    email: pick(['email', 'work_email']),
    phone: pick(['phone_number', 'phone', 'mobile']),
    fields: f, raw: l,
  };
}
async function metaGet(url) {
  const r = await fetch(url, { timeout: 20000 });
  const j = await r.json().catch(function () { return null; });
  if (!r.ok) throw new Error('Meta ' + r.status + ': ' + ((j && j.error && j.error.message) || 'request failed'));
  return j;
}
// Pull leads created since the last successful run (with a small overlap, since
// leadIngest is idempotent on meta_lead_id and duplicates cost nothing).
async function metaPull(trigger, opts) {
  if (!metaConfigured()) throw new Error('Meta is not configured (set META_PAGE_TOKEN in Railway -> Variables).');
  if (!pool) throw new Error('No database configured.');
  await ensureLeadTables();
  const cfg = await leadCfg();
  let sinceRow = null;
  try { const r = await pool.query('SELECT data FROM app_data WHERE key = $1', ['leads_meta_state']); sinceRow = r.rows[0] && r.rows[0].data; } catch (e) {}
  let sinceSec = Math.floor(((sinceRow && sinceRow.lastRunMs) || (Date.now() - 7 * 864e5)) / 1000) - 600;   // 10 min overlap
  // Never import anything older than metaSinceDate. Without this the very first
  // pull imports the account's entire history in one go and the assignment rule
  // shares the whole backlog out before anyone has looked at it.
  const floorSec = cfg.metaSinceDate
    ? Math.floor(new Date(cfg.metaSinceDate + 'T00:00:00Z').getTime() / 1000) : null;
  // Normally the floor only moves the window forward - it is a guard, not a
  // target. A backfill is the deliberate opposite: start at the floor whatever
  // the watermark says. Safe to repeat as often as you like, because leadIngest
  // is idempotent on meta_lead_id and a re-seen lead costs nothing.
  if (opts && opts.backfill && isFinite(floorSec)) sinceSec = floorSec;
  else if (isFinite(floorSec) && floorSec > sinceSec) sinceSec = floorSec;
  const page = await metaResolvePage();
  if (page.error) throw new Error(page.error + (page.hint ? ' — ' + page.hint : ''));
  const PTOK = page.token;
  let forms = (cfg.metaFormIds || []).map(function (id) { return { id: String(id), name: null }; });
  if (!forms.length) {
    const fj = await metaGet(META_API + '/' + page.id + '/leadgen_forms?limit=100&fields=id,name&access_token=' + encodeURIComponent(PTOK));
    forms = (fj.data || []).map(function (f) { return { id: f.id, name: f.name }; });
  }
  let seen = 0, created = 0;
  for (const form of forms) {
    let url = META_API + '/' + form.id + '/leads?limit=100&filtering=' +
      encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceSec }])) +
      '&access_token=' + encodeURIComponent(PTOK);
    let pages = 0;
    while (url && pages++ < 20) {
      const j = await metaGet(url);
      for (const l of (j.data || [])) {
        seen++;
        const res = await leadIngest(metaFieldsToLead(l, form), 'meta');
        if (!res.duplicate) created++;
      }
      url = (j.paging && j.paging.next) || null;
    }
  }
  // A run that found no forms looked at nothing, so it has no business claiming
  // everything up to now has been seen. Recording it as the watermark is how
  // sixty days of backfill silently became ten minutes.
  const state = { lastRunMs: forms.length ? Date.now() : ((sinceRow && sinceRow.lastRunMs) || 0),
                  trigger: trigger, forms: forms.length, seen: seen, created: created,
                  page: { id: page.id, name: page.name } };
  await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
                    ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`, ['leads_meta_state', JSON.stringify(state)]);
  console.log('[leads][meta] ' + trigger + ': ' + forms.length + ' form(s), ' + seen + ' seen, ' + created + ' new');
  return state;
}
// Retention: archived leads are kept for archiveRetentionMonths (two years by
// default) and then tombstoned - personal data removed, the row kept so the
// funnel history stays intact. Converted leads are never touched. Runs once a
// day, claim-the-date guarded like the other crons.
async function leadRetentionSweep() {
  if (!pool) return;
  await ensureLeadTables();
  const cfg = await leadCfg();
  const months = parseInt(cfg.archiveRetentionMonths, 10);
  if (!isFinite(months) || months <= 0) return;
  const r = await pool.query(
    `UPDATE leads SET full_name = NULL, email = NULL, phone = NULL, raw = '{}'::jsonb,
            fields = '{}'::jsonb, meta_lead_id = NULL, status = 'erased',
            events = events || $1::jsonb, updated_at = NOW()
       WHERE archived_at IS NOT NULL AND apt_id IS NULL AND status <> 'erased'
         AND archived_at < NOW() - ($2 || ' months')::interval
       RETURNING id`,
    [JSON.stringify([leadEvent('erased', 'system', 'archive retention: older than ' + months + ' months')]), String(months)]);
  if (r.rows.length) console.log('[leads] retention sweep tombstoned ' + r.rows.length + ' archived lead(s)');
}
setInterval(async function () {
  try {
    if (!pool) return;
    const a = vivaAthensNow();
    if (a.hour !== 4) return;                       // quiet hour
    const k = 'leads_retention_state';
    const q = await pool.query('SELECT data FROM app_data WHERE key = $1', [k]);
    const d = (q.rows[0] && q.rows[0].data) || {};
    if (d.lastDate === a.date) return;
    d.lastDate = a.date;
    await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
                      ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`, [k, JSON.stringify(d)]);
    await leadRetentionSweep();
  } catch (e) { console.error('[leads] retention sweep error:', e.message); }
}, 30 * 60 * 1000);

// Every 5 minutes. Silent and harmless until Meta is configured.
setInterval(function () {
  if (!metaConfigured() || !pool) return;
  metaPull('cron').catch(function (e) { console.error('[leads][meta] cron error:', e.message); });
}, 5 * 60 * 1000);

// Endpoints
app.get('/api/leads', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const view = String(req.query.view || 'active');
    const where = view === 'archived' ? 'archived_at IS NOT NULL' : view === 'all' ? 'TRUE' : 'archived_at IS NULL';
    // Free-text search. Matters most on the archive, which holds two years of
    // leads: without it, finding "that owner in Glyfada from last spring" means
    // scrolling. Erased tombstones hold no personal data so they simply miss.
    const q = String(req.query.q || '').trim().toLowerCase();
    const qWhere = q ? ` AND (
        lower(coalesce(full_name,'')) LIKE $1 OR lower(coalesce(email,'')) LIKE $1
        OR regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') LIKE $1
        OR lower(coalesce(form_name,'')) LIKE $1 OR lower(coalesce(campaign,'')) LIKE $1
        OR lower(coalesce(archive_reason,'')) LIKE $1 OR lower(coalesce(owner,'')) LIKE $1
        OR lower(coalesce(property_address,'')) LIKE $1 OR lower(coalesce(property_size,'')) LIKE $1
        OR ($2::text IS NOT NULL AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') LIKE $2) )` : '';
    // A phone number gets pasted the way it is displayed - "694 443 3748" - but
    // the column is compared digits-only, so the spaces would find nothing.
    const qDigits = q.replace(/\D/g, '');
    const qArgs = q ? ['%' + q.replace(/[%_]/g, '') + '%', qDigits.length >= 4 ? '%' + qDigits + '%' : null] : [];
    const r = await pool.query('SELECT * FROM leads WHERE ' + where + qWhere + ' ORDER BY COALESCE(created_time, updated_at) DESC LIMIT 2000', qArgs);
    res.json({ ok: true, leads: r.rows, config: await leadCfg(), metaConfigured: metaConfigured() });
  } catch (e) { console.error('[leads] list failed:', e.message); res.status(500).json({ error: e.message }); }
});
app.post('/api/leads', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const b = req.body || {};
    if (!String(b.fullName || '').trim()) return res.status(400).json({ error: 'A name is required.' });
    if (!String(b.email || '').trim() && !String(b.phone || '').trim()) return res.status(400).json({ error: 'An email or a phone number is required.' });
    if (!b.force) {
      const dup = await leadFindDuplicate(b.email, b.phone, null);
      if (dup) return res.status(409).json({ error: 'duplicate', duplicate: dup });
    }
    const out = await leadIngest({
      source: b.source || 'manual', fullName: b.fullName, email: b.email, phone: b.phone,
      fields: Object.assign({}, b.fields || {}, {
        // let the same extractor handle them, so manual and Meta leads agree
        'property address': b.propertyAddress || '', 'property size': b.propertySize || '',
        bedrooms: b.bedrooms || '', bathrooms: b.bathrooms || '',
      }), formName: b.note || null, raw: { manual: true, note: b.note || '' },
    }, b.by || 'team');
    if (b.owner) await pool.query('UPDATE leads SET owner = $2, assigned_at = NOW(), stage = CASE WHEN stage = $3 THEN $4 ELSE stage END WHERE id = $1', [out.id, String(b.owner), 'new', 'to_contact']);
    res.json({ ok: true, id: out.id, owner: b.owner || out.owner || null });
  } catch (e) { console.error('[leads] create failed:', e.message); res.status(500).json({ error: e.message }); }
});
app.patch('/api/leads/:id', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const id = parseInt(req.params.id, 10);
    const b = req.body || {}, by = String(b.by || 'team');
    const cur = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Lead not found.' });
    const row = cur.rows[0];
    const sets = [], vals = [id]; const ev = [];
    const put = function (col, v) { vals.push(v); sets.push(col + ' = $' + vals.length); };
    if (b.stage && b.stage !== row.stage) {
      if (LEAD_ALL_STAGES.indexOf(b.stage) === -1) return res.status(400).json({ error: 'Unknown stage.' });
      put('stage', b.stage); put('stage_changed_at', new Date().toISOString());
      if (b.stage === 'lost') { put('status', 'lost'); put('lost_reason', String(b.lostReason || '')); }
      else if (b.stage === 'live') { put('status', 'won'); put('won_at', new Date().toISOString()); }
      else put('status', 'open');
      if (b.stage === 'contacted' && !row.first_contact_at) put('first_contact_at', new Date().toISOString());
      ev.push(leadEvent('stage', by, row.stage + ' -> ' + b.stage + (b.lostReason ? ' (' + b.lostReason + ')' : '')));
    }
    if (b.owner !== undefined && b.owner !== row.owner) {
      put('owner', b.owner || null); put('assigned_at', new Date().toISOString());
      ev.push(leadEvent('assigned', by, 'to ' + (b.owner || 'nobody') + ' (manual)'));
    }
    ['full_name','email','phone','apt_id'].forEach(function (c) {
      const k = c === 'full_name' ? 'fullName' : c === 'apt_id' ? 'aptId' : c;
      if (b[k] !== undefined && b[k] !== row[c]) { put(c, b[k] || null); ev.push(leadEvent('edit', by, c)); }
    });
    // The form answer is where the property details start, not the last word:
    // half of them arrive as a range or a guess and get corrected on the call.
    const LEAD_PROP_EDIT = {
      propertyAddress: 'property_address', propertySize: 'property_size',
      propertyType: 'property_type', bedrooms: 'bedrooms', bathrooms: 'bathrooms',
    };
    Object.keys(LEAD_PROP_EDIT).forEach(function (k) {
      const c = LEAD_PROP_EDIT[k];
      if (b[k] === undefined || b[k] === row[c]) return;
      put(c, b[k] || null); ev.push(leadEvent('edit', by, c));
      if (c === 'bedrooms')  put('bedrooms_n',  leadInt(b[k]));
      if (c === 'bathrooms') put('bathrooms_n', leadInt(b[k]));
    });
    if (b.fields) { put('fields', JSON.stringify(b.fields)); ev.push(leadEvent('edit', by, 'details')); }
    if (b.note) ev.push(leadEvent('note', by, String(b.note).slice(0, 500)));
    if (b.emailSent) ev.push(leadEvent('email', by, String(b.emailSent).slice(0, 300)));
    if (!sets.length && !ev.length) return res.json({ ok: true, unchanged: true });
    vals.push(JSON.stringify(ev)); sets.push('events = events || $' + vals.length + '::jsonb');
    sets.push('updated_at = NOW()');
    await pool.query('UPDATE leads SET ' + sets.join(', ') + ' WHERE id = $1', vals);
    res.json({ ok: true });
  } catch (e) { console.error('[leads] update failed:', e.message); res.status(500).json({ error: e.message }); }
});
// Archive: the everyday removal. Reversible, keeps everything.
app.post('/api/leads/:id/archive', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const b = req.body || {}, by = String(b.by || 'team');
    const restore = !!b.restore;
    const ev = JSON.stringify([leadEvent(restore ? 'restored' : 'archived', by, String(b.reason || ''))]);
    const r = await pool.query(
      restore ? `UPDATE leads SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, events = events || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING id`
              : `UPDATE leads SET archived_at = NOW(), archived_by = $3, archive_reason = $4, events = events || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING id`,
      restore ? [parseInt(req.params.id, 10), ev] : [parseInt(req.params.id, 10), ev, by, String(b.reason || '')]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ ok: true });
  } catch (e) { console.error('[leads] archive failed:', e.message); res.status(500).json({ error: e.message }); }
});
// Permanent delete: for a genuine erasure request, and nothing else. Wipes the
// personal data, keeps a tombstone so the funnel counts stay honest and the
// erasure is provable. Refused once the lead has become an apartment - that is
// a live business relationship with its own retention basis.
app.delete('/api/leads/:id', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const b = req.body || {};
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT apt_id, source, stage FROM leads WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Lead not found.' });
    if (cur.rows[0].apt_id) return res.status(409).json({ error: 'This lead has become an apartment. Unlink it first if you really mean to erase it.' });
    const ev = JSON.stringify([leadEvent('erased', String(b.by || 'team'), 'personal data removed on request')]);
    await pool.query(
      `UPDATE leads SET full_name = NULL, email = NULL, phone = NULL, raw = '{}'::jsonb, fields = '{}'::jsonb,
              meta_lead_id = NULL, status = 'erased', archived_at = COALESCE(archived_at, NOW()),
              -- an address is personal data, and a 3-bed 85 m2 maisonette in a named
              -- suburb re-identifies its owner even without the street. "Personal data
              -- removed" has to mean these too, not just the name and the phone.
              property_address = NULL, property_size = NULL, property_type = NULL,
              bedrooms = NULL, bathrooms = NULL, bedrooms_n = NULL, bathrooms_n = NULL,
              events = $2::jsonb, updated_at = NOW() WHERE id = $1`, [id, ev]);
    console.log('[leads] erased #' + id + ' (tombstone kept)');
    res.json({ ok: true });
  } catch (e) { console.error('[leads] delete failed:', e.message); res.status(500).json({ error: e.message }); }
});
app.post('/api/leads/config', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    const cfg = Object.assign({}, LEAD_CFG_DEFAULT, req.body || {});
    await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
                      ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`, [LEAD_CFG_KEY, JSON.stringify(cfg)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One call to Meta, with the token kept out of everything that comes back.
// node-fetch puts the whole request URL in its parse errors, so returning a raw
// failure here would print the access token into the response AND the logs.
async function metaCall(path, qs, token) {
  const tok = token || META_TOKEN;
  const url = META_API + path + '?' + qs + '&access_token=' + encodeURIComponent(tok);
  const safe = META_API + path + '?' + qs;   // the only form of the URL that may be quoted
  let r;
  try { r = await fetch(url); }
  catch (e) { return { error: 'Could not reach ' + safe + ' (' + e.message.split(tok).join('[token]').split(META_TOKEN).join('[token]') + ')' }; }
  const body = await r.text();
  let j;
  try { j = JSON.parse(body); }
  catch (e) {
    return { error: 'Meta answered ' + r.status + ' with something that is not JSON: ' +
      body.slice(0, 120).split(tok).join('[token]').split(META_TOKEN).join('[token]') };
  }
  if (j.error) return { error: j.error.message, code: j.error.code, sub: j.error.error_subcode };
  return { data: j };
}
// A Page token answers /me with the Page. A User token answers with the person,
// and the Pages they manage hang off /me/accounts - each with its own Page token
// attached, which is the documented way to get one. Resolve either shape to
// {id, name, token} so nothing downstream has to care which was pasted in.
let _metaPage = null;
async function metaResolvePage() {
  if (_metaPage) return _metaPage;
  const me = await metaCall('/me', 'fields=id,name');
  if (me.error) return { error: me.error, code: me.code };
  // Only a Page has leadgen_forms, so that is the test for which kind this is.
  const probe = await metaCall('/' + me.data.id + '/leadgen_forms', 'limit=1');
  if (!probe.error) return (_metaPage = { id: me.data.id, name: me.data.name, token: META_TOKEN, kind: 'page' });
  const acc = await metaCall('/me/accounts', 'fields=id,name,access_token&limit=100');
  if (acc.error) return { error: acc.error, code: acc.code,
    hint: 'This looks like a User token, but it cannot list the Pages it manages - pages_show_list is missing.' };
  const pages = acc.data.data || [];
  if (!pages.length) return { error: 'That token manages no Pages.',
    hint: 'It is a User token for ' + me.data.name + ', and pages_show_list returned nothing. Check the token was made for the right person.' };
  const cfg = await leadCfg();
  const want = String(cfg.metaPageId || '').trim();
  const hit = want ? pages.filter(function (p) { return String(p.id) === want; })[0] : (pages.length === 1 ? pages[0] : null);
  if (!hit) return { error: want ? 'Page ' + want + ' is not one this token manages.' : 'This token manages ' + pages.length + ' Pages - say which one.',
    pages: pages.map(function (p) { return { id: p.id, name: p.name }; }),
    hint: 'Set metaPageId in the leads config to the right one.' };
  return (_metaPage = { id: hit.id, name: hit.name, token: hit.access_token, kind: 'page-via-user', via: me.data.name });
}
// Is the token real, does it still work, and can it actually see the forms?
// Three different failures that all look the same from here: no leads arriving.
app.get('/api/leads/meta/status', async (req, res) => {
  const out = { configured: metaConfigured(), apiVersion: META_API.split('/').pop() };
  // A short hash of the token, so "did the Railway variable actually change?"
  // has an answer. Reveals nothing - it is one-way and truncated - but two
  // readings with the same fingerprint are certainly the same token.
  if (META_TOKEN) out.tokenFingerprint =
    require('crypto').createHash('sha256').update(META_TOKEN).digest('hex').slice(0, 8) +
    ' (' + META_TOKEN.length + ' chars)';
  out.processStartedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  if (!out.configured) return res.status(503).json(Object.assign(out, { error: 'No META_PAGE_TOKEN set.' }));
  try {
    // Ask Meta what this token can actually do before diagnosing anything else.
    // A token generated in the Explorer without ticking the boxes carries only
    // public_profile, and every later failure is downstream of that.
    const NEEDED = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'ads_management'];
    const perm = await metaCall('/me/permissions', 'limit=100');
    if (!perm.error) {
      const rows = perm.data.data || [];
      const granted = rows.filter(function (p) { return p.status === 'granted'; }).map(function (p) { return p.permission; });
      const declined = rows.filter(function (p) { return p.status !== 'granted'; }).map(function (p) { return p.permission; });
      out.granted = granted;
      if (declined.length) out.declined = declined;
      out.missing = NEEDED.filter(function (p) { return granted.indexOf(p) === -1; });
      if (out.missing.length) return res.status(502).json(Object.assign(out, {
        error: 'The token is missing ' + out.missing.length + ' of the permissions this needs: ' + out.missing.join(', ') + '.',
        hint: 'Regenerate it in the Graph API Explorer with those boxes ticked - a token only carries what was selected at the moment it was made.' }));
    }
    const me = await metaCall('/me', 'fields=id,name');
    if (me.error) return res.status(502).json(Object.assign(out, {
      error: me.error, code: me.code,
      hint: me.code === 190 ? 'That token is expired or was revoked - generate a new one.' : undefined }));
    out.token = { id: me.data.id, name: me.data.name };
    const page = await metaResolvePage();
    if (page.error) return res.status(502).json(Object.assign(out, page));
    out.page = { id: page.id, name: page.name, tokenKind: page.kind };
    const f = await metaCall('/' + page.id + '/leadgen_forms', 'fields=id,name,leads_count,status&limit=50', page.token);
    if (f.error) return res.status(502).json(Object.assign(out, { error: f.error, code: f.code,
      hint: 'The Page resolved but its lead forms are not readable - leads_retrieval and pages_show_list are the usual missing ones.' }));
    out.forms = (f.data.data || []).map(function (x) { return { id: x.id, name: x.name, leads: x.leads_count, status: x.status }; });
    const st = await pool.query('SELECT data FROM app_data WHERE key = $1', ['leads_meta_state']).catch(function () { return { rows: [] }; });
    out.lastRun = st.rows[0] && st.rows[0].data;
    const cfg = await leadCfg();
    out.sinceDate = cfg.metaSinceDate || null;
    out.formFilter = (cfg.metaFormIds || []).length ? cfg.metaFormIds : 'every form the token can see';
    res.json(out);
  } catch (e) { res.status(500).json(Object.assign(out, { error: String(e.message || e).replace(META_TOKEN, '[token]') })); }
});
app.post('/api/leads/meta/pull', async (req, res) => {
  try {
    // 503 = "not set up yet", matching the database and email endpoints, so the
    // UI can tell "Meta isn't connected" apart from "the pull failed".
    if (!metaConfigured()) return res.status(503).json({ error: 'Meta is not connected (set META_PAGE_TOKEN in Railway -> Variables).' });
    res.json({ ok: true, state: await metaPull(req.body && req.body.backfill ? 'backfill' : 'manual',
                                                { backfill: !!(req.body && req.body.backfill) }) });
  }
  catch (e) { console.error('[leads][meta] pull failed:', e.message); res.status(500).json({ error: e.message }); }
});
// Brochure / draft contract, swapped in the UI rather than in a deploy.
app.get('/api/lead-assets', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const full = String(req.query.full || '') === '1';
    const r = await pool.query(full ? 'SELECT * FROM lead_assets' : 'SELECT key, filename, mime, size, version, updated_by, updated_at FROM lead_assets');
    res.json({ ok: true, assets: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/lead-assets/:key', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const r = await pool.query('SELECT * FROM lead_assets WHERE key = $1', [String(req.params.key || '')]);
    if (!r.rows.length) return res.status(404).json({ error: 'Asset not found.' });
    res.json({ ok: true, asset: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lead-assets', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'No database configured.' });
    await ensureLeadTables();
    const b = req.body || {};
    if (!b.key || !b.dataB64 || !b.filename) return res.status(400).json({ error: 'key, filename and dataB64 are required.' });
    const size = Buffer.from(String(b.dataB64), 'base64').length;
    if (size > 15 * 1024 * 1024) return res.status(413).json({ error: 'That file is over 15 MB.' });
    await pool.query(
      `INSERT INTO lead_assets (key, filename, mime, size, version, data, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,1,$5,$6,NOW())
       ON CONFLICT (key) DO UPDATE SET filename = $2, mime = $3, size = $4,
         version = lead_assets.version + 1, data = $5, updated_by = $6, updated_at = NOW()`,
      [String(b.key), String(b.filename), String(b.mime || 'application/octet-stream'), size, String(b.dataB64), String(b.by || 'team')]);
    res.json({ ok: true, size: size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whoami', (req, res) => {
  if (!APP_PASSWORD && !USERS.length) return res.json({ user: null });
  res.json({
    user: req.acctUser || null,
    access: req.acctAccess || 'all',
    profile: req.acctProfile || 'management',
    profiles: req.acctProfiles || [req.acctProfile || 'management'],
    mode: USERS.length ? 'users' : 'legacy'
  });
});

// ── Platform invoices (Airbnb / Booking.com host-portal PDFs) ────────────────
// These are invoices the platforms issue TO Elysian (ενδοκοινοτικά). They do NOT
// appear in Greek expense/myDATA imports. Monthly work: pull from the host
// portals → pack leased for E-New Generation (20th) and B2B for partners (25th).
const PLATFORM_INV_MAX_B64 = 20 * 1024 * 1024; // ~15 MB binary
const PLATFORM_INV_ACCOUNTANT = process.env.PLATFORM_INVOICE_ACCOUNTANT_EMAIL || 'info@e-newgeneration.gr, info@elysianproperties.eu';
let _platInvReady = false;
const _memPlatInv = new Map();
let _memPlatInvSeq = 1;
async function ensurePlatInvTable() {
  if (_platInvReady || !pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_invoices (
    id SERIAL PRIMARY KEY,
    month TEXT NOT NULL,
    channel TEXT NOT NULL,
    scope TEXT NOT NULL,
    partner TEXT DEFAULT '',
    filename TEXT,
    mime TEXT,
    size INT,
    source TEXT DEFAULT 'upload',
    uploaded_by TEXT,
    data TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  _platInvReady = true;
}
function platInvMeta(r) {
  return {
    id: r.id, month: r.month, channel: r.channel, scope: r.scope, partner: r.partner || '',
    filename: r.filename, mime: r.mime, size: r.size, source: r.source, uploadedBy: r.uploaded_by,
    createdAt: r.created_at || r.createdAt
  };
}
function platInvPdfBuffer(row) {
  const raw = String((row && row.data) || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw, 'base64');
}
function platInvFileLeaf(row) {
  return String((row && row.filename) || 'invoice.pdf').split('/').pop() || 'invoice.pdf';
}

async function piLoadPortalSession(channel) {
  const ch = String(channel || '').toLowerCase();
  if (ch !== 'airbnb' && ch !== 'booking') return null;
  const key = 'pi_portal_session_' + ch;
  if (pool) {
    try {
      const r = await pool.query('SELECT data FROM app_data WHERE key=$1', [key]);
      if (r.rows.length && r.rows[0].data) {
        const d = r.rows[0].data;
        return typeof d === 'string' ? JSON.parse(d) : d;
      }
    } catch (e) { console.error('[platform-invoices] session read', e.message); }
  }
  return null;
}
async function piSavePortalSession(channel, storageState, by) {
  const ch = String(channel || '').toLowerCase();
  if (ch !== 'airbnb' && ch !== 'booking') throw new Error('channel must be airbnb|booking');
  if (!storageState || typeof storageState !== 'object') throw new Error('storageState object required');
  const key = 'pi_portal_session_' + ch;
  const payload = {
    storageState,
    updatedAt: new Date().toISOString(),
    updatedBy: by || ''
  };
  if (pool) {
    await pool.query(
      `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
      [key, JSON.stringify(payload)]
    );
  }
  return payload;
}
async function piSessionMeta(channel) {
  const row = await piLoadPortalSession(channel);
  if (!row || !row.storageState) return { connected: false };
  return { connected: true, updatedAt: row.updatedAt || null, updatedBy: row.updatedBy || null };
}
async function piClearPortalSession(channel) {
  const ch = String(channel || '').toLowerCase();
  if (ch !== 'airbnb' && ch !== 'booking') return false;
  const key = 'pi_portal_session_' + ch;
  if (pool) {
    try { await pool.query('DELETE FROM app_data WHERE key=$1', [key]); return true; }
    catch (e) { console.error('[platform-invoices] clear session', e.message); return false; }
  }
  return false;
}
function piErrorsIndicateExpiredSession(errors, channel) {
  const ch = String(channel || '').toLowerCase();
  return (errors || []).some(function (e) {
    if (String((e && e.channel) || '').toLowerCase() !== ch) return false;
    const msg = String((e && (e.error || e.hint || '')) || '');
    return /session expired|reconnect .*session|Connect Airbnb session|OTP blocked|captcha\/unusual|MFA\/OTP/i.test(msg);
  });
}

app.get('/api/platform-invoices/status', async (req, res) => {
  let playwrightOk = false;
  try { require.resolve('playwright'); playwrightOk = true; } catch (e) {}
  const airbnbSession = await piSessionMeta('airbnb');
  const bookingSession = await piSessionMeta('booking');
  const airbnbCreds = !!(process.env.AIRBNB_HOST_EMAIL && process.env.AIRBNB_HOST_PASSWORD);
  const bookingCreds = !!(process.env.BOOKING_HOST_EMAIL && process.env.BOOKING_HOST_PASSWORD);
  const airbnbEnvSession = !!(process.env.AIRBNB_STORAGE_STATE_B64 || process.env.AIRBNB_STORAGE_STATE);
  const bookingEnvSession = !!(process.env.BOOKING_STORAGE_STATE_B64 || process.env.BOOKING_STORAGE_STATE);
  const airbnbReady = playwrightOk && (airbnbSession.connected || airbnbEnvSession || airbnbCreds);
  const bookingReady = playwrightOk && (bookingSession.connected || bookingEnvSession || bookingCreds);
  res.json({
    accountantEmail: PLATFORM_INV_ACCOUNTANT || null,
    airbnbConfigured: airbnbCreds || airbnbSession.connected || airbnbEnvSession,
    bookingConfigured: bookingCreds || bookingSession.connected || bookingEnvSession,
    airbnbSession,
    bookingSession,
    airbnbReady,
    bookingReady,
    pullAvailable: !!(airbnbReady || bookingReady),
    playwright: playwrightOk,
    bookingExtranet: 'https://admin.booking.com/',
    automation: 'pull-first',
    inAppConnectAirbnb: !!(playwrightOk && airbnbCreds),
    note: 'Automated pull. Booking.com = one invoice per apartment via admin.booking.com. Connect portal sessions once if captcha/OTP blocks password login; Pull refreshes sessions and downloads PDFs.'
  });
});
app.put('/api/platform-invoices/sessions/:channel', async (req, res) => {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    const b = req.body || {};
    let state = b.storageState;
    if (!state && b.storageStateB64) {
      state = JSON.parse(Buffer.from(String(b.storageStateB64), 'base64').toString('utf8'));
    }
    if (!state && typeof b.stateJson === 'string') state = JSON.parse(b.stateJson);
    if (!state || typeof state !== 'object') return res.status(400).json({ error: 'storageState or storageStateB64 required' });
    const saved = await piSavePortalSession(channel, state, req.acctUser || b.by || '');
    res.json({ ok: true, channel, updatedAt: saved.updatedAt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/platform-invoices/sessions/:channel', async (req, res) => {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    if (channel !== 'airbnb' && channel !== 'booking') return res.status(400).json({ error: 'channel must be airbnb|booking' });
    const key = 'pi_portal_session_' + channel;
    if (pool) await pool.query('DELETE FROM app_data WHERE key=$1', [key]);
    res.json({ ok: true, channel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── In-app Airbnb Connect (OTP in the UI — no laptop terminal) ───────────────
const _piLoginJobs = new Map();
const PI_LOGIN_TTL_MS = 30 * 60 * 1000;

function piOtpDiagnosticPublic(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const methods = { auto: true, button: true, enter: true, none: true };
  const events = Array.isArray(diag.events) ? diag.events.slice(-8).map(function (event) {
    const status = Number(event && event.status);
    const timestamp = Number(event && event.timestamp);
    const method = String((event && event.method) || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
    const submitMethod = String((event && event.submitMethod) || 'none').toLowerCase();
    return {
      path: String((event && event.path) || '').split(/[?#]/)[0].slice(0, 200),
      method: method,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      submitMethod: methods[submitMethod] ? submitMethod : 'none'
    };
  }) : [];
  const dom = diag.dom && typeof diag.dom === 'object' ? diag.dom : {};
  const submitMethod = String(dom.submitMethod || 'none').toLowerCase();
  return {
    events: events,
    dom: {
      inputVisible: dom.inputVisible === true,
      inputCount: Math.max(0, Math.min(20, Number(dom.inputCount) || 0)),
      formExists: dom.formExists === true,
      submitMethod: methods[submitMethod] ? submitMethod : 'none',
      validation: dom.validation === true
    }
  };
}

function piLoginPublic(job) {
  if (!job) return null;
  return {
    id: job.id,
    channel: job.channel,
    status: job.status,
    error: job.error || null,
    hint: job.hint || null,
    pageSnippet: job.pageSnippet || null,
    delivery: job.delivery || null,
    canEmail: !!job.canEmail,
    smsStuck: !!job.smsStuck,
    clickables: Array.isArray(job.clickables) ? job.clickables.slice(0, 24) : null,
    captcha: job.status === 'awaiting_captcha' ? {
      width: 1440,
      height: 900,
      rev: job.captchaRev || 0
    } : null,
    diagnostics: job.otpDiagnostic ? { otp: piOtpDiagnosticPublic(job.otpDiagnostic) } : null,
    interactive: job.page ? {
      width: 1440,
      height: 900,
      rev: job.interactiveRev || 0,
      url: (function () {
        try { return String(job.page.url() || '').replace(/[?#].*$/, '').slice(0, 200); }
        catch (e) { return ''; }
      })()
    } : null,
    sessionSaved: !!job._piSessionSaved,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
async function piLoginCleanup(job, keepPublic) {
  try { if (job && job.browser) await job.browser.close().catch(function () {}); } catch (e) {}
  if (job) {
    job.browser = null;
    job.context = null;
    job.page = null;
    if (!keepPublic) _piLoginJobs.delete(job.id);
  }
}
function piLoginSweep() {
  const now = Date.now();
  for (const [id, job] of _piLoginJobs.entries()) {
    if (now - (job.createdAt || now) > PI_LOGIN_TTL_MS) piLoginCleanup(job, false);
  }
}
(function () {
  const t = setInterval(piLoginSweep, 60000);
  if (t && typeof t.unref === 'function') t.unref();
})();

async function piAirbnbPageLooksLoggedIn(page) {
  const url = page.url();
  // Login footer contains the word "Hosting" — never treat body text as logged-in.
  if (/log.?in|sign.?in|authenticate/i.test(url)) return false;
  if (await page.locator('input[type="password"]:visible, #otp-code-input:visible, #phone-or-email:visible').count()) return false;
  const text = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
  if (/enter your password|log in to continue|try another way|verify that you.?re human/i.test(text) && !/airbnb\.com\/hosting/i.test(url)) return false;
  if (/airbnb\.com\/hosting(\/|$|\?)/i.test(url)) return true;
  if (/airbnb\.com\/(account(?:-settings)?|users\/show|become-a-host)(\/|$|\?)/i.test(url)) return true;
  const avatar = await page.locator('[data-testid="header-avatar"]:visible, [data-testid="cypress-headernav-profile"]:visible').count();
  return avatar > 0;
}
async function piAirbnbPageLooksReadyToSave(page) {
  const url = page.url();
  if (!url || !/airbnb\.com/i.test(url)) return false;
  if (await piAirbnbHasHumanCheck(page)) return false;
  if (await page.locator('input[type="password"]:visible, #otp-code-input:visible, #phone-or-email:visible').count()) return false;
  return true;
}
async function piAirbnbSaveLiveSession(job) {
  if (!job || !job.context) return false;
  const state = await job.context.storageState();
  const cookies = (state && Array.isArray(state.cookies)) ? state.cookies : [];
  if (cookies.length < 3) return false;
  await piSavePortalSession('airbnb', state, job.by || 'in-app-connect');
  job._piSessionSaved = true;
  job.updatedAt = Date.now();
  return true;
}
async function piAirbnbHarvestLiveJobs() {
  let saved = false;
  for (const job of _piLoginJobs.values()) {
    if (!job || !job.page || !job.context) continue;
    if (job.status === 'error' || job.status === 'starting' || job.status === 'logging_in') continue;
    try {
      await piAirbnbRunBrowserAction(job, async function () {
        if (await piAirbnbHasHumanCheck(job.page)) return;
        const ready = (await piAirbnbPageLooksLoggedIn(job.page)) || (await piAirbnbPageLooksReadyToSave(job.page));
        if (!ready) return;
        job._piOtpAccepted = true;
        saved = (await piAirbnbSaveLiveSession(job)) || saved;
        try {
          await piAirbnbFinishAndSave(job);
        } catch (eSave) {
          if (job._piSessionSaved) {
            job.status = 'connected';
            job.error = null;
            job.hint = 'Airbnb session saved from the in-app browser. You can Pull now.';
            job.updatedAt = Date.now();
          }
        }
      });
    } catch (eHarvest) {}
  }
  return saved;
}
async function piAirbnbNeedsOtp(page) {
  const otpVisible = await page.locator('#otp-code-input:visible, input[autocomplete="one-time-code"]:visible').count();
  return otpVisible > 0;
}
async function piAirbnbOtpDeliveryKind(page) {
  const text = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ').trim();
  if (await page.locator('#otp-code-input').count()) return 'email';
  if (/sent a code to\s+[\w.+-]+@[\w.-]+/i.test(text)) return 'email';
  if (/whats\s*app/i.test(text)) return 'whatsapp';
  if (/we texted|sent a text|texted a code|text message|\bsms\b/i.test(text)) return 'sms';
  if (/email/i.test(text) && !/we texted|sent a text|texted a code|text message|\bsms\b/i.test(text)) return 'email';
  return 'unknown';
}
async function piAirbnbOtpDeliveryHint(page, meta) {
  meta = meta || {};
  const text = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ').trim();
  const email = (text.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
  const phone = (text.match(/\*{2,}\d{2,4}|\d{2,3}\*{2,}\d{2,4}|ending in\s*\d{2,4}/i) || [])[0];
  const kind = meta.delivery || await piAirbnbOtpDeliveryKind(page);
  if (meta.smsStuck || (kind === 'sms' && meta.canEmail === false)) {
    return 'Airbnb still on SMS' + (phone ? (' (' + phone + ')') : '') +
      '. Tap Resend as email — Connect now forces Try another way → email when Airbnb offers it.';
  }
  if (kind === 'email') {
    return 'Airbnb usually emails this code' + (email ? (' to ' + email) : ' (check the host inbox + spam)') + '.';
  }
  if (kind === 'whatsapp') {
    return 'Airbnb says it sent a WhatsApp code' + (phone ? (' (' + phone + ')') : '') + '. Check WhatsApp on the host phone.';
  }
  if (kind === 'sms') {
    return 'Airbnb says it sent a text' + (phone ? (' (' + phone + ')') : '') +
      '. If it does not arrive within a minute, tap Resend as email — or Paste session JSON if email is not offered.';
  }
  return 'Check the Airbnb host email inbox first (and spam). SMS often does not arrive for this login.';
}
async function piAirbnbClickMatching(page, patterns, opts) {
  opts = opts || {};
  const maxLen = opts.maxLen || 100;
  const clicked = await page.evaluate(function (args) {
    var pats = args.patterns || [];
    var maxLen = args.maxLen || 100;
    function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
    var res = [];
    for (var i = 0; i < pats.length; i++) {
      try { res.push(new RegExp(pats[i], 'i')); } catch (e) {}
    }
    var nodes = Array.prototype.slice.call(document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], label, summary'
    ));
    var extras = Array.prototype.slice.call(document.querySelectorAll('div, span, p, li'));
    for (var e = 0; e < extras.length; e++) {
      var el = extras[e];
      var t0 = norm(el.innerText);
      if (!t0 || t0.length > maxLen) continue;
      if (el.childElementCount > 4) continue;
      nodes.push(el);
    }
    var seen = [];
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      if (!node || seen.indexOf(node) >= 0) continue;
      seen.push(node);
      var t = norm(node.innerText || node.textContent);
      if (!t || t.length > maxLen) continue;
      var ok = false;
      for (var r = 0; r < res.length; r++) {
        if (res[r].test(t)) { ok = true; break; }
      }
      if (!ok) continue;
      try {
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        node.click();
        return t;
      } catch (err) {}
    }
    return null;
  }, { patterns: patterns, maxLen: maxLen });
  if (clicked) await page.waitForTimeout(opts.wait || 1400);
  return clicked;
}
async function piAirbnbListClickables(page) {
  return page.evaluate(function () {
    function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
    var out = [];
    var nodes = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], label');
    for (var i = 0; i < nodes.length; i++) {
      var t = norm(nodes[i].innerText || nodes[i].textContent);
      if (!t || t.length > 80) continue;
      if (out.indexOf(t) < 0) out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  }).catch(function () { return []; });
}
async function piAirbnbOpenOtpOptions(page) {
  return !!(await piAirbnbClickMatching(page, [
    'more options', 'other options', 'try another', 'another way', 'another method',
    'get a code another', 'need help', "didn'?t get", 'did not get', "haven'?t received",
    'have not received', 'choose a different', 'different method', 'άλλες επιλογές',
    'άλλος τρόπος', 'δεν έλαβα', 'βοήθεια'
  ], { wait: 1200 }));
}
async function piAirbnbDismissOverlays(page) {
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(300);
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(200);
}
async function piAirbnbFillPassword(page, pass) {
  // Do not press Escape — that dismisses reCAPTCHA / Airlock.
  const modalClose = page.locator('#dls-modal-container [aria-label="Close"], [aria-label="Close"]').first();
  if (await modalClose.count()) await modalClose.click({ timeout: 2000 }).catch(function () {});
  const has = await page.locator('input[name="password"], input[type="password"]').count();
  if (!has) return false;
  const passInput = page.locator('input[name="password"], input[type="password"]').first();
  await passInput.click({ timeout: 4000 }).catch(function () {});
  await passInput.fill('', { force: true, timeout: 8000 }).catch(function () {});
  await passInput.pressSequentially(String(pass || ''), { delay: 28, force: true }).catch(async function () {
    await page.keyboard.type(String(pass || ''), { delay: 28 });
  });
  const cont = page.locator('button:has-text("Continue"), button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]').first();
  if (await cont.count()) await cont.click({ timeout: 5000 }).catch(function () {
    return cont.click({ force: true, timeout: 4000 });
  }).catch(function () {});
  await page.waitForTimeout(5000);
  return true;
}
async function piAirbnbHasHumanCheck(page) {
  const airlock = page.locator('#airlock-inline-container').first();
  if (await airlock.count() && await airlock.isVisible().catch(function () { return false; })) return true;
  const anchor = page.locator('iframe[src*="recaptcha/api2/anchor"]').first();
  if (await anchor.count() && await anchor.isVisible().catch(function () { return false; })) return true;
  const challenge = page.locator('iframe[src*="recaptcha/api2/bframe"]').first();
  if (await challenge.count()) {
    const box = await challenge.boundingBox().catch(function () { return null; });
    if (box && box.y >= 0 && box.width > 100 && box.height > 100) return true;
  }
  const t = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
  return /verify that you.?re human|select all images|click verify/i.test(t);
}
async function piAirbnbPassHumanCheck(page) {
  if (!(await piAirbnbHasHumanCheck(page))) return false;
  const modalClose = page.locator('#dls-modal-container [aria-label="Close"], [aria-label="Close"]').first();
  if (await modalClose.count()) await modalClose.click({ timeout: 2500 }).catch(function () {});
  await page.waitForTimeout(500);
  const box = page.frameLocator('iframe[src*="recaptcha/api2/anchor"]').first();
  try {
    await box.locator('#recaptcha-anchor').click({ timeout: 6000 });
  } catch (e) {
    await box.locator('.recaptcha-checkbox-border').click({ timeout: 4000 }).catch(function () {});
  }
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (await page.locator('#otp-code-input').count()) return true;
    const checked = await box.locator('#recaptcha-anchor').getAttribute('aria-checked').catch(function () { return null; });
    if (checked === 'true') return true;
    const bf = page.locator('iframe[src*="recaptcha/api2/bframe"]').first();
    const geom = await bf.boundingBox().catch(function () { return null; });
    if (geom && geom.y > 0 && geom.height > 120) return false;
    await page.waitForTimeout(500);
  }
  return false;
}
async function piAirbnbMarkAwaitingCaptcha(job) {
  if (!job || !job.page) return false;
  if (!(await piAirbnbHasHumanCheck(job.page))) return false;
  job.status = 'awaiting_captcha';
  job.error = null;
  job.hint = 'Airbnb needs a picture check. Click every matching picture in the image below, then click the blue Verify button inside the image.';
  job.captchaRev = (job.captchaRev || 0) + 1;
  job.updatedAt = Date.now();
  return true;
}
async function piAirbnbInteractiveSnapshot(job, hint) {
  if (!job || !job.page) return;
  job.interactiveRev = (job.interactiveRev || 0) + 1;
  job.updatedAt = Date.now();
  if (hint) job.hint = hint;
}
async function piAirbnbRunBrowserAction(job, fn) {
  const previous = job._piBrowserActionTail || Promise.resolve();
  let release;
  const thisAction = new Promise(function (resolve) { release = resolve; });
  job._piBrowserActionTail = thisAction;
  await previous.catch(function () {});
  try {
    return await fn();
  } finally {
    release();
  }
}
async function piAirbnbInteractiveAdvance(job) {
  if (!job || !job.page || job._piFinishing) return;
  const page = job.page;
  try {
    if (page.isClosed && page.isClosed()) return;
  } catch (eClosed) { return; }
  if ((await piAirbnbPageLooksLoggedIn(page)) || (await piAirbnbPageLooksReadyToSave(page))) {
    job._piFinishing = true;
    job._piOtpAccepted = true;
    try {
      await piAirbnbSaveLiveSession(job);
      await piAirbnbFinishAndSave(job);
    } catch (eSave) {
      job._piFinishing = false;
      if (job._piSessionSaved) {
        job.status = 'connected';
        job.error = null;
        job.hint = 'Airbnb session saved from the in-app browser. You can Pull now.';
        job.updatedAt = Date.now();
        return;
      }
      job._piOtpAccepted = false;
      job.status = 'interactive';
      job.error = null;
      await piAirbnbInteractiveSnapshot(job, 'Hosting was not confirmed yet. Keep operating Airbnb below until Hosting opens.');
    }
    return;
  }
  if (await piAirbnbHasHumanCheck(page)) {
    job.status = 'awaiting_captcha';
    job.error = null;
    await piAirbnbInteractiveSnapshot(job, 'Complete Airbnb verification directly in the interactive browser below.');
    return;
  }
  if ((await page.locator('#otp-code-input:visible').count().catch(function () { return 0; })) || (await piAirbnbNeedsOtp(page))) {
    job.status = 'awaiting_otp';
    job.error = null;
    await piAirbnbInteractiveSnapshot(job, 'Click the code field in the Airbnb screen, type the newest email code, then press Enter.');
    return;
  }
  job.status = 'interactive';
  job.error = null;
  await piAirbnbInteractiveSnapshot(job, 'Operate Airbnb directly below. Complete password/code prompts until Hosting opens.');
}
async function piAirbnbContinueAfterCaptcha(job) {
  const page = job.page;
  const settleUntil = Date.now() + 15000;
  while (true) {
    // A tile click normally leaves the challenge visible. Return it immediately;
    // only Verify removes the challenge and needs the longer settling window.
    if (await piAirbnbHasHumanCheck(page)) {
      await piAirbnbMarkAwaitingCaptcha(job);
      return;
    }
    if ((await page.locator('#otp-code-input').count()) || (await piAirbnbNeedsOtp(page))) {
      await piAirbnbMarkAwaitingOtp(job);
      return;
    }
    if (await piAirbnbPageLooksLoggedIn(page)) {
      job._piOtpAccepted = true;
      await piAirbnbFinishAndSave(job);
      return;
    }
    if (Date.now() >= settleUntil) break;
    job.status = 'starting';
    job.error = null;
    job.hint = 'Picture check completed. Waiting for Airbnb to continue the original email-code request…';
    job.updatedAt = Date.now();
    await page.waitForTimeout(400);
  }
  job.status = 'error';
  job.error = 'Airbnb accepted the picture check but did not continue the original email-code request. Click Try again to start a fresh Connect attempt.';
  job.hint = 'No additional email-code request was sent.';
  job.updatedAt = Date.now();
  await piLoginCleanup(job, true);
}
async function piAirbnbWaitForEmailOtpPage(page, ms) {
  const start = Date.now();
  while (Date.now() - start < (ms || 8000)) {
    if (await page.locator('#otp-code-input').count()) return true;
    const t = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
    if (/we sent a code to\s+[\w.+-]+@/i.test(t)) return true;
    await page.waitForTimeout(400);
  }
  return !!(await page.locator('#otp-code-input').count());
}
async function piAirbnbWaitForEmailOtpPage(page, ms) {
  const start = Date.now();
  while (Date.now() - start < (ms || 8000)) {
    if (await page.locator('#otp-code-input').count()) return true;
    const t = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
    if (/we sent a code to\s+[\w.+-]+@/i.test(t)) return true;
    await page.waitForTimeout(400);
  }
  return !!(await page.locator('#otp-code-input').count());
}
function piAirbnbAuthPath(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!/(^|\.)airbnb\.[a-z.]+$/i.test(parsed.hostname)) return '';
    const pathname = String(parsed.pathname || '');
    return /\/(?:api\/[^/]+\/)?auth(?:\/|$)/i.test(pathname) ? pathname.slice(0, 200) : '';
  } catch (e) { return ''; }
}
function piAirbnbRecordOtpAuthRequest(page, req) {
  if (!page || !page._piOtpCollecting) return;
  const path = piAirbnbAuthPath(req.url());
  if (!path) return;
  const event = {
    path: path,
    method: String(req.method() || '').toUpperCase(),
    status: null,
    timestamp: Date.now(),
    submitMethod: page._piOtpSubmitMethod || 'auto'
  };
  page._piOtpAuthEvents = (Array.isArray(page._piOtpAuthEvents) ? page._piOtpAuthEvents : []).concat([event]).slice(-8);
}
function piAirbnbRecordOtpAuthResponse(page, res) {
  if (!page || !page._piOtpCollecting) return;
  const path = piAirbnbAuthPath(res.url());
  if (!path) return;
  const method = String(res.request().method() || '').toUpperCase();
  const events = Array.isArray(page._piOtpAuthEvents) ? page._piOtpAuthEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].status == null && events[i].path === path && events[i].method === method) {
      events[i].status = res.status();
      return;
    }
  }
}
function piAirbnbArmEmailOtpGuard(page) {
  if (!page || page._piEmailOtpArmed) return;
  page._piEmailOtpArmed = true;
  page._piEmailOtpPosts = 0;
  page._piEmailOtpResponses = 0;
  page._piEmailOtpOk = 0;
  page._piEmailOtpLast = 0;
  page.on('request', function (req) {
    piAirbnbRecordOtpAuthRequest(page, req);
    if (req.method() === 'POST' && /\/api\/v2\/auth\/challenge\/email_otp/i.test(req.url())) {
      page._piEmailOtpPosts = (page._piEmailOtpPosts || 0) + 1;
    }
  });
  page.on('response', function (res) {
    piAirbnbRecordOtpAuthResponse(page, res);
    if (/\/api\/v2\/auth\/challenge\/email_otp/i.test(res.url())) {
      page._piEmailOtpResponses = (page._piEmailOtpResponses || 0) + 1;
      page._piEmailOtpLast = res.status();
      if (res.status() === 200) page._piEmailOtpOk = (page._piEmailOtpOk || 0) + 1;
    }
  });
}
async function piAirbnbPreferEmailDelivery(page, opts) {
  opts = opts || {};
  piAirbnbArmEmailOtpGuard(page);
  if (await page.locator('#otp-code-input').count()) return 'email';
  const t0 = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
  if (/we sent a code to\s+[\w.+-]+@/i.test(t0)) return 'email';
  if (!opts.retry && ((page._piEmailOtpOk || 0) > 0 || ((page._piEmailOtpPosts || 0) > 0 && page._piEmailOtpLast !== 420) || page._piPreferEmailClicked)) {
    return (await piAirbnbWaitForEmailOtpPage(page, 8000)) ? 'email' : null;
  }
  if (opts.retry) page._piPreferEmailClicked = false;

  var tryWay = page.locator('button:has-text("Try another way")').first();
  if (await tryWay.count()) {
    try {
      await tryWay.waitFor({ state: 'visible', timeout: 8000 });
      await tryWay.click({ timeout: 5000 });
    } catch (e) {
      await tryWay.click({ force: true, timeout: 4000 }).catch(function () {});
    }
  }
  var emailOpt = page.locator('[data-testid="fallback-option-email-otp"]').first();
  try {
    await emailOpt.waitFor({ state: 'visible', timeout: 8000 });
  } catch (e2) {
    emailOpt = page.getByText(/get a code via email/i).first();
  }
  if (await emailOpt.count()) {
    page._piPreferEmailClicked = true;
    try {
      await emailOpt.click({ timeout: 5000 });
    } catch (e3) {
      await emailOpt.click({ force: true, timeout: 4000 }).catch(function () {});
    }
    if (await piAirbnbWaitForEmailOtpPage(page, 12000)) return 'email';
  }
  return (await page.locator('#otp-code-input').count()) ? 'email' : null;
}
async function piAirbnbResendCode(page) {
  const body = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
  if (/wait 1 minute before requesting a code/i.test(body)) {
    return { ok: false, cooldown: true, status: page._piEmailOtpLast || 0 };
  }
  var sendNew = page.locator('button:has-text("send a new code"), a:has-text("send a new code")').first();
  if (!(await sendNew.count()) || !(await sendNew.isVisible().catch(function () { return false; }))) {
    return { ok: false, cooldown: false, status: 0 };
  }
  const beforeResponses = page._piEmailOtpResponses || 0;
  const beforeOk = page._piEmailOtpOk || 0;
  try {
    await sendNew.click({ timeout: 4000 });
  } catch (eClick) {
    return { ok: false, cooldown: false, status: 0 };
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && (page._piEmailOtpResponses || 0) <= beforeResponses) {
    await page.waitForTimeout(200);
  }
  const after = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
  const responded = (page._piEmailOtpResponses || 0) > beforeResponses;
  const accepted = responded && (page._piEmailOtpOk || 0) > beforeOk && page._piEmailOtpLast === 200;
  return {
    ok: accepted,
    cooldown: /wait 1 minute before requesting a code/i.test(after),
    status: responded ? (page._piEmailOtpLast || 0) : 0
  };
}
async function piAirbnbCaptureOtpDiagnostic(page, single) {
  const inputCount = await page.locator('#otp-code-input').count().catch(function () { return 0; });
  const inputVisible = inputCount > 0 && await page.locator('#otp-code-input').first().isVisible().catch(function () { return false; });
  const formExists = await single.evaluate(function (input) { return !!input.form; }).catch(function () { return false; });
  page._piOtpDiagnostic = {
    events: Array.isArray(page._piOtpAuthEvents) ? page._piOtpAuthEvents.slice(-8) : [],
    dom: {
      inputVisible: inputVisible,
      inputCount: inputCount,
      formExists: formExists,
      submitMethod: page._piOtpSubmitMethod || 'none',
      validation: page._piOtpValidationError === true
    }
  };
  page._piOtpCollecting = false;
}

async function piAirbnbFillOtp(page, otp) {
  const code = String(otp || '').replace(/\D/g, '');
  if (!code) throw new Error('Empty OTP');
  const single = page.locator('#otp-code-input').first();
  if (!(await single.count())) throw new Error('OTP input not found on Airbnb page');
  await single.waitFor({ state: 'visible', timeout: 8000 });
  page._piOtpAuthEvents = [];
  page._piOtpSubmitMethod = 'auto';
  page._piOtpValidationError = false;
  page._piOtpCollecting = true;
  // Do not press Escape — that leaves the email-code step. Trusted sequential
  // typing lets Airbnb's own input handlers auto-submit the completed code.
  await single.click({ force: true, timeout: 4000 }).catch(function () {});
  await single.fill('', { force: true }).catch(function () {});
  await single.pressSequentially(code, { delay: 90 });
  let got = String(await single.inputValue().catch(function () { return ''; })).replace(/\D/g, '');
  if (got !== code) {
    await single.click({ force: true }).catch(function () {});
    await page.keyboard.press('ControlOrMeta+A').catch(function () {});
    await page.keyboard.press('Backspace').catch(function () {});
    await page.keyboard.type(code, { delay: 90 });
    got = String(await single.inputValue().catch(function () { return ''; })).replace(/\D/g, '');
  }
  page._piOtpTyped = got;
  page._piOtpExpected = code;
  if (got !== code) {
    page._piOtpSubmitMethod = 'none';
    await piAirbnbCaptureOtpDiagnostic(page, single);
    return false;
  }

  // The final digit does not auto-submit every Airbnb variant. Prefer a visible,
  // enabled Continue/Submit in the active login modal (including sibling footers),
  // then a visible global control. Hidden password-page buttons are excluded.
  const submitSelector = 'button:visible:not([disabled]):not([aria-disabled="true"]), [role="button"]:visible:not([aria-disabled="true"])';
  let otpContinue = null;
  let otpScope = single.locator('xpath=ancestor::*[@id="dls-modal-container"][1]');
  if (!(await otpScope.count())) otpScope = single.locator('xpath=ancestor::*[@role="dialog"][1]');
  if (await otpScope.count()) {
    otpContinue = otpScope.locator(submitSelector).filter({ hasText: /^\s*(Continue|Submit)\s*$/i }).first();
  }
  if (!otpContinue || !(await otpContinue.count())) {
    otpContinue = page.locator(submitSelector).filter({ hasText: /^\s*(Continue|Submit)\s*$/i }).first();
  }
  let submitted = false;
  if (await otpContinue.count()) {
    page._piOtpSubmitMethod = 'button';
    try {
      await otpContinue.click({ timeout: 3000 });
      submitted = true;
    } catch (eClick) {
      page._piOtpSubmitMethod = (page._piOtpAuthEvents || []).length ? 'auto' : 'none';
    }
  }
  if (!submitted) {
    page._piOtpSubmitMethod = 'enter';
    try {
      await single.press('Enter', { timeout: 3000 });
      submitted = true;
    } catch (eEnter) {
      page._piOtpSubmitMethod = (page._piOtpAuthEvents || []).length ? 'auto' : 'none';
    }
  }
  page._piOtpSubmitted = submitted;

  // The password field stays mounted behind Airbnb's OTP modal, so it cannot
  // signal acceptance. Wait up to 15s for the OTP input itself to leave/hide,
  // or for navigation to the authenticated Hosting/account route.
  const otpUrl = page.url();
  try {
    await Promise.race([
      page.waitForFunction(function () {
        var el = document.querySelector('#otp-code-input');
        if (!el) return true;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return !rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden';
      }, null, { timeout: 15000 }),
      page.waitForURL(function (url) {
        return url.toString() !== otpUrl && /hosting|account/i.test(url.pathname);
      }, { timeout: 15000 })
    ]);
  } catch (e) {}
  const otpAlerts = await page.locator('[role="alert"]:visible, [aria-live="assertive"]:visible, [aria-live="polite"]:visible').allInnerTexts().catch(function () { return []; });
  const otpAlertText = otpAlerts.join(' ').replace(/\s+/g, ' ');
  page._piOtpValidationError = /(?:code|verification).{0,80}(?:incorrect|invalid|expired|doesn.t match|try again)|(?:incorrect|invalid|expired).{0,80}(?:code|verification)/i.test(otpAlertText);
  await piAirbnbCaptureOtpDiagnostic(page, single);
  return true;
}
async function piAirbnbSnapshotOtpMeta(job) {
  let delivery = await piAirbnbOtpDeliveryKind(job.page);
  job.delivery = delivery;
  job.canEmail = delivery === 'email';
  job.smsStuck = delivery === 'sms' && !job.canEmail;
  job.hint = await piAirbnbOtpDeliveryHint(job.page, {
    delivery: job.delivery,
    canEmail: job.canEmail,
    smsStuck: job.smsStuck
  });
  job.updatedAt = Date.now();
  try {
    job.pageSnippet = (await job.page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ').trim().slice(0, 320);
  } catch (e) { job.pageSnippet = ''; }
  try {
    job.clickables = await piAirbnbListClickables(job.page);
  } catch (e) { job.clickables = []; }
}
async function piAirbnbRefreshOtpMeta(job, opts) {
  opts = opts || {};
  // Never re-request email while already on email OTP unless explicitly forced (Resend)
  if (opts.forcePrefer) {
    await piAirbnbPreferEmailDelivery(job.page);
  }
  await piAirbnbSnapshotOtpMeta(job);
}
async function piAirbnbMarkAwaitingOtp(job) {
  // Snapshot only. PreferEmail must already have run exactly once in the worker.
  job.status = 'awaiting_otp';
  await piAirbnbSnapshotOtpMeta(job);
  if (await job.page.locator('#otp-code-input').count()) {
    job.hint = 'One code was emailed. Enter it below. Resend is locked for 1 minute — tapping it earlier will not send.';
  } else {
    job.hint = 'Airbnb did not show the email-code screen. Cancel and Connect once more.';
  }
}
async function piAirbnbFinishAndSave(job) {
  if (!job || !job._piOtpAccepted) {
    throw new Error('Airbnb Connect requires the email code. Enter it in Collect — do not Pull until the code is accepted.');
  }
  const page = job.page;
  const context = job.context;
  // Prefer staying on whatever Airbnb navigated to after auth; then open hosting
  await page.waitForTimeout(1500);
  if (await piAirbnbNeedsOtp(page)) {
    throw new Error('Still on Airbnb verification — enter the newest email code and Submit again.');
  }
  const targets = [
    'https://www.airbnb.com/hosting/reservations',
    'https://www.airbnb.com/hosting',
    'https://www.airbnb.com/hosting/today'
  ];
  let loggedIn = false;
  for (let t = 0; t < targets.length; t++) {
    await page.goto(targets[t], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(function () {});
    await page.waitForTimeout(2500);
    if (await piAirbnbNeedsOtp(page)) {
      throw new Error('Airbnb still wants a verification code after login. Enter the newest email code.');
    }
    if (await piAirbnbPageLooksLoggedIn(page)) { loggedIn = true; break; }
  }
  if (!loggedIn) {
    const url = page.url();
    const snip = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error('Airbnb login did not reach Hosting (url=' + url + '). ' + (snip || 'Check credentials/OTP and try again.'));
  }
  const state = await context.storageState();
  await piSavePortalSession('airbnb', state, job.by || 'in-app-connect');
  job.status = 'connected';
  job.updatedAt = Date.now();
  job.hint = 'Airbnb connected. You can Pull now.';
  await piLoginCleanup(job, true);
}
async function piAirbnbLaunchBrowser(pw) {
  const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'];
  const proxy = process.env.PLAYWRIGHT_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const opts = { headless: true, args: args };
  if (proxy) opts.proxy = { server: proxy };
  try {
    return await pw.chromium.launch(Object.assign({}, opts, { channel: 'chrome' }));
  } catch (e) {
    return await pw.chromium.launch(opts);
  }
}
async function piAirbnbNewContext(browser) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: process.env.PI_AIRBNB_TZ || 'Europe/Athens',
    geolocation: { latitude: 37.9838, longitude: 23.7275 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  await context.addInitScript(function () {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
    window.chrome = { runtime: {} };
  });
  return context;
}
async function piAirbnbLoginWorker(job) {
  const email = process.env.AIRBNB_HOST_EMAIL || '';
  const pass = process.env.AIRBNB_HOST_PASSWORD || '';
  let pw;
  try { pw = require('playwright'); } catch (e) {
    job.status = 'error';
    job.error = 'playwright is not installed on this deploy';
    job.updatedAt = Date.now();
    return;
  }
  try {
    job.status = 'starting';
    job.updatedAt = Date.now();
    const browser = await piAirbnbLaunchBrowser(pw);
    job.browser = browser;
    const context = await piAirbnbNewContext(browser);
    job.context = context;
    const page = await context.newPage();
    job.page = page;
    piAirbnbArmEmailOtpGuard(page);

    await page.goto('https://www.airbnb.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(1500);
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Accept all")', 'button:has-text("OK")', '[data-testid="accept-btn"]']) {
      const b = page.locator(sel).first();
      if (await b.count()) await b.click({ timeout: 2000 }).catch(function () {});
    }
    const emailInput = page.locator('#phone-or-email, input[name="email"], input[type="email"], input[autocomplete="username"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.click();
    await emailInput.fill('');
    await emailInput.type(email, { delay: 35 });
    await page.locator('button:has-text("Continue"), button[type="submit"]').first().click();
    try {
      await Promise.race([
        page.locator('button:has-text("Try another way")').first().waitFor({ state: 'visible', timeout: 20000 }),
        page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 20000 }),
        page.locator('#otp-code-input').first().waitFor({ state: 'visible', timeout: 20000 })
      ]);
    } catch (eWait) {}
    await page.waitForTimeout(2500);

    async function piAirbnbAwaitOtpOrDone() {
      if ((await page.locator('#otp-code-input').count()) || (await piAirbnbNeedsOtp(page))) {
        await piAirbnbMarkAwaitingOtp(job);
        return true;
      }
      if (await piAirbnbPageLooksLoggedIn(page)) {
        job._piOtpAccepted = true;
        await piAirbnbFinishAndSave(job);
        return true;
      }
      return false;
    }

    if (await piAirbnbAwaitOtpOrDone()) return;

    // Do not stop at the old "Signing in with the host password…" path.
    // Exactly one Get-a-code-via-email click for this job. Airbnb may answer
    // with a visible reCAPTCHA; keep that
    // browser alive and relay the picture grid into Collect instead of failing.
    job.hint = 'Opening Get a code via email…';
    job.updatedAt = Date.now();
    await piAirbnbPreferEmailDelivery(page);
    if (await piAirbnbAwaitOtpOrDone()) return;
    if (await piAirbnbHasHumanCheck(page) || page._piEmailOtpLast === 420) {
      const passed = await piAirbnbPassHumanCheck(page);
      if (await piAirbnbAwaitOtpOrDone()) return;
      if (passed) {
        await piAirbnbPreferEmailDelivery(page, { retry: true });
        if (await piAirbnbAwaitOtpOrDone()) return;
      }
      if (await piAirbnbMarkAwaitingCaptcha(job)) return;
    }

    const bodyText = (await page.locator('body').innerText().catch(function () { return ''; })).replace(/\s+/g, ' ');
    job.pageSnippet = bodyText.slice(0, 320);
    try { job.clickables = await piAirbnbListClickables(page); } catch (eC) { job.clickables = []; }
    // Keep the server-owned browser alive for direct user operation instead of
    // failing on an Airbnb page variant automation does not understand.
    job.status = 'interactive';
    job.error = null;
    job.pageSnippet = bodyText.slice(0, 320);
    job.hint = 'Operate Airbnb directly below. Complete password/code prompts until Hosting opens.';
    await piAirbnbInteractiveSnapshot(job);
    return;
    if (/select all images|click verify/i.test(bodyText)) {
      throw new Error('Airbnb showed a picture check. Wait a minute, Cancel, and Connect again — do not Pull until Connect asks for the email code.');
    }
    if (/airlock|arkose|security check|unusual activity|captcha|verify that you.?re human/i.test(bodyText) || page._piEmailOtpLast === 420) {
      throw new Error('Airbnb blocked this login (bot check). Cancel and Connect again — do not Pull until Connect asks for the email code.');
    }
    if (await page.locator('input[type="password"], #phone-or-email').count() || /enter your password|try another way/i.test(bodyText)) {
      throw new Error('Airbnb is still on login (no email code screen). Cancel and Connect again — do not Pull until Connect asks for the email code and reaches Hosting.');
    }
    throw new Error('Airbnb did not open the email-code screen. Cancel and Connect again. Do not Pull until Connect asks for a code.');
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
    job.updatedAt = Date.now();
    await piLoginCleanup(job, true);
  }
}

app.post('/api/platform-invoices/sessions/airbnb/login', async (req, res) => {
  try {
    piLoginSweep();
    if (!(process.env.AIRBNB_HOST_EMAIL && process.env.AIRBNB_HOST_PASSWORD)) {
      return res.status(503).json({
        error: 'Airbnb host credentials not configured on the server',
        hint: 'Set AIRBNB_HOST_EMAIL and AIRBNB_HOST_PASSWORD on Railway.'
      });
    }
    let playwrightOk = false;
    try { require.resolve('playwright'); playwrightOk = true; } catch (e) {}
    if (!playwrightOk) return res.status(503).json({ error: 'playwright is not installed on this deploy' });

    for (const job of _piLoginJobs.values()) {
      if (job.status === 'starting' || job.status === 'awaiting_otp' || job.status === 'awaiting_captcha' || job.status === 'logging_in' || job.status === 'interactive') {
        return res.json({ ok: true, job: piLoginPublic(job), resumed: true });
      }
    }
    const jobId = 'al' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const job = {
      id: jobId,
      channel: 'airbnb',
      status: 'starting',
      error: null,
      hint: 'Starting Airbnb login…',
      by: req.acctUser || (req.body && req.body.by) || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      browser: null,
      context: null,
      page: null
    };
    _piLoginJobs.set(jobId, job);
    piAirbnbLoginWorker(job);
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/platform-invoices/sessions/airbnb/login/:jobId', async (req, res) => {
  piLoginSweep();
  const job = _piLoginJobs.get(String(req.params.jobId || ''));
  if (!job) return res.status(404).json({ error: 'Login job not found or expired — start Connect again' });
  if (job.page && (job.status === 'interactive' || job.status === 'awaiting_otp' || job.status === 'awaiting_captcha')) {
    try {
      await piAirbnbRunBrowserAction(job, async function () { await piAirbnbInteractiveAdvance(job); });
    } catch (eAdvance) {}
  }
  res.json({ ok: true, job: piLoginPublic(job) });
});

app.get('/api/platform-invoices/sessions/airbnb/login/:jobId/browser.png', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(404).json({ error: 'No active Airbnb browser' });
    const png = await piAirbnbRunBrowserAction(job, async function () {
      return await job.page.screenshot({ type: 'png' });
    });
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('png').send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/click', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(409).json({ error: 'No active Airbnb browser', job: piLoginPublic(job) });
    const x = Number(req.body && req.body.x);
    const y = Number(req.body && req.body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1440 || y < 0 || y > 900) {
      return res.status(400).json({ error: 'Invalid browser coordinates' });
    }
    await piAirbnbRunBrowserAction(job, async function () {
      await job.page.mouse.click(x, y);
      await job.page.waitForTimeout(350);
      await piAirbnbInteractiveAdvance(job);
    });
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/type', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(409).json({ error: 'No active Airbnb browser', job: piLoginPublic(job) });
    const text = String((req.body && req.body.text) || '');
    if (!text || text.length > 256) return res.status(400).json({ error: 'Type 1-256 characters' });
    await piAirbnbRunBrowserAction(job, async function () {
      await job.page.keyboard.type(text, { delay: 45 });
      await job.page.waitForTimeout(350);
      await piAirbnbInteractiveAdvance(job);
    });
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/key', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(409).json({ error: 'No active Airbnb browser', job: piLoginPublic(job) });
    const key = String((req.body && req.body.key) || '');
    const allowed = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (allowed.indexOf(key) < 0) return res.status(400).json({ error: 'Unsupported browser key' });
    await piAirbnbRunBrowserAction(job, async function () {
      await job.page.keyboard.press(key);
      await job.page.waitForTimeout(500);
      await piAirbnbInteractiveAdvance(job);
    });
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/save', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(409).json({ error: 'No active Airbnb browser', job: piLoginPublic(job) });
    await piAirbnbRunBrowserAction(job, async function () {
      job._piOtpAccepted = true;
      await piAirbnbSaveLiveSession(job);
      try { await piAirbnbFinishAndSave(job); } catch (eSave) {
        if (job._piSessionSaved) {
          job.status = 'connected';
          job.error = null;
          job.hint = 'Airbnb session saved from the in-app browser. You can Pull now.';
          job.updatedAt = Date.now();
        } else {
          throw eSave;
        }
      }
    });
    if (!job._piSessionSaved && job.status !== 'connected') {
      return res.status(409).json({ error: 'Airbnb is not logged in yet — pass the code screen first', job: piLoginPublic(job) });
    }
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/refresh', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || !job.page) return res.status(409).json({ error: 'No active Airbnb browser', job: piLoginPublic(job) });
    await piAirbnbRunBrowserAction(job, async function () { await piAirbnbInteractiveAdvance(job); });
    res.json({ ok: true, job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/platform-invoices/sessions/airbnb/login/:jobId/captcha.png', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job || job.status !== 'awaiting_captcha' || !job.page) {
      return res.status(404).json({ error: 'No active Airbnb picture check' });
    }
    const png = await job.page.screenshot({ type: 'png' });
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('png').send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function piAirbnbCaptchaClickIsVerify(page, x, y) {
  const frames = page.frames().slice().reverse();
  for (const frame of frames) {
    if (!/recaptcha.*\/bframe/i.test(frame.url())) continue;
    const verify = frame.locator('#recaptcha-verify-button').first();
    if (!(await verify.count()) || !(await verify.isVisible().catch(function () { return false; }))) continue;
    const box = await verify.boundingBox().catch(function () { return null; });
    if (box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return true;
  }
  return false;
}

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/captcha/click', async (req, res) => {
  const job = _piLoginJobs.get(String(req.params.jobId || ''));
  if (!job || !job.page) {
    return res.status(409).json({ error: 'Job is not waiting for a picture check', job: piLoginPublic(job) });
  }
  const previousClick = job._piCaptchaClickTail || Promise.resolve();
  let releaseClick;
  const thisClick = new Promise(function (resolve) { releaseClick = resolve; });
  job._piCaptchaClickTail = thisClick;
  await previousClick.catch(function () {});
  try {
    if (job.status !== 'awaiting_captcha' || !job.page) {
      return res.status(409).json({ error: 'Picture check changed while this click was queued', job: piLoginPublic(job) });
    }
    const x = Number(req.body && req.body.x);
    const y = Number(req.body && req.body.y);
    const verifyHint = req.body && req.body.captchaVerify;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1440 || y < 0 || y > 900) {
      return res.status(400).json({ error: 'Invalid picture-check coordinates' });
    }
    if (verifyHint !== undefined && typeof verifyHint !== 'boolean') {
      return res.status(400).json({ error: 'Invalid picture-check Verify hint' });
    }
    const captchaVerify = verifyHint === true || await piAirbnbCaptchaClickIsVerify(job.page, x, y);
    job.hint = captchaVerify ? 'Checking your picture answer with Airbnb…' : 'Applying your picture selection…';
    job.updatedAt = Date.now();
    await job.page.mouse.click(x, y);
    if (captchaVerify) {
      await job.page.waitForTimeout(1800);
      await piAirbnbContinueAfterCaptcha(job);
    } else {
      await job.page.waitForTimeout(400);
      job.status = 'awaiting_captcha';
      job.error = null;
      job.hint = 'Selection registered. Continue choosing matching pictures, then click Verify.';
      job.updatedAt = Date.now();
    }
    res.json({ ok: true, captchaVerify: captchaVerify, job: piLoginPublic(job) });
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
    job.updatedAt = Date.now();
    await piLoginCleanup(job, true);
    res.status(500).json({ error: e.message, job: piLoginPublic(job) });
  } finally {
    releaseClick();
    if (job._piCaptchaClickTail === thisClick) delete job._piCaptchaClickTail;
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/otp', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Login job not found or expired — start Connect again' });
    if (job.status !== 'awaiting_otp') {
      return res.status(409).json({ error: 'Job is not waiting for OTP', job: piLoginPublic(job) });
    }
    const otp = String((req.body && (req.body.otp || req.body.code)) || '').trim();
    if (!/^\d{4,8}$/.test(otp)) return res.status(400).json({ error: 'Enter the 4–8 digit Airbnb code' });
    job.status = 'logging_in';
    job.hint = 'Submitting code…';
    job.updatedAt = Date.now();
    try {
      await piAirbnbFillOtp(job.page, otp);
      job.otpDiagnostic = job.page._piOtpDiagnostic || null;
      if (await piAirbnbNeedsOtp(job.page)) {
        // Snapshot only — never Prefer/Resend here (that emails a new code and invalidates the one just typed)
        await piAirbnbSnapshotOtpMeta(job);
        job.status = 'awaiting_otp';
        const typed = String(job.page._piOtpTyped || '');
        const expected = String(job.page._piOtpExpected || otp).replace(/\D/g, '');
        if (typed !== expected) {
          job.hint = 'Could not type that code into Airbnb. Submit the same code again (do not Resend yet).';
        } else if (job.page._piOtpValidationError) {
          job.hint = 'Airbnb says that code is invalid or expired. Enter only the newest email code; request a new code manually only if needed.';
        } else if (job.page._piOtpSubmitted) {
          job.hint = 'Airbnb is still showing the code screen without an invalid-code message. Submit the same newest code once more; do not Resend yet.';
        } else {
          job.hint = 'The digits reached Airbnb, but the code screen could not be submitted. Submit the same newest code again; do not Resend yet.';
        }
        job.updatedAt = Date.now();
        return res.json({ ok: true, job: piLoginPublic(job) });
      }
      const pass = process.env.AIRBNB_HOST_PASSWORD || '';
      if (await job.page.locator('input[name="password"]:visible, input[type="password"]:visible').count()) {
        await piAirbnbFillPassword(job.page, pass);
      }
      if (await piAirbnbNeedsOtp(job.page)) {
        await piAirbnbSnapshotOtpMeta(job);
        job.status = 'awaiting_otp';
        job.hint = 'Airbnb still wants a code after password. Wait a full minute, tap Resend once, then enter only the new email.';
        job.updatedAt = Date.now();
        return res.json({ ok: true, job: piLoginPublic(job) });
      }
      job._piOtpAccepted = true;
      await piAirbnbFinishAndSave(job);
      return res.json({ ok: true, job: piLoginPublic(job) });
    } catch (e) {
      job.status = 'error';
      job.error = e.message || String(e);
      job.updatedAt = Date.now();
      await piLoginCleanup(job, true);
      return res.status(500).json({ error: job.error, job: piLoginPublic(job) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/resend', async (req, res) => {
  try {
    const job = _piLoginJobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Login job not found or expired — start Connect again' });
    if (job.status !== 'awaiting_otp' || !job.page) {
      return res.status(409).json({ error: 'Job is not waiting for a code', job: piLoginPublic(job) });
    }
    const result = await piAirbnbResendCode(job.page);
    await piAirbnbSnapshotOtpMeta(job);
    if (result && result.cooldown) {
      job.hint = 'Airbnb will not email another code yet — do not Resend (Airbnb often waits 1 minute and will not send).';
    } else if (result && result.ok && !result.cooldown) {
      job.hint = 'Asked Airbnb for one new email. Enter only that newest code; older emails will not work.';
    } else {
      job.hint = result && result.status
        ? ('Airbnb did not accept the resend request (status ' + result.status + '). Do not keep clicking Resend; wait and use the newest email already received.')
        : 'Airbnb did not confirm a new email was sent. Do not keep clicking Resend; wait a full minute before trying once.';
    }
    job.updatedAt = Date.now();
    res.json({ ok: true, resent: !!(result && result.ok && !result.cooldown), cooldown: !!(result && result.cooldown), job: piLoginPublic(job) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/cancel', async (req, res) => {
  const job = _piLoginJobs.get(String(req.params.jobId || ''));
  if (job) await piLoginCleanup(job, false);
  res.json({ ok: true });
});


app.get('/api/platform-invoices', async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
  if (pool) {
    try {
      await ensurePlatInvTable();
      const r = await pool.query(
        `SELECT id, month, channel, scope, partner, filename, mime, size, source, uploaded_by, created_at
         FROM platform_invoices WHERE month=$1 ORDER BY channel, partner, filename, id`, [month]);
      return res.json({ ok: true, month, items: r.rows.map(platInvMeta) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const items = [..._memPlatInv.values()].filter(x => x.month === month).map(platInvMeta);
  res.json({ ok: true, month, items, db: false });
});
app.get('/api/platform-invoices/:id/file', async (req, res) => {
  const id = req.params.id;
  function sendPdf(row) {
    if (!row) return res.status(404).json({ error: 'not found' });
    const buf = platInvPdfBuffer(row);
    if (!buf.length) return res.status(404).json({ error: 'empty file' });
    const leaf = platInvFileLeaf(row).replace(/"/g, '');
    res.setHeader('Content-Type', row.mime || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + leaf + '"');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.end(buf);
  }
  if (pool && /^\d+$/.test(id)) {
    try {
      await ensurePlatInvTable();
      const r = await pool.query('SELECT id, filename, mime, data FROM platform_invoices WHERE id=$1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      return sendPdf(r.rows[0]);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const row = _memPlatInv.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  return sendPdf(row);
});
app.post('/api/platform-invoices', async (req, res) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(b.month || '')) return res.status(400).json({ error: 'Invalid month' });
  const channel = String(b.channel || '').toLowerCase();
  const scope = String(b.scope || '').toLowerCase();
  if (channel !== 'airbnb' && channel !== 'booking') return res.status(400).json({ error: 'channel must be airbnb|booking' });
  if (scope !== 'leased' && scope !== 'b2b') return res.status(400).json({ error: 'scope must be leased|b2b' });
  if (!b.dataB64 || typeof b.dataB64 !== 'string') return res.status(400).json({ error: 'Missing file data' });
  if (b.dataB64.length > PLATFORM_INV_MAX_B64) return res.status(413).json({ error: 'File too large' });
  const row = {
    month: b.month, channel, scope, partner: String(b.partner || '').slice(0, 120),
    filename: b.name || (channel + '.pdf'), mime: b.mime || 'application/pdf',
    size: parseInt(b.size, 10) || null, source: b.source || 'upload',
    uploaded_by: b.by || req.acctUser || '', data: b.dataB64
  };
  if (pool) {
    try {
      await ensurePlatInvTable();
      const r = await pool.query(
        `INSERT INTO platform_invoices (month, channel, scope, partner, filename, mime, size, source, uploaded_by, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
        [row.month, row.channel, row.scope, row.partner, row.filename, row.mime, row.size, row.source, row.uploaded_by, row.data]);
      return res.json({ ok: true, id: r.rows[0].id, createdAt: r.rows[0].created_at });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const id = 'p' + (_memPlatInvSeq++);
  _memPlatInv.set(id, { ...row, id, created_at: new Date().toISOString() });
  res.json({ ok: true, id, db: false });
});
app.patch('/api/platform-invoices/:id', async (req, res) => {
  const id = req.params.id;
  const partner = String((req.body && req.body.partner) || '').slice(0, 120);
  if (!id) return res.status(400).json({ error: 'id required' });
  if (pool && /^\d+$/.test(id)) {
    try {
      await ensurePlatInvTable();
      const r = await pool.query(
        'UPDATE platform_invoices SET partner=$1 WHERE id=$2 RETURNING id, partner, channel, filename',
        [partner, id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, item: platInvMeta(r.rows[0]) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const row = _memPlatInv.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  row.partner = partner;
  _memPlatInv.set(id, row);
  res.json({ ok: true, item: platInvMeta(row), db: false });
});
app.delete('/api/platform-invoices/:id', async (req, res) => {
  const id = req.params.id;
  if (pool && /^\d+$/.test(id)) {
    try {
      await ensurePlatInvTable();
      await pool.query('DELETE FROM platform_invoices WHERE id=$1', [id]);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (_memPlatInv.delete(id)) return res.json({ ok: true });
  res.status(404).json({ error: 'not found' });
});
app.post('/api/platform-invoices/send', async (req, res) => {
  try {
    if (!emailConfigured()) return res.status(503).json({ error: 'Email is not configured' });
    const b = req.body || {};
    const month = String(b.month || '');
    const scope = String(b.scope || '').toLowerCase();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
    if (scope !== 'leased' && scope !== 'b2b') return res.status(400).json({ error: 'scope must be leased|b2b' });
    let to = emailSplitAddrs(b.to);
    if (!to.length && scope === 'leased' && PLATFORM_INV_ACCOUNTANT) to = emailSplitAddrs(PLATFORM_INV_ACCOUNTANT);
    if (!to.length) return res.status(400).json({ error: 'No recipient (set to= or PLATFORM_INVOICE_ACCOUNTANT_EMAIL)' });
    const partner = String(b.partner || '');
    let rows = [];
    if (pool) {
      await ensurePlatInvTable();
      const q = partner
        ? await pool.query(`SELECT * FROM platform_invoices WHERE month=$1 AND scope=$2 AND partner=$3`, [month, scope, partner])
        : await pool.query(`SELECT * FROM platform_invoices WHERE month=$1 AND scope=$2`, [month, scope]);
      rows = q.rows;
    } else {
      rows = [..._memPlatInv.values()].filter(x => x.month === month && x.scope === scope && (!partner || x.partner === partner));
    }
    if (!rows.length) return res.status(400).json({ error: 'No invoices in this pack yet — upload or pull first' });
    rows.sort(function (a, b) {
      return String(a.channel || '').localeCompare(String(b.channel || '')) ||
        String(a.partner || '').localeCompare(String(b.partner || '')) ||
        String(a.filename || '').localeCompare(String(b.filename || ''));
    });
    let bytes = 0;
    const mailAtts = [];
    for (const r of rows) {
      const buf = Buffer.from(r.data, 'base64'); bytes += buf.length;
      mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: buf, contentType: r.mime || 'application/pdf' });
    }
    if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: 'Pack too large for one email' });
    const label = scope === 'leased'
      ? ('Elysian leased units — Airbnb/Booking.com invoices ' + month)
      : ('B2B platform invoices ' + month + (partner ? (' — ' + partner) : ''));
    const transporter = nodemailer.createTransport({
      host: EMAIL.host, port: EMAIL.port, secure: EMAIL.secure,
      auth: { user: EMAIL.user, pass: EMAIL.pass },
    });
    const info = await transporter.sendMail({
      from: EMAIL.from,
      to: to.join(', '),
      subject: b.subject || label,
      text: b.text || ('Attached: ' + rows.length + ' platform invoice(s) for ' + month + ' (' + scope + ').\n\nThese are Airbnb/Booking.com host invoices (ενδοκοινοτικά), not Greek domestic expenses.\n\n— Elysian Clearing'),
      attachments: mailAtts,
    });
    console.log('[platform-invoices] sent', month, scope, rows.length, '→', to.join(','));
    res.json({ ok: true, count: rows.length, messageId: info.messageId, to });
  } catch (e) {
    console.error('[platform-invoices] send', e.message);
    res.status(500).json({ error: e.message });
  }
});
function piYmFromUnix(t) {
  if (t == null || t === '') return '';
  let n = Number(t);
  if (!isFinite(n)) { const s = String(t); return s.length >= 7 ? s.slice(0, 7) : ''; }
  if (n < 1e12) n *= 1000;
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function piNormAirbnbCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9]{6,20}$/.test(code) ? code : '';
}
function piAirbnbCreatedMs(r) {
  const raw = r && r.createdOnChannel != null && r.createdOnChannel !== '' ? r.createdOnChannel : (r && r.created);
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(raw));
  return isFinite(parsed) ? parsed : 0;
}
function piSortAirbnbReservationsLatest(list) {
  return (list || []).slice().sort(function (a, b) { return piAirbnbCreatedMs(b) - piAirbnbCreatedMs(a); });
}
function piAirbnbRowsFromBookings(month, bks) {
  const inv = [], credit = [], missing = [];
  (bks || []).forEach(function (b) {
    const plat = String((b && (b.platform || b.channel)) || '').toLowerCase();
    if (plat.indexOf('air') < 0) return;
    const createdYm = piYmFromUnix(b.createdOnChannel != null ? b.createdOnChannel : b.created);
    const cancelYm = piYmFromUnix(b.cancelledAt);
    const code = piNormAirbnbCode(b.reservationId || b.reservation_id || b.confirmationCode || '');
    const row = {
      code: code,
      aptId: String((b && b.aptId) || '').trim(),
      aptName: String((b && b.aptName) || '').trim(),
      guestName: String((b && b.guestName) || '').trim(),
      hosthubId: String((b && b.id) || '').trim(),
      created: b && b.created != null ? b.created : null,
      createdOnChannel: b && b.createdOnChannel != null ? b.createdOnChannel : (b && b.created_on_channel != null ? b.created_on_channel : null)
    };
    if (createdYm === month) {
      if (code) inv.push(Object.assign({}, row, { kind: 'invoice' }));
      else missing.push(Object.assign({}, row, { kind: 'invoice' }));
    }
    if (b && b.cancelled && cancelYm === month) {
      if (code) credit.push(Object.assign({}, row, { kind: 'credit_note' }));
      else missing.push(Object.assign({}, row, { kind: 'credit_note' }));
    }
  });
  return { inv: inv, credit: credit, missing: missing };
}
async function piLoadDbBookings() {
  if (!pool) return [];
  try {
    const r = await pool.query("SELECT data FROM app_data WHERE key='main'");
    const data = r.rows[0] && r.rows[0].data;
    return (data && Array.isArray(data.bks)) ? data.bks : [];
  } catch (e) {
    return [];
  }
}
async function piPersistReservationIds(updates) {
  if (!pool || !updates || !updates.length) return 0;
  try {
    const r = await pool.query("SELECT data FROM app_data WHERE key='main'");
    if (!r.rows.length) return 0;
    const data = r.rows[0].data || {};
    const bks = Array.isArray(data.bks) ? data.bks : [];
    const byId = {};
    updates.forEach(function (u) { if (u.hosthubId && u.code) byId[u.hosthubId] = u.code; });
    let n = 0;
    bks.forEach(function (b) {
      const id = String(b.id || '');
      if (byId[id] && !piNormAirbnbCode(b.reservationId)) {
        b.reservationId = byId[id];
        n++;
      }
    });
    if (!n) return 0;
    data.bks = bks;
    await pool.query("UPDATE app_data SET data=$1, updated_at=NOW() WHERE key='main'", [data]);
    return n;
  } catch (e) {
    console.error('[platform-invoices] persist reservationId', e.message);
    return 0;
  }
}
async function piBackfillAirbnbCodesFromHosthub(rows) {
  const apiKey = SERVER_API_KEY;
  if (!apiKey) return { rows: rows || [], fetched: 0, error: 'HOSTHUB_API_KEY not set on server' };
  const out = [];
  let fetched = 0;
  for (const row of (rows || [])) {
    if (piNormAirbnbCode(row.code) || !row.hosthubId) { out.push(row); continue; }
    try {
      const r = await fetch(BASE + '/calendar-events/' + encodeURIComponent(row.hosthubId), { headers: hhH(apiKey) });
      if (!r.ok) { out.push(row); continue; }
      const ev = await r.json();
      const code = piNormAirbnbCode(ev.reservation_id || ev.reservationId || (ev.source && (ev.source.reservation_id || ev.source.confirmation_code)));
      fetched++;
      out.push(Object.assign({}, row, { code: code || '' }));
    } catch (e) {
      out.push(row);
    }
  }
  return { rows: out, fetched: fetched };
}
async function piResolveAirbnbReservations(month, clientList) {
  const client = (Array.isArray(clientList) ? clientList : []).filter(function (x) { return piNormAirbnbCode(x && x.code); });
  if (client.length) {
    return { reservations: client.map(function (x) {
      return {
        code: piNormAirbnbCode(x.code),
        kind: String(x.kind || 'invoice').toLowerCase(),
        aptId: String(x.aptId || '').trim(),
        aptName: String(x.aptName || '').trim(),
        guestName: String(x.guestName || '').trim(),
        hosthubId: String(x.hosthubId || '').trim(),
        created: x.created != null ? x.created : null,
        createdOnChannel: x.createdOnChannel != null ? x.createdOnChannel : null
      };
    }), source: 'client', missing: 0, persisted: 0 };
  }
  const dbBks = await piLoadDbBookings();
  let built = piAirbnbRowsFromBookings(month, dbBks);
  let rows = built.inv.concat(built.credit).concat(built.missing);
  const beforeMissing = built.missing.length;
  if (beforeMissing) {
    const bf = await piBackfillAirbnbCodesFromHosthub(built.missing);
    const filled = bf.rows.filter(function (x) { return piNormAirbnbCode(x.code); });
    const still = bf.rows.filter(function (x) { return !piNormAirbnbCode(x.code); });
    rows = built.inv.concat(built.credit).concat(filled);
    const persisted = await piPersistReservationIds(filled);
    built = { inv: built.inv, credit: built.credit, missing: still };
    return {
      reservations: rows.filter(function (x) { return piNormAirbnbCode(x.code); }),
      source: 'db+hosthub',
      missing: still.length,
      persisted: persisted,
      hosthubFetched: bf.fetched
    };
  }
  return {
    reservations: rows.filter(function (x) { return piNormAirbnbCode(x.code); }),
    source: 'db',
    missing: 0,
    persisted: 0
  };
}
app.get('/api/platform-invoices/airbnb-codes', async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
    const resolved = await piResolveAirbnbReservations(month, []);
    res.json({
      ok: true,
      month: month,
      reservations: resolved.reservations,
      missing: resolved.missing || 0,
      source: resolved.source,
      persisted: resolved.persisted || 0,
      count: (resolved.reservations || []).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const _piPullJobs = new Map();
function piPullPublic(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    month: job.month,
    channel: job.channel,
    hint: job.hint || null,
    error: job.error || null,
    saved: job.saved || [],
    errors: job.errors || [],
    progress: job.progress || null,
    airbnbCodes: job.airbnbCodes || 0,
    workerOk: job.workerOk,
    sessionsCleared: job.sessionsCleared || [],
    sessions: job.sessions || null,
    reconnectHint: job.reconnectHint,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
function piPullParseWorkerStdout(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (!j || j.event === 'progress') continue;
      return j;
    } catch (e) {}
  }
  return null;
}
function piPullConsumeStdoutLine(job, line) {
  try {
    const j = JSON.parse(line);
    if (j && j.event === 'progress') {
      job.progress = { done: j.done || 0, total: j.total || 0, saved: j.saved || 0, code: j.code || '' };
      job.hint = 'Pulling Airbnb ' + (j.done || 0) + '/' + (j.total || 0) +
        (j.code ? (' · ' + j.code) : '') +
        (j.saved ? (' · ' + j.saved + ' PDF(s) so far') : '') + '…';
      job.updatedAt = Date.now();
    }
  } catch (e) {}
}
async function piExecutePullJob(job) {
  const b = job.body || {};
  const month = job.month;
  const channel = job.channel;
  const by = job.by || 'portal-pull';
  job.status = 'running';
  job.hint = 'Saving the live Airbnb session, then pulling VAT PDFs…';
  job.updatedAt = Date.now();
  try { await piAirbnbHarvestLiveJobs(); } catch (eHarvest) {}
  const airbnbSession = await piLoadPortalSession('airbnb');
  const bookingSession = await piLoadPortalSession('booking');
  const airbnbOk = !!(airbnbSession && airbnbSession.storageState) ||
    !!(process.env.AIRBNB_STORAGE_STATE_B64 || process.env.AIRBNB_STORAGE_STATE) ||
    !!(process.env.AIRBNB_HOST_EMAIL && process.env.AIRBNB_HOST_PASSWORD);
  const bookingOk = !!(bookingSession && bookingSession.storageState) ||
    !!(process.env.BOOKING_STORAGE_STATE_B64 || process.env.BOOKING_STORAGE_STATE) ||
    !!(process.env.BOOKING_HOST_EMAIL && process.env.BOOKING_HOST_PASSWORD);
  if ((channel === 'airbnb' && !airbnbOk) || (channel === 'booking' && !bookingOk) || (channel === 'all' && !airbnbOk && !bookingOk)) {
    job.status = 'error';
    job.error = 'Portal not connected';
    job.hint = 'Use Connect Airbnb / Connect Booking once (session vault), or set host credentials / STORAGE_STATE_B64 on Railway.';
    job.updatedAt = Date.now();
    return;
  }
  const pathMod = require('path');
  const fsMod = require('fs');
  const osMod = require('os');
  const outDir = pathMod.join(osMod.tmpdir(), 'pi-pull-' + month + '-' + Date.now());
  const sessionDir = pathMod.join(osMod.tmpdir(), 'pi-sessions-' + Date.now());
  fsMod.mkdirSync(outDir, { recursive: true });
  fsMod.mkdirSync(sessionDir, { recursive: true });
  try {
    if (airbnbSession && airbnbSession.storageState) {
      fsMod.writeFileSync(pathMod.join(sessionDir, 'airbnb.json'), JSON.stringify(airbnbSession.storageState));
    }
    if (bookingSession && bookingSession.storageState) {
      fsMod.writeFileSync(pathMod.join(sessionDir, 'booking.json'), JSON.stringify(bookingSession.storageState));
    }
  } catch (e) {
    job.status = 'error';
    job.error = 'Could not materialize portal sessions: ' + e.message;
    job.updatedAt = Date.now();
    return;
  }
  const script = pathMod.join(__dirname, 'scripts', 'platform-invoice-pull.js');
  const args = [script, '--month=' + month, '--channel=' + channel, '--out=' + outDir, '--session-dir=' + sessionDir, '--save-sessions'];
  const env = Object.assign({}, process.env, { PI_SESSION_DIR: sessionDir });
  if (Array.isArray(b.apartments) && b.apartments.length) {
    env.PI_APARTMENTS_JSON = JSON.stringify(b.apartments.slice(0, 200));
  }
  let airbnbReservations = Array.isArray(b.airbnbReservations) ? b.airbnbReservations : [];
  let airbnbResolveMeta = null;
  if ((channel === 'airbnb' || channel === 'all') && !airbnbReservations.filter(function (x) { return x && x.code; }).length) {
    try {
      airbnbResolveMeta = await piResolveAirbnbReservations(month, []);
      airbnbReservations = airbnbResolveMeta.reservations || [];
    } catch (e) {
      console.error('[platform-invoices] resolve airbnb codes', e.message);
    }
  }
  const limitN = parseInt(b.limit != null ? b.limit : process.env.PI_AIRBNB_LIMIT, 10);
  if (limitN > 0) {
    airbnbReservations = piSortAirbnbReservationsLatest(airbnbReservations);
    airbnbReservations = airbnbReservations.slice(0, limitN);
  }
  if (airbnbReservations.length) {
    env.PI_AIRBNB_RESERVATIONS_JSON = JSON.stringify(airbnbReservations.slice(0, 500));
    if (limitN > 0) env.PI_AIRBNB_LIMIT = String(limitN);
  }
  job.airbnbCodes = airbnbReservations.length;
  if ((channel === 'airbnb' || channel === 'all') && !airbnbReservations.length) {
    job.status = 'error';
    job.error = 'No Airbnb reservation codes for ' + month;
    job.hint = 'Sync Hosthub on the Dashboard (bookings need reservationId from Hosthub), then retry Pull. If codes stay missing, Hosthub may not have reservation_id on those events.';
    job.updatedAt = Date.now();
    return;
  }
  if (b.airbnbOtp) env.AIRBNB_OTP = String(b.airbnbOtp);
  job.hint = (limitN > 0 ? 'Test pull (latest): ' : '') + 'Pulling Airbnb VAT PDFs from ' + airbnbReservations.length + ' Hosthub code(s)…';
  job.updatedAt = Date.now();
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  let stdout = '', stderr = '', carry = '';
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 90 * 60 * 1000);
  child.stdout.on('data', function (d) {
    const text = d.toString();
    stdout += text;
    carry += text;
    const parts = carry.split('\n');
    carry = parts.pop();
    parts.forEach(function (line) {
      if (line.trim()) piPullConsumeStdoutLine(job, line.trim());
    });
  });
  child.stderr.on('data', function (d) { stderr += d.toString(); });
  child.on('error', function (eSpawn) {
    job.status = 'error';
    job.error = eSpawn.message || String(eSpawn);
    job.updatedAt = Date.now();
  });
  child.on('close', async function (code) {
    clearTimeout(timer);
    if (carry.trim()) piPullConsumeStdoutLine(job, carry.trim());
    try {
      let result = piPullParseWorkerStdout(stdout);
      if (!result) {
        try { result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}'); }
        catch (e) { result = null; }
      }
      if (!result) {
        if (job.cancelled) {
          job.status = 'cancelled';
          job.error = null;
          job.hint = 'Pull stopped';
          job.updatedAt = Date.now();
          return;
        }
        job.status = 'error';
        job.error = 'Worker returned non-JSON';
        job.hint = (stderr || stdout).slice(0, 240);
        job.updatedAt = Date.now();
        return;
      }
      try {
        let earlyErrors = result.errors || [];
        for (const ch of ['airbnb', 'booking']) {
          if (piErrorsIndicateExpiredSession(earlyErrors, ch)) continue;
          const p = pathMod.join(sessionDir, ch + '.json');
          if (fsMod.existsSync(p)) {
            const st = JSON.parse(fsMod.readFileSync(p, 'utf8'));
            await piSavePortalSession(ch, st, 'portal-pull-refresh');
          }
        }
      } catch (e) { console.error('[platform-invoices] session refresh', e.message); }
      if (!Array.isArray(result.files)) {
        job.status = 'error';
        job.error = result.error || 'Pull failed';
        job.errors = result.errors || [];
        job.updatedAt = Date.now();
        return;
      }
      const saved = [];
      if (pool) await ensurePlatInvTable();
      for (const f of result.files) {
        const buf = fsMod.readFileSync(f.path);
        const dataB64 = buf.toString('base64');
        let partner = String((f.aptName || f.partner || '')).slice(0, 120);
        if (/^credit_note\b/i.test(partner)) partner = String(f.aptName || '').slice(0, 120);
        if (pool) {
          const dup = await pool.query(
            `SELECT id FROM platform_invoices WHERE month=$1 AND channel=$2 AND filename=$3 AND size=$4 LIMIT 1`,
            [month, f.channel, f.filename, buf.length]
          );
          if (dup.rows.length) {
            saved.push({ id: dup.rows[0].id, filename: f.filename, channel: f.channel, kind: f.kind, partner, deduped: true });
            continue;
          }
        }
        const row = {
          month, channel: f.channel, scope: f.scope || 'leased', partner,
          filename: f.filename, mime: 'application/pdf', size: buf.length, source: 'portal',
          uploaded_by: by, data: dataB64
        };
        if (pool) {
          const r = await pool.query(
            `INSERT INTO platform_invoices (month, channel, scope, partner, filename, mime, size, source, uploaded_by, data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [row.month, row.channel, row.scope, row.partner, row.filename, row.mime, row.size, row.source, row.uploaded_by, row.data]);
          saved.push({ id: r.rows[0].id, filename: row.filename, channel: row.channel, kind: f.kind, partner });
        } else {
          const id = 'p' + (_memPlatInvSeq++);
          _memPlatInv.set(id, Object.assign({}, row, { id: id, created_at: new Date().toISOString() }));
          saved.push({ id: id, filename: row.filename, channel: row.channel, kind: f.kind, partner, db: false });
        }
      }
      try { fsMod.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
      const pullErrors = result.errors || [];
      const cleared = [];
      try {
        if (piErrorsIndicateExpiredSession(pullErrors, 'airbnb')) {
          if (await piClearPortalSession('airbnb')) cleared.push('airbnb');
        }
        if (piErrorsIndicateExpiredSession(pullErrors, 'booking')) {
          if (await piClearPortalSession('booking')) cleared.push('booking');
        }
      } catch (e) { console.error('[platform-invoices] clear expired session', e.message); }
      job.saved = saved;
      job.errors = pullErrors;
      job.workerOk = !!result.ok;
      job.exitCode = code;
      job.airbnbCodes = result.airbnbCodes || airbnbReservations.length || 0;
      job.sessionsCleared = cleared;
      job.sessions = {
        airbnb: !!(await piSessionMeta('airbnb')).connected,
        booking: !!(await piSessionMeta('booking')).connected
      };
      job.reconnectHint = cleared.indexOf('airbnb') >= 0
        ? 'Airbnb session cleared. Click Connect Airbnb in Collect, enter the email code, wait until it says connected, then Pull again. Do not paste session JSON.'
        : undefined;
      job.status = job.cancelled ? 'cancelled' : 'done';
      job.error = null;
      job.hint = job.cancelled
        ? ('Pull stopped' + (saved.length ? (' · kept ' + saved.length + ' PDF(s)') : ''))
        : (saved.length
        ? ('Pulled ' + saved.length + ' Airbnb PDF(s) from ' + job.airbnbCodes + ' Hosthub code(s).')
        : ('Airbnb pull saved 0 PDFs from ' + job.airbnbCodes + ' Hosthub code(s).'));
      job.updatedAt = Date.now();
    } catch (eClose) {
      job.status = 'error';
      job.error = eClose.message || String(eClose);
      job.updatedAt = Date.now();
    }
  });
}

app.post('/api/platform-invoices/pull', async (req, res) => {
  const b = req.body || {};
  const month = String(b.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
  const channel = String(b.channel || 'all').toLowerCase();
  let playwrightOk = false;
  try { require.resolve('playwright'); playwrightOk = true; } catch (e) {}
  if (!playwrightOk) {
    return res.status(503).json({ error: 'playwright is not installed on this deploy', hint: 'Docker image must include Playwright Chromium' });
  }
  for (const existing of _piPullJobs.values()) {
    if (existing && existing.month === month && existing.channel === channel &&
        (existing.status === 'starting' || existing.status === 'running')) {
      return res.json({ ok: true, job: piPullPublic(existing), resumed: true });
    }
  }
  const jobId = 'pp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = {
    id: jobId,
    month: month,
    channel: channel,
    status: 'starting',
    error: null,
    hint: 'Starting Airbnb pull in the background…',
    by: req.acctUser || (b && b.by) || 'portal-pull',
    body: {
      apartments: Array.isArray(b.apartments) ? b.apartments : [],
      airbnbReservations: Array.isArray(b.airbnbReservations) ? b.airbnbReservations : [],
      airbnbOtp: b.airbnbOtp || '',
      limit: b.limit
    },
    saved: [],
    errors: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  _piPullJobs.set(jobId, job);
  setImmediate(function () {
    piExecutePullJob(job).catch(function (eRun) {
      job.status = 'error';
      job.error = eRun.message || String(eRun);
      job.updatedAt = Date.now();
    });
  });
  res.json({ ok: true, job: piPullPublic(job) });
});

function piCancelPullJob(job, reason) {
  if (!job) return false;
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return false;
  job.cancelled = true;
  job.status = 'cancelling';
  job.hint = reason || 'Stopping Airbnb pull…';
  job.updatedAt = Date.now();
  const child = job.child;
  if (child && child.pid) {
    try { child.kill('SIGTERM'); } catch (e) {}
    setTimeout(function () {
      if (job.status === 'cancelling') {
        try { child.kill('SIGKILL'); } catch (e2) {}
      }
    }, 2500);
  } else {
    job.status = 'cancelled';
    job.hint = 'Pull stopped';
  }
  return true;
}
app.get('/api/platform-invoices/pull/:jobId', async (req, res) => {
  const job = _piPullJobs.get(String(req.params.jobId || ''));
  if (!job) {
    return res.json({
      ok: true,
      job: {
        id: String(req.params.jobId || ''),
        status: 'cancelled',
        hint: 'Pull stopped',
        error: null,
        saved: [],
        errors: [],
        gone: true
      }
    });
  }
  res.json({ ok: true, job: piPullPublic(job) });
});
app.post('/api/platform-invoices/pull-stop', async (req, res) => {
  const stopped = [];
  for (const job of _piPullJobs.values()) {
    if (job && (job.status === 'starting' || job.status === 'running' || job.status === 'cancelling')) {
      piCancelPullJob(job, 'Pull stopped');
      stopped.push(piPullPublic(job));
    }
  }
  res.json({ ok: true, stopped, hint: stopped.length ? 'Stopping Airbnb pull…' : 'No pull is running' });
});
app.post('/api/platform-invoices/pull/:jobId/cancel', async (req, res) => {
  const job = _piPullJobs.get(String(req.params.jobId || ''));
  if (!job) {
    return res.json({
      ok: true,
      job: {
        id: String(req.params.jobId || ''),
        status: 'cancelled',
        hint: 'Pull stopped',
        error: null,
        saved: [],
        errors: [],
        gone: true
      }
    });
  }
  piCancelPullJob(job, 'Pull stopped');
  res.json({ ok: true, job: piPullPublic(job) });
});

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

// Leads pipeline: Meta lead ads and manual leads through to a signed apartment.
//
// Storage is two self-healing tables (same pattern as rental_info / proof_files)
// plus a config blob in app_data. Leads deliberately do NOT live in the main 'S'
// document - that syncs on every save and would grow without bound.
//
// Ingest is source-agnostic: leadIngest() is the single door. The Meta poll
// calls it, the manual "+ New lead" endpoint calls it, and a webhook can call it
// later with no change to storage, assignment, email or UI.
const LEAD_STAGES = ['new','to_contact','contacted','qualified','viewing','proposal','contract_sent','signed','onboarding','live'];
const LEAD_CLOSED = ['lost','on_hold'];
const LEAD_ALL_STAGES = LEAD_STAGES.concat(LEAD_CLOSED);
const LEAD_CFG_KEY = 'leads_config';
const LEAD_CFG_DEFAULT = {
  team: [
    { key: 'lefteris', name: 'Lefteris', active: true, weight: 1, awayUntil: null, canDelete: true },
    { key: 'george',   name: 'George',   active: true, weight: 1, awayUntil: null, canDelete: true },
    { key: 'giannis',  name: 'Giannis',  active: true, weight: 1, awayUntil: null, canDelete: false },
    { key: 'popi',     name: 'Popi',     active: true, weight: 1, awayUntil: null, canDelete: false },
  ],
  slaFirstContactHours: 4,      // working hours; configurable in the UI
  autoSendWelcome: false,       // draft by default - the first email carries a contract
  archiveUndoDays: 30,
  archiveRetentionMonths: 24,  // archived leads are kept two years, then tombstoned
  // The first Meta pull would otherwise sweep in every lead the account has ever
  // had (374 sat in Leads Center when this was built) and hand the whole backlog
  // out at once. This floor bounds it; set it to the date you actually want to
  // start from, or clear it once the backlog has been dealt with.
  metaSinceDate: '',           // 'YYYY-MM-DD' - nothing older than this is imported
  deletePassword: '2026',       // same gate as the monthly-close skip
  metaFormIds: [],              // empty = every form the token can see
  metaPageId: '',               // only needed when a User token manages several Pages
};
let _leadsReady = false;
async function ensureLeadTables() {
  if (_leadsReady || !pool) return;
  // Self-healing, same reason as the proofs table: a deploy can boot before the
  // database is reachable and then the startup DDL never ran. The leads module
  // keeps its config and Meta cursor in app_data, so ensure that one too rather
  // than assuming boot created it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key VARCHAR(50) PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id            SERIAL PRIMARY KEY,
      source        TEXT NOT NULL DEFAULT 'manual',
      meta_lead_id  TEXT,
      form_id       TEXT, form_name TEXT, campaign TEXT, adset TEXT, ad_id TEXT, page_id TEXT,
      created_time  TIMESTAMPTZ,
      raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
      full_name     TEXT, email TEXT, phone TEXT,
      fields        JSONB NOT NULL DEFAULT '{}'::jsonb,
      stage         TEXT NOT NULL DEFAULT 'new',
      owner         TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      lost_reason   TEXT,
      created_by    TEXT,
      assigned_at   TIMESTAMPTZ, first_contact_at TIMESTAMPTZ,
      stage_changed_at TIMESTAMPTZ DEFAULT NOW(), won_at TIMESTAMPTZ,
      archived_at   TIMESTAMPTZ, archived_by TEXT, archive_reason TEXT,
      events        JSONB NOT NULL DEFAULT '[]'::jsonb,
      apt_id        TEXT,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Partial unique index: Meta ids are unique, manual leads (NULL) are exempt.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_meta ON leads (meta_lead_id) WHERE meta_lead_id IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads (owner);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_assets (
      key         TEXT PRIMARY KEY,
      filename    TEXT, mime TEXT, size INTEGER,
      version     INTEGER NOT NULL DEFAULT 1,
      data        TEXT NOT NULL,
      updated_by  TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // ALTER, not just CREATE: the table already exists in production, so new
  // columns have to be added to it rather than only appearing for fresh installs.
  await pool.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS property_address TEXT,
      ADD COLUMN IF NOT EXISTS property_size    TEXT,
      ADD COLUMN IF NOT EXISTS property_type    TEXT,
      ADD COLUMN IF NOT EXISTS bedrooms         TEXT,
      ADD COLUMN IF NOT EXISTS bathrooms        TEXT,
      ADD COLUMN IF NOT EXISTS bedrooms_n       INTEGER,
      ADD COLUMN IF NOT EXISTS bathrooms_n      INTEGER;
  `);
  // Leads erased between the property columns shipping and the line above being
  // fixed kept their address. Clear those too - idempotent, matches nothing after
  // the first boot.
  await pool.query(`
    UPDATE leads SET property_address = NULL, property_size = NULL, property_type = NULL,
                     bedrooms = NULL, bathrooms = NULL, bedrooms_n = NULL, bathrooms_n = NULL
     WHERE status = 'erased' AND property_address IS NOT NULL;
  `);
  // Seed EN + GR company brochures once from disk so welcome emails attach the
  // matching language. Replacing via POST /api/lead-assets still wins — we only
  // insert when the key is missing. `brochure` stays as a GR alias for older callers.
  try {
    const fsLead = require('fs');
    const seeds = [
      { key: 'brochure-en', file: 'elysian-management-brochure-en.pdf', name: 'Elysian-Properties-Management-Brochure-EN.pdf' },
      { key: 'brochure-gr', file: 'elysian-management-brochure-gr.pdf', name: 'Elysian-Properties-Management-Brochure-GR.pdf' },
      { key: 'brochure',    file: 'elysian-management-brochure-gr.pdf', name: 'Elysian-Properties-Management-Brochure.pdf' }
    ];
    for (const s of seeds) {
      const brochurePath = path.join(__dirname, 'assets', s.file);
      if (!fsLead.existsSync(brochurePath)) continue;
      const have = await pool.query(`SELECT 1 FROM lead_assets WHERE key = $1 LIMIT 1`, [s.key]);
      if (have.rows.length) continue;
      const buf = fsLead.readFileSync(brochurePath);
      await pool.query(
        `INSERT INTO lead_assets (key, filename, mime, size, version, data, updated_by, updated_at)
         VALUES ($1,$2,'application/pdf',$3,1,$4,'system',NOW())
         ON CONFLICT (key) DO NOTHING`,
        [s.key, s.name, buf.length, buf.toString('base64')]);
      console.log('[leads] seeded ' + s.key + ' (' + buf.length + ' bytes)');
    }
  } catch (e) { console.error('[leads] brochure seed skipped:', e.message); }
  _leadsReady = true;
}
async function leadCfg() {
  if (!pool) return LEAD_CFG_DEFAULT;
  try {
    const r = await pool.query('SELECT data FROM app_data WHERE key = $1', [LEAD_CFG_KEY]);
    const d = (r.rows[0] && r.rows[0].data) || {};
    return Object.assign({}, LEAD_CFG_DEFAULT, d, { team: Array.isArray(d.team) && d.team.length ? d.team : LEAD_CFG_DEFAULT.team });
  } catch (e) { return LEAD_CFG_DEFAULT; }
}
function leadEvent(type, by, detail) { return { at: new Date().toISOString(), type: type, by: by || 'system', detail: detail || '' }; }
// Assignment: the available person with the fewest OPEN leads. Weight divides
// the count, so someone at 0.5 takes half the flow. Ties break on fewest in the
// last 7 days, then on who was assigned longest ago. Deterministic on purpose -
// the counts at the moment of assignment go onto the timeline so the decision
// can always be explained.
async function leadPickOwner() {
  const cfg = await leadCfg();
  const now = Date.now();
  const avail = (cfg.team || []).filter(function (m) {
    if (!m.active) return false;
    if (m.awayUntil && new Date(m.awayUntil).getTime() > now) return false;
    return true;
  });
  if (!avail.length) return { owner: null, counts: {}, reason: 'nobody available' };
  const q = await pool.query(
    `SELECT owner,
            COUNT(*) FILTER (WHERE status = 'open' AND archived_at IS NULL) AS open_now,
            COUNT(*) FILTER (WHERE assigned_at > NOW() - INTERVAL '7 days') AS last7,
            MAX(assigned_at) AS last_assigned
       FROM leads WHERE owner IS NOT NULL GROUP BY owner`);
  const by = {};
  q.rows.forEach(function (r) { by[r.owner] = { open: +r.open_now || 0, last7: +r.last7 || 0, last: r.last_assigned ? new Date(r.last_assigned).getTime() : 0 }; });
  const counts = {};
  avail.forEach(function (m) { counts[m.key] = (by[m.key] || {}).open || 0; });
  const scored = avail.map(function (m) {
    const s = by[m.key] || { open: 0, last7: 0, last: 0 };
    const w = (typeof m.weight === 'number' && m.weight > 0) ? m.weight : 1;
    return { key: m.key, load: s.open / w, last7: s.last7, last: s.last };
  });
  scored.sort(function (a, b) {
    if (a.load !== b.load) return a.load - b.load;
    if (a.last7 !== b.last7) return a.last7 - b.last7;
    return a.last - b.last;
  });
  return { owner: scored[0].key, counts: counts, reason: '' };
}
function leadDigits(s) { return String(s || '').replace(/[^0-9]/g, '').slice(-9); }
// Duplicate guard: same email, or the last 9 digits of the phone, on a lead that
// is still open. Stops a Meta form on Monday and a phone call on Wednesday
// becoming two tickets pulling two different people.
async function leadFindDuplicate(email, phone, excludeId) {
  const e = String(email || '').trim().toLowerCase(), p = leadDigits(phone);
  if (!e && !p) return null;
  const r = await pool.query(
    `SELECT id, full_name, email, phone, owner, stage FROM leads
      WHERE archived_at IS NULL AND status = 'open' AND ($3::int IS NULL OR id <> $3)
        AND ( ($1 <> '' AND lower(email) = $1)
           OR ($2 <> '' AND length($2) >= 6 AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 9) = $2) )
      ORDER BY id LIMIT 1`, [e, p, excludeId || null]);
  return r.rows[0] || null;
}
// Property details out of whatever the lead form asked.
//
// Meta forms use custom questions, and ours are in Greek - "Τετραγωνικά
// Ακινήτου", "Τοποθεσία & Διεύθυνση Ακινήτου". The full answer set is always
// kept in `fields`, but the ones that decide whether a lead is worth pursuing
// (where is it, how big, how many rooms) are promoted to real columns so they
// are visible on the card, searchable, and can pre-fill the apartment record
// when the lead converts.
//
// Matching is on the question key or label, accent- and case-insensitive, and
// covers Greek and English. A form can be renamed or a new question added
// without losing anything: unmatched answers still live in `fields`.
function leadNorm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip Greek/Latin accents
    .replace(/ς/g, 'σ')                        // final sigma -> sigma
    .toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const LEAD_PROPERTY_MATCHERS = [
  { col: 'property_address', re: /(τοποθεσια|διευθυνση|περιοχη|address|location|street)/ },
  { col: 'property_size',    re: /(τετραγωνικ|τ\.?μ|εμβαδον|μεγεθοσ|sq\.?\s?m|square|size)/ },
  { col: 'bedrooms',         re: /(υπνοδωματ|κρεβατοκαμαρ|δωματι|bedroom|bed\b)/ },
  { col: 'bathrooms',        re: /(μπανι|λουτρ|bathroom|bath\b|wc)/ },
  { col: 'property_type',    re: /(τυποσ ακινητου|ειδοσ ακινητου|property type|type of property)/ },
];
// leadNorm folds final sigma, so a pattern written with ς could never match a
// normalised label - the answer would be silently dropped. Say so out loud.
LEAD_PROPERTY_MATCHERS.forEach(function (m) {
  if (/ς/.test(m.re.source))
    console.error('[leads] matcher ' + m.col + ' uses a final sigma and can never match');
});
// Pull the first whole number out of an answer: "2 υπνοδωμάτια" -> 2, "50-100
// τ.μ." -> null (a range is not a count, so it stays as text only).
function leadInt(v) {
  const s = String(v || '').trim();
  if (/\d\s*[-–—\/]\s*\d/.test(s)) return null;
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return isFinite(n) && n >= 0 && n < 100 ? n : null;
}
function leadExtractProperty(fields) {
  const out = { property_address: null, property_size: null, bedrooms: null, bathrooms: null, property_type: null, bedrooms_n: null, bathrooms_n: null };
  Object.keys(fields || {}).forEach(function (k) {
    const v = String(fields[k] == null ? '' : fields[k]).trim();
    if (!v) return;
    const nk = leadNorm(k);
    for (const m of LEAD_PROPERTY_MATCHERS) {
      if (out[m.col]) continue;                       // first answer wins
      if (m.re.test(nk)) { out[m.col] = v.slice(0, 400); break; }
    }
  });
  out.bedrooms_n = leadInt(out.bedrooms);
  out.bathrooms_n = leadInt(out.bathrooms);
  return out;
}
// The single door every lead comes through, whatever the source.
async function leadIngest(input, by) {
  await ensureLeadTables();
  const src = String(input.source || 'manual');
  if (input.metaLeadId) {
    const dup = await pool.query('SELECT id FROM leads WHERE meta_lead_id = $1', [String(input.metaLeadId)]);
    if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };   // re-delivery, poll overlap, retry
  }
  const pick = await leadPickOwner();
  const _prop = leadExtractProperty(input.fields || {});
  const ev = [leadEvent('created', by || (src === 'meta' ? 'meta' : 'team'), 'source: ' + src)];
  // This line is the whole defence of the assignment rule - it has to be
  // readable on the ticket, so no raw JSON.
  if (pick.owner) ev.push(leadEvent('assigned', 'system', 'to ' + pick.owner + ' (open: ' +
    Object.keys(pick.counts || {}).map(function (k) { return k + ' ' + pick.counts[k]; }).join(', ') + ')'));
  else ev.push(leadEvent('unassigned', 'system', pick.reason));
  const r = await pool.query(
    `INSERT INTO leads (source, meta_lead_id, form_id, form_name, campaign, adset, ad_id, page_id,
                        created_time, raw, full_name, email, phone, fields, stage, owner, created_by,
                        assigned_at, events, property_address, property_size, property_type,
                        bedrooms, bathrooms, bedrooms_n, bathrooms_n)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19::jsonb,
             $20,$21,$22,$23,$24,$25,$26)
     RETURNING id`,
    [src, input.metaLeadId || null, input.formId || null, input.formName || null, input.campaign || null,
     input.adset || null, input.adId || null, input.pageId || null, input.createdTime || new Date().toISOString(),
     JSON.stringify(input.raw || {}), input.fullName || null, input.email || null, input.phone || null,
     JSON.stringify(input.fields || {}), pick.owner ? 'to_contact' : 'new', pick.owner, by || null,
     pick.owner ? new Date().toISOString() : null, JSON.stringify(ev),
     _prop.property_address, _prop.property_size, _prop.property_type,
     _prop.bedrooms, _prop.bathrooms, _prop.bedrooms_n, _prop.bathrooms_n]);
  console.log('[leads] ingested #' + r.rows[0].id + ' (' + src + ') -> ' + (pick.owner || 'UNASSIGNED'));
  return { id: r.rows[0].id, duplicate: false, owner: pick.owner };
}

// POST /api/proofs — upload one proof {month, task, aptId, aptName, name, mime, size, by, dataB64}
app.post('/api/proofs', async (req, res) => {
  const b = req.body || {};
  if (!/^(\d{4}-\d{2}|law5170)$/.test(b.month || ''))      return res.status(400).json({ error: 'Invalid month (YYYY-MM or law5170 expected)' });
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
      logEvent(req, 'files', 'upload', (meta.month === 'law5170' ? '[Law5170] ' : '[' + meta.month + '] ') + meta.apt_name + ' · ' + meta.task_key + ' · ' + meta.filename);
      return res.json({ ok: true, db: true, id: r.rows[0].id, uploadedAt: r.rows[0].uploaded_at });
    } catch (e) {
      console.error('[proofs] write error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  const id = 'm' + _memProofSeq++;
  _memProofs.set(id, { ...meta, id, uploaded_at: new Date().toISOString(), data: b.dataB64 });
  logEvent(req, 'files', 'upload', '[mem] ' + meta.apt_name + ' · ' + meta.task_key + ' · ' + meta.filename);
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
    try { await ensureProofTable(); await pool.query(`DELETE FROM proof_files WHERE id = $1`, [parseInt(id)]); logEvent(req, 'files', 'delete', 'proof #' + id); return res.json({ ok: true }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  logEvent(req, 'files', 'delete', 'proof #' + id);
  _memProofs.delete(id);
  res.json({ ok: true });
});

// ── Change log — per-account audit trail (server-stamped usernames) ───────────
// Captures data changes (saves, uploads, Property Info) and client-posted
// events (including UI clicks). The client never chooses the username.
let _logTableReady = false, _logN = 0, _memLogSeq = 1;
const _memLog = [];
async function ensureLogTable() {
  if (_logTableReady || !pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS change_log (
    id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
    username TEXT, area TEXT, action TEXT, details TEXT
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_changelog_id ON change_log (id DESC);`);
  _logTableReady = true;
}
async function logEvent(req, area, action, details) {
  const row = {
    username: String((req && req.acctUser) || 'system').slice(0, 60),
    area: String(area || 'app').slice(0, 30),
    action: String(action || 'event').slice(0, 80),
    details: String(details == null ? '' : details).slice(0, 600),
  };
  if (!pool) {
    _memLog.unshift({ id: _memLogSeq++, ts: new Date().toISOString(), ...row });
    if (_memLog.length > 8000) _memLog.length = 8000;
    return;
  }
  try {
    await ensureLogTable();
    await pool.query(
      `INSERT INTO change_log (username, area, action, details) VALUES ($1,$2,$3,$4)`,
      [row.username, row.area, row.action, row.details]
    );
    if ((++_logN) % 25 === 0)
      await pool.query(`DELETE FROM change_log WHERE id < (SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM change_log ORDER BY id DESC LIMIT 8000) t)`);
  } catch (e) { console.error('[log]', e.message); }
}
function mergeKeepMap(oldM, newM, mergeVal) {
  const oldO = (oldM && typeof oldM === 'object' && !Array.isArray(oldM)) ? oldM : {};
  const newO = (newM && typeof newM === 'object' && !Array.isArray(newM)) ? newM : {};
  const out = Object.assign({}, oldO, newO);
  Object.keys(oldO).forEach(k => {
    if (!(k in newO)) out[k] = oldO[k];
    else if (typeof mergeVal === 'function') out[k] = mergeVal(oldO[k], newO[k]);
  });
  return out;
}
function mergeRptLock(oldL, newL) {
  const a = oldL && typeof oldL === 'object' ? oldL : {};
  const b = newL && typeof newL === 'object' ? newL : {};
  const m = Object.assign({}, a, b);
  if (a.email && !b.email) m.email = a.email;
  else if (a.email && b.email && (a.email.at || 0) > (b.email.at || 0)) m.email = a.email;
  if (a.oxygen && !b.oxygen) m.oxygen = a.oxygen;
  return m;
}
function mergeCloseRec(oldR, newR) {
  const a = oldR && typeof oldR === 'object' ? oldR : {};
  const b = newR && typeof newR === 'object' ? newR : {};
  const m = Object.assign({}, a, b);
  if (a.remit && !b.remit) m.remit = a.remit;
  if (a.emailed && !b.emailed) m.emailed = a.emailed;
  if (a.done && b.done) m.done = Object.assign({}, a.done, b.done);
  return m;
}
function mergeMonthlyClose(oldC, newC) {
  return mergeKeepMap(oldC, newC, function (om, nm) {
    return mergeKeepMap(om, nm, mergeCloseRec);
  });
}
function mergeAptsProtect(dbApts, inApts) {
  const dbById = {}, dbByName = {};
  (dbApts || []).forEach(a => {
    if (!a) return;
    if (a.id) dbById[String(a.id)] = a;
    if (a.name) dbByName[String(a.name).trim().toLowerCase()] = a;
  });
  return (inApts || []).map(apt => {
    if (!apt) return apt;
    const old = (apt.id && dbById[String(apt.id)]) || (apt.name && dbByName[String(apt.name).trim().toLowerCase()]);
    if (!old) return apt;
    const m = Object.assign({}, old, apt);
    ['ownerEmail','ownerEmail2','ownerEmail3','clearGroup','ownerName','ownerSurname','ownerPhone'].forEach(f => {
      if (!String(apt[f] || '').trim() && String(old[f] || '').trim()) m[f] = old[f];
    });
    if (old.businessTax && (apt.businessTax === undefined || apt.businessTax === null)) m.businessTax = old.businessTax;
    if (old.businessTaxAmt != null && (apt.businessTaxAmt === undefined || apt.businessTaxAmt === null || apt.businessTaxAmt === '')) m.businessTaxAmt = old.businessTaxAmt;
    return m;
  });
}

function diffSummary(oldD, newD) {
  try {
    const out = [];
    const keys = [...new Set([...(oldD ? Object.keys(oldD) : []), ...(newD ? Object.keys(newD) : [])])];
    for (const k of keys) {
      const a = oldD ? oldD[k] : undefined, b = newD ? newD[k] : undefined;
      if (Array.isArray(a) || Array.isArray(b)) {
        const la = Array.isArray(a) ? a.length : 0, lb = Array.isArray(b) ? b.length : 0;
        if (la !== lb) out.push(k + ' ' + la + '→' + lb);
        else if (la <= 2000 && JSON.stringify(a) !== JSON.stringify(b)) out.push(k + ' ✎');
      } else if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a).length, kb = Object.keys(b).length;
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k + ' ✎' + (ka !== kb ? ' (' + ka + '→' + kb + ' keys)' : ''));
      } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k + ' ✎');
      if (out.length >= 12) { out.push('…'); break; }
    }
    return out.length ? out.join(' · ') : 'saved (no top-level change detected)';
  } catch (e) { return 'saved'; }
}

// POST /api/changelog — client events (changes + clicks); user is server-stamped
app.post('/api/changelog', async (req, res) => {
  const b = req.body || {};
  await logEvent(req, b.area, b.action, b.details);
  res.json({ ok: true });
});
// GET /api/changelog?limit=&user=&area=&kind= — newest first
// kind=changes excludes area=click; kind=clicks keeps only area=click
app.get('/api/changelog', async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 300, 500);
  const kind = String(req.query.kind || '').toLowerCase();
  const filterRow = (r) => {
    if (req.query.user && r.username !== req.query.user) return false;
    if (req.query.area && r.area !== req.query.area) return false;
    if (kind === 'clicks' && r.area !== 'click') return false;
    if (kind === 'changes' && r.area === 'click') return false;
    return true;
  };
  if (!pool) {
    return res.json(_memLog.filter(filterRow).slice(0, lim));
  }
  try {
    await ensureLogTable();
    const conds = [], vals = [];
    if (req.query.user) { vals.push(req.query.user); conds.push('username = $' + vals.length); }
    if (req.query.area) { vals.push(req.query.area); conds.push('area = $' + vals.length); }
    if (kind === 'clicks') conds.push("area = 'click'");
    if (kind === 'changes') conds.push("area <> 'click'");
    vals.push(lim);
    const r = await pool.query(
      'SELECT id, ts, username, area, action, details FROM change_log' +
      (conds.length ? ' WHERE ' + conds.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT $' + vals.length, vals);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      id:ev.id, reservationId:String(ev.reservation_id||ev.reservationId||(ev.source&&(ev.source.reservation_id||ev.source.confirmation_code))||'').trim(), aptId:_aptMatch?.id||'', aptName:_aptName, cancelled:ev.is_visible===false, cancelledAt:ev.cancelled_at||null,
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
    // getStoredApiKey() does not exist - it never did. There is no server-side
    // store for the Hosthub key either: the app keeps it in the browser, in
    // localStorage.hh_api_key. So on any deploy without SERVER_API_KEY set, this
    // line threw ReferenceError inside the timer callback, outside the try below,
    // and took the whole process down every 15 minutes. Production has the
    // variable set, which is the only reason it has not been biting.
    const apiKey = SERVER_API_KEY || null;
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
    logEvent(req, 'email', 'send', String(b.subject || '').slice(0, 120) + ' · ' + to.length + ' to');
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
  // Owner clearing fees are settled against the payout rather than paid at
  // issue, so every APY/TPY carries 'Epi Pistosei' (on credit, myDATA code 5).
  // Matched by myDATA code first so it survives an id change, then by id.
  // OXYGEN_PM_ID still overrides.
  const PM_CODE = '5', PM_ID = '5dc5dbda-6da6-4499-9ac6-200ed1abbbb3';
  const pick = arr.find(x => String(x.mydata_code) === PM_CODE) || arr.find(x => x.id === PM_ID);
  if (pick) _oxyLookups.pm = pick.id;
  else if (arr.length) _oxyLookups.pm = arr[0].id;
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
    // Clearing fees are settled against the owner's payout, so the document is
    // marked paid unless the caller explicitly passes isPaid:false.
    taxId, pmId, seq, isPaid: (b.isPaid === undefined ? true : !!b.isPaid),
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
    let inv = (made.body && (made.body.data || made.body)) || {};
    // Oxygen assigns the myDATA MARK a moment after creation - poll briefly so the ledger records it.
    if (inv.id && !((inv.mydata || {}).mark)) {
      for (let _i = 0; _i < 3; _i++) {
        await new Promise(r => setTimeout(r, 1200));
        const again = await oxyFetch('/invoices/' + encodeURIComponent(inv.id));
        const fresh = (again.body && (again.body.data || again.body)) || null;
        if (fresh && fresh.id) { inv = fresh; if ((fresh.mydata || {}).mark) break; }
      }
    }
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
// GET /api/oxygen/invoice-pdf/:id - the issued document's PDF, base64, for email attachment
app.get('/api/oxygen/invoice-pdf/:id', async (req, res) => {
  if (!OXY.key) return res.status(400).json({ error: 'oxygen not configured' });
  const id = req.params.id;
  try {
    const url = OXY.base.replace(/\/+$/, '') + '/invoices/' + encodeURIComponent(id) + '/pdf';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + OXY.key, Accept: 'application/pdf' } });
    if (!r.ok) return res.status(502).json({ error: 'pdf fetch failed', status: r.status });
    const buf = r.buffer ? await r.buffer() : Buffer.from(await r.arrayBuffer());
    if (!(buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF'))
      return res.status(502).json({ error: 'response was not a PDF', bytes: buf.length });
    res.json({ ok: true, id: id, bytes: buf.length, base64: buf.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/oxygen/lookups', async (req, res) => {
  if (!OXY.key) return res.json({ configured: false });
  const out = { configured: true, base: OXY.base, sandbox: oxySandbox() };
  const disp = c => ([c.name, c.surname].filter(Boolean).join(' ') || c.company_name || c.nickname || c.email || ('#' + c.id));
  const grab = async (p, map) => { const r = await oxyFetch(p); if (!r.ok) return { error: 'HTTP ' + r.status }; return oxyArr(r.body).map(map); };
  // Oxygen paginates /contacts (500 per page), so walk pages until no new ids
  // appear. Self-terminating: if the params are ignored the second page repeats
  // and the dedupe loop stops immediately.
  const seen = Object.create(null); const all = []; out.pages = 0; out.pageMeta = null;
  for (let page = 1; page <= 20; page++) {
    const r2 = await oxyFetch('/contacts?per_page=500&page=' + page);
    if (!r2.ok) { if (page === 1) out.contactsError = 'HTTP ' + r2.status; break; }
    if (page === 1 && r2.body && !Array.isArray(r2.body)) out.pageMeta = r2.body.meta || r2.body.links || null;
    const rows = oxyArr(r2.body); out.pages = page;
    let added = 0;
    rows.forEach(c => { const k = String(c.id); if (seen[k]) return; seen[k] = 1; added++;
      all.push({ id: c.id, name: disp(c), afm: c.vat_number || '', email: c.email || '' }); });
    if (!rows.length || !added) break;
  }
  out.contacts = all;
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
      for (let page = 1; page <= 200; page++) {
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
// Mirror client pcAptKey: apartments sharing clearGroup (Votsala) share one mark key.
function pcvAptKey(b, apts) {
  let group = '';
  try {
    const list = Array.isArray(apts) ? apts : [];
    let a = null;
    if (b && b.aptId != null && b.aptId !== '') a = list.find(x => x && String(x.id) === String(b.aptId)) || null;
    if (!a && b && b.aptName) a = list.find(x => x && x.name === b.aptName) || null;
    if (a && a.clearGroup) group = String(a.clearGroup).trim();
  } catch (e) {}
  const raw = group || (b && b.aptName) || '';
  return pcvNormApt(raw) || (b && b.aptId) || '?';
}
function pcvAptLabel(b, apts) {
  try {
    const list = Array.isArray(apts) ? apts : [];
    let a = null;
    if (b && b.aptId != null && b.aptId !== '') a = list.find(x => x && String(x.id) === String(b.aptId)) || null;
    if (!a && b && b.aptName) a = list.find(x => x && x.name === b.aptName) || null;
    if (a && a.clearGroup && String(a.clearGroup).trim()) return String(a.clearGroup).trim();
  } catch (e) {}
  return (b && b.aptName) || '?';
}
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
  const apts = (data && data.apts) || [];
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
      const aptKey = pcvAptKey(b, apts);
      const key = 'bdc|' + pcvISO(thu) + '|' + aptKey;
      const u = bdc[key] || (bdc[key] = { key, chan: 'bdc', date: thu, exp: 0, label: pcvAptLabel(b, apts) + ' — Thu ' + pcvISO(thu) });
      u.exp += amt;
    } else {
      const ci = pcvParseDMY(b.checkIn); if (!ci) continue;
      const rel = pcvAdd(ci, 1);
      if (rel < from || rel > t) continue;
      const aptKey = pcvAptKey(b, apts);
      const key = 'abb|' + aptKey + '|' + pcvISO(ci) + '|' + pcvNormG(b.guestName);
      units.push({ key, chan: 'abb', date: rel, exp: amt, label: pcvAptLabel(b, apts) + ' — ' + (b.guestName || '—') + ' (release ' + pcvISO(rel) + ')' });
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

// ── Viva Cash Flow (Tools → Cash Flow tab) ───────────────────────────────────────
// Daily income vs expenses from the Viva business account. 130-day window:
// 60 charted days + 60 days of MA60 warm-up + margin.
// Full history: Viva serves everything back to the account's first transaction
// (26 Feb 2025). The empty lead-in is trimmed below, so this is an upper bound.
const CF_DAYS = Math.max(30, Math.min(1200, parseInt(process.env.VIVA_CASHFLOW_DAYS || '', 10) || 730));
const CF_KEY  = 'viva_cashflow';
const CF_INTERNAL_PATTERNS = String(process.env.VIVA_INTERNAL_IBANS || '').toLowerCase().split(/[\\s,;]+/).filter(Boolean);
function cfIsInternal(counterpart) {
  const c = String(counterpart || '').toLowerCase().replace(/\\s+/g, '');
  if (CF_INTERNAL_PATTERNS.length) return CF_INTERNAL_PATTERNS.some(p => c.includes(p));
  // Default: counterparty is an Eurobank account (Greek bank code 026 right
  // after GRkk) or names Eurobank outright. Pin exact IBANs via VIVA_INTERNAL_IBANS.
  // Own-account transfers carry the company's own name in the counterparty
  // ('IBAN - ELYSIAN PROPERTIES ...'). Matching any Eurobank IBAN would be wrong:
  // owners who bank with Eurobank (e.g. Votsala IKE) receive real remittances.
  return c.includes('elysian') || c.includes('eurobank');
}
// Like vivaNormalizeCredits but keeps the sign - debits ARE the expenses here.
function cfNormalizeAll(raw) {
  return (raw || []).map(t => ({
    id: String(t.accountTransactionId || t.AccountTransactionId || t.TransactionId || t.transactionId || t.Id || t.id || ''),
    date: new Date(t.created || t.Created || t.InsDate || t.insDate || t.dateCreated || t.Date || t.date || 0),
    amount: Math.round(((t.amount != null ? +t.amount : +t.Amount) || 0) * 100) / 100,
    counterpart: String(t.counterPart || t.CounterPart || t.counterpart || t.userDescription || t.Description || t.description || ''),
    typeId: t.typeId != null ? t.typeId : t.TypeId, subTypeId: t.subTypeId != null ? t.subTypeId : t.SubTypeId,
  })).filter(t => t.id && t.amount !== 0 && !isNaN(t.date));
}
async function cfRefresh(trigger, daysOverride) {
  if (!vivaConfigured()) throw new Error('Viva credentials not configured (VIVA_TX_USER / VIVA_TX_PASS).');
  if (!pool) throw new Error('No database configured.');
  const now = new Date();
  const _span = Math.max(30, Math.min(1200, parseInt(daysOverride, 10) || CF_DAYS));
  const from = pcvAdd(pcvDay0(now), -_span);
  // The merchants v2 Search returns EVERY transaction (credits and debits);
  // vivaFetchTransactions' fallback filters to credits only - flag that case.
  const failures = [];
  let raw = await vivaMerchantsStrategy(from.toISOString(), now.toISOString(), failures);
  let creditsOnly = false;
  if (!raw) { raw = await vivaFetchTransactions(from.toISOString(), now.toISOString()); creditsOnly = true; }
  const txs = cfNormalizeAll(raw);
  const byDay = {};
  for (let i = 0; i <= _span; i++) { const d = pcvAdd(from, i); byDay[pcvISO(d)] = { d: pcvISO(d), inc: 0, exp: 0, intIn: 0, intOut: 0 }; }
  const internals = [];
  const typeHisto = {};
  for (const t of txs) {
    const k = pcvISO(pcvDay0(t.date));
    const row = byDay[k]; if (!row) continue;
    const isInt = cfIsInternal(t.counterpart);
    const th = (t.typeId != null ? t.typeId : '?') + '/' + (t.subTypeId != null ? t.subTypeId : '?') + (t.amount < 0 ? ' out' : ' in');
    typeHisto[th] = (typeHisto[th] || 0) + 1;
    if (t.amount > 0) {
      row.inc = Math.round((row.inc + t.amount) * 100) / 100;
      if (isInt) row.intIn = Math.round((row.intIn + t.amount) * 100) / 100;
    } else {
      const a = -t.amount;
      row.exp = Math.round((row.exp + a) * 100) / 100;
      if (isInt) row.intOut = Math.round((row.intOut + a) * 100) / 100;
    }
    if (isInt) internals.push({ d: k, amount: t.amount, counterpart: String(t.counterpart || '').slice(0, 60) });
  }
  internals.sort((a, b) => a.d < b.d ? 1 : -1);
  // Diagnostics: biggest movements with their counterparties - used to identify
  // the internal Eurobank sweep transfers and tune VIVA_INTERNAL_IBANS.
  const _outs = txs.filter(t => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 15).map(t => ({ d: pcvISO(pcvDay0(t.date)), amount: t.amount, counterpart: String(t.counterpart || '').slice(0, 70), typeId: t.typeId, subTypeId: t.subTypeId }));
  const _ins = txs.filter(t => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 10).map(t => ({ d: pcvISO(pcvDay0(t.date)), amount: t.amount, counterpart: String(t.counterpart || '').slice(0, 70), typeId: t.typeId, subTypeId: t.subTypeId }));
  // Preserve the cron claim through manual refreshes
  let prevCron = null;
  try { const pr = await pool.query('SELECT data FROM app_data WHERE key = $1', [CF_KEY]); prevCron = pr.rows[0] && pr.rows[0].data && pr.rows[0].data.lastCronDate || null; } catch (e) {}
  // The account's first transaction is its real start - drop the flat zero days
  // before it so a wide window does not carry months of dead space.
  const _allRows = Object.values(byDay).sort((a, b) => a.d < b.d ? -1 : 1);
  const _fi = _allRows.findIndex(r => r.inc || r.exp);
  const _rows = _fi > 0 ? _allRows.slice(_fi) : _allRows;
  const rec = {
    updatedAt: now.toISOString(), trigger, creditsOnly, lastCronDate: prevCron,
    from: _rows.length ? _rows[0].d : pcvISO(from), to: pcvISO(pcvDay0(now)),
    txCount: txs.length, typeHisto, spanDays: _span, requestedFrom: pcvISO(from),
    firstActive: _fi >= 0 ? _allRows[_fi].d : null,
    days: _rows,
    internals: internals.slice(0, 40),
    topOut: _outs, topIn: _ins,
  };
  await pool.query(
    `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
    [CF_KEY, JSON.stringify(rec)]
  );
  console.log(`[viva][cashflow] ${trigger}: ${txs.length} tx, ${internals.length} internal-tagged, creditsOnly=${creditsOnly}`);
  return rec;
}
app.get('/api/viva/cashflow', async (req, res) => {
  try {
    if (!pool) return res.json({ ok: false, error: 'No database configured.' });
    const r = await pool.query('SELECT data FROM app_data WHERE key = $1', [CF_KEY]);
    res.json({ ok: true, configured: vivaConfigured(), data: (r.rows[0] && r.rows[0].data) || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/viva/cashflow/refresh', async (req, res) => {
  try {
    const rec = await Promise.race([
      cfRefresh('manual', req.query && req.query.days),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Viva cash-flow refresh did not finish in time - check the [viva] lines in the Railway logs.')), 240000)),
    ]);
    res.json({ ok: true, txCount: rec.txCount, updatedAt: rec.updatedAt, internals: rec.internals.length, creditsOnly: rec.creditsOnly });
  } catch (e) {
    console.error('[viva][cashflow] refresh error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Daily 06:00 Europe/Athens auto-refresh (claim-the-date guard, mirrors vivaCronTick)
async function cfCronTick() {
  try {
    if (!vivaConfigured() || !pool) return;
    const a = vivaAthensNow();
    if (a.hour !== 6) return;
    const r = await pool.query('SELECT data FROM app_data WHERE key = $1', [CF_KEY]);
    const data = (r.rows[0] && r.rows[0].data) || {};
    if (data.lastCronDate === a.date) return;
    data.lastCronDate = a.date;   // claim first so a crash cannot loop-fire
    await pool.query(`INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`, [CF_KEY, JSON.stringify(data)]);
    await cfRefresh('cron-6am');
  } catch (e) { console.error('[viva][cashflow] cron error:', e.message); }
}
setInterval(cfCronTick, 10 * 60 * 1000);   // fires once, 06:00-06:59 Athens, every day

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

  // Votsala 1+2 share clearGroup → one Booking.com expectation (same as client Payments Check)
  const votsalaData = {
    payChk: { marks: {}, cfg: { from: '2026-07-01', tol: 1 } },
    apts: [
      { id: 'v1', name: 'Votsala 1 Luxury Stay with Patio', clearGroup: 'Votsala' },
      { id: 'v2', name: 'Votsala 2 Luxury Stay with Patio', clearGroup: 'Votsala' },
    ],
    bks: [
      { platform: 'Booking.com', aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio', guestName: 'A', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 100 },
      { platform: 'Booking.com', aptId: 'v2', aptName: 'Votsala 2 Luxury Stay with Patio', guestName: 'B', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 50 },
    ],
  };
  const vUnits = vivaExpectedUnits(votsalaData, today);
  const vLine = vUnits.find(u => u.key && u.key.indexOf('|votsala') >= 0);
  ok('Votsala clearGroup → one BDC unit', vUnits.filter(u => u.chan === 'bdc').length === 1);
  ok('Votsala clearGroup sums payouts (150)', !!vLine && Math.abs(vLine.exp - 150) < 0.001);
  ok('Votsala mark key uses group name', !!vLine && vLine.key === 'bdc|2026-07-16|votsala');

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
