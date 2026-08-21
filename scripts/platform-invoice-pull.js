#!/usr/bin/env node
/**
 * Platform invoice portal pull — Airbnb + Booking.com (automated)
 *
 * Usage:
 *   node scripts/platform-invoice-pull.js --month=2026-07 [--channel=all|airbnb|booking] [--out=/tmp/pi] [--headed]
 *
 * Sessions (preferred — avoids captcha/OTP on Railway):
 *   PI_SESSION_DIR/airbnb.json + booking.json  (written by API from DB)
 *   or AIRBNB_STORAGE_STATE_B64 / BOOKING_STORAGE_STATE_B64
 *   After a successful authenticated visit, refreshes are written to
 *   PI_SESSION_DIR/<channel>.json when --save-sessions is set (default when PI_SESSION_DIR is set).
 *
 * Env:
 *   AIRBNB_HOST_EMAIL / AIRBNB_HOST_PASSWORD
 *   BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD
 *   PLAYWRIGHT_PROXY_SERVER (optional, e.g. http://user:pass@host:port)
 *   AIRBNB_OTP (optional one-shot code if password login hits OTP)
 *   PI_APARTMENTS_JSON or PI_APARTMENTS_FILE (JSON array of {aptId,aptName,bookingHotelId,clearGroup})
 *   PI_AIRBNB_HAVE_JSON or PI_AIRBNB_HAVE_FILE — vault filenames already saved (skip list)
 *   PI_AIRBNB_RESERVATIONS_JSON or PI_AIRBNB_RESERVATIONS_FILE — Hosthub-driven Airbnb codes (VAT Invoicer-style):
 *     JSON array of {code, kind:'invoice'|'credit_note'|'both', aptId, aptName, guestName, created, createdOnChannel, checkIn, checkOut}
 *     Worker opens /hosting/stay/{CODE} (Airbnb's current reservation page), clicks the
 *     total price (Airbnb Help 438), finds every VAT invoice / credit note ID on that stay,
 *     fetches /invoice/{token} and /vat_invoices/{token} with the host session, opens them
 *     in a new tab on airbnb.gr + airbnb.com (VAT Invoicer), prints PDF. Cancel = debit + credit; extend = original debit
 *     + credit of that debit + new debit. Filenames are kind-{code}-{vatId}.pdf.
 *   PI_AIRBNB_LIMIT — optional max codes (Collect "Test pull (5 codes)" = latest N by created).
 *
 * Booking.com: https://admin.booking.com/ group Finance → Invoices mass extract
 * for document month M (June stays → July invoice). One PDF per Booking property;
 * Votsala 1–8 share one id / one PDF. Filing uses bookingHotelId only.
 * Dating: Booking invoice month M covers bookings from M−1;
 *         Airbnb VAT file month = invoice issue date on the VAT HTML (extensions reissue).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { issueDateToMonth } = require('./platform-invoice-accountant-xls');
const booking = require('./platform-invoice-booking');
const bookingBlock = require('./platform-invoice-booking-block');

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

const MONTH = arg('month', '');
const CHANNEL = String(arg('channel', 'all')).toLowerCase();
const OUT = arg('out', path.join('/tmp', 'platform-invoices-' + (MONTH || 'na')));
const HEADED = flag('headed');
const SESSION_DIR = arg('session-dir', process.env.PI_SESSION_DIR || '');
const SAVE_SESSIONS = flag('save-sessions') || !!SESSION_DIR;

if (!/^\d{4}-\d{2}$/.test(MONTH)) {
  console.log(JSON.stringify({ ok: false, error: 'Usage: --month=YYYY-MM required' }));
  process.exit(2);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function loadJsonBlob(envKey, fileKey) {
  const fp = process.env[fileKey];
  if (fp) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
      return null;
    }
  }
  const raw = process.env[envKey] || '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
function loadApartments() {
  const arr = loadJsonBlob('PI_APARTMENTS_JSON', 'PI_APARTMENTS_FILE');
  return Array.isArray(arr) ? arr : [];
}

function loadAirbnbLimit() {
  const n = parseInt(process.env.PI_AIRBNB_LIMIT || '0', 10);
  return n > 0 ? n : 0;
}

const pullStop = { requested: false, why: '', dumped: false };
const pullLive = { files: null, errors: null };
function emitJson(obj) {
  try {
    fs.writeSync(1, JSON.stringify(obj) + '\n');
  } catch (e) {
    try {
      console.log(JSON.stringify(obj));
    } catch (e2) {}
  }
}
function airbnbHaveKey(kind, code, vatId) {
  const k = String(kind || 'invoice').toLowerCase() === 'credit_note' ? 'credit_note' : 'invoice';
  const c = String(code || '').toUpperCase();
  const v = String(vatId || '').toUpperCase();
  return v ? k + ':' + c + ':' + v : k + ':' + c;
}
function loadAirbnbHaveSet() {
  const parsed = loadJsonBlob('PI_AIRBNB_HAVE_JSON', 'PI_AIRBNB_HAVE_FILE');
  const arr = Array.isArray(parsed) ? parsed : [];
  const set = new Set();
  (arr || []).forEach(function (x) {
    if (x && typeof x === 'object' && x.code) {
      set.add(airbnbHaveKey(x.kind, x.code, x.vatId || x.invoiceId || ''));
      return;
    }
    const s = String(x || '').toUpperCase();
    const m = s.match(/(INVOICE|CREDIT_NOTE)-([A-Z0-9]{6,20})(?:-([A-Z0-9._-]+?))?(?:\.PDF)?(?:\s|$)/);
    if (m) {
      const kind = m[1] === 'CREDIT_NOTE' ? 'credit_note' : 'invoice';
      set.add(airbnbHaveKey(kind, m[2], m[3] || ''));
      return;
    }
    const code = String(x || '').trim().toUpperCase();
    if (/^[A-Z0-9]{6,20}$/.test(code)) {
      set.add(airbnbHaveKey('invoice', code));
      set.add(airbnbHaveKey('credit_note', code));
    }
  });
  return set;
}
function airbnbDocAlreadyHave(have, kind, code, vatId) {
  if (!have || !have.size) return false;
  const c = String(code || '').toUpperCase();
  const v = String(vatId || '').toUpperCase();
  if (v) return have.has(airbnbHaveKey(kind, c, v));
  return have.has(airbnbHaveKey(kind, c));
}
function airbnbResvAlreadyHave(resv, have) {
  // Always reopen the stay: one saved PDF is not the full debit/credit/extension set.
  return false;
}
function requestPullStop(why) {
  if (pullStop.requested) return;
  pullStop.requested = true;
  pullStop.why = String(why || 'stop');
}
function pullStopRequested() {
  return pullStop.requested;
}
function emitStoppedResult() {
  if (pullStop.dumped) return;
  pullStop.dumped = true;
  const files = pullLive.files || [];
  const errors = (pullLive.errors || []).slice();
  if (!errors.some((e) => e && (e.error === 'Pull stopped' || String(e.error || '').indexOf('interrupted') >= 0))) {
    errors.push({ channel: 'airbnb', error: pullStop.why ? ('Pull interrupted (' + pullStop.why + ')') : 'Pull stopped' });
  }
  emitJson({
    ok: files.length > 0,
    stopped: true,
    incomplete: true,
    month: MONTH,
    files,
    errors,
    airbnbCodes: loadAirbnbReservations().length,
  });
}
process.on('SIGTERM', function () {
  requestPullStop('SIGTERM');
  setTimeout(function () {
    emitStoppedResult();
    process.exit(0);
  }, 1200);
});
process.on('SIGINT', function () {
  requestPullStop('SIGINT');
  setTimeout(function () {
    emitStoppedResult();
    process.exit(0);
  }, 1200);
});
process.on('uncaughtException', function (e) {
  requestPullStop((e && e.message) || 'uncaughtException');
  try {
    (pullLive.errors || []).push({ channel: 'airbnb', error: (e && e.message) || String(e) });
  } catch (e2) {}
  emitStoppedResult();
  process.exit(1);
});
process.on('unhandledRejection', function (e) {
  requestPullStop((e && e.message) || 'unhandledRejection');
  try {
    (pullLive.errors || []).push({ channel: 'airbnb', error: (e && e.message) || String(e) });
  } catch (e2) {}
  emitStoppedResult();
  process.exit(1);
});

function platformStoreLabel(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'booking' || c === 'bdc') return 'Booking.com';
  return 'Airbnb';
}

function aptStoreFolder(name) {
  const s = String(name || 'Apartment')
    .replace(/[\\/]+/g, ' ')
    .replace(/[^\w.\-\u00C0-\u024F\u0370-\u03FF ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || 'Apartment').slice(0, 60);
}

/** Durable store path: Platform / month / apartment / kind-code.pdf */
function piInvoiceStoreRel(opts) {
  const plat = platformStoreLabel(opts && opts.channel);
  const month = String((opts && opts.month) || 'unknown');
  const apt = aptStoreFolder((opts && (opts.aptName || opts.partner)) || 'Apartment');
  const kind = String((opts && opts.kind) || 'invoice').replace(/[^\w-]+/g, '_') || 'invoice';
  const code = String((opts && (opts.code || opts.reservationId)) || '').replace(/[^\w-]+/g, '_');
  const leaf = code ? kind + '-' + code + '.pdf' : kind + '.pdf';
  return plat + '/' + month + '/' + apt + '/' + leaf;
}

function airbnbPortalOrigin() {
  const raw = String(process.env.PI_AIRBNB_ORIGIN || 'https://www.airbnb.com').replace(/\/$/, '');
  return raw || 'https://www.airbnb.com';
}
function airbnbPortalIsLive() {
  return /airbnb\./i.test(airbnbPortalOrigin());
}

function airbnbCreatedMs(r) {
  const raw =
    r && r.createdOnChannel != null && r.createdOnChannel !== ''
      ? r.createdOnChannel
      : r && r.created;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(raw));
  return isFinite(parsed) ? parsed : 0;
}

/** Newest Hosthub created/createdOnChannel first (Test pull = latest N ids). */
function sortAirbnbReservationsLatest(list) {
  return (list || []).slice().sort((a, b) => airbnbCreatedMs(b) - airbnbCreatedMs(a));
}

/** Hosthub channel reservation codes for Airbnb (confirmation codes). */
function loadAirbnbReservations() {
  try {
    const arr = loadJsonBlob('PI_AIRBNB_RESERVATIONS_JSON', 'PI_AIRBNB_RESERVATIONS_FILE');
    if (!Array.isArray(arr)) return [];
    let list = arr
      .map((r) => ({
        code: String((r && (r.code || r.reservationId || r.confirmationCode)) || '')
          .trim()
          .toUpperCase(),
        kind: String((r && r.kind) || 'both').toLowerCase(),
        aptId: String((r && (r.aptId || r.apartmentId)) || '').trim(),
        aptName: String((r && (r.aptName || r.apartmentName)) || '').trim(),
        guestName: String((r && (r.guestName || r.guest)) || '').trim(),
        created: r && r.created != null ? r.created : null,
        createdOnChannel:
          r && r.createdOnChannel != null
            ? r.createdOnChannel
            : r && r.created_on_channel != null
              ? r.created_on_channel
              : null,
        checkIn: r && r.checkIn != null ? String(r.checkIn) : r && r.check_in != null ? String(r.check_in) : '',
        checkOut: r && r.checkOut != null ? String(r.checkOut) : r && r.check_out != null ? String(r.check_out) : '',
      }))
      .filter((r) => r.code && /^[A-Z0-9]{6,20}$/.test(r.code));
    const limit = loadAirbnbLimit();
    if (limit > 0) list = sortAirbnbReservationsLatest(list).slice(0, limit);
    return list;
  } catch (e) {
    return [];
  }
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function matchApartment(label, apts) {
  if (booking.isPortalChromeLabel(label)) return { aptId: '', aptName: '' };
  const n = norm(label);
  if (!n || !apts.length) return { aptId: '', aptName: String(label || '').trim() };
  let best = null;
  let bestScore = 0;
  for (const a of apts) {
    const id = String(a.aptId || '').trim();
    const name = String(a.aptName || '').trim();
    const candidates = [id, name, norm(id), norm(name)].filter(Boolean);
    for (const c of candidates) {
      const cn = norm(c);
      if (!cn) continue;
      if (n === cn || n.includes(cn) || cn.includes(n)) {
        const score = cn.length;
        if (score > bestScore) {
          bestScore = score;
          best = { aptId: id, aptName: name || label };
        }
      }
    }
  }
  return best || { aptId: '', aptName: String(label || '').trim() };
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    return null;
  }
}

