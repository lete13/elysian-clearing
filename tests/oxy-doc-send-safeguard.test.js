'use strict';
/**
 * Private/B2B send and Monthly Close require an issued ΑΠΥ/ΤΠΥ (FE 128).
 * Cedar Apt July 2026: the owner email went out with no ΤΠΥ.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyFe(max) {
  let src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  let sha = sha256(src);
  const files = [];
  for (let n = 1; n <= max; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    const file = path.join(root, 'fe', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, 'fe/' + name + ' continues the chain');
    for (const [i, p] of (spec.patches || []).entries()) {
      const count = src.split(p.find).length - 1;
      assert.strictEqual(count, p.count || 1, 'fe/' + name + ' patch ' + (i + 1) + ' (' + p.note + ')');
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    assert.strictEqual(sha, spec.expectedSha256, 'fe/' + name + ' hash');
    files.push(name);
  }
  return { src, sha, files };
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
  throw new Error('unclosed ' + name);
}

const fe127 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-127.json'), 'utf8'));
const fe128 = JSON.parse(fs.readFileSync(path.join(root, 'fe', 'patches-128.json'), 'utf8'));
assert.strictEqual(fe128.baseSha256, fe127.expectedSha256, 'FE 128 continues FE 127');
assert(fe128.patches.some((p) => (p.replace || '').includes('_oxyNeed && !(_oxyDoc && _oxyDoc.invoiceId)')), 'FE 128 aborts send without a document');
assert(fe128.patches.some((p) => (p.replace || '').includes("alert('Cannot send: no '")), 'FE 128 alerts when the document is missing');

const fe = applyFe(140);
assert(fe.files.includes('patches-128.json'), 'FE 128 is in the chain');

const html = fe.src;
assert(html.includes('const _oxyNeed = _pk0.some'), 'send computes _oxyNeed from packets');
assert(html.includes('if (_oxyNeed) {'), 'Oxygen path keyed off _oxyNeed');
assert(html.includes('_oxyNeed && !(_oxyDoc && _oxyDoc.invoiceId)'), 'hard gate after Oxygen try/catch');
assert(html.includes("alert('Cannot send: no ' + _oxyLabel"), 'blocking alert on missing document');
assert(html.includes('The email was NOT sent.'), 'alert says the email was not sent');
assert(!html.includes("if (_apt.profile && _apt.profile !== 'leased') {"), 'old primary-apt skip is gone');
assert(html.includes('function mcNeedsOxyDoc(a)'), 'mcNeedsOxyDoc exists');
assert(html.includes('function mcEmailedNoOxy(a)'), 'mcEmailedNoOxy exists');
assert(html.includes('class="mc-oxy-alert"'), 'focus banner class');
assert(html.includes('class="mc-oxy-badge"'), 'list badge class');
assert(html.includes("if (batchStage === 'email')"), 'batch cannot tick Email');
assert(!html.includes('      return !!(em && r && r.remit && (em.at || 0) >= (r.remit.at_ms || 0));'), 'email isDone no longer completes on the email stamp alone');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.trim());
scripts.forEach((source, i) => new vm.Script(source, { filename: 'effective-script-' + (i + 1) + '.js' }));

const sandbox = {
  S: {
    apts: [
      { id: 'cedar1', profile: 'b2b', name: 'The Athenian Cedar', clearGroup: 'Cedar Apt' },
      { id: 'cedar2', profile: 'b2b', name: 'Urban Cedar Apartment', clearGroup: 'Cedar Apt' },
      { id: 'vots', profile: 'leased', name: 'Votsala 1' },
      { id: 'nest', profile: 'private', name: 'The Nest' }
    ],
    rptLocks: {},
    monthlyClose: { '2026-07': {} },
    monthlyTasks: {}
  },
  mcMonth: '2026-07',
  PROOF_STAGE: { takk_issue: 1, takk_pay: 1, remit_pay: 1 },
  takkDone: function () { return false; }
};

const helperSrc = [
  extractFn(html, 'lockFor'),
  extractFn(html, 'mcStore'),
  extractFn(html, 'mcRec'),
  extractFn(html, 'mcNeedsOxyDoc'),
  extractFn(html, 'mcOxyIssued'),
  extractFn(html, 'mcEmailedNoOxy'),
  extractFn(html, 'isDone')
].join('\n');

vm.runInNewContext(
  helperSrc +
    '\nthis.lockFor=lockFor; this.mcRec=mcRec; this.mcNeedsOxyDoc=mcNeedsOxyDoc;' +
    ' this.mcOxyIssued=mcOxyIssued; this.mcEmailedNoOxy=mcEmailedNoOxy; this.isDone=isDone;',
  sandbox
);

const cedar = { id: 'cedar1', type: 'b2b', members: ['cedar1', 'cedar2'], name: 'Cedar Apt (2 apartments)' };
const vots = { id: 'vots', type: 'leased', members: ['vots'], name: 'Votsala 1' };
const nest = { id: 'nest', type: 'private', members: ['nest'], name: 'The Nest' };
const mixed = { id: 'vots', type: 'leased', members: ['vots', 'cedar1'], name: 'mixed' };

assert.strictEqual(sandbox.mcNeedsOxyDoc(cedar), true, 'B2B group needs a ΤΠΥ');
assert.strictEqual(sandbox.mcNeedsOxyDoc(nest), true, 'private needs an ΑΠΥ');
assert.strictEqual(sandbox.mcNeedsOxyDoc(vots), false, 'leased does not need a fiscal document');
assert.strictEqual(sandbox.mcNeedsOxyDoc(mixed), true, 'leased-typed group still needs a doc if a B2B member is in it');

const julyLock = '::2026-06-30T21:00:00.000Z::2026-07-30T21:00:00.000Z';
const remit = { at_ms: Date.parse('2026-08-09T10:00:00.000Z'), payout: 2634.17 };
const emailed = { at: Date.parse('2026-08-10T05:52:35.704Z'), to: 'owner@example.com' };

sandbox.S.monthlyClose['2026-07'].cedar1 = { done: {}, remit, emailed };
sandbox.S.rptLocks['cedar1+cedar2' + julyLock] = { email: emailed, payout: 2634.17 };

assert.strictEqual(sandbox.mcOxyIssued(cedar), false, 'Cedar lock has no oxygen stamp');
assert.strictEqual(sandbox.mcEmailedNoOxy(cedar), true, 'Cedar emailed this close with no ΤΠΥ');
assert.strictEqual(sandbox.isDone(cedar, 'email'), false, 'Cedar Email stage stays open without ΤΠΥ');

sandbox.S.rptLocks['cedar1+cedar2' + julyLock].oxygen = { invoiceId: 'inv-1', number: 'ΤΠΥ 1' };
assert.strictEqual(sandbox.mcOxyIssued(cedar), true, 'oxygen stamp on the grouped lock is found');
assert.strictEqual(sandbox.mcEmailedNoOxy(cedar), false, 'no alert once the ΤΠΥ exists');
assert.strictEqual(sandbox.isDone(cedar, 'email'), true, 'Email completes when emailed + ΤΠΥ');

sandbox.S.monthlyClose['2026-07'].vots = { done: {}, remit, emailed };
sandbox.S.rptLocks['vots' + julyLock] = { email: emailed };
assert.strictEqual(sandbox.mcEmailedNoOxy(vots), false, 'leased emailed without Oxygen is fine');
assert.strictEqual(sandbox.isDone(vots, 'email'), true, 'leased Email completes on the email stamp');

sandbox.S.monthlyClose['2026-07'].nest = { done: { email: { by: 'Popi', at: emailed.at } }, remit };
sandbox.S.rptLocks['nest' + julyLock] = {};
assert.strictEqual(sandbox.isDone(nest, 'email'), false, 'manual Email tick is not enough for private without ΑΠΥ');

sandbox.S.rptLocks['nest' + julyLock] = { oxygen: { invoiceId: 'apy-1' }, email: emailed };
sandbox.S.monthlyClose['2026-07'].nest.emailed = emailed;
assert.strictEqual(sandbox.isDone(nest, 'email'), true, 'private Email completes with ΑΠΥ + email');

const stale = { at: Date.parse('2026-08-01T10:00:00.000Z') };
sandbox.S.monthlyClose['2026-07'].cedar1 = { done: {}, remit, emailed: stale };
sandbox.S.rptLocks['cedar1+cedar2' + julyLock].email = stale;
assert.strictEqual(sandbox.isDone(cedar, 'email'), false, 'stale email stamp older than remit does not count');

console.log('oxy-doc-send-safeguard OK: FE 128 ' + fe.sha.slice(0, 12) + '…');
