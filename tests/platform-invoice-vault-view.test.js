'use strict';
/**
 * Vault view: POST a PDF then GET /api/platform-invoices/:id/file.
 * Uses in-memory store (no Postgres). Does not hit Airbnb.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = parseInt(process.env.PI_VAULT_TEST_PORT || '18777', 10);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function req(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function waitHealth() {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < 25000) {
    try {
      const h = await req('GET', '/health');
      if (h.status === 200) return;
      last = h.body.toString();
    } catch (e) {
      last = e.message;
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error('server did not become healthy: ' + last);
}

(async function main() {
  let started = false;
  try {
    const h = await req('GET', '/health');
    if (h.status === 200) started = false;
    else throw new Error('not up');
  } catch (e) {
    const env = Object.assign({}, process.env, {
      PORT: String(PORT),
      APP_PASSWORD: '',
      USERS_JSON: '',
    });
    delete env.DATABASE_URL;
    delete env.POSTGRES_URL;
    delete env.PGDATABASE_URL;
    delete env.PGHOST;
    delete env.SRVBOOT_DRYRUN;
    spawn(process.execPath, ['srv-boot.js'], {
      cwd: root,
      env,
      stdio: 'ignore',
      detached: true,
    }).unref();
    started = true;
  }
  await waitHealth();

  const post = await req(
    'POST',
    '/api/platform-invoices',
    JSON.stringify({
      month: '2026-07',
      channel: 'airbnb',
      scope: 'leased',
      partner: 'Birdhouse',
      name: 'Airbnb/2026-07/Birdhouse/invoice-HMTEST01.pdf',
      mime: 'application/pdf',
      size: pdf.length,
      source: 'portal',
      dataB64: pdf.toString('base64'),
    }),
    { 'Content-Type': 'application/json' }
  );
  assert.strictEqual(post.status, 200, 'POST vault PDF: ' + post.body.toString().slice(0, 240));
  const saved = JSON.parse(post.body.toString());
  assert(saved.id, 'POST returns id');

  const list = await req('GET', '/api/platform-invoices?month=2026-07');
  assert.strictEqual(list.status, 200, list.body.toString().slice(0, 240));
  const listed = JSON.parse(list.body.toString());
  assert(
    (listed.items || []).some((x) => String(x.partner) === 'Birdhouse' && String(x.id) === String(saved.id)),
    'list includes apartment Birdhouse'
  );

  const postAug = await req(
    'POST',
    '/api/platform-invoices',
    JSON.stringify({
      month: '2026-08',
      channel: 'booking',
      scope: 'leased',
      partner: 'Coloneum',
      name: 'Booking.com/2026-08/Coloneum/invoice-bdc.pdf',
      mime: 'application/pdf',
      size: pdf.length,
      source: 'portal',
      dataB64: pdf.toString('base64'),
    }),
    { 'Content-Type': 'application/json' }
  );
  assert.strictEqual(postAug.status, 200, 'POST August PDF: ' + postAug.body.toString().slice(0, 240));
  const savedAug = JSON.parse(postAug.body.toString());

  const all = await req('GET', '/api/platform-invoices');
  assert.strictEqual(all.status, 200, 'GET all vault: ' + all.body.toString().slice(0, 240));
  const allListed = JSON.parse(all.body.toString());
  assert.strictEqual(allListed.month, 'all', 'no-month list is the whole vault');
  assert(
    (allListed.items || []).some((x) => String(x.id) === String(saved.id)) &&
      (allListed.items || []).some((x) => String(x.id) === String(savedAug.id)),
    'all-vault list includes both apartment folders / months'
  );
  const bad = await req('GET', '/api/platform-invoices?month=nope');
  assert.strictEqual(bad.status, 400, 'invalid month still rejected');

  const file = await req('GET', '/api/platform-invoices/' + saved.id + '/file');
  assert.strictEqual(file.status, 200, 'GET file: ' + file.body.toString().slice(0, 240));
  assert(/pdf/i.test(String(file.headers['content-type'] || '')), 'content-type is PDF');
  assert.strictEqual(file.body.slice(0, 5).toString(), '%PDF-');
  console.log('platform-invoice-vault-view.test.js: ok' + (started ? ' (started local server)' : ' (reused server)'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
