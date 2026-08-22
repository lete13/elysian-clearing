'use strict';
/**
 * SRV 97: Payments Check matches Horizon-style Viva credits that were skipped
 * after report-only clearGroups stopped sharing a mark key, and IBANs with spaces.
 * Run: node scripts/_build-horizon-viva-match-patch.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

function applySrv(stopAt) {
  let src = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (stopAt && name === stopAt) break;
    const p = path.join(root, 'srv', name);
    if (!fs.existsSync(p)) break;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const patch of cfg.patches || []) {
      const count = src.split(patch.find).length - 1;
      if (count !== (patch.count || 1)) throw new Error('miss ' + name + ' :: ' + patch.note + ' x' + count);
      src = src.split(patch.find).join(patch.replace);
    }
  }
  return src;
}

const src = applySrv('patches-97.json');
const base = sha(src);

const patches = [
  {
    note: 'Classify Viva IBANs after stripping spaces',
    find:
      "function vivaClassify(counterpart) {\n" +
      "  const c = String(counterpart || '').toLowerCase().trim();\n" +
      "  if (/airbnb/.test(c)) return 'abb';\n" +
      "  if (/booking/.test(c)) return 'bdc';\n" +
      "  // Viva's v2 Search stores the counterparty IBAN, not the name (verified on\n" +
      "  // live data 29 Jul 2026). The channels' payout accounts:\n" +
      "  //   Airbnb Payments  — Bank of America Dublin   → IE..BOFA...\n" +
      "  //   Booking.com B.V. — Citibank Netherlands     → NL..CITI...\n" +
      "  if (/^ie\\d{2}bofa/.test(c)) return 'abb';\n" +
      "  if (/^nl\\d{2}citi/.test(c)) return 'bdc';\n" +
      "  return null;   // unknown counterparties (card settlements, transfers…) are NEVER matched\n" +
      "}\n",
    replace:
      "function vivaClassify(counterpart) {\n" +
      "  const c = String(counterpart || '').toLowerCase().trim();\n" +
      "  const compact = c.replace(/[\\s-]/g, '');\n" +
      "  if (/airbnb/.test(c)) return 'abb';\n" +
      "  if (/booking/.test(c)) return 'bdc';\n" +
      "  // Viva's v2 Search stores the counterparty IBAN, not the name (verified on\n" +
      "  // live data 29 Jul 2026). The channels' payout accounts:\n" +
      "  //   Airbnb Payments  — Bank of America Dublin   → IE..BOFA...\n" +
      "  //   Booking.com B.V. — Citibank Netherlands     → NL..CITI...\n" +
      "  // Compact form: Viva sometimes inserts spaces in the IBAN.\n" +
      "  if (/^ie\\d{2}bofa/.test(compact)) return 'abb';\n" +
      "  if (/^nl\\d{2}citi/.test(compact)) return 'bdc';\n" +
      "  return null;   // unknown counterparties (card settlements, transfers…) are NEVER matched\n" +
      "}\n",
    count: 1
  },
  {
    note: 'Join counterpart + description so IBAN does not hide Booking/Airbnb',
    find:
      "function vivaNormalizeCredits(raw) {\n" +
      "  return (raw || []).map(t => ({\n" +
      "    id: String(t.accountTransactionId || t.AccountTransactionId || t.TransactionId || t.transactionId || t.Id || t.id || ''),\n" +
      "    date: new Date(t.created || t.Created || t.InsDate || t.insDate || t.dateCreated || t.Date || t.date || 0),\n" +
      "    amount: Math.round(((t.amount != null ? +t.amount : +t.Amount) || 0) * 100) / 100,\n" +
      "    counterpart: String(t.counterPart || t.CounterPart || t.counterpart || t.userDescription || t.Description || t.description || ''),\n",
    replace:
      "function vivaNormalizeCredits(raw) {\n" +
      "  return (raw || []).map(t => ({\n" +
      "    id: String(t.accountTransactionId || t.AccountTransactionId || t.TransactionId || t.transactionId || t.Id || t.id || ''),\n" +
      "    date: new Date(t.created || t.Created || t.InsDate || t.insDate || t.dateCreated || t.Date || t.date || 0),\n" +
      "    amount: Math.round(((t.amount != null ? +t.amount : +t.Amount) || 0) * 100) / 100,\n" +
      "    counterpart: [t.counterPart, t.CounterPart, t.counterpart, t.userDescription, t.Description, t.description].filter(Boolean).map(function (x) { return String(x); }).join(' '),\n",
    count: 1
  },
  {
    note: 'Do not pin Viva txs on stale report-group mark keys',
    find:
      "  const creditsAll = vivaNormalizeCredits(raw);\n" +
      "  // never reuse a bank transaction that already ticked something\n" +
      "  const usedTx = new Set(Object.values((data.payChk && data.payChk.marks) || {}).map(m => m && m.txId).filter(Boolean));\n" +
      "  const credits = creditsAll.filter(c => !usedTx.has(c.id));\n",
    replace:
      "  const creditsAll = vivaNormalizeCredits(raw);\n" +
      "  // never reuse a bank transaction that already ticked a still-live payout key.\n" +
      "  // Stale clearGroup keys (Michalakopoulou etc. before Votsala-only grouping)\n" +
      "  // must not pin the credit — those apartments are paid one by one.\n" +
      "  const liveKeys = new Set(vivaExpectedUnits(Object.assign({}, data, { payChk: { marks: {}, cfg: ((data.payChk && data.payChk.cfg) || {}) } }), today).map(u => u.key));\n" +
      "  const usedTx = new Set(Object.entries((data.payChk && data.payChk.marks) || {}).filter(function (e) { return liveKeys.has(e[0]) && e[1] && e[1].txId; }).map(function (e) { return e[1].txId; }));\n" +
      "  const credits = creditsAll.filter(c => !usedTx.has(c.id));\n",
    count: 1
  },
  {
    note: 'viva-selftest: spaced IBAN + stale Michalakopoulou mark',
    find:
      "  ok('classify Booking.com payout IBAN (Citi NL)', vivaClassify('NL15CITI2032301393') === 'bdc');\n" +
      "  ok('other IBANs stay unclassified', vivaClassify('GR1601101250000000012300695') === null);\n",
    replace:
      "  ok('classify Booking.com payout IBAN (Citi NL)', vivaClassify('NL15CITI2032301393') === 'bdc');\n" +
      "  ok('classify Booking.com IBAN with spaces', vivaClassify('NL15 CITI 2032301393') === 'bdc');\n" +
      "  ok('classify Airbnb IBAN with spaces', vivaClassify('IE93 BOFA 99006156923068') === 'abb');\n" +
      "  ok('other IBANs stay unclassified', vivaClassify('GR1601101250000000012300695') === null);\n" +
      "\n" +
      "  const horizonData = {\n" +
      "    payChk: { marks: { 'bdc|2026-08-20|michalakopoulou': { txId: 'tx-h', amt: 412.5, auto: true, exp: 412.5 } }, cfg: { from: '2026-07-01', tol: 1 } },\n" +
      "    apts: [{ id: 'h1', name: 'Elysian Lycabettus - Horizon', clearGroup: 'Michalakopoulou' }],\n" +
      "    bks: [{ platform: 'Booking.com', aptId: 'h1', aptName: 'Elysian Lycabettus - Horizon', guestName: 'A', checkIn: '14/8/2026', checkOut: '15/8/2026', payout: 412.5 }],\n" +
      "  };\n" +
      "  const hzToday = D(2026, 8, 21);\n" +
      "  const hzUnits = vivaExpectedUnits(horizonData, hzToday);\n" +
      "  ok('stale Michalakopoulou mark does not hide Horizon unit', hzUnits.some(u => u.key === 'bdc|2026-08-20|elysian lycabettus horizon'));\n" +
      "  const liveKeysHz = new Set(vivaExpectedUnits(Object.assign({}, horizonData, { payChk: { marks: {}, cfg: horizonData.payChk.cfg } }), hzToday).map(u => u.key));\n" +
      "  const usedTxHz = new Set(Object.entries(horizonData.payChk.marks).filter(function (e) { return liveKeysHz.has(e[0]) && e[1] && e[1].txId; }).map(function (e) { return e[1].txId; }));\n" +
      "  ok('stale group mark does not reserve the Viva tx', !usedTxHz.has('tx-h'));\n" +
      "  const hzMatch = vivaMatch(hzUnits, [{ id: 'tx-h', date: D(2026, 8, 20), amount: 412.5, counterpart: 'NL15 CITI 2032301393' }], 1);\n" +
      "  ok('Horizon matches spaced Booking IBAN after stale mark ignored', hzMatch.matches.length === 1 && hzMatch.matches[0].unit.key.indexOf('horizon') >= 0);\n"
  },
  {
    note: 'Match N identical-amount credits to N units instead of skipping all',
    find:
      "    if (exact.length === 1) { pick = exact[0]; kind = 'exact'; }\n" +
      "    else if (exact.length === 0 && close.length === 1) { pick = close[0]; kind = 'tolerance'; }\n",
    replace:
      "    if (exact.length === 1) { pick = exact[0]; kind = 'exact'; }\n" +
      "    else if (exact.length === 0 && close.length === 1) { pick = close[0]; kind = 'tolerance'; }\n" +
      "    else if (exact.length > 1) {\n" +
      "      var sameN = 1;\n" +
      "      for (var si = sorted.indexOf(cr) + 1; si < sorted.length; si++) {\n" +
      "        var c2 = sorted[si];\n" +
      "        if (vivaClassify(c2.counterpart) !== chan) continue;\n" +
      "        if (Math.abs(c2.amount - cr.amount) > 0.011) continue;\n" +
      "        var cd2 = pcvDay0(c2.date);\n" +
      "        if (!exact.some(function (u) { return cd2 >= pcvAdd(u.date, -1) && cd2 <= pcvAdd(u.date, 10); })) continue;\n" +
      "        sameN++;\n" +
      "      }\n" +
      "      if (sameN === exact.length) { pick = exact[0]; kind = 'exact-set'; }\n" +
      "    }\n",
    count: 1
  },
  {
    note: 'viva-selftest: twin credits of the same amount both match',
    find:
      "  ok('twin credits: still skipped while ambiguous (2 candidates each)', amb2.matches.length === 0);\n",
    replace:
      "  ok('twin credits with twin units both auto-match', amb2.matches.length === 2);\n",
    count: 1
  },
  {
    note: 'Store leftoverProbe so Horizon misses are diagnosable from lastResult',
    find:
      "    unmatchedCredits: unmatchedCredits.slice(0, 25).map(x => ({ date: pcvISO(pcvDay0(x.credit.date)), counterpart: x.credit.counterpart.slice(0, 60), amount: x.credit.amount, candidates: x.candidates })),\n" +
      "    missingExpected,\n" +
      "  };\n",
    replace:
      "    unmatchedCredits: unmatchedCredits.slice(0, 25).map(x => ({ date: pcvISO(pcvDay0(x.credit.date)), counterpart: x.credit.counterpart.slice(0, 60), amount: x.credit.amount, candidates: x.candidates })),\n" +
      "    missingExpected,\n" +
      "    leftoverProbe: leftover.filter(function (u) { return /horizon|lycabettus|michalakopoulou/i.test(String(u.key || '') + ' ' + String(u.label || '')); }).slice(0, 12).map(function (u) {\n" +
      "      var near = classified.filter(function (c) { return Math.abs(c.amount - u.exp) <= Math.max(tol, 5); }).slice(0, 8).map(function (c) {\n" +
      "        return { amount: c.amount, date: pcvISO(pcvDay0(c.date)), chan: vivaClassify(c.counterpart), used: usedTx.has(c.id) };\n" +
      "      });\n" +
      "      return { key: u.key, exp: u.exp, date: pcvISO(u.date), near: near };\n" +
      "    }),\n" +
      "  };\n",
    count: 1
  }
];

let out = src;
for (const p of patches) {
  const n = out.split(p.find).length - 1;
  if (n !== (p.count || 1)) throw new Error('builder miss ' + p.note + ' x' + n);
  out = out.split(p.find).join(p.replace);
}

const cfg = {
  baseSha256: base,
  expectedSha256: sha(out),
  builtAt: '2026-08-21 Viva: spaced IBANs + stale marks + equal-amount sets',
  patches: patches,
  assertions: [
    { has: 'const compact = c.replace(/[\\s-]/g, \'\');', note: 'IBAN compact form' },
    { has: 'liveKeys.has(e[0])', note: 'usedTx only live keys' },
    { has: "kind = 'exact-set'", note: 'N-to-N equal amount matching' },
    { has: 'leftoverProbe', note: 'Horizon leftover probe on lastResult' },
    { has: 'classify Booking.com IBAN with spaces', note: 'selftest spaced IBAN' },
    { has: 'stale group mark does not reserve the Viva tx', note: 'selftest stale Michalakopoulou' },
    { has: 'twin credits with twin units both auto-match', note: 'selftest equal-amount set' },
    { hasNot: 'const usedTx = new Set(Object.values((data.payChk && data.payChk.marks) || {}).map(m => m && m.txId).filter(Boolean));', note: 'unfiltered usedTx removed' },
    { hasNot: 'twin credits: still skipped while ambiguous', note: 'old twin-skip selftest removed' }
  ]
};

fs.writeFileSync(path.join(root, 'srv', 'patches-97.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote srv/patches-97.json', cfg.expectedSha256);
