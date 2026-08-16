'use strict';
/**
 * Booking.com IP-block cooldown — shared Connect/Pull helpers (no live Booking.com).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const block = require(path.join(root, 'scripts', 'platform-invoice-booking-block'));
const worker = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');

assert.strictEqual(block.BLOCK_KEY, 'pi_booking_block');
assert.strictEqual(block.looksBlockedText('Sign-in failed. Please try again later.'), true);
assert.strictEqual(block.looksBlockedText('Sign in to manage your property'), false);
assert.strictEqual(block.looksBlockedText('Username Also known as Login name'), false);
assert.strictEqual(block.looksBlockedText("Let's make sure you're human"), false);
assert.strictEqual(block.looksHumanCheckText("Let's make sure you're human"), true);
assert.strictEqual(block.looksBlockedStatus(403), true);
assert.strictEqual(block.looksBlockedStatus(429), true);
assert.strictEqual(block.looksBlockedStatus(200), false);
assert.strictEqual(block.looksBlockedStatus(503), false);
assert.strictEqual(block.looksBlockedPage({ text: '', status: 429 }), true);
assert.strictEqual(block.looksBlockedPage({ text: 'Try again later', status: 200 }), true);
assert.strictEqual(block.looksBlockedPage({ text: 'Welcome', status: 200 }), false);

const parsed = block.parseBlockData(JSON.stringify({ until: Date.now() + 60000, reason: 'x' }));
assert(block.isActive(parsed));
assert(!block.isActive({ until: Date.now() - 1000 }));
assert.strictEqual(block.parseBlockData('1700000000000').until, 1700000000000);

const proxyAuth = block.parsePlaywrightProxy('http://user:p%40ss@proxy.example:8000');
assert.deepStrictEqual(proxyAuth, {
  server: 'http://proxy.example:8000',
  username: 'user',
  password: 'p@ss',
});
assert.deepStrictEqual(block.parsePlaywrightProxy('http://proxy.example:8000'), {
  server: 'http://proxy.example:8000',
});
assert.strictEqual(block.parsePlaywrightProxy(''), null);

const mem = {};
const pool = {
  query: async function (sql, params) {
    if (/SELECT/.test(sql)) {
      const v = mem[params[0]];
      return { rows: v ? [{ data: v }] : [] };
    }
    if (/INSERT/.test(sql)) {
      mem[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (/DELETE/.test(sql)) {
      delete mem[params[0]];
      return { rows: [] };
    }
    throw new Error('unexpected sql');
  },
};

(async function () {
  const prev = process.env.BOOKING_CONNECT_COOLDOWN_MS;
  process.env.BOOKING_CONNECT_COOLDOWN_MS = '3600000';
  const row = await block.markBlocked(pool, { source: 'test', status: 429, reason: 'Try again later' });
  assert.strictEqual(mem[block.BLOCK_KEY].source, 'test');
  assert.strictEqual(mem[block.BLOCK_KEY].status, 429);
  assert(row.until > Date.now());
  const replica = await block.readBlocked(pool);
  assert.strictEqual(replica.until, row.until, 'replicas read the same Postgres row');
  assert(block.isActive(replica));
  await block.clearBlocked(pool);
  assert.strictEqual(await block.readBlocked(pool), null);
  if (prev == null) delete process.env.BOOKING_CONNECT_COOLDOWN_MS;
  else process.env.BOOKING_CONNECT_COOLDOWN_MS = prev;

  const watch = block.attachPageWatch({
    on: function (ev, fn) {
      assert.strictEqual(ev, 'response');
      fn({
        url: function () { return 'https://account.booking.com/sign-in'; },
        status: function () { return 403; },
        request: function () { return { resourceType: function () { return 'document'; } }; },
      });
    },
  });
  assert.strictEqual(watch.blockedHttp, true);
  assert.strictEqual(watch.lastStatus, 403);

  const imgWatch = block.attachPageWatch({
    on: function (ev, fn) {
      fn({
        url: function () { return 'https://q.bstatic.com/x.png'; },
        status: function () { return 403; },
        request: function () { return { resourceType: function () { return 'image'; } }; },
      });
    },
  });
  assert.strictEqual(imgWatch.blockedHttp, false, 'static 403 is not a login block');

  assert.strictEqual(block.cooldownMs(), 4 * 60 * 60 * 1000);
})().then(function () {
  assert(worker.includes("require('./platform-invoice-booking-block')"), 'worker uses shared block helpers');
  assert(worker.includes('bookingDetectBlock'), 'worker detects a Booking.com block');
  assert(worker.includes('Do not password-login from this server IP'), 'expired session does not password-login');
  assert(worker.includes("kind: prefix.toLowerCase()"), 'Pull passes channel kind into the browser');
  assert(worker.includes('headless: bookingKind ? false'), 'Booking Pull is headed');
  assert(worker.includes("if (!bookingKind)"), 'Chrome/122 spoof is Airbnb-only');
  assert(worker.includes('HeadlessChrome is blocked'), 'Booking Pull refuses HeadlessChrome');
  assert(worker.includes('bookingEnsureDisplay'), 'Booking Pull starts Xvfb');
  assert(worker.includes("ignoreDefaultArgs = ['--enable-automation']"), 'Booking Pull drops automation flag');
  const uaIdx = worker.indexOf("Chrome/122.0.0.0 Safari/537.36");
  const gateIdx = worker.indexOf('if (!bookingKind)');
  assert(uaIdx > gateIdx && gateIdx >= 0, 'Mac Chrome/122 user-agent is behind the Airbnb-only gate');
  assert(worker.includes('blockedNow'), 'password login checks the cooldown');
  console.log('platform-invoice-booking-block.test.js: ok');
}).catch(function (e) {
  console.error(e);
  process.exit(1);
});
