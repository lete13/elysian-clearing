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
assert(xls.includes('BDC-1'), 'Excel includes matched Booking.com rows when provided');
assert(xls.includes('Platform invoices') || xls.includes('Worksheet'), 'Excel worksheet present');

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
const srv87 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-87.json'), 'utf8'));
assert.strictEqual(srv87.baseSha256, srv86.expectedSha256, 'SRV 87 continues SRV 86');
assert(srv87.patches.some((p) => (p.replace || '').includes('piWritePullJson')), 'SRV 87 writes pull JSON next to the session dir');
assert(srv87.patches.some((p) => (p.replace || '').includes('PI_AIRBNB_HAVE_FILE')), 'SRV 87 HAVE file');

function invoicePdf(text) {
  return '%PDF-1.4\n(' + text + ')\n%%EOF';
}
function zipEntries(files, opts) {
  const dd = !!(opts && opts.dataDescriptor);
  const locals = [];
  const cds = [];
  let offset = 0;
  files.forEach(function (f) {
    const nameBuf = Buffer.from(f.name);
    const raw = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body);
    const deflated = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(dd ? 0x08 : 0, 6);
    local.writeUInt16LE(8, 8);
    if (!dd) {
      local.writeUInt32LE(deflated.length, 18);
      local.writeUInt32LE(raw.length, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    const parts = [local, nameBuf, deflated];
    if (dd) {
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(0, 4);
      desc.writeUInt32LE(deflated.length, 8);
      desc.writeUInt32LE(raw.length, 12);
      parts.push(desc);
    }
    const blob = Buffer.concat(parts);
    locals.push(blob);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(dd ? 0x08 : 0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cds.push(Buffer.concat([cd, nameBuf]));
    offset += blob.length;
  });
  const cdBlob = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBlob.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cdBlob, eocd]));
}

const birdPdf = invoicePdf('Property ID 10980606 Invoice number 1234567890 Issue date 01/07/2026 Total EUR 12.34');
const votsPdf = invoicePdf('Property ID 5550001 Invoice number 555000199 Issue date 02/07/2026 Total EUR 80.00');
const unkPdf = invoicePdf('Property ID 3210009 Invoice number 99 Issue date 03/07/2026 Total EUR 1.00');
const stmtPdf = invoicePdf('Statement of account payout');
const nameMonthPdf = invoicePdf('Property ID 7770002 Invoice number 7771');
const fallbackPdf = invoicePdf('Property ID 10980606 Invoice number 888');

const catZip = zipEntries([
  { name: 'invoice-10980606.pdf', body: birdPdf },
  { name: 'invoices/votsala.pdf', body: votsPdf },
  { name: 'invoice-3210009.pdf', body: unkPdf },
  { name: 'statement.pdf', body: stmtPdf },
  { name: 'Horizon_July_2026.pdf', body: nameMonthPdf },
]);
const cat = booking.categorizeBookingZip(catZip, apts, '2026-08');
assert(cat.ok, 'zip categorize ok');
assert.strictEqual(cat.skipped.filter((s) => s.reason === 'statement').length, 1, 'statement skipped');
const bird = cat.files.find((f) => f.bookingHotelId === '10980606' && f.invoiceNumber === '1234567890');
assert(bird, 'Birdhouse invoice categorized');
assert.strictEqual(bird.mapped, true);
assert.strictEqual(bird.channel, 'booking');
assert.strictEqual(bird.source, 'upload');
assert.strictEqual(bird.usedFallbackMonth, false);
assert.strictEqual(bird.partner, 'Birdhouse');
assert.strictEqual(bird.month, '2026-07');
assert.strictEqual(bird.filename, 'Booking.com/2026-07/Birdhouse/invoice-10980606-1234567890.pdf');
const votsFile = cat.files.find((f) => f.bookingHotelId === '5550001');
assert.strictEqual(votsFile.partner, 'Votsala');
assert.strictEqual(votsFile.month, '2026-07');
const unkFile = cat.files.find((f) => f.bookingHotelId === '3210009');
assert.strictEqual(unkFile.mapped, false);
assert.strictEqual(unkFile.partner, 'unmapped-3210009');
assert(cat.unmapped.indexOf('3210009') >= 0, 'unmapped id listed');
const horizon = cat.files.find((f) => f.bookingHotelId === '7770002');
assert.strictEqual(horizon.month, '2026-07', 'month from July 2026 filename');
assert.strictEqual(horizon.partner, 'Horizon');

