'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

function applyFe(stopAt) {
  let src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  let sha = sha256(src);
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (stopAt && name === stopAt) break;
    const file = path.join(root, 'fe', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 !== sha) throw new Error(name + ' base drift');
    for (const p of spec.patches || []) {
      const count = src.split(p.find).length - 1;
      if (count !== (p.count || 1)) throw new Error(name + ' ' + p.note + ' x' + count);
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    if (sha !== spec.expectedSha256) throw new Error(name + ' expected sha');
  }
  return { src, sha };
}

const prev = applyFe('patches-133.json');
const find =
  '      g.lines.forEach(l => {\n' +
  '        l.key   = pcKeyBdc(g.thuISO, l.aptKey);\n' +
  '        l.mark  = marks[l.key] || null;\n';
const replace =
  '      g.lines.forEach(l => {\n' +
  '        l.key   = pcKeyBdc(g.thuISO, l.aptKey);\n' +
  '        if (!marks[l.key]) {\n' +
  '          var liveKeys = g.lines.map(function (x) { return pcKeyBdc(g.thuISO, x.aptKey); });\n' +
  '          var staleFit = Object.keys(marks).filter(function (k) {\n' +
  '            if (k.indexOf(\'bdc|\' + g.thuISO + \'|\') !== 0) return false;\n' +
  '            if (liveKeys.indexOf(k) >= 0) return false;\n' +
  '            var m = marks[k];\n' +
  '            var mv = (m && m.amt != null && m.amt !== \'\') ? +m.amt : (m ? +m.exp : NaN);\n' +
  '            return isFinite(mv) && Math.abs(mv - l.exp) <= 0.011;\n' +
  '          });\n' +
  '          var siblings = staleFit.length === 1 ? g.lines.filter(function (o) {\n' +
  '            if (pcKeyBdc(g.thuISO, o.aptKey) === l.key || marks[pcKeyBdc(g.thuISO, o.aptKey)]) return false;\n' +
  '            var m = marks[staleFit[0]];\n' +
  '            var mv = (m && m.amt != null && m.amt !== \'\') ? +m.amt : (m ? +m.exp : NaN);\n' +
  '            return isFinite(mv) && Math.abs(mv - o.exp) <= 0.011;\n' +
  '          }) : [];\n' +
  '          if (staleFit.length === 1 && !siblings.length) {\n' +
  '            marks[l.key] = marks[staleFit[0]];\n' +
  '            if (typeof window !== \'undefined\') window._pcStaleMigrated = true;\n' +
  '          }\n' +
  '        }\n' +
  '        l.mark  = marks[l.key] || null;\n';

const n = prev.src.split(find).length - 1;
if (n !== 1) throw new Error('pcKeyBdc mark lookup found ' + n);
const outSrc = prev.src.split(find).join(replace);

const findSave =
  '  function renderPay() {\n' +
  '    const panel = document.getElementById(\'tab-pay\');\n' +
  '    if (!panel) return;\n' +
  '    const C = pcCompute();\n';
const replaceSave =
  '  function renderPay() {\n' +
  '    const panel = document.getElementById(\'tab-pay\');\n' +
  '    if (!panel) return;\n' +
  '    const C = pcCompute();\n' +
    '    if (window._pcStaleMigrated) {\n' +
  '      window._pcStaleMigrated = false;\n' +
  '      if (typeof save === \'function\') save();\n' +
  '    }\n';
const n2 = outSrc.split(findSave).length - 1;
if (n2 !== 1) throw new Error('renderPay found ' + n2);
let finalSrc = outSrc.split(findSave).join(replaceSave);

const findProbe =
  '          lr.missingExpected.forEach(x => { html += \'<div style="color:var(--tx2);padding:1px 0">\' + esc(x.label) + \' — \' + fmt(x.exp) + \'</div>\'; });\n';
const replaceProbe =
  '          lr.missingExpected.forEach(x => { html += \'<div style="color:var(--tx2);padding:1px 0">\' + esc(x.label) + \' — \' + fmt(x.exp) + \'</div>\'; });\n' +
  '        }\n' +
  '        if ((lr.leftoverProbe || []).length) {\n' +
  '          html += \'<div style="font-weight:700;margin:8px 0 4px">Leftover Lycabettus / Horizon (not yet 3 days late)</div>\';\n' +
  '          lr.leftoverProbe.forEach(function (x) {\n' +
  '            html += \'<div style="color:var(--tx2);padding:1px 0;font-family:var(--mono);font-size:11.5px">\' + esc(x.key) + \' · \' + esc(x.date) + \' · \' + fmt(x.exp) + (x.near && x.near.length ? (\' · near \' + x.near.map(function (n) { return fmt(n.amount) + \' \' + (n.chan || \'?\') + (n.used ? \' used\' : \'\'); }).join(\', \')) : \'\') + \'</div>\';\n' +
  '          });\n' +
  '        }\n' +
  '        if ((lr.sampleUnclassified || []).length) {\n' +
  '          html += \'<div style="font-weight:700;margin:8px 0 4px">Unclassified bank credits (not treated as Booking.com / Airbnb)</div>\';\n' +
  '          lr.sampleUnclassified.forEach(function (x) {\n' +
  '            html += \'<div style="color:var(--tx2);padding:1px 0;font-family:var(--mono);font-size:11.5px">\' + esc(x.date) + \' · \' + esc(x.counterpart) + \' · \' + fmt(x.amount) + \'</div>\';\n' +
  '          });\n';
const n3 = finalSrc.split(findProbe).length - 1;
if (n3 !== 1) throw new Error('missingExpected render found ' + n3);
finalSrc = finalSrc.split(findProbe).join(replaceProbe);

const cfg = {
  baseSha256: prev.sha,
  expectedSha256: sha256(finalSrc),
  builtAt: '2026-08-21 Payments Check: migrate stale report-group marks onto the unique apartment line',
  patches: [
    { note: 'Migrate stale Michalakopoulou-style BDC marks onto the unique apt line', find: find, replace: replace, count: 1 },
    { note: 'Persist migrated Payments Check marks', find: findSave, replace: replaceSave, count: 1 },
    { note: 'Show leftoverProbe and unclassified Viva credits on Payments Check', find: findProbe, replace: replaceProbe, count: 1 }
  ],
  assertions: [
    { has: "typeof window !== 'undefined'", note: 'stale mark migration flag' },
    { has: 'liveKeys.indexOf(k) >= 0', note: 'skip live keys when migrating' },
    { has: 'leftoverProbe', note: 'leftover Horizon probe in UI' },
    { has: 'sampleUnclassified', note: 'unclassified credits in UI' }
  ]
};
fs.writeFileSync(path.join(root, 'fe', 'patches-133.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote fe/patches-133.json', cfg.expectedSha256);
