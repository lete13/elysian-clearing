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
 *     JSON array of {code, kind:'invoice'|'credit_note'|'both', aptId, aptName, guestName}
 *     Worker opens each reservation by code and downloads VAT invoice / credit note PDFs.
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

/** Hosthub channel reservation codes for Airbnb (confirmation codes). */
function loadAirbnbReservations() {
  try {
    const raw = process.env.PI_AIRBNB_RESERVATIONS_JSON || '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r) => ({
        code: String((r && (r.code || r.reservationId || r.confirmationCode)) || '')
          .trim()
          .toUpperCase(),
        kind: String((r && r.kind) || 'both').toLowerCase(),
        aptId: String((r && (r.aptId || r.apartmentId)) || '').trim(),
        aptName: String((r && (r.aptName || r.apartmentName)) || '').trim(),
        guestName: String((r && (r.guestName || r.guest)) || '').trim(),
      }))
      .filter((r) => r.code && /^[A-Z0-9]{6,20}$/.test(r.code));
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
  const email = process.env.AIRBNB_HOST_EMAIL || '';
  const pass = process.env.AIRBNB_HOST_PASSWORD || '';
  const stored = await loadStorageState('AIRBNB');
  if (stored && stored.__error) {
    errors.push({ channel: 'airbnb', error: 'AIRBNB session invalid: ' + stored.__error });
    return false;
  }
  if (!stored && (!email || !pass)) {
    errors.push({
      channel: 'airbnb',
      error: 'Connect Airbnb session (or set AIRBNB_HOST_EMAIL / AIRBNB_HOST_PASSWORD)',
    });
    return false;
  }

  if (!stored) {
    await page.goto('https://www.airbnb.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (const sel of ['button:has-text("Accept")', 'button:has-text("OK")', '[data-testid="accept-btn"]']) {
      const b = page.locator(sel).first();
      if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
    }

    const emailInput = page
      .locator('#phone-or-email, input[name="email"], input[type="email"], input[autocomplete="username"]')
      .first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    await emailInput.fill(email);
    await page.locator('button:has-text("Continue"), button[type="submit"]').first().click();
    await page.waitForTimeout(2500);

    let bodyText = await page.locator('body').innerText().catch(() => '');
    if (/confirmation code|one-time|verify your|we.ll send/i.test(bodyText) && !(await page.locator('input[type="password"]').count())) {
      const filled = await tryFillOtp(page, dir);
      if (!filled) {
        errors.push({
          channel: 'airbnb',
          error:
            'Airbnb asked for OTP. Connect a saved host session once (Platform Invoices → Connect Airbnb), then Pull runs unattended.',
        });
        await page.screenshot({ path: path.join(dir, '_login-otp.png'), fullPage: true }).catch(() => {});
        return false;
      }
    }

    const passInput = page.locator('input[name="password"], input[type="password"]').first();
    if (await passInput.count()) {
      await passInput.waitFor({ timeout: 20000 });
      await passInput.fill(pass);
      await page.locator('button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]').first().click();
      await page.waitForTimeout(4000);
    }

    bodyText = await page.locator('body').innerText().catch(() => '');
    if (/confirmation code|one-time|verify your/i.test(bodyText)) {
      const filled = await tryFillOtp(page, dir);
      if (!filled) {
        errors.push({
          channel: 'airbnb',
          error: 'Airbnb MFA/OTP blocked password login — reconnect Airbnb session in the app.',
        });
        await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
        return false;
      }
    }
    if (/captcha|unusual activity/i.test(bodyText)) {
      errors.push({
        channel: 'airbnb',
        error: 'Airbnb blocked login (captcha/unusual activity). Reconnect Airbnb session from a normal browser.',
      });
      await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
      return false;
    }
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

async function captureAirbnbDocPdf(page, dir, filename) {
  // Prefer a real download; otherwise print the open invoice HTML to PDF (VAT Invoicer-style).
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page
      .locator(
        'button:has-text("Download"), a:has-text("Download"), button:has-text("Print"), a:has-text("Print"), button:has-text("Save")'
      )
      .first()
      .click({ timeout: 3000 })
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
        out.push({ kind, href: abs, text: text.slice(0, 80) });
      });
      return out;
    },
    { wantInvoice, wantCredit }
  );
}

