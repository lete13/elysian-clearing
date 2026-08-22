'use strict';
/**
 * Platform Invoices month agent: leftover pull summary → Booking reconcile →
 * Excel pack → per-accountant send plan → run report.
 */

const booking = require('./platform-invoice-booking');
const { buildAccountantXls, accountantXlsFilename } = require('./platform-invoice-accountant-xls');
const { recipientsForSend } = require('./platform-invoice-accountants');

function isAirbnbRow(row) {
  const ch = String((row && row.channel) || '').toLowerCase();
  return !ch || ch === 'airbnb' || ch === 'air';
}

function isBookingRow(row) {
  const ch = String((row && row.channel) || '').toLowerCase();
  return ch === 'booking' || ch === 'bdc';
}

/**
 * Build the month pack used by Excel / PDF email.
 * Excel includes every vault Booking.com invoice for the month.
 * Agent send still blocks when Hosthub stays and invoices do not match.
 */
function buildMonthPack(month, vaultRows, bks, apts) {
  const airbnb = (vaultRows || []).filter(function (r) {
    return isAirbnbRow(r) && (!r.month || String(r.month) === String(month));
  });
  const bookingRows = (vaultRows || []).filter(function (r) {
    return isBookingRow(r) && (!r.month || String(r.month) === String(month));
  });
  const recon = booking.reconcileBookingMonth(month, bks, apts, bookingRows);
  const packRows = airbnb.concat(bookingRows);
  const xlsBuf = buildAccountantXls(packRows, bks, { includeBooking: true });
  const counts = (xlsBuf && xlsBuf._piCounts) || {
    airbnb: airbnb.length,
    booking: bookingRows.length,
    total: packRows.length,
  };
  return {
    month: month,
    ok: !!recon.ok,
    blocked: !recon.ok,
    reconcile: recon,
    packRows: packRows,
    pdfRows: packRows,
    xlsBuf: xlsBuf,
    xlsName: accountantXlsFilename(month),
    counts: counts,
    errors: recon.errors || [],
  };
}

function planAccountantEmails(cards, pack) {
  const recipients = recipientsForSend(cards);
  const sent = [];
  const skipped = [];
  recipients.forEach(function (c) {
    if (pack && pack.blocked) {
      skipped.push({
        id: c.id,
        email: c.email,
        reason: 'month_blocked_booking_errors',
        receivePdfs: c.receivePdfs,
        receiveExcel: c.receiveExcel,
      });
      return;
    }
    if (c.skip) {
      skipped.push({
        id: c.id,
        email: c.email,
        reason: 'toggles_off',
        receivePdfs: false,
        receiveExcel: false,
      });
      return;
    }
    sent.push({
      id: c.id,
      name: c.name,
      email: c.email,
      attachPdfs: !!c.receivePdfs,
      attachExcel: !!c.receiveExcel,
    });
  });
  return { sent: sent, skipped: skipped };
}

function buildAgentReport(opts) {
  opts = opts || {};
  const pack = opts.pack || null;
  const leftover = opts.leftover || { saved: [], alreadyHave: [], errors: [] };
  const emailPlan = opts.emailPlan || { sent: [], skipped: [] };
  return {
    month: opts.month || (pack && pack.month) || '',
    status: pack && pack.blocked ? 'blocked' : opts.status || 'ok',
    leftover: {
      saved: (leftover.saved || []).length,
      alreadyHave: (leftover.alreadyHave || []).length,
      errors: leftover.errors || [],
      codesSaved: leftover.saved || [],
      codesAlreadyHave: leftover.alreadyHave || [],
    },
    booking: {
      ok: !(pack && pack.blocked),
      errors: (pack && pack.errors) || [],
      bookMonth: pack && pack.reconcile ? pack.reconcile.bookMonth : '',
      included: pack && pack.reconcile ? (pack.reconcile.included || []).length : 0,
    },
    excel: {
      filename: pack ? pack.xlsName : '',
      airbnbRows: pack && pack.counts ? pack.counts.airbnb : 0,
      bookingRows: pack && pack.counts ? pack.counts.booking : 0,
      totalRows: pack && pack.counts ? pack.counts.total : 0,
    },
    emailed: emailPlan.sent || [],
    skipped: emailPlan.skipped || [],
    at: new Date().toISOString(),
  };
}

module.exports = {
  isAirbnbRow,
  isBookingRow,
  buildMonthPack,
  planAccountantEmails,
  buildAgentReport,
};