async function loadStorageState(prefix) {
  const lower = prefix.toLowerCase();
  if (SESSION_DIR) {
    const p = path.join(SESSION_DIR, lower + '.json');
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      return { __error: e.message };
    }
  }
  const b64 = process.env[prefix + '_STORAGE_STATE_B64'] || '';
  const raw = process.env[prefix + '_STORAGE_STATE'] || '';
  try {
    if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (raw) {
      if (raw.trim().startsWith('{')) return JSON.parse(raw);
      if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, 'utf8'));
    }
  } catch (e) {
    return { __error: e.message };
  }
  return null;
}

async function persistSession(prefix, context) {
  if (!SAVE_SESSIONS || !SESSION_DIR || !context) return;
  try {
    ensureDir(SESSION_DIR);
    const state = await context.storageState();
    fs.writeFileSync(path.join(SESSION_DIR, prefix.toLowerCase() + '.json'), JSON.stringify(state));
  } catch (e) {
    /* ignore */
  }
}

let _bookingBlockPool;
function bookingBlockPool() {
  if (_bookingBlockPool !== undefined) return _bookingBlockPool;
  _bookingBlockPool = bookingBlock.createPoolFromEnv() || null;
  return _bookingBlockPool;
}
async function bookingBlockPoolClose() {
  if (_bookingBlockPool && typeof _bookingBlockPool.end === 'function') {
    await _bookingBlockPool.end().catch(function () {});
  }
  _bookingBlockPool = undefined;
}

function bookingEnsureDisplay() {
  if (!process.env.DISPLAY) process.env.DISPLAY = ':99';
  try {
    const n = String(process.env.DISPLAY).replace(/^:/, '').split('.')[0];
    if (fs.existsSync('/tmp/.X11-unix/X' + n)) return;
    const { spawn, spawnSync } = require('child_process');
    const child = spawn('Xvfb', [process.env.DISPLAY, '-screen', '0', '1920x1080x24', '-ac'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', function () {});
    child.unref();
    spawnSync('sleep', ['0.5']);
  } catch (eXvfb) {}
}

async function withBrowser(fn, opts) {
  const pw = await loadPlaywright();
  if (!pw) {
    return { ok: false, error: 'playwright package not installed' };
  }
  const kind = String((opts && opts.kind) || '').toLowerCase();
  const bookingKind = kind === 'booking' || kind === 'bdc';
  if (bookingKind) bookingEnsureDisplay();
  let browser;
  const proxy = bookingBlock.parsePlaywrightProxy(
    process.env.PLAYWRIGHT_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  );
  const launchOpts = {
    headless: bookingKind ? false : !HEADED,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    ...(proxy ? { proxy: proxy } : {}),
  };
  if (bookingKind) {
    launchOpts.ignoreDefaultArgs = ['--enable-automation'];
    launchOpts.args = launchOpts.args.concat([
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1440,900',
    ]);
  }
  try {
    try {
      browser = await pw.chromium.launch(Object.assign({}, launchOpts, { channel: 'chrome' }));
    } catch (e0) {
      browser = await pw.chromium.launch(launchOpts);
    }
  } catch (e) {
    return {
      ok: false,
      error: 'Chromium not available: ' + e.message,
      hint: 'Run: npx playwright install chromium',
    };
  }
  const storageState = opts && opts.storageState;
  const contextOpts = {
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    locale: bookingKind ? 'en-GB' : 'en-US',
    timezoneId: process.env.PI_AIRBNB_TZ || 'Europe/Athens',
    geolocation: { latitude: 37.9838, longitude: 23.7275 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': bookingKind ? 'en-GB,en;q=0.9,el;q=0.8' : 'en-US,en;q=0.9' },
    ...(storageState ? { storageState } : {}),
  };
  if (!bookingKind) {
    contextOpts.userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  }
  const context = await browser.newContext(contextOpts);
  await context.addInitScript(function () {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  if (bookingKind) {
    const ua = await page.evaluate(function () { return navigator.userAgent; }).catch(function () { return ''; });
    if (/HeadlessChrome/i.test(ua)) {
      await browser.close().catch(function () {});
      return {
        ok: false,
        error: 'Booking.com Pull needs headed Chrome (Xvfb). HeadlessChrome is blocked.',
      };
    }
  }
  try {
    return await fn(page, context, browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function saveDownload(download, dir, filename) {
  ensureDir(dir);
  const dest = path.join(dir, filename);
  await download.saveAs(dest);
  const st = fs.statSync(dest);
  if (!st.size || st.size < TINY_PDF_BYTES) {
    try { fs.unlinkSync(dest); } catch (eUn) {}
    return null;
  }
  return { path: dest, filename, bytes: st.size };
}

async function tryFillOtp(page, dir) {
  const otp = String(process.env.AIRBNB_OTP || process.env.PI_AIRBNB_OTP || '').trim();
  if (!otp) return false;
  const otpInput = page
    .locator(
      'input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]'
    )
    .first();
  if (!(await otpInput.count())) return false;
  await otpInput.fill(otp);
  await page.locator('button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').first().click().catch(() => {});
  await page.waitForTimeout(3000);
  return true;
}

async function ensureAirbnbLoggedIn(page, context, dir, errors) {
  if (!airbnbPortalIsLive()) return true;
  const stored = await loadStorageState('AIRBNB');
  if (stored && stored.__error) {
    errors.push({ channel: 'airbnb', error: 'AIRBNB session invalid: ' + stored.__error });
    return false;
  }
  if (!stored) {
    errors.push({
      channel: 'airbnb',
      error: 'No Airbnb session. Click Connect Airbnb, enter the email code, wait until it says connected, then Pull.',
    });
    return false;
  }

  await page.goto('https://www.airbnb.com/hosting/reservations', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(2500);

  const bodyNow = await page.locator('body').innerText().catch(() => '');
  if (
    /log.?in|sign.?in/i.test(page.url()) ||
    /log in to continue|welcome to airbnb|enter your password|try another way/i.test(bodyNow) ||
    (await page.locator('input[type="password"], #phone-or-email').count())
  ) {
    errors.push({
      channel: 'airbnb',
      error: 'Airbnb session expired — reconnect Airbnb in Platform Invoices (Connect Airbnb, email code), then Pull again.',
    });
    return false;
  }

  await persistSession('AIRBNB', context);
  await mirrorAirbnbCookiesToGr(context);
  return true;
}

const TINY_PDF_BYTES = 2048;
function isTinyPdf(buf) {
  return !buf || !buf.length || buf.length < TINY_PDF_BYTES;
}

function savePdfBuffer(dir, filename, buf) {
  if (isTinyPdf(buf)) return null;
  ensureDir(dir);
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, buf);
  return { path: dest, filename, bytes: buf.length };
}

function kindFromInvoiceBlob(s) {
  const t = String(s || '').toLowerCase();
  if (/credit\s*note|credit[_-]?note|πιστωτικ/.test(t)) return 'credit_note';
  return 'invoice';
}

/**
 * VAT Invoicer privacy flow step 4: search reservation HTML/JSON for the
 * Airbnb VAT invoice ID (and any invoice-page URLs already on the page).
 */
function extractAirbnbVatInvoiceHits(html, origin) {
  const text = String(html || '');
  const base = origin || 'https://www.airbnb.com';
  const hits = [];
  const seen = new Set();
  function add(kind, href, id, how) {
    const h = String(href || '').trim();
    let i = String(id || '').trim();
    if (i && /^(true|false|null|undefined)$/i.test(i)) i = '';
    if (i && (i.length < 4 || i.length > 80)) i = '';
    if (!h && !i) return;
    const k = kind || 'invoice';
    const key = k + '|' + h + '|' + i;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind: k, href: h, id: i, how: how || 'scan' });
  }
  function abs(href) {
    try {
      return new URL(href, base).href;
    } catch (e) {
      return '';
    }
  }

  const urlRe = /https?:\/\/[^"'\\\s<>]*?(vat[_-]?invoice|tax[_-]?invoice|credit[_-]?note)[^"'\\\s<>]*/gi;
  let m;
  while ((m = urlRe.exec(text))) {
    add(kindFromInvoiceBlob(m[0]), abs(m[0]), '', 'html-url');
  }
  const pathRe = /(?:^|["'\s])(\/(?:[a-z0-9_-]+\/)*(?:vat[_-]?invoice|tax[_-]?invoice)[^"'\\\s<>]*)/gi;
  while ((m = pathRe.exec(text))) {
    add(kindFromInvoiceBlob(m[1]), abs(m[1]), '', 'html-path');
  }

  const keyRe =
    /"(vatInvoiceId|taxInvoiceId|vat_invoice_id|tax_invoice_id|creditNoteId|credit_note_id|invoiceId|invoice_id|vatInvoiceToken|taxInvoiceToken|vatInvoiceUuid|taxInvoiceUuid)"\s*:\s*"([^"]+)"/gi;
  while ((m = keyRe.exec(text))) {
    add(kindFromInvoiceBlob(m[1]), '', m[2], 'json-id:' + m[1]);
  }
  const keyNumRe =
    /"(vatInvoiceId|taxInvoiceId|vat_invoice_id|tax_invoice_id|creditNoteId|invoiceId|vatInvoiceToken)"\s*:\s*(\d{4,})/gi;
  while ((m = keyNumRe.exec(text))) {
    add(kindFromInvoiceBlob(m[1]), '', m[2], 'json-id:' + m[1]);
  }

  const objRe = /"(vatInvoice|taxInvoice|vat_invoice|tax_invoice|creditNote)"\s*:\s*\{[^}]{0,800}\}/gi;
  while ((m = objRe.exec(text))) {
    const chunk = m[0];
    const idm = chunk.match(/"(?:id|invoiceId|token|uuid)"\s*:\s*"([^"]+)"/i);
    const urlm = chunk.match(/"(?:url|href|link|invoiceUrl)"\s*:\s*"([^"]+)"/i);
    add(kindFromInvoiceBlob(m[1]), urlm ? abs(urlm[1]) : '', idm ? idm[1] : '', 'json-obj:' + m[1]);
  }

  const urlKeyRe = /"(vatInvoiceUrl|taxInvoiceUrl|invoiceUrl|invoiceURL|vat_invoice_url)"\s*:\s*"([^"]+)"/gi;
  while ((m = urlKeyRe.exec(text))) {
    if (/vat|tax|invoice/i.test(m[2])) add(kindFromInvoiceBlob(m[1] + ' ' + m[2]), abs(m[2]), '', 'json-url:' + m[1]);
  }

  const pathIdRe = /\/(?:reservation\/)?(?:vat_invoice|tax_invoice|vat_invoices)\/([A-Za-z0-9_-]+)/gi;
  while ((m = pathIdRe.exec(text))) {
    add('invoice', abs(m[0]), m[1], 'path-id');
  }
  const shortInvRe = /\/invoice\/([A-Za-z0-9_-]{6,})/gi;
  while ((m = shortInvRe.exec(text))) {
    if (/vat[_-]?invoice|tax[_-]?invoice/i.test(m[0])) continue;
    add('invoice', abs('/invoice/' + m[1]), m[1], 'short-invoice-id');
  }
  const arrRe = /"(vatInvoices|taxInvoices|hostVatInvoices|vatDocuments|taxDocuments|creditNotes|debitNotes)"\s*:\s*(\[[^\]]{0,8000}\])/gi;
  while ((m = arrRe.exec(text))) {
    const chunk = m[2] || '';
    const idRe = /"(?:id|invoiceId|vatInvoiceId|token|uuid)"\s*:\s*"([^"]+)"/gi;
    let im;
    while ((im = idRe.exec(chunk))) {
      add(kindFromInvoiceBlob(m[1] + ' ' + chunk.slice(Math.max(0, im.index - 80), im.index + 80)), '', im[1], 'json-arr:' + m[1]);
    }
    const urlRe2 = /"(?:url|href|link|invoiceUrl)"\s*:\s*"([^"]+)"/gi;
    while ((im = urlRe2.exec(chunk))) {
      add(kindFromInvoiceBlob(m[1] + ' ' + im[1]), abs(im[1]), '', 'json-arr-url:' + m[1]);
    }
  }
  return hits;
}

