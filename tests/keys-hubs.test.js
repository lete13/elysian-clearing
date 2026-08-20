'use strict';
/**
 * Keys Hubs — assignment, lockbox, proximity, persist, anti-wipe (no live DB).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function applyChain(kind, baseFile) {
  let source = fs.readFileSync(path.join(root, baseFile), 'utf8');
  let sha = crypto.createHash('sha256').update(source).digest('hex');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : `patches-${n}.json`;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, `${kind}/${name} continues the chain`);
    for (const [index, patch] of spec.patches.entries()) {
      const count = source.split(patch.find).length - 1;
      assert.strictEqual(count, patch.count || 1, `${kind}/${name} patch ${index + 1} (${patch.note})`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(sha, spec.expectedSha256, `${kind}/${name} effective hash`);
  }
  return source;
}

const html = applyChain('fe', 'index.html');
const srv = applyChain('srv', 'server.js');

assert(html.includes('function renderKeyHubs()'), 'renderer shipped');
assert(html.includes('id="nav-keys">Keys Hubs</button>'), 'nav tab shipped');
assert(html.includes('keyHubs: S.keyHubs || {}'), 'persisted on save');
assert(!html.includes('window._distKmGlobal'), 'no Daily Ops reach-in');
assert(srv.includes('ANTI-WIPE KEYS HUBS'), 'server anti-wipe shipped');

const start = html.indexOf('// ── Keys Hubs');
const end = html.indexOf('function opsManageCleaners() {');
assert(start >= 0 && end > start, 'Keys Hubs block sits above opsManageCleaners');
const src = html.slice(start, end);

let saved = 0;
const panel = { innerHTML: '', classList: { contains: () => true } };
const searchEl = { value: '', focus() {}, setSelectionRange() {} };
const sandbox = {
  S: { apts: [], keyHubs: {}, keyLabels: {}, keyLockbox: {} },
  save() { saved++; },
  document: {
    getElementById(id) {
      if (id === 'tab-keys') return panel;
      if (id === 'kh-search') return searchEl;
      return null;
    },
  },
  Math,
  parseFloat,
  isFinite,
  console,
};
vm.runInNewContext(src + `
this.KEY_HUBS = KEY_HUBS;
this._keyHubsOf = _keyHubsOf;
this._keyLockbox = _keyLockbox;
this._keyHubDist = _keyHubDist;
this._keyHubDists = _keyHubDists;
this._keyHubMatch = _keyHubMatch;
this._keyHubName = _keyHubName;
this.opsToggleKeyHub = opsToggleKeyHub;
this.opsToggleLockbox = opsToggleLockbox;
this.opsSetKeyLabel = opsSetKeyLabel;
this._keyHubSetSearch = _keyHubSetSearch;
this.renderKeyHubs = renderKeyHubs;
`, sandbox);

const { KEY_HUBS, _keyHubsOf, _keyLockbox, _keyHubDist, _keyHubDists,
  _keyHubMatch, opsToggleKeyHub, opsToggleLockbox, opsSetKeyLabel, renderKeyHubs } = sandbox;

function fromVm(v) { return JSON.parse(JSON.stringify(v)); }
assert.strictEqual(KEY_HUBS.length, 5, 'five physical hubs');
assert.deepStrictEqual(fromVm(KEY_HUBS.map((h) => h.id)), ['votsala', 'verandas', 'cholargos', 'plynthrio', 'driver']);

// Old single-string assignments still read as a one-hub list
sandbox.S.keyHubs = { a1: 'votsala' };
assert.deepStrictEqual(fromVm(_keyHubsOf('a1')), ['votsala'], 'migrates the old string format');

sandbox.S.keyHubs = {};
opsToggleKeyHub('a1', 'votsala');
opsToggleKeyHub('a1', 'driver');
assert.deepStrictEqual(fromVm(_keyHubsOf('a1')).sort(), ['driver', 'votsala'], 'an apartment can sit in several hubs');
assert.strictEqual(saved, 2, 'toggles go through save(), not a raw DB write');
opsToggleKeyHub('a1', 'votsala');
assert.deepStrictEqual(fromVm(_keyHubsOf('a1')), ['driver'], 'second click removes that hub');
opsToggleKeyHub('a1', 'driver');
assert.deepStrictEqual(fromVm(_keyHubsOf('a1')), [], 'last hub clears the map entry');
assert.strictEqual(sandbox.S.keyHubs.a1, undefined, 'empty assignment is deleted, not stored as []');

opsToggleLockbox('a1');
assert.strictEqual(_keyLockbox('a1'), true, 'lockbox on');
opsToggleLockbox('a1');
assert.strictEqual(_keyLockbox('a1'), false, 'lockbox off');

opsSetKeyLabel('a1', '  blue tag  ');
assert.strictEqual(sandbox.S.keyLabels.a1, 'blue tag', 'key tag is trimmed');
opsSetKeyLabel('a1', '   ');
assert.strictEqual(sandbox.S.keyLabels.a1, undefined, 'blank tag is deleted');

const votsala = KEY_HUBS.find((h) => h.id === 'votsala');
const plynthrio = KEY_HUBS.find((h) => h.id === 'plynthrio');
const birdhouse = { id: 'bh', name: 'Birdhouse', lat: 37.9755, lng: 23.7348, city: 'Athens' }; // near Makri / Verandas
const ariti = { id: 'ar', name: 'ARITI 7', lat: 39.96, lng: 23.66, city: 'Halkidiki' };
const skarlatos = { id: 'sk', name: 'The Skarlatos residence', lat: 40.632, lng: 22.944, city: 'Thessaloniki' };

const bhDists = _keyHubDists(birdhouse);
assert.strictEqual(bhDists[0].h.id, 'verandas', 'central Athens ranks Verandas first');
assert.ok(bhDists[0].d < 3, 'Birdhouse is within a few km of Verandas');
assert.ok(_keyHubDist(birdhouse, plynthrio) > 250, 'Thessaloniki hub is far from Athens');

const skDists = _keyHubDists(skarlatos);
assert.strictEqual(skDists[0].h.id, 'plynthrio', 'Thessaloniki apartment ranks the Mitoudi hub first');
assert.ok(skDists[0].d < 10, 'Skarlatos is in the city');

assert.strictEqual(_keyHubDist({ lat: '', lng: '' }, votsala), null, 'missing coords do not invent a distance');

sandbox.S.apts = [birdhouse, ariti, skarlatos];
sandbox.S.keyHubs = { bh: ['verandas', 'driver'], sk: ['plynthrio'] };
sandbox.S.keyLockbox = { ar: true };
sandbox.S.keyLabels = { bh: 'gold 12' };
renderKeyHubs();
assert(panel.innerHTML.includes('Keys Hubs'), 'title renders');
assert(panel.innerHTML.includes('Birdhouse'), 'apartment row renders');
assert(panel.innerHTML.includes('gold 12'), 'key tag renders');
assert(panel.innerHTML.includes('kh-chip on kh-chip-verandas'), 'assigned hub chip is on');
assert(panel.innerHTML.includes('🔒 On-site lockbox'), 'lockbox is the nearest key when set');
assert(panel.innerHTML.includes('no key nearby') || panel.innerHTML.includes('Thessaloniki'), 'Thessaloniki row shows its hub');
assert(panel.innerHTML.includes('id="kh-search"'), 'search input is addressable after re-render');
assert.strictEqual((panel.innerHTML.match(/class="kh-nokey"/g) || []).length, 0, 'lockbox and assigned apts are not "no key"');

assert.strictEqual(_keyHubMatch(birdhouse, 'gold'), true, 'search matches the key tag');
assert.strictEqual(_keyHubMatch(birdhouse, 'verandas'), true, 'search matches assigned hub name');
assert.strictEqual(_keyHubMatch(ariti, 'lockbox'), true, 'search matches lockbox');
assert.strictEqual(_keyHubMatch(ariti, 'bird'), false, 'unrelated search misses');

// A stale POST that omits the new keys must not blank the DB (mirrors server anti-wipe).
function antiWipe(existing, payload) {
  const size = (m) => (m && typeof m === 'object' ? Object.keys(m).length : 0);
  if (size(existing.keyHubs) > 0 && size(payload.keyHubs) === 0) payload.keyHubs = existing.keyHubs;
  if (size(existing.keyLabels) > 0 && size(payload.keyLabels) === 0) payload.keyLabels = existing.keyLabels;
  if (size(existing.keyLockbox) > 0 && size(payload.keyLockbox) === 0) payload.keyLockbox = existing.keyLockbox;
  return payload;
}
const kept = antiWipe(
  { keyHubs: { bh: ['verandas'] }, keyLabels: { bh: 'gold' }, keyLockbox: { ar: true } },
  { apts: [], keyHubs: {}, keyLabels: {}, keyLockbox: {} }
);
assert.deepStrictEqual(kept.keyHubs.bh, ['verandas'], 'stale empty keyHubs restored');
assert.strictEqual(kept.keyLabels.bh, 'gold', 'stale empty keyLabels restored');
assert.strictEqual(kept.keyLockbox.ar, true, 'stale empty keyLockbox restored');

const intentional = antiWipe(
  { keyHubs: { bh: ['verandas'] } },
  { keyHubs: { bh: ['driver'] } }
);
assert.deepStrictEqual(intentional.keyHubs.bh, ['driver'], 'a real edit still wins');

const persistOcc = html.split('keyHubs: S.keyHubs || {}').length - 1;
assert(persistOcc >= 3, `keyHubs in save(), saveToDb and localStorage rewrite (found ${persistOcc})`);

console.log('keys-hubs OK: 5 hubs, multi-assign, lockbox, proximity, persist, anti-wipe');
