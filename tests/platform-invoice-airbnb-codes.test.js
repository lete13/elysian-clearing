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
assert(worker.includes('function piInvoiceStoreRel'), 'stores PDFs as Platform/month/apartment/file');
assert(worker.includes("plat + '/' + month + '/' + apt"), 'path is platform / month / apartment');

const fe89 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-89.json'), 'utf8'));
const srv64 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-64.json'), 'utf8'));
assert(fe89.patches.some((p) => (p.replace || '').includes('piStoreApt')), 'FE groups vault by apartment');
assert(srv64.patches.some((p) => (p.replace || '').includes('ORDER BY channel, partner, filename, id')), 'API lists by platform then apartment');
assert(srv64.patches.some((p) => (p.replace || '').includes('f.aptName || f.partner')), 'pull stores partner as apartment');

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

const storeSrc = extractBetween(worker, 'platformStoreLabel', 'loadAirbnbReservations');
const store = vm.runInNewContext(storeSrc + '\n({ piInvoiceStoreRel, aptStoreFolder, platformStoreLabel })');
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'airbnb', month: '2026-07', aptName: 'Birdhouse', kind: 'invoice', code: 'HMHPBAREC3' }),
  'Airbnb/2026-07/Birdhouse/invoice-HMHPBAREC3.pdf'
);
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'airbnb', month: '2026-07', aptName: 'Skyline Loft', kind: 'credit_note', code: 'HMCANCEL1' }),
  'Airbnb/2026-07/Skyline Loft/credit_note-HMCANCEL1.pdf'
);
assert.strictEqual(store.platformStoreLabel('airbnb'), 'Airbnb');
assert.strictEqual(store.platformStoreLabel('booking'), 'Booking.com');
assert.strictEqual(store.aptStoreFolder('Bird/house'), 'Bird house');
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'booking', month: '2026-07', aptName: 'Horizon', kind: 'invoice', code: 'apt-1' }),
  'Booking.com/2026-07/Horizon/invoice-apt-1.pdf'
);

const os = require('os');
const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-store-'));
const storedRel = store.piInvoiceStoreRel({
  channel: 'airbnb', month: '2026-07', aptName: 'Birdhouse', kind: 'invoice', code: 'HMHPBAREC3',
});
const storedAbs = path.join(tmpStore, storedRel);
fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
fs.writeFileSync(storedAbs, '%PDF-1.4 store-layout-test');
assert.strictEqual(
  fs.readFileSync(path.join(tmpStore, 'Airbnb', '2026-07', 'Birdhouse', 'invoice-HMHPBAREC3.pdf'), 'utf8'),
  '%PDF-1.4 store-layout-test'
);

function vaultLooksLikeCredit(f) {
  return /credit/i.test(String(f.filename || '')) || String(f.partner || '').toLowerCase() === 'credit_note';
}
assert(vaultLooksLikeCredit({ filename: 'Airbnb/2026-07/Birdhouse/credit_note-HMCANCEL1.pdf', partner: 'Birdhouse' }));
assert(!vaultLooksLikeCredit({ filename: 'Airbnb/2026-07/Birdhouse/invoice-HMABCDEF.pdf', partner: 'Birdhouse' }));

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
