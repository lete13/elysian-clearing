'use strict';
/**
 * Build fe/patches-139.json: collapsible Retrieve sections (per-section
 * chevrons + Collapse/Expand all) and a "Ship anyway" override when the
 * Booking reconcile block stops the manual send.
 * Run: node scripts/_build-pi-fold-shipforce.js
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

const src = applyFe('patches-139.json');

function foldHeader(n, title) {
  return '<div onclick="piToggleFold(' + n + ')" style="font-weight:650;font-size:15px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;gap:8px"><span>' + title + '</span><span id="pi-fold-c' + n + '" style="margin-left:auto;color:var(--tx3);font-weight:400">▾</span></div>';
}

const patches = [];

patches.push({
  note: 'Collapse/Expand all buttons beside the status strip',
  find:
    '      <div id="pi-flow-status" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"></div>\n' +
    '      <div id="pi-steps" style="display:none"></div>',
  replace:
    '      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">\n' +
    '        <div id="pi-flow-status" style="display:flex;gap:8px;flex-wrap:wrap;flex:1;min-width:0"></div>\n' +
    '        <button type="button" class="btn sm" onclick="piFoldAll(true)">Collapse all</button>\n' +
    '        <button type="button" class="btn sm" onclick="piFoldAll(false)">Expand all</button>\n' +
    '      </div>\n' +
    '      <div id="pi-steps" style="display:none"></div>',
  count: 1,
});

patches.push({
  note: 'Expect header toggles its section',
  find: '<div style="font-weight:650;font-size:15px;margin-bottom:6px">1 · Expect — what the month should contain (Hosthub)</div>',
  replace: foldHeader(2, '1 · Expect — what the month should contain (Hosthub)'),
  count: 1,
});

patches.push({
  note: 'Collect header toggles its section',
  find: '<div style="font-weight:650;font-size:15px;margin-bottom:6px">2 · Collect documents</div>',
  replace: foldHeader(3, '2 · Collect documents'),
  count: 1,
});

patches.push({
  note: 'Review header toggles its section',
  find: '<div style="font-weight:650;font-size:15px;margin-bottom:6px">3 · Review</div>',
  replace: foldHeader(4, '3 · Review'),
  count: 1,
});

patches.push({
  note: 'Ship header toggles its section',
  find: '<div style="font-weight:650;font-size:15px;margin-bottom:6px">4 · Ship to accountants</div>',
  replace: foldHeader(5, '4 · Ship to accountants'),
  count: 1,
});

patches.push({
  note: 'renderSteps applies saved fold state',
  find:
    "  function renderSteps() {\n" +
    "    var box = document.getElementById('pi-steps');\n" +
    "    if (box) box.innerHTML = '';\n" +
    "    var p1 = document.getElementById('pi-panel-1');\n" +
    "    if (p1) p1.style.display = 'none';\n" +
    "    for (var s = 2; s <= 5; s++) {\n" +
    "      var p = document.getElementById('pi-panel-' + s);\n" +
    "      if (p) { p.style.display = 'block'; p.style.marginBottom = '14px'; }\n" +
    "    }\n" +
    "  }",
  replace:
    "  function renderSteps() {\n" +
    "    var box = document.getElementById('pi-steps');\n" +
    "    if (box) box.innerHTML = '';\n" +
    "    var p1 = document.getElementById('pi-panel-1');\n" +
    "    if (p1) p1.style.display = 'none';\n" +
    "    for (var s = 2; s <= 5; s++) {\n" +
    "      var p = document.getElementById('pi-panel-' + s);\n" +
    "      if (p) { p.style.display = 'block'; p.style.marginBottom = '14px'; }\n" +
    "    }\n" +
    "    try { piApplyFolds(); } catch (eFold) {}\n" +
    "  }",
  count: 1,
});

patches.push({
  note: 'piGo expands the target section before scrolling',
  find:
    "    var p = document.getElementById('pi-panel-' + Math.max(2, PI.step));\n" +
    "    if (p && p.scrollIntoView) { try { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (eScroll) {} }\n" +
    "  };",
  replace:
    "    var target = Math.max(2, PI.step);\n" +
    "    try { localStorage.setItem('pi_fold_' + target, '0'); } catch (eFold) {}\n" +
    "    try { piApplyFolds(); } catch (eFold2) {}\n" +
    "    var p = document.getElementById('pi-panel-' + target);\n" +
    "    if (p && p.scrollIntoView) { try { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (eScroll) {} }\n" +
    "  };",
  count: 1,
});

const foldJs =
  "  function piFoldState(n) {\n" +
  "    try { return localStorage.getItem('pi_fold_' + n) === '1'; } catch (e) { return false; }\n" +
  "  }\n" +
  "  window.piApplyFolds = function () {\n" +
  "    for (var n = 2; n <= 5; n++) {\n" +
  "      var p = document.getElementById('pi-panel-' + n);\n" +
  "      if (!p) continue;\n" +
  "      var collapsed = piFoldState(n);\n" +
  "      var kids = p.children;\n" +
  "      for (var i = 1; i < kids.length; i++) {\n" +
  "        var el = kids[i];\n" +
  "        if (el.getAttribute('data-pi-disp') == null) el.setAttribute('data-pi-disp', el.style.display || '');\n" +
  "        el.style.display = collapsed ? 'none' : (el.getAttribute('data-pi-disp') || '');\n" +
  "      }\n" +
  "      var c = document.getElementById('pi-fold-c' + n);\n" +
  "      if (c) c.textContent = collapsed ? '▸' : '▾';\n" +
  "    }\n" +
  "  };\n" +
  "  window.piToggleFold = function (n) {\n" +
  "    try { localStorage.setItem('pi_fold_' + n, piFoldState(n) ? '0' : '1'); } catch (e) {}\n" +
  "    piApplyFolds();\n" +
  "  };\n" +
  "  window.piFoldAll = function (collapsed) {\n" +
  "    for (var n = 2; n <= 5; n++) { try { localStorage.setItem('pi_fold_' + n, collapsed ? '1' : '0'); } catch (e) {} }\n" +
  "    piApplyFolds();\n" +
  "  };\n";

patches.push({
  note: 'Fold state helpers (localStorage-backed)',
  find: '  window.piLoadAgentLatest = async function () {',
  replace: foldJs + '  window.piLoadAgentLatest = async function () {',
  count: 1,
});

patches.push({
  note: 'piSend carries force and surfaces reconcile errors to the caller',
  find:
    "  window.piSend = async function (scope) {\n" +
    "    var month = monthVal();\n" +
    "    var partner = scope === 'b2b' ? ((document.getElementById('pi-partner') || {}).value || '').trim() : '';\n" +
    "    var to = '';\n" +
    "    if (scope === 'b2b') to = prompt('Partner email for this pack:', '') || '';\n" +
    "    try {\n" +
    "      var r = await fetch('/api/platform-invoices/send', {\n" +
    "        method: 'POST', headers: { 'Content-Type': 'application/json' },\n" +
    "        body: JSON.stringify({ month: month, scope: scope, partner: partner, to: to, subject: (scope==='leased' ? ('PLATFORM INVOICES ' + month) : undefined), text: (scope==='leased' ? ('Finished Elysian platform-invoice pack for ' + month + ' (ενδοκοινοτικά / Airbnb+Booking).\\n') : undefined) })\n" +
    "      }).then(function (x) { return x.json(); });\n" +
    "      if (!r.ok) throw new Error(r.error || 'send failed');\n" +
    "      msg('Sent ' + r.count + ' file(s) to ' + (r.to || []).join(', '), true);\n" +
    "      return r;\n" +
    "    } catch (e) { msg(e.message || String(e), false); throw e; }\n" +
    "  };",
  replace:
    "  window.piSend = async function (scope, force) {\n" +
    "    var month = monthVal();\n" +
    "    var partner = scope === 'b2b' ? ((document.getElementById('pi-partner') || {}).value || '').trim() : '';\n" +
    "    var to = '';\n" +
    "    if (scope === 'b2b') to = prompt('Partner email for this pack:', '') || '';\n" +
    "    try {\n" +
    "      var r = await fetch('/api/platform-invoices/send', {\n" +
    "        method: 'POST', headers: { 'Content-Type': 'application/json' },\n" +
    "        body: JSON.stringify({ month: month, scope: scope, partner: partner, to: to, force: !!force, subject: (scope==='leased' ? ('PLATFORM INVOICES ' + month) : undefined), text: (scope==='leased' ? ('Finished Elysian platform-invoice pack for ' + month + ' (ενδοκοινοτικά / Airbnb+Booking).\\n') : undefined) })\n" +
    "      }).then(function (x) { return x.json(); });\n" +
    "      if (!r.ok) {\n" +
    "        var err = new Error(r.error || 'send failed');\n" +
    "        err.piErrors = r.errors || [];\n" +
    "        err.piCanForce = !!r.canForce;\n" +
    "        throw err;\n" +
    "      }\n" +
    "      msg('Sent ' + r.count + ' file(s) to ' + (r.to || []).join(', '), true);\n" +
    "      return r;\n" +
    "    } catch (e) { msg(e.message || String(e), false); throw e; }\n" +
    "  };",
  count: 1,
});

patches.push({
  note: 'Blocked ship offers an explicit Ship anyway override',
  find:
    "  window.piShip = async function () {\n" +
    "    var btn = document.getElementById('pi-ship-btn');\n" +
    "    var out = document.getElementById('pi-ship-result');\n" +
    "    var missing = piMissingBdcNames();\n" +
    "    if (missing.length) {\n" +
    "      if (!confirm('Booking.com still missing apartment invoice(s): ' + missing.join(', ') +\n" +
    "          '\\n\\nBooking.com = one invoice per apartment. Ship anyway?')) return;\n" +
    "    }\n" +
    "    if (btn) btn.disabled = true;\n" +
    "    msg('Shipping finished pack…', true);\n" +
    "    try {\n" +
    "      var r = await piSend('leased');\n",
  replace:
    "  window.piShipAnyway = function () {\n" +
    "    if (!confirm('Ship the pack despite Booking reconcile alerts? Excel and PDFs include everything in the vault for this month.')) return;\n" +
    "    piShip(true);\n" +
    "  };\n" +
    "  window.piShip = async function (force) {\n" +
    "    var btn = document.getElementById('pi-ship-btn');\n" +
    "    var out = document.getElementById('pi-ship-result');\n" +
    "    var missing = piMissingBdcNames();\n" +
    "    if (missing.length && !force) {\n" +
    "      if (!confirm('Booking.com still missing apartment invoice(s): ' + missing.join(', ') +\n" +
    "          '\\n\\nBooking.com = one invoice per apartment. Ship anyway?')) return;\n" +
    "    }\n" +
    "    if (btn) btn.disabled = true;\n" +
    "    msg('Shipping finished pack…', true);\n" +
    "    try {\n" +
    "      var r = await piSend('leased', !!force);\n",
  count: 1,
});

patches.push({
  note: 'Ship error box lists alerts and the override button',
  find:
    "    } catch (e) {\n" +
    "      if (out) out.innerHTML = '<span style=\"color:var(--tx-err,#b91c1c)\">' + (e.message || e) + '</span>';\n" +
    "    } finally {\n" +
    "      if (btn) btn.disabled = false;\n" +
    "    }\n" +
    "  };",
  replace:
    "    } catch (e) {\n" +
    "      if (out) {\n" +
    "        var errs = (e && e.piErrors) || [];\n" +
    "        out.innerHTML = '<span style=\"color:var(--tx-err,#b91c1c)\">' + (e.message || e) + '</span>' +\n" +
    "          (errs.length ? '<div style=\"margin-top:6px;font-size:12px\">' + errs.map(function (x) { return '· <b>' + String(x.aptName || '').replace(/</g, '&lt;') + '</b> — ' + String(x.message || x.type || '').replace(/</g, '&lt;'); }).join('<br>') + '</div>' : '') +\n" +
    "          ((e && e.piCanForce) ? '<div style=\"margin-top:8px\"><button class=\"btn sm gold\" onclick=\"piShipAnyway()\">Ship anyway (' + errs.length + ' alert' + (errs.length === 1 ? '' : 's') + ')</button></div>' : '');\n" +
    "      }\n" +
    "    } finally {\n" +
    "      if (btn) btn.disabled = false;\n" +
    "    }\n" +
    "  };",
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
  builtAt: '2026-08-22 Collapsible Retrieve sections + Ship anyway override',
  patches: patches,
  assertions: [
    { has: 'piToggleFold(2)', note: 'section headers toggle' },
    { has: 'window.piFoldAll', note: 'collapse/expand all' },
    { has: 'piShipAnyway', note: 'ship-anyway override' },
    { has: 'force: !!force', note: 'send carries force' },
    { has: 'data-pi-disp', note: 'original display values restored on expand' },
  ],
};

fs.writeFileSync(path.join(root, 'fe', 'patches-139.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote fe/patches-139.json', cfg.expectedSha256);