function airbnbInvoicePagePatterns(html) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^"'\\\s<>]*?(vat[_-]?invoice|tax[_-]?invoice)[^"'\\\s<>]*/gi;
  let m;
  while ((m = re.exec(text))) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out.slice(0, 20);
}

function airbnbBareInvoicePath(url) {
  const s = String(url || '');
  if (/vat[_-]?invoice|tax[_-]?invoice|credit[_-]?note/i.test(s)) return false;
  try {
    const u = new URL(s, 'https://www.airbnb.com');
    return /^\/invoice\/[A-Za-z0-9_-]+\/?$/i.test(u.pathname);
  } catch (e) {
    return /(?:^|\/)invoice\/[A-Za-z0-9_-]+/i.test(s);
  }
}

/** VAT Invoicer opens https://{countryDomain}/invoice/{token} in a new tab. Greece → airbnb.gr. */
function airbnbInvoiceHosts(origin) {
  const hosts = [];
  function add(h) {
    const s = String(h || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
    if (s && hosts.indexOf(s) < 0) hosts.push(s);
  }
  try {
    add(new URL(origin || 'https://www.airbnb.com').host);
  } catch (e) {
    add('www.airbnb.com');
  }
  if (/airbnb\./i.test(String(origin || ''))) {
    add('www.airbnb.gr');
    add('www.airbnb.com');
  }
  return hosts;
}

function airbnbInvoiceUrlsForHit(hit, origin, pageUrlPatterns) {
  const urls = [];
  const seen = new Set();
  function push(u) {
    if (!u || seen.has(u)) return;
    try {
      const p = new URL(u, origin || 'https://www.airbnb.com').pathname;
      if (/^\/invoice\/?$/i.test(p)) return;
    } catch (e) {}
    seen.add(u);
    urls.push(u);
  }
  const origin0 = String(origin || 'https://www.airbnb.com').replace(/\/$/, '');
  const id = String((hit && hit.id) || vatIdFromAirbnbUrl(hit && hit.href) || '').trim();
  if (hit && hit.href) push(hit.href);
  if (id) {
    const enc = encodeURIComponent(id);
    airbnbInvoiceHosts(origin0).forEach((host) => {
      let proto = 'https:';
      try {
        proto = new URL(origin0).protocol || 'https:';
      } catch (e) {}
      const base = proto + '//' + host;
      push(base + '/invoice/' + enc);
      push(base + '/vat_invoices/' + enc);
    });
    (pageUrlPatterns || []).forEach((t) => {
      if (String(t).includes(id)) push(t);
      else {
        const swapped = String(t).replace(/\/[A-Za-z0-9_-]+(\?.*)?$/, '/' + enc + '$1');
        if (swapped !== t) push(swapped);
      }
    });
    push(origin0 + '/reservation/vat_invoice/' + enc);
    push(origin0 + '/reservation/tax_invoice/' + enc);
  }
  return urls.slice(0, 10);
}

function airbnbInvoiceNavMs() {
  return airbnbPortalIsLive() ? 8000 : 12000;
}

function airbnbInvoiceLandedDead(url, nav) {
  const landed = String(url || '');
  if (nav && typeof nav.status === 'function' && nav.status() >= 400) return true;
  if (nav && typeof nav.status === 'number' && nav.status >= 400) return true;
  return /\/404(\?|$|\/)/i.test(landed);
}

function airbnbInvoiceSoft404(bodyText) {
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  if (/AIUC-|invoice number|αριθμ[οό]ς τιμολ/i.test(t)) return false;
  return /we can.t find|not found|doesn.t exist|page not found|404|couldn.t find that page/i.test(t);
}

function airbnbBodySnippet(bodyText) {
  return String(bodyText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function looksLikeAirbnbInvoiceHtml(url, bodyText) {
  const u = String(url || '');
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  if (/log.?in|sign.?in/i.test(u) && !/invoice/i.test(u)) return false;
  if (airbnbInvoiceSoft404(t)) return false;
  if (/\/hosting\/stay(\/|$)/i.test(u) && !/vat_invoice|tax_invoice|\/invoice\//i.test(u)) return false;
  if (/\/hosting\/reservations(\/details)?/i.test(u) && !/vat_invoice|tax_invoice|\/invoice\//i.test(u)) return false;
  const markers =
    /AIUC-|vat invoice|tax invoice|τιμολ|invoice number|αριθμ[οό]ς τιμολ|credit note|πιστωτικ|airbnb ireland uc|airbnb payments/i.test(
      t
    );
  if (!markers) return false;
  if (/upcoming reservations|reservation details/i.test(t) && !/AIUC-|invoice number/i.test(t)) return false;
  return true;
}

function parseAirbnbVatAmount(raw) {
  const s = String(raw || '').replace(/\s+/g, '').replace(',', '.');
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function parseAirbnbVatFields(bodyText, kind, vatId) {
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  let invoiceNumber = '';
  const aiuc = t.match(/AIUC-[A-Z0-9]+(?:-[A-Z0-9]+)*/i);
  if (aiuc) invoiceNumber = aiuc[0].toUpperCase().replace(/[,.;]+$/, '');
  if (!invoiceNumber && vatId && /AIUC/i.test(String(vatId))) invoiceNumber = String(vatId).toUpperCase();
  if (!invoiceNumber) invoiceNumber = String(vatId || '').trim();
  let issueDate = '';
  const dmy = t.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (dmy) issueDate = parseInt(dmy[1], 10) + '/' + parseInt(dmy[2], 10) + '/' + dmy[3];
  else {
    const ymd = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (ymd) issueDate = parseInt(ymd[3], 10) + '/' + parseInt(ymd[2], 10) + '/' + ymd[1];
  }
  let total = null;
  const labeled = t.match(
    /(?:subtotal|invoice\s*total|grand\s*total|amount\s*due|total\s*amount|total fee including vat|σύνολο|(?:^|[\s:])total)\D{0,40}€\s*([0-9]+(?:[.,][0-9]{1,2})?)/i
  );
  if (labeled) total = parseAirbnbVatAmount(labeled[1]);
  if (total == null || total === 0) {
    const euros = [];
    const euroRe = /€\s*([0-9]+(?:[.,][0-9]{1,2})?)/g;
    let em;
    while ((em = euroRe.exec(t))) {
      const n = parseAirbnbVatAmount(em[1]);
      if (n != null && n !== 0) euros.push(n);
    }
    if (euros.length) total = euros[euros.length - 1];
  }
  const isCredit =
    String(kind || '') === 'credit_note' ||
    /credit\s*note|πιστωτικ|-CN-/i.test(t + ' ' + invoiceNumber);
  const sign = isCredit || (total != null && total < 0) ? '-' : '';
  const abs = total == null ? '' : Math.abs(total);
  return {
    invoiceNumber: invoiceNumber,
    issueDate: issueDate,
    total: abs,
    sign: sign,
  };
}

/** True only for a real stay/details page — not a hosting 200 that says the reservation is missing. */
function airbnbReservationPageIsOpen(url, bodyText, code) {
  const u = String(url || '');
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  const c = String(code || '').trim();
  if (!c) return false;
  if (/\/(login|signin|signup)(\/|$|\?)/i.test(u) && !/hosting/i.test(u)) return false;
  const missingCopy = /we can.?t find|doesn.?t exist|couldn.?t find|page not found|that page doesn.?t exist|no longer available|δεν μπορο[υύ]με να βρο[υύ]με|δεν υπ[αά]ρχει/i.test(
    t
  );
  const codeInText = t.toUpperCase().indexOf(c.toUpperCase()) >= 0;
  const staySignals = /check-?in|check-?out|confirmation code|guest/i.test(t);
  if (missingCopy && !staySignals) return false;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const onStayOrDetails = new RegExp(
    '/hosting/(?:stay|reservations(?:/details)?)/' + esc + '(?:/|$|\\?)',
    'i'
  ).test(u);
  if (!onStayOrDetails) return false;
  if (missingCopy && !codeInText) return false;
  if (codeInText && staySignals) return true;
  if (onStayOrDetails && staySignals && !missingCopy) return true;
  return false;
}

function vatIdFromAirbnbUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/(?:vat[_-]?invoice|tax[_-]?invoice|vat_invoices|credit[_-]?note)\/([A-Za-z0-9_-]+)/i);
  if (!m) m = s.match(/\/invoice\/([A-Za-z0-9_-]{6,})/i);
  if (!m) return '';
  const id = String(m[1] || '').trim();
  if (!id || /^(true|false|null)$/i.test(id)) return '';
  return id;
}

function usefulAirbnbInvoiceHits(hits, code) {
  const c = String(code || '').toUpperCase();
  return (hits || []).filter((h) => {
    const id = String((h && h.id) || '').trim();
    const href = String((h && h.href) || '');
    if (id && id.toUpperCase() !== c && !/^(true|false|null)$/i.test(id)) return true;
    if (/vat[_-]?invoice|tax[_-]?invoice|\/invoice\//i.test(href)) return true;
    return false;
  });
}

function attachAirbnbInvoiceNetworkTap(page, bag) {
  const onResp = async (res) => {
    try {
      const url = res.url();
      if (!/airbnb\.|graphql/i.test(url)) return;
      const headers = res.headers() || {};
      const len = parseInt(headers['content-length'] || '0', 10);
      if (len > 8000000) return;
      const ct = String(headers['content-type'] || '');
      if (ct && !/json|javascript|text|graphql/i.test(ct)) return;
      const body = await res.text();
      if (
        !/vatInvoice|taxInvoice|vat_invoice|tax_invoice|creditNote|vatInvoiceId|taxInvoiceId|invoiceUrl/i.test(body) &&
        !/\/reservation\/vat_invoice|\/invoice\/[A-Za-z0-9_-]{6,}/i.test(url + ' ' + body)
      ) {
        return;
      }
      let origin = 'https://www.airbnb.com';
      try {
        origin = new URL(url).origin;
      } catch (e) {}
      extractAirbnbVatInvoiceHits(body, origin).forEach((h) => bag.push(h));
    } catch (e) {}
  };
  page.on('response', onResp);
  return () => {
    try {
      page.off('response', onResp);
    } catch (e) {}
  };
}

async function waitForAirbnbInvoiceHtml(page) {
  const live = airbnbPortalIsLive();
  const deadline = Date.now() + (live ? 15000 : 1200);
  let sawSoft404At = 0;
  let last = { url: page.url(), body: '', ok: false };
  while (Date.now() < deadline) {
    const url = page.url();
    const body = await page
      .evaluate(() => {
        const main = document.querySelector('main#site-content');
        const t = (main && main.innerText) || (document.body && document.body.innerText) || '';
        return String(t).replace(/\s+/g, ' ');
      })
      .catch(() => '');
    last = { url: url, body: body, ok: looksLikeAirbnbInvoiceHtml(url, body) };
    if (last.ok) return last;
    if (airbnbInvoiceLandedDead(url, null)) return last;
    if (airbnbInvoiceSoft404(body)) {
      if (!sawSoft404At) sawSoft404At = Date.now();
      else if (Date.now() - sawSoft404At > (live ? 3000 : 150)) return last;
    }
    await page.waitForTimeout(live ? 400 : 80);
  }
  return last;
}

async function clickAirbnbStayInvoiceCandidate(page, context, cand) {
  const token = String((cand && cand.id) || vatIdFromAirbnbUrl(cand && cand.href) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!token) return { clicked: false, target: page, popup: null };
  const links = page.locator('a[href*="' + token + '"]');
  const n = await links.count().catch(() => 0);
  let link = null;
  for (let i = 0; i < n; i++) {
    const el = links.nth(i);
    if (await el.isVisible().catch(() => false)) {
      link = el;
      break;
    }
  }
  if (!link) return { clicked: false, target: page, popup: null };
  const popupP = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await link.click({ timeout: 3000, noWaitAfter: true }).catch(() => null);
  const popup = await popupP;
  const target = popup || page;
  await target.waitForLoadState('domcontentloaded', { timeout: airbnbInvoiceNavMs() }).catch(() => {});
  await waitForAirbnbInvoiceHtml(target);
  return { clicked: true, target: target, popup: popup };
}

async function fetchAirbnbInvoicePayload(page, url) {
  const resp = await page.request
    .get(url, { timeout: airbnbInvoiceNavMs(), maxRedirects: 5 })
    .catch(() => null);
  if (!resp) return { ok: false, status: 0, url: url, text: '', buf: null, pdf: false };
  const status = resp.status();
  const ct = String((resp.headers() || {})['content-type'] || '');
  const buf = Buffer.from(await resp.body().catch(() => Buffer.alloc(0)));
  const pdf = buf.slice(0, 5).toString() === '%PDF-' || /pdf/i.test(ct);
  const text = pdf ? '' : buf.toString('utf8').slice(0, 400000);
  const finalUrl = typeof resp.url === 'function' ? resp.url() : url;
  return {
    ok: status >= 200 && status < 400,
    status: status,
    ct: ct,
    url: finalUrl,
    text: text,
    buf: buf,
    pdf: pdf,
  };
}

function htmlTextFromAirbnbFetch(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function mirrorAirbnbCookiesToGr(context) {
  if (!airbnbPortalIsLive()) return;
  const cookies = await context.cookies().catch(() => []);
  const extra = [];
  const seen = new Set();
  (cookies || []).forEach((c) => {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    if (!/airbnb\.com$/i.test(d)) return;
    const key = String(c.name || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    extra.push({
      name: c.name,
      value: c.value,
      domain: '.airbnb.gr',
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'Lax',
      expires: c.expires,
    });
  });
  if (extra.length) await context.addCookies(extra).catch(() => {});
}

async function captureAirbnbDocPdf(page, dir, filename) {
  // Prefer a real download; otherwise print the open invoice HTML to PDF (VAT Invoicer-style).
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 4000 }).catch(() => null),
    page
      .locator(
        'button:has-text("Download"), a:has-text("Download"), button:has-text("Print"), a:has-text("Print"), button:has-text("Save")'
      )
      .first()
      .click({ timeout: 1500 })
      .catch(() => null),
  ]);
  if (download) {
    const suggested = (download.suggestedFilename() || filename).replace(/[^\w.\-]+/g, '_');
    return saveDownload(download, dir, suggested.endsWith('.pdf') ? suggested : filename);
  }
  const pdf = await page.pdf({ format: 'A4', printBackground: true }).catch(() => null);
  if (isTinyPdf(pdf)) return null;
  return savePdfBuffer(dir, filename, pdf);
}

async function findAirbnbDocHrefs(page, wantKinds) {
  const wantInvoice = wantKinds.includes('invoice') || wantKinds.includes('both');
  const wantCredit = wantKinds.includes('credit_note') || wantKinds.includes('both');
  return page.$$eval(
    'a[href], button',
    (els, flags) => {
      const out = [];
      const seen = new Set();
      els.forEach((el) => {
        const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
        let href = el.getAttribute('href') || '';
        if (!href && el.tagName === 'BUTTON') {
          const parent = el.closest('a');
          if (parent) href = parent.getAttribute('href') || '';
        }
        if (!href) return;
        const blob = (text + ' ' + href).toLowerCase();
        let kind = '';
        if (flags.wantCredit && /credit\s*note|πιστωτικ|credit-note|credit_note/.test(blob)) kind = 'credit_note';
        else if (flags.wantInvoice && /vat\s*invoice|tax\s*invoice|τιμολ|vat_invoice|vat-invoice|\/invoice/.test(blob))
          kind = 'invoice';
        else if (flags.wantInvoice && /\binvoice\b/.test(blob) && !/receipt|statement/.test(blob)) kind = 'invoice';
        if (!kind) return;
        let abs = href;
        try {
          abs = new URL(href, location.origin).href;
        } catch (e) {
          return;
        }
        const key = kind + '|' + abs;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ kind, href: abs, id: '', how: 'labeled-href', text: text.slice(0, 80) });
      });
      return out;
    },
    { wantInvoice, wantCredit }
  );
}

async function scanAirbnbReservationForInvoiceIds(page) {
  const html = await page.content().catch(() => '');
  let origin = 'https://www.airbnb.com';
  try {
    origin = new URL(page.url()).origin;
  } catch (e) {}
  const hits = extractAirbnbVatInvoiceHits(html, origin);
  const templates = airbnbInvoicePagePatterns(html);
  const extra = await page
    .evaluate(() => {
      const KEY_RE = /vat[_-]?invoice|tax[_-]?invoice|invoiceid|invoice_id|credit[_-]?note|creditnote/i;
      const URL_RE = /vat[_-]?invoice|tax[_-]?invoice|credit[_-]?note|\/invoice\//i;
      const out = [];
      const seen = new Set();
      function kindFrom(s) {
        const t = String(s || '').toLowerCase();
        if (/credit/.test(t)) return 'credit_note';
        return 'invoice';
      }
      function abs(href) {
        try {
          return new URL(href, location.origin).href;
        } catch (e) {
          return '';
        }
      }
      function add(item) {
        const href = item.href || '';
        const id = item.id || '';
        const kind = item.kind || 'invoice';
        const key = kind + '|' + href + '|' + id;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ kind, href, id, how: item.how || 'dom' });
      }
      document.querySelectorAll('a[href], iframe[src], link[href]').forEach((el) => {
        const href = el.getAttribute('href') || el.getAttribute('src') || '';
        if (URL_RE.test(href)) add({ kind: kindFrom(href), href: abs(href), how: 'dom-href' });
      });
      document.querySelectorAll('[data-invoice-id], [data-vat-invoice-id], [data-tax-invoice-id]').forEach((el) => {
        const id =
          el.getAttribute('data-invoice-id') ||
          el.getAttribute('data-vat-invoice-id') ||
          el.getAttribute('data-tax-invoice-id') ||
          '';
        if (id) add({ kind: 'invoice', id: id, how: 'data-attr' });
      });
      function walk(obj, depth, seen) {
        if (!obj || typeof obj !== 'object' || depth > 10) return;
        if (seen.has(obj)) return;
        seen.add(obj);
        if (Array.isArray(obj)) {
          obj.forEach((x) => walk(x, depth + 1, seen));
          return;
        }
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) {
            add({ kind: kindFrom(k), id: String(v), how: 'json-walk:' + k });
          }
          if (typeof v === 'string' && URL_RE.test(v)) {
            add({ kind: kindFrom(v), href: abs(v), how: 'json-walk-url' });
          }
          if (v && typeof v === 'object') walk(v, depth + 1, seen);
        });
        const typeish = String(obj.__typename || obj.type || obj.kind || obj.documentType || '');
        const id = obj.id || obj.invoiceId || obj.vatInvoiceId || obj.token || obj.uuid;
        const keys = Object.keys(obj).join(' ');
        if (id && KEY_RE.test(typeish + ' ' + keys)) {
          add({ kind: kindFrom(typeish + ' ' + keys), id: String(id), how: 'json-obj-id' });
        }
      }
      const seenJson = new Set();
      if (window.__NEXT_DATA__) walk(window.__NEXT_DATA__, 0, seenJson);
      document.querySelectorAll('script[type="application/json"], script').forEach((s) => {
        const t = s.textContent || '';
        if (!t || t.length > 1500000) return;
        const trimmed = t.trim();
        if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
        try {
          walk(JSON.parse(trimmed), 0, seenJson);
        } catch (e) {}
      });
      return { docs: out, origin: location.origin };
    })
    .catch(() => ({ docs: [], origin }));
  (extra.docs || []).forEach((h) => hits.push(h));
  return { hits, templates, origin: extra.origin || origin, html };
}

