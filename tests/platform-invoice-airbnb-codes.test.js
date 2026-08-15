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
assert(worker.includes('listAirbnbVatDocHrefs'), 'collects every VAT invoice/credit note href on the stay');
assert(worker.includes('vatIdFromAirbnbUrl'), 'names PDFs with the Airbnb VAT document id');
assert(worker.includes("kind: 'both'"), 'pull treats each stay as all related invoices');
assert(worker.includes('mergeListedHrefs'), 'keeps collecting VAT hrefs after each debit/credit open');
assert(worker.includes('airbnbReservationPageIsOpen'), 'does not treat a missing stay URL as opened');
assert(worker.includes('PI_AIRBNB_LIMIT'), 'Test pull can slice codes');
assert(worker.includes('ids/urls found:'), '0-PDF error says what was searched');
assert(!/hrefs\.length/.test(worker) || worker.indexOf('loadAirbnbReservations') < worker.indexOf('pullAirbnb'), 'Hosthub-driven path present');

const fe88 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-88.json'), 'utf8'));
const srv63 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-63.json'), 'utf8'));
assert(worker.includes('function piInvoiceStoreRel'), 'stores PDFs as Platform/month/apartment/file');
assert(worker.includes("plat + '/' + month + '/' + apt"), 'path is platform / month / apartment');

const fe90 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-90.json'), 'utf8'));
const srv64 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-64.json'), 'utf8'));
assert(fe90.patches.some((p) => (p.replace || '').includes('piStoreApt')), 'FE groups vault by apartment');
assert(srv64.patches.some((p) => (p.replace || '').includes('ORDER BY channel, partner, filename, id')), 'API lists by platform then apartment');
assert(srv64.patches.some((p) => (p.replace || '').includes('f.aptName || f.partner')), 'pull stores partner as apartment');
assert(worker.includes('function requestPullStop'), 'worker can stop mid-queue');
assert(worker.includes("process.on('SIGTERM'"), 'SIGTERM dumps PDFs already captured');
const fe91 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-91.json'), 'utf8'));
const srv65 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-65.json'), 'utf8'));
assert(fe91.patches.some((p) => (p.replace || '').includes('piStopPull')), 'Collect has Stop pull');
assert(srv65.patches.some((p) => (p.replace || '').includes("app.post('/api/platform-invoices/pull-stop'")), 'API stops running pull jobs');
const fe92 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-92.json'), 'utf8'));
const srv66 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-66.json'), 'utf8'));
assert(worker.includes('hosting/stay/'), 'opens Airbnb stay reservation page');
assert(worker.includes('sortAirbnbReservationsLatest'), 'test pull sorts latest Hosthub ids');
assert(worker.includes('collectAirbnbInvoiceHits'), 're-scans stay page for VAT invoice IDs');
assert(worker.includes('clickAirbnbStayTotalPrice'), 'Help 438: click total price');
assert(worker.includes('settleAirbnbHostPage'), 'waits for stay-page GraphQL');
assert(worker.includes('airbnbPortalOrigin'), 'fixture origin override for local stay-click tests');

