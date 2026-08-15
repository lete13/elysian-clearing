'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function applyChain() {
  let source = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  let sha = crypto.createHash('sha256').update(source).digest('hex');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : `patches-${n}.json`;
    const file = path.join(root, 'fe', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, `${name} continues the chain`);
    for (const [index, patch] of spec.patches.entries()) {
      const count = source.split(patch.find).length - 1;
      assert.strictEqual(count, patch.count || 1, `${name} patch ${index + 1}`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(spec.expectedSha256, sha, `${name} hash`);
  }
  return source;
}

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unclosed ' + name);
}

const html = applyChain();
assert(html.includes('ανά καθαρίστρια'), 'poster subtitle says by cleaner');
assert(html.includes('Day-off / leave stay in the compact strip'), 'layout note present');
assert(!/staffParts\.push\('Ιματ\./.test(html), 'Ιματισμός not in compact staff strip');
assert(!/staffParts\.push\('Οδηγ\./.test(html), 'drivers not in compact staff strip');
assert(/staffParts\.push\('Ρεπό '/.test(html), 'Ρεπό stays in strip');
assert(/staffParts\.push\('Άδ\. '/.test(html), 'Άδειες stays in strip');

const appended = [];
const context = {
  console, document: {
    createElement() {
      return {
        id: '', style: { cssText: '' },
        setAttribute() {},
        get innerHTML() { return this._html || ''; },
        set innerHTML(v) { this._html = v; },
      };
    },
    body: { appendChild(el) { appended.push(el); } },
  },
  window: {},
  S: {
    daily: {
      extra: {
        '2026-08-15': {
          oncall: { 0: 'Nikos' },
          repo: { 0: 'Maria', 1: 'Eleni' },
          adeies: { 0: 'Anna' },
          imatismos_cholargos: { 0: 'Linen A' },
          imatismos_thess: { 0: 'Linen B' },
          odigoi: { 0: 'Yannis' },
          odigoiRoutes: { 0: [{ key: 'a1', name: 'Art House' }] },
        },
      },
    },
  },
  _opsDate: '2026-08-15',
  _opsDayLabel: () => '15/8/2026',
  _opsEscHtml: (s) => String(s || ''),
  _opsCrewShareRows: () => ([
    { aptId: 'a1', aptName: 'Art House', cleanType: 'turnover', cleanTask: 'katharismos', cleanerNames: ['Maria'], cleanerName: 'Maria', comments: '' },
    { aptId: 'a2', aptName: 'Coloneum', cleanType: 'turnover', cleanTask: 'katharismos', cleanerNames: ['Eleni'], cleanerName: 'Eleni', comments: 'PRIORITY' },
  ]),
  _opsCleanerList: (r) => r.cleanerNames || [],
  _opsAptOf: (r) => r,
  _opsAptLines: (r) => ({ name: r.aptName, addr: '' }),
};
context.window = context;
context.window.aptAreaLabel = () => 'Athens';
context.window.aptProximityCompare = () => 0;

vm.createContext(context);
vm.runInContext(extractFn(html, '_opsBuildCrewPoster'), context);
const wrap = context._opsBuildCrewPoster();
const out = wrap.innerHTML;

assert(out.includes('Maria'), 'cleaner Maria section');
assert(out.includes('Eleni'), 'cleaner Eleni section');
assert(out.indexOf('Art House') < out.indexOf('Ρεπό'), 'cleaner apartments appear before day-off strip');
assert(out.includes('Ρεπό Maria, Eleni'), 'Ρεπό kept in compact strip');
assert(out.includes('Άδ. Anna'), 'Άδειες kept in compact strip');
assert(out.includes('ΙΜΑΤΙΣΜΟΣ'), 'linens block present');
assert(out.includes('ΟΔΗΓΟΙ / ΔΙΑΔΡΟΜΕΣ'), 'drivers block present');
assert(out.indexOf('Ρεπό') < out.indexOf('ΙΜΑΤΙΣΜΟΣ'), 'day-off strip before linens');
assert(out.indexOf('ΙΜΑΤΙΣΜΟΣ') < out.indexOf('ΟΔΗΓΟΙ'), 'linens before drivers');
assert(!/Ιματ\. Linen/.test(out), 'linens not duplicated in compact strip');
assert(!/Οδηγ\. Yannis/.test(out), 'drivers not duplicated in compact strip');
assert(out.includes('ανά καθαρίστρια'), 'by-cleaner label in header');

console.log('daily-ops-cleaner-poster: ok');
