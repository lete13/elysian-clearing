'use strict';
/**
 * Platform Invoices accountant cards (emails + PDF/Excel toggles + apartments).
 * An empty apartments list means the card receives every apartment.
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
    apartments: [],
  },
  {
    id: 'elysianproperties',
    name: 'Elysian Properties',
    email: 'info@elysianproperties.eu',
    receivePdfs: true,
    receiveExcel: true,
    apartments: [],
  },
];

function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

// Same shape the server's emailAddrOk enforces before nodemailer sees it.
function emailOk(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s || '').trim());
}

function makeId(email, fallback) {
  const base = String(email || fallback || 'accountant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'accountant';
}

function normalizeApartments(raw) {
  let list = raw;
  if (typeof list === 'string') list = list.split(/[\n,;]+/);
  if (!Array.isArray(list)) return [];
  const seen = {};
  const out = [];
  list.forEach(function (a) {
    const name = String(a || '').trim().slice(0, 120);
    const key = name.toLowerCase();
    if (!name || seen[key]) return;
    seen[key] = true;
    out.push(name);
  });
  return out.slice(0, 200);
}

function normalizeCard(raw, idx) {
  const email = normalizeEmail(raw && (raw.email || raw.to));
  if (!emailOk(email)) return null;
  return {
    id: String((raw && raw.id) || makeId(email, 'acct' + (idx || 0))),
    name: String((raw && (raw.name || raw.label)) || email).trim().slice(0, 80),
    email: email,
    receivePdfs: !(raw && (raw.receivePdfs === false || raw.pdfs === false || raw.receivePdf === false)),
    receiveExcel: !(raw && (raw.receiveExcel === false || raw.xls === false || raw.excel === false)),
    apartments: normalizeApartments(raw && raw.apartments),
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
        apartments: c.apartments || [],
        skip: !c.receivePdfs && !c.receiveExcel,
      };
    });
}

module.exports = {
  ACCOUNTANTS_KEY,
  DEFAULT_ACCOUNTANTS,
  normalizeEmail,
  emailOk,
  normalizeApartments,
  normalizeCard,
  seedFromEnv,
  parseAccountantsData,
  recipientsForSend,
};
