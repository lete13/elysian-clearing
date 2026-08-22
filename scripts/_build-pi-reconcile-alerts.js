'use strict';
/**
 * Build fe/patches-137.json: Booking.com expect follows the invoice generation
 * logic (departure month), and the Accountants tab shows reconcile alerts.
 * Run: node scripts/_build-pi-reconcile-alerts.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyFe(untilName) {
  let src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (name === untilName) break;
    const file = path.join(root, 'fe', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 && sha256(src) !== spec.baseSha256) throw new Error(name + ' base drift');
    for (const p of spec.patches || []) {
      const parts = src.split(p.find);
      if (parts.length - 1 !== (p.count || 1)) throw new Error(name + ' anchor: ' + p.note);
      src = parts.join(p.replace);
    }
    if (spec.expectedSha256 && sha256(src) !== spec.expectedSha256) throw new Error(name + ' expected sha');
  }
  return src;
}

const src = applyFe('patches-137.json');

const patches = [];

patches.push({
  note: 'Client Booking expect uses departure month like Booking.com invoicing',
  find:
    "    function piBdcStayMonth(b) {\n" +
    "      var ym = piYmFromDmy(b && (b.checkIn || b.check_in));\n" +
    "      if (ym) return ym;\n" +
    "      return piYmFromTs(b && (b.createdOnChannel != null ? b.createdOnChannel : b.created));\n" +
    "    }",
  replace:
    "    function piBdcStayMonth(b) {\n" +
    "      var ym = piYmFromDmy(b && (b.checkOut || b.check_out));\n" +
    "      if (!ym) ym = piYmFromDmy(b && (b.checkIn || b.check_in));\n" +
    "      if (ym) return ym;\n" +
    "      return piYmFromTs(b && (b.createdOnChannel != null ? b.createdOnChannel : b.created));\n" +
    "    }",
  count: 1,
});

patches.push({
  note: 'Health line says check-outs, matching the billing rule',
  find: "      '<div style=\"margin-top:6px\"><b>Booking.com</b> (stays in <code>' + bdcBookMonth + '</code>): <b>' + bdcExpect + '</b> invoice PDF(s) — one per apartment; Votsala 1–8 = one PDF</div>';",
  replace: "      '<div style=\"margin-top:6px\"><b>Booking.com</b> (check-outs in <code>' + bdcBookMonth + '</code>): <b>' + bdcExpect + '</b> invoice PDF(s) — one per apartment; Votsala 1–8 = one PDF</div>';",
  count: 2,
});

patches.push({
  note: 'Expect copy: June check-outs → July folder',
  find: '<b>Booking.com</b> = one invoice per apartment (June stays → July folder). Votsala 1–8 share one BDC PDF.',
  replace: '<b>Booking.com</b> = one invoice per apartment (June check-outs → July folder). Votsala 1–8 share one BDC PDF.',
  count: 1,
});

patches.push({
  note: 'Alerts box above the accountant cards',
  find: '      <div id="pi-accountant-cards"></div>',
  replace: '      <div id="pi-acct-alerts" style="margin-bottom:10px"></div>\n      <div id="pi-accountant-cards"></div>',
  count: 1,
});

patches.push({
  note: 'Accountants sub-menu renders reconcile alerts',
  find: "    if (PI.menu === 'accountants') piRenderAccountantCards();",
  replace: "    if (PI.menu === 'accountants') { piRenderAccountantCards(); piRenderAcctAlerts(); }",
  count: 1,
});

const alertsJs =
  "  window.piRenderAcctAlerts = async function () {\n" +
  "    var box = document.getElementById('pi-acct-alerts');\n" +
  "    if (!box) return;\n" +
  "    var month = monthVal();\n" +
  "    box.innerHTML = '<div style=\"color:var(--tx3);font-size:12px\">Checking Booking.com invoices vs Hosthub departures for ' + month + '…</div>';\n" +
  "    try {\n" +
  "      var j = await fetch('/api/platform-invoices/reconcile?month=' + encodeURIComponent(month)).then(function (r) { return r.json(); });\n" +
  "      if (j && j.error) throw new Error(j.error);\n" +
  "      if (j.match) {\n" +
  "        box.innerHTML = '<div style=\"border:1px solid rgba(26,127,55,.35);border-radius:10px;padding:10px 12px;font-size:12.5px;background:rgba(26,127,55,.07)\"><b>' + month + '</b> — Booking.com invoices match Hosthub departures in <b>' + (j.bookMonth || '') + '</b> · ' + (j.included || 0) + ' PDF(s) across ' + (j.expected || 0) + ' expected folder(s).</div>';\n" +
  "        return;\n" +
  "      }\n" +
  "      var errs = j.errors || [];\n" +
  "      box.innerHTML = '<div style=\"border:1px solid rgba(185,28,28,.4);border-radius:10px;padding:10px 12px;font-size:12.5px;background:rgba(185,28,28,.06)\">' +\n" +
  "        '<div style=\"font-weight:650;color:#b91c1c;margin-bottom:6px\">' + month + ' — ' + errs.length + ' Booking.com reconcile alert(s). The agent will not email until these are resolved.</div>' +\n" +
  "        errs.map(function (e) {\n" +
  "          var kind = e.type === 'stays_without_invoice' ? 'Departures but no invoice' : 'Invoice but no departures';\n" +
  "          return '<div style=\"margin-top:3px\">· <b>' + piAcctEsc(e.aptName || '') + '</b> — ' + kind + '. ' + piAcctEsc(e.message || '') + '</div>';\n" +
  "        }).join('') +\n" +
  "        '</div>';\n" +
  "    } catch (e) { box.innerHTML = '<div style=\"color:#b00;font-size:12px\">Reconcile check failed: ' + piAcctEsc(e.message || String(e)) + '</div>'; }\n" +
  "  };\n";

patches.push({
  note: 'piRenderAcctAlerts fetches the reconcile status',
  find: '  window.piLoadAgentLatest = async function () {',
  replace: alertsJs + '  window.piLoadAgentLatest = async function () {',
  count: 1,
});

let out = src;
for (const [i, p] of patches.entries()) {
  const parts = out.split(p.find);
  if (parts.length - 1 !== (p.count || 1)) {
    throw new Error('patch ' + (i + 1) + ' (' + p.note + '): anchor count ' + (parts.length - 1));
  }
  out = parts.join(p.replace);
}

const cfg = {
  baseSha256: sha256(src),
  expectedSha256: sha256(out),
  builtAt: '2026-08-22 Booking expect by departure month + Accountants-tab alerts',
  patches: patches,
  assertions: [
    { has: 'piYmFromDmy(b && (b.checkOut || b.check_out));', note: 'client expect by check-out' },
    { has: 'id="pi-acct-alerts"', note: 'alerts box on Accountants tab' },
    { has: 'piRenderAcctAlerts', note: 'alerts renderer' },
    { has: '/api/platform-invoices/reconcile?month=', note: 'alerts use the reconcile endpoint' },
    { hasNot: '(June stays → July folder)', note: 'copy says check-outs' },
  ],
};

fs.writeFileSync(path.join(root, 'fe', 'patches-137.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote fe/patches-137.json', cfg.expectedSha256);
