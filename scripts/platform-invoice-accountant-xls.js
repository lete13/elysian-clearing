'use strict';
/**
 * Accountant import sheet (Greek bank/expense template):
 * A/A, Ημερομηνία, Αιτιολογία, Κατάστημα, Τοκισμός από, Αρ. συναλλαγής, Ποσό, Πρόσημο ποσού
 */

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  };
}

function fallbackInvoiceNumber(row) {
  const leaf = String((row && row.filename) || '')
    .split('/')
    .pop() || '';
  const m = leaf.toUpperCase().match(/(?:INVOICE|CREDIT_NOTE)-[A-Z0-9]{6,20}(?:-([A-Z0-9._-]+?))?(?:\.PDF)?$/);
  if (m && m[1]) return m[1];
  return '';
}

function accountantRow(row) {
  const meta = parseMeta(row);
  const invoiceNumber = String(meta.invoiceNumber || fallbackInvoiceNumber(row) || '').trim();
  const issueDate = String(meta.issueDate || '').trim();
  let total = meta.total;
  if (total === '' || total == null) total = '';
  else {
    const n = Number(total);
    total = isFinite(n) ? (Math.round(n * 100) / 100) : total;
  }
  const sign = meta.sign === '-' || (typeof total === 'number' && total < 0) ? '-' : '';
  if (typeof total === 'number') total = Math.abs(total);
  const creditFile = /credit/i.test(String((row && row.filename) || '')) || String((row && row.kind) || '') === 'credit_note';
  const outSign = sign || (creditFile ? '-' : '');
  return {
    issueDate: issueDate,
    invoiceNumber: invoiceNumber,
    total: total,
    sign: outSign,
  };
}

function issueDateKey(dmy) {
  const m = String(dmy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return Date.UTC(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

function buildAccountantXls(rows) {
  const headers = [
    'A/A',
    'Ημερομηνία',
    'Αιτιολογία',
    'Κατάστημα',
    'Τοκισμός από',
    'Αρ. συναλλαγής',
    'Ποσό',
    'Πρόσημο ποσού',
  ];
  const recs = [];
  (rows || []).forEach((row) => {
    if (String((row && row.channel) || '').toLowerCase() === 'booking') return;
    const rec = accountantRow(row);
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
    const cells = [n, rec.issueDate, rec.invoiceNumber, '', rec.issueDate, '', rec.total, rec.sign];
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
};
