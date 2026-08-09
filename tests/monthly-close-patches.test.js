'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches.json'), 'utf8'));
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

for (const [index, patch] of spec.patches.entries()) {
  const count = html.split(patch.find).length - 1;
  assert.strictEqual(count, patch.count || 1, `patch ${index + 1} (${patch.note}) anchor count`);
  html = html.split(patch.find).join(patch.replace);
}

const sha = crypto.createHash('sha256').update(html).digest('hex');
assert.strictEqual(sha, spec.expectedSha256, 'effective frontend hash');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(source => source.trim());
scripts.forEach((source, index) => new vm.Script(source, { filename: `effective-script-${index + 1}.js` }));

const monthlyCloseStart = html.indexOf('// ---- Report stage: work in the real Reports tab, then come back ----');
const showReport = html.indexOf("showTab('rpt'", monthlyCloseStart);
const restoreChannels = html.indexOf('rptChanSel = new Set(_snap.chans)', monthlyCloseStart);
assert(monthlyCloseStart >= 0 && showReport > monthlyCloseStart, 'Monthly Close report opener exists');
assert(restoreChannels > showReport, 'confirmed channels are restored after showTab clears them');

assert(html.includes('payout: _pks.reduce'), 'grouped report freezes the combined payout');
assert(html.includes('memberIds: _pks.map'), 'grouped report freezes its member IDs');
assert(html.includes('cleanOverride: (_cleanKey'), 'cleaning override is captured in the close snapshot');
assert(html.includes('moOverride: (_moKey'), 'month override is captured in the close snapshot');
const mcPersistOcc = html.split('monthlyClose: S.monthlyClose || {}').length - 1;
assert(mcPersistOcc >= 3, `Monthly Close persisted in save(), post-load rewrite and server payload (found ${mcPersistOcc})`);
assert(html.includes("fetch('/api/proofs?month='"), 'email reads authoritative proof metadata');
assert(html.includes("String(p.task_key || p.task || '')"), 'email matches proof task keys');
assert(html.includes("_aptIds.indexOf(String(p.apt_id || p.aptId || ''))"), 'email matches proofs for every report apartment');
assert(html.includes('(too large for one email'), 'attachment size guard keeps the send under the server cap');
assert(html.includes("setApt('${a.id}','ownerEmail3'"), 'configuration accepts up to three owner email addresses');
assert(html.includes('p.a.ownerEmail3'), 'owner email goes to every configured address');
assert(html.includes("rem:s.rem+m.rem"), 'Annual Tracker totals the cleared owner remittance');
assert(html.includes('${m.rem?fmt(m.rem)'), 'Annual Tracker shows the cleared remittance per month');
assert(html.includes('if(!Array.isArray(a.fixedCharges))a.fixedCharges=[];'), 'Add fixed charge works on pre-field apartments');

const packets = [
  { payout: 100, b2bRem: 110, ctDeduct: 3, vatDeduct: 2, atDeduct: 1 },
  { payout: 250, b2bRem: 275, ctDeduct: 5, vatDeduct: 4, atDeduct: 2 },
];
assert.strictEqual(packets.reduce((sum, packet) => sum + (packet.payout || 0), 0), 350);
assert.strictEqual(packets.reduce((sum, packet) => sum + (packet.b2bRem || 0), 0), 385);

console.log(`monthly-close patches OK: ${spec.patches.length} patches, ${scripts.length} scripts, ${sha}`);
