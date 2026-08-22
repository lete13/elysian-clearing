'use strict';
/**
 * Build fe/patches-136.json: Accountants sub-menu in Platform Invoices.
 * Cards move out of the Retrieve review step into their own view and gain
 * an apartment list (empty = send everything).
 * Run: node scripts/_build-pi-accountants-submenu.js
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

const src = applyFe('patches-136.json');

const patches = [];

patches.push({
  note: 'Accountants button on the Platform Invoices sub-menu',
  find: "      <button type=\"button\" id=\"pi-menu-retrieve\" class=\"btn sm\" onclick=\"piSetMenu('retrieve')\">Retrieve</button>",
  replace:
    "      <button type=\"button\" id=\"pi-menu-retrieve\" class=\"btn sm\" onclick=\"piSetMenu('retrieve')\">Retrieve</button>\n" +
    "      <button type=\"button\" id=\"pi-menu-accountants\" class=\"btn sm\" onclick=\"piSetMenu('accountants')\">Accountants</button>",
  count: 1,
});

patches.push({
  note: 'Accountants view next to Vault and Retrieve',
  find: '    <div id="pi-view-retrieve" style="display:none">',
  replace:
    '    <div id="pi-view-accountants" style="display:none">\n' +
    '      <div style="font-size:12.5px;color:var(--tx3);margin-bottom:10px">Who receives the monthly pack. Each card has its emails, PDFs / Excel toggles, and an optional apartment list — leave the list <b>empty</b> to send everything, or add apartments to send only their invoices (PDFs and Excel rows).</div>\n' +
    '      <div id="pi-accountant-cards"></div>\n' +
    '    </div>\n\n' +
    '    <div id="pi-view-retrieve" style="display:none">',
  count: 1,
});

patches.push({
  note: 'piSetMenu knows the accountants view',
  find:
    "  window.piSetMenu = function (which) {\n" +
    "    PI.menu = which === 'retrieve' ? 'retrieve' : 'vault';\n" +
    "    try { localStorage.setItem('pi_menu', PI.menu); } catch (eMenu) {}\n" +
    "    var v = document.getElementById('pi-view-vault');\n" +
    "    var r = document.getElementById('pi-view-retrieve');\n" +
    "    if (v) v.style.display = PI.menu === 'vault' ? 'block' : 'none';\n" +
    "    if (r) r.style.display = PI.menu === 'retrieve' ? 'block' : 'none';\n" +
    "    var bV = document.getElementById('pi-menu-vault');\n" +
    "    var bR = document.getElementById('pi-menu-retrieve');\n" +
    "    if (bV) bV.className = 'btn sm' + (PI.menu === 'vault' ? ' gold' : '');\n" +
    "    if (bR) bR.className = 'btn sm' + (PI.menu === 'retrieve' ? ' gold' : '');\n" +
    "    if (PI.menu === 'vault') renderVaultTree();\n" +
    "    if (PI.menu === 'retrieve') renderSteps();\n" +
    "  };",
  replace:
    "  window.piSetMenu = function (which) {\n" +
    "    PI.menu = which === 'retrieve' ? 'retrieve' : (which === 'accountants' ? 'accountants' : 'vault');\n" +
    "    try { localStorage.setItem('pi_menu', PI.menu); } catch (eMenu) {}\n" +
    "    var v = document.getElementById('pi-view-vault');\n" +
    "    var r = document.getElementById('pi-view-retrieve');\n" +
    "    var a = document.getElementById('pi-view-accountants');\n" +
    "    if (v) v.style.display = PI.menu === 'vault' ? 'block' : 'none';\n" +
    "    if (r) r.style.display = PI.menu === 'retrieve' ? 'block' : 'none';\n" +
    "    if (a) a.style.display = PI.menu === 'accountants' ? 'block' : 'none';\n" +
    "    var bV = document.getElementById('pi-menu-vault');\n" +
    "    var bR = document.getElementById('pi-menu-retrieve');\n" +
    "    var bA = document.getElementById('pi-menu-accountants');\n" +
    "    if (bV) bV.className = 'btn sm' + (PI.menu === 'vault' ? ' gold' : '');\n" +
    "    if (bR) bR.className = 'btn sm' + (PI.menu === 'retrieve' ? ' gold' : '');\n" +
    "    if (bA) bA.className = 'btn sm' + (PI.menu === 'accountants' ? ' gold' : '');\n" +
    "    if (PI.menu === 'vault') renderVaultTree();\n" +
    "    if (PI.menu === 'retrieve') renderSteps();\n" +
    "    if (PI.menu === 'accountants') piRenderAccountantCards();\n" +
    "  };",
  count: 1,
});

patches.push({
  note: 'Review step links to the Accountants sub-menu instead of embedding cards',
  find: "      '<div id=\"pi-accountant-cards\" style=\"margin-top:10px\"></div>' +",
  replace:
    "      '<div style=\"margin-top:10px;color:var(--tx3)\">Accountant cards (emails, apartments, PDFs/Excel) are managed in the <a href=\"#\" onclick=\"piSetMenu(&quot;accountants&quot;);return false\">Accountants</a> sub-menu.</div>' +",
  count: 1,
});

patches.push({
  note: 'Review step no longer renders cards inline',
  find: '    try { piRenderAccountantCards(); piLoadAgentLatest(); } catch (eCards) {}',
  replace: '    try { piLoadAgentLatest(); } catch (eCards) {}',
  count: 1,
});

const cardsJs =
  "  function piAcctEsc(s) {\n" +
  "    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\"/g, '&quot;');\n" +
  "  }\n" +
  "  function piAcctAptNames() {\n" +
  "    var apts = (typeof S !== 'undefined' && Array.isArray(S.apts)) ? S.apts : [];\n" +
  "    return apts.map(function (a) { return String((a && a.name) || '').trim(); }).filter(Boolean).sort();\n" +
  "  }\n" +
  "  window._piAcctCards = [];\n" +
  "  function piAcctCollect() {\n" +
  "    var box = document.getElementById('pi-accountant-cards');\n" +
  "    if (!box) return;\n" +
  "    box.querySelectorAll('.pi-acct-card').forEach(function (el) {\n" +
  "      var c = (window._piAcctCards || [])[parseInt(el.getAttribute('data-i'), 10)];\n" +
  "      if (!c) return;\n" +
  "      var get = function (f) { var n = el.querySelector('[data-f=\"' + f + '\"]'); return n ? n.value : ''; };\n" +
  "      var chk = function (f) { var n = el.querySelector('[data-f=\"' + f + '\"]'); return !!(n && n.checked); };\n" +
  "      c.name = get('name');\n" +
  "      c.email = get('email');\n" +
  "      c.receivePdfs = chk('receivePdfs');\n" +
  "      c.receiveExcel = chk('receiveExcel');\n" +
  "    });\n" +
  "  }\n" +
  "  function piAcctPaint() {\n" +
  "    var box = document.getElementById('pi-accountant-cards');\n" +
  "    if (!box) return;\n" +
  "    var cards = window._piAcctCards || [];\n" +
  "    var names = piAcctAptNames();\n" +
  "    var html = cards.map(function (c, i) {\n" +
  "      var chips = (c.apartments || []).map(function (a, j) {\n" +
  "        return '<span style=\"display:inline-flex;align-items:center;gap:4px;border:1px solid var(--bdr);border-radius:999px;padding:2px 8px;font-size:12px;background:var(--bg2)\">' + piAcctEsc(a) +\n" +
  "          '<a href=\"#\" onclick=\"piAcctDelApt(' + i + ',' + j + ');return false\" style=\"text-decoration:none;color:var(--tx3)\">×</a></span>';\n" +
  "      }).join('');\n" +
  "      return '<div class=\"pi-acct-card\" data-i=\"' + i + '\" style=\"border:1px solid var(--bdr);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg)\">' +\n" +
  "        '<div style=\"display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px\">' +\n" +
  "        '<input data-f=\"name\" value=\"' + piAcctEsc(c.name || '') + '\" placeholder=\"Name\" style=\"font-weight:600;flex:1;min-width:160px\">' +\n" +
  "        '<label style=\"font-size:12px\"><input type=\"checkbox\" data-f=\"receivePdfs\"' + (c.receivePdfs ? ' checked' : '') + '> PDFs</label>' +\n" +
  "        '<label style=\"font-size:12px\"><input type=\"checkbox\" data-f=\"receiveExcel\"' + (c.receiveExcel ? ' checked' : '') + '> Excel</label>' +\n" +
  "        '<button class=\"btn sm\" onclick=\"piAcctRemoveCard(' + i + ')\">Remove</button>' +\n" +
  "        '</div>' +\n" +
  "        '<label style=\"display:block;font-size:12px;margin-bottom:8px\">Emails (comma-separated) — the whole pack for this card goes here <input data-f=\"email\" value=\"' + piAcctEsc(c.email || '') + '\" style=\"width:100%;margin-top:2px\"></label>' +\n" +
  "        '<div style=\"font-size:12px;color:var(--tx3);margin-bottom:4px\">Apartments — leave empty to send <b>every</b> apartment; list some to send only their PDFs and Excel rows</div>' +\n" +
  "        '<div style=\"display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px\">' + (chips || '<span style=\"color:var(--tx3);font-size:12px\">All apartments</span>') + '</div>' +\n" +
  "        '<div style=\"display:flex;gap:6px\">' +\n" +
  "        '<input data-f=\"apt-add\" list=\"pi-apt-datalist\" placeholder=\"Add apartment…\" style=\"flex:1;min-width:160px\">' +\n" +
  "        '<button class=\"btn sm\" onclick=\"piAcctAddApt(' + i + ')\">Add</button>' +\n" +
  "        '</div>' +\n" +
  "        '<input type=\"hidden\" data-f=\"id\" value=\"' + piAcctEsc(c.id || '') + '\">' +\n" +
  "        '</div>';\n" +
  "    }).join('');\n" +
  "    html += '<datalist id=\"pi-apt-datalist\">' + names.map(function (n) { return '<option value=\"' + piAcctEsc(n) + '\"></option>'; }).join('') + '</datalist>';\n" +
  "    html += '<div style=\"display:flex;gap:8px;margin-top:4px\">' +\n" +
  "      '<button class=\"btn sm\" onclick=\"piAcctAddCard()\">Add accountant</button>' +\n" +
  "      '<button class=\"btn sm gold\" onclick=\"piSaveAccountantCards()\">Save accountant cards</button>' +\n" +
  "      '</div>';\n" +
  "    if (!cards.length) html = '<div style=\"color:var(--tx3);margin-bottom:8px\">No accountant cards yet — add one below.</div>' + html;\n" +
  "    box.innerHTML = html;\n" +
  "  }\n" +
  "  window.piAcctAddApt = function (i) {\n" +
  "    piAcctCollect();\n" +
  "    var el = document.querySelector('.pi-acct-card[data-i=\"' + i + '\"] [data-f=\"apt-add\"]');\n" +
  "    var v = el ? String(el.value || '').trim() : '';\n" +
  "    var c = (window._piAcctCards || [])[i];\n" +
  "    if (!c || !v) return;\n" +
  "    c.apartments = c.apartments || [];\n" +
  "    var has = c.apartments.some(function (a) { return String(a).toLowerCase() === v.toLowerCase(); });\n" +
  "    if (!has) c.apartments.push(v);\n" +
  "    piAcctPaint();\n" +
  "  };\n" +
  "  window.piAcctDelApt = function (i, j) {\n" +
  "    piAcctCollect();\n" +
  "    var c = (window._piAcctCards || [])[i];\n" +
  "    if (c && c.apartments) c.apartments.splice(j, 1);\n" +
  "    piAcctPaint();\n" +
  "  };\n" +
  "  window.piAcctAddCard = function () {\n" +
  "    piAcctCollect();\n" +
  "    window._piAcctCards.push({ id: '', name: '', email: '', receivePdfs: true, receiveExcel: true, apartments: [] });\n" +
  "    piAcctPaint();\n" +
  "  };\n" +
  "  window.piAcctRemoveCard = function (i) {\n" +
  "    piAcctCollect();\n" +
  "    window._piAcctCards.splice(i, 1);\n" +
  "    piAcctPaint();\n" +
  "  };\n" +
  "  window.piRenderAccountantCards = async function () {\n" +
  "    var box = document.getElementById('pi-accountant-cards');\n" +
  "    if (!box) return;\n" +
  "    try {\n" +
  "      var j = await fetch('/api/platform-invoices/accountants').then(function (r) { return r.json(); });\n" +
  "      window._piAcctCards = ((j && j.accountants) || []).map(function (c) {\n" +
  "        return { id: c.id || '', name: c.name || '', email: c.email || '', receivePdfs: !!c.receivePdfs, receiveExcel: !!c.receiveExcel, apartments: Array.isArray(c.apartments) ? c.apartments.slice() : [] };\n" +
  "      });\n" +
  "      piAcctPaint();\n" +
  "    } catch (e) { box.innerHTML = '<div style=\"color:#b00\">' + (e.message || e) + '</div>'; }\n" +
  "  };\n" +
  "  window.piSaveAccountantCards = async function () {\n" +
  "    piAcctCollect();\n" +
  "    var cards = (window._piAcctCards || []).map(function (c) {\n" +
  "      return { id: c.id, name: c.name || c.email, email: c.email, receivePdfs: c.receivePdfs, receiveExcel: c.receiveExcel, apartments: c.apartments || [] };\n" +
  "    });\n" +
  "    msg('Saving accountant cards…', true);\n" +
  "    try {\n" +
  "      var res = await fetch('/api/platform-invoices/accountants', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountants: cards }) });\n" +
  "      var j = await res.json();\n" +
  "      if (!res.ok) throw new Error((j && j.error) || 'save failed');\n" +
  "      msg('Accountant cards saved', true);\n" +
  "      await piRenderAccountantCards();\n" +
  "    } catch (e) { msg(e.message || String(e), false); }\n" +
  "  };\n";

patches.push({
  note: 'Accountant cards with apartments editor (overrides earlier render/save)',
  find: '  window.piLoadAgentLatest = async function () {',
  replace: cardsJs + '  window.piLoadAgentLatest = async function () {',
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
  builtAt: '2026-08-22 Accountants sub-menu with per-card apartments',
  patches: patches,
  assertions: [
    { has: "id=\"pi-menu-accountants\"", note: 'Accountants sub-menu button' },
    { has: "id=\"pi-view-accountants\"", note: 'Accountants view' },
    { has: 'piAcctAddApt', note: 'apartment editor on cards' },
    { has: "if (PI.menu === 'accountants') piRenderAccountantCards();", note: 'sub-menu renders cards' },
    { hasNot: "'<div id=\"pi-accountant-cards\" style=\"margin-top:10px\"></div>' +", note: 'cards no longer embedded in review step' },
  ],
};

fs.writeFileSync(path.join(root, 'fe', 'patches-136.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote fe/patches-136.json', cfg.expectedSha256);
