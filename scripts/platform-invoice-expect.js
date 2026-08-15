'use strict';
/**
 * Hosthub → estimated Airbnb VAT documents for a month.
 * normal = 1 debit; cancelled = debit + credit (2);
 * n extends = 1 + 2n (each extra extend = credit of previous debit + new debit).
 * Cancel wins over extend over normal when the same confirmation code appears twice.
 *
 * Hosthub usually updates one calendar event in place (same id) — that still
 * counts as one extend when Hosthub `created` is >36h after Airbnb `createdOnChannel`.
 * Extra Hosthub event ids on the same confirmation code raise n (lifetime, not only in-month).
 */

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

function createdMs(t) {
  if (t == null || t === '') return 0;
  const n = Number(t);
  if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(t));
  return isFinite(parsed) ? parsed : 0;
}

function airCode(b) {
  return String((b && (b.reservationId || b.reservation_id || b.confirmationCode || b.code)) || '')
    .trim()
    .toUpperCase();
}

function hosthubIdOf(b) {
  return String((b && (b.id || b.hosthubId)) || '').trim();
}

function dmyKey(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return Date.UTC(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

const RANK = { cancel: 3, extend: 2, normal: 1 };
const EXTEND_MS = 36 * 3600 * 1000;

function isAirbnbBooking(b) {
  const plat = String((b && (b.platform || b.channel)) || '').toLowerCase();
  return plat.indexOf('air') >= 0;
}

function countExtends(allBks, seed) {
  const ids = {};
  (allBks || []).forEach(function (b) {
    const id = hosthubIdOf(b);
    if (id) ids[id] = true;
  });
  const unique = Object.keys(ids).length;
  if (unique > 1) return unique - 1;
  const rows = allBks && allBks.length ? allBks : seed ? [seed] : [];
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const ch = createdMs(b && b.createdOnChannel);
    const hh = createdMs(b && b.created);
    if (ch && hh && hh - ch > EXTEND_MS) return 1;
  }
  if (seed && !(allBks && allBks.length)) {
    const ch = createdMs(seed.createdOnChannel);
    const hh = createdMs(seed.created);
    if (ch && hh && hh - ch > EXTEND_MS) return 1;
  }
  return 0;
}

function docsForStay(stayKind, n) {
  if (stayKind === 'cancel') return 2;
  return 1 + 2 * (n || 0);
}

function classifyAirbnbStay(b, month) {
  if (!b) return null;
  const channelYm = ymFromTs(b.createdOnChannel);
  const hosthubYm = ymFromTs(b.created);
  const createdYm = (channelYm === month || hosthubYm === month) ? month : (channelYm || hosthubYm);
  const cancelYm = ymFromTs(b.cancelledAt);
  const inCreated = createdYm === month;
  const inCancel = !!(cancelYm === month && (b.cancelled || b.cancelledAt));
  if (!inCreated && !inCancel) return null;
  let stayKind = 'normal';
  if (inCancel) stayKind = 'cancel';
  else {
    const ch = createdMs(b.createdOnChannel);
    const hh = createdMs(b.created);
    if (ch && hh && hh - ch > EXTEND_MS) stayKind = 'extend';
  }
  const n = stayKind === 'extend' ? 1 : 0;
  return {
    code: airCode(b),
    stayKind: stayKind,
    extends: n,
    docs: docsForStay(stayKind, n),
    inCreated: inCreated,
    inCancel: inCancel,
    aptId: String((b && b.aptId) || '').trim(),
    aptName: String((b && b.aptName) || '').trim(),
    guestName: String((b && b.guestName) || '').trim(),
    hosthubId: hosthubIdOf(b),
    created: b.created != null ? b.created : null,
    createdOnChannel: b.createdOnChannel != null ? b.createdOnChannel : null,
    checkIn: b.checkIn != null ? String(b.checkIn) : '',
    checkOut: b.checkOut != null ? String(b.checkOut) : '',
    cancelled: !!b.cancelled,
    cancelledAt: b.cancelledAt != null ? b.cancelledAt : null,
  };
}

function mergeStay(prev, next) {
  if (!prev) return next;
  const later = dmyKey(next.checkOut) >= dmyKey(prev.checkOut) ? next : prev;
  const base = (RANK[next.stayKind] || 0) > (RANK[prev.stayKind] || 0)
    ? Object.assign({}, prev, next)
    : Object.assign({}, next, prev, {
      stayKind: prev.stayKind,
      docs: prev.docs,
      extends: prev.extends,
    });
  return Object.assign({}, base, {
    inCreated: prev.inCreated || next.inCreated,
    inCancel: prev.inCancel || next.inCancel,
    checkIn: later.checkIn || base.checkIn || '',
    checkOut: later.checkOut || base.checkOut || '',
    aptName: later.aptName || base.aptName || '',
    aptId: later.aptId || base.aptId || '',
  });
}

function estimateAirbnbInvoices(month, bks) {
  const allByCode = {};
  (bks || []).forEach(function (b) {
    if (!isAirbnbBooking(b)) return;
    const code = airCode(b);
    if (!code) return;
    if (!allByCode[code]) allByCode[code] = [];
    allByCode[code].push(b);
  });
  const byCode = {};
  const missing = [];
  (bks || []).forEach(function (b) {
    if (!isAirbnbBooking(b)) return;
    const rec = classifyAirbnbStay(b, month);
    if (!rec) return;
    if (!rec.code) {
      if (rec.inCreated) missing.push(Object.assign({}, rec, { kind: 'invoice' }));
      if (rec.inCancel) missing.push(Object.assign({}, rec, { kind: 'credit_note' }));
      return;
    }
    byCode[rec.code] = mergeStay(byCode[rec.code], rec);
  });
  const stays = Object.keys(byCode)
    .sort()
    .map(function (k) {
      const s = byCode[k];
      const n = countExtends(allByCode[k] || [], s);
      const stayKind = s.stayKind === 'cancel' ? 'cancel' : (n > 0 ? 'extend' : 'normal');
      return Object.assign({}, s, {
        stayKind: stayKind,
        extends: n,
        docs: docsForStay(stayKind, n),
      });
    });
  const estimate = { normal: 0, cancel: 0, extend: 0, docs: 0, stays: stays.length, extendDocs: 0 };
  stays.forEach(function (s) {
    estimate[s.stayKind] += 1;
    estimate.docs += s.docs;
    if (s.stayKind === 'extend') estimate.extendDocs += s.docs;
  });
  return { stays: stays, missing: missing, estimate: estimate };
}

module.exports = {
  ymFromTs,
  createdMs,
  classifyAirbnbStay,
  estimateAirbnbInvoices,
  countExtends,
  docsForStay,
  EXTEND_MS,
};
