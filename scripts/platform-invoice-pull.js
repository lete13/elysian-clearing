#!/usr/bin/env node
/**
 * Platform invoice portal pull — Airbnb + Booking.com
 *
 * Usage:
 *   node scripts/platform-invoice-pull.js --month=2026-07 [--channel=all|airbnb|booking] [--out=/tmp/pi] [--headed]
 *
 * Env:
 *   AIRBNB_HOST_EMAIL / AIRBNB_HOST_PASSWORD
 *   BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD
 *
 * Booking.com extranet entry: https://admin.booking.com/ (never www.booking.com)
 *
 * Dating rules:
 *   Booking.com  — invoice month M covers bookings from M-1
 *   Airbnb VAT   — issue month = confirmation (Hosthub created)
 *   Airbnb CN    — issue month = cancellation (Hosthub cancelledAt)
 *
 * Prints one JSON object to stdout. PDFs land in --out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

if (!/^\d{4}-\d{2}$/.test(MONTH)) {
  console.log(JSON.stringify({ ok: false, error: 'Usage: --month=YYYY-MM required' }));
  process.exit(2);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    return null;
  }
}

async function loadStorageState(prefix) {
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

async function withBrowser(fn, opts) {
  const pw = await loadPlaywright();
  if (!pw) {
    return { ok: false, error: 'playwright package not installed' };
  }
  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: !HEADED,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
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
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    ...(storageState ? { storageState } : {}),
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

/** Airbnb: login → reservations → open details → download VAT invoice / credit note. */
async function pullAirbnb(page, context, month, outDir, files, errors) {
  const email = process.env.AIRBNB_HOST_EMAIL || '';
  const pass = process.env.AIRBNB_HOST_PASSWORD || '';
  const stored = await loadStorageState('AIRBNB');
  if (stored && stored.__error) {
    errors.push({ channel: 'airbnb', error: 'AIRBNB_STORAGE_STATE invalid: ' + stored.__error });
    return;
  }
  if (!stored && (!email || !pass)) {
    errors.push({ channel: 'airbnb', error: 'Set AIRBNB_HOST_EMAIL / AIRBNB_HOST_PASSWORD or AIRBNB_STORAGE_STATE_B64' });
    return;
  }
  const dir = path.join(outDir, 'airbnb');
  ensureDir(dir);

  try {
    const stored = await loadStorageState('AIRBNB');
    if (stored && stored.__error) {
      errors.push({ channel: 'airbnb', error: 'AIRBNB_STORAGE_STATE invalid: ' + stored.__error });
      return;
    }
    if (!stored) {
      await page.goto('https://www.airbnb.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (const sel of ['button:has-text("Accept")', 'button:has-text("OK")', '[data-testid="accept-btn"]']) {
        const b = page.locator(sel).first();
        if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
      }

      // Current Airbnb login uses #phone-or-email
      const emailInput = page
        .locator('#phone-or-email, input[name="email"], input[type="email"], input[autocomplete="username"]')
        .first();
      await emailInput.waitFor({ state: 'visible', timeout: 20000 });
      await emailInput.fill(email);
      await page.locator('button:has-text("Continue"), button[type="submit"]').first().click();
      await page.waitForTimeout(2500);

      let bodyText = await page.locator('body').innerText().catch(() => '');
      if (/confirmation code|one-time|verify your|we.ll send/i.test(bodyText) && !(await page.locator('input[type="password"]').count())) {
        errors.push({
          channel: 'airbnb',
          error:
            'Airbnb wants an email/SMS code (OTP). Set AIRBNB_STORAGE_STATE_B64 from a headed login (see scripts/platform-invoice-save-session.js), or upload PDFs manually.',
        });
        await page.screenshot({ path: path.join(dir, '_login-otp.png'), fullPage: true }).catch(() => {});
        return;
      }

      const passInput = page.locator('input[name="password"], input[type="password"]').first();
      await passInput.waitFor({ timeout: 20000 });
      await passInput.fill(pass);
      await page.locator('button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]').first().click();
      await page.waitForTimeout(4000);

      bodyText = await page.locator('body').innerText().catch(() => '');
      if (/verif|two-factor|authenticator|captcha|unusual activity|confirmation code/i.test(bodyText)) {
        errors.push({
          channel: 'airbnb',
          error:
            'Login needs verification (MFA/OTP/captcha). Set AIRBNB_STORAGE_STATE_B64 from headed login, or upload PDFs.',
        });
        await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
        return;
      }
    }

    await page.goto('https://www.airbnb.com/hosting/reservations', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // Try "All" tab
    for (const t of ['All', 'Όλα', 'Upcoming', 'Past', 'Canceled', 'Cancelled']) {
      const tab = page.locator(`button:has-text("${t}"), a:has-text("${t}"), [role="tab"]:has-text("${t}")`).first();
      if (await tab.count()) await tab.click({ timeout: 1500 }).catch(() => {});
    }
    await page.waitForTimeout(1500);

    // Collect reservation detail links (best-effort — UI changes often)
    const hrefs = await page.$$eval('a[href*="/details"], a[href*="reservation"], a[href*="/hosting/"]', (as) => {
      const u = new Set();
      as.forEach((a) => {
        const h = a.getAttribute('href') || '';
        if (/reservation|details|booking/i.test(h)) {
          try {
            u.add(new URL(h, location.origin).href);
          } catch (e) {}
        }
      });
      return [...u].slice(0, 80);
    });

    if (!hrefs.length) {
      errors.push({
        channel: 'airbnb',
        error: 'No reservation links found after login — selectors may need updating, or the inbox is empty.',
      });
      await page.screenshot({ path: path.join(dir, '_reservations.png'), fullPage: true }).catch(() => {});
      return;
    }

    let idx = 0;
    for (const href of hrefs) {
      idx++;
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
        const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

        // Prefer explicit invoice / VAT / credit-note actions
        const candidates = [
          { kind: 'credit_note', re: /credit\s*note|πιστωτικ/i },
          { kind: 'invoice', re: /vat\s*invoice|tax\s*invoice|τιμολ|invoice/i },
        ];
        for (const c of candidates) {
          if (!c.re.test(text) && c.kind === 'credit_note') continue;
          const btn = page
            .locator(
              'a:has-text("VAT Invoice"), a:has-text("Invoice"), a:has-text("Credit note"), a:has-text("Credit Note"), button:has-text("VAT Invoice"), button:has-text("Print"), a:has-text("Download"), button:has-text("Download")'
            )
            .filter({ hasText: c.re })
            .first();
          // Broader fallback
          const any = (await btn.count())
            ? btn
            : page.locator('a:has-text("Invoice"), button:has-text("Invoice"), a:has-text("Print"), button:has-text("Print")').first();
          if (!(await any.count())) continue;

          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
            any.click({ timeout: 5000 }).catch(() => null),
          ]);
          if (!download) {
            // Print dialog path — try page.pdf as last resort for printable views
            continue;
          }
          const suggested = download.suggestedFilename() || `airbnb-${c.kind}-${month}-${idx}.pdf`;
          const safe = suggested.replace(/[^\w.\-]+/g, '_');
          const saved = await saveDownload(download, dir, safe);
          files.push({
            channel: 'airbnb',
            kind: c.kind,
            scope: 'leased',
            filename: saved.filename,
            path: saved.path,
            bytes: saved.bytes,
            source: 'portal',
          });
        }
      } catch (e) {
        errors.push({ channel: 'airbnb', href, error: e.message });
      }
    }
  } catch (e) {
    errors.push({ channel: 'airbnb', error: e.message });
    await page.screenshot({ path: path.join(dir, '_error.png'), fullPage: true }).catch(() => {});
  }
}

