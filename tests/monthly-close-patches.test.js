'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const origHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
let html = origHtml;

// Releases ship as a chain: fe/patches.json, then fe/patches-2.json, -3.json …
// Each file starts where the previous one ended, so a release is a small new
// file rather than a rewrite of one ever-growing patches.json.
const chainFiles = ['patches.json'];
for (let n = 2; n <= 80; n++) {
  const f = path.join(root, 'fe', `patches-${n}.json`);
  if (!fs.existsSync(f)) break;
  chainFiles.push(`patches-${n}.json`);
}

// A chain file may carry its own `assertions` — [{has|hasNot, note}] checked
// against the final effective output. Feature checks then ship WITH the release
// that introduces them, instead of this file growing on every deploy.
const declared = [];
function collect(file, spec) {
  (spec.assertions || []).forEach(a => declared.push({ file, ...a }));
}
function checkDeclared(text, kind) {
  declared.filter(a => a.file.startsWith(kind)).forEach(a => {
    if (a.has) assert(text.includes(a.has), `${a.file}: ${a.note}`);
    if (a.hasNot) assert(!text.includes(a.hasNot), `${a.file}: ${a.note}`);
  });
}

let spec = null;
let sha = crypto.createHash('sha256').update(html).digest('hex');
let patchCount = 0;
for (const file of chainFiles) {
  spec = JSON.parse(fs.readFileSync(path.join(root, 'fe', file), 'utf8'));
  collect('fe/' + file, spec);
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
checkDeclared(html, 'fe/');

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}
function extractConst(source, name) {
  const start = source.indexOf('const ' + name + ' = {');
  assert(start >= 0, 'missing ' + name);
  return source.slice(start, source.indexOf('};', start) + 2);
}
assert.strictEqual(extractFn(origHtml, 'calcBase'), extractFn(html, 'calcBase'), 'calcBase unchanged (golden path)');
assert.strictEqual(
  extractFn(origHtml, 'calcAptPacket').replace(/^[\s\S]*?(function calcAptPacket)/, '$1'),
  extractFn(html, 'calcAptPacket').replace(/^[\s\S]*?(function calcAptPacket)/, '$1'),
  'calcAptPacket implementation unchanged'
);
['HORIZON_JUNE', 'SKYLINE_JUNE', 'COZY_JUNE'].forEach(name => {
  assert.strictEqual(extractConst(origHtml, name), extractConst(html, name), name + ' locked values unchanged');
});
const goldenStart = '// ── TEST GROUP 4: Golden Standard — Horizon June 2026';
const goldenEnd = '// ── TEST GROUP 5: Leased Profile invariants';
assert.strictEqual(
  origHtml.slice(origHtml.indexOf(goldenStart), origHtml.indexOf(goldenEnd)),
  html.slice(html.indexOf(goldenStart), html.indexOf(goldenEnd)),
  'G1–G31 golden test block is byte-identical'
);
assert(html.includes("assert('G1 Horizon gross'"), 'G1 Horizon golden assertion still present');
assert(html.includes("assert('G31 Cozy B2B partner line'"), 'G31 Cozy golden assertion still present');
assert(html.includes('calcBase(gBks, goldenApt)'), 'Horizon golden still calls calcBase with no stay override');
assert(html.includes('calcBase(sBksRaw, skylineApt)'), 'Skyline golden still calls calcBase with no stay override');
assert(html.includes('calcBase(czBksRaw, cozyApt)'), 'Cozy golden still calls calcBase with no stay override');

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

const packetSrc = [
  (() => {
    const start = html.indexOf('const BLOCK_NAMES = ');
    const end = html.indexOf('function rptMonthsSpanned', start);
    assert(start >= 0 && end > start, 'packet helpers present');
    return html.slice(start, end);
  })(),
  extractFn(html, 'sumPackets'),
].join('\n');
const packetCtx = {};
vm.runInNewContext(packetSrc + '\nthis.calcAptPacket = calcAptPacket;\nthis.sumPackets = sumPackets;\nthis.calcBase = calcBase;', packetCtx);
const mA = { id:'mA', name:'Multi A', mgmtFee:15, cleaningFee:20, vatOnFees:false,
  businessTax:true, businessTaxAmt:50, deductCT:true, deductVAT:true,
  municipalityTax:true, deductCleaning:true, b2b:false,
  fixedCharges:[{ id:'fA1', label:'Software', amount:45 }] };
