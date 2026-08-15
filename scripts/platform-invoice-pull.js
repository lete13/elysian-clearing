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
 *   PI_APARTMENTS_JSON (optional JSON array of {aptId,aptName} for partner matching)
 *   PI_AIRBNB_RESERVATIONS_JSON — Hosthub-driven Airbnb codes (VAT Invoicer-style):
 *     JSON array of {code, kind:'invoice'|'credit_note'|'both', aptId, aptName, guestName, created, createdOnChannel}
 *     Worker opens /hosting/stay/{CODE} (Airbnb's current reservation page), clicks the
 *     total price (Airbnb Help 438), finds every VAT invoice / credit note ID on that stay,
 *     opens each invoice HTML, prints PDF. Cancel = debit + credit; extend = original debit
 *     + credit of that debit + new debit. Filenames are kind-{code}-{vatId}.pdf.
 *   PI_AIRBNB_LIMIT — optional max codes (Collect "Test pull (5 codes)" = latest N by created).
 *
 * Booking.com: https://admin.booking.com/ — one invoice per property/apartment.
 * Dating: Booking invoice month M covers bookings from M−1;
 *         Airbnb VAT = created; credit note = cancelledAt.
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

function loadApartments() {
  try {
    const raw = process.env.PI_APARTMENTS_JSON || '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
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
  let arr = [];
  try {
    arr = JSON.parse(process.env.PI_AIRBNB_HAVE_JSON || '[]');
  } catch (e) {
    arr = [];
  }
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
    const raw = process.env.PI_AIRBNB_RESERVATIONS_JSON || '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
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

async function withBrowser(fn, opts) {
  const pw = await loadPlaywright();
  if (!pw) {
    return { ok: false, error: 'playwright package not installed' };
  }
  let browser;
  const proxy = process.env.PLAYWRIGHT_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const launchOpts = {
    headless: !HEADED,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  };
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
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: process.env.PI_AIRBNB_TZ || 'Europe/Athens',
    geolocation: { latitude: 37.9838, longitude: 23.7275 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(function () {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
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
  return true;
}

async function savePdfBuffer(dir, filename, buf) {
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

  const pathIdRe = /\/reservation\/(?:vat_invoice|tax_invoice)\/([A-Za-z0-9_-]+)/gi;
  while ((m = pathIdRe.exec(text))) {
    add('invoice', abs(m[0]), m[1], 'path-id');
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

function airbnbInvoiceUrlsForHit(hit, origin, pageUrlPatterns) {
  const urls = [];
  const seen = new Set();
  function push(u) {
    if (!u || seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  }
  if (hit && hit.href) push(hit.href);
  const id = String((hit && hit.id) || '').trim();
  const origin0 = String(origin || 'https://www.airbnb.com').replace(/\/$/, '');
  if (id) {
    (pageUrlPatterns || []).forEach((t) => {
      if (String(t).includes(id)) push(t);
      else {
        const swapped = String(t).replace(/\/[A-Za-z0-9_-]+(\?.*)?$/, '/' + encodeURIComponent(id) + '$1');
        if (swapped !== t) push(swapped);
      }
    });
    // Airbnb's own VAT invoice HTML pages (not a VAT Invoicer endpoint).
    push(origin0 + '/reservation/vat_invoice/' + encodeURIComponent(id));
    push(origin0 + '/reservation/tax_invoice/' + encodeURIComponent(id));
  }
  return urls;
}

function looksLikeAirbnbInvoiceHtml(url, bodyText) {
  const u = String(url || '');
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  if (/log.?in|sign.?in/i.test(u)) return false;
  if (/\/hosting\/stay(\/|$)/i.test(u) && !/vat_invoice|tax_invoice/i.test(u)) return false;
  if (/\/hosting\/reservations(\/details)?/i.test(u) && !/vat_invoice|tax_invoice/i.test(u)) return false;
  if (/vat_invoice|tax_invoice|\/invoice\//i.test(u)) {
    if (/we can.t find|not found|doesn.t exist|page not found|404/i.test(t)) return false;
    return true;
  }
  if (
    /vat invoice|tax invoice|τιμολ|invoice number|αριθμ[οό]ς τιμολ|credit note|πιστωτικ/i.test(t) &&
    !/upcoming reservations|reservation details/i.test(t)
  ) {
    return true;
  }
  return false;
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
  const totalLine = t.match(
    /(?:invoice\s*total|grand\s*total|amount\s*due|total\s*amount|σύνολο|total)\D{0,24}(?:€|EUR)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i
  );
  if (totalLine) total = parseAirbnbVatAmount(totalLine[1]);
  if (total == null) {
    const euro = t.match(/€\s*([0-9]+(?:[.,][0-9]{1,2})?)/);
    if (euro) total = parseAirbnbVatAmount(euro[1]);
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
  const m = String(url || '').match(/\/(?:vat[_-]?invoice|tax[_-]?invoice|credit[_-]?note)\/([A-Za-z0-9_-]+)/i);
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
    if (/vat[_-]?invoice|tax[_-]?invoice/i.test(href)) return true;
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
        !/\/reservation\/vat_invoice/i.test(url + ' ' + body)
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
  if (!pdf || !pdf.length) return null;
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
      const URL_RE = /vat[_-]?invoice|tax[_-]?invoice|credit[_-]?note/i;
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
      const re = /vat\s*invoice|tax\s*invoice|credit\s*note|debit\s*note|τιμολ|πιστωτικ|vat_invoice|tax_invoice/i;
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
  await page.waitForTimeout(800);
  const url = page.url();
  const body = await page.locator('body').innerText().catch(() => '');
  if (!looksLikeAirbnbInvoiceHtml(url, body)) return { saved: null, url, lookedLikeInvoice: false };
  const saved = await captureAirbnbDocPdf(page, dir, fname);
  return { saved, url, lookedLikeInvoice: true };
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

  const listingGuess =
    (await page.locator('h1, h2, [data-testid*="listing"]').first().innerText().catch(() => '')) || resv.aptName || '';
  const apt = matchApartment(listingGuess || resv.aptName, apts);
  const aptId = resv.aptId || apt.aptId || '';
  const aptName = resv.aptName || apt.aptName || listingGuess || '';

  // Always collect every VAT debit + credit on the stay (cancel / extend sets).
  const kindsWanted = new Set(['invoice', 'credit_note']);
  const alreadyHave = loadAirbnbHaveSet();
  const savedKeys = new Set();

  let savedCount = 0;
  let lastLanded = page.url();
  let lastLookedLikeInvoice = false;
  const reservationUrl = page.url();

  async function saveIfInvoice(targetPage, kind, how, idHint) {
    const body = await targetPage.locator('body').innerText().catch(() => '');
    const urlNow = targetPage.url();
    lastLanded = urlNow;
    lastLookedLikeInvoice = looksLikeAirbnbInvoiceHtml(urlNow, body);
    if (!lastLookedLikeInvoice) return false;
    const fields = parseAirbnbVatFields(body, kind, vatIdFromAirbnbUrl(urlNow) || idHint);
    let vatId = String(idHint || vatIdFromAirbnbUrl(urlNow) || fields.invoiceNumber || '').replace(/[^\w.-]+/g, '').slice(0, 40);
    if (vatId && vatId.toUpperCase() === String(code).toUpperCase()) vatId = '';
    if (airbnbDocAlreadyHave(alreadyHave, kind, code, vatId)) return 'have';
    const storeKey = airbnbHaveKey(kind, code, vatId);
    if (savedKeys.has(storeKey)) return 'have';
    const rel = piInvoiceStoreRel({
      channel: 'airbnb',
      month: month,
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
      filename: rel.replace(/\\/g, '/'),
      path: cap.saved.path,
      bytes: cap.saved.bytes,
      code,
    });
    return true;
  }

  async function goStay() {
    if (!/\/hosting\/stay\//i.test(page.url())) {
      await page.goto(reservationUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await settleAirbnbHostPage(page);
    }
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
  for (const hit of hits) {
    if (hit.id && String(hit.id).toUpperCase() === code) continue;
    const kind = hit.kind === 'credit_note' ? 'credit_note' : 'invoice';
    for (const href of airbnbInvoiceUrlsForHit(hit, origin, templates)) {
      addCandidate(kind, href, hit.id || vatIdFromAirbnbUrl(href), hit.how || 'scan');
    }
  }
  mergeListedHrefs(await listAirbnbVatDocHrefs(page));

  for (let i = 0; i < candidates.length && i < 24; i++) {
    const cand = candidates[i];
    if (airbnbDocAlreadyHave(alreadyHave, cand.kind, code, cand.id)) continue;
    try {
      const popupP = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      const nav = await page.goto(cand.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
      if (nav && nav.status() >= 400) {
        await popupP;
        continue;
      }
      await page.waitForTimeout(1200);
      const popup = await popupP;
      const target = popup || page;
      await saveIfInvoice(target, cand.kind, cand.how || 'invoice-id', cand.id);
      if (popup) await popup.close().catch(() => {});
      await goStay();
      await clickAirbnbStayTotalPrice(page);
      mergeListedHrefs(await listAirbnbVatDocHrefs(page));
    } catch (e) {
      errors.push({ channel: 'airbnb', code, kind: cand.kind, error: e.message });
    }
  }

  if (!savedCount) {
    await goStay();
    await revealAndCollect('help-click-retry');
    bag = await collectAirbnbInvoiceHits(page, netHits, 'both');
    for (const hit of usefulAirbnbInvoiceHits(bag.hits, code)) {
      const kind = hit.kind === 'credit_note' ? 'credit_note' : 'invoice';
      for (const href of airbnbInvoiceUrlsForHit(hit, origin, bag.templates || [])) {
        if (airbnbDocAlreadyHave(alreadyHave, kind, code, hit.id || vatIdFromAirbnbUrl(href))) continue;
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(1200);
        await saveIfInvoice(page, kind, 'rescan-id', hit.id || '');
        await goStay();
      }
    }
  }

  if (!savedCount) {
    const lastUrls = [
      origin + '/reservation/vat_invoice/' + encodeURIComponent(code),
      origin + '/reservation/tax_invoice/' + encodeURIComponent(code),
    ];
    for (const href of lastUrls) {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1200);
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
    }

    const limit = loadAirbnbLimit();
    let queue = sortAirbnbReservationsLatest([...byCode.values()]);
    if (limit > 0) queue = queue.slice(0, limit);

    let pulled = 0;
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
        continue;
      }
      emitJson({ event: 'progress', done: idx, total: total, saved: files.length, code: resv.code });
      pulled += await pullAirbnbDocsForCode(page, context, month, dir, files, errors, resv, apts);
    }
    if (pullStopRequested()) {
      errors.push({ channel: 'airbnb', error: 'Pull stopped' });
    }
    if (!pulled) {
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

async function listBookingProperties(page) {
  const found = [];
  const tryUrls = [
    'https://admin.booking.com/hotel/hoteladmin/groups/home/index.html',
    'https://admin.booking.com/hotel/hoteladmin/groups/home.html',
    'https://admin.booking.com/',
  ];
  for (const u of tryUrls) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(2000);
    if (!page.url().includes('admin.booking.com')) continue;
    const rows = await page
      .$$eval(
        'a[href*="hotel_id"], a[href*="hoteladmin"], a[href*="extranet_ng"], [data-testid*="property"] a, table a',
        (as) => {
          const out = [];
          const seen = new Set();
          as.forEach((a) => {
            const href = a.getAttribute('href') || '';
            if (!/hotel_id|hoteladmin|extranet/i.test(href)) return;
            let abs = href;
            try {
              abs = new URL(href, location.origin).href;
            } catch (e) {}
            if (!/admin\.booking\.com/i.test(abs)) return;
            if (/login|sign-in|account\.booking/i.test(abs)) return;
            const name = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            const key = abs.replace(/#.*$/, '');
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ url: key, name: name || key });
          });
          return out.slice(0, 80);
        }
      )
      .catch(() => []);
    for (const r of rows) {
      if (!found.some((f) => f.url === r.url)) found.push(r);
    }
    if (found.length >= 2) break;
  }
  if (!found.length) {
    found.push({ url: page.url(), name: 'current' });
  }
  return found;
}

async function downloadBookingInvoicesForProperty(page, month, dir, files, errors, prop, apts) {
  const [year, mon] = month.split('-').map(Number);
  const monthNames = [
    '',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const apt = matchApartment(prop.name, apts);
  const partner = apt.aptId || apt.aptName || prop.name || '';

  // Keep hotel_id when present so invoices page stays in property context
  let hotelQ = '';
  try {
    const u = new URL(prop.url);
    hotelQ = u.search || '';
  } catch (e) {}

  const invoiceUrls = [
    'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoices.html' + hotelQ,
    'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoice.html' + hotelQ,
    'https://admin.booking.com/hotel/hoteladmin/finance_invoices.html' + hotelQ,
    'https://admin.booking.com/hotel/hoteladmin/finance/invoices.html' + hotelQ,
    'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/documents.html' + hotelQ,
  ];

  if (prop.url && /hoteladmin|extranet/i.test(prop.url)) {
    await page.goto(prop.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1500);
  }

  let opened = false;
  for (const u of invoiceUrls) {
    const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1200);
    const url = page.url();
    const text = await page.locator('body').innerText().catch(() => '');
    if (
      url.includes('admin.booking.com') &&
      /invoice|τιμολ|finance|document/i.test(text + url) &&
      !/sign.?in|log.?in|loginname/i.test(url)
    ) {
      opened = true;
      break;
    }
    if (res && res.ok() && url.includes('admin.booking.com') && !/login/i.test(url)) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    for (const label of ['Finance', 'Invoices', 'Documents', 'Οικονομικά', 'Τιμολόγια']) {
      const fin = page.locator(`a:has-text("${label}"), button:has-text("${label}"), [role="link"]:has-text("${label}")`).first();
      if (await fin.count()) {
        await fin.click().catch(() => {});
        await page.waitForTimeout(1500);
        if (page.url().includes('admin.booking.com')) {
          opened = true;
          break;
        }
      }
    }
  }
  if (!opened) {
    errors.push({
      channel: 'booking',
      property: prop.name,
      error: 'Could not open Finance/Invoices for property',
      url: page.url(),
    });
    return 0;
  }

  const monthLabel = monthNames[mon] || String(mon);
  const monthSelect = page.locator('select[name*="month" i], select[id*="month" i], [data-testid*="month"] select').first();
  if (await monthSelect.count()) {
    await monthSelect.selectOption({ label: monthLabel }).catch(() =>
      monthSelect.selectOption({ value: String(mon) }).catch(() =>
        monthSelect.selectOption({ value: String(mon).padStart(2, '0') }).catch(() => {})
      )
    );
  }
  const yearSelect = page.locator('select[name*="year" i], select[id*="year" i], [data-testid*="year"] select').first();
  if (await yearSelect.count()) {
    await yearSelect.selectOption({ value: String(year) }).catch(() =>
      yearSelect.selectOption({ label: String(year) }).catch(() => {})
    );
  }

  const gen = page
    .locator(
      'button:has-text("Generate"), a:has-text("Generate"), button:has-text("All outstanding"), a:has-text("All outstanding"), button:has-text("Download all"), a:has-text("Download all")'
    )
    .first();
  if (await gen.count()) await gen.click().catch(() => {});
  await page.waitForTimeout(2000);

  const dlLoc = page.locator(
    'a[href*=".pdf"], a[download], a:has-text("PDF"), a:has-text("Download"), button:has-text("Download"), a:has-text("outstanding")'
  );
  const n = await dlLoc.count();
  let got = 0;
  for (let i = 0; i < Math.min(n, 15); i++) {
    const el = dlLoc.nth(i);
    const label = ((await el.innerText().catch(() => '')) + ' ' + (await el.getAttribute('href').catch(() => ''))).toLowerCase();
    if (label && !/\.pdf|download|invoice|outstanding|τιμολ/.test(label)) continue;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
      el.click({ timeout: 5000 }).catch(() => null),
    ]);
    if (!download) continue;
    const aptName = apt.aptName || prop.name || partner || 'Apartment';
    const rel = piInvoiceStoreRel({
      channel: 'booking',
      month,
      aptName,
      kind: 'invoice',
      code: String(apt.aptId || aptName || 'apt').replace(/\s+/g, '_').slice(0, 40),
    });
    const storeRoot = path.resolve(dir, '..');
    const abs = path.join(storeRoot, rel);
    ensureDir(path.dirname(abs));
    const saved = await saveDownload(download, path.dirname(abs), path.basename(rel));
    files.push({
      channel: 'booking',
      kind: 'invoice',
      scope: 'leased',
      partner: aptName,
      aptName,
      filename: rel.replace(/\\/g, '/'),
      path: saved.path,
      bytes: saved.bytes,
      source: 'portal',
    });
    emitJson({
      event: 'saved',
      channel: 'booking',
      kind: 'invoice',
      partner: aptName,
      aptName,
      filename: rel.replace(/\\/g, '/'),
      path: saved.path,
      bytes: saved.bytes,
    });
    got++;
    // Booking = one invoice per apartment — stop after first PDF for this property
    break;
  }
  if (!got) {
    errors.push({
      channel: 'booking',
      property: prop.name,
      error: 'No PDF download on invoices page for this apartment',
      url: page.url(),
    });
    await page
      .screenshot({
        path: path.join(dir, '_invoices-' + String(prop.name || 'x').replace(/[^\w.\-]+/g, '_').slice(0, 30) + '.png'),
        fullPage: true,
      })
      .catch(() => {});
  }
  return got;
}

/**
 * Booking.com host extranet — ALWAYS via https://admin.booking.com/
 * Pulls one invoice per property (apartment).
 */
async function pullBooking(page, context, month, outDir, files, errors) {
  const email = process.env.BOOKING_HOST_EMAIL || '';
  const pass = process.env.BOOKING_HOST_PASSWORD || '';
  const stored = await loadStorageState('BOOKING');
  if (stored && stored.__error) {
    errors.push({ channel: 'booking', error: 'BOOKING session invalid: ' + stored.__error });
    return;
  }
  if (!stored && (!email || !pass)) {
    errors.push({
      channel: 'booking',
      error: 'Connect Booking session (or set BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD)',
    });
    return;
  }
  const dir = path.join(outDir, 'booking');
  ensureDir(dir);
  const apts = loadApartments();

  try {
    if (!stored) {
      await page.goto('https://admin.booking.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(2500);

      for (const sel of [
        'button:has-text("Accept")',
        'button:has-text("Agree")',
        '#onetrust-accept-btn-handler',
      ]) {
        const b = page.locator(sel).first();
        if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
      }

      const emailInput = page.locator('#loginname, input[name="loginname"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 30000 });
      await emailInput.fill(email);
      await page
        .locator('button:has-text("Next"), button[type="submit"], button:has-text("Continue")')
        .first()
        .click({ timeout: 10000 });
      await page.waitForTimeout(2500);

      const bodyAfterNext = await page.locator('body').innerText().catch(() => '');
      if (/make sure you.re human|are you human|captcha/i.test(bodyAfterNext)) {
        errors.push({
          channel: 'booking',
          error:
            'Booking.com captcha on password login. Connect Booking session once from a desktop browser (Platform Invoices → Connect Booking), then Pull is unattended.',
          url: page.url(),
        });
        await page.screenshot({ path: path.join(dir, '_captcha.png'), fullPage: true }).catch(() => {});
        return;
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

      for (let i = 0; i < 20; i++) {
        const url = page.url();
        if (onAdminExtranet(url) || (url.includes('admin.booking.com') && !/login|sign-in/i.test(url))) break;
        const t = await page.locator('body').innerText().catch(() => '');
        if (/make sure you.re human|verif|two-factor|authenticator|captcha|challenge/i.test(t)) {
          errors.push({
            channel: 'booking',
            error: 'Login blocked by verification/captcha — reconnect Booking session in the app (one-time).',
            url,
          });
          await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
          return;
        }
        await page.waitForTimeout(1000);
      }
    } else {
      await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
    }

    if (!page.url().includes('admin.booking.com') || /login|sign-in|loginname/i.test(page.url())) {
      errors.push({
        channel: 'booking',
        error: 'Booking session expired or not on admin.booking.com — reconnect Booking session, then Pull.',
        url: page.url(),
      });
      await page.screenshot({ path: path.join(dir, '_wrong-host.png'), fullPage: true }).catch(() => {});
      return;
    }

    await persistSession('BOOKING', context);
    await page.screenshot({ path: path.join(dir, '_after-login.png'), fullPage: true }).catch(() => {});

    const props = await listBookingProperties(page);
    let total = 0;
    for (const prop of props) {
      total += await downloadBookingInvoicesForProperty(page, month, dir, files, errors, prop, apts);
    }
    if (!total) {
      errors.push({
        channel: 'booking',
        error:
          'No Booking PDFs downloaded across ' +
          props.length +
          ' propert' +
          (props.length === 1 ? 'y' : 'ies') +
          ' — check Finance → Invoices for the document month.',
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
    return withBrowser(
      async (page, context) => {
        await pullFn(page, context, MONTH, OUT, files, errors);
        return true;
      },
      { storageState: stored || undefined }
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
    process.exit(1);
  }
  if (wantAirbnb && wantBooking && air && air.error && book && book.error && !files.length) {
    emitJson({ ok: false, error: air.error || book.error, hint: air.hint || book.hint, errors });
    process.exit(1);
  }

  const sessions = {};
  if (SESSION_DIR) {
    for (const ch of ['airbnb', 'booking']) {
      const p = path.join(SESSION_DIR, ch + '.json');
      sessions[ch] = fs.existsSync(p);
    }
  }

  if (pullStop.dumped) process.exit(files.length ? 0 : 1);
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
  process.exit(files.length ? 0 : 1);
}

main().catch((e) => {
  try {
    (pullLive.errors || []).push({ channel: 'airbnb', error: (e && e.message) || String(e) });
  } catch (e2) {}
  requestPullStop((e && e.message) || 'main');
  emitStoppedResult();
  process.exit(1);
});
