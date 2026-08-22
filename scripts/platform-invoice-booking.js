'use strict';
/**
 * Booking.com host-invoice helpers (no Playwright).
 *
 * Document month M = invoices issued in M covering reservations in M−1.
 * One PDF per Booking property. Votsala 1–8 share one property / one PDF.
 * Filing key is bookingHotelId only — never apartment-name fuzzy match.
 * Mapping IDs onto Configuration (matchBookingProperties) may use names;
 * invoice filing still keys only on bookingHotelId.
 */

const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');

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

const BOOKING_PROPERTY_URLS = [
  'https://admin.booking.com/hotel/hoteladmin/groups/home/index.html',
  'https://admin.booking.com/hotel/hoteladmin/groups/home/properties.html',
  'https://admin.booking.com/hotel/hoteladmin/groups/home.html',
  'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html',
  'https://admin.booking.com/hotel/hoteladmin/groups/finance/invoices.html',
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

/**
 * Booking.com generates the monthly commission invoice for reservations that
 * DEPARTED (checked out) in that month, so a 31 May → 4 June stay is on the
 * invoice issued in July. Bill month = check-out month, check-in as fallback.
 */
function bookingBillMonth(b) {
  const fromCheckOut = ymFromDmy((b && (b.checkOut || b.check_out || b.departure)) || '');
  if (fromCheckOut) return fromCheckOut;
  return stayMonth(b);
}

function estimateBookingInvoices(month, bks, apts) {
  const bookMonth = prevMonth(month);
  const byKey = {};
  let bookings = 0;
  (bks || []).forEach(function (b) {
    if (!isBookingStay(b)) return;
    if (b && b.cancelled) return;
    if (bookingBillMonth(b) !== bookMonth) return;
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
    /accommodation\s*(?:number|no\.?|#|id)\s*[:.]?\s*(\d{5,10})/i,
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

function hotelIdFromKnownApts(text, apts) {
  const s = String(text || '');
  if (!s || !Array.isArray(apts) || !apts.length) return '';
  const ids = {};
  apts.forEach(function (a) {
    const id = normalizeHotelId(a && a.bookingHotelId);
    if (id) ids[id] = true;
  });
  const known = Object.keys(ids).sort(function (a, b) {
    return b.length - a.length;
  });
  for (let i = 0; i < known.length; i++) {
    const id = known[i];
    const re = new RegExp('(?:^|[^0-9])' + id + '(?:[^0-9]|$)');
    if (re.test(s)) return id;
  }
  return '';
}

function parseBookingInvoiceNumber(text) {
  const s = String(text || '');
  const patterns = [
    /invoice\s*(?:number|no\.?|#)\s*[:.]?\s*([A-Z]{0,4}-?\d{5,14}(?:-[A-Z0-9]+)?)/i,
    /τιμολ[^\n]{0,20}(?:αριθ|no|#)[^\d]{0,8}(\d{5,14})/i,
    /\b(GR-?\d{6,14})\b/i,
    /\[(\d{8,14})\]/,
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

function pdfUnescapeLiteral(inner) {
  return String(inner || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([0-7]{1,3})/g, function (_, oct) {
      return String.fromCharCode(parseInt(oct, 8));
    })
    .replace(/\\(.)/g, '$1');
}

function pdfLooksLikeText(s) {
  const t = String(s || '');
  if (t.length < 2) return false;
  let ok = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 10 || c === 13 || (c >= 160 && c < 0xd800)) ok += 1;
  }
  return ok / t.length >= 0.8;
}

function pdfHexToStr(hex) {
  const h = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  if (h.length % 4 === 0 && h.length >= 4) {
    for (let i = 0; i < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  }
  if (h.length % 2 === 0 && h.length >= 2) {
    for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return out;
  }
  return h ? String.fromCharCode(parseInt(h, 16)) : '';
}

function pdfParseToUnicode(src) {
  const map = {};
  function eatBlock(kind) {
    const re = new RegExp('begin' + kind + '([\\s\\S]*?)end' + kind, 'gi');
    let block;
    while ((block = re.exec(src))) {
      const body = block[1];
      if (kind === 'bfrange') {
        const triple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        let m;
        while ((m = triple.exec(body))) {
          const start = parseInt(m[1], 16);
          const end = parseInt(m[2], 16);
          const first = pdfHexToStr(m[3]);
          const base = first ? first.charCodeAt(0) : parseInt(m[3], 16);
          for (let cid = start; cid <= end; cid++) {
            map[cid] = String.fromCharCode(base + (cid - start));
          }
        }
      } else {
        const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        let m;
        while ((m = pair.exec(body))) {
          map[parseInt(m[1], 16)] = pdfHexToStr(m[2]);
        }
      }
    }
  }
  eatBlock('bfrange');
  eatBlock('bfchar');
  return map;
}

function pdfMergeCmaps(maps) {
  const out = {};
  (maps || []).forEach(function (m) {
    Object.keys(m || {}).forEach(function (k) {
      if (m[k]) out[k] = m[k];
    });
  });
  return out;
}

function pdfInflateBytes(buf) {
  if (!buf || !buf.length) return null;
  try {
    return zlib.inflateSync(buf);
  } catch (e1) {}
  try {
    return zlib.inflateRawSync(buf);
  } catch (e2) {}
  return null;
}

function pdfInflatedStreams(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let data = Buffer.from(s.slice(start, end), 'latin1');
    if (data.length && data[data.length - 1] === 0x0a) {
      data = data.slice(0, data[data.length - 2] === 0x0d ? -2 : -1);
    }
    const inflated = pdfInflateBytes(data);
    if (inflated) out.push(inflated);
  }
  return out;
}

function pdfMapCidBytes(latin1, cmap) {
  const buf = Buffer.from(String(latin1 || ''), 'latin1');
  const hasMap = cmap && Object.keys(cmap).length;
  if (hasMap) {
    let out = '';
    if (buf.length >= 2 && buf.length % 2 === 0) {
      for (let i = 0; i < buf.length; i += 2) {
        const cid = (buf[i] << 8) | buf[i + 1];
        if (Object.prototype.hasOwnProperty.call(cmap, cid)) out += cmap[cid];
        else if (Object.prototype.hasOwnProperty.call(cmap, buf[i + 1])) out += cmap[buf[i + 1]];
      }
      if (out.replace(/\s+/g, '').length) return out;
    }
    out = '';
    for (let i = 0; i < buf.length; i++) {
      if (Object.prototype.hasOwnProperty.call(cmap, buf[i])) out += cmap[buf[i]];
    }
    if (out.replace(/\s+/g, '').length) return out;
  }
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let be = true;
    for (let i = 0; i < buf.length; i += 2) {
      if (buf[i] !== 0) {
        be = false;
        break;
      }
    }
    if (be) {
      let t = '';
      for (let i = 1; i < buf.length; i += 2) t += String.fromCharCode(buf[i]);
      return t;
    }
  }
  return buf.toString('latin1');
}

function pdfPushDecoded(chunks, text) {
  const t = String(text || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
  if (t && pdfLooksLikeText(t)) chunks.push(t);
}

function pdfCollectTj(content, cmap, chunks) {
  const s = String(content || '');
  const litRe = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  let m;
  while ((m = litRe.exec(s))) {
    const inner = m[0].replace(/\)\s*Tj$/i, '').slice(1);
    pdfPushDecoded(chunks, pdfMapCidBytes(pdfUnescapeLiteral(inner), cmap));
  }
  const hexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  while ((m = hexRe.exec(s))) {
    const hex = String(m[1] || '').replace(/\s+/g, '');
    const bytes = hex.replace(/[^0-9A-Fa-f]/g, '');
    let raw = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) raw += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    pdfPushDecoded(chunks, pdfMapCidBytes(raw, cmap));
  }
  const tjRe = /\[([\s\S]*?)\]\s*TJ/g;
  while ((m = tjRe.exec(s))) {
    const body = m[1] || '';
    const parts = body.match(/\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>/g) || [];
    parts.forEach(function (p) {
      if (p.charAt(0) === '(') {
        pdfPushDecoded(chunks, pdfMapCidBytes(pdfUnescapeLiteral(p.slice(1, -1)), cmap));
        return;
      }
      const bytes = String(p).replace(/[<>\s]/g, '');
      let raw = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) raw += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
      pdfPushDecoded(chunks, pdfMapCidBytes(raw, cmap));
    });
  }
}

function pdfExtractText(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'binary');
  const s = raw.toString('latin1');
  const chunks = [];
  const streams = pdfInflatedStreams(raw);
  const cmaps = [];
  streams.forEach(function (st) {
    const t = st.toString('latin1');
    if (/beginbfchar|beginbfrange/i.test(t)) cmaps.push(pdfParseToUnicode(t));
  });
  const cmap = pdfMergeCmaps(cmaps);
  streams.forEach(function (st) {
    pdfCollectTj(st.toString('latin1'), cmap, chunks);
  });
  const litRe = /\((?:\\.|[^\\)]){2,500}\)/g;
  let m;
  while ((m = litRe.exec(s))) {
    const inner = pdfUnescapeLiteral(m[0].slice(1, -1));
    if (pdfLooksLikeText(inner)) pdfPushDecoded(chunks, inner);
  }
  return chunks.join(' ').replace(/\s+/g, ' ').slice(0, 200000);
}

function parseBookingInvoiceFields(text, apts) {
  const s = String(text || '');
  return {
    hotelId: parseBookingHotelId(s) || hotelIdFromKnownApts(s, apts),
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

function isBookingInvoiceBlob(name, text) {
  const blob = (String(name || '') + ' ' + String(text || '')).trim();
  if (!blob) return false;
  if (parseBookingHotelId(blob) || parseBookingInvoiceNumber(blob)) return true;
  return /accommodation\s*(?:number|no\.?|#|id)|invoice\s*(?:number|no\.?|#)|\btotal amount due\b/i.test(blob);
}

function isBookingStatementBlob(name, text) {
  const file = String(name || '');
  const blob = (file + ' ' + String(text || '')).trim();
  if (/\.xlsx?(\s|$|\?)/i.test(blob) || /\.csv(\s|$|\?)/i.test(blob)) return true;
  // Host invoices mention "Reservation Statements" in the footer and
  // "Commission Reservations" as a line item. Those are invoices.
  if (isBookingInvoiceBlob(file, text)) return false;
  return /statement of account|(?:^|[^\w])reservation statements?(?:[^\w]|$)|finance overview|payout statement/i.test(
    blob
  );
}

function isPortalChromeLabel(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return /^(today|upcoming|requests?|reservations?|inbox|calendar|listings?|hosting|search|messages?|performance|insights|earnings|checking out|currently hosting|arriving soon)$/.test(
    n
  );
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

function pdfShortHash(buf) {
  return crypto
    .createHash('sha1')
    .update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || ''))
    .digest('hex')
    .slice(0, 10);
}

function zipLeafToken(zipName) {
  const s = String(zipName || '').replace(/\\/g, '/');
  return path
    .basename(s)
    .replace(/\.pdf$/i, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function bookingInvoiceFilename(hotelId, invoiceNo, zipName, contentKey) {
  const id = normalizeHotelId(hotelId) || 'unknown';
  const inv = String(invoiceNo || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (inv) return 'invoice-' + id + '-' + inv + '.pdf';
  if (id !== 'unknown') return 'invoice-' + id + '.pdf';
  const leaf = zipLeafToken(zipName);
  const extra = String(contentKey || '')
    .replace(/[^\w]+/g, '')
    .slice(0, 10);
  if (leaf && extra && /^invoice$/i.test(leaf)) return 'invoice-unknown-' + extra + '.pdf';
  if (leaf && extra) return 'invoice-unknown-' + leaf + '-' + extra + '.pdf';
  if (leaf) return 'invoice-unknown-' + leaf + '.pdf';
  if (extra) return 'invoice-unknown-' + extra + '.pdf';
  return 'invoice-unknown.pdf';
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

function zipSkipEntry(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.charAt(n.length - 1) === '/') return true;
  if (!/\.pdf$/i.test(n)) return true;
  if (n.charAt(0) === '_' || /(^|\/)__MACOSX\//i.test(n)) return true;
  return false;
}

function zipInflate(method, data) {
  if (!data) return null;
  try {
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
  } catch (e) {
    return null;
  }
  return null;
}

function unzipFromCentralDirectory(zip) {
  let eocd = -1;
  const min = Math.max(0, zip.length - 22 - 65535);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > zip.length) return null;
  const nEntries = zip.readUInt16LE(eocd + 10);
  const cdOff = zip.readUInt32LE(eocd + 16);
  if (!nEntries || cdOff + 46 > zip.length) return [];
  const out = [];
  let p = cdOff;
  for (let n = 0; n < nEntries && p + 46 <= zip.length; n++) {
    if (zip[p] !== 0x50 || zip[p + 1] !== 0x4b || zip[p + 2] !== 0x01 || zip[p + 3] !== 0x02) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p = p + 46 + nameLen + extraLen + commentLen;
    if (zipSkipEntry(name) || !compSize) continue;
    if (localOff + 30 > zip.length) continue;
    const locNameLen = zip.readUInt16LE(localOff + 26);
    const locExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + locNameLen + locExtraLen;
    const data = zip.slice(dataStart, dataStart + compSize);
    const raw = zipInflate(method, data);
    if (!raw || !looksLikePdf(raw)) continue;
    out.push({ name: path.basename(name), zipPath: String(name).replace(/\\/g, '/'), buf: raw });
  }
  return out;
}

function unzipFromLocalHeaders(zip) {
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
    const compSize = zip.readUInt32LE(i + 18);
    const nameLen = zip.readUInt16LE(i + 26);
    const extraLen = zip.readUInt16LE(i + 28);
    const name = zip.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    if (flags & 0x08 || !compSize) {
      i = dataStart;
      continue;
    }
    const data = zip.slice(dataStart, dataStart + compSize);
    i = dataStart + compSize;
    if (zipSkipEntry(name)) continue;
    const raw = zipInflate(method, data);
    if (!raw || !looksLikePdf(raw)) continue;
    out.push({ name: path.basename(name), zipPath: String(name).replace(/\\/g, '/'), buf: raw });
  }
  return out;
}

function unzipPdfEntries(buf) {
  const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const fromCd = unzipFromCentralDirectory(zip);
  if (fromCd && fromCd.length) return fromCd;
  const fromLocal = unzipFromLocalHeaders(zip);
  if (fromLocal.length) return fromLocal;
  return fromCd || fromLocal;
}

function aptStoreFolder(name) {
  const s = String(name || 'Apartment')
    .replace(/[\\/]+/g, ' ')
    .replace(/[^\w.\-\u00C0-\u024F\u0370-\u03FF ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || 'Apartment').slice(0, 60);
}

function bookingStoreRel(month, folder, hotelId, invoiceNo, zipName, contentKey) {
  const ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : 'unknown';
  return (
    'Booking.com/' +
    ym +
    '/' +
    aptStoreFolder(folder) +
    '/' +
    bookingInvoiceFilename(hotelId, invoiceNo, zipName, contentKey)
  );
}

function monthFromFilenameBlob(name) {
  const s = String(name || '');
  const iso = s.match(/(20\d{2})-(\d{2})/);
  if (iso) {
    const m = parseInt(iso[2], 10);
    if (m >= 1 && m <= 12) return iso[1] + '-' + iso[2];
  }
  for (let m = 1; m <= 12; m++) {
    const en = MONTH_NAMES_EN[m];
    const el = MONTH_NAMES_EL[m];
    if (!en) continue;
    const re = new RegExp('(?:' + en + (el ? '|' + el : '') + ')[\\s._-]+(20\\d{2})', 'i');
    const hit = s.match(re);
    if (hit) return hit[1] + '-' + String(m).padStart(2, '0');
  }
  return '';
}

function bookingZipDupKey(file) {
  const hotel = normalizeHotelId(file && (file.bookingHotelId || file.hotelId));
  const inv = String((file && file.invoiceNumber) || '').trim();
  if (hotel && inv) return 'inv:' + hotel + '|' + inv;
  const zip = String((file && file.zipName) || '').replace(/\\/g, '/').trim();
  if (zip) return 'zip:' + zip;
  return 'file:' + String((file && file.filename) || '').replace(/\\/g, '/');
}

function categorizeBookingZip(buf, apts, fallbackMonth) {
  const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (!looksLikeZip(zip)) {
    return { ok: false, error: 'Not a zip file', files: [], skipped: [], unmapped: [], months: [] };
  }
  const entries = unzipPdfEntries(zip);
  const files = [];
  const skipped = [];
  const monthSet = {};
  entries.forEach(function (ent) {
    const text = pdfExtractText(ent.buf);
    if (isBookingStatementBlob(ent.name, text)) {
      skipped.push({ name: ent.name, reason: 'statement' });
      return;
    }
    const fields = parseBookingInvoiceFields(text + ' ' + ent.name, apts);
    const hotelId = fields.hotelId || parseBookingHotelId(ent.name) || '';
    const fromIssue = ymFromDmy(fields.issueDate);
    const fromName = monthFromFilenameBlob(ent.name);
    let month = fromIssue || fromName;
    let usedFallbackMonth = false;
    if (!/^\d{4}-\d{2}$/.test(month) && /^\d{4}-\d{2}$/.test(String(fallbackMonth || ''))) {
      month = String(fallbackMonth);
      usedFallbackMonth = true;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      skipped.push({ name: ent.name, reason: 'no-month', hotelId: hotelId });
      return;
    }
    const resolved = resolveBookingApt(hotelId, apts);
    const invoiceNo = fields.invoiceNumber || '';
    const zipName = ent.zipPath || ent.name;
    const filename = bookingStoreRel(
      month,
      resolved.folder,
      resolved.bookingHotelId || hotelId,
      invoiceNo,
      zipName,
      pdfShortHash(ent.buf)
    );
    monthSet[month] = true;
    files.push({
      zipName: zipName,
      buf: ent.buf,
      bytes: ent.buf.length,
      channel: 'booking',
      kind: 'invoice',
      scope: 'leased',
      partner: resolved.folder,
      aptName: resolved.folder,
      aptId: resolved.aptId,
      bookingHotelId: resolved.bookingHotelId || hotelId,
      mapped: !!resolved.mapped,
      invoiceNumber: invoiceNo,
      issueDate: fields.issueDate || '',
      total: fields.total,
      reservationId: resolved.bookingHotelId || hotelId,
      listingName: resolved.folder,
      month: month,
      usedFallbackMonth: usedFallbackMonth,
      filename: filename,
      source: 'upload',
    });
  });
  const unmapped = [];
  const seenUn = {};
  files.forEach(function (f) {
    if (f.mapped) return;
    const id = f.bookingHotelId || f.partner;
    if (!id || seenUn[id]) return;
    seenUn[id] = true;
    unmapped.push(id);
  });
  return {
    ok: true,
    files: files,
    skipped: skipped,
    unmapped: unmapped,
    months: Object.keys(monthSet).sort(),
  };
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
 * Document month M covers Booking.com departures (check-outs) in M−1,
 * matching how Booking.com generates its monthly commission invoices.
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
    if (month && row.month && String(row.month) !== String(month)) return;
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
        message: 'Booking.com departures in ' + (est.bookMonth || '') + ' for ' + folder + ' but no invoice PDF in vault for ' + month,
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
        message: 'Booking.com invoice folder ' + folder + ' has no Hosthub departures for ' + (est.bookMonth || '') + ' (unmapped hotel id)',
      });
      return;
    }
    errors.push({
      type: 'invoice_without_stays',
      channel: 'booking',
      aptName: folder,
      message: 'Booking.com invoice for ' + folder + ' in ' + month + ' but no Hosthub departures in ' + (est.bookMonth || ''),
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

function normBookingName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bookingUnitNumber(norm) {
  const n = String(norm || '');
  const named = n.match(/\b(?:votsala|veranda)\s+(\d)\b/);
  if (named) return named[1];
  const trail = n.match(/\b(\d)\s*$/);
  return trail ? trail[1] : '';
}

function isVotsalaPropertyName(name) {
  const n = normBookingName(name);
  if (!n || !/^votsala\b/.test(n)) return false;
  return !/\bvotsala\s+\d\b/.test(n);
}

function bookingNameTokens(norm) {
  const skip = {
    apartment: 1, apartments: 1, luxury: 1, stay: 1, with: 1, patio: 1, deluxe: 1,
    modern: 1, elegant: 1, studio: 1, balcony: 1, the: 1, and: 1, near: 1, city: 1,
    center: 1, centre: 1, athens: 1, piraeus: 1, urban: 1, escape: 1, retreat: 1,
    house: 1, home: 1, small: 1, family: 1, apt: 1, in: 1, of: 1, elysian: 1,
  };
  return String(norm || '')
    .split(' ')
    .filter(function (t) {
      return t.length >= 3 && !skip[t];
    });
}

function bookingNameScore(propName, aptName) {
  const p = normBookingName(propName);
  const a = normBookingName(aptName);
  if (!p || !a) return 0;
  const pn = bookingUnitNumber(p);
  const an = bookingUnitNumber(a);
  if (pn && an && pn !== an) return 0;
  if (p === a) return 100;
  if (a.indexOf(p) === 0) {
    const suffix = a.slice(p.length).trim();
    if (/^\d/.test(suffix)) return 0;
    if (p.length >= 6) return 80;
  }
  if (p.indexOf(a) === 0) {
    const suffix = p.slice(a.length).trim();
    if (/^\d/.test(suffix)) return 0;
    if (a.length >= 6) return 80;
  }
  const pt = bookingNameTokens(p);
  const at = bookingNameTokens(a);
  if (!pt.length || !at.length) return 0;
  const overlap = pt.filter(function (t) {
    return at.indexOf(t) >= 0;
  });
  if (!overlap.length) return 0;
  if (overlap.length === pt.length || overlap.length === at.length) {
    if (pt.length === 1 && overlap[0].length >= 5) return 70;
    if (overlap.length >= 2) return 65;
    if (overlap[0].length >= 7) return 60;
  }
  if (overlap.length >= 2) return 50;
  return 0;
}

function propertyNameFromObj(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(
    obj.name ||
      obj.hotel_name ||
      obj.hotelName ||
      obj.property_name ||
      obj.propertyName ||
      obj.title ||
      obj.label ||
      obj.hotel_name_en ||
      ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function harvestBookingProperties(obj, out, depth) {
  const sink = out || [];
  if ((depth || 0) > 16 || obj == null) return sink;
  if (Array.isArray(obj)) {
    obj.forEach(function (x) {
      harvestBookingProperties(x, sink, (depth || 0) + 1);
    });
    return sink;
  }
  if (typeof obj !== 'object') return sink;
  const hotelId = normalizeHotelId(
    obj.hotel_id || obj.hotelId || obj.property_id || obj.propertyId || obj.hotelid
  );
  const name = propertyNameFromObj(obj);
  if (hotelId) sink.push({ hotelId: hotelId, name: name });
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (v && typeof v === 'object') harvestBookingProperties(v, sink, (depth || 0) + 1);
  });
  return sink;
}

function listBookingPropertiesFromDom() {
  var out = [];
  function push(id, name) {
    var hid = String(id || '').match(/(\d{5,10})/);
    if (!hid) return;
    var n = String(name || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    if (/^https?:/i.test(n) || n.length < 2) n = '';
    out.push({ hotelId: hid[1], name: n });
  }
  var nodes = document.querySelectorAll(
    'option[value], a[href], [data-hotel-id], [data-hotelid], [data-property-id], input[name="hotel_id"], input[name="hotelId"]'
  );
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var href = el.getAttribute('href') || el.getAttribute('data-href') || '';
    var val = el.value || '';
    var hid =
      el.getAttribute('data-hotel-id') ||
      el.getAttribute('data-hotelid') ||
      el.getAttribute('data-property-id') ||
      '';
    var text = (el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'OPTION' || tag === 'INPUT') push(val || hid, text || el.getAttribute('aria-label') || '');
    else if (hid) push(hid, text);
    else {
      var blob = href + ' ' + val;
      var m = blob.match(/hotel[_-]?id=(\d{5,10})/i) || blob.match(/property[_-]?id=(\d{5,10})/i);
      if (m) push(m[1], text);
    }
  }
  return out;
}

function collectBookingPropertyRows(parts) {
  const rows = [];
  function add(list) {
    (list || []).forEach(function (row) {
      rows.push(row);
    });
  }
  if (parts && parts.html) add(listBookingPropertiesFromHtml(parts.html));
  if (parts && parts.json != null) add(harvestBookingProperties(parts.json));
  add(parts && parts.dom);
  add(parts && parts.rows);
  return dedupeBookingProperties(rows);
}

async function scrapeBookingProperties(page, opts) {
  const urls = (opts && opts.urls) || BOOKING_PROPERTY_URLS;
  const waitMs = opts && opts.waitMs != null ? opts.waitMs : 1800;
  const harvested = [];
  const onResp = function (res) {
    Promise.resolve()
      .then(async function () {
        try {
          const headers = (res && res.headers && res.headers()) || {};
          const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
          const url = String((res && res.url && res.url()) || '');
          if (ct.indexOf('json') < 0 && !/\.json(\?|$)/i.test(url)) return;
          if (url && !/booking\.com/i.test(url)) return;
          const text = await res.text();
          if (text && text.length > 8 && text.length < 8e6) {
            harvestBookingProperties(JSON.parse(text), harvested);
          }
        } catch (eTap) {}
      })
      .catch(function () {});
  };
  if (page && typeof page.on === 'function') page.on('response', onResp);
  try {
    for (let i = 0; i < urls.length; i++) {
      if (page && typeof page.goto === 'function') {
        await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(function () {
          return null;
        });
      }
      if (page && typeof page.waitForTimeout === 'function' && waitMs) await page.waitForTimeout(waitMs);
      if (opts && typeof opts.afterGoto === 'function') {
        const stop = await opts.afterGoto(page, urls[i]);
        if (stop) break;
      }
      const html =
        page && typeof page.content === 'function'
          ? await page.content().catch(function () {
              return '';
            })
          : '';
      if (html) listBookingPropertiesFromHtml(html).forEach(function (row) { harvested.push(row); });
      if (page && typeof page.evaluate === 'function') {
        const fromDom = await page.evaluate(listBookingPropertiesFromDom).catch(function () {
          return [];
        });
        (fromDom || []).forEach(function (row) {
          harvested.push(row);
        });
      }
    }
  } finally {
    try {
      if (page && typeof page.off === 'function') page.off('response', onResp);
      else if (page && typeof page.removeListener === 'function') page.removeListener('response', onResp);
    } catch (eOff) {}
  }
  return dedupeBookingProperties(harvested);
}

function listBookingPropertiesFromHtml(html) {
  const src = String(html || '');
  const out = [];
  function push(id, name) {
    const hotelId = normalizeHotelId(id);
    if (!hotelId) return;
    const n = String(name || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    out.push({ hotelId: hotelId, name: n });
  }
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRe.exec(src))) {
    const attrs = m[1] || '';
    const val = (attrs.match(/value\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    push(val, m[2]);
  }
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(src))) {
    const attrs = m[1] || '';
    const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const hid = parseBookingHotelId(attrs + ' ' + href);
    if (hid) push(hid, m[2]);
  }
  const dataRe = /data-hotel-?id\s*=\s*["'](\d{5,10})["']/gi;
  while ((m = dataRe.exec(src))) {
    const slice = src.slice(m.index, Math.min(src.length, m.index + 240));
    const inner = (slice.match(/>([^<]{2,80})</) || [])[1] || '';
    push(m[1], inner);
  }
  return out;
}

function dedupeBookingProperties(rows) {
  const byId = {};
  (rows || []).forEach(function (row) {
    const hotelId = normalizeHotelId(row && (row.hotelId || row.hotel_id || row.id));
    if (!hotelId) return;
    const name = String((row && (row.name || row.hotelName || row.propertyName || row.text)) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const prev = byId[hotelId];
    if (!prev) {
      byId[hotelId] = { hotelId: hotelId, name: name };
      return;
    }
    if (name && name.length > String(prev.name || '').length) prev.name = name;
  });
  return Object.keys(byId)
    .sort()
    .map(function (k) {
      return byId[k];
    });
}

function aptRow(apt) {
  return {
    aptId: String((apt && (apt.aptId || apt.id)) || ''),
    aptName: String((apt && (apt.aptName || apt.name)) || ''),
    clearGroup: String((apt && apt.clearGroup) || ''),
  };
}

function matchBookingProperties(props, apts) {
  const list = Array.isArray(apts) ? apts : [];
  const properties = dedupeBookingProperties(props);
  const linked = [];
  const unmatched = [];
  const skipped = [];
  const already = [];

  function pushLink(apt, hotelId, propertyName, how) {
    const rec = Object.assign(aptRow(apt), {
      bookingHotelId: hotelId,
      propertyName: propertyName,
      how: how,
    });
    const cur = normalizeHotelId(apt && apt.bookingHotelId);
    if (cur && cur === hotelId) {
      already.push(rec);
      return;
    }
    if (cur && cur !== hotelId) {
      skipped.push(Object.assign({}, rec, { reason: 'conflict', existing: cur }));
      return;
    }
    linked.push(rec);
  }

  properties.forEach(function (prop) {
    const hotelId = normalizeHotelId(prop && prop.hotelId);
    const name = String((prop && prop.name) || '').trim();
    if (!hotelId) return;
    if (isVotsalaPropertyName(name)) {
      const vots = list.filter(function (a) {
        return isVotsalaApt(a);
      });
      if (!vots.length) {
        unmatched.push({ hotelId: hotelId, name: name, reason: 'no-votsala-apartments' });
        return;
      }
      vots.forEach(function (a) {
        pushLink(a, hotelId, name, 'votsala-group');
      });
      return;
    }
    const scored = [];
    list.forEach(function (a) {
      let score = bookingNameScore(name, (a && (a.aptName || a.name)) || '');
      (a && a.aliases ? a.aliases : []).forEach(function (al) {
        const s2 = bookingNameScore(name, al);
        if (s2 > score) score = s2;
      });
      if (score > 0) scored.push({ apt: a, score: score });
    });
    scored.sort(function (x, y) {
      return y.score - x.score;
    });
    if (!scored.length || scored[0].score < 50) {
      unmatched.push({ hotelId: hotelId, name: name, reason: 'no-name-match' });
      return;
    }
    const top = scored[0].score;
    const ties = scored.filter(function (x) {
      return x.score === top;
    });
    if (ties.length > 1) {
      unmatched.push({
        hotelId: hotelId,
        name: name,
        reason: 'ambiguous',
        candidates: ties.map(function (t) {
          return aptRow(t.apt).aptName;
        }),
      });
      return;
    }
    pushLink(ties[0].apt, hotelId, name, 'name');
  });

  return {
    properties: properties,
    linked: linked,
    unmatched: unmatched,
    skipped: skipped,
    already: already,
  };
}

function applyBookingHotelIds(apts, linked) {
  const list = (apts || []).map(function (a) {
    return Object.assign({}, a);
  });
  const byId = {};
  const byName = {};
  list.forEach(function (a) {
    if (a && (a.id || a.aptId)) byId[String(a.id || a.aptId)] = a;
    const n = String((a && (a.name || a.aptName)) || '')
      .trim()
      .toLowerCase();
    if (n) byName[n] = a;
  });
  let updated = 0;
  (linked || []).forEach(function (row) {
    const apt =
      (row.aptId && byId[String(row.aptId)]) ||
      (row.aptName && byName[String(row.aptName).trim().toLowerCase()]);
    if (!apt) return;
    const next = normalizeHotelId(row.bookingHotelId);
    if (!next) return;
    const cur = normalizeHotelId(apt.bookingHotelId);
    if (cur && cur !== next) return;
    if (cur === next) return;
    apt.bookingHotelId = next;
    updated += 1;
  });
  return { apts: list, updated: updated };
}

module.exports = {
  MONTH_NAMES_EN,
  MONTH_NAMES_EL,
  BOOKING_INVOICE_URLS,
  BOOKING_PROPERTY_URLS,
  prevMonth,
  ymFromDmy,
  isBookingStay,
  stayMonth,
  bookingBillMonth,
  findApt,
  isVotsalaApt,
  bookingBillingFolder,
  bookingBillingKey,
  estimateBookingInvoices,
  normalizeHotelId,
  parseBookingHotelId,
  hotelIdFromKnownApts,
  parseBookingInvoiceNumber,
  parseBookingInvoiceFields,
  pdfExtractText,
  pdfShortHash,
  isPortalChromeLabel,
  looksLikePdf,
  looksLikeZip,
  isBookingInvoiceBlob,
  isBookingStatementBlob,
  resolveBookingApt,
  bookingInvoiceFilename,
  monthTokens,
  invoiceMatchesMonth,
  listBookingInvoiceTargets,
  harvestBookingInvoicePayloads,
  dedupeInvoiceTargets,
  unzipPdfEntries,
  aptStoreFolder,
  bookingStoreRel,
  monthFromFilenameBlob,
  bookingZipDupKey,
  categorizeBookingZip,
  bookingTooEarly,
  bookingCompleteness,
  reconcileBookingMonth,
  normBookingName,
  bookingUnitNumber,
  isVotsalaPropertyName,
  bookingNameScore,
  harvestBookingProperties,
  listBookingPropertiesFromHtml,
  listBookingPropertiesFromDom,
  collectBookingPropertyRows,
  scrapeBookingProperties,
  dedupeBookingProperties,
  matchBookingProperties,
  applyBookingHotelIds,
};