async function pullAirbnbDocsForCode(page, context, month, dir, files, errors, resv, apts) {
  const code = resv.code;
  const urls = [
    'https://www.airbnb.com/hosting/reservations/details/' + encodeURIComponent(code),
    'https://www.airbnb.com/hosting/reservations/' + encodeURIComponent(code),
  ];
  let opened = false;
  for (const url of urls) {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1500);
    if (/log.?in|sign.?in/i.test(page.url())) {
      errors.push({ channel: 'airbnb', code, error: 'Session lost opening reservation ' + code });
      return 0;
    }
    const text = await page.locator('body').innerText().catch(() => '');
    if (/we can.t find|not found|doesn.t exist|couldn.t find/i.test(text) && !(res && res.ok())) continue;
    if (/reservation|confirmation|guest|check-?in|vat|invoice|booking/i.test(text)) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    errors.push({ channel: 'airbnb', code, error: 'Could not open Airbnb reservation page for code ' + code });
    await page.screenshot({ path: path.join(dir, '_miss-' + code + '.png'), fullPage: true }).catch(() => {});
    return 0;
  }

  const listingGuess =
    (await page.locator('h1, h2, [data-testid*="listing"]').first().innerText().catch(() => '')) || resv.aptName || '';
  const apt = matchApartment(listingGuess || resv.aptName, apts);
  const aptId = resv.aptId || apt.aptId || '';
  const aptName = resv.aptName || apt.aptName || listingGuess || '';

  const wantKinds = [resv.kind || 'both'];
  let docs = await findAirbnbDocHrefs(page, wantKinds);
  // Expand "Receipts / Tax info" style menus if nothing visible yet
  if (!docs.length) {
    for (const label of ['Receipt', 'Tax', 'Invoice', 'Documents', 'Απόδειξη', 'Τιμολόγιο']) {
      const btn = page.locator(`button:has-text("${label}"), a:has-text("${label}"), [role="button"]:has-text("${label}")`).first();
      if (await btn.count()) await btn.click({ timeout: 1500 }).catch(() => {});
    }
    await page.waitForTimeout(800);
    docs = await findAirbnbDocHrefs(page, wantKinds);
  }

  const kindsWanted = new Set();
  if (resv.kind === 'invoice' || resv.kind === 'both' || !resv.kind) kindsWanted.add('invoice');
  if (resv.kind === 'credit_note' || resv.kind === 'both') kindsWanted.add('credit_note');

  let savedCount = 0;
  const seenKind = new Set();
  for (const doc of docs) {
    if (!kindsWanted.has(doc.kind) || seenKind.has(doc.kind)) continue;
    try {
      await page.goto(doc.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1200);
      const fname = `airbnb-${doc.kind}-${code}-${month}.pdf`;
      const saved = await captureAirbnbDocPdf(page, dir, fname);
      if (!saved) {
        errors.push({ channel: 'airbnb', code, kind: doc.kind, error: 'Opened doc but could not capture PDF' });
        continue;
      }
      seenKind.add(doc.kind);
      savedCount++;
      files.push({
        channel: 'airbnb',
        kind: doc.kind,
        scope: 'leased',
        partner: doc.kind === 'credit_note' ? ('credit_note:' + code) : (aptId || aptName || code),
        aptName: aptName,
        reservationId: code,
        filename: saved.filename,
        path: saved.path,
        bytes: saved.bytes,
        source: 'portal',
      });
    } catch (e) {
      errors.push({ channel: 'airbnb', code, kind: doc.kind, error: e.message });
    }
  }

  if (!savedCount) {
    errors.push({
      channel: 'airbnb',
      code,
      error:
        'No VAT invoice/credit note link found on reservation ' +
        code +
        ' (wanted: ' +
        [...kindsWanted].join(',') +
        ')',
    });
    await page.screenshot({ path: path.join(dir, '_nodoc-' + code + '.png'), fullPage: true }).catch(() => {});
  }
  return savedCount;
}

/**
 * Airbnb VAT Invoicer-style pull:
 * Hosthub supplies reservation confirmation codes → open each hosting reservation → PDF.
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

    // De-dupe codes but keep kind union (invoice + credit_note → both)
    const byCode = new Map();
    for (const r of reservations) {
      const prev = byCode.get(r.code);
      if (!prev) {
        byCode.set(r.code, Object.assign({}, r));
        continue;
      }
      if (prev.kind !== r.kind) prev.kind = 'both';
      if (!prev.aptId && r.aptId) prev.aptId = r.aptId;
      if (!prev.aptName && r.aptName) prev.aptName = r.aptName;
    }

    let pulled = 0;
    for (const resv of byCode.values()) {
      pulled += await pullAirbnbDocsForCode(page, context, month, dir, files, errors, resv, apts);
    }
    if (!pulled) {
      errors.push({
        channel: 'airbnb',
        error: 'Hosthub listed ' + byCode.size + ' Airbnb code(s) but 0 PDFs were captured.',
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
    const suggested =
      download.suggestedFilename() ||
      `booking-${(partner || 'apt').toString().replace(/[^\w.\-]+/g, '_').slice(0, 40)}-${month}-${got + 1}.pdf`;
    const saved = await saveDownload(download, dir, suggested.replace(/[^\w.\-]+/g, '_'));
    files.push({
      channel: 'booking',
      kind: 'invoice',
      scope: 'leased',
      partner,
      aptName: apt.aptName || prop.name || '',
      filename: saved.filename,
      path: saved.path,
      bytes: saved.bytes,
      source: 'portal',
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
    console.log(JSON.stringify(fail));
    process.exit(1);
  }
  if (wantAirbnb && wantBooking && air && air.error && book && book.error && !files.length) {
    console.log(JSON.stringify({ ok: false, error: air.error || book.error, hint: air.hint || book.hint, errors }));
    process.exit(1);
  }

  const sessions = {};
  if (SESSION_DIR) {
    for (const ch of ['airbnb', 'booking']) {
      const p = path.join(SESSION_DIR, ch + '.json');
      sessions[ch] = fs.existsSync(p);
    }
  }

  const result = {
    ok: files.length > 0,
    month: MONTH,
    out: OUT,
    files,
    errors,
    sessionsSaved: sessions,
    airbnbCodes: loadAirbnbReservations().length,
  };
  console.log(JSON.stringify(result, null, 0));
  process.exit(files.length ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
