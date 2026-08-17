'use strict';
/**
 * Platform Invoices vault folders: apartment → platform → year → month.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
let sha = crypto.createHash('sha256').update(html).digest('hex');
for (let n = 1; n <= 200; n++) {
  const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
  const file = path.join(root, 'fe', name);
  if (!fs.existsSync(file)) break;
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(spec.baseSha256, sha, name + ' continues the chain');
  for (const [i, p] of spec.patches.entries()) {
    const count = html.split(p.find).length - 1;
    assert.strictEqual(count, p.count || 1, name + ' #' + (i + 1) + ' ' + p.note);
    html = html.split(p.find).join(p.replace);
  }
  sha = crypto.createHash('sha256').update(html).digest('hex');
  assert.strictEqual(sha, spec.expectedSha256, name + ' hash');
}

assert(html.includes('id="pi-view-vault"'), 'vault is the main view');
assert(html.includes('id="pi-view-retrieve"'), 'Retrieve is a submenu');
assert(html.includes("piSetMenu('retrieve')"), 'Retrieve menu switch');
assert(html.includes('apartment → platform → year → month'), 'folder copy');
assert(html.includes('function renderVaultTree'), 'folder tree renderer');
assert(html.includes('function piVaultBookingHotelId'), 'vault looks up Booking.com hotel id');
assert(html.includes('function piVaultAptLabel'), 'apartment folder label includes hotel id');
assert(html.includes('function piStoreYm'), 'year/month helper');
assert(html.includes('PDFs by apartment — click Open to view'), 'collect vault heading kept');
assert(html.includes('Guided monthly run'), 'retrieve still has guided run copy');
assert(html.includes('Pull Airbnb (Hosthub codes)'), 'full pull kept');
assert(html.includes('piPullBooking()'), 'Booking.com pull');
assert(html.includes("piPull({ codes: ['HM9DCDMEXT','HMWRNAWHBA'] })"), 'test pull kept');
assert(html.includes('Vault vs Expect'), 'Expect vs vault copy');
assert(html.includes('incomplete stays first'), 'month pull opens incomplete stays first');
assert(!html.includes('piPullIncomplete'), 'no separate Pull incomplete helper');
assert(!html.includes('id="pi-pull-incomplete-btn"'), 'no Pull incomplete button');

const start = html.indexOf('function piStoreApt(it)');
const end = html.indexOf('window.piGo = function', start);
assert(start >= 0 && end > start, 'vault helpers present');
const src = html.slice(start, end);

const tree = { innerHTML: '' };
const meta = { textContent: '' };
const document = {
  getElementById: function (id) {
    if (id === 'pi-vault-tree') return tree;
    if (id === 'pi-vault-meta') return meta;
    return { style: {}, className: '', textContent: '', innerHTML: '' };
  },
};
const ctx = {
  document,
  window: {},
  PI: { vaultItems: [], vaultQ: '', vaultHideEmpty: true },
  S: {
    apts: [
      { name: 'Birdhouse Apartment', bookingHotelId: '11820968' },
      { name: 'Coloneum', bookingHotelId: '12240693' },
      { name: 'Votsala 1 Luxury Stay with Patio', clearGroup: 'Votsala', bookingHotelId: '13180441' },
      { name: 'Votsala 2 Luxury Stay with Patio', clearGroup: 'Votsala', bookingHotelId: '13180441' },
      { name: 'Sunset Nest in Fiskardo', bookingHotelId: '' },
    ],
  },
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
};
vm.runInNewContext(src, ctx);
assert.strictEqual(typeof ctx.renderVaultTree, 'function', 'renderVaultTree exported to sandbox');
ctx.renderVaultTree();

ctx.PI.vaultItems = [
  {
    id: '1',
    month: '2026-07',
    channel: 'airbnb',
    partner: 'Birdhouse Apartment',
    filename: 'Airbnb/2026-07/Birdhouse Apartment/invoice-HM9DCDMEXT.pdf',
    invoiceNumber: 'AIUC-1',
    issueDate: '13/7/2026',
    total: 19.53,
  },
  {
    id: '2',
    month: '2026-08',
    channel: 'booking',
    partner: 'Coloneum',
    filename: 'Booking.com/2026-08/Coloneum/invoice-bdc.pdf',
    issueDate: '01/8/2026',
  },
  {
    id: '3',
    month: '2026-07',
    channel: 'booking',
    partner: 'Votsala',
    filename: 'Booking.com/2026-07/Votsala/invoice-13180441.pdf',
    issueDate: '01/7/2026',
  },
  {
    id: '4',
    month: '2026-07',
    channel: 'airbnb',
    partner: 'Votsala 1 Luxury Stay with Patio',
    filename: 'Airbnb/2026-07/Votsala 1 Luxury Stay with Patio/invoice-HMVOT1.pdf',
    invoiceNumber: 'AIUC-V1',
    issueDate: '10/7/2026',
  },
];
ctx.renderVaultTree();

assert(tree.innerHTML.indexOf('Birdhouse Apartment · 11820968') >= 0, 'Birdhouse folder shows Booking.com id');
assert(tree.innerHTML.indexOf('Coloneum · 12240693') >= 0, 'Coloneum folder shows Booking.com id');
assert(tree.innerHTML.indexOf('Votsala · 13180441') >= 0, 'shared Votsala Booking folder shows hotel id');
assert(tree.innerHTML.indexOf('Votsala 1 Luxury Stay with Patio · 13180441') >= 0, 'Votsala unit folder shows shared hotel id');
assert(tree.innerHTML.indexOf('Booking.com · 11820968') >= 0, 'Birdhouse Booking.com line shows hotel id');
assert(tree.innerHTML.indexOf('Booking.com · 12240693') >= 0, 'Coloneum Booking.com line shows hotel id');
assert(tree.innerHTML.indexOf('Booking.com · 13180441') >= 0, 'Votsala Booking.com line shows hotel id');
assert(tree.innerHTML.indexOf('Airbnb · ') < 0, 'Airbnb platform line stays Airbnb');
assert(tree.innerHTML.indexOf('class="pi-fold pi-apt"') >= 0, 'apt folder class');
assert(tree.innerHTML.indexOf('<details open class="pi-fold pi-apt">') < 0, 'apartment folders start closed');
assert(tree.innerHTML.indexOf('<details class="pi-fold pi-apt" open') < 0, 'apartment folders start closed (attr order)');
assert(tree.innerHTML.indexOf('Coloneum') >= 0, 'second apartment folder');
assert(tree.innerHTML.indexOf('Airbnb') >= 0, 'platform subfolder');
assert(tree.innerHTML.indexOf('Booking.com') >= 0, 'Booking.com subfolder');
assert(tree.innerHTML.indexOf('2026') >= 0, 'year subfolder');
assert(tree.innerHTML.indexOf('July 2026') >= 0, 'month subfolder');
assert(tree.innerHTML.indexOf('August 2026') >= 0, 'August month subfolder');
assert(tree.innerHTML.indexOf('invoice-HM9DCDMEXT.pdf') >= 0, 'PDF leaf');
assert(tree.innerHTML.indexOf('/api/platform-invoices/1/file') >= 0, 'Open href');
assert(/4 PDF/.test(meta.textContent), 'meta counts PDFs: ' + meta.textContent);

ctx.PI.vaultHideEmpty = false;
ctx.renderVaultTree();
assert(tree.innerHTML.indexOf('Sunset Nest in Fiskardo') >= 0, 'unmapped apartment still listed');
assert(tree.innerHTML.indexOf('Sunset Nest in Fiskardo ·') < 0, 'no hotel id suffix when unmapped');
ctx.PI.vaultHideEmpty = true;

ctx.PI.vaultQ = '11820968';
ctx.renderVaultTree();
assert(tree.innerHTML.indexOf('Birdhouse Apartment · 11820968') >= 0, 'search by Booking.com id finds Birdhouse');
assert(tree.innerHTML.indexOf('Coloneum') < 0, 'search by Birdhouse id hides Coloneum');
ctx.PI.vaultQ = '';
ctx.renderVaultTree();

console.log('platform-invoice-vault-folders.test.js: ok');
