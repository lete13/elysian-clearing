'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const listeners = {};
const panel = {
  dataset: {},
  innerHTML: '',
  addEventListener(type, handler) { listeners[type] = handler; },
  contains() { return true; },
  querySelector() { return null; },
};

const rows = Array.from({ length: 200 }, (_, index) => ({
  aptId: 'a' + (index + 1),
  aptName: 'Apartment ' + String(index + 1).padStart(3, '0'),
  checkinSameDay: index % 5 === 0 ? 'unknown' : 'yes',
  nextNights: 2 + (index % 6),
  people: 1 + (index % 5),
  arrivalTime: (14 + (index % 8)) + ':00',
  comments: index % 11 === 0 ? 'Priority arrival' : '',
  isPriority: index % 11 === 0,
  cleanType: 'turnover',
  cleanTask: 'katharismos',
  cleanerNames: index % 4 === 0 ? [] : [['Maria', 'Eleni', 'Katerina'][index % 3]],
  cleanerName: index % 4 === 0 ? '' : ['Maria', 'Eleni', 'Katerina'][index % 3],
  cleanDone: index % 7 === 0,
}));

const apartments = rows.map((row, index) => ({
  id: row.aptId,
  name: row.aptName,
  address: (index + 1) + ' Example St',
  area: ['Athens', 'Piraeus', 'Thessaloniki'][index % 3],
}));

const S = {
  apts: apartments,
  bks: [],
  cleaners: ['Maria', 'Eleni', 'Katerina'],
  drivers: ['Yannis'],
  daily: {
    snapshots: {},
    tasks: [],
    extra: {
      '2026-08-15': {
        oncall: {}, repo: {}, adeies: {}, adeiesDur: {},
        imatismos_cholargos: {}, imatismos_thess: {}, odigoi: {},
        odigoiRoutes: {}, _rows: {},
      },
    },
  },
};

const context = {
  console, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, isFinite,
  URL, navigator: {}, ClipboardItem() {}, confirm: () => true, prompt: () => '',
  S, _opsDate: '2026-08-15', _opsRows: [], _opsCleanExtras: [], _opsNotes: '',
  _dbAvailable: false,
  OPS_CLEAN_TASKS: [
    ['katharismos', 'Cleaning'], ['prepare_sofa', 'Sofa'],
    ['episkeui', 'Repair'], ['extra', 'Extra'],
  ],
  OPS_KINDS: [
    { key: 'isMaintenance', manual: 'maintenanceManual' },
    { key: 'isPreparation', manual: 'preparationManual' },
    { key: 'isExtended', manual: 'extendedManual' },
  ],
  document: {
    getElementById(id) { return id === 'tab-opsbeta' ? panel : null; },
    createElement() { return { style: {}, setAttribute() {}, click() {}, remove() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
};

context.window = context;
context.window._opsBetaState = {
  filter: 'all', sort: 'default', search: '', selected: {},
  selectionDate: '', focusId: '', page: 1, pageSize: 50,
};
context.window.requestAnimationFrame = (fn) => fn();
context.window.showTab = function () {};
Object.assign(context, {
  startDbPoll() {}, save() {}, saveToDb() {}, _opsSaveNow() {}, _opsEnsure() {},
  _opsTodayStr: () => '2026-08-15',
  _opsDefaultOpsDate: () => '2026-08-15',
  _opsDayLabel: () => '15 August 2026',
  _opsLoadData: () => ({ rows, notes: '' }),
  _opsPrepareCleanDay() {
    context._opsCleanExtras = [];
    return { done: rows.filter((row) => row.cleanDone).length, total: rows.length, clean: rows, extras: [] };
  },
  _opsCleanTarget: (row) => row,
  _opsCleanStorageKey: (row) => (row.aptId || row.aptName) + '::' + (row.cleanType || 'turnover'),
  _opsFindCleanRow: (key) => rows.find((row) => row.aptId + '::' + (row.cleanType || 'turnover') === key),
  _opsCleanerList: (row) => row ? (row.cleanerNames || []) : [],
  _opsKindOf: () => null,
  _opsAptOf: (row) => apartments.find((apt) => apt.id === row.aptId),
  _opsAptLines(row) {
    const apt = apartments.find((candidate) => candidate.id === row.aptId);
    return { name: apt.name, addr: apt.address };
  },
  _opsAvailableCleaners: () => S.cleaners,
  _opsScheduleAptOptions: () => [],
  _opsDriverRoutes: () => [],
  _opsSyncUnassignedToRepo() {}, _opsApplySofaCommentsAll() {},
  _opsApplySameDayPriorityAll() {}, _opsPrefetchRentalInfo() {},
  aptAreaLabel: (apt) => apt.area || '',
});

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(rootDir, 'fe', 'daily-ops-beta.js'), 'utf8'), context);
context.renderOpsBeta();

const renderedRows = () => (panel.innerHTML.match(/class="ob-dispatch-row/g) || []).length;
const event = (action, extra = {}) => ({
  target: Object.assign({ dataset: { obAction: action }, tagName: 'INPUT', closest() { return this; } }, extra),
  preventDefault() {},
});

assert.strictEqual(renderedRows(), 50, 'only one 50-row page is rendered');
assert(panel.innerHTML.includes('Page 1 / 4'), '200 rows produce four pages');
assert(panel.innerHTML.includes('showing 50 of 200'), 'visible and total counts are explicit');

listeners.change(event('select-page', { checked: true }));
assert.strictEqual(Object.keys(context._opsBetaState.selected).length, 50, 'select-page selects 50 rows');

listeners.change(event('bulk-cleaner', { value: 'Maria', tagName: 'SELECT' }));
assert(rows.slice(0, 50).every((row) => row.cleanerName === 'Maria'), 'bulk cleaner assignment updates the page');

listeners.click(event('page', { dataset: { obAction: 'page', obPage: '2' } }));
assert(panel.innerHTML.includes('Page 2 / 4'), 'paging advances without expanding the DOM');

listeners.click(event('select-all-results'));
assert.strictEqual(Object.keys(context._opsBetaState.selected).length, 200, 'select-all covers every filtered result');

listeners.click(event('crew-assign', {
  dataset: { obAction: 'crew-assign', obName: encodeURIComponent('Eleni') },
}));
assert(rows.every((row) => row.cleanerName === 'Eleni'), 'crew workload action assigns all selected rows');

listeners.click(event('inspect', {
  dataset: { obAction: 'inspect', obId: encodeURIComponent('row:a101::turnover') },
}));
assert(panel.innerHTML.includes('Apartment 101'), 'a single reservation opens in the inspector');

console.log('daily-ops-beta-scale: ok (200 rows, 4 pages, bulk assignment, inspector)');