async function settleAirbnbHostPage(page) {
  const live = airbnbPortalIsLive();
  await page.waitForLoadState('networkidle', { timeout: live ? 12000 : 3000 }).catch(() => {});
  await page.waitForTimeout(live ? 4500 : 400);
}

async function clickVisibleAirbnbVatInvoice(page) {
  const locators = [
    page.getByRole('link', { name: /vat invoice|tax invoice|τιμολόγιο|credit note|debit note|πιστωτικ/i }),
    page.getByRole('button', { name: /vat invoice|tax invoice|τιμολόγιο|credit note|debit note|πιστωτικ/i }),
    page.getByText(/^\s*VAT invoice\s*$/i),
    page.getByText(/^\s*Tax invoice\s*$/i),
    page.getByText(/^\s*Credit note\s*$/i),
    page.getByText(/Τιμολόγιο/),
  ];
  let clicked = false;
  for (const loc of locators) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 12); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2500 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(600);
      }
    }
  }
  return clicked;
}

async function listAirbnbVatDocHrefs(page) {
  return page
    .evaluate(() => {
      const out = [];
      const seen = new Set();
      const re = /vat\s*invoice|tax\s*invoice|credit\s*note|debit\s*note|τιμολ|πιστωτικ|vat_invoice|tax_invoice|vat_invoices|\/invoice\//i;
      document.querySelectorAll('a[href]').forEach((el) => {
        const hrefRaw = el.getAttribute('href') || '';
        const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + hrefRaw).replace(
          /\s+/g,
          ' '
        );
        if (!re.test(text)) return;
        let href = hrefRaw;
        try {
          href = new URL(href, location.origin).href;
        } catch (e) {
          return;
        }
        if (seen.has(href)) return;
        seen.add(href);
        out.push({ href, kind: /credit|πιστωτικ/i.test(text) ? 'credit_note' : 'invoice' });
      });
      return out;
    })
    .catch(() => []);
}

async function clickAirbnbStayTotalPrice(page) {
  const marked = await page
    .evaluate(() => {
      function visible(el) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      }
      function clickable(el) {
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          if (n.matches && n.matches('button, a, [role="button"], [tabindex]')) return n;
          n = n.parentElement;
        }
        return el;
      }
      document.querySelectorAll('[data-pi-price]').forEach((el) => el.removeAttribute('data-pi-price'));
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], span, div, p, strong'));
      const scored = [];
      nodes.forEach((el) => {
        if (!visible(el)) return;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 80) return;
        const hasMoney = /€|EUR|\$|£|USD/.test(t) && /\d/.test(t);
        const hasTotal = /total|σύνολο|payout|price details|show breakdown|receipt|ανάλυση/i.test(t);
        if (!hasMoney && !hasTotal) return;
        let score = 0;
        if (hasTotal) score += 5;
        if (hasMoney) score += 2;
        if (/€/.test(t)) score += 1;
        if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') score += 3;
        scored.push({ el: clickable(el), score, t });
      });
      scored.sort((a, b) => b.score - a.score);
      const seen = new Set();
      const out = [];
      for (const s of scored) {
        if (seen.has(s.el)) continue;
        seen.add(s.el);
        s.el.setAttribute('data-pi-price', String(out.length));
        out.push({ i: out.length, t: s.t, score: s.score });
        if (out.length >= 5) break;
      }
      return out;
    })
    .catch(() => []);
  if (!marked || !marked.length) return false;
  for (const c of marked) {
    await page.locator('[data-pi-price="' + c.i + '"]').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(1800);
    // List hrefs only — clicking a VAT/credit control here navigates away and hides sibling docs.
    const hrefs = await listAirbnbVatDocHrefs(page);
    if (hrefs && hrefs.length) return true;
  }
  return marked.length > 0;
}

