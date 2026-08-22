'use strict';
/**
 * Move vault PDFs off chrome labels (Today / Upcoming / Requests) and
 * unmapped-unknown Booking.com folders once hotel id / Hosthub apt is known.
 */
const booking = require('./platform-invoice-booking');
const { parseMeta } = require('./platform-invoice-accountant-xls');

function isPortalChromeLabel(name) {
  return booking.isPortalChromeLabel(name);
}

function rewriteFilenameApt(filename, folder) {
  const s = String(filename || '').replace(/\\/g, '/');
  const parts = s.split('/');
  if (parts.length >= 3) {
    const idx = /^\d{4}-\d{2}$/.test(parts[1]) ? 2 : parts.length - 2;
    if (idx >= 0 && idx < parts.length - 1) {
      parts[idx] = booking.aptStoreFolder(folder);
      return parts.join('/');
    }
  }
  return s;
}

function aptNameFromReservation(code, bks, apts) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  const hits = (bks || []).filter(function (b) {
    return String((b && b.reservationId) || '').trim().toUpperCase() === c;
  });
  if (!hits.length) return '';
  const name = String((hits[0] && hits[0].aptName) || '').trim();
  if (name && !isPortalChromeLabel(name)) return name;
  const aptId = String((hits[0] && hits[0].aptId) || '');
  const apt = (apts || []).find(function (a) {
    return a && String(a.id || a.aptId || '') === aptId;
  });
  return String((apt && (apt.name || apt.aptName)) || name || '').trim();
}

function planAirbnbChromeRefile(row, bks, apts) {
  if (!row || String(row.channel || '').toLowerCase() !== 'airbnb') return null;
  const partner = String(row.partner || '').trim();
  if (!isPortalChromeLabel(partner)) return null;
  const meta = parseMeta(row);
  const name = aptNameFromReservation(meta.reservationId, bks, apts);
  if (!name || isPortalChromeLabel(name)) return null;
  const filename = rewriteFilenameApt(row.filename, name);
  const nextMeta = Object.assign({}, meta, { listingName: name });
  return {
    partner: name,
    filename: filename,
    month: row.month,
    meta: nextMeta,
    metaJson: JSON.stringify(nextMeta),
  };
}

function planBookingPdfRefile(row, pdfBuf, apts) {
  if (!row) return null;
  const ch = String(row.channel || '').toLowerCase();
  if (ch !== 'booking' && ch !== 'bdc') return null;
  const partner = String(row.partner || '');
  const fname = String(row.filename || '');
  if (!/^unmapped-/i.test(partner) && !/unmapped-/i.test(fname)) return null;
  const text = booking.pdfExtractText(pdfBuf);
  const fields = booking.parseBookingInvoiceFields(text + ' ' + fname, apts);
  const hotelId = fields.hotelId || booking.parseBookingHotelId(fname) || booking.hotelIdFromKnownApts(text + ' ' + fname, apts) || '';
  const resolved = booking.resolveBookingApt(hotelId, apts);
  if (!resolved.mapped && resolved.folder === partner && !fields.invoiceNumber) return null;
  const fromIssue = booking.ymFromDmy(fields.issueDate);
  const month = fromIssue || row.month;
  const filename = booking.bookingStoreRel(
    month,
    resolved.folder,
    resolved.bookingHotelId || hotelId,
    fields.invoiceNumber,
    fname,
    pdfBuf ? booking.pdfShortHash(pdfBuf) : ''
  );
  const prev = parseMeta(row);
  const nextMeta = Object.assign({}, prev, {
    invoiceNumber: fields.invoiceNumber || prev.invoiceNumber || '',
    issueDate: fields.issueDate || prev.issueDate || '',
    total: fields.total !== '' && fields.total != null ? fields.total : prev.total,
    bookingHotelId: resolved.bookingHotelId || hotelId || prev.bookingHotelId || '',
    hotelId: resolved.bookingHotelId || hotelId || prev.hotelId || '',
    listingName: resolved.folder,
    reservationId: resolved.bookingHotelId || hotelId || prev.reservationId || '',
  });
  if (
    resolved.folder === partner &&
    filename === String(row.filename || '').replace(/\\/g, '/') &&
    String(month) === String(row.month || '')
  ) {
    return null;
  }
  return {
    partner: resolved.folder,
    filename: filename,
    month: month,
    meta: nextMeta,
    metaJson: JSON.stringify(nextMeta),
    mapped: !!resolved.mapped,
    bookingHotelId: resolved.bookingHotelId || hotelId,
  };
}

module.exports = {
  isPortalChromeLabel,
  rewriteFilenameApt,
  aptNameFromReservation,
  planAirbnbChromeRefile,
  planBookingPdfRefile,
};
