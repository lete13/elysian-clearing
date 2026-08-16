'use strict';
/**
 * Booking.com mass-extract + id map — static checks (no admin.booking.com).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const booking = require(path.join(root, 'scripts', 'platform-invoice-booking'));
const expect = require(path.join(root, 'scripts', 'platform-invoice-expect'));
const { buildAccountantXls } = require(path.join(root, 'scripts', 'platform-invoice-accountant-xls'));
const worker = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');

assert(worker.includes("require('./platform-invoice-booking')"), 'worker uses booking helpers');
assert(worker.includes('openBookingInvoicesPage'), 'opens group Finance → Invoices');
assert(worker.includes('bookingClickMassExtract'), 'clicks month mass extract');
assert(worker.includes('resolveBookingApt'), 'files by bookingHotelId');
assert(worker.includes('resolved.folder'), 'files into the mapped or unmapped folder');
assert(fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-booking.js'), 'utf8').includes("folder: 'unmapped-'"), 'unmapped ids get a holding folder');
assert(!/async function listBookingProperties/.test(worker), 'does not walk property homepages');
assert(!/matchApartment\(prop/.test(worker), 'does not name-match Booking invoices');

const apts = [
  { id: 'b1', aptId: 'b1', aptName: 'Birdhouse', name: 'Birdhouse', bookingHotelId: '10980606' },
  { id: 'v1', aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio', name: 'Votsala 1 Luxury Stay with Patio', clearGroup: 'Votsala', bookingHotelId: '5550001' },
  { id: 'v2', aptId: 'v2', aptName: 'Votsala 2 Luxury Stay with Patio', name: 'Votsala 2 Luxury Stay with Patio', clearGroup: 'Votsala', bookingHotelId: '5550001' },
  { id: 'h1', aptId: 'h1', aptName: 'Horizon', name: 'Horizon', bookingHotelId: '7770002' },
];

const juneBird = { platform: 'Booking.com', aptId: 'b1', aptName: 'Birdhouse', checkIn: '12/6/2026', checkOut: '15/6/2026', guestName: 'A' };
const juneBird2 = { platform: 'Booking.com', aptId: 'b1', aptName: 'Birdhouse', checkIn: '20/6/2026', checkOut: '22/6/2026', guestName: 'B' };
const juneV1 = { platform: 'Booking.com', aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio', checkIn: '10/6/2026', checkOut: '12/6/2026' };
const juneV2 = { platform: 'Booking.com', aptId: 'v2', aptName: 'Votsala 2 Luxury Stay with Patio', checkIn: '14/6/2026', checkOut: '16/6/2026' };
const julyStay = { platform: 'Booking.com', aptId: 'h1', aptName: 'Horizon', checkIn: '2/7/2026', checkOut: '5/7/2026' };
const airVotsala = { platform: 'Airbnb', aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio', checkIn: '10/6/2026', reservationId: 'HMTEST1', createdOnChannel: Date.parse('2026-06-10') };

const est = booking.estimateBookingInvoices('2026-07', [juneBird, juneBird2, juneV1, juneV2, julyStay, airVotsala], apts);
assert.strictEqual(est.bookMonth, '2026-06');
assert.strictEqual(est.bookings, 4, 'June BDC stays only (not July, not Airbnb)');
assert.strictEqual(est.docs, 2, 'Birdhouse + Votsala = two July PDFs');
assert.strictEqual(est.apts.length, 2);
assert(est.apts.some((a) => a.aptName === 'Birdhouse' && a.bookings === 2), 'two June stays → one Birdhouse expect row');
assert(est.apts.some((a) => a.aptName === 'Votsala' && a.bookings === 2), 'Votsala 1+2 → one Votsala row');
assert(!est.apts.some((a) => a.aptName === 'Horizon'), 'July stay is not a July invoice');
assert.strictEqual(expect.estimateBookingInvoices, booking.estimateBookingInvoices, 'expect.js re-exports booking estimate');

const airEst = expect.estimateAirbnbInvoices('2026-06', [airVotsala, juneV1]);
assert.strictEqual(airEst.stays.length, 1, 'Airbnb Votsala stays stay per unit');
assert.strictEqual(airEst.stays[0].aptName, 'Votsala 1 Luxury Stay with Patio');

assert.strictEqual(booking.parseBookingHotelId('https://admin.booking.com/x?hotel_id=10980606&invoice=1'), '10980606');
assert.strictEqual(booking.parseBookingHotelId('Property ID: 5550001 Invoice number 998877'), '5550001');
assert.strictEqual(booking.parseBookingHotelId('Booking.com/2026-07/unmapped-3210009/invoice-3210009.pdf'), '3210009');

const fields = booking.parseBookingInvoiceFields(
  'Booking.com Invoice\nProperty ID 10980606\nInvoice number 1234567890\nIssue date 01/07/2026\nTotal EUR 12.34'
);
assert.strictEqual(fields.hotelId, '10980606');
assert.strictEqual(fields.invoiceNumber, '1234567890');
assert.strictEqual(fields.issueDate, '01/07/2026');
assert.strictEqual(fields.total, 12.34);

const mapped = booking.resolveBookingApt('10980606', apts);
assert.strictEqual(mapped.mapped, true);
assert.strictEqual(mapped.folder, 'Birdhouse');
const vots = booking.resolveBookingApt('5550001', apts);
assert.strictEqual(vots.folder, 'Votsala');
assert.strictEqual(vots.clearGroup, 'Votsala');
const unk = booking.resolveBookingApt('3210009', apts);
assert.strictEqual(unk.mapped, false);
assert.strictEqual(unk.folder, 'unmapped-3210009');
assert.notStrictEqual(unk.folder, 'Birdhouse', 'never guess a folder from a name');

assert.strictEqual(
  booking.bookingInvoiceFilename('10980606', '1234567890'),
  'invoice-10980606-1234567890.pdf'
);

const html = `
  <table>
    <tr><td>Birdhouse</td><td>July 2026</td><td><a href="/finance/invoice.pdf?hotel_id=10980606">PDF</a></td></tr>
    <tr><td>Votsala</td><td>July 2026</td><td><a href="/finance/invoice.pdf?hotel_id=5550001">Download</a></td></tr>
    <tr><td>Horizon</td><td>June 2026</td><td><a href="/finance/invoice.pdf?hotel_id=7770002">PDF</a></td></tr>
    <tr><td>Birdhouse</td><td>July 2026</td><td><a href="/finance/export.xls?hotel_id=10980606">Excel</a></td></tr>
  </table>`;
const targets = booking.listBookingInvoiceTargets(html, 'https://admin.booking.com/', '2026-07');
assert(targets.some((t) => t.hotelId === '10980606'), 'July PDF for Birdhouse');
assert(targets.some((t) => t.hotelId === '5550001'), 'July PDF for Votsala');
assert(!targets.some((t) => /\.xls/i.test(t.href || '')), 'skips XLS');

const harvested = booking.harvestBookingInvoicePayloads({
  invoices: [
    { hotel_id: '10980606', pdf_url: 'https://admin.booking.com/a.pdf', invoice_number: '1', period: '2026-07' },
    { hotelId: '5550001', downloadUrl: '/b.pdf', invoiceNumber: '2', month: 'July 2026' },
  ],
});
const deduped = booking.dedupeInvoiceTargets(harvested, '2026-07');
assert.strictEqual(deduped.length, 2);
assert(deduped.every((t) => t.hotelId));

const pdfA = Buffer.from('%PDF-1.4 bird');
const files = [
  { channel: 'booking', aptName: 'Birdhouse', partner: 'Birdhouse', path: '/tmp/a.pdf' },
];
let complete = booking.bookingCompleteness(est.apts, files);
assert.strictEqual(complete.ok, false);
assert(complete.missing.indexOf('Votsala') >= 0);
files.push({ channel: 'booking', aptName: 'Votsala', partner: 'Votsala' });
complete = booking.bookingCompleteness(est.apts, files);
assert.strictEqual(complete.ok, true);
files.push({ channel: 'booking', aptName: 'unmapped-3210009', partner: 'unmapped-3210009' });
complete = booking.bookingCompleteness(est.apts, files);
assert.strictEqual(complete.ok, false);
assert(complete.unmapped.indexOf('unmapped-3210009') >= 0);
files.pop();
files.push({ channel: 'booking', aptName: 'Birdhouse', partner: 'Birdhouse' });
complete = booking.bookingCompleteness(est.apts, files);
assert(complete.duplicates.some((d) => d.aptName === 'Birdhouse'));

const storeSrc = (function () {
  const start = worker.indexOf('function platformStoreLabel');
  const end = worker.indexOf('\nfunction loadAirbnbReservations');
  return worker.slice(start, end);
})();
const vm = require('vm');
const store = vm.runInNewContext(storeSrc + '\n({ piInvoiceStoreRel, aptStoreFolder, platformStoreLabel })');
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'booking', month: '2026-07', aptName: 'Birdhouse', kind: 'invoice', code: '10980606-123' }),
  'Booking.com/2026-07/Birdhouse/invoice-10980606-123.pdf'
);
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'booking', month: '2026-07', aptName: 'Votsala', kind: 'invoice', code: '5550001' }),
  'Booking.com/2026-07/Votsala/invoice-5550001.pdf'
);
assert.strictEqual(
  store.piInvoiceStoreRel({ channel: 'booking', month: '2026-07', aptName: 'unmapped-3210009', kind: 'invoice', code: '3210009' }),
  'Booking.com/2026-07/unmapped-3210009/invoice-3210009.pdf'
);

const xls = buildAccountantXls(
  [
    { channel: 'airbnb', filename: 'Airbnb/2026-07/Birdhouse/invoice-HM.pdf', meta: { invoiceNumber: 'AIUC-1', issueDate: '1/7/2026', total: 8 } },
    { channel: 'booking', filename: 'Booking.com/2026-07/Birdhouse/invoice-10980606.pdf', meta: { invoiceNumber: 'BDC-1', issueDate: '1/7/2026', total: 99 } },
  ],
  []
).toString('utf8');
assert(xls.includes('AIUC-1'));
assert(!xls.includes('BDC-1'), 'Excel still skips Booking.com');

assert.strictEqual(booking.bookingTooEarly('2026-07', new Date('2026-08-16T12:00:00Z')), false);
assert.strictEqual(booking.bookingTooEarly('2026-08', new Date('2026-08-03T12:00:00Z')), true);
assert.strictEqual(booking.bookingTooEarly('2026-08', new Date('2026-08-16T12:00:00Z')), false);

function zipPdf(name, body) {
  const raw = Buffer.from(body);
  const deflated = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(deflated.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  const crc = 0;
  header.writeUInt32LE(crc, 14);
  return Buffer.concat([header, nameBuf, deflated]);
}
const zipped = zipPdf('invoice-10980606.pdf', '%PDF-1.4 zipped-invoice');
const ents = booking.unzipPdfEntries(zipped);
assert.strictEqual(ents.length, 1);
assert.strictEqual(ents[0].name, 'invoice-10980606.pdf');
assert(booking.looksLikePdf(ents[0].buf));

assert.strictEqual(booking.isBookingStatementBlob('export.xls', ''), true);
assert.strictEqual(booking.isBookingStatementBlob('invoice.pdf', 'commission invoice'), false);

const fe118 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-118.json'), 'utf8'));
const srv79 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-79.json'), 'utf8'));
assert(fe118.patches.some((p) => (p.replace || '').includes('piConnectBookingInApp()')), 'FE Connect Booking is in-app');
assert(fe118.patches.some((p) => (p.replace || '').includes('Do not paste JSON')), 'FE tells the host not to paste JSON');
assert(srv79.patches.some((p) => (p.replace || '').includes('https://admin.booking.com/')), 'SRV opens the Extranet, not www.booking.com');
const bookingLoginPatch = srv79.patches.find((p) => (p.replace || '').includes("app.post('/api/platform-invoices/sessions/booking/login'"));
assert(bookingLoginPatch, 'SRV has Booking login POST');
assert(!/if \(!\(process\.env\.BOOKING_HOST_EMAIL/.test(bookingLoginPatch.replace), 'Booking Connect does not require env passwords');
assert(bookingLoginPatch.replace.includes('piBookingTryFillLogin'), 'optional env auto-fill exists');
const srv81 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-81.json'), 'utf8'));
assert(srv81.patches.some((p) => (p.replace || '').includes("BOOKING_CONNECT_AUTOFILL === '1'")), 'auto-fill is not the default Connect path');
assert(srv81.patches.some((p) => (p.replace || '').includes('piBookingNewContext')), 'Booking Connect has its own browser context');
assert(!srv81.patches.some((p) => (p.replace || '').includes('Chrome/122')), 'Booking context does not spoof Chrome 122');
const srv82 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-82.json'), 'utf8'));
assert(srv82.patches.some((p) => (p.replace || '').includes('headless: false')), 'Booking Connect is headed');
assert(srv82.patches.some((p) => (p.replace || '').includes('piBookingHumanType')), 'Type focuses username');
assert(srv82.patches.some((p) => (p.replace || '').includes('not(#hidden-password)')), 'Type ignores hidden password decoy');
assert(srv82.patches.some((p) => (p.replace || '').includes('cn <= 140')), 'FE bootstrap through 140');
const srv83 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-83.json'), 'utf8'));
assert(srv83.patches.some((p) => (p.replace || '').includes("existsSync('/tmp/.X11-unix/X'")), 'Xvfb starts if the X socket is missing');
const srv84 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-84.json'), 'utf8'));
assert(srv84.patches.some((p) => (p.replace || '').includes('Server started HeadlessChrome')), 'HeadlessChrome is refused');
assert(srv84.patches.every((p) => !(p.replace || '').includes('falling back to headless')), 'no headless fallback in SRV 84');
const fe122 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-122.json'), 'utf8'));
const fe123 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-123.json'), 'utf8'));
const srv85 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-85.json'), 'utf8'));
assert.strictEqual(fe123.baseSha256, fe122.expectedSha256, 'FE 123 continues FE 122');
assert.strictEqual(srv85.baseSha256, srv84.expectedSha256, 'SRV 85 continues SRV 84');
assert(fe123.patches.some((p) => (p.replace || '').includes('Do not retry now')), 'FE 123 says do not retry');
assert(srv85.patches.some((p) => (p.replace || '').includes('piBookingMarkNetworkBlocked')), 'SRV 85 marks a network block');
const srv86 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-86.json'), 'utf8'));
assert.strictEqual(srv86.baseSha256, srv85.expectedSha256, 'SRV 86 continues SRV 85');
assert(srv86.patches.some((p) => (p.replace || '').includes("require('./scripts/platform-invoice-booking-block')")), 'SRV 86 uses the shared block module');
assert(srv86.patches.some((p) => (p.replace || '').includes('await piBookingReadBlockedUntil')), 'SRV 86 reads the cooldown from Postgres');
assert(srv86.patches.some((p) => (p.replace || '').includes('Pull will not password-login from this IP')), 'SRV 86 stops Pull password-login while blocked');

console.log('platform-invoice-booking.test.js: ok');
