'use strict';
/**
 * Payments Check batches only Votsala. Other clearGroups are for owner reports
 * and stay per-apartment because those payouts arrive one by one.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyKind(kind) {
  const baseName = kind === 'fe' ? 'index.html' : 'server.js';
  let src = fs.readFileSync(path.join(root, baseName), 'utf8').replace(/\r\n/g, '\n');
  let sha = sha256(src);
  let last = 'base';
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, kind + '/' + name + ' continues the chain');
    for (const [i, p] of (spec.patches || []).entries()) {
      const count = src.split(p.find).length - 1;
      assert.strictEqual(count, p.count || 1, kind + '/' + name + ' patch ' + (i + 1) + ' (' + p.note + ')');
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    assert.strictEqual(sha, spec.expectedSha256, kind + '/' + name + ' hash');
    last = name;
  }
  return { src, sha, last };
}

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

const fe = applyKind('fe');
const srv = applyKind('srv');
assert.strictEqual(fe.last, 'patches-138.json', 'FE 138 is the tip of the chain');
assert.strictEqual(srv.last, 'patches-100.json', 'SRV 100 is the tip of the chain');
assert(fe.src.includes('piRunAgent'), 'FE includes Platform Invoices agent');
assert(srv.src.includes("app.post('/api/platform-invoices/agent'"), 'SRV includes Platform Invoices agent');
assert(srv.src.includes("j.event === 'already_have'"), 'SRV tracks already_have');
assert(srv.src.includes('return await new Promise(function (resolvePull)'), 'SRV awaits pull worker');
assert(fe.src.includes('piUploadBookingZip'), 'FE includes Booking.com zip upload');
assert(fe.src.includes('"Villa Liberty": "3575720"'), 'FE includes Villa Liberty hotel id');
assert(srv.src.includes("app.post('/api/platform-invoices/booking-zip'"), 'SRV includes Booking zip ingest');
assert(srv.src.includes("app.post('/api/platform-invoices/booking-map'"), 'SRV includes Booking id map');
assert(fe.src.includes("if (g && !/^votsala$/i.test(g)) g = '';"), 'client ignores non-Votsala groups');
assert(fe.src.includes('window._pcStaleMigrated'), 'client migrates stale report-group marks');
assert(srv.src.includes('function pcvPayGroup'), 'server pay-group helper shipped');
assert(srv.src.includes("c.replace(/[\\s-]/g, '')"), 'server classifies spaced Viva IBANs');
assert(srv.src.includes('liveKeys.has(e[0])'), 'server ignores stale report-group mark tx ids');

const parseD = extractFn(fe.src, 'parseD');
const normAptName = extractFn(fe.src, 'normAptName');
const pcStart = fe.src.indexOf('function pcState()');
const pcCompute = extractFn(fe.src, 'pcCompute');
const pcEnd = fe.src.indexOf(pcCompute) + pcCompute.length;
assert(pcStart >= 0 && pcEnd > pcStart, 'Payments Check engine extractable');

const apts = [
  { id: 'v1', name: 'Votsala 1 Luxury Stay with Patio', clearGroup: 'Votsala' },
  { id: 'v2', name: 'Votsala 2 Luxury Stay with Patio', clearGroup: 'Votsala' },
  { id: 'h1', name: 'Horizon Test Apt', clearGroup: 'Michalakopoulou' },
  { id: 'h2', name: 'Lycabettus Test Apt', clearGroup: 'Michalakopoulou' },
];
const sandbox = {
  S: { apts, bks: [], payChk: { marks: {}, cfg: { from: '2026-07-01', tol: 1 } } },
  window: {},
  aptById(id) { return sandbox.S.apts.find((a) => a && String(a.id) === String(id)) || null; },
  parseD: null,
  normAptName: null,
};
vm.runInNewContext(
  parseD + '\n' + normAptName + '\n' +
  fe.src.slice(pcStart, pcEnd) + '\n' +
  'this.parseD = parseD;\nthis.normAptName = normAptName;\n' +
  'this.pcClearGroup = pcClearGroup;\nthis.pcAptKey = pcAptKey;\nthis.pcCompute = pcCompute;\n',
  sandbox
);

assert.strictEqual(sandbox.pcClearGroup({ aptId: 'v1' }), 'Votsala', 'Votsala still groups');
assert.strictEqual(sandbox.pcClearGroup({ aptId: 'h1' }), '', 'Michalakopoulou is not a Payments Check group');
assert.strictEqual(sandbox.pcClearGroup({ aptName: 'Lycabettus Test Apt' }), '', 'report group by name is ignored');
assert.strictEqual(sandbox.pcAptKey({ aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio' }), 'votsala');
assert.strictEqual(sandbox.pcAptKey({ aptId: 'h1', aptName: 'Horizon Test Apt' }), 'horizon test apt');
assert.notStrictEqual(
  sandbox.pcAptKey({ aptId: 'h1', aptName: 'Horizon Test Apt' }),
  sandbox.pcAptKey({ aptId: 'h2', aptName: 'Lycabettus Test Apt' }),
  'report-group apartments keep distinct keys'
);

sandbox.S.bks = [
  { platform: 'Booking.com', aptId: 'v1', aptName: 'Votsala 1 Luxury Stay with Patio', guestName: 'A', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 100 },
  { platform: 'Booking.com', aptId: 'v2', aptName: 'Votsala 2 Luxury Stay with Patio', guestName: 'B', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 50 },
  { platform: 'Booking.com', aptId: 'h1', aptName: 'Horizon Test Apt', guestName: 'C', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 100 },
  { platform: 'Booking.com', aptId: 'h2', aptName: 'Lycabettus Test Apt', guestName: 'D', checkIn: '14/7/2026', checkOut: '15/7/2026', payout: 50 },
];
const computed = sandbox.pcCompute(new Date(2026, 6, 24));
const lines = (computed.batches || []).flatMap((g) => g.lines || []);
const votsala = lines.filter((l) => /votsala/i.test(String(l.name || l.aptKey || '')));
const report = lines.filter((l) => /horizon test apt|lycabettus test apt/i.test(String(l.name || l.aptKey || '')));
assert.strictEqual(votsala.length, 1, 'Votsala still one Booking.com line');
assert.ok(Math.abs(votsala[0].exp - 150) < 0.011, 'Votsala sums both units');
assert.strictEqual(report.length, 2, 'report-group apartments stay two Booking.com lines');
assert.notStrictEqual(report[0].aptKey, report[1].aptKey, 'report-group lines have different apt keys');
assert.ok(!lines.some((l) => /michalakopoulou/i.test(String(l.name || l.aptKey || ''))), 'Michalakopoulou does not appear as a Payments Check property');

const vivaStart = srv.src.indexOf('const VIVA_BLOCK_NAMES');
const vivaFn = extractFn(srv.src, 'vivaExpectedUnits');
const vivaClassifyFn = extractFn(srv.src, 'vivaClassify');
const vivaMatchFn = extractFn(srv.src, 'vivaMatch');
const vivaEnd = srv.src.indexOf(vivaFn) + vivaFn.length;
assert(vivaStart >= 0 && vivaEnd > vivaStart, 'vivaExpectedUnits extractable');
const vivaBox = {};
vm.runInNewContext(
  srv.src.slice(vivaStart, vivaEnd) + '\n' + vivaClassifyFn + '\n' + vivaMatchFn + '\n' +
  'this.pcvPayGroup = pcvPayGroup;\nthis.pcvAptKey = pcvAptKey;\nthis.pcvAptLabel = pcvAptLabel;\nthis.vivaExpectedUnits = vivaExpectedUnits;\nthis.vivaClassify = vivaClassify;\nthis.vivaMatch = vivaMatch;\n',
  vivaBox
);

assert.strictEqual(vivaBox.pcvPayGroup('Votsala'), 'Votsala');
assert.strictEqual(vivaBox.pcvPayGroup('Michalakopoulou'), '');
assert.strictEqual(vivaBox.pcvAptKey({ aptId: 'h1', aptName: 'Horizon Test Apt' }, apts), 'horizon test apt');
assert.strictEqual(vivaBox.pcvAptLabel({ aptId: 'v1' }, apts), 'Votsala');
assert.strictEqual(vivaBox.pcvAptLabel({ aptId: 'h1', aptName: 'Horizon Test Apt' }, apts), 'Horizon Test Apt');

const today = new Date(2026, 6, 25);
const vUnits = vivaBox.vivaExpectedUnits({
  payChk: { marks: {}, cfg: { from: '2026-07-01', tol: 1 } },
  apts,
  bks: sandbox.S.bks,
}, today);
const vBdc = vUnits.filter((u) => u.chan === 'bdc');
assert.strictEqual(vBdc.filter((u) => /votsala/.test(u.key)).length, 1, 'server Votsala is one unit');
assert.ok(vBdc.some((u) => u.key === 'bdc|2026-07-16|horizon test apt'), 'server Horizon stays itself');
assert.ok(vBdc.some((u) => u.key === 'bdc|2026-07-16|lycabettus test apt'), 'server Lycabettus stays itself');
assert.ok(!vBdc.some((u) => /michalakopoulou/.test(u.key)), 'server does not key report groups');

assert.strictEqual(vivaBox.vivaClassify('NL15CITI2032301393'), 'bdc');
assert.strictEqual(vivaBox.vivaClassify('NL15 CITI 2032301393'), 'bdc', 'spaced Booking IBAN is still Booking.com');
assert.strictEqual(vivaBox.vivaClassify('IE93 BOFA 99006156923068'), 'abb', 'spaced Airbnb IBAN is still Airbnb');

const hzToday = new Date(2026, 7, 21);
const hzName = 'Elysian Lycabettus - Horizon';
const hzData = {
  payChk: {
    marks: { 'bdc|2026-08-20|michalakopoulou': { txId: 'tx-h', amt: 412.5, auto: true, exp: 412.5 } },
    cfg: { from: '2026-07-01', tol: 1 },
  },
  apts: [{ id: 'h1', name: hzName, clearGroup: 'Michalakopoulou' }],
  bks: [{ platform: 'Booking.com', aptId: 'h1', aptName: hzName, guestName: 'A', checkIn: '14/8/2026', checkOut: '15/8/2026', payout: 412.5 }],
};
const hzUnits = vivaBox.vivaExpectedUnits(hzData, hzToday);
assert.ok(hzUnits.some((u) => u.key === 'bdc|2026-08-20|elysian lycabettus horizon'), 'stale group mark does not hide Horizon');
const liveKeys = new Set(
  vivaBox.vivaExpectedUnits(Object.assign({}, hzData, { payChk: { marks: {}, cfg: hzData.payChk.cfg } }), hzToday).map((u) => u.key)
);
const usedTx = new Set(
  Object.entries(hzData.payChk.marks)
    .filter((e) => liveKeys.has(e[0]) && e[1] && e[1].txId)
    .map((e) => e[1].txId)
);
assert.ok(!usedTx.has('tx-h'), 'stale Michalakopoulou mark does not reserve the Viva tx');
const hzHit = vivaBox.vivaMatch(
  hzUnits,
  [{ id: 'tx-h', date: new Date(2026, 7, 20), amount: 412.5, counterpart: 'NL15 CITI 2032301393' }],
  1
);
assert.strictEqual(hzHit.matches.length, 1, 'Horizon auto-matches the existing Viva credit');
assert.ok(/horizon/.test(hzHit.matches[0].unit.key), 'match lands on Horizon not the old group key');

const twins = vivaBox.vivaMatch(
  [
    { key: 'bdc|2026-08-20|elysian lycabettus horizon', chan: 'bdc', date: new Date(2026, 7, 20), exp: 412.5 },
    { key: 'bdc|2026-08-20|other apt', chan: 'bdc', date: new Date(2026, 7, 20), exp: 412.5 },
  ],
  [
    { id: 'tx-a', date: new Date(2026, 7, 20), amount: 412.5, counterpart: 'NL15CITI2032301393' },
    { id: 'tx-b', date: new Date(2026, 7, 21), amount: 412.5, counterpart: 'NL15CITI2032301393' },
  ],
  1
);
assert.strictEqual(twins.matches.length, 2, 'two equal Booking credits match two equal expected units');

sandbox.S.payChk.marks['bdc|2026-07-16|michalakopoulou'] = { at: 'x', by: 'Viva auto-check', auto: true, exp: 100, amt: 100, txId: 'tx-old' };
const migrated = sandbox.pcCompute(new Date(2026, 6, 24));
const hzLine = (migrated.batches || []).flatMap((g) => g.lines || []).find((l) => /horizon test apt/i.test(String(l.name || l.aptKey || '')));
assert.ok(hzLine && hzLine.mark, 'client copies the stale Michalakopoulou mark onto Horizon when the amount is unique');

console.log('payments-check-votsala-group.test.js: ok');
