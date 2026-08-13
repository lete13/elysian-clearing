#!/usr/bin/env node
/**
 * One-time headed login → save Playwright storageState for automated Pull.
 *
 * Usage (laptop with a display):
 *   AIRBNB_HOST_EMAIL=… AIRBNB_HOST_PASSWORD=… \
 *     node scripts/platform-invoice-save-session.js --channel=airbnb --headed
 *
 *   BOOKING_HOST_EMAIL='Login name' BOOKING_HOST_PASSWORD=… \
 *     node scripts/platform-invoice-save-session.js --channel=booking --headed
 *
 * Complete captcha / OTP in the browser. When you reach the host home,
 * press Enter. The script prints *_STORAGE_STATE_B64 and can POST it to
 * production so Pull never needs manual PDF upload:
 *
 *   PI_SESSION_POST_URL=https://…/api/platform-invoices/sessions/booking \
 *   PI_SESSION_POST_COOKIE='elysian_session=…' \
 *     node scripts/platform-invoice-save-session.js --channel=booking --headed
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

const CHANNEL = String(arg('channel', '')).toLowerCase();
const OUT = arg('out', '');
const HEADED = flag('headed') || true;

if (CHANNEL !== 'airbnb' && CHANNEL !== 'booking') {
  console.error('Usage: --channel=airbnb|booking [--out=state.json]');
  process.exit(2);
}

function postJson(urlStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: buf });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  if (CHANNEL === 'booking') {
    await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded' });
    console.error('Complete Booking.com extranet login (captcha if shown).');
    console.error('When you see the property / Finance area on admin.booking.com, return here.');
  } else {
    await page.goto('https://www.airbnb.com/login', { waitUntil: 'domcontentloaded' });
    console.error('Complete Airbnb host login (OTP if shown).');
    console.error('When you see Hosting → Reservations, return here.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await new Promise((resolve) =>
    rl.question('Press Enter when logged in… ', () => {
      rl.close();
      resolve();
    })
  );

  const state = await context.storageState();
  const json = JSON.stringify(state);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const key = CHANNEL === 'booking' ? 'BOOKING_STORAGE_STATE_B64' : 'AIRBNB_STORAGE_STATE_B64';

  if (OUT) {
    fs.writeFileSync(OUT, json);
    console.error('Wrote', path.resolve(OUT));
  }

  console.log(key + '=' + b64);

  const postUrl =
    process.env.PI_SESSION_POST_URL ||
    (process.env.PI_APP_URL
      ? String(process.env.PI_APP_URL).replace(/\/$/, '') + '/api/platform-invoices/sessions/' + CHANNEL
      : '');
  const cookie = process.env.PI_SESSION_POST_COOKIE || '';
  if (postUrl) {
    try {
      const r = await postJson(postUrl, { storageState: state, storageStateB64: b64 }, cookie);
      console.error('Posted session to', postUrl, '→ HTTP', r.status, r.body.slice(0, 200));
    } catch (e) {
      console.error('Failed to POST session:', e.message);
    }
  } else {
    console.error('\nOptional: set PI_APP_URL + PI_SESSION_POST_COOKIE to push this session into the app vault.');
    console.error('Or paste the session JSON under Platform Invoices → Connect ' + (CHANNEL === 'booking' ? 'Booking' : 'Airbnb') + '.');
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
