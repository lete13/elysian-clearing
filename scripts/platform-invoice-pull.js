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

async function withBrowser(fn) {
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
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    return await fn(page, context);
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
  if (!email || !pass) {
    errors.push({ channel: 'airbnb', error: 'AIRBNB_HOST_EMAIL / AIRBNB_HOST_PASSWORD not set' });
    return;
  }
  const dir = path.join(outDir, 'airbnb');
  ensureDir(dir);

  try {
    await page.goto('https://www.airbnb.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Cookie / region banners
    for (const sel of ['button:has-text("Accept")', 'button:has-text("OK")', '[data-testid="accept-btn"]']) {
      const b = page.locator(sel).first();
      if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
    }

    // Prefer email login path
    const emailBtn = page.locator('button:has-text("Continue with email"), a:has-text("Continue with email"), button:has-text("Email")').first();
    if (await emailBtn.count()) await emailBtn.click().catch(() => {});

    const emailInput = page.locator('input[name="email"], input[type="email"], input[autocomplete="username"]').first();
    await emailInput.waitFor({ timeout: 20000 });
    await emailInput.fill(email);
    const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
    if (await continueBtn.count()) await continueBtn.click().catch(() => {});

    const passInput = page.locator('input[name="password"], input[type="password"]').first();
    await passInput.waitFor({ timeout: 20000 });
    await passInput.fill(pass);
    await page.locator('button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]').first().click();
    await page.waitForTimeout(4000);

    // MFA / captcha detection
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/verif|two-factor|authenticator|captcha|unusual activity/i.test(bodyText)) {
      errors.push({
        channel: 'airbnb',
        error: 'Login needs manual verification (MFA/captcha). Use headed mode once or unlock the host account.',
      });
      await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
      return;
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
  if (!email || !pass) {
    errors.push({ channel: 'booking', error: 'BOOKING_HOST_EMAIL / BOOKING_HOST_PASSWORD not set' });
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
    // Canonical partner extranet entry (not the consumer site)
    await page.goto('https://admin.booking.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1500);

    // Cookie banners
    for (const sel of [
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      '#onetrust-accept-btn-handler',
    ]) {
      const b = page.locator(sel).first();
      if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
    }

    // Username / email (Booking often uses "loginname")
    const emailInput = page
      .locator(
        'input[name="loginname"], input[name="username"], input[type="email"], input[autocomplete="username"], #loginname'
      )
      .first();
    await emailInput.waitFor({ timeout: 25000 });
    await emailInput.fill(email);
    const next = page
      .locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]')
      .first();
    if (await next.count()) await next.click().catch(() => {});
    await page.waitForTimeout(1200);

    const passInput = page.locator('input[name="password"], input[type="password"], #password').first();
    await passInput.waitFor({ timeout: 20000 });
    await passInput.fill(pass);
    await page
      .locator(
        'button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Sign In"), button[type="submit"]'
      )
      .first()
      .click();
    await page.waitForTimeout(5000);

    // If account.booking.com SSO, wait until we are back on admin.booking.com
    for (let i = 0; i < 20; i++) {
      const url = page.url();
      if (onAdminExtranet(url) || (url.includes('admin.booking.com') && !/login|sign-in/i.test(url))) break;
      if (/verif|two-factor|authenticator|captcha|challenge/i.test(await page.locator('body').innerText().catch(() => ''))) {
        errors.push({
          channel: 'booking',
          error: 'Login needs manual verification (MFA/captcha) on admin.booking.com.',
        });
        await page.screenshot({ path: path.join(dir, '_login-blocked.png'), fullPage: true }).catch(() => {});
        return;
      }
      await page.waitForTimeout(1000);
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

  const result = await withBrowser(async (page, context) => {
    if (wantAirbnb) await pullAirbnb(page, context, MONTH, OUT, files, errors);
    if (wantBooking) {
      // Fresh page reduces Airbnb session bleed into Booking
      const p2 = await context.newPage();
      await pullBooking(p2, context, MONTH, OUT, files, errors);
      await p2.close().catch(() => {});
    }
    return { ok: files.length > 0, month: MONTH, out: OUT, files, errors };
  });

  if (result && result.error && !result.files) {
    console.log(JSON.stringify(result));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 0));
  process.exit(result && result.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
