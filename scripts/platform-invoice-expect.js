'use strict';
/**
 * Hosthub → estimated Airbnb VAT documents for a month.
 * normal = 1 debit; cancelled = debit + credit; extended = original debit + credit of that debit + new debit.
 * Cancel wins over extend over normal when the same confirmation code appears twice.
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

const RANK = { cancel: 3, extend: 2, normal: 1 };
const DOCS = { cancel: 2, extend: 3, normal: 1 };
const EXTEND_MS = 36 * 3600 * 1000;

function isAirbnbBooking(b) {
  const plat = String((b && (b.platform || b.channel)) || '').toLowerCase();
  return plat.indexOf('air') >= 0;
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
  return {
    code: airCode(b),
    stayKind: stayKind,
    docs: DOCS[stayKind],
    inCreated: inCreated,
    inCancel: inCancel,
    aptId: String((b && b.aptId) || '').trim(),
    aptName: String((b && b.aptName) || '').trim(),
    guestName: String((b && b.guestName) || '').trim(),
    hosthubId: String((b && (b.id || b.hosthubId)) || '').trim(),
    created: b.created != null ? b.created : null,
    createdOnChannel: b.createdOnChannel != null ? b.createdOnChannel : null,
    cancelled: !!b.cancelled,
    cancelledAt: b.cancelledAt != null ? b.cancelledAt : null,
  };
}

function mergeStay(prev, next) {
  if (!prev) return next;
  if ((RANK[next.stayKind] || 0) > (RANK[prev.stayKind] || 0)) {
    return Object.assign({}, prev, next, {
      inCreated: prev.inCreated || next.inCreated,
      inCancel: prev.inCancel || next.inCancel,
    });
  }
  return Object.assign({}, next, prev, {
    stayKind: prev.stayKind,
    docs: prev.docs,
    inCreated: prev.inCreated || next.inCreated,
    inCancel: prev.inCancel || next.inCancel,
  });
}

function estimateAirbnbInvoices(month, bks) {
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
      return byCode[k];
    });
  const estimate = { normal: 0, cancel: 0, extend: 0, docs: 0, stays: stays.length };
  stays.forEach(function (s) {
    estimate[s.stayKind] += 1;
    estimate.docs += s.docs;
  });
  return { stays: stays, missing: missing, estimate: estimate };
}

module.exports = {
  ymFromTs,
  createdMs,
  classifyAirbnbStay,
  estimateAirbnbInvoices,
  EXTEND_MS,
};
