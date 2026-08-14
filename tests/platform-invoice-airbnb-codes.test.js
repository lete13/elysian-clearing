'use strict';
/**
 * Airbnb Hosthub reservation-code pull (VAT Invoicer-style) — static checks.
 * Does not hit Airbnb; asserts worker + patch wiring.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');
const srv29 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-29.json'), 'utf8'));
const fe49 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-49.json'), 'utf8'));
const srv30 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-30.json'), 'utf8'));
const fe50 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-50.json'), 'utf8'));

assert(worker.includes('PI_AIRBNB_RESERVATIONS_JSON'), 'worker reads Hosthub codes env');
assert(worker.includes('loadAirbnbReservations'), 'worker has Hosthub code loader');
assert(worker.includes('hosting/reservations/details/'), 'opens Airbnb reservation by code');
assert(worker.includes("event: 'progress'"), 'worker emits per-code progress for the in-app Pull poll');
assert(worker.includes('No Hosthub Airbnb reservation codes provided'), 'fails closed without codes');
assert(worker.includes('function extractAirbnbVatInvoiceHits'), 'searches reservation HTML for VAT invoice IDs');
assert(worker.includes('reservation/vat_invoice/'), 'opens Airbnb VAT invoice HTML page from the ID');
assert(worker.includes('looksLikeAirbnbInvoiceHtml'), 'will not PDF the reservation details shell');
assert(worker.includes('PI_AIRBNB_LIMIT'), 'Test pull can slice codes');
assert(worker.includes('ids/urls found:'), '0-PDF error says what was searched');
assert(!/hrefs\.length/.test(worker) || worker.indexOf('loadAirbnbReservations') < worker.indexOf('pullAirbnb'), 'Hosthub-driven path present');

const fe88 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-88.json'), 'utf8'));
const srv63 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-63.json'), 'utf8'));
assert(fe88.patches.some((p) => (p.replace || '').includes('Test pull (5 codes)')), 'FE gold button is Test pull');
assert(fe88.patches.some((p) => (p.replace || '').includes('Pull Airbnb (Hosthub codes)')), 'FE keeps full Pull label');
assert(fe88.patches.some((p) => (p.replace || '').includes('Do not auto-run Pull')), 'FE stops unlimited auto-pull');
assert(srv63.patches.some((p) => (p.replace || '').includes('PI_AIRBNB_LIMIT')), 'API passes limit to worker');

function extractBetween(source, startName, nextName) {
  const start = source.indexOf('function ' + startName + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start);
  assert(start >= 0 && end > start, 'missing ' + startName + ' .. ' + nextName);
  return source.slice(start, end);
}
const vm = require('vm');
const extractSrc =
  extractBetween(worker, 'kindFromInvoiceBlob', 'airbnbInvoicePagePatterns') +
  extractBetween(worker, 'airbnbInvoiceUrlsForHit', 'looksLikeAirbnbInvoiceHtml');
const helpers = vm.runInNewContext(extractSrc + '\n({ extractAirbnbVatInvoiceHits, airbnbInvoiceUrlsForHit })', {
  URL: URL,
  encodeURIComponent: encodeURIComponent,
});
const html = '<script>{"vatInvoiceId":"INV99ABC","vatInvoice":{"id":"INV99ABC","url":"https://www.airbnb.com/reservation/vat_invoice/INV99ABC"}}</script>';
const hits = helpers.extractAirbnbVatInvoiceHits(html, 'https://www.airbnb.com');
assert(hits.some((h) => h.id === 'INV99ABC'), 'extracts vatInvoiceId from reservation JSON');
assert(hits.some((h) => String(h.href || '').indexOf('/reservation/vat_invoice/INV99ABC') >= 0), 'extracts VAT invoice HTML URL');
const urls = helpers.airbnbInvoiceUrlsForHit({ kind: 'invoice', id: 'INV99ABC', href: '' }, 'https://www.airbnb.com', []);
assert(urls.some((u) => u.indexOf('/reservation/vat_invoice/INV99ABC') >= 0), 'builds Airbnb VAT invoice HTML URL from ID');

assert(srv29.patches.some((p) => p.replace.includes("reservationId:ev.reservation_id||''")), 'sync maps reservation_id');
assert(srv29.patches.some((p) => p.replace.includes('PI_AIRBNB_RESERVATIONS_JSON')), 'API passes codes to worker');

assert(fe49.patches.some((p) => (p.replace || '').includes('piAirExpectList')), 'FE builds expect from Hosthub');
assert(fe49.patches.some((p) => (p.replace || '').includes("channel: 'airbnb'")), 'FE pulls Airbnb only');
assert(fe49.patches.some((p) => (p.replace || '').includes('airbnbReservations')), 'FE posts codes');
assert(srv30.patches.some((p) => (p.replace || '').includes('piResolveAirbnbReservations')), 'server resolves codes');
assert(fe50.patches.some((p) => (p.replace || '').includes('/api/platform-invoices/airbnb-codes')), 'FE backfills via airbnb-codes');

// Simulate Hosthub → Airbnb code filter (mirrors FE dating rules)
function ymFromTs(t) {
  if (t == null || t === '') return '';
  let n = Number(t);
  if (!isFinite(n)) {
    const s = String(t);
    return s.length >= 7 ? s.slice(0, 7) : '';
  }
  if (n < 1e12) n *= 1000;
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function airExpect(month, bks) {
  const inv = [], credit = [];
  bks.forEach((b) => {
    if (String(b.platform || '').toLowerCase().indexOf('air') < 0) return;
    const createdYm = ymFromTs(b.createdOnChannel != null ? b.createdOnChannel : b.created);
    const cancelYm = ymFromTs(b.cancelledAt);
    const code = String(b.reservationId || '').trim().toUpperCase();
    if (createdYm === month && code) inv.push({ code, kind: 'invoice' });
    if (b.cancelled && cancelYm === month && code) credit.push({ code, kind: 'credit_note' });
  });
  return { inv, credit };
}

const sample = [
  { platform: 'Airbnb', reservationId: 'HMABCDEF', createdOnChannel: 1722470400, created: 1722470400 }, // 2024-08
  { platform: 'Airbnb', reservationId: 'HMCANCEL1', createdOnChannel: 1719792000, cancelled: true, cancelledAt: 1722470400 },
  { platform: 'Booking.com', reservationId: '1234567890', createdOnChannel: 1722470400 },
  { platform: 'Airbnb', reservationId: '', createdOnChannel: 1722470400 },
];
const exp = airExpect('2024-08', sample);
assert.strictEqual(exp.inv.length, 1);
assert.strictEqual(exp.inv[0].code, 'HMABCDEF');
assert.strictEqual(exp.credit.length, 1);
assert.strictEqual(exp.credit[0].code, 'HMCANCEL1');

// Code regex used by worker
const re = /^[A-Z0-9]{6,20}$/;
assert(re.test('HMABCDEF'));
assert(re.test('AB67782136778'));
assert(!re.test('short'));
assert(!re.test('HAS SPACE'));

console.log('platform-invoice-airbnb-codes.test.js: ok');
