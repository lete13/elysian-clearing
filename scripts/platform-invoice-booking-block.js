'use strict';
/**
 * Shared Booking.com server-IP block detection + cooldown.
 *
 * Used by in-app Connect (server) and unattended Pull (this worker).
 * Postgres `app_data` key `pi_booking_block` is the source of truth so a
 * Railway deploy / replica recycle cannot forget the cooldown. `/tmp` is
 * only a last-resort cache when DATABASE_URL is missing.
 *
 * Detection is body text (Sign-in failed / Try again later) AND HTTP 403/429
 * on booking.com document/xhr/fetch responses.
 */

const BLOCK_KEY = 'pi_booking_block';
const DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const BLOCK_FILE = '/tmp/elysian-booking-connect-blocked-until';

function cooldownMs() {
  const n = Number(process.env.BOOKING_CONNECT_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}

function looksBlockedText(text) {
  return /sign[\s-]?in failed|try again later|too many (?:attempts|requests)|unusual (?:activity|traffic)|we couldn.?t sign you in/i.test(
    String(text || '')
  );
}

function looksHumanCheckText(text) {
  return /let'?s make sure you.?re human|verify you are human|are you a robot|press and hold/i.test(String(text || ''));
}

function looksBlockedStatus(status) {
  const n = Number(status);
  return n === 403 || n === 429;
}

function looksBlockedPage(opts) {
  opts = opts || {};
  if (looksBlockedStatus(opts.status)) return true;
  return looksBlockedText(opts.text);
}

function parseBlockData(data) {
  if (data == null || data === '') return null;
  let obj = data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (/^\d+$/.test(trimmed)) {
      const until = Number(trimmed);
      return Number.isFinite(until) && until > 0 ? { until: until } : null;
    }
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
  }
  if (typeof obj === 'number') {
    return Number.isFinite(obj) && obj > 0 ? { until: obj } : null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const until = Number(obj.until);
  if (!Number.isFinite(until) || until <= 0) return null;
  return {
    until: until,
    reason: obj.reason || '',
    status: obj.status || 0,
    source: obj.source || '',
    updatedAt: obj.updatedAt || '',
  };
}

function isActive(row, now) {
  const t = now == null ? Date.now() : now;
  return !!(row && Number(row.until) > t);
}

function blockedError(row) {
  const until = (row && Number(row.until)) || 0;
  const remainMin = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  const when = until ? new Date(until).toISOString() : 'later';
  return (
    'Booking.com blocked this server network. Connect/Pull paused until ' +
    when +
    ' (~' +
    remainMin +
    ' more minutes). Do not password-login from this IP.'
  );
}

function parsePlaywrightProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!u.hostname) return { server: s };
    const server = u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
    const out = { server: server };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (e) {
    return { server: s };
  }
}

function attachPageWatch(page) {
  if (page && page._piBookingWatch) return page._piBookingWatch;
  const state = { lastStatus: 0, lastUrl: '', blockedHttp: false };
  if (page) page._piBookingWatch = state;
  if (!page || typeof page.on !== 'function') return state;
  page.on('response', function (res) {
    try {
      const url = String((res.url && res.url()) || '');
      if (!/booking\.com/i.test(url)) return;
      const status = Number(res.status && res.status());
      if (!looksBlockedStatus(status)) return;
      let rt = '';
      try {
        const req = res.request && res.request();
        rt = String((req && req.resourceType && req.resourceType()) || '');
      } catch (eRt) {
        rt = '';
      }
      if (rt && rt !== 'document' && rt !== 'xhr' && rt !== 'fetch') return;
      state.lastStatus = status;
      state.lastUrl = url;
      state.blockedHttp = true;
    } catch (eWatch) {}
  });
  return state;
}

function createPoolFromEnv() {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PGDATABASE_URL ||
    process.env.DATABASE_PRIVATE_URL ||
    process.env.POSTGRES_PRIVATE_URL ||
    '';
  if (!url) return null;
  const { Pool } = require('pg');
  return new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
}

function writeBlockFile(row) {
  try {
    require('fs').writeFileSync(BLOCK_FILE, JSON.stringify(row));
  } catch (eWrite) {}
}

function readBlockFile() {
  try {
    return parseBlockData(require('fs').readFileSync(BLOCK_FILE, 'utf8'));
  } catch (eRead) {
    return null;
  }
}

async function readBlocked(pool) {
  if (pool) {
    try {
      const r = await pool.query('SELECT data FROM app_data WHERE key=$1', [BLOCK_KEY]);
      if (r.rows.length && r.rows[0].data) {
        const row = parseBlockData(r.rows[0].data);
        if (isActive(row)) return row;
        return null;
      }
    } catch (e) {
      try {
        console.error('[booking-block] read', e.message);
      } catch (e2) {}
    }
  }
  const fileRow = readBlockFile();
  if (isActive(fileRow)) return fileRow;
  return null;
}

async function markBlocked(pool, extra) {
  extra = extra || {};
  const until = Date.now() + cooldownMs();
  const row = {
    until: until,
    reason: String(extra.reason || '').replace(/\s+/g, ' ').slice(0, 400),
    status: Number(extra.status) || 0,
    source: String(extra.source || ''),
    updatedAt: new Date().toISOString(),
  };
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [BLOCK_KEY, JSON.stringify(row)]
      );
    } catch (e) {
      try {
        console.error('[booking-block] write', e.message);
      } catch (e2) {}
    }
  }
  writeBlockFile(row);
  return row;
}

async function clearBlocked(pool) {
  if (pool) {
    try {
      await pool.query('DELETE FROM app_data WHERE key=$1', [BLOCK_KEY]);
    } catch (e) {}
  }
  try {
    require('fs').unlinkSync(BLOCK_FILE);
  } catch (eUn) {}
}

module.exports = {
  BLOCK_KEY,
  BLOCK_FILE,
  DEFAULT_COOLDOWN_MS,
  cooldownMs,
  looksBlockedText,
  looksHumanCheckText,
  looksBlockedStatus,
  looksBlockedPage,
  parseBlockData,
  isActive,
  blockedError,
  parsePlaywrightProxy,
  attachPageWatch,
  createPoolFromEnv,
  readBlocked,
  markBlocked,
  clearBlocked,
};