const fe96 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-96.json'), 'utf8'));
const srv67 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-67.json'), 'utf8'));
assert(fe96.patches.some((p) => (p.replace || '').includes('Test pull: latest ')), 'FE test pull is latest N');
assert(fe96.patches.some((p) => (p.replace || '').includes('createdOnChannel')), 'FE posts Hosthub created dates');
assert(srv67.patches.some((p) => (p.replace || '').includes('piSortAirbnbReservationsLatest')), 'server sorts latest before limit');
const fe98 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-98.json'), 'utf8'));
const srv68 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-68.json'), 'utf8'));
assert(fe98.patches.some((p) => (p.replace || '').includes('PDFs by apartment')), 'Collect vault heading is PDFs by apartment');
assert(fe98.patches.some((p) => (p.replace || '').includes("/api/platform-invoices/' + id + '/file")), 'vault rows Open the PDF');
assert(srv68.patches.some((p) => (p.replace || '').includes("app.get('/api/platform-invoices/:id/file'")), 'API serves PDF bytes');
const fe104 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-104.json'), 'utf8'));
const srv70 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-70.json'), 'utf8'));
assert(fe104.patches.some((p) => (p.replace || '').includes('already saved codes are skipped')), 'FE resume copy');
assert(srv70.patches.some((p) => (p.replace || '').includes('PI_AIRBNB_HAVE_JSON')), 'retry skips vaulted codes');
assert(srv70.patches.some((p) => (p.replace || '').includes('4 * 60 * 60 * 1000')), '4h pull budget');
assert(srv70.patches.some((p) => (p.replace || '').includes("j.event === 'progress' || j.event === 'saved'")), 'progress is not a result');
assert(worker.includes('function loadAirbnbHaveSet'), 'worker skips vaulted codes');
assert(worker.includes("event: 'saved'"), 'worker emits saved as each PDF lands');
assert(fe92.patches.some((p) => (p.replace || '').includes('no pull job with that id')), 'vanished job id is Pull stopped');
assert(srv66.patches.some((p) => (p.replace || '').includes("status: 'cancelled'")), 'missing job GET is cancelled');
const fe106 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-106.json'), 'utf8'));
const srv71 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-71.json'), 'utf8'));
const fe108 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-108.json'), 'utf8'));
const srv72 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-72.json'), 'utf8'));
assert(fe108.patches.some((p) => (p.replace || '').includes('Expect is which stays to open')), 'FE Expect is stays not PDF count');
assert(fe108.patches.some((p) => (p.replace || '').includes("kind: 'both'")), 'FE pull kind both');
assert(srv72.patches.some((p) => (p.replace || '').includes("kind: 'both'")), 'server pull kind both');
assert(srv72.patches.some((p) => (p.replace || '').includes('hosthubYm === month')), 'Hosthub created month opens stay');
const fe109 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-109.json'), 'utf8'));
const srv73 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-73.json'), 'utf8'));
assert(fe109.patches.some((p) => (p.replace || '').includes("piPull({ codes: ['HM9DCDMEXT','HMWRNAWHBA'] })")), 'FE test pull is the two missed stays');
assert(fe109.patches.some((p) => (p.replace || '').includes('Estimated invoices to pull')), 'FE Expect estimates invoices');
assert(fe109.patches.some((p) => (p.replace || '').includes('piDownloadAccountantXls')), 'FE downloads accountant Excel');
assert(srv73.patches.some((p) => (p.replace || '').includes('buildAccountantXls')), 'server attaches accountant Excel');
assert(srv73.patches.some((p) => (p.replace || '').includes('estimateAirbnbInvoices')), 'server Expect estimate');
assert(worker.includes('parseAirbnbVatFields'), 'worker parses Airbnb VAT number/date/amount');
assert(worker.includes('invoiceNumber: fields.invoiceNumber'), 'saved event carries invoice number');

function extractBetween(source, startName, nextName) {
  const start = source.indexOf('function ' + startName + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start);
  assert(start >= 0 && end > start, 'missing ' + startName + ' .. ' + nextName);
  return source.slice(start, end);
}
const vm = require('vm');
const extractSrc =
  extractBetween(worker, 'kindFromInvoiceBlob', 'airbnbInvoicePagePatterns') +
  extractBetween(worker, 'airbnbInvoiceUrlsForHit', 'attachAirbnbInvoiceNetworkTap');
