'use strict';
/**
 * Booking.com host-invoice helpers (no Playwright).
 *
 * Document month M = invoices issued in M covering reservations in M−1.
 * One PDF per Booking property. Votsala 1–8 share one property / one PDF.
 * Filing key is bookingHotelId only — never apartment-name fuzzy match.
 */

const zlib = require('zlib');
const path = require('path');

const MONTH_NAMES_EN = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_NAMES_EL = [
  '',
  'Ιανουαρίου',
  'Φεβρουαρίου',
  'Μαρτίου',
  'Απριλίου',
  'Μαΐου',
  'Ιουνίου',
  'Ιουλίου',
  'Αυγούστου',
  'Σεπτεμβρίου',
  'Οκτωβρίου',
  'Νοεμβρίου',
  'Δεκεμβρίου',
];

const BOOKING_INVOICE_URLS = [
  'https://admin.booking.com/hotel/hoteladmin/groups/finance/invoices.html',
  'https://admin.booking.com/hotel/hoteladmin/groups/home/index.html',
  'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoices.html',
  'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/finance/invoice.html',
  'https://admin.booking.com/hotel/hoteladmin/finance/invoices.html',
  'https://admin.booking.com/hotel/hoteladmin/finance_invoices.html',
  'https://admin.booking.com/partner/finance/invoices',
  'https://admin.booking.com/',
];