/**
 * Booking.com host extranet — ALWAYS via https://admin.booking.com/
 * (not www.booking.com / partner join). Login may bounce through
 * account.booking.com but must return to admin.booking.com/hotel/…
 */
async function pullBooking(page, context, month, outDir, files, errors) {
  const email = process.env.BOOKING_HOST_EMAIL || '';
  const pass = process.env.BOOKING_HOST_PASSWORD || '';
  const stored = await loadStorageState('BOOKING');
  if (stored && stored.__error) {
    errors.push({ channel: 'booking', error: 'BOOKING_STORAGE_STATE invalid: ' + stored.__error });
    return;
  }
  if (!stored && (!email || !pass)) {
    errors.push({
      channel: 'booking',
      error: 'Set BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD or BOOKING_STORAGE_STATE_B64',
    });
    return;
  }
  const dir = path.join(outDir, 'booking');
  ensureDir(dir);
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

  function onAdminExtranet(url) {
    try {
      const u = new URL(url);
      return u.hostname === 'admin.booking.com' && /hoteladmin|extranet/i.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  try {
    if (!stored) {
      // Partner extranet entry. /login 404s — root redirects to account.booking.com SSO.
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

      // Extranet "Login name" / Login ID (often not an email)
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
            'Booking.com showed a human/captcha check after Login name. From a desktop browser run: node scripts/platform-invoice-save-session.js --channel=booking --headed — then set BOOKING_STORAGE_STATE_B64 on Railway. Until then use Upload.',
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
            error:
              'Login blocked by verification/captcha. Set BOOKING_STORAGE_STATE_B64 from headed login, or upload PDFs.',
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

    // Multi-property picker
    const prop = page
      .locator(
        'a[href*="hoteladmin"], a[href*="extranet"], [data-testid*="property"] a, table a[href*="hotel_id"]'
      )
      .first();
    if (await prop.count()) {
      await prop.click().catch(() => {});
      await page.waitForTimeout(2500);
    }

    if (!page.url().includes('admin.booking.com')) {
      errors.push({
        channel: 'booking',
        error: 'Not on admin.booking.com after login (landed on ' + page.url() + ').',
        hint: stored ? 'Storage state may be expired — re-run save-session.' : undefined,
      });
      await page.screenshot({ path: path.join(dir, '_wrong-host.png'), fullPage: true }).catch(() => {});
      return;
    }

    await page.screenshot({ path: path.join(dir, '_after-login.png'), fullPage: true }).catch(() => {});

    // Finance → Invoices on the extranet (URL patterns vary by hoteladmin version)
    const invoiceUrls = [
      'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoices.html',
      'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoice.html',
      'https://admin.booking.com/hotel/hoteladmin/finance_invoices.html',
      'https://admin.booking.com/hotel/hoteladmin/finance/invoices.html',
      'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/documents.html',
    ];
    let opened = false;
    for (const u of invoiceUrls) {
      const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
      await page.waitForTimeout(1500);
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
      // Nav: Finance / Invoices / Documents (stay on admin.booking.com)
      for (const label of ['Finance', 'Invoices', 'Documents', 'Οικονομικά', 'Τιμολόγια']) {
        const fin = page.locator(`a:has-text("${label}"), button:has-text("${label}"), [role="link"]:has-text("${label}")`).first();
        if (await fin.count()) {
          await fin.click().catch(() => {});
          await page.waitForTimeout(2000);
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
        error: 'Could not open Finance/Invoices on admin.booking.com — update selectors/URL.',
        url: page.url(),
      });
      await page.screenshot({ path: path.join(dir, '_nav.png'), fullPage: true }).catch(() => {});
      return;
    }

    // Month / year filters — best effort (invoice month M = bookings M−1)
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
        'button:has-text("Generate"), a:has-text("Generate"), button:has-text("All outstanding"), a:has-text("All outstanding"), button:has-text("Download all")'
      )
      .first();
    if (await gen.count()) await gen.click().catch(() => {});
    await page.waitForTimeout(2500);

    // Collect every plausible PDF / download link for this month
    const dlLoc = page.locator(
      'a[href*=".pdf"], a[download], a:has-text("PDF"), a:has-text("Download"), button:has-text("Download"), a:has-text("outstanding")'
    );
    const n = await dlLoc.count();
    let got = 0;
    for (let i = 0; i < Math.min(n, 25); i++) {
      const el = dlLoc.nth(i);
      const label = ((await el.innerText().catch(() => '')) + ' ' + (await el.getAttribute('href').catch(() => ''))).toLowerCase();
      if (label && !/\.pdf|download|invoice|outstanding|τιμολ/.test(label)) continue;
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
        el.click({ timeout: 5000 }).catch(() => null),
      ]);
      if (!download) continue;
      const suggested = download.suggestedFilename() || `booking-invoice-${month}-${got + 1}.pdf`;
      const saved = await saveDownload(download, dir, suggested.replace(/[^\w.\-]+/g, '_'));
      files.push({
        channel: 'booking',
        kind: 'invoice',
        scope: 'leased',
        filename: saved.filename,
        path: saved.path,
        bytes: saved.bytes,
        source: 'portal',
      });
      got++;
    }
    if (!got) {
      errors.push({
        channel: 'booking',
        error: 'No PDF download on admin.booking.com invoices page — selectors need a live pass.',
        url: page.url(),
      });
      await page.screenshot({ path: path.join(dir, '_invoices.png'), fullPage: true }).catch(() => {});
    }
  } catch (e) {
    errors.push({ channel: 'booking', error: e.message, url: page.url() });
    await page.screenshot({ path: path.join(dir, '_error.png'), fullPage: true }).catch(() => {});
  }
}

async function main() {
  ensureDir(OUT);
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
      errors.push({ channel: prefix.toLowerCase(), error: prefix + '_STORAGE_STATE invalid: ' + stored.__error });
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
    // launch failure
    errors.push({ channel: 'airbnb', error: air.error, hint: air.hint });
  }
  const book = await runChannel(wantBooking, 'BOOKING', pullBooking);
  if (book && book.error && !book.ok) {
    errors.push({ channel: 'booking', error: book.error, hint: book.hint });
  }

  // If Chromium itself failed for every channel
  if ((wantAirbnb && air && air.error && !wantBooking) || (wantBooking && book && book.error && !wantAirbnb)) {
    const fail = air && air.error ? air : book;
    console.log(JSON.stringify(fail));
    process.exit(1);
  }
  if (wantAirbnb && wantBooking && air && air.error && book && book.error && !files.length) {
    console.log(JSON.stringify({ ok: false, error: air.error || book.error, hint: air.hint || book.hint, errors }));
    process.exit(1);
  }

  const result = { ok: files.length > 0, month: MONTH, out: OUT, files, errors };
  console.log(JSON.stringify(result, null, 0));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