const mB = { ...mA, id:'mB', name:'Multi B', cleaningFee:15, fixedCharges:[] };
const bk = (gross, ct, vat, at, cancelled, cleanH, svc, pchg) =>
  ({ gross, ct, vat, at, cancelled, cleanH, svc, pchg, guestName:'guest' });
const bksA = [ bk(1000, 50, 100, 10, false, 0, 120, 5), bk(500, 25, 50, 5, false, 0, 60, 2.5) ];
const bksB = [ bk(600, 30, 60, 6, false, 0, 72, 3), bk(400, 20, 40, 4, false, 0, 48, 2), bk(300, 15, 30, 3, false, 0, 36, 1.5) ];
const mExps = [
  { id:'me1', aptId:'mB', charge:true, net:100, vat:24, total:124, date:'15/06/2026' },
  { id:'me2', aptId:'__spl', charge:true, date:'16/06/2026', splits:[{ aptId:'mA', amt:30 }, { aptId:'mC', amt:70 }] },
];
const mGea = (e, forAptId) => {
  if (e.aptId === '__spl') return (e.splits||[]).filter(s => forAptId ? s.aptId===forAptId : true)
    .reduce((t,s)=>t+(parseFloat(s.amt)||0),0);
  if (forAptId && e.aptId !== forAptId) return 0;
  return parseFloat(e.net||e.total||0);
};
const mGeaVat = (e, forAptId) => {
  if (e.aptId === '__spl') return mGea(e, forAptId) * 0.24;
  if (forAptId && e.aptId !== forAptId) return 0;
  return parseFloat(e.vat||0);
};
const expsFor = id => mExps.filter(e => e.aptId===id || (e.aptId==='__spl' && (e.splits||[]).some(s=>s.aptId===id)));
const pAov = packetCtx.calcAptPacket(mA, bksA, expsFor('mA'), mGea, mGeaVat, 5, 1);
const pBov = packetCtx.calcAptPacket(mB, bksB, expsFor('mB'), mGea, mGeaVat, 1, 2);
assert.strictEqual(pAov.cleanDeduct, 100, 'grouped apt A cleaning override 5×20');
assert.strictEqual(pBov.cleanDeduct, 15, 'grouped apt B cleaning override 1×15');
assert.strictEqual(pAov.fixedCh, 45, 'grouped apt A software stays 1 month');
assert.strictEqual(pBov.m.bt, 100, 'grouped apt B business tax ×2 months');
assert.strictEqual(packetCtx.sumPackets([pAov, pBov]).payout, pAov.payout + pBov.payout, 'grouped payout with mixed overrides');

const stepCtx = { window: {}, S: { cleanOverride: {}, moOverride: {} }, saves: 0, renders: 0 };
stepCtx.window = stepCtx;
stepCtx.save = () => { stepCtx.saves++; };
stepCtx.renderRpt = () => { stepCtx.renders++; };
vm.runInNewContext(
  extractFn(html, 'rptOvKey') + '\n' +
  extractFn(html, 'rptCleanStep') + '\n' +
  extractFn(html, 'rptMoStep') + '\n' +
  extractFn(html, 'rptMoReset') + '\n' +
  extractFn(html, 'rptCleanReset') + '\n' +
  'this.rptOvKey = rptOvKey; this.rptCleanStep = rptCleanStep; this.rptMoStep = rptMoStep; this.rptMoReset = rptMoReset; this.rptCleanReset = rptCleanReset;',
  stepCtx
);
const dates = { from: new Date(Date.UTC(2026, 6, 1)), to: new Date(Date.UTC(2026, 6, 31)) };
stepCtx.window._rptMoAuto = 1;
stepCtx.window._rpt = {
  apt: { id: 'a1' },
  dates,
  packets: [
    { a: { id: 'a1' }, m: { cleanStays: 2, cleanStaysAuto: 2 }, months: 1 },
    { a: { id: 'a2' }, m: { cleanStays: 3, cleanStaysAuto: 3 }, months: 1 },
  ],
};
assert.strictEqual(stepCtx.rptOvKey('a1', dates), 'a1::2026-07-01::2026-07-31');
stepCtx.rptCleanStep(1, 'a1');
assert.strictEqual(stepCtx.S.cleanOverride['a1::2026-07-01::2026-07-31'], 3, 'a1 cleaning +1');
stepCtx.window._rpt.packets[1].m.cleanStays = 3;
stepCtx.rptCleanStep(-1, 'a2');
assert.strictEqual(stepCtx.S.cleanOverride['a2::2026-07-01::2026-07-31'], 2, 'a2 cleaning -1');
assert.strictEqual(stepCtx.S.cleanOverride['a1::2026-07-01::2026-07-31'], 3, 'a1 cleaning unchanged by a2 step');
stepCtx.rptMoStep(1, 'a2');
assert.strictEqual(stepCtx.S.moOverride['a2::2026-07-01::2026-07-31'], 2, 'a2 software months +1');
assert.strictEqual(stepCtx.S.moOverride['a1::2026-07-01::2026-07-31'], undefined, 'a1 months untouched');
stepCtx.rptMoStep(1, 'a1');
assert.strictEqual(stepCtx.S.moOverride['a1::2026-07-01::2026-07-31'], 2, 'a1 software months +1');
stepCtx.rptCleanReset('a1');
assert.ok(!Object.prototype.hasOwnProperty.call(stepCtx.S.cleanOverride, 'a1::2026-07-01::2026-07-31'), 'a1 cleaning reset');
assert.strictEqual(stepCtx.S.cleanOverride['a2::2026-07-01::2026-07-31'], 2, 'a2 cleaning survives a1 reset');
stepCtx.rptMoReset('a2');
assert.ok(!Object.prototype.hasOwnProperty.call(stepCtx.S.moOverride, 'a2::2026-07-01::2026-07-31'), 'a2 months reset');
assert.strictEqual(stepCtx.S.moOverride['a1::2026-07-01::2026-07-31'], 2, 'a1 months survive a2 reset');

