/* Daily Ops — promoted Beta table UI
 *
 * Renders into #tab-ops and replaces classic renderOps(). Shares S.daily /
 * _ops* persistence with the rest of the app (cleaners, staff, crew poster).
 */
(function () {
  'use strict';

  var state = window._opsBetaState = window._opsBetaState || {
    filter: 'all',
    sort: 'status',
    search: '',
    saveTimer: null,
    searchTimer: null,
    selected: {},
    selectionDate: '',
    focusId: '',
    page: 1,
    pageSize: 0, // 0 = show every matching row (table height follows the day)
  };
  if (!state.selected) state.selected = {};
  if (state.pageSize == null) state.pageSize = 0;
  if (!state.page) state.page = 1;

  function pageSizeFor(total) {
    var size = Number(state.pageSize);
    if (!isFinite(size) || size <= 0) return Math.max(1, total || 1);
    return size;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function encoded(value) {
    return encodeURIComponent(String(value == null ? '' : value));
  }

  function decoded(value) {
    try { return decodeURIComponent(String(value || '')); }
    catch (e) { return String(value || ''); }
  }

  function today() {
    return (typeof _opsTodayStr === 'function') ? _opsTodayStr() : new Date().toISOString().slice(0, 10);
  }

  function dateLabel(value) {
    if (typeof _opsDayLabel === 'function') return _opsDayLabel(value);
    if (typeof _opsFmtDate === 'function') return _opsFmtDate(value);
    return value;
  }

  function cleanKey(row) {
    if (!row) return '';
    if (typeof _opsCleanStorageKey === 'function') return _opsCleanStorageKey(row);
    return String(row.aptId || row.aptName || '') + '::' + String(row.cleanType || 'turnover');
  }

  function cleanTarget(row) {
    if (!row) return null;
    return (typeof _opsCleanTarget === 'function') ? _opsCleanTarget(row) : row;
  }

  function cleaners(row) {
    if (!row) return [];
    if (typeof _opsCleanerList === 'function') return _opsCleanerList(row);
    if (Array.isArray(row.cleanerNames)) return row.cleanerNames.filter(Boolean);
    return row.cleanerName ? [row.cleanerName] : [];
  }

  function kindOf(row) {
    return (row && typeof _opsKindOf === 'function') ? _opsKindOf(row) : null;
  }

  function cleanType(row) {
    var t = String((row && row.cleanType) || 'turnover');
    if (t === 'refresh') return { label: 'REFRESH', cls: 'ob-blue' };
    if (t === 'sofa_bed') return { label: 'SOFA', cls: 'ob-red' };
    return { label: 'TURNOVER', cls: 'ob-green' };
  }

  function taskOptions(current) {
    var list = (typeof OPS_CLEAN_TASKS !== 'undefined' && Array.isArray(OPS_CLEAN_TASKS))
      ? OPS_CLEAN_TASKS
      : [['katharismos', 'Καθαρισμός'], ['prepare_sofa', 'Prepare sofa bed'], ['episkeui', 'Επισκευή βλάβης'], ['extra', 'Extra']];
    return list.map(function (item) {
      return '<option value="' + esc(item[0]) + '"' + (String(current || 'katharismos') === String(item[0]) ? ' selected' : '') + '>' + esc(item[1]) + '</option>';
    }).join('');
  }

  function setSaveState(text, ok) {
    var el = document.getElementById('ops-beta-save-state');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok === false ? 'var(--ob-red)' : 'var(--ob-muted)';
  }

  function persist(immediateDb) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    try {
      if (typeof _opsSaveNow === 'function') _opsSaveNow();
      else if (typeof save === 'function') save();
      if (immediateDb && typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
      setSaveState('Saved ' + new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' }), true);
    } catch (e) {
      setSaveState('Save failed: ' + (e.message || e), false);
    }
  }

  function queueSave() {
    clearTimeout(state.saveTimer);
    setSaveState('Saving…', true);
    state.saveTimer = setTimeout(function () { persist(true); }, 500);
  }

  function mainAndExtras() {
    var main = (_opsRows || []).map(function (row, index) {
      var target = cleanTarget(row);
      return { row: row, index: index, target: target, extra: false, key: target ? cleanKey(target) : '' };
    });
    var attached = {};
    main.forEach(function (item) {
      if (item.target && item.target !== item.row) attached[cleanKey(item.target)] = true;
    });
    var extra = (_opsCleanExtras || []).filter(function (row) {
      return !attached[cleanKey(row)];
    }).map(function (row) {
      return { row: row, index: -1, target: row, extra: true, key: cleanKey(row) };
    });
    return main.concat(extra);
  }

  function itemAttention(item) {
    var row = item.row || {};
    var target = item.target;
    var notes = String(row.comments || row.cleanTaskNote || '');
    return !!(
      (target && !target.cleanDone) ||
      (target && cleaners(target).length === 0) ||
      row.checkinSameDay === 'unknown' ||
      row.isPriority || row.lateCheckout || row.parkBed || row.earlyCheckin ||
      /Prepare [12] sofa bed/i.test(notes)
    );
  }

  function filteredItems(items) {
    var q = String(state.search || '').toLowerCase().trim();
    var out = items.filter(function (item) {
      var target = item.target;
      if (state.filter === 'attention' && !itemAttention(item)) return false;
      if (state.filter === 'open' && (!target || target.cleanDone)) return false;
      if (state.filter === 'done' && (!target || !target.cleanDone)) return false;
      if (state.filter === 'unassigned' && (!target || cleaners(target).length > 0)) return false;
      if (!q) return true;
      var hay = [item.row.aptName, item.row.comments, item.row.cleanTaskNote, cleaners(target).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (state.sort === 'cleaner') {
      out.sort(function (a, b) {
        var ac = String(cleaners(a.target)[0] || 'zzz');
        var bc = String(cleaners(b.target)[0] || 'zzz');
        var byCleaner = ac.localeCompare(bc, 'el', { sensitivity: 'base' });
        if (byCleaner) return byCleaner;
        if (typeof window.aptProximityCompare === 'function') return window.aptProximityCompare(_opsAptOf(a.row), _opsAptOf(b.row));
        return String(a.row.aptName || '').localeCompare(String(b.row.aptName || ''));
      });
    } else if (state.sort === 'status') {
      out.sort(function (a, b) {
        function rank(item) {
          if (!item.target) return 4;
          if (item.target.cleanDone) return 3;
          if (!cleaners(item.target).length || item.row.checkinSameDay === 'unknown' || item.row.isPriority) return 0;
          return 1;
        }
        var diff = rank(a) - rank(b);
        if (diff) return diff;
        return String(a.row.aptName || '').localeCompare(String(b.row.aptName || ''), 'el', { numeric: true });
      });
    }
    return out;
  }

  function itemId(item) {
    var row = (item && item.row) || {};
    var base = item && item.key ? item.key : String(row.aptId || row.aptName || item.index || 'row');
    return (item && item.extra ? 'extra:' : 'row:') + base;
  }

  function selectedItems(items) {
    return items.filter(function (item) { return !!state.selected[itemId(item)]; });
  }

  function resetSelectionForDate() {
    if (state.selectionDate === _opsDate) return;
    state.selectionDate = _opsDate;
    state.selected = {};
    state.focusId = '';
    state.page = 1;
  }

  function checkinHtml(row, index) {
    if (row.isCheckinOnly || row.checkinSameDay === 'checkin_only') {
      return '<span class="ob-chip ob-blue">Άφιξη' + (row.nextNights ? ' · ' + esc(row.nextNights) + ' νύχτες' : '') + '</span>';
    }
    var stateName = row.checkinSameDay || 'unknown';
    var cfg = stateName === 'yes'
      ? { cls: 'ob-green', text: 'Ναι' + (row.nextNights ? ' · ' + row.nextNights + ' νύχτες' : '') }
      : stateName === 'no'
        ? { cls: 'ob-red', text: 'Όχι' }
        : { cls: 'ob-amber', text: 'Δεν ξέρουμε' };
    return '<button class="ob-chip ob-checkin ' + cfg.cls + '" data-ob-action="checkin" data-ob-index="' + index + '">' + esc(cfg.text) + '</button>';
  }

  function cleanerRoster() {
    var out = [];
    (Array.isArray(S.cleaners) ? S.cleaners : []).forEach(function (entry) {
      var name = typeof entry === 'string' ? entry : (entry && entry.name);
      if (!name || out.indexOf(name) >= 0) return;
      if (typeof _opsIsCleanerRole === 'function' && !_opsIsCleanerRole(name)) return;
      out.push(name);
    });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b), 'el', { sensitivity: 'base' }); });
  }

  function compactFlags(row, index, extra) {
    if (extra) return '<span class="ob-row-muted">—</span>';
    // Icons (not letters) so the activity is readable at a glance.
    var defs = [
      ['late', '⏰', 'Late checkout', row.lateCheckout, 'hot'],
      ['priority', '❗', 'Priority', row.isPriority, 'hot'],
      ['park', '👶', 'Παρκοκρεβάτο', row.parkBed, 'cool'],
      ['early', '☀️', 'Early check-in', row.earlyCheckin, 'cool'],
    ];
    return '<div class="ob-row-flags">' + defs.map(function (f) {
      return '<button type="button" class="ob-mini-flag ' + f[4] + (f[3] ? ' on' : '') + '" data-ob-action="flag" data-ob-index="' + index + '" data-ob-flag="' + f[0] + '" title="' + f[2] + '" aria-label="' + f[2] + '">' + f[1] + '</button>';
    }).join('') + '</div>';
  }

  // Option A — Ops urgency: soft row tint + left edge, highest signal first.
  function rowToneClass(item) {
    var row = (item && item.row) || {};
    var target = item && item.target;
    var notes = String(row.comments || row.cleanTaskNote || '');
    var sofa = /Prepare [12] sofa bed/i.test(notes);
    if (target && target.cleanDone) return 'tone-done';
    if (!target) return 'tone-excluded';
    if (row.isPriority || row.lateCheckout || sofa) return 'tone-hot';
    if (!cleaners(target).length || row.checkinSameDay === 'unknown') return 'tone-warn';
    if (row.checkinSameDay === 'yes' || row.checkinSameDay === 'checkin_only' || row.isCheckinOnly || row.earlyCheckin) {
      return 'tone-same';
    }
    return 'tone-open';
  }

  function cleanerChipsHtml(target) {
    if (!target) return '<span class="ob-row-muted">—</span>';
    var key = cleanKey(target);
    var names = cleaners(target);
    var chips = names.map(function (nm, ni) {
      return '<span class="ob-cchip">' + esc(nm) +
        '<button type="button" data-ob-action="cleaner-remove" data-ob-key="' + encoded(key) + '" data-ob-idx="' + ni + '" title="Αφαίρεση">×</button></span>';
    }).join('');
    return '<div class="ob-cchips-wrap">' +
      (chips ? '<div class="ob-cchips">' + chips + '</div>' : '') +
      '<input class="ob-input ob-row-cleaner" list="ops-beta-cleaners" value="" placeholder="' + (names.length ? '+ άλλη…' : 'Καθαρίστρια…') + '" data-ob-action="cleaner-add" data-ob-key="' + encoded(key) + '">' +
      '</div>';
  }

  function colorLegendHtml() {
    return '<div class="ob-tone-legend" title="Reservation color coding">' +
      '<span class="ob-tone-lg"><i class="tone-hot"></i>Priority / late / sofa</span>' +
      '<span class="ob-tone-lg"><i class="tone-warn"></i>Unassigned / CI unknown</span>' +
      '<span class="ob-tone-lg"><i class="tone-same"></i>Same-day / Early</span>' +
      '<span class="ob-tone-lg"><i class="tone-open"></i>Normal open</span>' +
      '<span class="ob-tone-lg"><i class="tone-done"></i>Clean ✓ done</span>' +
      '</div>';
  }

  function dispatchRowHtml(item, displayNumber) {
    var row = item.row || {};
    var target = item.target;
    var id = itemId(item);
    var selected = !!state.selected[id];
    var done = !!(target && target.cleanDone);
    var lines = (typeof _opsAptLines === 'function') ? _opsAptLines(row) : { name: row.aptName || '', addr: '' };
    var area = (typeof window.aptAreaLabel === 'function' && typeof _opsAptOf === 'function') ? window.aptAreaLabel(_opsAptOf(row)) : '';
    var type = target ? cleanType(target) : null;
    var kind = kindOf(row);
    var names = cleaners(target).join(', ');
    var note = String(row.comments || row.cleanTaskNote || '');
    var keyAttr = target ? ' data-ob-key="' + encoded(item.key) + '"' : '';
    var statusClass = done ? 'done' : (!target ? 'excluded' : (!names ? 'unassigned' : 'open'));
    var toneClass = rowToneClass(item);
    var statusText = done ? 'DONE' : (!target ? 'NO CLEAN' : (!names ? 'UNASSIGNED' : 'OPEN'));
    var checkin = item.extra
      ? '<span class="ob-row-muted">—</span>'
      : checkinHtml(row, item.index);
    var cleanControl = target
      ? '<input class="ob-clean-check ob-row-clean" type="checkbox" data-ob-action="clean" data-ob-key="' + encoded(item.key) + '"' + (done ? ' checked' : '') + ' title="Καθαρίστηκε">'
      : '<span class="ob-row-muted">—</span>';
    var cleanerControl = target ? cleanerChipsHtml(target) : '<span class="ob-row-muted">—</span>';
    var taskControl = target
      ? '<select class="ob-select ob-row-task" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="cleanTask">' + taskOptions(target.cleanTask) + '</select>'
      : '<span class="ob-row-muted">—</span>';
    var paxControl = item.extra
      ? '<span class="ob-row-muted">' + esc(row.people || '—') + '</span>'
      : '<input class="ob-input ob-row-pax" type="number" min="0" max="20" value="' + esc(row.people || '') + '" data-ob-action="row-field" data-ob-index="' + item.index + '" data-ob-field="people" placeholder="—">';
    var etaControl = item.extra
      ? '<span class="ob-row-muted">—</span>'
      : '<input class="ob-input ob-row-eta" value="' + esc(row.arrivalTime || '') + '" data-ob-action="row-field" data-ob-index="' + item.index + '" data-ob-field="arrivalTime" placeholder="—">';
    var noteControl = item.extra
      ? '<input class="ob-input ob-row-note" value="' + esc(note) + '" data-ob-action="clean-field" data-ob-key="' + encoded(item.key) + '" data-ob-field="comments" placeholder="Notes…">'
      : '<input class="ob-input ob-row-note" value="' + esc(note) + '" data-ob-action="comment" data-ob-index="' + item.index + '"' + keyAttr + ' placeholder="Notes…">';
    var badges = (type ? '<span class="ob-row-type ' + type.cls + '">' + esc(type.label) + '</span>' : '') +
      (kind ? '<span class="ob-row-type ob-amber">' + esc(kind.label) + '</span>' : '') +
      (row.isOwner ? '<span class="ob-row-type ob-red">OWNER</span>' : '');
    return '<tr class="ob-dispatch-row ' + statusClass + ' ' + toneClass + (selected ? ' selected' : '') + '" data-ob-id="' + encoded(id) + '">' +
      '<td class="ob-center"><input type="checkbox" data-ob-action="select" data-ob-id="' + encoded(id) + '"' + (selected ? ' checked' : '') + (target ? '' : ' disabled') + ' aria-label="Select ' + esc(lines.name || row.aptName) + '"></td>' +
      '<td class="ob-center">' + cleanControl + '</td>' +
      '<td class="ob-property-cell"><div class="ob-property-line"><b>' + displayNumber + ' · ' + esc(lines.name || row.aptName || 'Apartment') + '</b>' + badges + '</div><small>' + esc([area, lines.addr].filter(Boolean).join(' · ')) + '</small></td>' +
      '<td><div class="ob-stay-line"><span>' + (row.isCheckinOnly ? 'Arrival only' : 'CO') + '</span>' + checkin + '</div><small>' + esc(row.nextNights ? row.nextNights + ' nights' : '') + '</small></td>' +
      '<td class="ob-center">' + paxControl + '</td>' +
      '<td class="ob-center">' + etaControl + '</td>' +
      '<td>' + compactFlags(row, item.index, item.extra) + '</td>' +
      '<td>' + cleanerControl + '</td>' +
      '<td>' + taskControl + '</td>' +
      '<td>' + noteControl + '</td>' +
      '<td><span class="ob-row-status ' + statusClass + '">' + statusText + '</span></td>' +
      '</tr>';
  }

  function bulkBarHtml(filtered, allItems) {
    var selected = selectedItems(allItems);
    var count = selected.length;
    var actionable = filtered.filter(function (item) { return !!item.target; });
    var allFilteredSelected = !!actionable.length && actionable.every(function (item) { return !!state.selected[itemId(item)]; });
    var roster = cleanerRoster();
    var options = '<option value="">Assign cleaner…</option>' + roster.map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');
    var taskList = '<option value="">Set task…</option>' + taskOptions('__none__').replace(/ selected/g, '');
    return '<div class="ob-bulk' + (count ? ' active' : '') + '">' +
      '<b>' + count + ' selected</b>' +
      '<button class="ob-btn" data-ob-action="select-all-results"' + (!actionable.length || allFilteredSelected ? ' disabled' : '') + '>Select all ' + actionable.length + ' actionable</button>' +
      '<select class="ob-select" data-ob-action="bulk-cleaner"' + (count ? '' : ' disabled') + '>' + options + '</select>' +
      '<select class="ob-select" data-ob-action="bulk-task"' + (count ? '' : ' disabled') + '>' + taskList + '</select>' +
      '<button class="ob-btn ob-success" data-ob-action="bulk-done"' + (count ? '' : ' disabled') + '>✓ Mark clean</button>' +
      '<button class="ob-btn" data-ob-action="bulk-open"' + (count ? '' : ' disabled') + '>Reopen</button>' +
      '<span class="ob-spacer"></span>' +
      '<button class="ob-btn" data-ob-action="clear-selection"' + (count ? '' : ' disabled') + '>Clear</button>' +
      '</div>';
  }

  function pagerHtml(page, pageCount, total, size) {
    var all = !Number(state.pageSize);
    return '<div class="ob-pager"><span>' + total + ' matching rows' + (all ? '' : (' · page size ' + size)) + '</span><span class="ob-spacer"></span>' +
      '<button class="ob-btn ob-square" data-ob-action="page" data-ob-page="' + (page - 1) + '"' + (page <= 1 || all ? ' disabled' : '') + '>←</button>' +
      '<b>' + (all ? 'Showing all' : ('Page ' + page + ' / ' + pageCount)) + '</b>' +
      '<button class="ob-btn ob-square" data-ob-action="page" data-ob-page="' + (page + 1) + '"' + (page >= pageCount || all ? ' disabled' : '') + '>→</button>' +
      '<select class="ob-select" data-ob-action="page-size" title="Rows shown in the table">' +
      '<option value="0"' + (all ? ' selected' : '') + '>Fit all rows</option>' +
      '<option value="25"' + (state.pageSize === 25 ? ' selected' : '') + '>25 rows</option>' +
      '<option value="50"' + (state.pageSize === 50 ? ' selected' : '') + '>50 rows</option>' +
      '<option value="100"' + (state.pageSize === 100 ? ' selected' : '') + '>100 rows</option>' +
      '</select></div>';
  }

  function cleanerDatalist() {
    var names = [];
    if (Array.isArray(S.cleaners)) {
      S.cleaners.forEach(function (entry) {
        var name = typeof entry === 'string' ? entry : (entry && entry.name);
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    }
    return '<datalist id="ops-beta-cleaners">' + names.sort().map(function (name) { return '<option value="' + esc(name) + '"></option>'; }).join('') + '</datalist>';
  }

  function activeTasks() {
    if (!S.daily || !Array.isArray(S.daily.tasks)) return [];
    return S.daily.tasks.filter(function (task) {
      if (task.createdDate > _opsDate) return false;
      if (task.completed && task.completedDate < _opsDate) return false;
      return true;
    });
  }

  function tasksHtml(tasks) {
    var html = '<b>📋 Tasks</b>';
    if (!tasks.length) html += '<span style="font-size:10px;color:var(--ob-muted)">No tasks for this day</span>';
    tasks.forEach(function (task) {
      var apt = task.aptName || '';
      if (!apt && task.aptId) {
        var hit = (S.apts || []).find(function (a) { return a.id === task.aptId; });
        apt = hit ? hit.name : '';
      }
      html += '<label class="ob-task"><input type="checkbox" data-ob-action="task-toggle" data-ob-id="' + esc(task.id) + '"' + (task.completed ? ' checked' : '') + '>' +
        '<span' + (task.completed ? ' style="text-decoration:line-through;opacity:.6"' : '') + '>' + (apt ? '<b>' + esc(apt) + ':</b> ' : '') + esc(task.text) + '</span>' +
        '<button type="button" data-ob-action="task-delete" data-ob-id="' + esc(task.id) + '">×</button></label>';
    });
    return html + '<span class="ob-spacer"></span><button class="ob-btn" data-ob-action="task-add">+ Add task</button>';
  }

  function personNamesFor(block, current) {
    var list = [];
    if (typeof _opsAvailableCleaners === 'function') list = _opsAvailableCleaners(current || '', block) || [];
    else if (Array.isArray(S.cleaners)) list = S.cleaners.map(function (x) { return typeof x === 'string' ? x : x.name; }).filter(Boolean);
    if (current && list.indexOf(current) < 0) list.unshift(current);
    return list;
  }

  function personSelect(block, index, current) {
    var options = '<option value="">—</option>' + personNamesFor(block, current).map(function (name) {
      return '<option value="' + esc(name) + '"' + (String(name).toLowerCase() === String(current || '').toLowerCase() ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
    return '<select class="ob-select" data-ob-action="staff" data-ob-block="' + esc(block) + '" data-ob-index="' + index + '">' + options + '</select>';
  }

  function staffCard(title, block, baseRows, extra, leave) {
    var rowExtra = Number((extra._rows || {})[block] || 0);
    var count = baseRows + rowExtra;
    var values = extra[block] || {};
    var html = '<div class="ob-staff-card"><h4>' + esc(title) + '</h4>';
    for (var i = 0; i < count; i++) {
      html += '<div class="ob-staff-row">' + personSelect(block, i, String(values[i] || ''));
      if (leave) {
        var days = Number(((extra.adeiesDur || {})[i]) || 1);
        html += '<input class="ob-input" style="width:52px;flex:0 0 52px" type="number" min="1" max="30" value="' + days + '" data-ob-action="leave-days" data-ob-index="' + i + '" title="Ημέρες άδειας">';
      }
      html += '</div>';
    }
    return html + '<button class="ob-btn ob-staff-add" data-ob-action="staff-add" data-ob-block="' + esc(block) + '">+ row</button></div>';
  }

  function routeStops(index) {
    if (typeof _opsDriverRoutes === 'function') return _opsDriverRoutes(index) || [];
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    if (!day.odigoiRoutes) day.odigoiRoutes = {};
    if (!Array.isArray(day.odigoiRoutes[index])) day.odigoiRoutes[index] = [];
    return day.odigoiRoutes[index];
  }

  function driversHtml(extra) {
    var count = 2 + Number((extra._rows || {}).odigoi || 0);
    var values = extra.odigoi || {};
    var aptOptions = (typeof _opsScheduleAptOptions === 'function') ? _opsScheduleAptOptions() : [];
    var html = '<div class="ob-staff-card"><h4>ΟΔΗΓΟΙ / ΔΙΑΔΡΟΜΕΣ</h4>';
    for (var i = 0; i < count; i++) {
      var stops = routeStops(i);
      html += '<div class="ob-driver"><div class="ob-staff-row"><input class="ob-input" list="ops-beta-drivers" value="' + esc(values[i] || '') + '" data-ob-action="staff" data-ob-block="odigoi" data-ob-index="' + i + '" placeholder="οδηγός"></div>' +
        '<div class="ob-route-chips">' + stops.map(function (stop, stopIndex) {
          return '<span class="ob-route-chip">' + esc(stop.name || stop.key) + '<button type="button" data-ob-action="route-remove" data-ob-driver="' + i + '" data-ob-stop="' + stopIndex + '">×</button></span>';
        }).join('') + '</div>' +
        '<select class="ob-select" style="width:100%" data-ob-action="route-add" data-ob-driver="' + i + '"><option value="">+ apartment stop…</option>' +
        aptOptions.map(function (opt) {
          var used = stops.some(function (stop) { return stop.key === opt.key; });
          return '<option value="' + esc(opt.key) + '"' + (used ? ' disabled' : '') + '>' + esc(opt.title || opt.name) + '</option>';
        }).join('') + '</select></div>';
    }
    return html + '<button class="ob-btn ob-staff-add" data-ob-action="staff-add" data-ob-block="odigoi">+ driver</button></div>';
  }

  function driverDatalist() {
    var names = [];
    if (Array.isArray(S.drivers)) {
      S.drivers.forEach(function (entry) {
        var name = typeof entry === 'string' ? entry : (entry && entry.name);
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    }
    return '<datalist id="ops-beta-drivers">' + names.map(function (name) { return '<option value="' + esc(name) + '"></option>'; }).join('') + '</datalist>';
  }

  function staffHtml() {
    if (typeof _opsSyncUnassignedToRepo === 'function') {
      try { _opsSyncUnassignedToRepo(); } catch (e) {}
    }
    _opsEnsure();
    var extra = S.daily.extra[_opsDate] || {};
    return '<div class="ob-staff-grid">' +
      staffCard('ΕΦΗΜΕΡΙΑ', 'oncall', 1, extra, false) +
      staffCard('ΡΕΠΟ', 'repo', 5, extra, false) +
      staffCard('ΑΔΕΙΕΣ', 'adeies', 5, extra, true) +
      '<div class="ob-staff-card"><h4>ΙΜΑΤΙΣΜΟΣ</h4><div class="ob-label">Χολαργός</div><div class="ob-staff-row">' + personSelect('imatismos_cholargos', 0, String(((extra.imatismos_cholargos || {})[0]) || '')) + '</div>' +
      '<div class="ob-label" style="margin-top:8px">Θεσσαλονίκη</div><div class="ob-staff-row">' + personSelect('imatismos_thess', 0, String(((extra.imatismos_thess || {})[0]) || '')) + '</div></div>' +
      driversHtml(extra) + '</div>' + driverDatalist();
  }

  function setStaff(block, index, value) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate][block]) S.daily.extra[_opsDate][block] = {};
    var previous = S.daily.extra[_opsDate][block][index];
    S.daily.extra[_opsDate][block][index] = value;
    if (block === 'adeies' && typeof _opsSyncAdeiaRange === 'function') _opsSyncAdeiaRange(index);
    if (block === 'odigoi' && String(previous || '') !== String(value || '') && typeof _opsRewriteDriverRouteComments === 'function') {
      _opsRewriteDriverRouteComments(index, previous, value);
    }
    if (block !== 'repo' && typeof _opsSyncUnassignedToRepo === 'function') _opsSyncUnassignedToRepo();
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
  }

  function addStaffRow(block) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate]._rows) S.daily.extra[_opsDate]._rows = {};
    S.daily.extra[_opsDate]._rows[block] = Number(S.daily.extra[_opsDate]._rows[block] || 0) + 1;
    if (typeof save === 'function') save();
  }

  function setLeaveDays(index, value) {
    _opsEnsure();
    if (!S.daily.extra[_opsDate]) S.daily.extra[_opsDate] = {};
    if (!S.daily.extra[_opsDate].adeiesDur) S.daily.extra[_opsDate].adeiesDur = {};
    var days = parseInt(value, 10);
    if (!isFinite(days) || days < 1) days = 1;
    if (days > 30) days = 30;
    S.daily.extra[_opsDate].adeiesDur[index] = days;
    if (typeof _opsSyncAdeiaRange === 'function') _opsSyncAdeiaRange(index);
    if (typeof save === 'function') save();
  }

  function addRoute(driverIndex, aptKey) {
    if (!aptKey) return;
    var options = (typeof _opsScheduleAptOptions === 'function') ? _opsScheduleAptOptions() : [];
    var hit = options.find(function (option) { return option.key === aptKey; });
    if (!hit) return;
    var stops = routeStops(driverIndex);
    if (stops.some(function (stop) { return stop.key === aptKey; })) return;
    stops.push({ key: hit.key, name: hit.name });
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    var driver = String(((day.odigoi || {})[driverIndex]) || '').trim();
    var row = (typeof _opsFindRow === 'function') ? _opsFindRow(aptKey) : null;
    var tag = (typeof _opsDriverRouteTag === 'function') ? _opsDriverRouteTag(driver || ('Driver ' + (driverIndex + 1))) : '';
    if (row && tag && typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, tag, true);
    persist(true);
  }

  function removeRoute(driverIndex, stopIndex) {
    var stops = routeStops(driverIndex);
    var stop = stops[stopIndex];
    if (!stop) return;
    stops.splice(stopIndex, 1);
    var day = (S.daily.extra && S.daily.extra[_opsDate]) || {};
    var driver = String(((day.odigoi || {})[driverIndex]) || '').trim();
    var row = (typeof _opsFindRow === 'function') ? _opsFindRow(stop.key) : null;
    var tag = (typeof _opsDriverRouteTag === 'function') ? _opsDriverRouteTag(driver || ('Driver ' + (driverIndex + 1))) : '';
    if (row && tag && typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, tag, false);
    persist(true);
  }

  function statusSummary(items) {
    var open = items.filter(function (item) { return item.target && !item.target.cleanDone; }).length;
    var unassigned = items.filter(function (item) { return item.target && !cleaners(item.target).length; }).length;
    var decisions = items.filter(itemAttention).length;
    return { open: open, unassigned: unassigned, decisions: decisions };
  }

  function render() {
    var root = document.getElementById('tab-ops');
    if (!root) return;
    window._opsFastSave = true;
    if (typeof startDbPoll === 'function') {
      try { startDbPoll(); } catch (e) {}
    }
    if (typeof _opsEnsure !== 'function' || typeof _opsLoadData !== 'function') {
      root.innerHTML = '<div style="padding:24px;color:var(--tx-err)">Daily Ops data helpers are not available.</div>';
      return;
    }
    _opsEnsure();
    if (!_opsDate) _opsDate = (typeof _opsDefaultOpsDate === 'function') ? _opsDefaultOpsDate() : today();
    if (typeof _opsPrefetchRentalInfo === 'function') _opsPrefetchRentalInfo();

    var loaded = _opsLoadData(_opsDate);
    _opsRows = loaded.rows || [];
    _opsNotes = loaded.notes || '';
    if (typeof _opsApplySofaCommentsAll === 'function') _opsApplySofaCommentsAll();
    if (typeof _opsApplySameDayPriorityAll === 'function') _opsApplySameDayPriorityAll();
    var cleanDay = (typeof _opsPrepareCleanDay === 'function') ? _opsPrepareCleanDay() : { done: 0, total: 0, extras: [] };
    var allItems = mainAndExtras();
    resetSelectionForDate();
    var visibleItems = filteredItems(allItems);
    var size = pageSizeFor(visibleItems.length);
    var pageCount = Math.max(1, Math.ceil((visibleItems.length || 1) / size));
    if (state.page > pageCount) state.page = pageCount;
    if (state.page < 1) state.page = 1;
    var pageStart = (state.page - 1) * size;
    var pageItems = visibleItems.slice(pageStart, pageStart + size);
    var pageActionable = pageItems.filter(function (item) { return !!item.target; });
    var pageAllSelected = !!pageActionable.length && pageActionable.every(function (item) { return !!state.selected[itemId(item)]; });
    var summary = statusSummary(allItems);
    var tasks = activeTasks();
    var isToday = _opsDate === today();
    var pct = cleanDay.total ? Math.round((cleanDay.done * 100) / cleanDay.total) : 0;

    var filters = [
      ['all', 'All ' + allItems.length],
      ['attention', 'Attention ' + summary.decisions],
      ['open', 'Open ' + summary.open],
      ['unassigned', 'Unassigned ' + summary.unassigned],
      ['done', 'Done ' + cleanDay.done],
    ].map(function (item) {
      return '<button class="ob-filter' + (state.filter === item[0] ? ' on' : '') + '" data-ob-action="filter" data-ob-filter="' + item[0] + '">' + esc(item[1]) + '</button>';
    }).join('');

    root.innerHTML = '<div class="ob-shell">' +
      '<div class="ob-command">' +
        '<div class="ob-title"><span class="ob-title-mark">Ops</span><div><b>Daily Ops</b><small>Checkout &amp; cleaning · live bookings</small></div></div>' +
        '<button class="ob-btn ob-square" data-ob-action="nav" data-ob-days="-1" title="Previous day">←</button>' +
        '<button class="ob-btn' + (isToday ? ' ob-primary' : '') + '" data-ob-action="today">Today</button>' +
        '<button class="ob-btn ob-square" data-ob-action="nav" data-ob-days="1" title="Next day">→</button>' +
        '<input class="ob-input ob-date" type="date" value="' + esc(_opsDate) + '" data-ob-action="date">' +
        '<span class="ob-stat"><b>' + _opsRows.length + '</b> checkout</span>' +
        '<span class="ob-stat"><b>' + cleanDay.done + '/' + cleanDay.total + '</b> clean</span>' +
        '<span class="ob-stat"><b>' + tasks.filter(function (t) { return !t.completed; }).length + '</b> tasks</span>' +
        '<span class="ob-spacer"></span>' +
        '<button class="ob-btn" data-ob-action="manage-cleaners" title="Add or remove cleaners">Καθαρίστριες</button>' +
        '<button class="ob-btn" data-ob-action="ops-image">📋 Ops image</button>' +
        '<button class="ob-btn ob-gold" data-ob-action="cleaner-image">🧹 Cleaner image</button>' +
        '<button class="ob-btn ob-gold" data-ob-action="schedule-check">📸 Check schedule</button>' +
        '<input type="file" id="ops-beta-schedule-file" accept="image/*" data-ob-action="schedule-file" hidden>' +
      '</div>' +
      '<div class="ob-page">' + cleanerDatalist() +
        '<details class="ob-collapsible ob-task-drawer"><summary>Tasks <b>' + tasks.filter(function (t) { return !t.completed; }).length + ' open</b></summary><div class="ob-tasks">' + tasksHtml(tasks) + '</div></details>' +
        '<div class="ob-toolbar">' + filters +
          '<span class="ob-spacer"></span>' +
          '<input class="ob-input ob-search" value="' + esc(state.search) + '" data-ob-action="search" placeholder="Search apartment, cleaner or comment…">' +
          '<select class="ob-select" data-ob-action="sort"><option value="status"' + (state.sort === 'status' ? ' selected' : '') + '>Sort: status</option><option value="cleaner"' + (state.sort === 'cleaner' ? ' selected' : '') + '>Sort: cleaner / route</option><option value="default"' + (state.sort === 'default' ? ' selected' : '') + '>Sort: default</option></select>' +
          '<button class="ob-btn ob-danger" data-ob-action="restart" title="Clears only the cleaning checkmarks for this day">Restart ✓</button>' +
        '</div>' +
        bulkBarHtml(visibleItems, allItems) +
        '<div id="ops-beta-board-capture">' +
          '<div class="ob-board-head"><div><h2>DISPATCH CONSOLE · CHECKOUT &amp; CLEANING</h2><small>' + esc(dateLabel(_opsDate)) + ' · showing ' + pageItems.length + ' of ' + visibleItems.length + ' matching rows</small></div><span class="ob-spacer"></span><b>' + cleanDay.done + ' / ' + cleanDay.total + ' clean</b><div class="ob-progress"><span style="width:' + pct + '%"></span></div></div>' +
          colorLegendHtml() +
          '<div class="ob-dispatch-layout"><div class="ob-dispatch-main">' +
            '<div class="ob-table-wrap"><table class="ob-dispatch-table"><thead><tr>' +
              '<th class="ob-center"><input type="checkbox" data-ob-action="select-page"' + (pageAllSelected ? ' checked' : '') + ' title="Select this page"></th>' +
              '<th class="ob-center">✓</th><th>Property</th><th>Stay / check-in</th><th class="ob-center">Pax</th><th class="ob-center">ETA</th><th>Flags</th><th>Cleaner</th><th>Task</th><th>Notes</th><th>Status</th>' +
            '</tr></thead><tbody>' +
              (pageItems.length ? pageItems.map(function (item, index) { return dispatchRowHtml(item, pageStart + index + 1); }).join('') : '<tr><td colspan="11"><div class="ob-empty">No rows match this view.</div></td></tr>') +
            '</tbody></table></div>' + pagerHtml(state.page, pageCount, visibleItems.length, size) +
          '</div></div>' +
        '</div>' +
        '<div class="ob-aux-grid"><details class="ob-collapsible"><summary>Staff, leave, linen &amp; driver routes</summary><div class="ob-section"><h3>Same saved data as Daily Ops</h3>' + staffHtml() + '</div></details>' +
          '<details class="ob-collapsible"><summary>Daily notes</summary><div class="ob-section"><textarea class="ob-notes" data-ob-action="notes" placeholder="General notes for the day…">' + esc(_opsNotes) + '</textarea><div class="ob-save-state" id="ops-beta-save-state">Saved fields are shared with Daily Ops</div></div></details>' +
        '</div>' +
      '</div></div>';
    bind(root);
  }

  function rerender() {
    render();
  }

  function findClean(key) {
    return (typeof _opsFindCleanRow === 'function') ? _opsFindCleanRow(key) : null;
  }

  function toggleFlag(index, flag) {
    var row = _opsRows[index];
    if (!row) return;
    if (flag === 'late') {
      row.lateCheckout = !row.lateCheckout;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_LATE, row.lateCheckout);
    } else if (flag === 'priority') {
      row.isPriority = !row.isPriority;
      row.priorityManual = !!row.isPriority;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_PRIORITY, row.isPriority);
    } else if (flag === 'park') {
      row.parkBed = !row.parkBed;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_PARK, row.parkBed);
    } else if (flag === 'early') {
      row.earlyCheckin = !row.earlyCheckin;
      if (typeof _opsSetManagedComment === 'function') _opsSetManagedComment(row, OPS_TAG_EARLY, row.earlyCheckin);
    }
    persist(true);
    rerender();
  }

  function toggleCheckin(index) {
    var row = _opsRows[index];
    if (!row || row.isCheckinOnly) return;
    var cycle = { yes: 'no', no: 'unknown', unknown: 'yes' };
    row.checkinSameDay = cycle[row.checkinSameDay] || 'unknown';
    row.checkinManual = true;
    delete row.priorityManual;
    if (typeof _opsApplySameDayPriority === 'function') _opsApplySameDayPriority(row);
    persist(true);
    rerender();
  }

  function toggleKind(index, key) {
    var row = _opsRows[index];
    if (!row || typeof OPS_KINDS === 'undefined') return;
    var now = !row[key];
    OPS_KINDS.forEach(function (kind) {
      if (kind.key === key) { row[kind.key] = now; row[kind.manual] = now; }
      else if (now) { row[kind.key] = false; row[kind.manual] = false; }
    });
    if (now) row.isCheckinOnly = false;
    else if (!row.checkoutGuest && row.checkinSameDay === 'checkin_only' && typeof _opsIsSpecial === 'function' && !_opsIsSpecial(row)) row.isCheckinOnly = true;
    if (typeof _opsOrder === 'function') _opsRows = _opsOrder(_opsRows);
    persist(true);
    rerender();
  }

  function updateRowField(index, field, value) {
    var row = _opsRows[index];
    if (!row) return;
    row[field] = value;
    if (field === 'people') {
      if (typeof _opsApplySofaComment === 'function') _opsApplySofaComment(row);
      if (typeof _opsApplyLongStayComment === 'function') _opsApplyLongStayComment(row);
    }
    queueSave();
  }

  function updateComment(index, key, value) {
    var row = _opsRows[index];
    if (!row) return;
    row.comments = value;
    row.cleanTaskNote = value;
    var target = findClean(key);
    if (target && target !== row) {
      target.comments = value;
      target.cleanTaskNote = value;
    }
    queueSave();
  }

  function updateCleanField(key, field, value) {
    var row = findClean(key);
    if (!row) return;
    if (field === 'comments') {
      row.comments = value;
      row.cleanTaskNote = value;
    } else {
      row[field] = value;
    }
    queueSave();
  }

  function updateCleaners(key, value) {
    var row = findClean(key);
    if (!row) return;
    var list = String(value || '').split(/\s*[·,;|/]\s*/).map(function (name) { return name.trim(); }).filter(Boolean);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else {
      row.cleanerNames = list;
      row.cleanerName = list.join(' · ');
    }
    queueSave();
  }

  function addCleanerChip(key, value) {
    if (typeof opsAddCleanerKey === 'function') {
      opsAddCleanerKey(key, value);
      return;
    }
    var row = findClean(key);
    if (!row) return;
    var add = String(value || '').split(/\s*[·,;|/]\s*/).map(function (name) { return name.trim(); }).filter(Boolean);
    if (!add.length) return;
    var list = cleaners(row).concat(add);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else { row.cleanerNames = list; row.cleanerName = list.join(' · '); }
    persist(true);
    rerender();
  }

  function removeCleanerChip(key, idx) {
    if (typeof opsRemoveCleanerAt === 'function') {
      opsRemoveCleanerAt(key, idx);
      return;
    }
    var row = findClean(key);
    if (!row) return;
    var list = cleaners(row).slice();
    if (idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(row, list);
    else { row.cleanerNames = list; row.cleanerName = list.join(' · '); }
    persist(true);
    rerender();
  }

  function selectItems(items, checked) {
    items.forEach(function (item) {
      var id = itemId(item);
      if (checked && item.target) state.selected[id] = true;
      else delete state.selected[id];
    });
  }

  function currentFilteredItems() {
    return filteredItems(mainAndExtras());
  }

  function currentPageItems() {
    var filtered = currentFilteredItems();
    var size = pageSizeFor(filtered.length);
    var start = (state.page - 1) * size;
    return filtered.slice(start, start + size);
  }

  function applySelected(callback, after) {
    var items = selectedItems(mainAndExtras());
    if (!items.length) return false;
    items.forEach(function (item) { if (item.target) callback(item.target, item); });
    persist(true);
    if (typeof after === 'function') after();
    rerender();
    return true;
  }

  function bulkCleaner(name) {
    if (!name) return;
    applySelected(function (target) {
      if (typeof _opsWriteCleaners === 'function') _opsWriteCleaners(target, [name]);
      else { target.cleanerNames = [name]; target.cleanerName = name; }
    });
  }

  function bulkTask(task) {
    if (!task) return;
    applySelected(function (target) { target.cleanTask = task; });
  }

  function bulkDone(done) {
    applySelected(function (target) { target.cleanDone = !!done; }, function () {
      if (done && typeof _opsMaybeAdvanceAfterCleans === 'function') _opsMaybeAdvanceAfterCleans();
    });
  }

  function removeRow(index) {
    if (!_opsRows[index]) return;
    if (!window.confirm('Remove this row from the selected day?')) return;
    _opsRows.splice(index, 1);
    persist(true);
    rerender();
  }

  function toggleTask(id, checked) {
    var task = (S.daily.tasks || []).find(function (item) { return item.id === id; });
    if (!task) return;
    task.completed = !!checked;
    task.completedDate = checked ? _opsDate : null;
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function addTask() {
    var text = window.prompt('Task for ' + dateLabel(_opsDate) + ':');
    if (!text || !String(text).trim()) return;
    var apartment = window.prompt('Apartment name (optional):', '') || '';
    var hit = apartment ? (S.apts || []).find(function (apt) {
      return String(apt.name || '').toLowerCase().indexOf(String(apartment).toLowerCase()) >= 0;
    }) : null;
    _opsEnsure();
    S.daily.tasks.push({
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      aptId: hit ? hit.id : '',
      aptName: hit ? hit.name : apartment,
      text: String(text).trim(),
      createdDate: _opsDate,
      completed: false,
      completedDate: null,
    });
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function deleteTask(id) {
    S.daily.tasks = (S.daily.tasks || []).filter(function (task) { return task.id !== id; });
    if (typeof save === 'function') save();
    if (typeof saveToDb === 'function' && typeof _dbAvailable !== 'undefined' && _dbAvailable) saveToDb();
    rerender();
  }

  function restartCleans() {
    if (typeof opsRestartCleaningSchedule === 'function') {
      opsRestartCleaningSchedule();
      return;
    }
    if (!window.confirm('Clear only the cleaning ✓ marks for ' + dateLabel(_opsDate) + '? Cleaners, comments, flags and staff blocks will stay.')) return;
    mainAndExtras().forEach(function (item) { if (item.target) item.target.cleanDone = false; });
    _opsEnsure();
    if (S.daily.cleansCompleteFor) delete S.daily.cleansCompleteFor[_opsDate];
    persist(true);
    rerender();
  }

  function copyBetaImage() {
    var el = document.getElementById('ops-beta-board-capture');
    if (!el) return;
    var run = async function () {
      if (typeof html2canvas === 'undefined') {
        if (typeof toast === 'function') toast('Loading image export…', 'warn');
        await new Promise(function (resolve, reject) {
          var script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      if (typeof toast === 'function') toast('Capturing Daily Ops…');
      var canvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: '#F4F6FA',
        useCORS: true,
        logging: false,
      });
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('Could not build PNG');
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (typeof toast === 'function') toast('Ops board copied — paste into chat', 'ok');
      } else {
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'daily-ops-' + (_opsDate || 'today') + '.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (typeof toast === 'function') toast('Downloaded Ops board PNG', 'ok');
      }
    };
    run().catch(function (error) {
      if (typeof toast === 'function') toast('Screenshot failed: ' + (error && error.message ? error.message : error), 'err');
    });
  }

  function bind(root) {
    if (root.dataset.opsBetaBound === '1') return;
    root.dataset.opsBetaBound = '1';
    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-ob-action]');
      if (!button || !root.contains(button)) return;
      var action = button.dataset.obAction;
      if (action === 'nav') {
        persist(false);
        _opsDate = (typeof _opsAddDays === 'function') ? _opsAddDays(_opsDate, Number(button.dataset.obDays || 0)) : _opsDate;
        rerender();
      } else if (action === 'today') {
        persist(false); _opsDate = today(); rerender();
      } else if (action === 'filter') {
        state.filter = button.dataset.obFilter || 'all'; state.page = 1; rerender();
      } else if (action === 'page') {
        state.page = Math.max(1, Number(button.dataset.obPage || 1)); rerender();
      } else if (action === 'select-all-results') {
        selectItems(currentFilteredItems(), true); rerender();
      } else if (action === 'clear-selection') {
        state.selected = {}; rerender();
      } else if (action === 'bulk-done') {
        bulkDone(true);
      } else if (action === 'bulk-open') {
        bulkDone(false);
      } else if (action === 'flag') {
        toggleFlag(Number(button.dataset.obIndex), button.dataset.obFlag);
      } else if (action === 'checkin') {
        toggleCheckin(Number(button.dataset.obIndex));
      } else if (action === 'cleaner-remove') {
        removeCleanerChip(decoded(button.dataset.obKey), Number(button.dataset.obIdx));
      } else if (action === 'manage-cleaners') {
        if (typeof opsManageCleaners === 'function') opsManageCleaners();
      } else if (action === 'task-add') {
        addTask();
      } else if (action === 'task-delete') {
        event.preventDefault(); deleteTask(button.dataset.obId);
      } else if (action === 'staff-add') {
        addStaffRow(button.dataset.obBlock); rerender();
      } else if (action === 'route-remove') {
        removeRoute(Number(button.dataset.obDriver), Number(button.dataset.obStop)); rerender();
      } else if (action === 'restart') {
        restartCleans();
      } else if (action === 'ops-image') {
        copyBetaImage();
      } else if (action === 'cleaner-image') {
        if (typeof opsCopyCleaningImage === 'function') opsCopyCleaningImage();
      } else if (action === 'schedule-check') {
        var file = document.getElementById('ops-beta-schedule-file'); if (file) file.click();
      }
    });

    root.addEventListener('change', function (event) {
      var input = event.target.closest('[data-ob-action]');
      if (!input || !root.contains(input)) return;
      var action = input.dataset.obAction;
      if (action === 'date') {
        persist(false); _opsDate = input.value || today(); rerender();
      } else if (action === 'sort') {
        state.sort = input.value || 'status'; state.page = 1; rerender();
      } else if (action === 'page-size') {
        state.pageSize = Number(input.value);
        if (!isFinite(state.pageSize) || state.pageSize < 0) state.pageSize = 0;
        state.page = 1;
        rerender();
      } else if (action === 'select') {
        var selectId = decoded(input.dataset.obId);
        if (input.checked) state.selected[selectId] = true;
        else delete state.selected[selectId];
        rerender();
      } else if (action === 'select-page') {
        selectItems(currentPageItems(), !!input.checked); rerender();
      } else if (action === 'bulk-cleaner') {
        bulkCleaner(input.value);
      } else if (action === 'bulk-task') {
        bulkTask(input.value);
      } else if (action === 'clean') {
        var clean = findClean(decoded(input.dataset.obKey));
        if (clean) {
          clean.cleanDone = !!input.checked;
          persist(true);
          if (typeof _opsMaybeAdvanceAfterCleans === 'function') _opsMaybeAdvanceAfterCleans();
          rerender();
        }
      } else if (action === 'row-check') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, !!input.checked); persist(true);
      } else if (action === 'row-field') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, input.value);
        if (input.dataset.obField === 'people') rerender();
      } else if (action === 'comment') {
        updateComment(Number(input.dataset.obIndex), decoded(input.dataset.obKey), input.value);
      } else if (action === 'clean-field') {
        updateCleanField(decoded(input.dataset.obKey), input.dataset.obField, input.value);
        if (input.tagName === 'SELECT') rerender();
      } else if (action === 'cleaner-add') {
        addCleanerChip(decoded(input.dataset.obKey), input.value);
        input.value = '';
      } else if (action === 'task-toggle') {
        toggleTask(input.dataset.obId, input.checked);
      } else if (action === 'staff') {
        setStaff(input.dataset.obBlock, Number(input.dataset.obIndex), input.value); rerender();
      } else if (action === 'leave-days') {
        setLeaveDays(Number(input.dataset.obIndex), input.value); rerender();
      } else if (action === 'route-add') {
        addRoute(Number(input.dataset.obDriver), input.value); rerender();
      } else if (action === 'schedule-file') {
        if (input.files && input.files[0] && typeof opsScheduleCheck === 'function') opsScheduleCheck(input.files[0]);
        input.value = '';
      }
    });

    root.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      var input = event.target.closest('[data-ob-action="cleaner-add"]');
      if (!input || !root.contains(input)) return;
      event.preventDefault();
      addCleanerChip(decoded(input.dataset.obKey), input.value);
      input.value = '';
    });

    root.addEventListener('input', function (event) {
      var input = event.target.closest('[data-ob-action]');
      if (!input || !root.contains(input)) return;
      var action = input.dataset.obAction;
      if (action === 'search') {
        state.search = input.value || '';
        state.page = 1;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () {
          render();
          var search = root.querySelector('[data-ob-action="search"]');
          if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
        }, 140);
      } else if (action === 'row-field') {
        updateRowField(Number(input.dataset.obIndex), input.dataset.obField, input.value);
      } else if (action === 'comment') {
        updateComment(Number(input.dataset.obIndex), decoded(input.dataset.obKey), input.value);
      } else if (action === 'clean-field' && input.tagName !== 'SELECT') {
        updateCleanField(decoded(input.dataset.obKey), input.dataset.obField, input.value);
      } else if (action === 'notes') {
        _opsNotes = input.value;
        queueSave();
      }
    });

  }

  window.renderOpsBeta = render;
  // Promote Beta UI to the canonical Daily Ops tab.
  window.renderOps = render;
})();
