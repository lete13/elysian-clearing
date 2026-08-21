'use strict';
/**
 * Accountant import sheet (Greek bank/expense template):
 * A/A, Ημερομηνία, Αιτιολογία, Κατάστημα, Τοκισμός από, Αρ. συναλλαγής, Ποσό, Πρόσημο ποσού
 * then Reservation id, Listing name, Check-in, Check-out (stay identity; not part of the import block).
 */

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function issueDateToMonth(dmy) {
  const s = String(dmy || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(parseInt(m[2], 10)).padStart(2, '0');
  m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (m) return m[1] + '-' + m[2];
  return '';
}

function monthFromFilename(filename) {
  const m = String(filename || '')
    .replace(/\\/g, '/')
    .match(/\/(20\d{2}-\d{2})\//);
  return m ? m[1] : '';
}

function rewriteFilenameMonth(filename, month) {
  const m = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return String(filename || '').replace(/\\/g, '/');
  const s = String(filename || '').replace(/\\/g, '/');
  if (/^[^/]+\/\d{4}-\d{2}\//.test(s)) return s.replace(/^([^/]+)\/(\d{4}-\d{2})\//, '$1/' + m + '/');
  return s;
}

function archiveMonthOf(f, fallback) {
  const meta = parseMeta(f);
  const fromIssue = issueDateToMonth((meta && meta.issueDate) || (f && f.issueDate) || '');
  if (/^\d{4}-\d{2}$/.test(fromIssue)) return fromIssue;
  if (f && /^\d{4}-\d{2}$/.test(String(f.month || ''))) return String(f.month);
  const fromPath = monthFromFilename(f && f.filename);
  if (fromPath) return fromPath;
  return /^\d{4}-\d{2}$/.test(String(fallback || '')) ? String(fallback) : '';
}

function plannedRefile(row) {
  if (!row) return null;
  const ch = String(row.channel || '').toLowerCase();
  if (ch === 'booking' || ch === 'bdc') return null;
  const want = archiveMonthOf(row, row.month);
  if (!/^\d{4}-\d{2}$/.test(want)) return null;
  const filename = rewriteFilenameMonth(row.filename, want);
  if (want === String(row.month || '') && filename === String(row.filename || '').replace(/\\/g, '/')) return null;
  return { month: want, filename: filename };
}

function parseMeta(row) {
  if (!row) return {};
  if (row.meta && typeof row.meta === 'object' && !Buffer.isBuffer(row.meta)) return row.meta;
  try {
    if (row.meta) return JSON.parse(row.meta);
  } catch (e) {}
  return {
    invoiceNumber: row.invoiceNumber || '',
    issueDate: row.issueDate || '',
    total: row.total,
    sign: row.sign || '',
    reservationId: row.reservationId || '',
    listingName: row.listingName || row.aptName || '',
    checkIn: row.checkIn || '',
    checkOut: row.checkOut || '',
  };
}

function fallbackInvoiceNumber(row) {
  const leaf = String((row && row.filename) || '')
    .split('/')
    .pop() || '';
  const ch = String((row && row.channel) || '').toLowerCase();
  if (ch === 'booking' || ch === 'bdc') {
    const bdc = leaf.match(/invoice-(\d{5,10})(?:-([A-Za-z0-9._-]+))?(?:\.pdf)?$/i);
    if (bdc && bdc[2]) return bdc[2];
    if (bdc) return bdc[1];
  }
  const m = leaf.toUpperCase().match(/(?:INVOICE|CREDIT_NOTE)-[A-Z0-9]{6,20}(?:-([A-Z0-9._-]+?))?(?:\.PDF)?$/);
  if (m && m[1]) return m[1];
  return '';
}

function hotelIdFromBookingRow(row) {
  const meta = parseMeta(row);
  if (meta.hotelId || meta.bookingHotelId) return String(meta.hotelId || meta.bookingHotelId).trim();
  const leaf = String((row && row.filename) || '')
    .split('/')
    .pop() || '';
  const m = leaf.match(/invoice-(\d{5,10})/i);
  if (m) return m[1];
  const folder = String((row && (row.aptName || row.partner)) || '');
  const u = folder.match(/^unmapped-(\d{5,10})$/i);
  return u ? u[1] : '';
}

function accountantRow(row, byCode) {
  const meta = parseMeta(row);
  const ch = String((row && row.channel) || '').toLowerCase();
  const isBooking = ch === 'booking' || ch === 'bdc';
  const invoiceNumber = String(meta.invoiceNumber || fallbackInvoiceNumber(row) || '').trim();
  const issueDate = String(meta.issueDate || '').trim();
  let total = meta.total;
  if (total === '' || total == null) total = '';
  else {
    const n = Number(total);
    total = isFinite(n) ? Math.round(n * 100) / 100 : total;
  }
  const sign = meta.sign === '-' || (typeof total === 'number' && total < 0) ? '-' : '';
  if (typeof total === 'number') total = Math.abs(total);
  const creditFile = /credit/i.test(String((row && row.filename) || '')) || String((row && row.kind) || '') === 'credit_note';
  const outSign = sign || (creditFile ? '-' : '');
  let code = String(meta.reservationId || row.reservationId || codeFromFilename(row) || '')
    .trim()
    .toUpperCase();
  if (isBooking) {
    code = String(meta.reservationId || row.reservationId || hotelIdFromBookingRow(row) || '').trim();
  }
  const bk = !isBooking && byCode && code ? byCode[code] : null;
  const listingName = String(
    meta.listingName ||
      (bk && bk.aptName) ||
      (row && row.aptName) ||
      (row && row.partner && String(row.partner).toLowerCase() !== 'credit_note' ? row.partner : '') ||
      listingFromFilename(row) ||
      ''
  ).trim();
  const checkIn = isBooking ? '' : String(meta.checkIn || (bk && bk.checkIn) || row.checkIn || '').trim();
  const checkOut = String(meta.checkOut || (bk && bk.checkOut) || row.checkOut || '').trim();
  return {
    issueDate: issueDate,
    invoiceNumber: invoiceNumber,
    total: total,
    sign: outSign,
    reservationId: code,
    listingName: listingName,
    checkIn: isBooking ? '' : checkIn,
    checkOut: isBooking ? '' : checkOut,
    channel: isBooking ? 'booking' : 'airbnb',
  };
}

function issueDateKey(dmy) {
  const m = String(dmy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return Date.UTC(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

function buildAccountantXls(rows, bks) {
  const headers = [
    'A/A',
    'Ημερομηνία',
    'Αιτιολογία',
    'Κατάστημα',
    'Τοκισμός από',
    'Αρ. συναλλαγής',
    'Ποσό',
    'Πρόσημο ποσού',
    'Reservation id',
    'Listing name',
    'Check-in',
    'Check-out',
  ];
  const byCode = indexBookings(bks);
  const recs = [];
  (rows || []).forEach((row) => {
    if (String((row && row.channel) || '').toLowerCase() === 'booking') return;
    const rec = accountantRow(row, byCode);
    if (!rec.invoiceNumber && rec.total === '' && !rec.issueDate) return;
    recs.push(rec);
  });
  recs.sort((a, b) => issueDateKey(a.issueDate) - issueDateKey(b.issueDate) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<?mso-application progid="Excel.Sheet"?>');
  lines.push(
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
  );
  lines.push('<Worksheet ss:Name="Airbnb VAT"><Table>');
  lines.push(
    '<Row>' +
      headers.map((h) => '<Cell><Data ss:Type="String">' + xmlEscape(h) + '</Data></Cell>').join('') +
      '</Row>'
  );
  recs.forEach((rec, i) => {
    const n = i + 1;
    const cells = [
      n,
      rec.issueDate,
      rec.invoiceNumber,
      '',
      rec.issueDate,
      '',
      rec.total,
      rec.sign,
      rec.reservationId,
      rec.listingName,
      rec.checkIn,
      rec.checkOut,
    ];
    lines.push(
      '<Row>' +
        cells
          .map((c, i) => {
            const asNum = (i === 0 || i === 6) && c !== '' && /^-?\d+(\.\d+)?$/.test(String(c));
            return (
              '<Cell><Data ss:Type="' +
              (asNum ? 'Number' : 'String') +
              '">' +
              xmlEscape(c) +
              '</Data></Cell>'
            );
          })
          .join('') +
        '</Row>'
    );
  });
  lines.push('</Table></Worksheet></Workbook>');
  return Buffer.from(lines.join(''), 'utf8');
}

function fileMetaJson(f) {
  return JSON.stringify({
    invoiceNumber: f && f.invoiceNumber ? String(f.invoiceNumber) : '',
    issueDate: f && f.issueDate ? String(f.issueDate) : '',
    total: f && f.total != null && f.total !== '' ? f.total : '',
    sign: f && f.sign === '-' ? '-' : '',
    reservationId: f && (f.reservationId || f.code) ? String(f.reservationId || f.code) : '',
    listingName: f && (f.listingName || f.aptName) ? String(f.listingName || f.aptName) : '',
    checkIn: f && f.checkIn ? String(f.checkIn) : '',
    checkOut: f && f.checkOut ? String(f.checkOut) : '',
    vatId: f && f.vatId ? String(f.vatId) : '',
    kind: f && f.kind ? String(f.kind) : '',
  });
}

module.exports = {
  xmlEscape,
  parseMeta,
  accountantRow,
  buildAccountantXls,
  fileMetaJson,
  codeFromFilename,
  issueDateToMonth,
  monthFromFilename,
  rewriteFilenameMonth,
  archiveMonthOf,
  plannedRefile,
};
