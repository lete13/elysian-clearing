'use strict';
/**
 * Platform Invoices accountant cards (email + PDF/Excel toggles).
 * Stored in Postgres app_data key pi_accountants.
 */

const ACCOUNTANTS_KEY = 'pi_accountants';

const DEFAULT_ACCOUNTANTS = [
  {
    id: 'e-newgeneration',
    name: 'E-New Generation',
    email: 'info@e-newgeneration.gr',
    receivePdfs: true,
    receiveExcel: true,
  },
  {
    id: 'elysianproperties',
    name: 'Elysian Properties',
    email: 'info@elysianproperties.eu',
    receivePdfs: true,
    receiveExcel: true,
  },
];

function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function makeId(email, fallback) {
  const base = String(email || fallback || 'accountant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'accountant';
}

function normalizeCard(raw, idx) {
  const email = normalizeEmail(raw && (raw.email || raw.to));
  if (!email || email.indexOf('@') < 0) return null;
  return {
    id: String((raw && raw.id) || makeId(email, 'acct' + (idx || 0))),
    name: String((raw && (raw.name || raw.label)) || email).trim().slice(0, 80),
    email: email,
    receivePdfs: !(raw && (raw.receivePdfs === false || raw.pdfs === false || raw.receivePdf === false)),
    receiveExcel: !(raw && (raw.receiveExcel === false || raw.xls === false || raw.excel === false)),
  };
}

function seedFromEnv(envEmail) {
  const fromEnv = String(envEmail || '')
    .split(/[,;]+/)
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean)
    .map(function (email, i) {
      return normalizeCard({ email: email, name: email }, i);
    })
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return DEFAULT_ACCOUNTANTS.map(function (c) {
    return Object.assign({}, c);
  });
}

function parseAccountantsData(data) {
  if (data == null || data === '') return null;
  let obj = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeCard).filter(Boolean);
  }
  if (obj && Array.isArray(obj.accountants)) {
    return obj.accountants.map(normalizeCard).filter(Boolean);
  }
  return null;
}

function recipientsForSend(cards) {
  const list = Array.isArray(cards) ? cards : [];
  return list
    .map(normalizeCard)
    .filter(Boolean)
    .map(function (c) {
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        receivePdfs: !!c.receivePdfs,
        receiveExcel: !!c.receiveExcel,
        skip: !c.receivePdfs && !c.receiveExcel,
      };
    });
}

module.exports = {
  ACCOUNTANTS_KEY,
  DEFAULT_ACCOUNTANTS,
  normalizeEmail,
  normalizeCard,
  seedFromEnv,
  parseAccountantsData,
  recipientsForSend,
};