async function clickAirbnbHelpVatInvoice(page) {
  if ((await listAirbnbVatDocHrefs(page)).length) return true;
  const priceClicked = await clickAirbnbStayTotalPrice(page);
  if ((await listAirbnbVatDocHrefs(page)).length) return true;
  if (await clickVisibleAirbnbVatInvoice(page)) return true;
  return priceClicked;
}

async function collectAirbnbInvoiceHits(page, netHits, kind) {
  const scanned = await scanAirbnbReservationForInvoiceIds(page);
  const hrefDocs = await findAirbnbDocHrefs(page, [kind || 'both']).catch(() => []);
  const hits = []
    .concat(scanned.hits || [])
    .concat(netHits || [])
    .concat(hrefDocs || []);
  hits.sort((a, b) => {
    const score = (h) => {
      const blob = ((h.how || '') + ' ' + (h.href || '')).toLowerCase();
      if (/vat|tax/.test(blob)) return 0;
      if (h.href) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  return {
    scanned,
    hits,
    origin: scanned.origin || 'https://www.airbnb.com',
    templates: scanned.templates || [],
  };
}

async function tryCaptureInvoicePage(page, context, dir, fname) {
  const waited = await waitForAirbnbInvoiceHtml(page);
  if (!waited.ok) return { saved: null, url: waited.url, lookedLikeInvoice: false };
  const saved = await captureAirbnbDocPdf(page, dir, fname);
  return { saved, url: waited.url, lookedLikeInvoice: true };
}

async function pullAirbnbDocsForCode(page, context, month, dir, files, errors, resv, apts) {
  const code = resv.code;
  const netHits = [];
  const stopTap = attachAirbnbInvoiceNetworkTap(page, netHits);
  const portalOrigin = airbnbPortalOrigin();
  const urls = [
    portalOrigin + '/hosting/stay/' + encodeURIComponent(code),
    portalOrigin + '/hosting/reservations/details/' + encodeURIComponent(code),
    portalOrigin + '/hosting/reservations/' + encodeURIComponent(code),
    portalOrigin + '/hosting/reservations?confirmation_code=' + encodeURIComponent(code),
    portalOrigin + '/hosting/reservations?confirmationCode=' + encodeURIComponent(code),
  ];
  let opened = false;
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await settleAirbnbHostPage(page);
    if (/log.?in|sign.?in/i.test(page.url())) {
      stopTap();
      errors.push({ channel: 'airbnb', code, error: 'Session lost opening reservation ' + code });
      return 0;
    }
    const landed = page.url();
    const text = await page.locator('body').innerText().catch(() => '');
    if (airbnbReservationPageIsOpen(landed, text, code)) {
      opened = true;
      break;
    }
    const stayHref = await page
      .evaluate((c) => {
        const needle = String(c || '').toUpperCase();
        const a = Array.from(document.querySelectorAll('a[href]')).find((el) => {
          const href = String(el.getAttribute('href') || '').toUpperCase();
          return href.indexOf('/HOSTING/STAY/' + needle) >= 0 || href.indexOf('/HOSTING/RESERVATIONS/DETAILS/' + needle) >= 0;
        });
        if (!a) return '';
        try {
          return new URL(a.getAttribute('href'), location.origin).href;
        } catch (e) {
          return '';
        }
      }, code)
      .catch(() => '');
    if (stayHref) {
      await page.goto(new URL(stayHref, landed).href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await settleAirbnbHostPage(page);
      const after = await page.locator('body').innerText().catch(() => '');
      if (airbnbReservationPageIsOpen(page.url(), after, code)) {
        opened = true;
        break;
      }
    }
  }
  if (!opened) {
    stopTap();
    errors.push({
      channel: 'airbnb',
      code,
      error:
        'Could not open Airbnb reservation ' +
        code +
        ' (stay URL was a miss or a hosting list; details/search also failed)',
    });
    await page.screenshot({ path: path.join(dir, '_miss-' + code + '.png'), fullPage: true }).catch(() => {});
    return 0;
  }

  const listingGuessRaw =
    (await page.locator('h1, h2, [data-testid*="listing"]').first().innerText().catch(() => '')) || '';
  const listingGuess = booking.isPortalChromeLabel(listingGuessRaw) ? '' : listingGuessRaw;
  const apt = matchApartment(listingGuess || resv.aptName, apts);
  const aptId = resv.aptId || apt.aptId || '';
  let aptName = '';
  if (resv.aptName && !booking.isPortalChromeLabel(resv.aptName)) aptName = resv.aptName;
  else if (apt.aptName && !booking.isPortalChromeLabel(apt.aptName)) aptName = apt.aptName;
  else if (listingGuess) aptName = listingGuess;
  else if (aptId) {
    const hit = (apts || []).find((a) => a && String(a.aptId || a.id || '') === String(aptId));
    aptName = String((hit && (hit.aptName || hit.name)) || '').trim();
  }

  // Always collect every VAT debit + credit on the stay (cancel / extend sets).
  const kindsWanted = new Set(['invoice', 'credit_note']);
  const alreadyHave = loadAirbnbHaveSet();
  const savedKeys = new Set();

  let savedCount = 0;
  let alreadyListedCount = 0;
  let lastLanded = page.url();
  let lastLookedLikeInvoice = false;
  let lastBody = '';
  let lastFetchNote = '';
  const reservationUrl = page.url();

  function noteAlreadyListed(kind, idHint, href) {
    alreadyListedCount += 1;
    emitJson({
      event: 'already_have',
      channel: 'airbnb',
      code,
      kind: kind || 'invoice',
      vatId: String(idHint || vatIdFromAirbnbUrl(href) || ''),
      href: String(href || '').slice(0, 180),
    });
  }

  async function saveIfInvoice(targetPage, kind, how, idHint) {
    const waited = await waitForAirbnbInvoiceHtml(targetPage);
    const body = waited.body || (await targetPage.locator('body').innerText().catch(() => ''));
    const urlNow = waited.url || targetPage.url();
    lastLanded = urlNow;
    lastBody = body;
    lastLookedLikeInvoice = waited.ok || looksLikeAirbnbInvoiceHtml(urlNow, body);
    if (!lastLookedLikeInvoice) return false;
    const fields = parseAirbnbVatFields(body, kind, vatIdFromAirbnbUrl(urlNow) || idHint);
    let vatId = String(idHint || vatIdFromAirbnbUrl(urlNow) || fields.invoiceNumber || '').replace(/[^\w.-]+/g, '').slice(0, 40);
    if (vatId && vatId.toUpperCase() === String(code).toUpperCase()) vatId = '';
    if (airbnbDocAlreadyHave(alreadyHave, kind, code, vatId)) {
      noteAlreadyListed(kind, vatId, urlNow);
      return 'have';
    }
    const storeKey = airbnbHaveKey(kind, code, vatId);
    if (savedKeys.has(storeKey)) {
      noteAlreadyListed(kind, vatId, urlNow);
      return 'have';
    }
    const archiveMonth = issueDateToMonth(fields.issueDate) || month;
    const rel = piInvoiceStoreRel({
      channel: 'airbnb',
      month: archiveMonth,
      aptName: aptName,
      kind: kind,
      code: vatId ? code + '-' + vatId : code,
    });
    const storeRoot = path.resolve(dir, '..');
    const absPath = path.join(storeRoot, rel);
    ensureDir(path.dirname(absPath));
    const cap = await tryCaptureInvoicePage(targetPage, context, path.dirname(absPath), path.basename(rel));
    lastLanded = cap.url;
    lastLookedLikeInvoice = cap.lookedLikeInvoice;
    if (!cap.saved) return false;
    savedKeys.add(storeKey);
    alreadyHave.add(storeKey);
    savedCount++;
    files.push({
      channel: 'airbnb',
      kind,
      scope: 'leased',
      partner: aptName || aptId || code,
      aptName: aptName,
      reservationId: code,
      vatId: vatId || '',
      invoiceNumber: fields.invoiceNumber || '',
      issueDate: fields.issueDate || '',
      total: fields.total,
      sign: fields.sign || '',
      listingName: aptName,
      checkIn: resv.checkIn || '',
      checkOut: resv.checkOut || '',
      month: archiveMonth,
      filename: rel.replace(/\\/g, '/'),
      path: cap.saved.path,
      bytes: cap.saved.bytes,
      source: 'portal',
      how,
    });
    emitJson({
      event: 'saved',
      channel: 'airbnb',
      kind,
      partner: aptName || aptId || code,
      aptName: aptName,
      reservationId: code,
      vatId: vatId || '',
      invoiceNumber: fields.invoiceNumber || '',
      issueDate: fields.issueDate || '',
      total: fields.total,
      sign: fields.sign || '',
      listingName: aptName,
      checkIn: resv.checkIn || '',
      checkOut: resv.checkOut || '',
      month: archiveMonth,
      filename: rel.replace(/\\/g, '/'),
      path: cap.saved.path,
      bytes: cap.saved.bytes,
      code,
    });
    return true;
  }

  async function savePdfBytes(kind, how, idHint, srcUrl, buf) {
    lastLanded = srcUrl;
    lastLookedLikeInvoice = true;
    lastBody = 'application/pdf ' + ((buf && buf.length) || 0);
    let vatId = String(idHint || vatIdFromAirbnbUrl(srcUrl) || '').replace(/[^\w.-]+/g, '').slice(0, 40);
    if (vatId && vatId.toUpperCase() === String(code).toUpperCase()) vatId = '';
    if (airbnbDocAlreadyHave(alreadyHave, kind, code, vatId)) {
      noteAlreadyListed(kind, vatId, srcUrl);
      return 'have';
    }
    const storeKey = airbnbHaveKey(kind, code, vatId);
    if (savedKeys.has(storeKey)) {
      noteAlreadyListed(kind, vatId, srcUrl);
      return 'have';
    }
    if (isTinyPdf(buf)) return false;
    const archiveMonth = month;
    const rel = piInvoiceStoreRel({
      channel: 'airbnb',
      month: archiveMonth,
      aptName: aptName,
      kind: kind,
      code: vatId ? code + '-' + vatId : code,
    });
    const storeRoot = path.resolve(dir, '..');
    const absPath = path.join(storeRoot, rel);
    ensureDir(path.dirname(absPath));
    const saved = savePdfBuffer(path.dirname(absPath), path.basename(rel), buf);
    if (!saved) return false;
    savedKeys.add(storeKey);
    alreadyHave.add(storeKey);
    savedCount++;
    files.push({
      channel: 'airbnb',
      kind,
      scope: 'leased',
      partner: aptName || aptId || code,
      aptName: aptName,
      reservationId: code,
      vatId: vatId || '',
      invoiceNumber: '',
      issueDate: '',
      total: '',
      sign: '',
      listingName: aptName,
      checkIn: resv.checkIn || '',
      checkOut: resv.checkOut || '',
      month: archiveMonth,
      filename: rel.replace(/\\/g, '/'),
      path: saved.path,
      bytes: saved.bytes,
      source: 'portal',
      how,
    });
    emitJson({
      event: 'saved',
      channel: 'airbnb',
      kind,
      partner: aptName || aptId || code,
      aptName: aptName,
      reservationId: code,
      vatId: vatId || '',
      code,
      filename: rel.replace(/\\/g, '/'),
      bytes: saved.bytes,
      how,
    });
    return true;
  }

  async function saveFetchedHtml(kind, how, idHint, html, srcUrl) {
    const text = htmlTextFromAirbnbFetch(html);
    lastLanded = srcUrl;
    lastBody = text;
    lastLookedLikeInvoice = looksLikeAirbnbInvoiceHtml(srcUrl, text) || /AIUC-/i.test(html);
    if (!lastLookedLikeInvoice) return false;
    const tab = await context.newPage();
    try {
      await tab.setContent(html, { waitUntil: 'domcontentloaded' });
      return await saveIfInvoice(tab, kind, how, idHint);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  async function openInvoiceNewTab(href, kind, how, idHint) {
    const tab = await context.newPage();
    try {
      const nav = await tab.goto(href, { waitUntil: 'domcontentloaded', timeout: airbnbInvoiceNavMs() }).catch(() => null);
      if (airbnbInvoiceLandedDead(tab.url(), nav)) {
        lastLanded = tab.url();
        lastBody = await tab.locator('body').innerText().catch(() => '');
        lastLookedLikeInvoice = false;
        return false;
      }
      const ok = await saveIfInvoice(tab, kind, how, idHint);
      return ok;
    } finally {
      await tab.close().catch(() => {});
    }
  }

  async function goStay() {
    const here = String(page.url() || '');
    if (/\/hosting\/stay\//i.test(here) && !/\/404(\?|$|\/)/i.test(here)) return;
    await page.goto(reservationUrl, { waitUntil: 'domcontentloaded', timeout: airbnbInvoiceNavMs() }).catch(() => {});
    await page.waitForTimeout(airbnbPortalIsLive() ? 600 : 200);
  }

  async function afterInvoiceAttempt(popup) {
    if (popup) await popup.close().catch(() => {});
    await goStay();
    await clickAirbnbStayTotalPrice(page);
    mergeListedHrefs(await listAirbnbVatDocHrefs(page));
  }

  async function revealAndCollect(how) {
    await clickAirbnbHelpVatInvoice(page);
    await settleAirbnbHostPage(page);
    if (/vat_invoice|tax_invoice/i.test(page.url())) {
      const k = kindFromInvoiceBlob(page.url() + ' ' + (await page.locator('body').innerText().catch(() => '')));
      await saveIfInvoice(page, k, how, vatIdFromAirbnbUrl(page.url()));
      await goStay();
      await clickAirbnbStayTotalPrice(page);
      await settleAirbnbHostPage(page);
    } else if (/\/invoice\//i.test(page.url()) && !/\/404(\?|$|\/)/i.test(page.url())) {
      const k = kindFromInvoiceBlob(page.url() + ' ' + (await page.locator('body').innerText().catch(() => '')));
      const vid = vatIdFromAirbnbUrl(page.url());
      await saveIfInvoice(page, k, how, vid);
      await goStay();
      await clickAirbnbStayTotalPrice(page);
      await settleAirbnbHostPage(page);
    }
    const hrefDocs = await listAirbnbVatDocHrefs(page);
    hrefDocs.forEach(function (d) {
      netHits.push({ kind: d.kind || 'invoice', href: d.href, id: vatIdFromAirbnbUrl(d.href), how: 'listed-href' });
    });
  }

  let bag = await collectAirbnbInvoiceHits(page, netHits, 'both');
  if (!usefulAirbnbInvoiceHits(bag.hits, code).length) {
    await revealAndCollect('help-click');
    await settleAirbnbHostPage(page);
    bag = await collectAirbnbInvoiceHits(page, netHits, 'both');
  } else {
    await clickAirbnbStayTotalPrice(page);
    await settleAirbnbHostPage(page);
    const hrefDocs = await listAirbnbVatDocHrefs(page);
    hrefDocs.forEach(function (d) {
      netHits.push({ kind: d.kind || 'invoice', href: d.href, id: vatIdFromAirbnbUrl(d.href), how: 'listed-href' });
    });
    bag = await collectAirbnbInvoiceHits(page, netHits, 'both');
  }

  const origin = bag.origin || portalOrigin;
  const templates = bag.templates || [];
  const hits = bag.hits || [];
  const candidates = [];
  const seenCand = new Set();
  function addCandidate(kind, href, id, how) {
    const k = kind === 'credit_note' ? 'credit_note' : 'invoice';
    const hrefN = String(href || '');
    const vid = String(id || vatIdFromAirbnbUrl(hrefN) || '').toUpperCase();
    const key = vid || hrefN;
    if (!key) return;
    if (seenCand.has(key)) {
      if (k === 'credit_note') {
        candidates.forEach(function (c) {
          const cid = String(c.id || vatIdFromAirbnbUrl(c.href) || '').toUpperCase();
          if (cid === vid || c.href === hrefN) {
            c.kind = 'credit_note';
            if (hrefN) c.href = hrefN;
          }
        });
      }
      return;
    }
    seenCand.add(key);
    candidates.push({ kind: k, href: hrefN, id: id || vid, how: how || 'scan' });
  }
  function mergeListedHrefs(docs) {
    (docs || []).forEach(function (d) {
      addCandidate(d.kind, d.href, vatIdFromAirbnbUrl(d.href), 'listed-href');
    });
  }
  mergeListedHrefs(await listAirbnbVatDocHrefs(page));
  for (const hit of hits) {
    if (hit.id && String(hit.id).toUpperCase() === code) continue;
    const kind = hit.kind === 'credit_note' ? 'credit_note' : 'invoice';
    addCandidate(kind, hit.href, hit.id || vatIdFromAirbnbUrl(hit.href), hit.how || 'scan');
  }
  mergeListedHrefs(await listAirbnbVatDocHrefs(page));

  for (let i = 0; i < candidates.length && i < 24; i++) {
    const cand = candidates[i];
    if (airbnbDocAlreadyHave(alreadyHave, cand.kind, code, cand.id)) {
      noteAlreadyListed(cand.kind, cand.id, cand.href);
      continue;
    }
    let savedThis = false;
    await goStay();
    await clickAirbnbStayTotalPrice(page);
    try {
      const clicked = await clickAirbnbStayInvoiceCandidate(page, context, cand);
      if (clicked.clicked) {
        const landed = clicked.target.url();
        const bodyNow = await clicked.target.locator('body').innerText().catch(() => '');
        lastLanded = landed;
        lastBody = bodyNow;
        if (!airbnbInvoiceLandedDead(landed, null) && !airbnbInvoiceSoft404(bodyNow)) {
          const ok = await saveIfInvoice(clicked.target, cand.kind, 'stay-click', cand.id);
          if (ok) savedThis = true;
        }
        await afterInvoiceAttempt(clicked.popup);
      }
    } catch (e) {
      errors.push({ channel: 'airbnb', code, kind: cand.kind, error: e.message });
    }
    if (savedThis) continue;
    await goStay();
    await clickAirbnbStayTotalPrice(page);
    const openUrls = airbnbInvoiceUrlsForHit(cand, origin, templates);
    const fetchNotes = [];
    for (const href of openUrls) {
      if (savedThis) break;
      try {
        const got = await fetchAirbnbInvoicePayload(page, href);
        fetchNotes.push(
          String(got.status || 0) +
            (got.pdf ? 'pdf' : '') +
            ' ' +
            String(got.url || href).replace(/^https?:\/\/[^/]+/, '')
        );
        if (got.pdf && got.buf && got.buf.length > 80) {
          const ok = await savePdfBytes(cand.kind, 'fetch-pdf', cand.id, got.url || href, got.buf);
          if (ok) {
            savedThis = true;
            break;
          }
        }
        const htmlText = htmlTextFromAirbnbFetch(got.text || '');
        if (got.ok && (looksLikeAirbnbInvoiceHtml(got.url || href, htmlText) || /AIUC-/i.test(got.text || ''))) {
          const ok = await saveFetchedHtml(cand.kind, 'fetch-html', cand.id, got.text, got.url || href);
          if (ok) {
            savedThis = true;
            break;
          }
        }
        if (!got.ok || got.status >= 400 || airbnbInvoiceLandedDead(got.url, got) || airbnbInvoiceSoft404(htmlText)) {
          lastLanded = got.url || href;
          if (htmlText) lastBody = htmlText;
          continue;
        }
        const okTab = await openInvoiceNewTab(href, cand.kind, 'new-tab', cand.id);
        if (okTab) {
          savedThis = true;
          break;
        }
      } catch (e) {
        errors.push({ channel: 'airbnb', code, kind: cand.kind, error: e.message });
      }
    }
    lastFetchNote = fetchNotes.slice(0, 8).join(',');
    if (!savedThis) await goStay();
  }

  if (!savedCount) {
    await goStay();
    await revealAndCollect('help-click-retry');
    bag = await collectAirbnbInvoiceHits(page, netHits, 'both');
    for (const hit of usefulAirbnbInvoiceHits(bag.hits, code)) {
      const kind = hit.kind === 'credit_note' ? 'credit_note' : 'invoice';
      const cand = { kind: kind, href: hit.href, id: hit.id || vatIdFromAirbnbUrl(hit.href) };
      if (airbnbDocAlreadyHave(alreadyHave, kind, code, cand.id)) {
        noteAlreadyListed(kind, cand.id, cand.href);
        continue;
      }
      await goStay();
      await clickAirbnbStayTotalPrice(page);
      let clicked = { clicked: false, popup: null };
      try {
        clicked = await clickAirbnbStayInvoiceCandidate(page, context, cand);
        if (clicked.clicked && !airbnbInvoiceLandedDead(clicked.target.url(), null)) {
          const bodyNow = await clicked.target.locator('body').innerText().catch(() => '');
          if (!airbnbInvoiceSoft404(bodyNow)) {
            await saveIfInvoice(clicked.target, kind, 'rescan-click', cand.id);
          }
        }
      } catch (eRescan) {
        errors.push({ channel: 'airbnb', code, kind: kind, error: eRescan.message });
      }
      await afterInvoiceAttempt(clicked.popup);
    }
  }

  if (!savedCount) {
    const lastUrls = [
      origin + '/reservation/vat_invoice/' + encodeURIComponent(code),
      origin + '/reservation/tax_invoice/' + encodeURIComponent(code),
    ];
    for (const href of lastUrls) {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: airbnbInvoiceNavMs() }).catch(() => {});
      if (airbnbInvoiceLandedDead(page.url(), null)) continue;
      await page.waitForTimeout(airbnbPortalIsLive() ? 700 : 200);
      await saveIfInvoice(page, 'invoice', 'code-as-invoice-id', '');
    }
  }

  stopTap();

  if (!savedCount) {
    const idSample = (bag.hits || [])
      .map((h) => (h.id ? h.id : '') + (h.href ? ' ' + h.href.replace(/^https?:\/\/[^/]+/, '') : ''))
      .filter(Boolean)
      .slice(0, 4)
      .join(' | ');
    // Airbnb only listed invoice URL(s) already in the vault — nothing new to pull.
    if (alreadyListedCount > 0) {
      emitJson({
        event: 'already_have',
        channel: 'airbnb',
        code,
        listed: alreadyListedCount,
        ids: idSample || 'none',
        wanted: [...kindsWanted].join(','),
      });
      return -1;
    }
    errors.push({
      channel: 'airbnb',
      code,
      error:
        'No VAT invoice HTML for ' +
        code +
        ' (wanted: ' +
        [...kindsWanted].join(',') +
        '; ids/urls found: ' +
        (idSample || 'none') +
        '; landed: ' +
        String(lastLanded || '').slice(0, 120) +
        '; invoiceHtml: ' +
        lastLookedLikeInvoice +
        '; body: ' +
        airbnbBodySnippet(lastBody) +
        (lastFetchNote ? '; fetch: ' + lastFetchNote : '') +
        ')',
    });
    await page.screenshot({ path: path.join(dir, '_nodoc-' + code + '.png'), fullPage: true }).catch(() => {});
  }
  return savedCount;
}

/**
 * Airbnb VAT Invoicer-style pull (https://vatinvoicer.com/privacy/):
 * Hosthub confirmation codes → /hosting/stay/{CODE} → total price → every VAT invoice/credit note HTML → PDF.
 */
async function pullAirbnb(page, context, month, outDir, files, errors) {
  const dir = path.join(outDir, 'airbnb');
  ensureDir(dir);
  const apts = loadApartments();
  const reservations = loadAirbnbReservations();

  try {
    if (!reservations.length) {
      errors.push({
        channel: 'airbnb',
        error:
          'No Hosthub Airbnb reservation codes provided. Sync Hosthub, then Pull again (Expect lists confirmation codes).',
      });
      return;
    }

    const ok = await ensureAirbnbLoggedIn(page, context, dir, errors);
    if (!ok) return;

    // De-dupe codes. Kind is always both: Airbnb may issue several debit + credit PDFs per stay.
    const byCode = new Map();
    for (const r of reservations) {
      const prev = byCode.get(r.code);
      if (!prev) {
        byCode.set(r.code, Object.assign({}, r, { kind: 'both' }));
        continue;
      }
      prev.kind = 'both';
      if (!prev.aptId && r.aptId) prev.aptId = r.aptId;
      if (!prev.aptName && r.aptName) prev.aptName = r.aptName;
      if (!prev.checkIn && r.checkIn) prev.checkIn = r.checkIn;
      if (!prev.checkOut && r.checkOut) prev.checkOut = r.checkOut;
    }

    const limit = loadAirbnbLimit();
    let queue = [...byCode.values()];
    if (limit > 0) {
      queue = sortAirbnbReservationsLatest(queue).slice(0, limit);
    } else {
      queue.sort(function (a, b) {
        const miss = (Number(b.missing) || 0) - (Number(a.missing) || 0);
        if (miss) return miss;
        return airbnbCreatedMs(b) - airbnbCreatedMs(a);
      });
    }

    let pulled = 0;
    let alreadyHaveOk = 0;
    let idx = 0;
    const total = queue.length;
    const alreadyHave = loadAirbnbHaveSet();
    for (const resv of queue) {
      if (pullStopRequested()) break;
      idx += 1;
      if (airbnbResvAlreadyHave(resv, alreadyHave)) {
        emitJson({
          event: 'progress',
          done: idx,
          total: total,
          saved: files.length,
          code: resv.code,
          skipped: true,
        });
        alreadyHaveOk += 1;
        continue;
      }
      emitJson({ event: 'progress', done: idx, total: total, saved: files.length, code: resv.code });
      const n = await pullAirbnbDocsForCode(page, context, month, dir, files, errors, resv, apts);
      if (n < 0) alreadyHaveOk += 1;
      else pulled += n;
    }
    if (pullStopRequested()) {
      errors.push({ channel: 'airbnb', error: 'Pull stopped' });
    }
    if (!pulled && !alreadyHaveOk) {
      errors.push({
        channel: 'airbnb',
        error: 'Hosthub listed ' + queue.length + ' Airbnb code(s) but 0 PDFs were captured.',
      });
    }
    await persistSession('AIRBNB', context);
  } catch (e) {
    errors.push({ channel: 'airbnb', error: e.message });
    await page.screenshot({ path: path.join(dir, '_error.png'), fullPage: true }).catch(() => {});
  }
}

function onAdminExtranet(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'admin.booking.com' && /hoteladmin|extranet|groups/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

async function bookingAcceptCookies(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    '#onetrust-accept-btn-handler',
  ]) {
    const b = page.locator(sel).first();
    if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
  }
}

async function bookingDetectBlock(page, dir, errors, stage) {
  const watch = bookingBlock.attachPageWatch(page);
  const text = await page.locator('body').innerText().catch(function () { return ''; });
  if (!bookingBlock.looksBlockedPage({ text: text, status: watch.lastStatus }) && !watch.blockedHttp) return false;
  const row = await bookingBlock.markBlocked(bookingBlockPool(), {
    source: 'pull',
    status: watch.lastStatus,
    reason: String(text || '').replace(/\s+/g, ' ').slice(0, 320),
  });
  errors.push({
    channel: 'booking',
    error: bookingBlock.blockedError(row),
    cooldownUntil: row && row.until,
    url: page.url(),
    stage: stage,
  });
  await page.screenshot({ path: path.join(dir, '_blocked.png'), fullPage: true }).catch(function () {});
  return true;
}

async function ensureBookingLoggedIn(page, context, dir, errors) {
  const email = process.env.BOOKING_HOST_EMAIL || '';
  const pass = process.env.BOOKING_HOST_PASSWORD || '';
  const stored = await loadStorageState('BOOKING');
  bookingBlock.attachPageWatch(page);
  const block = await bookingBlock.readBlocked(bookingBlockPool());
  const blockedNow = bookingBlock.isActive(block);
  if (stored && stored.__error) {
    errors.push({ channel: 'booking', error: 'BOOKING session invalid: ' + stored.__error });
    return false;
  }
  if (!stored && blockedNow) {
    errors.push({
      channel: 'booking',
      error: bookingBlock.blockedError(block),
      cooldownUntil: block.until,
    });
    return false;
  }
  if (!stored && (!email || !pass)) {
    errors.push({
      channel: 'booking',
      error: 'Connect Booking session (or set BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD)',
    });
    return false;
  }
  try {
    if (!stored) {
      await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await bookingAcceptCookies(page);
      if (await bookingDetectBlock(page, dir, errors, 'after-open')) return false;
      const emailInput = page.locator('#loginname, input[name="loginname"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 30000 });
      await emailInput.fill(email);
      await page
        .locator('button:has-text("Next"), button[type="submit"], button:has-text("Continue")')
        .first()
        .click({ timeout: 10000 });
      await page.waitForTimeout(2500);
      if (await bookingDetectBlock(page, dir, errors, 'after-next')) return false;
      const bodyAfterNext = await page.locator('body').innerText().catch(() => '');
      if (/make sure you.re human|are you human|captcha/i.test(bodyAfterNext)) {
        errors.push({
          channel: 'booking',
          error:
            'Booking.com captcha on password login. Connect Booking session once from a desktop browser (Platform Invoices → Connect Booking), then Pull is unattended.',
          url: page.url(),
        });
        await page.screenshot({ path: path.join(dir, '_captcha.png'), fullPage: true }).catch(() => {});
        return false;
      }
      const passInput = page
        .locator('input[type="password"]:not([id="hidden-password"]), input[name="password"], #password')
        .first();
      await passInput.waitFor({ state: 'visible', timeout: 20000 });
      await passInput.fill(pass);
      await page
        .locator(
          'button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Sign In"), button[type="submit"]'
        )
        .first()
        .click();
      await page.waitForTimeout(5000);
      if (await bookingDetectBlock(page, dir, errors, 'after-signin')) return false;
      for (let i = 0; i < 20; i++) {
        const url = page.url();
        if (onAdminExtranet(url) || (url.includes('admin.booking.com') && !/login|sign-in/i.test(url))) break;
        if (await bookingDetectBlock(page, dir, errors, 'signin-wait')) return false;
        const t = await page.locator('body').innerText().catch(() => '');
        if (/make sure you.re human|verif|two-factor|authenticator|captcha|challenge/i.test(t)) {
          errors.push({
            channel: 'booking',
            error: 'Login blocked by verification/captcha — reconnect Booking session in the app (one-time).',
            url,
          });
          await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
          return false;
        }
        await page.waitForTimeout(1000);
      }
    } else {
      await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      if (await bookingDetectBlock(page, dir, errors, 'session-open')) return false;
    }
    if (!page.url().includes('admin.booking.com') || /login|sign-in|loginname/i.test(page.url())) {
      errors.push({
        channel: 'booking',
        error: 'Booking session expired or not on admin.booking.com — reconnect Booking session, then Pull. Do not password-login from this server IP.',
        url: page.url(),
      });
      await page.screenshot({ path: path.join(dir, '_wrong-host.png'), fullPage: true }).catch(() => {});
      return false;
    }
    await persistSession('BOOKING', context);
    await page.screenshot({ path: path.join(dir, '_after-login.png'), fullPage: true }).catch(() => {});
    return true;
  } catch (e) {
    errors.push({ channel: 'booking', error: e.message, url: page.url() });
    await page.screenshot({ path: path.join(dir, '_error.png'), fullPage: true }).catch(() => {});
    return false;
  }
}

async function bookingClickNav(page, labels) {
  for (const label of labels) {
    const loc = page.locator(`a:has-text("${label}"), button:has-text("${label}"), [role="link"]:has-text("${label}")`).first();
    if (await loc.count()) {
      await loc.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function openBookingInvoicesPage(page, dir, errors) {
  for (const u of booking.BOOKING_INVOICE_URLS) {
    if (pullStopRequested()) return false;
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1800);
    await bookingAcceptCookies(page);
    if (await bookingDetectBlock(page, dir, errors, 'invoices')) return false;
    const url = page.url();
    const text = await page.locator('body').innerText().catch(() => '');
    if (/login|sign-in|loginname/i.test(url)) continue;
    if (!url.includes('admin.booking.com')) continue;
    if (/invoice|τιμολ|finance|document|οικονομ/i.test(text + url)) {
      if (!/invoice|τιμολ/i.test(text + url)) {
        await bookingClickNav(page, ['Finance', 'Invoices', 'Documents', 'Οικονομικά', 'Τιμολόγια']);
      }
      await page.screenshot({ path: path.join(dir, '_invoices.png'), fullPage: true }).catch(() => {});
      return true;
    }
    const clicked = await bookingClickNav(page, ['Finance', 'Invoices', 'Documents', 'Οικονομικά', 'Τιμολόγια']);
    if (clicked) {
      const t2 = await page.locator('body').innerText().catch(() => '');
      if (/invoice|τιμολ|finance|document/i.test(t2 + page.url())) {
        await page.screenshot({ path: path.join(dir, '_invoices.png'), fullPage: true }).catch(() => {});
        return true;
      }
    }
  }
  errors.push({
    channel: 'booking',
    error: 'Could not open group Finance → Invoices on admin.booking.com',
    url: page.url(),
  });
  await page.screenshot({ path: path.join(dir, '_no-invoices.png'), fullPage: true }).catch(() => {});
  return false;
}

async function bookingSelectMonth(page, month) {
  const [year, mon] = String(month).split('-').map(Number);
  const monthLabel = booking.MONTH_NAMES_EN[mon] || String(mon);
  const monthEl = booking.MONTH_NAMES_EL[mon] || '';
  const monthSelect = page.locator('select[name*="month" i], select[id*="month" i], [data-testid*="month"] select').first();
  if (await monthSelect.count()) {
    await monthSelect
      .selectOption({ label: monthLabel })
      .catch(() => monthSelect.selectOption({ value: String(mon) }).catch(() =>
        monthSelect.selectOption({ value: String(mon).padStart(2, '0') }).catch(() => {})
      ));
  }
  const yearSelect = page.locator('select[name*="year" i], select[id*="year" i], [data-testid*="year"] select').first();
  if (await yearSelect.count()) {
    await yearSelect.selectOption({ value: String(year) }).catch(() =>
      yearSelect.selectOption({ label: String(year) }).catch(() => {})
    );
  }
  for (const label of [monthLabel + ' ' + year, monthLabel, monthEl, String(year)].filter(Boolean)) {
    const chip = page.locator(`button:has-text("${label}"), a:has-text("${label}"), [role="option"]:has-text("${label}")`).first();
    if (await chip.count()) {
      await chip.click({ timeout: 2500 }).catch(() => {});
      break;
    }
  }
  const apply = page.locator('button:has-text("Apply"), button:has-text("Filter"), button:has-text("Search"), button:has-text("Εφαρμογή")').first();
  if (await apply.count()) await apply.click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function bookingClickMassExtract(page) {
  const gen = page.locator(
    [
      'button:has-text("Download all")',
      'a:has-text("Download all")',
      'button:has-text("Download all invoices")',
      'a:has-text("Download all invoices")',
      'button:has-text("Generate")',
      'a:has-text("Generate")',
      'button:has-text("All outstanding")',
      'a:has-text("All outstanding")',
      'button:has-text("Export")',
      'a:has-text("Export")',
      'button:has-text("Λήψη όλων")',
      'a:has-text("Λήψη όλων")',
    ].join(', ')
  ).first();
  if (await gen.count()) {
    await gen.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }
  return false;
}

async function fetchBookingPdf(page, url) {
  const abs = new URL(url, page.url()).href;
  const resp = await page.request.get(abs, { timeout: 60000 });
  const buf = Buffer.from(await resp.body());
  return buf;
}

function fileBookingPdf(buf, meta, month, dir, files, apts) {
  if (!booking.looksLikePdf(buf)) return null;
  const text = booking.pdfExtractText(buf);
  if (booking.isBookingStatementBlob(meta.name || meta.url || '', text)) return null;
  const fields = booking.parseBookingInvoiceFields(
    (meta.hotelId || '') + ' ' + (meta.url || '') + ' ' + (meta.name || '') + ' ' + text
  );
  const hotelId = fields.hotelId || booking.normalizeHotelId(meta.hotelId) || booking.parseBookingHotelId(meta.url || meta.name || '');
  const resolved = booking.resolveBookingApt(hotelId, apts);
  const invoiceNo = fields.invoiceNumber || meta.invoiceNo || '';
  const leaf = booking.bookingInvoiceFilename(resolved.bookingHotelId || hotelId, invoiceNo);
  const rel = piInvoiceStoreRel({
    channel: 'booking',
    month: month,
    aptName: resolved.folder,
    kind: 'invoice',
    code: leaf.replace(/^invoice-/, '').replace(/\.pdf$/i, ''),
  });
  const storeRoot = path.resolve(dir, '..');
  const abs = path.join(storeRoot, rel);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, buf);
  const rec = {
    channel: 'booking',
    kind: 'invoice',
    scope: 'leased',
    partner: resolved.folder,
    aptName: resolved.folder,
    aptId: resolved.aptId,
    bookingHotelId: resolved.bookingHotelId || hotelId,
    mapped: !!resolved.mapped,
    invoiceNumber: invoiceNo,
    issueDate: fields.issueDate || '',
    total: fields.total,
    filename: rel.replace(/\\/g, '/'),
    path: abs,
    bytes: buf.length,
    source: 'portal',
  };
  files.push(rec);
  emitJson({
    event: 'saved',
    channel: 'booking',
    kind: 'invoice',
    partner: resolved.folder,
    aptName: resolved.folder,
    bookingHotelId: rec.bookingHotelId,
    mapped: rec.mapped,
    filename: rec.filename,
    path: rec.path,
    bytes: rec.bytes,
    invoiceNumber: invoiceNo,
  });
  return rec;
}

/**
 * Booking.com host extranet — ALWAYS via https://admin.booking.com/
 * Mass-extract every apartment invoice for the document month. Do not walk
 * property homepages. File by bookingHotelId (Votsala → folder Votsala).
 */
async function pullBooking(page, context, month, outDir, files, errors) {
  const dir = path.join(outDir, 'booking');
  ensureDir(dir);
  const apts = loadApartments();
  const captured = [];
  const jsonTargets = [];

  page.on('response', function (res) {
    (async function () {
      try {
        const ct = String((res.headers()['content-type'] || '')).toLowerCase();
        const url = res.url();
        if (ct.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
          const buf = Buffer.from(await res.body());
          if (booking.looksLikePdf(buf)) captured.push({ buf: buf, url: url, name: path.basename(String(url).split('?')[0]) || 'invoice.pdf' });
          return;
        }
        if (ct.includes('zip') || /\.zip(\?|$)/i.test(url)) {
          const buf = Buffer.from(await res.body());
          if (booking.looksLikeZip(buf)) {
            booking.unzipPdfEntries(buf).forEach(function (ent) {
              captured.push({ buf: ent.buf, url: url, name: ent.name });
            });
          }
          return;
        }
        if (ct.includes('json')) {
          const text = await res.text();
          if (text && text.length > 8 && text.length < 8e6) {
            try { booking.harvestBookingInvoicePayloads(JSON.parse(text), jsonTargets); } catch (eJson) {}
          }
        }
      } catch (eTap) {}
    })();
  });

  page.on('download', function (download) {
    (async function () {
      try {
        const name = download.suggestedFilename() || 'download.bin';
        const tmp = path.join(dir, '_dl-' + Date.now() + '-' + String(name).replace(/[^\w.-]+/g, '_').slice(0, 80));
        await download.saveAs(tmp);
        const buf = fs.readFileSync(tmp);
        if (booking.looksLikeZip(buf)) {
          booking.unzipPdfEntries(buf).forEach(function (ent) {
            captured.push({ buf: ent.buf, url: name, name: ent.name });
          });
        } else if (booking.looksLikePdf(buf)) {
          captured.push({ buf: buf, url: name, name: name });
        }
      } catch (eDl) {}
    })();
  });

  try {
    const ok = await ensureBookingLoggedIn(page, context, dir, errors);
    if (!ok) return;
    const opened = await openBookingInvoicesPage(page, dir, errors);
    if (!opened) return;
    await bookingSelectMonth(page, month);
    await page.screenshot({ path: path.join(dir, '_invoices-month.png'), fullPage: true }).catch(() => {});
    await bookingClickMassExtract(page);
    await page.waitForTimeout(2500);

    const html = await page.content();
    const domTargets = booking.listBookingInvoiceTargets(html, page.url(), month);
    const evalRows = await page
      .evaluate(function () {
        const out = [];
        const els = document.querySelectorAll('a[href], button[data-href], [data-hotel-id], tr, [role="row"]');
        els.forEach(function (el) {
          const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
          const text = ((el.closest('tr') || el).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
          const hid = el.getAttribute('data-hotel-id') || el.getAttribute('data-hotelid') || '';
          if (!href && !hid && !/invoice|pdf|download|τιμολ/i.test(text)) return;
          out.push({ href: href, text: text, hotelId: hid });
        });
        return out.slice(0, 400);
      })
      .catch(() => []);
    const targets = booking.dedupeInvoiceTargets(jsonTargets.concat(domTargets).concat(evalRows), month);
    const total = Math.max(targets.length, captured.length, 1);
    emitJson({ event: 'progress', done: 0, total: total, saved: files.length, code: 'invoices' });

    let idx = 0;
    for (const t of targets) {
      if (pullStopRequested()) break;
      idx += 1;
      emitJson({
        event: 'progress',
        done: idx,
        total: Math.max(targets.length, 1),
        saved: files.length,
        code: t.hotelId || t.invoiceNo || 'invoice',
      });
      const href = t.href || t.url;
      if (!href || href.charAt(0) === '#') continue;
      if (booking.isBookingStatementBlob(href, t.text)) continue;
      try {
        const buf = await fetchBookingPdf(page, href);
        if (booking.looksLikeZip(buf)) {
          booking.unzipPdfEntries(buf).forEach(function (ent) {
            captured.push({ buf: ent.buf, url: href, name: ent.name, hotelId: t.hotelId, invoiceNo: t.invoiceNo });
          });
        } else if (booking.looksLikePdf(buf)) {
          captured.push({ buf: buf, url: href, name: path.basename(String(href).split('?')[0]) || 'invoice.pdf', hotelId: t.hotelId, invoiceNo: t.invoiceNo });
        }
      } catch (eFetch) {
        const loc = page.locator(`a[href="${href}"]`).first();
        if (await loc.count()) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
            loc.click({ timeout: 4000 }).catch(() => null),
          ]);
          if (download) {
            const name = download.suggestedFilename() || 'invoice.pdf';
            const tmp = path.join(dir, '_click-' + Date.now() + '-' + String(name).replace(/[^\w.-]+/g, '_').slice(0, 80));
            await download.saveAs(tmp).catch(() => null);
            if (fs.existsSync(tmp)) {
              const buf = fs.readFileSync(tmp);
              if (booking.looksLikePdf(buf)) captured.push({ buf: buf, url: href, name: name, hotelId: t.hotelId, invoiceNo: t.invoiceNo });
            }
          }
        }
      }
    }

    await page.waitForTimeout(1500);
    const seenHotel = {};
    captured.forEach(function (item) {
      if (!item || !item.buf) return;
      const fields = booking.parseBookingInvoiceFields(
        (item.hotelId || '') + ' ' + (item.url || '') + ' ' + (item.name || '') + ' ' + booking.pdfExtractText(item.buf)
      );
      const hid = fields.hotelId || booking.normalizeHotelId(item.hotelId);
      if (hid && seenHotel[hid]) return;
      const rec = fileBookingPdf(item.buf, item, month, dir, files, apts);
      if (rec && rec.bookingHotelId) seenHotel[rec.bookingHotelId] = true;
    });

    if (pullStopRequested()) {
      errors.push({ channel: 'booking', error: 'Pull stopped' });
    }
    if (!files.filter(function (f) { return f.channel === 'booking'; }).length) {
      const tooEarly = booking.bookingTooEarly(month);
      errors.push({
        channel: 'booking',
        error: tooEarly
          ? ('Booking.com invoices for ' + month + ' are not out yet (first week of the month). Retry after the 7th.')
          : ('No Booking PDFs from Finance → Invoices mass extract for ' + month + ' — check the session still has Finance access.'),
        tooEarly: tooEarly || undefined,
        url: page.url(),
        targets: targets.length,
      });
    }
    await persistSession('BOOKING', context);
  } catch (e) {
    errors.push({ channel: 'booking', error: e.message, url: page.url() });
    await page.screenshot({ path: path.join(dir, '_error.png'), fullPage: true }).catch(() => {});
  }
}

async function main() {
  ensureDir(OUT);
  if (SESSION_DIR) ensureDir(SESSION_DIR);
  const files = [];
  const errors = [];
  pullLive.files = files;
  pullLive.errors = errors;
  const wantAirbnb = CHANNEL === 'all' || CHANNEL === 'airbnb';
  const wantBooking = CHANNEL === 'all' || CHANNEL === 'booking';

  if (!wantAirbnb && !wantBooking) {
    console.log(JSON.stringify({ ok: false, error: 'channel must be all|airbnb|booking' }));
    process.exit(2);
  }

  async function runChannel(want, prefix, pullFn) {
    if (!want) return null;
    const stored = await loadStorageState(prefix);
    if (stored && stored.__error) {
      errors.push({ channel: prefix.toLowerCase(), error: prefix + ' session invalid: ' + stored.__error });
      return null;
    }
    if (prefix === 'BOOKING') {
      const block = await bookingBlock.readBlocked(bookingBlockPool());
      const canSession = !!(stored && !stored.__error);
      if (bookingBlock.isActive(block) && !canSession) {
        errors.push({
          channel: 'booking',
          error: bookingBlock.blockedError(block),
          cooldownUntil: block.until,
        });
        return null;
      }
    }
    return withBrowser(
      async (page, context) => {
        await pullFn(page, context, MONTH, OUT, files, errors);
        return true;
      },
      { storageState: stored || undefined, kind: prefix.toLowerCase() }
    );
  }

  const air = await runChannel(wantAirbnb, 'AIRBNB', pullAirbnb);
  if (air && air.error && !air.ok) {
    errors.push({ channel: 'airbnb', error: air.error, hint: air.hint });
  }
  const book = await runChannel(wantBooking, 'BOOKING', pullBooking);
  if (book && book.error && !book.ok) {
    errors.push({ channel: 'booking', error: book.error, hint: book.hint });
  }

  if ((wantAirbnb && air && air.error && !wantBooking) || (wantBooking && book && book.error && !wantAirbnb)) {
    const fail = air && air.error ? air : book;
    emitJson(fail);
    await bookingBlockPoolClose();
    process.exit(1);
  }
  if (wantAirbnb && wantBooking && air && air.error && book && book.error && !files.length) {
    emitJson({ ok: false, error: air.error || book.error, hint: air.hint || book.hint, errors });
    await bookingBlockPoolClose();
    process.exit(1);
  }

  const sessions = {};
  if (SESSION_DIR) {
    for (const ch of ['airbnb', 'booking']) {
      const p = path.join(SESSION_DIR, ch + '.json');
      sessions[ch] = fs.existsSync(p);
    }
  }

  if (pullStop.dumped) {
    await bookingBlockPoolClose();
    process.exit(files.length ? 0 : 1);
  }
  const result = {
    ok: files.length > 0,
    stopped: pullStopRequested() || undefined,
    incomplete: pullStopRequested() || undefined,
    month: MONTH,
    out: OUT,
    files,
    errors,
    sessionsSaved: sessions,
    airbnbCodes: loadAirbnbReservations().length,
  };
  pullStop.dumped = true;
  emitJson(result);
  await bookingBlockPoolClose();
  process.exit(files.length ? 0 : 1);
}

main().catch((e) => {
  try {
    (pullLive.errors || []).push({ channel: 'airbnb', error: (e && e.message) || String(e) });
  } catch (e2) {}
  requestPullStop((e && e.message) || 'main');
  emitStoppedResult();
  bookingBlockPoolClose().finally(function () { process.exit(1); });
});
