'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// Releases ship as a chain: fe/patches.json, then fe/patches-2.json, -3.json …
// Each file starts where the previous one ended, so a release is a small new
// file rather than a rewrite of one ever-growing patches.json.
const chainFiles = ['patches.json'];
for (let n = 2; n <= 20; n++) {
  const f = path.join(root, 'fe', `patches-${n}.json`);
  if (!fs.existsSync(f)) break;
  chainFiles.push(`patches-${n}.json`);
}

let spec = null;
let sha = crypto.createHash('sha256').update(html).digest('hex');
let patchCount = 0;
for (const file of chainFiles) {
  spec = JSON.parse(fs.readFileSync(path.join(root, 'fe', file), 'utf8'));
  assert.strictEqual(spec.baseSha256, sha, `${file} continues the chain`);
  for (const [index, patch] of spec.patches.entries()) {
    const count = html.split(patch.find).length - 1;
    assert.strictEqual(count, patch.count || 1, `${file} patch ${index + 1} (${patch.note}) anchor count`);
    html = html.split(patch.find).join(patch.replace);
  }
  sha = crypto.createHash('sha256').update(html).digest('hex');
  assert.strictEqual(sha, spec.expectedSha256, `${file} effective frontend hash`);
  patchCount += spec.patches.length;
}
assert(chainFiles.length >= 2, 'the release chain is in use');

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
assert(html.includes('lk.email.at >= (r.remit.at_ms || 0)'), 'Email stage ignores stamps older than this close\'s confirmation');
assert(html.includes('mcSetComment'), 'close card has a comments box saved to the close record');
assert(html.includes('Notes for this period:'), 'close comments ride into the owner email message');
assert(html.includes('id="mc-searchbox"'), 'search bar renders in Focus view too');
assert(html.includes('QF.forEach'), 'Focus queue narrows to the search matches');
assert(html.includes('class="mc-pace'), 'daily pace chip renders in the close header');
assert(html.includes("new Date(parseInt(p[0], 10), parseInt(p[1], 10), 10)"), 'pace deadline is the 10th of the month after the close month');
assert(html.includes('_abortSend = true'), 'declining the invoice step is recorded to cancel the send');
assert(html.includes('if (_abortSend) {'), 'send actually stops before the fetch when the invoice step is declined');
assert(html.includes('function _emailAttName('), 'fixed attachment-name builder exists');
assert(html.includes('function _emailAttExt('), 'attachment extension guesser exists');
assert(html.includes('_emailAttName(_apt.profile'), 'invoice attachment uses the fixed naming scheme');
assert(html.includes('_emailAttName(w.pre, _apt.name, _attPer'), 'proof attachments use the fixed naming scheme');
assert(html.includes("pre: 'TAKK_Issuance'"), 'TAKK issuance document kind named TAKK_Issuance');
assert(html.includes("pre: 'TAKK_Payment'"), 'TAKK payment document kind named TAKK_Payment');
assert(html.includes("pre: 'Payment_Proof'"), 'owner payment document kind named Payment_Proof');
assert(html.includes('fmt(-ea)'), 'expense rows formatted with their real sign (credit notes)');
assert(html.includes("' (credit)'"), 'PDF marks credit-note expense lines');
assert(!html.includes("'-'+fmt(ea)"), 'no hard-coded minus prefixes left on screen expense rows');
assert(html.includes('function expToggleMonth(k)'), 'Expenses tab has a month-group toggle');
assert(html.includes("window._expOpen.add(_mks[0])"), 'latest expense month opens by default');
assert(html.includes('expToggleMonth(\'${k}\')'), 'month header rows toggle their group');
assert(html.includes('_qOpen||window._expOpen.has(k)'), 'search opens all expense month groups');
assert(html.includes('id="nav-cash"'), 'Cash Flow appears in the Tools menu');
assert(html.includes('id="tab-cash"'), 'Cash Flow tab panel exists');
assert(html.includes("name==='cash'"), 'showTab dispatches the Cash Flow renderer');
assert(html.includes('function renderCash()'), 'Cash Flow renderer exists');
assert(html.includes('Exclude internal transfers (Eurobank)'), 'internal-transfer toggle present');
assert(html.includes("fetch('/api/viva/cashflow')"), 'Cash Flow reads the server cache');
assert(html.includes('function cfSetW(n)'), 'Cash Flow chart has a range setter');
assert(html.includes('Math.min(window._cfW||60,days.length)'), 'chart window follows the selected range');
assert(html.includes('[30,60,90,180,365].filter(n=>n<days.length)'), 'range options adapt to the cached history');
assert(html.includes("_wOpts.push(days.length);"), 'an All option covering the whole cache is offered');
assert(!html.includes('const W=Math.min(60,days.length)'), 'hard-coded 60-day chart window is gone');
assert(!html.includes('pull the last 130 days'), 'empty-state copy no longer promises a fixed 130 days');
assert(html.includes("var MC_SKIP_PW = '2026';"), 'skip-month action is password gated');
assert(html.includes('window.mcNotNeeded'), 'Not-needed-this-month action exists');
assert(html.includes('window.mcUndoNotNeeded'), 'a skipped month can be undone');
assert(html.includes("a.type === 'private'"), 'private apartments get the TAKK reminder');
assert(html.includes('The TAKK still has to be issued'), 'TAKK warning text present');
assert(html.includes('function mcPrevSkipped(id)'), 'previous-month skip lookup exists');
assert(html.includes('skipped</span>'), 'previous-month skip is flagged on the focus card');
assert(html.includes('!complete(a) && !mcSkipped(a.id)'), 'skipped apartments leave the queue');
assert(html.includes('if (mcSkipped(a.id)) { skipN += n; return; }'), 'skipped apartments are never counted as sent');
assert(html.includes('var _need = Math.max(0, tot - skipN);'), 'progress measures what actually needs clearing');