const helpers = vm.runInNewContext(
  extractSrc + '\n({ extractAirbnbVatInvoiceHits, airbnbInvoiceUrlsForHit, looksLikeAirbnbInvoiceHtml, usefulAirbnbInvoiceHits, vatIdFromAirbnbUrl, airbnbReservationPageIsOpen, parseAirbnbVatFields })',
  { URL: URL, encodeURIComponent: encodeURIComponent }
);
const html = '<script>{"vatInvoiceId":"INV99ABC","vatInvoice":{"id":"INV99ABC","url":"https://www.airbnb.com/reservation/vat_invoice/INV99ABC"}}</script>';
const hits = helpers.extractAirbnbVatInvoiceHits(html, 'https://www.airbnb.com');
assert(hits.some((h) => h.id === 'INV99ABC'), 'extracts vatInvoiceId from reservation JSON');
assert(hits.some((h) => String(h.href || '').indexOf('/reservation/vat_invoice/INV99ABC') >= 0), 'extracts VAT invoice HTML URL');
const manyHtml = '{"vatInvoices":[{"id":"INV99ABC","url":"https://www.airbnb.com/reservation/vat_invoice/INV99ABC"},{"id":"CN88XYZ","url":"https://www.airbnb.com/reservation/vat_invoice/CN88XYZ"}]}';
const many = helpers.extractAirbnbVatInvoiceHits(manyHtml, 'https://www.airbnb.com');
assert(many.some((h) => h.id === 'INV99ABC'), 'extracts first vatInvoices[] id');
assert(many.some((h) => h.id === 'CN88XYZ'), 'extracts second vatInvoices[] id on the same stay');
const urls = helpers.airbnbInvoiceUrlsForHit({ kind: 'invoice', id: 'INV99ABC', href: '' }, 'https://www.airbnb.com', []);
assert(urls.some((u) => u.indexOf('/reservation/vat_invoice/INV99ABC') >= 0), 'builds Airbnb VAT invoice HTML URL from ID');
const tokenHtml = '{"vatInvoiceToken":"TOK99XYZ","vatInvoiceUrl":"https://www.airbnb.com/reservation/vat_invoice/TOK99XYZ"}';
const tokenHits = helpers.extractAirbnbVatInvoiceHits(tokenHtml, 'https://www.airbnb.com');
assert(tokenHits.some((h) => h.id === 'TOK99XYZ'), 'extracts vatInvoiceToken');
assert(tokenHits.some((h) => String(h.href || '').indexOf('/reservation/vat_invoice/TOK99XYZ') >= 0), 'extracts vatInvoiceUrl');
assert(!helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/hosting/stay/HMHPBAREC3', 'Guest check-in reservation €120'));
assert(helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/reservation/vat_invoice/INV99ABC', 'VAT invoice'));
assert(!helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/reservation/vat_invoice/HMHPBAREC3', 'We can’t find that page'));
assert.strictEqual(
  helpers.airbnbReservationPageIsOpen(
    'https://www.airbnb.com/hosting/stay/HM9DCDMEXT',
    "We can't find this reservation. Reservations · Bookings",
    'HM9DCDMEXT'
  ),
  false,
  'hosting 200 with missing copy is not an open stay'
);
assert.strictEqual(
  helpers.airbnbReservationPageIsOpen(
    'https://www.airbnb.com/hosting/reservations/details/HM9DCDMEXT',
    'Guest Alex · check-in 12 Jul · reservation HM9DCDMEXT',
    'HM9DCDMEXT'
  ),
  true,
  'details page with the confirmation code is open'
);
assert.strictEqual(
  helpers.airbnbReservationPageIsOpen(
    'https://www.airbnb.com/hosting/reservations',
    'Upcoming reservations · booking · guest check-in',
    'HMWRNAWHBA'
  ),
  false,
  'reservations list is not the stay'
);
assert.strictEqual(helpers.usefulAirbnbInvoiceHits([{ id: 'HMHPBAREC3' }, { id: 'INV99ABC' }], 'HMHPBAREC3').length, 1);
assert.strictEqual(helpers.vatIdFromAirbnbUrl('https://www.airbnb.com/reservation/vat_invoice/INV99ABC'), 'INV99ABC');

const sortSrc = extractBetween(worker, 'airbnbCreatedMs', 'loadAirbnbReservations');
const sortH = vm.runInNewContext(sortSrc + '\n({ airbnbCreatedMs, sortAirbnbReservationsLatest })');
const latest = sortH.sortAirbnbReservationsLatest([
  { code: 'OLD', createdOnChannel: 1000 },
  { code: 'NEW', createdOnChannel: 5000 },
  { code: 'MID', created: 3000 },
]);
assert.deepStrictEqual(latest.map((x) => x.code), ['NEW', 'MID', 'OLD']);
assert(sortH.airbnbCreatedMs({ createdOnChannel: 1 }) < sortH.airbnbCreatedMs({ createdOnChannel: 2 }));

const storeSrc = extractBetween(worker, 'platformStoreLabel', 'loadAirbnbReservations');
const store = vm.runInNewContext(storeSrc + '\n({ piInvoiceStoreRel, aptStoreFolder, platformStoreLabel })');
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'airbnb', month: '2026-07', aptName: 'Birdhouse', kind: 'invoice', code: 'HMHPBAREC3-INV99ABC' }),
  'Airbnb/2026-07/Birdhouse/invoice-HMHPBAREC3-INV99ABC.pdf'
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
    const channelYm = ymFromTs(b.createdOnChannel);
    const hosthubYm = ymFromTs(b.created);
    const createdYm = (channelYm === month || hosthubYm === month) ? month : (channelYm || hosthubYm);
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
  { platform: 'Airbnb', reservationId: 'HMEXTEND1', createdOnChannel: 1719792000, created: 1722470400 },
];
const exp = airExpect('2024-08', sample);
assert.strictEqual(exp.inv.length, 2);
assert(exp.inv.some((x) => x.code === 'HMABCDEF'));
assert(exp.inv.some((x) => x.code === 'HMEXTEND1'), 'Hosthub created in month opens an extension stay');
assert.strictEqual(exp.credit.length, 1);
assert.strictEqual(exp.credit[0].code, 'HMCANCEL1');