const fb = booking.categorizeBookingZip(zipEntries([{ name: 'plain.pdf', body: fallbackPdf }]), apts, '2026-08');
assert.strictEqual(fb.files[0].month, '2026-08');
assert.strictEqual(fb.files[0].usedFallbackMonth, true);

const ddZip = zipEntries([{ name: 'invoice-10980606.pdf', body: birdPdf }], { dataDescriptor: true });
const ddEnts = booking.unzipPdfEntries(ddZip);
assert.strictEqual(ddEnts.length, 1, 'data-descriptor zip still extracts');
assert(booking.looksLikePdf(ddEnts[0].buf));

const skipZip = zipEntries([
  { name: '__MACOSX/._invoice-10980606.pdf', body: birdPdf },
  { name: 'notes.csv', body: 'a,b\n1,2\n' },
  { name: 'keep.pdf', body: birdPdf },
]);
const skipEnts = booking.unzipPdfEntries(skipZip);
assert.strictEqual(skipEnts.length, 1, 'skips __MACOSX and non-PDF');
assert.strictEqual(skipEnts[0].name, 'keep.pdf');

const noMonth = booking.categorizeBookingZip(
  zipEntries([{ name: 'plain.pdf', body: fallbackPdf }]),
  apts,
  ''
);
assert.strictEqual(noMonth.files.length, 0, 'no month and no fallback → skip');
assert(noMonth.skipped.some((s) => s.reason === 'no-month'));

assert.strictEqual(
  booking.bookingZipDupKey({ bookingHotelId: '10980606', invoiceNumber: '1234567890', filename: 'x.pdf' }),
  'inv:10980606|1234567890'
);