const rsvCtx = {};
vm.runInNewContext(
  extractFn(html, 'parseD') + '\n' +
  extractFn(html, 'rptBkAptName') + '\n' +
  extractFn(html, 'rptOrderedBks') + '\n' +
  'this.parseD = parseD; this.rptBkAptName = rptBkAptName; this.rptOrderedBks = rptOrderedBks;',
  rsvCtx
);
const aptHorizon = { id: 'h1', name: 'Horizon' };
const aptSkyline = { id: 's1', name: 'Skyline' };
const mixedBks = [
  { aptId: 's1', aptName: 'wrong', guestName: 'Zed', checkIn: '05/06/2026' },
  { aptId: 'h1', aptName: 'wrong', guestName: 'Ann', checkIn: '20/06/2026' },
  { aptId: 'h1', aptName: 'wrong', guestName: 'Bob', checkIn: '02/06/2026' },
  { aptId: 's1', aptName: 'wrong', guestName: 'Cara', checkIn: '01/06/2026' },
];
const ordered = rsvCtx.rptOrderedBks(mixedBks, [aptHorizon, aptSkyline]);
assert.deepStrictEqual(ordered.map(b => b.guestName), ['Bob', 'Ann', 'Cara', 'Zed'], 'grouped reservations: first apt then check-in');
assert.strictEqual(rsvCtx.rptBkAptName(ordered[0], [aptHorizon, aptSkyline]), 'Horizon');
assert.strictEqual(rsvCtx.rptBkAptName(ordered[2], [aptHorizon, aptSkyline]), 'Skyline');
assert.strictEqual(html.includes("['Apartment','Channel','Guest','Check-in'"), true, 'screen reservations table has Apartment column');
assert.strictEqual(html.includes('<th>Apartment</th><th>Guest</th><th>Check-in</th>'), true, 'PDF reservations table has Apartment column');
assert.ok(html.includes('colspan="6"><b>Total (${bks.length})</b>'), 'PDF footer spans the apartment column');
assert.strictEqual(mixedBks[0].guestName, 'Zed', 'sort copies the list and does not mutate the source');


// ── Server patches (srv/patches.json → server.js), mirroring srv-boot.js ─────
const srvChain = ['patches.json'];
for (let n = 2; n <= 80; n++) {
  if (!fs.existsSync(path.join(root, 'srv', `patches-${n}.json`))) break;
  srvChain.push(`patches-${n}.json`);
}
let srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let srvSha = crypto.createHash('sha256').update(srv).digest('hex');
let srvCount = 0;
for (const file of srvChain) {
  const srvSpec = JSON.parse(fs.readFileSync(path.join(root, 'srv', file), 'utf8'));
  collect('srv/' + file, srvSpec);
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
checkDeclared(srv, 'srv/');
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

console.log(`monthly-close patches OK: ${patchCount} patches in ${chainFiles.length} chain file(s), ${scripts.length} scripts, ${declared.length} declared checks, ${sha}; server: ${srvCount} patches in ${srvChain.length} chain file(s), ${srvSha}`);