const { estimateAirbnbInvoices } = require(path.join(root, 'scripts', 'platform-invoice-expect'));
const est = estimateAirbnbInvoices('2024-08', sample);
assert.strictEqual(est.estimate.normal, 1, 'ordinary stay = 1 invoice');
assert.strictEqual(est.estimate.cancel, 1, 'cancelled stay = 2 invoices');
assert.strictEqual(est.estimate.extend, 1, 'Hosthub created >36h after channel = extend ×3');
assert.strictEqual(est.estimate.docs, 1 + 2 + 3, 'docs = normal1 + cancel2 + extend3');
assert.strictEqual(est.stays.find((s) => s.code === 'HMABCDEF').docs, 1);
assert.strictEqual(est.stays.find((s) => s.code === 'HMCANCEL1').docs, 2);
assert.strictEqual(est.stays.find((s) => s.code === 'HMEXTEND1').docs, 3);
assert.strictEqual(est.stays.find((s) => s.code === 'HMCANCEL1').stayKind, 'cancel');

const debitHtml = 'Invoice number AIUC-104771625-GR-1552747 issued 4/7/2026 Total €8.00';
const debit = helpers.parseAirbnbVatFields(debitHtml, 'invoice', '');
assert.strictEqual(debit.invoiceNumber, 'AIUC-104771625-GR-1552747');
assert.strictEqual(debit.issueDate, '4/7/2026');
assert.strictEqual(debit.total, 8);
assert.strictEqual(debit.sign, '');
const creditHtml = 'Credit note AIUC-104771625-GR-1552747-CN-1 4/7/2026 Total €8.00';
const creditF = helpers.parseAirbnbVatFields(creditHtml, 'credit_note', '');
assert.strictEqual(creditF.invoiceNumber, 'AIUC-104771625-GR-1552747-CN-1');
assert.strictEqual(creditF.sign, '-');
assert.strictEqual(creditF.total, 8);

const { buildAccountantXls, accountantRow } = require(path.join(root, 'scripts', 'platform-invoice-accountant-xls'));
const debitRow = accountantRow({
  channel: 'airbnb',
  filename: 'Airbnb/2026-07/Birdhouse/invoice-HMTEST-AIUC.pdf',
  meta: { invoiceNumber: 'AIUC-104771625-GR-1552747', issueDate: '4/7/2026', total: 8, sign: '' },
});
assert.strictEqual(debitRow.sign, '');
assert.strictEqual(debitRow.total, 8);
const creditRow = accountantRow({
  channel: 'airbnb',
  filename: 'Airbnb/2026-07/Birdhouse/credit_note-HMTEST-CN.pdf',
  kind: 'credit_note',
  meta: { invoiceNumber: 'AIUC-104771625-GR-1552747-CN-1', issueDate: '4/7/2026', total: 8, sign: '-' },
});
assert.strictEqual(creditRow.sign, '-');
const xls = buildAccountantXls([
  { channel: 'airbnb', meta: { invoiceNumber: 'AIUC-AAA', issueDate: '4/7/2026', total: 8, sign: '' } },
  { channel: 'airbnb', kind: 'credit_note', meta: { invoiceNumber: 'AIUC-AAA-CN-1', issueDate: '4/7/2026', total: 8, sign: '-' } },
  { channel: 'booking', meta: { invoiceNumber: 'BDC-1', issueDate: '1/7/2026', total: 99, sign: '' } },
]).toString('utf8');
assert(xls.includes('Ημερομηνία'), 'Excel has issue-date header');
assert(xls.includes('Αιτιολογία'), 'Excel has invoice-number header');
assert(xls.includes('Κατάστημα'), 'Excel has empty store column header');
assert(xls.includes('Αρ. συναλλαγής'), 'Excel has empty txn column header');
assert(xls.includes('Πρόσημο ποσού'), 'Excel has sign header');
assert(xls.includes('AIUC-AAA'), 'Excel has debit invoice number');
assert(xls.includes('AIUC-AAA-CN-1'), 'Excel has credit invoice number');
assert(!xls.includes('BDC-1'), 'Excel skips Booking.com');
assert(!xls.includes('ΥΠ10'), 'txn column is empty, not ΥΠ10');
const rowsXml = xls.split('<Row>').slice(2); // skip workbook noise / header
assert(rowsXml.some((r) => r.includes('AIUC-AAA-CN-1') && r.includes('>-</Data>')), 'credit Πρόσημο is minus');
assert(rowsXml.some((r) => r.includes('>AIUC-AAA<') && !r.includes('AIUC-AAA-CN') && !/Πρόσημο[\s\S]*>-</.test(r)), 'debit Πρόσημο empty');

// Code regex used by worker
const re = /^[A-Z0-9]{6,20}$/;
assert(re.test('HMABCDEF'));
assert(re.test('AB67782136778'));
assert(!re.test('short'));
assert(!re.test('HAS SPACE'));

console.log('platform-invoice-airbnb-codes.test.js: ok');
