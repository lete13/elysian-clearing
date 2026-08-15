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
assert(worker.includes('clickAirbnbStayInvoiceCandidate'), 'clicks the stay-page VAT invoice link');
assert(worker.includes('stay-click'), 'saves PDF from stay-page click');
assert(worker.includes('waitForAirbnbInvoiceHtml'), 'waits for invoice HTML in main#site-content');
assert(worker.includes('www.airbnb.gr'), 'opens invoices on the Greece Airbnb domain');
assert(worker.includes('/vat_invoices/'), 'tries legacy /vat_invoices/{token}');
assert(worker.includes('fetch-html'), 'saves invoice HTML fetched with the host session');
assert(worker.includes('new-tab'), 'opens invoice URLs in a new tab like VAT Invoicer');
assert(worker.includes('airbnbInvoiceNavMs'), 'dead invoice URLs fail in seconds, not 45s');
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
const fe110 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-110.json'), 'utf8'));
const srv74 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-74.json'), 'utf8'));
assert(fe109.patches.some((p) => (p.replace || '').includes("piPull({ codes: ['HM9DCDMEXT','HMWRNAWHBA'] })")), 'FE test pull is the two missed stays');
assert(fe109.patches.some((p) => (p.replace || '').includes('Estimated invoices to pull')), 'FE Expect estimates invoices');
assert(fe109.patches.some((p) => (p.replace || '').includes('piDownloadAccountantXls')), 'FE downloads accountant Excel');
assert(srv73.patches.some((p) => (p.replace || '').includes('buildAccountantXls')), 'server attaches accountant Excel');
assert(srv73.patches.some((p) => (p.replace || '').includes('estimateAirbnbInvoices')), 'server Expect estimate');
assert(fe110.patches.some((p) => (p.replace || '').includes('+2 per extra extend')), 'FE multi-extend copy');
assert(fe110.patches.some((p) => (p.replace || '').includes('piCountAirbnbExtends')), 'FE counts extra Hosthub ids');
assert(fe110.patches.some((p) => (p.replace || '').includes('checkIn: x.checkIn')), 'FE posts check-in with pull');
assert(srv74.patches.some((p) => (p.replace || '').includes('buildAccountantXls(rows, bks)')), 'Excel download joins Hosthub');
assert(srv74.patches.some((p) => (p.replace || '').includes('buildAccountantXls(rows, xlsBks)')), 'Excel ship joins Hosthub');
const fe111 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-111.json'), 'utf8'));
const srv75 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-75.json'), 'utf8'));
assert.strictEqual(fe111.baseSha256, fe110.expectedSha256, 'FE 111 continues FE 110');
assert.strictEqual(srv75.baseSha256, srv74.expectedSha256, 'SRV 75 continues SRV 74');
assert(fe111.patches.some((p) => (p.replace || '').includes('piDocsInMonth')), 'FE splits Expect docs by issue month');
assert(fe111.patches.some((p) => (p.replace || '').includes('VAT issue date')), 'FE copy says archive by VAT issue date');
assert(fe111.patches.some((p) => (p.replace || '').includes('PDFs by apartment — click Open to view')), 'vault Open heading kept as substring');
assert(srv75.patches.some((p) => (p.replace || '').includes('piRefileAirbnbByIssueDate')), 'server refiles by issue date');
assert(srv75.patches.some((p) => (p.replace || '').includes('archiveMonthOf(f, job.month)')), 'live ingest uses issue month');
assert(srv75.patches.some((p) => (p.replace || '').includes('SELECT id FROM platform_invoices WHERE channel=$1 AND filename=$2 AND size=$3 LIMIT 1')), 'dedup ignores collect month');
assert(worker.includes('issueDateToMonth'), 'worker maps VAT issue date to archive month');
assert(worker.includes('archiveMonth'), 'worker stores PDFs under the invoice issue month');
assert(worker.includes('invoiceNumber: fields.invoiceNumber'), 'saved event carries invoice number');
const fe115 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-115.json'), 'utf8'));
const srv77 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-77.json'), 'utf8'));
assert.strictEqual(fe115.baseSha256, JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-114.json'), 'utf8')).expectedSha256, 'FE 115 continues FE 114');
assert.strictEqual(srv77.baseSha256, JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-76.json'), 'utf8')).expectedSha256, 'SRV 77 continues SRV 76');
assert(fe115.patches.some((p) => (p.replace || '').includes('id="pi-view-vault"')), 'FE vault is the main view');
assert(fe115.patches.some((p) => (p.replace || '').includes("piSetMenu('retrieve')")), 'FE Retrieve submenu');
assert(fe115.patches.some((p) => (p.replace || '').includes('function renderVaultTree')), 'FE folder tree');
assert(fe115.patches.some((p) => (p.replace || '').includes('apartment → platform → year → month')), 'FE folder copy');
assert(srv77.patches.some((p) => (p.replace || '').includes("month === 'all'")), 'API lists whole vault');
assert(srv77.patches.some((p) => (p.replace || '').includes('ORDER BY partner, channel, month')), 'API orders apartment then platform then month');
const fe116 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-116.json'), 'utf8'));
const srv78 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-78.json'), 'utf8'));
assert.strictEqual(fe116.baseSha256, fe115.expectedSha256, 'FE 116 continues FE 115');
assert.strictEqual(srv78.baseSha256, srv77.expectedSha256, 'SRV 78 continues SRV 77');
assert(fe116.patches.some((p) => (p.replace || '').includes('piPullIncomplete')), 'FE Pull incomplete');
assert(fe116.patches.some((p) => (p.replace || '').includes('Vault vs Expect')), 'FE vault vs Expect');
assert(fe116.patches.some((p) => (p.replace || '').includes('Number(f.size) < 2048')), 'FE ignores tiny PDFs');
assert(srv78.patches.some((p) => (p.replace || '').includes('expectGaps')), 'server Expect gaps');
assert(srv78.patches.some((p) => (p.replace || '').includes('gaps: gaps')), 'airbnb-codes returns gaps');
assert(srv78.patches.some((p) => (p.replace || '').includes('/^HM[A-Z0-9]{6,18}$/.test(airCode)')), 'keeps cancelled Airbnb HM codes');
assert(srv78.patches.some((p) => (p.replace || '').includes('TINY_PDF_BYTES')), 'server tiny PDF skip');
assert(worker.includes('function isTinyPdf'), 'worker rejects tiny PDFs');
assert(worker.includes('TINY_PDF_BYTES = 2048'), 'worker tiny threshold is 2KB');
assert(worker.includes('(Number(b.missing) || 0) - (Number(a.missing) || 0)'), 'worker pulls incomplete stays first');
assert(srv78.patches.some((p) => (p.replace || '').includes("kind: 'both'")), 'pull kind both kept');

function extractBetween(source, startName, nextName) {
  const start = source.indexOf('function ' + startName + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start);
  assert(start >= 0 && end > start, 'missing ' + startName + ' .. ' + nextName);
  return source.slice(start, end);
}
const vm = require('vm');
const extractSrc =
  extractBetween(worker, 'kindFromInvoiceBlob', 'airbnbInvoicePagePatterns') +
  extractBetween(worker, 'airbnbBareInvoicePath', 'attachAirbnbInvoiceNetworkTap');
const helpers = vm.runInNewContext(
  extractSrc + '\n({ extractAirbnbVatInvoiceHits, airbnbInvoiceUrlsForHit, airbnbBareInvoicePath, looksLikeAirbnbInvoiceHtml, usefulAirbnbInvoiceHits, vatIdFromAirbnbUrl, airbnbReservationPageIsOpen, parseAirbnbVatFields, airbnbInvoiceHosts, airbnbInvoiceSoft404 })',
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
assert(helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/invoice/INV99ABC', 'VAT invoice Invoice number AIUC-1'));
assert(!helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/reservation/vat_invoice/HMHPBAREC3', 'We can’t find that page'));
assert(!helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/invoice/23k6jHjbbk9', 'Airbnb'));
assert(helpers.airbnbInvoiceSoft404("We can't find that page"));
assert(!helpers.airbnbInvoiceSoft404('VAT invoice Invoice number AIUC-104771625-GR-1552747'));
assert.strictEqual(helpers.airbnbInvoiceHosts('https://www.airbnb.com').join(','), 'www.airbnb.com,www.airbnb.gr');
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
assert.strictEqual(helpers.vatIdFromAirbnbUrl('https://www.airbnb.com/invoice/23k6jHjbbk9'), '23k6jHjbbk9');
assert.strictEqual(helpers.vatIdFromAirbnbUrl('/invoice/23a2NdTYpDo'), '23a2NdTYpDo');
assert.strictEqual(helpers.vatIdFromAirbnbUrl('/vat_invoices/23a2NdTYpDo'), '23a2NdTYpDo');
assert(helpers.airbnbBareInvoicePath('https://www.airbnb.com/invoice/23k6jHjbbk9'), 'stay-page /invoice/token is the short path');
assert(!helpers.airbnbBareInvoicePath('https://www.airbnb.com/reservation/vat_invoice/23k6jHjbbk9'));
const shortHtml = '<a href="/invoice/23k6jHjbbk9">VAT invoice</a>';
const shortHits = helpers.extractAirbnbVatInvoiceHits(shortHtml, 'https://www.airbnb.com');
assert(shortHits.some((h) => h.id === '23k6jHjbbk9'), 'extracts stay-page /invoice/token as VAT id');
assert(shortHits.some((h) => String(h.href || '').indexOf('/invoice/23k6jHjbbk9') >= 0), 'keeps stay-page /invoice/ href to click');
const shortUrls = helpers.airbnbInvoiceUrlsForHit(
  { kind: 'invoice', href: 'https://www.airbnb.com/invoice/23k6jHjbbk9', id: '' },
  'https://www.airbnb.com',
  []
);
assert(shortUrls.some((u) => u.indexOf('/reservation/vat_invoice/23k6jHjbbk9') >= 0), 'still tries vat_invoice HTML');
assert(shortUrls.some((u) => /airbnb\.com\/invoice\/23k6jHjbbk9/.test(u)), 'opens /invoice/token in a new tab (VAT Invoicer)');
assert(shortUrls.some((u) => /airbnb\.gr\/invoice\/23k6jHjbbk9/.test(u)), 'opens /invoice/token on airbnb.gr');
assert(shortUrls.some((u) => /\/vat_invoices\/23k6jHjbbk9/.test(u)), 'tries legacy /vat_invoices/token');
assert.strictEqual(helpers.usefulAirbnbInvoiceHits([{ href: 'https://www.airbnb.com/invoice/23k6jHjbbk9' }], 'HM9DCDMEXT').length, 1);
assert(!helpers.looksLikeAirbnbInvoiceHtml('https://www.airbnb.com/404', "We can't find that page"));

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

const { estimateAirbnbInvoices, expectGaps, TINY_PDF_BYTES, filenameAirbnbCode } = require(path.join(root, 'scripts', 'platform-invoice-expect'));
const est = estimateAirbnbInvoices('2024-08', sample);
assert.strictEqual(est.estimate.normal, 1, 'ordinary stay = 1 invoice');
assert.strictEqual(est.estimate.cancel, 1, 'cancelled stay listed in cancel month');
assert.strictEqual(est.estimate.extend, 1, 'Hosthub created >36h after channel = extend');
assert.strictEqual(est.estimate.docs, 1 + 1 + 2, 'this-month docs: normal1 + cancel-credit1 + extend-reissue2');
assert.strictEqual(est.stays.find((s) => s.code === 'HMABCDEF').docs, 1);
assert.strictEqual(est.stays.find((s) => s.code === 'HMCANCEL1').docs, 1, 'cancel credit in cancel month');
assert.strictEqual(est.stays.find((s) => s.code === 'HMEXTEND1').docs, 2, 'extend reissue (credit+new debit) in Hosthub created month');
assert.strictEqual(est.stays.find((s) => s.code === 'HMEXTEND1').docsStay, 3, 'stay still has 3 PDFs to pull');
assert.strictEqual(est.stays.find((s) => s.code === 'HMEXTEND1').extends, 1);
assert.strictEqual(est.stays.find((s) => s.code === 'HMCANCEL1').stayKind, 'cancel');
const estJul = estimateAirbnbInvoices('2024-07', sample);
assert.strictEqual(estJul.stays.find((s) => s.code === 'HMEXTEND1').docs, 1, 'original debit stays in createdOnChannel month');
assert.strictEqual(estJul.stays.find((s) => s.code === 'HMCANCEL1').docs, 1, 'cancel debit in createdOnChannel month');

const multi = [
  { platform: 'Airbnb', reservationId: 'HMMULTI2', id: 'e1', createdOnChannel: 1722470400, created: 1722470400, checkIn: '1/8/2024', checkOut: '5/8/2024', aptName: 'Birdhouse' },
  { platform: 'Airbnb', reservationId: 'HMMULTI2', id: 'e2', createdOnChannel: 1722470400, created: 1722556800, checkIn: '1/8/2024', checkOut: '8/8/2024', aptName: 'Birdhouse' },
  { platform: 'Airbnb', reservationId: 'HMMULTI2', id: 'e3', createdOnChannel: 1722470400, created: 1722643200, checkIn: '1/8/2024', checkOut: '12/8/2024', aptName: 'Birdhouse' },
];
const est2 = estimateAirbnbInvoices('2024-08', multi);
assert.strictEqual(est2.stays.length, 1);
assert.strictEqual(est2.stays[0].extends, 2, '3 Hosthub ids = 2 extends');
assert.strictEqual(est2.stays[0].docs, 5, '2 extends = 1+2n = 5 invoices');
assert.strictEqual(est2.estimate.extendDocs, 5);
assert.strictEqual(est2.stays[0].checkOut, '12/8/2024', 'later checkout wins');

const four = [];
for (let i = 0; i < 5; i++) {
  four.push({
    platform: 'Airbnb',
    reservationId: 'HMFOURX',
    id: 'id' + i,
    createdOnChannel: 1722470400,
    created: 1722470400,
    checkIn: '1/8/2024',
    checkOut: 5 + i + '/8/2024',
  });
}
const est4 = estimateAirbnbInvoices('2024-08', four);
assert.strictEqual(est4.stays[0].extends, 4, '5 Hosthub ids = 4 extends');
assert.strictEqual(est4.stays[0].docs, 9, '4 extends = 9 invoices');

const lifetime = [
  { platform: 'Airbnb', reservationId: 'HMLIFE1', id: 'old', createdOnChannel: 1719792000, created: 1719792000 },
  { platform: 'Airbnb', reservationId: 'HMLIFE1', id: 'new', createdOnChannel: 1719792000, created: 1722470400, checkIn: '1/8/2024', checkOut: '10/8/2024' },
];
const estLife = estimateAirbnbInvoices('2024-08', lifetime);
assert.strictEqual(estLife.stays[0].extends, 1, 'out-of-month extra Hosthub id still counts');
assert.strictEqual(estLife.stays[0].docs, 2, 'August gets extend reissue, not the July debit');
assert.strictEqual(estLife.stays[0].docsStay, 3);

const cancelExt = [
  { platform: 'Airbnb', reservationId: 'HMCANX1', id: 'a', createdOnChannel: 1719792000, created: 1719792000, cancelled: true, cancelledAt: 1722470400 },
  { platform: 'Airbnb', reservationId: 'HMCANX1', id: 'b', createdOnChannel: 1719792000, created: 1722470400, cancelled: true, cancelledAt: 1722470400 },
];
assert.strictEqual(estimateAirbnbInvoices('2024-08', cancelExt).stays[0].docs, 1, 'cancel credit this month; debit stays in createdOnChannel month');
assert.strictEqual(estimateAirbnbInvoices('2024-08', cancelExt).stays[0].stayKind, 'cancel');

assert.strictEqual(TINY_PDF_BYTES, 2048);
assert.strictEqual(filenameAirbnbCode('Airbnb/2026-07/Le Plaza/invoice-HM2N2TXW4H.pdf'), 'HM2N2TXW4H');
assert.strictEqual(filenameAirbnbCode('Airbnb/2026-07/X/credit_note-HM3TW2MMBX-CN1.pdf'), 'HM3TW2MMBX');

const gapStays = estimateAirbnbInvoices('2024-08', sample).stays;
const tinyIgnored = expectGaps(gapStays, [
  { filename: 'Airbnb/2024-08/X/invoice-HMABCDEF.pdf', size: 9000 },
  { filename: 'Airbnb/2024-08/X/invoice-HMCANCEL1.pdf', size: 9000 },
  { filename: 'Airbnb/2024-08/X/invoice-HMEXTEND1.pdf', size: 661 },
]);
assert.strictEqual(tinyIgnored.complete, 2, 'tiny extend PDF is not a saved invoice');
assert.strictEqual(tinyIgnored.incomplete.length, 1);
assert.strictEqual(tinyIgnored.incomplete[0].code, 'HMEXTEND1');
assert.strictEqual(tinyIgnored.incomplete[0].need, 2, 'August extend needs the reissue pair');
assert.strictEqual(tinyIgnored.incomplete[0].have, 0);
assert.strictEqual(tinyIgnored.missingDocs, 2);

const shortCancel = expectGaps(
  [{ code: 'HM3TW2MMBX', stayKind: 'cancel', docs: 2, docsStay: 2, aptName: 'Olive' }],
  [{ filename: 'Airbnb/2026-07/Olive/invoice-HM3TW2MMBX.pdf', size: 12000 }]
);
assert.strictEqual(shortCancel.complete, 0);
assert.strictEqual(shortCancel.incomplete[0].have, 1);
assert.strictEqual(shortCancel.incomplete[0].missing, 1);

const zeroExtend = expectGaps(
  [{ code: 'HM4WZ4A8W9', stayKind: 'extend', docs: 2, docsStay: 3, extends: 1, aptName: 'Peaceful' }],
  []
);
assert.strictEqual(zeroExtend.incomplete[0].have, 0);
assert.strictEqual(zeroExtend.incomplete[0].need, 2);
assert.strictEqual(zeroExtend.missingDocs, 2);

const emptyPdf = expectGaps(
  [{ code: 'HM2N2TXW4H', stayKind: 'normal', docs: 1, docsStay: 1 }],
  [{ filename: 'Airbnb/2026-07/Le Plaza/invoice-HM2N2TXW4H.pdf', size: 661 }]
);
assert.strictEqual(emptyPdf.complete, 0, '661-byte blank print does not complete the stay');
assert.strictEqual(emptyPdf.missingDocs, 1);

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
const liveInv =
  'Invoice from: Airbnb Ireland UC Invoice number: AIUC-105901827-GR-1574404 Invoice issue date: 2026-07-13 ' +
  'VAT Country VAT Rate Base Fee Amount VAT Amount Total Fee Including VAT GR 0.0% Service Fee €19.53 EUR €0.00 EUR €19.53 EUR Subtotal €19.53 EUR Reverse charge applies Invoice';
const liveParsed = helpers.parseAirbnbVatFields(liveInv, 'invoice', '');
assert.strictEqual(liveParsed.invoiceNumber, 'AIUC-105901827-GR-1574404');
assert.strictEqual(liveParsed.issueDate, '13/7/2026');
assert.strictEqual(liveParsed.total, 19.53, 'does not take VAT rate 0.0% as the invoice total');

const { buildAccountantXls, accountantRow, issueDateToMonth, plannedRefile, rewriteFilenameMonth, archiveMonthOf } = require(path.join(root, 'scripts', 'platform-invoice-accountant-xls'));
assert.strictEqual(issueDateToMonth('4/7/2026'), '2026-07');
assert.strictEqual(issueDateToMonth('4/8/2026'), '2026-08');
assert.strictEqual(archiveMonthOf({ issueDate: '4/8/2026', month: '2026-07' }, '2026-07'), '2026-08');
assert.strictEqual(archiveMonthOf({ meta: { issueDate: '4/7/2026' }, month: '2026-07' }, '2026-07'), '2026-07');
assert.strictEqual(
  archiveMonthOf({ filename: 'Airbnb/2026-08/Birdhouse/invoice-X.pdf', month: '2026-07' }, '2026-07'),
  '2026-07',
  'without an issue date, keep the stored month (do not guess from path alone)'
);
const extendVault = [
  { id: 1, channel: 'airbnb', month: '2026-07', filename: 'Airbnb/2026-07/Birdhouse/invoice-HMEXT-INV1.pdf', meta: { issueDate: '4/7/2026' } },
  { id: 2, channel: 'airbnb', month: '2026-07', filename: 'Airbnb/2026-07/Birdhouse/credit_note-HMEXT-CN1.pdf', meta: { issueDate: '4/8/2026' } },
  { id: 3, channel: 'airbnb', month: '2026-07', filename: 'Airbnb/2026-07/Birdhouse/invoice-HMEXT-INV2.pdf', meta: { issueDate: '4/8/2026' } },
].map(function (r) { return Object.assign({}, r, plannedRefile(r) || {}); });
assert.strictEqual(extendVault.filter((r) => r.month === '2026-07').length, 1, 'original debit stays in July');
assert.strictEqual(extendVault.filter((r) => r.month === '2026-08').length, 2, 'credit + new debit refile to August');
assert.strictEqual(extendVault[1].filename, 'Airbnb/2026-08/Birdhouse/credit_note-HMEXT-CN1.pdf');
assert.strictEqual(extendVault[2].filename, 'Airbnb/2026-08/Birdhouse/invoice-HMEXT-INV2.pdf');
assert.strictEqual(
  rewriteFilenameMonth('Airbnb/2026-07/Birdhouse/credit_note-HMTEST1-CN.pdf', '2026-08'),
  'Airbnb/2026-08/Birdhouse/credit_note-HMTEST1-CN.pdf'
);
const refile = plannedRefile({
  channel: 'airbnb',
  month: '2026-07',
  filename: 'Airbnb/2026-07/Birdhouse/invoice-HMTEST1-INV.pdf',
  meta: { issueDate: '4/8/2026', invoiceNumber: 'AIUC-AAA' },
});
assert.strictEqual(refile.month, '2026-08');
assert.strictEqual(refile.filename, 'Airbnb/2026-08/Birdhouse/invoice-HMTEST1-INV.pdf');
assert.strictEqual(
  plannedRefile({
    channel: 'booking',
    month: '2026-07',
    filename: 'Booking.com/2026-07/Horizon/invoice-apt.pdf',
    meta: { issueDate: '4/8/2026' },
  }),
  null,
  'Booking.com keeps the collect month'
);
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
const xls = buildAccountantXls(
  [
    {
      channel: 'airbnb',
      filename: 'Airbnb/2026-07/Birdhouse/invoice-HMTEST1-INV.pdf',
      meta: { invoiceNumber: 'AIUC-AAA', issueDate: '4/7/2026', total: 8, sign: '', reservationId: 'HMTEST1' },
    },
    {
      channel: 'airbnb',
      filename: 'Airbnb/2026-07/Birdhouse/credit_note-HMTEST1-CN.pdf',
      kind: 'credit_note',
      meta: { invoiceNumber: 'AIUC-AAA-CN-1', issueDate: '4/7/2026', total: 8, sign: '-' },
    },
    { channel: 'booking', meta: { invoiceNumber: 'BDC-1', issueDate: '1/7/2026', total: 99, sign: '' } },
  ],
  [{ platform: 'Airbnb', reservationId: 'HMTEST1', aptName: 'Birdhouse', checkIn: '1/7/2026', checkOut: '5/7/2026' }]
).toString('utf8');
assert(xls.includes('Ημερομηνία'), 'Excel has issue-date header');
assert(xls.includes('Αιτιολογία'), 'Excel has invoice-number header');
assert(xls.includes('Κατάστημα'), 'Excel has empty store column header');
assert(xls.includes('Αρ. συναλλαγής'), 'Excel has empty txn column header');
assert(xls.includes('Πρόσημο ποσού'), 'Excel has sign header');
assert(xls.includes('Reservation id'), 'Excel has reservation id header');
assert(xls.includes('Listing name'), 'Excel has listing name header');
assert(xls.includes('Check-in'), 'Excel has check-in header');
assert(xls.includes('Check-out'), 'Excel has check-out header');
assert(xls.includes('AIUC-AAA'), 'Excel has debit invoice number');
assert(xls.includes('AIUC-AAA-CN-1'), 'Excel has credit invoice number');
assert(xls.includes('HMTEST1'), 'Excel has reservation id');
assert(xls.includes('Birdhouse'), 'Excel has listing name from Hosthub');
assert(xls.includes('1/7/2026'), 'Excel has check-in');
assert(xls.includes('5/7/2026'), 'Excel has check-out');
assert(!xls.includes('BDC-1'), 'Excel skips Booking.com');
assert(!xls.includes('ΥΠ10'), 'txn column is empty, not ΥΠ10');
const rowsXml = xls.split('<Row>').slice(2); // skip workbook noise / header
assert(rowsXml.some((r) => r.includes('AIUC-AAA-CN-1') && r.includes('>-</Data>')), 'credit Πρόσημο is minus');
assert(rowsXml.some((r) => r.includes('>AIUC-AAA<') && !r.includes('AIUC-AAA-CN') && !/Πρόσημο[\s\S]*>-</.test(r)), 'debit Πρόσημο empty');
assert(
  rowsXml.some((r) => r.includes('AIUC-AAA-CN-1') && r.includes('HMTEST1') && r.includes('1/7/2026')),
  'credit row still joins Hosthub from filename code'
);

// Code regex used by worker
const re = /^[A-Z0-9]{6,20}$/;
assert(re.test('HMABCDEF'));
assert(re.test('AB67782136778'));
assert(!re.test('short'));
assert(!re.test('HAS SPACE'));

console.log('platform-invoice-airbnb-codes.test.js: ok');