function prevMonth(ym) {
  const p = String(ym || '').split('-');
  const y = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  if (!y || !m) return '';
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function ymFromDmy(s) {
  const str = String(s || '').trim();
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(parseInt(m[2], 10)).padStart(2, '0');
  m = str.match(/^(20\d{2})-(\d{2})(?:-\d{2})?/);
  if (m) return m[1] + '-' + m[2];
  return '';
}

function isBookingStay(b) {
  const plat = String((b && (b.platform || b.channel)) || '').toLowerCase();
  return plat.indexOf('book') >= 0;
}

function stayMonth(b) {
  const fromCheckIn = ymFromDmy((b && (b.checkIn || b.check_in || b.arrival)) || '');
  if (fromCheckIn) return fromCheckIn;
  const t = b && (b.createdOnChannel != null && b.createdOnChannel !== '' ? b.createdOnChannel : b.created);
  if (t == null || t === '') return '';
  const n = Number(t);
  if (isFinite(n) && n > 0) {
    const d = new Date(n < 1e12 ? n * 1000 : n);
    if (!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  const parsed = Date.parse(String(t));
  if (isFinite(parsed)) {
    const d = new Date(parsed);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  return '';
}

function findApt(b, apts) {
  const list = Array.isArray(apts) ? apts : [];
  const id = String((b && (b.aptId || b.apartmentId || b.id)) || '').trim();
  const name = String((b && (b.aptName || b.apartmentName || b.name)) || '').trim();
  if (id) {
    const hit = list.find((a) => a && (String(a.aptId || a.id || '') === id));
    if (hit) return hit;
  }
  if (name) {
    const hit = list.find((a) => a && String(a.aptName || a.name || '') === name);
    if (hit) return hit;
  }
  return null;
}

function isVotsalaApt(apt, fallbackName) {
  const g = String((apt && apt.clearGroup) || '').trim();
  if (/^votsala$/i.test(g)) return true;
  const name = String((apt && (apt.aptName || apt.name)) || fallbackName || '');
  return /^votsala\b/i.test(name);
}

function bookingBillingFolder(apt, fallbackName) {
  if (isVotsalaApt(apt, fallbackName)) return 'Votsala';
  return String((apt && (apt.aptName || apt.name)) || fallbackName || 'Apartment').trim() || 'Apartment';
}

function bookingBillingKey(b, apts) {
  const apt = findApt(b, apts);
  if (isVotsalaApt(apt, b && b.aptName)) return 'Votsala';
  const id = String((apt && (apt.aptId || apt.id)) || (b && b.aptId) || '').trim();
  if (id) return 'id:' + id;
  const name = String((apt && (apt.aptName || apt.name)) || (b && b.aptName) || '').trim();
  if (name) return 'name:' + name.toLowerCase();
  return 'unk:' + String((b && (b.id || b.reservationId || b.bookingId)) || '');
}

function estimateBookingInvoices(month, bks, apts) {
  const bookMonth = prevMonth(month);
  const byKey = {};
  let bookings = 0;
  (bks || []).forEach(function (b) {
    if (!isBookingStay(b)) return;
    if (b && b.cancelled) return;
    if (stayMonth(b) !== bookMonth) return;
    bookings += 1;
    const key = bookingBillingKey(b, apts);
    if (!byKey[key]) {
      const apt = findApt(b, apts);
      const folder = bookingBillingFolder(apt, (b && b.aptName) || key);
      byKey[key] = {
        key: key,
        aptId: key === 'Votsala' ? '' : String((apt && (apt.aptId || apt.id)) || (b && b.aptId) || '').trim(),
        aptName: folder,
        bookings: 0,
        bookingHotelId: String((apt && apt.bookingHotelId) || '').trim(),
      };
    }
    byKey[key].bookings += 1;
  });
  const units = Object.keys(byKey)
    .sort()
    .map(function (k) {
      return byKey[k];
    });
  return { apts: units, bookings: bookings, bookMonth: bookMonth, docs: units.length };
}

function normalizeHotelId(id) {
  const s = String(id || '').trim();
  const m = s.match(/(\d{5,10})/);
  return m ? m[1] : '';
}

function parseBookingHotelId(text) {
  const s = String(text || '');
  const patterns = [
    /hotel[_-]?id["'=\s:/]+(\d{5,10})/i,
    /property[_-]?id["'=\s:/]+(\d{5,10})/i,
    /(?:hotel|property)\s*id\s*[:#]?\s*(\d{5,10})/i,
    /unmapped-(\d{5,10})/i,
    /(?:^|[^\d])id[:\s]+(\d{5,10})(?:[^\d]|$)/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m) return m[1];
  }
  const file = s.match(/invoice-(\d{5,10})(?:-|\.|$)/i);
  if (file) return file[1];
  return '';
}

function parseBookingInvoiceNumber(text) {
  const s = String(text || '');
  const patterns = [
    /invoice\s*(?:number|no\.?|#)\s*[:.]?\s*([A-Z]{0,4}-?\d{5,14}(?:-[A-Z0-9]+)?)/i,
    /τιμολ[^\n]{0,20}(?:αριθ|no|#)[^\d]{0,8}(\d{5,14})/i,
    /\b(GR-?\d{6,14})\b/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m) return String(m[1]).replace(/\s+/g, '');
  }
  return '';
}

function parseBookingIssueDate(text) {
  const s = String(text || '');
  const dmy = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (dmy) return dmy[1] + '/' + dmy[2] + '/' + dmy[3];
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return String(parseInt(iso[3], 10)) + '/' + String(parseInt(iso[2], 10)) + '/' + iso[1];
  return '';
}

function parseBookingTotal(text) {
  const s = String(text || '');
  const m =
    s.match(/(?:total|amount|σύνολο)[^\d]{0,24}(?:EUR|€)?\s*([0-9]+[.,][0-9]{2})/i) ||
    s.match(/(?:EUR|€)\s*([0-9]+[.,][0-9]{2})/i);
  if (!m) return '';
  const n = parseFloat(String(m[1]).replace(',', '.'));
  return isFinite(n) ? n : '';
}

function pdfExtractText(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'binary');
  const s = raw.toString('latin1');
  const chunks = [];
  const re = /\((?:\\.|[^\\)]){2,160}\)/g;
  let m;
  while ((m = re.exec(s))) {
    chunks.push(
      m[0]
        .slice(1, -1)
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, ' ')
        .replace(/\\(.)/g, '$1')
    );
  }
  const compact = s.replace(/[^\x20-\x7E\u00A0-\u024F]/g, ' ').replace(/\s+/g, ' ');
  return (chunks.join(' ') + ' ' + compact).slice(0, 200000);
}

function parseBookingInvoiceFields(text) {
  const s = String(text || '');
  return {
    hotelId: parseBookingHotelId(s),
    invoiceNumber: parseBookingInvoiceNumber(s),
    issueDate: parseBookingIssueDate(s),
    total: parseBookingTotal(s),
  };
}

function looksLikePdf(buf) {
  if (!buf || !buf.length || buf.length < 8) return false;
  const head = Buffer.isBuffer(buf) ? buf.slice(0, 5).toString('latin1') : String(buf).slice(0, 5);
  return head === '%PDF-';
}

function looksLikeZip(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function isBookingStatementBlob(name, text) {
  const blob = (String(name || '') + ' ' + String(text || '')).trim();
  if (/\.xlsx?(\s|$|\?)/i.test(blob) || /\.csv(\s|$|\?)/i.test(blob)) return true;
  return /statement of account|reservation.?statement|finance overview|payout statement/i.test(blob);
}

function resolveBookingApt(hotelId, apts) {
  const id = normalizeHotelId(hotelId);
  if (!id) {
    return { mapped: false, folder: 'unmapped-unknown', aptName: 'unmapped-unknown', aptId: '', bookingHotelId: '', clearGroup: '' };
  }
  const hits = (apts || []).filter(function (a) {
    return normalizeHotelId(a && a.bookingHotelId) === id;
  });
  if (!hits.length) {
    return {
      mapped: false,
      folder: 'unmapped-' + id,
      aptName: 'unmapped-' + id,
      aptId: '',
      bookingHotelId: id,
      clearGroup: '',
    };
  }
  const votsala = hits.find(function (a) {
    return isVotsalaApt(a);
  });
  if (votsala || hits.every(function (a) { return isVotsalaApt(a); })) {
    return {
      mapped: true,
      folder: 'Votsala',
      aptName: 'Votsala',
      aptId: String((votsala || hits[0]).aptId || (votsala || hits[0]).id || ''),
      bookingHotelId: id,
      clearGroup: 'Votsala',
    };
  }
  const apt = hits[0];
  const name = String(apt.aptName || apt.name || '').trim() || 'Apartment';
  return {
    mapped: true,
    folder: name,
    aptName: name,
    aptId: String(apt.aptId || apt.id || ''),
    bookingHotelId: id,
    clearGroup: String(apt.clearGroup || '').trim(),
  };
}

function bookingInvoiceFilename(hotelId, invoiceNo) {
  const id = normalizeHotelId(hotelId) || 'unknown';
  const inv = String(invoiceNo || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return inv ? 'invoice-' + id + '-' + inv + '.pdf' : 'invoice-' + id + '.pdf';
}

function monthTokens(month) {
  const p = String(month || '').split('-');
  const y = p[0];
  const m = parseInt(p[1], 10);
  if (!y || !m) return [];
  const tokens = [
    month,
    y + '/' + String(m).padStart(2, '0'),
    String(m).padStart(2, '0') + '/' + y,
    String(m) + '/' + y,
    (MONTH_NAMES_EN[m] || '') + ' ' + y,
    (MONTH_NAMES_EL[m] || '') + ' ' + y,
  ];
  return tokens.filter(Boolean).map(function (t) {
    return t.toLowerCase();
  });
}

function invoiceMatchesMonth(row, month) {
  if (!month) return true;
  const tokens = monthTokens(month);
  const blob = String(
    (row && (row.period || row.month || row.date || row.text || row.label || '')) +
      ' ' +
      JSON.stringify(row || {})
  ).toLowerCase();
  if (!blob.trim() || blob === ' {}') return true;
  for (let i = 0; i < tokens.length; i++) {
    if (blob.indexOf(tokens[i]) >= 0) return true;
  }
  const p = String(month).split('-');
  const y = p[0];
  const m = parseInt(p[1], 10);
  if (blob.indexOf(y) >= 0 && blob.indexOf(String(m).padStart(2, '0')) >= 0) return true;
  return false;
}

function absUrl(href, pageUrl) {
  const h = String(href || '').trim();
  if (!h || h.charAt(0) === '#') return '';
  try {
    return new URL(h, pageUrl || 'https://admin.booking.com/').href;
  } catch (e) {
    return h;
  }
}

function listBookingInvoiceTargets(html, pageUrl, month) {
  const src = String(html || '');
  const seen = {};
  const out = [];
  function push(row) {
    const href = absUrl(row.href || row.url, pageUrl);
    const hotelId = normalizeHotelId(row.hotelId || parseBookingHotelId(href + ' ' + (row.text || '')));
    if (isBookingStatementBlob(href, row.text)) return;
    if (!href && !hotelId) return;
    if (month && row.text && !invoiceMatchesMonth(row, month) && !/pdf|invoice|download|τιμολ/i.test(href)) {
      return;
    }
    const key = (hotelId || '') + '|' + (href || '') + '|' + String(row.invoiceNo || '');
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      href: href,
      url: href,
      hotelId: hotelId,
      invoiceNo: String(row.invoiceNo || parseBookingInvoiceNumber(row.text || href) || ''),
      text: String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    });
  }

  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(src))) {
    const attrs = m[1] || '';
    const inner = String(m[2] || '').replace(/<[^>]+>/g, ' ');
    const hrefM = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    const href = hrefM ? hrefM[1] : '';
    const blob = (attrs + ' ' + href + ' ' + inner).toLowerCase();
    if (!/invoice|pdf|download|τιμολ|hotel_id/i.test(blob)) continue;
    if (/\.xlsx?|\.csv/.test(blob) && !/\.pdf/.test(blob)) continue;
    push({ href: href, text: inner + ' ' + href, hotelId: parseBookingHotelId(href + ' ' + inner) });
  }

  const hrefRe = /https?:\/\/[^"' \s>]+(?:invoice|pdf)[^"' \s>]*/gi;
  while ((m = hrefRe.exec(src))) {
    push({ href: m[0], text: m[0], hotelId: parseBookingHotelId(m[0]) });
  }
  return out;
}

function harvestBookingInvoicePayloads(obj, out, depth) {
  const sink = out || [];
  if (depth > 14 || obj == null) return sink;
  if (Array.isArray(obj)) {
    obj.forEach(function (x) {
      harvestBookingInvoicePayloads(x, sink, (depth || 0) + 1);
    });
    return sink;
  }
  if (typeof obj !== 'object') return sink;
  const hotelId = normalizeHotelId(obj.hotel_id || obj.hotelId || obj.property_id || obj.propertyId || obj.id);
  const url = obj.pdf_url || obj.pdfUrl || obj.download_url || obj.downloadUrl || obj.file_url || obj.fileUrl || obj.url || obj.href;
  const invoiceNo = obj.invoice_number || obj.invoiceNumber || obj.invoice_id || obj.invoiceId || obj.number;
  const period = obj.period || obj.month || obj.invoice_month || obj.invoiceMonth || obj.date;
  const urlStr = url != null ? String(url) : '';
  if (urlStr && /pdf|invoice|download/i.test(urlStr) && !isBookingStatementBlob(urlStr, '')) {
    sink.push({
      href: urlStr,
      url: urlStr,
      hotelId: hotelId,
      invoiceNo: invoiceNo != null ? String(invoiceNo) : '',
      text: String(period || ''),
      period: period != null ? String(period) : '',
    });
  }
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (v && typeof v === 'object') harvestBookingInvoicePayloads(v, sink, (depth || 0) + 1);
  });
  return sink;
}

function dedupeInvoiceTargets(rows, month) {
  const seen = {};
  const out = [];
  (rows || []).forEach(function (row) {
    if (month && row && (row.period || row.text) && !invoiceMatchesMonth(row, month)) return;
    const hotelId = normalizeHotelId(row && (row.hotelId || row.hotel_id));
    const href = String((row && (row.href || row.url)) || '');
    const key = hotelId ? 'id:' + hotelId : 'url:' + href;
    if (!hotelId && !href) return;
    if (seen[key]) {
      if (href && !seen[key].href) seen[key].href = href;
      return;
    }
    const rec = {
      href: href,
      url: href,
      hotelId: hotelId,
      invoiceNo: String((row && (row.invoiceNo || row.invoice_number)) || ''),
      text: String((row && (row.text || row.period)) || ''),
    };
    seen[key] = rec;
    out.push(rec);
  });
  return out;
}

function unzipPdfEntries(buf) {
  const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const out = [];
  let i = 0;
  while (i < zip.length - 30) {
    if (zip[i] !== 0x50 || zip[i + 1] !== 0x4b || zip[i + 2] !== 0x03 || zip[i + 3] !== 0x04) {
      const next = zip.indexOf(Buffer.from('PK\x03\x04'), i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }
    const method = zip.readUInt16LE(i + 8);
    const flags = zip.readUInt16LE(i + 6);
    if (flags & 0x08) break;
    const compSize = zip.readUInt32LE(i + 18);
    const nameLen = zip.readUInt16LE(i + 26);
    const extraLen = zip.readUInt16LE(i + 28);
    const name = zip.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const data = zip.slice(dataStart, dataStart + compSize);
    i = dataStart + compSize;
    if (!/\.pdf$/i.test(name) || name.charAt(0) === '_' || /\/__MACOSX\//i.test(name)) continue;
    let raw;
    try {
      if (method === 0) raw = data;
      else if (method === 8) raw = zlib.inflateRawSync(data);
      else continue;
    } catch (e) {
      continue;
    }
    if (!looksLikePdf(raw)) continue;
    out.push({ name: path.basename(name), buf: raw });
  }
  return out;
}

function bookingTooEarly(month, now) {
  const d = now || new Date();
  const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  if (String(month) !== ym) return false;
  return d.getDate() < 7;
}

function bookingCompleteness(expectApts, files) {
  const byFolder = {};
  (files || []).forEach(function (f) {
    if (String((f && f.channel) || '').toLowerCase() !== 'booking' && String((f && f.channel) || '').toLowerCase() !== 'bdc') {
      if (f && f.channel && String(f.channel).toLowerCase() !== 'booking') return;
    }
    const ch = String((f && f.channel) || '').toLowerCase();
    if (ch && ch !== 'booking' && ch !== 'bdc') return;
    const folder = String((f && (f.aptName || f.partner)) || '').trim();
    if (!folder) return;
    byFolder[folder] = (byFolder[folder] || 0) + 1;
  });
  const missing = [];
  const duplicates = [];
  (expectApts || []).forEach(function (a) {
    const name = String((a && a.aptName) || '').trim();
    if (!name) return;
    const n = byFolder[name] || 0;
    if (n === 0) missing.push(name);
    if (n > 1) duplicates.push({ aptName: name, n: n });
  });
  const unmapped = Object.keys(byFolder).filter(function (k) {
    return /^unmapped-/i.test(k);
  });
  return {
    ok: missing.length === 0 && unmapped.length === 0 && duplicates.length === 0,
    missing: missing,
    duplicates: duplicates,
    unmapped: unmapped,
    folders: byFolder,
  };
}

/**
 * Document month M covers Booking.com stays in M−1.
 * Include a vault PDF only when Hosthub has matching stays for that property.
 * Error when PDF exists without stays, or stays exist without a PDF.
 */
function reconcileBookingMonth(month, bks, apts, vaultRows) {
  const est = estimateBookingInvoices(month, bks, apts);
  const expectByFolder = {};
  (est.apts || []).forEach(function (a) {
    const name = String((a && a.aptName) || '').trim();
    if (!name) return;
    expectByFolder[name] = a;
  });

  const filesByFolder = {};
  (vaultRows || []).forEach(function (row) {
    const ch = String((row && row.channel) || '').toLowerCase();
    if (ch !== 'booking' && ch !== 'bdc') return;
    if (row.month && String(row.month) !== String(month) && String(month || '')) {
      // Prefer explicit month match when provided; still allow unscoped vault rows.
      if (String(row.month) !== String(month)) return;
    }
    const folder = String((row && (row.aptName || row.partner)) || '').trim();
    if (!folder) return;
    if (!filesByFolder[folder]) filesByFolder[folder] = [];
    filesByFolder[folder].push(row);
  });

  const included = [];
  const errors = [];
  const seenFolders = {};

  Object.keys(expectByFolder).forEach(function (folder) {
    seenFolders[folder] = true;
    const rows = filesByFolder[folder] || [];
    if (!rows.length) {
      errors.push({
        type: 'stays_without_invoice',
        channel: 'booking',
        aptName: folder,
        bookingHotelId: String((expectByFolder[folder] && expectByFolder[folder].bookingHotelId) || ''),
        bookings: Number((expectByFolder[folder] && expectByFolder[folder].bookings) || 0),
        message: 'Booking.com stays in ' + (est.bookMonth || '') + ' for ' + folder + ' but no invoice PDF in vault for ' + month,
      });
      return;
    }
    rows.forEach(function (row) {
      included.push(row);
    });
  });

  Object.keys(filesByFolder).forEach(function (folder) {
    if (seenFolders[folder]) return;
    if (/^unmapped-/i.test(folder)) {
      errors.push({
        type: 'invoice_without_stays',
        channel: 'booking',
        aptName: folder,
        message: 'Booking.com invoice folder ' + folder + ' has no Hosthub stays for ' + (est.bookMonth || '') + ' (unmapped hotel id)',
      });
      return;
    }
    errors.push({
      type: 'invoice_without_stays',
      channel: 'booking',
      aptName: folder,
      message: 'Booking.com invoice for ' + folder + ' in ' + month + ' but no Hosthub stays in ' + (est.bookMonth || ''),
    });
  });

  return {
    ok: errors.length === 0,
    month: month,
    bookMonth: est.bookMonth,
    expect: est,
    included: included,
    errors: errors,
  };
}

module.exports = {
  MONTH_NAMES_EN,
  MONTH_NAMES_EL,
  BOOKING_INVOICE_URLS,
  prevMonth,
  ymFromDmy,
  isBookingStay,
  stayMonth,
  findApt,
  isVotsalaApt,
  bookingBillingFolder,
  bookingBillingKey,
  estimateBookingInvoices,
  normalizeHotelId,
  parseBookingHotelId,
  parseBookingInvoiceNumber,
  parseBookingInvoiceFields,
  pdfExtractText,
  looksLikePdf,
  looksLikeZip,
  isBookingStatementBlob,
  resolveBookingApt,
  bookingInvoiceFilename,
  monthTokens,
  invoiceMatchesMonth,
  listBookingInvoiceTargets,
  harvestBookingInvoicePayloads,
  dedupeInvoiceTargets,
  unzipPdfEntries,
  bookingTooEarly,
  bookingCompleteness,
  reconcileBookingMonth,
};