// ── Server patches (srv/patches.json → server.js), mirroring srv-boot.js ─────
const srvChain = ['patches.json'];
for (let n = 2; n <= 20; n++) {
  if (!fs.existsSync(path.join(root, 'srv', `patches-${n}.json`))) break;
  srvChain.push(`patches-${n}.json`);
}
let srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let srvSha = crypto.createHash('sha256').update(srv).digest('hex');
let srvCount = 0;
for (const file of srvChain) {
  const srvSpec = JSON.parse(fs.readFileSync(path.join(root, 'srv', file), 'utf8'));
  assert.strictEqual(srvSpec.baseSha256, srvSha, `srv/${file} continues the chain`);
  for (const [index, patch] of srvSpec.patches.entries()) {
    const count = srv.split(patch.find).length - 1;
    assert.strictEqual(count, patch.count || 1, `srv/${file} patch ${index + 1} (${patch.note}) anchor count`);
    srv = srv.split(patch.find).join(patch.replace);
  }
  srvSha = crypto.createHash('sha256').update(srv).digest('hex');
  assert.strictEqual(srvSha, srvSpec.expectedSha256, `srv/${file} effective server hash`);
  srvCount += srvSpec.patches.length;
}
new vm.Script(srv, { filename: 'server.effective.js' });
assert(srv.includes("app.get('/api/viva/cashflow'"), 'cashflow read endpoint exists');
assert(srv.includes("app.post('/api/viva/cashflow/refresh'"), 'cashflow refresh endpoint exists');
assert(srv.includes('function cfCronTick'), 'cashflow 06:00 scheduler exists');
assert(srv.includes('cfIsInternal'), 'internal Eurobank transfer tagging exists');
assert(srv.includes("|| 730));"), 'cash-flow window defaults to the full ~2-year span');
assert(srv.includes('const _rows = _fi > 0 ? _allRows.slice(_fi) : _allRows;'), 'empty lead-in trimmed from the cache');
assert(srv.includes("cfRefresh('manual', req.query && req.query.days)"), 'refresh honours a ?days= override');
assert(!srv.includes('for (let page = 1; page <= 40; page++)'), 'Search page cap raised beyond 40');
assert(srv.includes("const cf = path.join(__dirname, 'fe', 'patches-' + cn + '.json');"), 'FE bootstrap walks the patches-N release chain');
assert(srv.includes('does not continue the chain'), 'a chain file that does not continue the chain is rejected');
assert(srv.includes('patches: chainOps'), '/api/fe-info reports the whole chain');
assert(srv.includes("console.log('  FE: applied ' + chainOps + ' patch(es)") && srv.includes("' bytes, sha256 ' + chainSha.slice(0, 12)"), 'boot log reports the whole chain');

assert(srv.includes("app.get('/api/rental-info'"), 'Property Info portfolio endpoint exists');
assert(srv.includes("app.get('/api/rental-info/:id'"), 'Property Info read endpoint exists');
assert(srv.includes("app.post('/api/rental-info/:id'"), 'Property Info save endpoint exists (the tab 404d without it)');
assert(srv.includes('CREATE TABLE IF NOT EXISTS rental_info'), 'rental_info table is self-healing like proof_files');
assert(srv.includes('ON CONFLICT (rental_id) DO UPDATE'), 'saving one apartment upserts its own row');
assert(srv.includes('function riShape('), 'saved records are shaped, so junk fields cannot land in the column');
assert(srv.includes("app.get('/api/whoami'"), 'whoami endpoint exists');
assert(html.includes("fetch('/api/rental-info/'"), 'the Property Info tab is the client of those endpoints');

const boot = fs.readFileSync(path.join(root, 'srv-boot.js'), 'utf8');
new vm.Script('(function(exports,require,module,__filename,__dirname){\n' + boot.replace(/^#![^\n]*\n/, '') + '\n})', { filename: 'srv-boot.js' });
assert(boot.includes("'patches-' + n + '.json'"), 'srv-boot walks the server release chain');
assert(boot.includes("' base drift: have '"), 'each chain file must continue the chain');
assert(srvChain.length >= 2, 'the server release chain is in use');

const packets = [
  { payout: 100, b2bRem: 110, ctDeduct: 3, vatDeduct: 2, atDeduct: 1 },
  { payout: 250, b2bRem: 275, ctDeduct: 5, vatDeduct: 4, atDeduct: 2 },
];
assert.strictEqual(packets.reduce((sum, packet) => sum + (packet.payout || 0), 0), 350);
assert.strictEqual(packets.reduce((sum, packet) => sum + (packet.b2bRem || 0), 0), 385);

console.log(`monthly-close patches OK: ${patchCount} patches in ${chainFiles.length} chain file(s), ${scripts.length} scripts, ${sha}; server: ${srvCount} patches in ${srvChain.length} chain file(s), ${srvSha}`);
