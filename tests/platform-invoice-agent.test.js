'use strict';
/**
 * Platform Invoices: Booking reconcile, accountant cards, agent report, already_have.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const booking = require(path.join(root, 'scripts', 'platform-invoice-booking'));
const { buildAccountantXls, accountantXlsFilename } = require(path.join(root, 'scripts', 'platform-invoice-accountant-xls'));
const accountants = require(path.join(root, 'scripts', 'platform-invoice-accountants'));
const agent = require(path.join(root, 'scripts', 'platform-invoice-agent'));

const apts = [
  { id: 'b1', name: 'Birdhouse', bookingHotelId: '10980606' },
  { id: 'v1', name: 'Votsala 1', clearGroup: 'Votsala', bookingHotelId: '5550001' },
  { id: 'v2', name: 'Votsala 2', clearGroup: 'Votsala', bookingHotelId: '5550001' },
];

const juneStay = {
  platform: 'Booking.com',
  aptId: 'b1',
  aptName: 'Birdhouse',
  checkIn: '10/6/2026',
  checkOut: '12/6/2026',
};

// Document month July covers June stays.
const reconOk = booking.reconcileBookingMonth(
  '2026-07',
  [juneStay],
  apts,
  [
    {
      channel: 'booking',
      month: '2026-07',
      aptName: 'Birdhouse',
      partner: 'Birdhouse',
      filename: 'Booking.com/2026-07/Birdhouse/invoice-10980606-1234567890.pdf',
      meta: { invoiceNumber: '1234567890', issueDate: '1/7/2026', total: 412.5, hotelId: '10980606' },
    },
  ]
);
assert.strictEqual(reconOk.ok, true, 'matched Booking invoice + stays is ok');
assert.strictEqual(reconOk.included.length, 1);
assert.strictEqual(reconOk.bookMonth, '2026-06');

const reconNoInv = booking.reconcileBookingMonth('2026-07', [juneStay], apts, []);
assert.strictEqual(reconNoInv.ok, false);
assert.strictEqual(reconNoInv.errors[0].type, 'stays_without_invoice');

const reconNoStay = booking.reconcileBookingMonth(
  '2026-07',
  [],
  apts,
  [
    {
      channel: 'booking',
      month: '2026-07',
      aptName: 'Birdhouse',
      filename: 'Booking.com/2026-07/Birdhouse/invoice-10980606.pdf',
      meta: { invoiceNumber: 'BDC-1', issueDate: '1/7/2026', total: 10 },
    },
  ]
);
assert.strictEqual(reconNoStay.ok, false);
assert.strictEqual(reconNoStay.errors[0].type, 'invoice_without_stays');

const pack = agent.buildMonthPack(
  '2026-07',
  [
    {
      channel: 'airbnb',
      month: '2026-07',
      filename: 'Airbnb/2026-07/Birdhouse/invoice-HMTEST1.pdf',
      meta: { invoiceNumber: 'AIUC-104771625-GR-1552747', issueDate: '4/7/2026', total: 8, reservationId: 'HMTEST1' },
    },
    {
      channel: 'airbnb',
      month: '2026-07',
      kind: 'credit_note',
      filename: 'Airbnb/2026-07/Birdhouse/credit_note-HMTEST1.pdf',
      meta: { invoiceNumber: 'AIUC-104771625-GR-1552747-CN-1', issueDate: '4/7/2026', total: 8, sign: '-', reservationId: 'HMTEST1' },
    },
    {
      channel: 'booking',
      month: '2026-07',
      aptName: 'Birdhouse',
      filename: 'Booking.com/2026-07/Birdhouse/invoice-10980606-1234567890.pdf',
      meta: { invoiceNumber: '1234567890', issueDate: '1/7/2026', total: 412.5, hotelId: '10980606' },
    },
  ],
  [
    juneStay,
    { platform: 'Airbnb', reservationId: 'HMTEST1', aptName: 'Birdhouse', checkIn: '1/7/2026', checkOut: '5/7/2026' },
  ],
  apts
);
assert.strictEqual(pack.ok, true);
assert.strictEqual(pack.xlsName, 'Platform-invoices-2026-07.xls');
assert.strictEqual(accountantXlsFilename('2026-07'), 'Platform-invoices-2026-07.xls');
const xls = pack.xlsBuf.toString('utf8');
assert(xls.includes('1234567890'), 'Booking invoice number in Excel');
assert(xls.includes('AIUC-104771625-GR-1552747'), 'Airbnb debit in Excel');
assert(xls.includes('AIUC-104771625-GR-1552747-CN-1'), 'Airbnb credit in Excel');
assert(xls.includes('10980606'), 'Booking hotel id as reservation id');
assert.strictEqual(pack.counts.booking, 1);
assert.strictEqual(pack.counts.airbnb, 2);

const blocked = agent.buildMonthPack('2026-07', [], [juneStay], apts);
assert.strictEqual(blocked.blocked, true);

const packNoStay = agent.buildMonthPack(
  '2026-07',
  [
    {
      channel: 'booking',
      month: '2026-07',
      aptName: 'Birdhouse',
      filename: 'Booking.com/2026-07/Birdhouse/invoice-10980606-BDC-1.pdf',
      meta: { invoiceNumber: 'BDC-1', issueDate: '1/7/2026', total: 10, hotelId: '10980606' },
    },
  ],
  [],
  apts
);
assert.strictEqual(packNoStay.blocked, true, 'invoice without stays still blocks agent send');
assert(packNoStay.xlsBuf.toString('utf8').includes('BDC-1'), 'unmatched Booking invoice still on Excel');
assert.strictEqual(packNoStay.counts.booking, 1);

const cards = accountants.seedFromEnv('');
assert.strictEqual(cards.length, 2);
assert(cards.every((c) => c.receivePdfs && c.receiveExcel));

const planSkip = agent.planAccountantEmails(
  [
    { email: 'a@example.com', receivePdfs: false, receiveExcel: false },
    { email: 'b@example.com', receivePdfs: true, receiveExcel: false },
  ],
  pack
);
assert.strictEqual(planSkip.skipped.length, 1);
assert.strictEqual(planSkip.skipped[0].reason, 'toggles_off');
assert.strictEqual(planSkip.sent.length, 1);
assert.strictEqual(planSkip.sent[0].attachPdfs, true);
assert.strictEqual(planSkip.sent[0].attachExcel, false);

const planBlocked = agent.planAccountantEmails(cards, blocked);
assert(planBlocked.skipped.every((s) => s.reason === 'month_blocked_booking_errors'));

const report = agent.buildAgentReport({
  month: '2026-07',
  pack: pack,
  leftover: { saved: ['HMNEW'], alreadyHave: ['HMOLD'], errors: [] },
  emailPlan: planSkip,
  status: 'sent',
});
assert.strictEqual(report.month, '2026-07');
assert.strictEqual(report.leftover.saved, 1);
assert.strictEqual(report.leftover.alreadyHave, 1);
assert.strictEqual(report.excel.totalRows, 3);
assert.strictEqual(report.emailed.length, 1);

const worker = fs.readFileSync(path.join(root, 'scripts', 'platform-invoice-pull.js'), 'utf8');
assert(worker.includes("event: 'already_have'"), 'worker emits already_have');
assert(worker.includes('alreadyHaveOk'), 'worker treats already-listed as success');
assert(worker.includes('return -1'), 'already-listed returns sentinel');

const srv92 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-92.json'), 'utf8'));
assert(srv92.patches.some((p) => (p.replace || '').includes("app.post('/api/platform-invoices/agent'")), 'SRV agent route');
assert(srv92.patches.some((p) => (p.replace || '').includes('piLoadAccountants')), 'SRV accountants');
assert(srv92.patches.some((p) => (p.replace || '').includes('pullDeadline')), 'SRV agent waits for leftover pull');
const srv93 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-93.json'), 'utf8'));
assert(srv93.patches.some((p) => (p.replace || '').includes("j.event === 'already_have'")), 'SRV already_have tracker');
assert(srv93.patches.some((p) => (p.replace || '').includes('resolvePull')), 'SRV awaits pull worker');
const srv98 = JSON.parse(fs.readFileSync(path.join(root, 'srv', 'patches-98.json'), 'utf8'));
assert(srv98.patches.some((p) => (p.replace || '').includes('buildAccountantXls(rows, bks, { includeBooking: true })')), 'SRV Excel uses vault Booking rows');
assert(srv98.patches.some((p) => (p.find || '').includes('recon.included')), 'SRV Excel stops filtering to matched Booking');
const fe128 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-128.json'), 'utf8'));
assert(fe128.patches.some((p) => (p.replace || '').includes('piRunAgent')), 'FE run agent');
assert(fe128.patches.some((p) => (p.replace || '').includes('pi-accountant-cards')), 'FE cards UI');
assert(fe128.patches.some((p) => (p.replace || '').includes('95 * 60 * 1000')), 'FE agent poll covers long leftover pull');

console.log('platform-invoice-agent.test.js: ok');
