#!/usr/bin/env node
'use strict';
/**
 * Harvest Booking.com hotel_id from each apartment's public listing URL
 * (S.apts.bookingUrl). Headed Chrome only — not HeadlessChrome, not password
 * Sign-in, not the Extranet. Filing still uses bookingHotelId only.
 *
 * Usage:
 *   node scripts/platform-invoice-booking-ids.js --from-json apts.json --out harvested.json
 * JSON is [{id,name,bookingUrl,clearGroup}] or a full /api/db/data payload.
 */
const fs = require('fs');
const path = require('path');
const booking = require('./platform-invoice-booking');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function loadApts(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.apts || (raw.data && raw.data.apts) || [];
  return list.filter(Boolean).map(function (a) {
    return {
      id: String(a.id || a.aptId || '').trim(),
      name: String(a.name || a.aptName || '').trim(),
      clearGroup: String(a.clearGroup || '').trim(),
      bookingUrl: String(a.bookingUrl || '').trim(),
      bookingHotelId: booking.normalizeHotelId(a.bookingHotelId),
    };
  });
}

function looksLikeWaf(html, url) {
  const s = String(html || '') + ' ' + String(url || '');
  return /challenge-container|AwsWafIntegration|verify that you.re not a robot/i.test(s);
}

async function launchBookingChrome() {
  const { chromium } = require('playwright');
  const launchOpts = {
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1440,900',
    ],
  };
  let browser;
  try {
    browser = await chromium.launch(Object.assign({}, launchOpts, { channel: 'chrome' }));
  } catch (e0) {
    browser = await chromium.launch(launchOpts);
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-GB',
    timezoneId: 'Europe/Athens',
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9,el;q=0.8' },
  });
  await context.addInitScript(function () {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  const ua = await page.evaluate(function () { return navigator.userAgent; }).catch(function () { return ''; });
  if (/HeadlessChrome/i.test(ua)) {
    await browser.close().catch(function () {});
    throw new Error('Booking.com listing harvest needs headed Chrome. HeadlessChrome is blocked.');
  }
  return { browser: browser, context: context, page: page, ua: ua };
}

async function harvestOne(page, url) {
  const out = { url: url, hotelId: '', finalUrl: '', error: '' };
  if (!url) return out;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);
    let html = await page.content();
    out.finalUrl = page.url();
    if (looksLikeWaf(html, out.finalUrl)) {
      await page.waitForTimeout(4000);
      html = await page.content();
      out.finalUrl = page.url();
    }
    if (looksLikeWaf(html, out.finalUrl) && !booking.extractBookingHotelIdFromHtml(html, out.finalUrl)) {
      out.error = 'waf-challenge';
      return out;
    }
    out.hotelId = booking.extractBookingHotelIdFromHtml(html, out.finalUrl);
    if (!out.hotelId) {
      out.hotelId = await page
        .locator('input[name="hotel_id"]')
        .first()
        .getAttribute('value')
        .catch(function () { return ''; });
      out.hotelId = booking.normalizeHotelId(out.hotelId);
    }
    if (!out.hotelId) out.error = 'no-hotel-id';
  } catch (e) {
    out.error = e.message || String(e);
  }
  return out;
}

async function main() {
  const from = arg('--from-json', '');
  const outFile = arg('--out', path.join('/tmp', 'booking-hotel-ids.json'));
  if (!from) {
    console.error('Need --from-json apts.json');
    process.exit(2);
  }
  const apts = loadApts(from);
  const withUrl = apts.filter(function (a) { return /^https?:\/\/([^/]*\.)?booking\.com\//i.test(a.bookingUrl); });
  console.log('apts', apts.length, 'with bookingUrl', withUrl.length, 'ua-check launching headed Chrome');
  const session = await launchBookingChrome();
  console.log('browser ua', session.ua);
  const harvested = [];
  try {
    for (let i = 0; i < withUrl.length; i++) {
      const a = withUrl[i];
      const row = await harvestOne(session.page, a.bookingUrl);
      const rec = {
        aptId: a.id,
        aptName: a.name,
        clearGroup: a.clearGroup,
        bookingUrl: a.bookingUrl,
        finalUrl: row.finalUrl,
        bookingHotelId: row.hotelId,
        error: row.error,
      };
      harvested.push(rec);
      console.log(
        String(i + 1) + '/' + withUrl.length,
        rec.bookingHotelId || rec.error || 'empty',
        a.name
      );
      await session.page.waitForTimeout(1200);
    }
  } finally {
    await session.browser.close().catch(function () {});
  }
  const applied = booking.applyHarvestedBookingHotelIds(apts, harvested);
  const payload = {
    harvested: harvested,
    applied: applied.applied,
    mapped: applied.map.mapped,
    total: applied.map.total,
    unmapped: applied.map.unmapped,
    issues: applied.issues,
    rows: applied.map.rows,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log('wrote', outFile, 'mapped', payload.mapped + '/' + payload.total);
  if (payload.issues.votsalaMismatch) console.log('Votsala mismatch', payload.issues.votsalaIds);
  if (payload.issues.duplicates && payload.issues.duplicates.length) {
    console.log('duplicate ids', JSON.stringify(payload.issues.duplicates));
  }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
