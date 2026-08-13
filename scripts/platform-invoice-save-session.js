#!/usr/bin/env node
/**
 * One-time headed login → save Playwright storageState for Railway.
 *
 * Usage (on your laptop, with a display):
 *   AIRBNB_HOST_EMAIL=… AIRBNB_HOST_PASSWORD=… \
 *     node scripts/platform-invoice-save-session.js --channel=airbnb --headed
 *
 *   BOOKING_HOST_EMAIL='Login name' BOOKING_HOST_PASSWORD=… \
 *     node scripts/platform-invoice-save-session.js --channel=booking --headed
 *
 * Complete any captcha / OTP in the browser window. When you reach the
 * host home (Airbnb hosting or admin.booking.com extranet), press Enter
 * here. The script prints *_STORAGE_STATE_B64=… to paste into Railway.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

const CHANNEL = String(arg('channel', '')).toLowerCase();
const OUT = arg('out', '');
const HEADED = flag('headed') || true; // default headed — that's the point

if (CHANNEL !== 'airbnb' && CHANNEL !== 'booking') {
  console.error('Usage: --channel=airbnb|booking [--out=state.json]');
  process.exit(2);
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
  await new Promise((resolve) => rl.question('Press Enter when logged in… ', () => { rl.close(); resolve(); }));

  const state = await context.storageState();
  const json = JSON.stringify(state);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const key = CHANNEL === 'booking' ? 'BOOKING_STORAGE_STATE_B64' : 'AIRBNB_STORAGE_STATE_B64';

  if (OUT) {
    fs.writeFileSync(OUT, json);
    console.error('Wrote', path.resolve(OUT));
  }

  console.log(key + '=' + b64);
  console.error('\nPaste the line above into Railway Variables, then retry Pull from portals.');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