const fe128 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-128.json'), 'utf8'));
const fe129 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-129.json'), 'utf8'));
const srv92 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-92.json'), 'utf8'));
const srv94 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-94.json'), 'utf8'));
assert.strictEqual(fe128.baseSha256, JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-127.json'), 'utf8')).expectedSha256, 'FE 128 continues FE 127');
assert.strictEqual(fe129.baseSha256, fe128.expectedSha256, 'FE 129 continues FE 128');
assert.strictEqual(srv92.baseSha256, JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-91.json'), 'utf8')).expectedSha256, 'SRV 92 continues SRV 91');
assert.strictEqual(srv94.baseSha256, JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-93.json'), 'utf8')).expectedSha256, 'SRV 94 continues SRV 93');
assert(fe128.patches.some((p) => (p.replace || '').includes('piRunAgent')), 'FE 128 Run Agent');
assert(fe129.patches.some((p) => (p.replace || '').includes('piUploadBookingZip')), 'FE zip upload handler');
assert(fe129.patches.some((p) => (p.replace || '').includes('id="pi-bdc-zip"')), 'FE zip input');
assert(fe129.patches.some((p) => (p.replace || '').includes('accept=".zip,application/zip"')), 'FE zip accept');
const emergency = fe129.patches.find((p) => (p.note || '').indexOf('Emergency') >= 0);
assert(emergency && /pi-pull-bdc-btn/.test(emergency.replace) && /pi-connect-booking-btn/.test(emergency.replace), 'Pull/Connect Booking moved to emergency tools');
const primary = fe129.patches.find((p) => (p.replace || '').includes('id="pi-bdc-zip"'));
assert(primary && !/pi-pull-bdc-btn/.test(primary.replace), 'primary Collect row is the zip, not Pull Booking');
assert(srv94.patches.some((p) => (p.replace || '').includes("app.post('/api/platform-invoices/booking-zip'")), 'SRV booking-zip route');
assert(srv94.patches.some((p) => (p.replace || '').includes('categorizeBookingZip')), 'SRV uses categorizeBookingZip');
assert(srv94.patches.some((p) => (p.replace || '').includes('PLATFORM_INV_ZIP_MAX_B64')), 'SRV zip size cap');
assert(srv94.patches.some((p) => /source:\s*'upload'/.test(p.replace || '')), 'zip ingest source=upload');

assert.strictEqual(
  booking.parseBookingHotelId('Accommodation number: 15253339 Invoice number 1659850126'),
  '15253339',
  'Accommodation number is the Booking.com hotel id'
);
assert.strictEqual(booking.isPortalChromeLabel('Today'), true);
assert.strictEqual(booking.isPortalChromeLabel('Upcoming'), true);
assert.strictEqual(booking.isPortalChromeLabel('Requests'), true);
assert.strictEqual(booking.isPortalChromeLabel('Navarino Athenian Nest'), false);

function flatePdf(content) {
  const compressed = zlib.deflateSync(Buffer.from(content));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + compressed.length + ' /Filter /FlateDecode >> stream\n'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
}
const flateNav = flatePdf(
  'BT (Accommodation number: 15253339) Tj (Invoice number: 1659850126) Tj (Date: 03/08/2026) Tj (Total amount due EUR 35.43) Tj ET'
);
const flateFields = booking.parseBookingInvoiceFields(booking.pdfExtractText(flateNav));
assert.strictEqual(flateFields.hotelId, '15253339', 'FlateDecode CID-less stream still yields hotel id');
assert.strictEqual(flateFields.invoiceNumber, '1659850126');
assert.strictEqual(flateFields.issueDate, '03/08/2026');

function utf16bePdfString(s) {
  let out = '';
  String(s || '').split('').forEach(function (ch) {
    const c = ch.charCodeAt(0);
    out += String.fromCharCode((c >> 8) & 0xff, c & 0xff);
  });
  return out;
}
const cidNav = flatePdf(
  'BT (' +
    utf16bePdfString('Accommodation number: 15253339') +
    ') Tj (' +
    utf16bePdfString('Invoice number: 1659850126') +
    ') Tj (' +
    utf16bePdfString('Date: 03/08/2026') +
    ') Tj (' +
    utf16bePdfString('Total amount due EUR 35.43') +
    ') Tj ET'
);
const cidFields = booking.parseBookingInvoiceFields(booking.pdfExtractText(cidNav));
assert.strictEqual(cidFields.hotelId, '15253339', 'UTF-16BE CID Tj (openhtmltopdf) yields Accommodation number');
assert.strictEqual(cidFields.invoiceNumber, '1659850126');
assert.strictEqual(cidFields.issueDate, '03/08/2026');

const navApts = [{ name: 'Navarino Athenian Nest', aptName: 'Navarino Athenian Nest', bookingHotelId: '15253339' }];
const cidZip = booking.categorizeBookingZip(
  zipEntries([{ name: 'invoices/invoice.pdf', body: cidNav }]),
  navApts,
  '2026-06'
);
assert.strictEqual(cidZip.files.length, 1, 'CID invoice is not skipped');
assert.strictEqual(cidZip.files[0].mapped, true);
assert.strictEqual(cidZip.files[0].partner, 'Navarino Athenian Nest');
assert.strictEqual(cidZip.files[0].month, '2026-08');
assert.strictEqual(cidZip.files[0].filename, 'Booking.com/2026-08/Navarino Athenian Nest/invoice-15253339-1659850126.pdf');
assert.strictEqual(cidZip.unmapped.length, 0);

const refile = require(path.join(root, 'scripts', 'platform-invoice-vault-refile'));
const navPlan = refile.planBookingPdfRefile(
  {
    channel: 'booking',
    partner: 'unmapped-unknown',
    filename: 'Booking.com/2026-06/unmapped-unknown/invoice-unknown.pdf',
    month: '2026-06',
  },
  flateNav,
  [{ name: 'Navarino Athenian Nest', aptName: 'Navarino Athenian Nest', bookingHotelId: '15253339' }]
);
assert(navPlan, 'unmapped PDF is refiled');
assert.strictEqual(navPlan.partner, 'Navarino Athenian Nest');
assert.strictEqual(navPlan.month, '2026-08', 'issue date month wins over zip fallback');
assert.strictEqual(navPlan.bookingHotelId, '15253339');
assert(navPlan.filename.indexOf('Navarino') >= 0, 'store path uses apartment name');

const todayPlan = refile.planAirbnbChromeRefile(
  {
    channel: 'airbnb',
    partner: 'Today',
    filename: 'Airbnb/2026-02/Today/invoice-HMT93XPRZX.pdf',
    meta: { reservationId: 'HMT93XPRZX' },
  },
  [{ reservationId: 'HMT93XPRZX', aptName: 'The Monograph' }],
  []
);
assert.strictEqual(todayPlan.partner, 'The Monograph');
assert(todayPlan.filename.indexOf('The Monograph') >= 0);

const unkA = invoicePdf('Commission invoice Issue date 01/07/2026 Total EUR 1.00 body-a');
const unkB = invoicePdf('Commission invoice Issue date 02/07/2026 Total EUR 2.00 body-b');
const unkZip = zipEntries([
  { name: 'invoice.pdf', body: unkA },
  { name: 'folder/invoice.pdf', body: unkB },
]);
const unkCat = booking.categorizeBookingZip(unkZip, apts, '2026-07');
assert.strictEqual(unkCat.files.length, 2, 'blank hotel ids still ingest every PDF');
assert.notStrictEqual(
  unkCat.files[0].filename,
  unkCat.files[1].filename,
  'unmapped PDFs must not collapse onto one invoice-unknown.pdf'
);
assert.notStrictEqual(
  booking.bookingZipDupKey(unkCat.files[0]),
  booking.bookingZipDupKey(unkCat.files[1]),
  'dup key uses zip path when hotel id is missing'
);
assert(unkCat.files.every((f) => f.partner === 'unmapped-unknown'));

const workerPull = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');
assert(workerPull.includes('isPortalChromeLabel'), 'Airbnb pull ignores Today/Upcoming chrome labels');

const fleet = [
  { id: 'b1', name: 'Birdhouse Apartment', aptName: 'Birdhouse Apartment' },
  { id: 'c1', name: 'Coloneum', aptName: 'Coloneum' },
  { id: 'h1', name: 'Elysian Lycabettus - Horizon', aptName: 'Elysian Lycabettus - Horizon' },
  { id: 'p1', name: 'Elysian Lycabettus - Panorama', aptName: 'Elysian Lycabettus - Panorama' },
  { id: 'va', name: 'The Athenian Veranda', aptName: 'The Athenian Veranda' },
  { id: 'va2', name: 'The Athenian Veranda 2', aptName: 'The Athenian Veranda 2' },
  { id: 'v1', name: 'Votsala 1 Luxury Stay with Patio', aptName: 'Votsala 1 Luxury Stay with Patio', clearGroup: 'Votsala' },
  { id: 'v2', name: 'Votsala 2 Luxury Stay with Patio', aptName: 'Votsala 2 Luxury Stay with Patio', clearGroup: 'Votsala' },
  { id: 'v3', name: 'Votsala 3 Deluxe & Modern Apartment in Piraeus', aptName: 'Votsala 3 Deluxe & Modern Apartment in Piraeus', clearGroup: 'Votsala' },
];
assert.strictEqual(booking.isVotsalaPropertyName('Votsala Apartments Piraeus'), true);
assert.strictEqual(booking.isVotsalaPropertyName('Votsala 1 Luxury Stay with Patio'), false);

const htmlProps = booking.listBookingPropertiesFromHtml(`
  <select>
    <option value="10980606">Birdhouse Apartment</option>
    <option value="5550001">Votsala</option>
    <option value="7770002">Horizon</option>
  </select>
  <a href="/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=8881112">Coloneum</a>
`);
const jsonProps = booking.harvestBookingProperties({
  hotels: [
    { hotel_id: '10980606', name: 'Birdhouse Apartment' },
    { hotelId: '5550001', hotelName: 'Votsala' },
    { property_id: '7770002', property_name: 'Horizon' },
  ],
});
const idMap = booking.matchBookingProperties(htmlProps.concat(jsonProps), fleet);
assert(idMap.linked.some((r) => r.aptId === 'b1' && r.bookingHotelId === '10980606'), 'Birdhouse id linked');
assert(idMap.linked.filter((r) => r.how === 'votsala-group' && r.bookingHotelId === '5550001').length === 3, 'one Votsala id on all Votsala units');
assert(idMap.linked.some((r) => r.aptId === 'h1' && r.bookingHotelId === '7770002'), 'Horizon token links Lycabettus Horizon');
assert(!idMap.linked.some((r) => r.aptId === 'p1'), 'Panorama is not Horizon');
assert(idMap.linked.some((r) => r.aptId === 'c1' && r.bookingHotelId === '8881112'), 'Coloneum from href');

const verandaMap = booking.matchBookingProperties(
  [
    { hotelId: '2010001', name: 'The Athenian Veranda' },
    { hotelId: '2020002', name: 'The Athenian Veranda 2' },
    { hotelId: '2030003', name: 'The Athenian Veranda 3' },
    { hotelId: '2040004', name: 'The Athenian Veranda 4' },
  ],
  fleet.concat([
    { id: 'va3', name: 'The Athenian Veranda 3', aptName: 'The Athenian Veranda 3' },
    { id: 'va4', name: 'The Athenian Veranda 4', aptName: 'The Athenian Veranda 4' },
  ])
);
assert.strictEqual(verandaMap.linked.find((r) => r.aptId === 'va').bookingHotelId, '2010001');
assert.strictEqual(verandaMap.linked.find((r) => r.aptId === 'va2').bookingHotelId, '2020002');
assert.strictEqual(verandaMap.linked.find((r) => r.aptId === 'va3').bookingHotelId, '2030003');
assert.strictEqual(verandaMap.linked.find((r) => r.aptId === 'va4').bookingHotelId, '2040004');

const conflictFleet = fleet.map(function (a) {
  return Object.assign({}, a, a.id === 'b1' ? { bookingHotelId: '9999999' } : {});
});
const conflicted = booking.matchBookingProperties([{ hotelId: '10980606', name: 'Birdhouse Apartment' }], conflictFleet);
assert(conflicted.skipped.some((s) => s.aptId === 'b1' && s.reason === 'conflict'), 'does not overwrite a different saved id');

const applied = booking.applyBookingHotelIds(fleet, idMap.linked);
assert.strictEqual(applied.apts.find((a) => a.id === 'b1').bookingHotelId, '10980606');
assert.strictEqual(applied.apts.find((a) => a.id === 'v1').bookingHotelId, '5550001');
assert.strictEqual(applied.apts.find((a) => a.id === 'v3').bookingHotelId, '5550001');

const amb = booking.matchBookingProperties([{ hotelId: '1110001', name: 'Lycabettus' }], fleet);
assert(amb.unmatched.some((u) => u.reason === 'ambiguous'), 'shared Lycabettus token stays unmatched');

const collected = booking.collectBookingPropertyRows({
  html: '<a href="/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=3330003">Art House</a>',
  json: { hotels: [{ hotel_id: '10980606', name: 'Birdhouse Apartment' }] },
  dom: [{ hotelId: '8881112', name: 'Coloneum' }],
});
assert(collected.some((r) => r.hotelId === '10980606' && /birdhouse/i.test(r.name)), 'collect json');
assert(collected.some((r) => r.hotelId === '8881112'), 'collect dom');
assert(collected.some((r) => r.hotelId === '3330003' && /art house/i.test(r.name)), 'collect html');

booking
  .scrapeBookingProperties(
    {
      _fns: [],
      on(ev, fn) {
        if (ev === 'response') this._fns.push(fn);
      },
      off(ev, fn) {
        this._fns = this._fns.filter((f) => f !== fn);
      },
      async goto(url) {
        this._fns.forEach((fn) =>
          fn({
            headers() {
              return { 'content-type': 'application/json' };
            },
            url() {
              return String(url) + '/partner/api/hotels.json';
            },
            async text() {
              return JSON.stringify({ hotels: [{ hotelId: '4440004', hotelName: 'The Monograph' }] });
            },
          })
        );
      },
      async waitForTimeout() {},
      async content() {
        return '<option value="10980606">Birdhouse Apartment</option>';
      },
      async evaluate() {
        return [{ hotelId: '8881112', name: 'Coloneum' }];
      },
    },
    { urls: ['https://admin.booking.com/'], waitMs: 0 }
  )
  .then(function (scraped) {
    assert(scraped.some((r) => r.hotelId === '10980606'), 'scrape html options');
    assert(scraped.some((r) => r.hotelId === '8881112'), 'scrape evaluate rows');
    assert(scraped.some((r) => r.hotelId === '4440004' && /monograph/i.test(r.name)), 'scrape json intercept');
    const fe130 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-130.json'), 'utf8'));
    const fe131 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-131.json'), 'utf8'));
    const fe132 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-132.json'), 'utf8'));
    const fe133 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-133.json'), 'utf8'));
    const srv93 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-93.json'), 'utf8'));
    const srv95 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-95.json'), 'utf8'));
    const srv96 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-96.json'), 'utf8'));
    assert.strictEqual(fe130.baseSha256, fe129.expectedSha256, 'FE 130 continues FE 129');
    assert.strictEqual(fe131.baseSha256, fe130.expectedSha256, 'FE 131 continues FE 130');
    assert.strictEqual(fe132.baseSha256, fe131.expectedSha256, 'FE 132 continues FE 131');
    assert.strictEqual(fe133.baseSha256, fe132.expectedSha256, 'FE 133 continues FE 132');
    assert.strictEqual(srv93.baseSha256, srv92.expectedSha256, 'SRV 93 continues SRV 92');
    assert.strictEqual(srv95.baseSha256, srv94.expectedSha256, 'SRV 95 continues SRV 94');
    assert.strictEqual(srv96.baseSha256, srv95.expectedSha256, 'SRV 96 continues SRV 95');
    assert(fe133.patches.some((p) => (p.replace || '').includes('piChromeFolder')), 'FE skips Today/Upcoming chrome folders');
    assert(fe133.patches.some((p) => (p.replace || '').includes('could not read a Booking.com hotel id')), 'FE zip copy does not ask to paste unmapped-unknown');
    assert(srv96.patches.some((p) => (p.replace || '').includes('piRefileVaultApartments')), 'SRV refiles unmapped/chrome vault rows');
    assert(srv96.patches.some((p) => (p.replace || '').includes("require('./scripts/platform-invoice-vault-refile')")), 'SRV loads vault refile helper');
    assert(fe130.patches.some((p) => (p.replace || '').includes('piMapBookingIds')), 'FE Map Booking.com IDs handler');
    assert(fe130.patches.some((p) => (p.replace || '').includes('id="pi-map-bdc-btn"')), 'FE Map button');
    assert(srv95.patches.some((p) => (p.replace || '').includes("app.post('/api/platform-invoices/booking-map'")), 'SRV booking-map route');
    assert(srv95.patches.some((p) => (p.replace || '').includes('scrapeBookingProperties')), 'SRV scrapes from the Connect session');
    assert(srv95.patches.some((p) => (p.replace || '').includes('applyBookingHotelIds')), 'SRV writes bookingHotelId onto apartments');
    assert(!/BOOKING_HOST_PASSWORD/.test(JSON.stringify(srv95.patches)), 'mapping does not password-login');
    const mapPatch = fe131.patches.find((p) => (p.replace || '').includes('BOOKING_HOTEL_IDS'));
    assert(mapPatch, 'FE 131 stores Booking.com hotel ids');
    const mapMatch = String(mapPatch.replace).match(/const BOOKING_HOTEL_IDS = (\{[\s\S]*?\});/);
    assert(mapMatch, 'FE 131 hotel id object is extractable');
    const liveIds = Function('return ' + mapMatch[1])();
    assert.strictEqual(liveIds['Birdhouse Apartment'], '11820968', 'Birdhouse live id');
    assert.strictEqual(liveIds['Votsala 1 Luxury Stay with Patio'], '13180441', 'Votsala live id');
    assert.strictEqual(liveIds['The Athenian Veranda 4'], '13870170', 'Veranda 4 live id');
    assert.strictEqual(liveIds['Elysian Lycabettus - Horizon'], '15109307', 'Horizon live id');
    assert.strictEqual(liveIds['Elysian Lycabettus - Panorama'], '15139682', 'Panorama live id');
    assert.strictEqual(liveIds['Filoxenia Apartment Athens'], '8519226', 'Filoxenia live id');
    assert.strictEqual(liveIds['Filonexia Apartment Athens'], '8519226', 'Filonexia spelling maps to the same id');
    assert.strictEqual(liveIds['Sunset Nest in Fiskardo'], undefined, 'Sunset Nest has no Booking.com listing URL');
    assert.strictEqual(liveIds['Villa Liberty'], undefined, 'Villa Liberty was unset in the first map');
    assert(fe131.patches.some((p) => (p.replace || '').includes('bookingHotelIdForName')), 'FE 131 applyDefaults fills blank bookingHotelId');
    assert(fe132.patches.some((p) => (p.replace || '').includes('"Villa Liberty": "3575720"')), 'FE 132 sets Villa Liberty to 3575720');
    console.log('platform-invoice-booking.test.js: ok');
  })
  .catch(function (e) {
    console.error(e);
    process.exit(1);
  });
