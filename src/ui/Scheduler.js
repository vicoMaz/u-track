import { store }              from '../store.js';
import { satSubsystemOrigin } from '../satSubsystems.js';

// ── State ────────────────────────────────────────────────────────

let _satId          = null;
let _db             = [];
let _dbLoading      = false;
let _selectedPasses = new Set();
let _procedures     = [];         // [{def, values:{paramName→string}}]
let _searchQuery    = '';
let _dropdownOpen   = false;
let _dragSrcIdx     = null;

// ── Helpers ──────────────────────────────────────────────────────

const _shortName = proc => proc.procedureName.split('.').pop();

function _fmtTime(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function _fmtDuration(ms) { return `${Math.round(ms / 60000)} min`; }

function _futurePasses() {
  if (!_satId) return [];
  return (store.satPasses[_satId] ?? []).filter(p => p.future);
}

function _sat() { return store.satellites.find(s => s.id === _satId) ?? null; }

// ── Fetch procedure database ──────────────────────────────────────

async function _loadDb() {
  const sat = _sat();
  if (!sat) { _db = []; _renderSearch(); return; }
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) { _db = []; _renderSearch(); return; }

  _dbLoading = true;
  _renderSearch();
  try {
    const res = await fetch(`${origin}/api/v1/procedure`, { signal: AbortSignal.timeout(15_000) });
    _db = res.ok ? await res.json() : [];
  } catch { _db = []; }
  _dbLoading = false;
  _renderSearch();
}

// ── Parameter input renderer ──────────────────────────────────────

function _paramInput(param, value, uid) {
  const a = `class="sc-pv-inp" data-uid="${uid}"`;
  switch (param.valueType) {
    case 'Boolean':
      return `<select ${a}>
        <option value="">—</option>
        <option ${value === 'true'  ? 'selected' : ''}>true</option>
        <option ${value === 'false' ? 'selected' : ''}>false</option>
      </select>`;
    case 'Enum':
      return `<select ${a}>
        <option value="">—</option>
        ${(param.enumValues ?? []).map(v =>
          `<option ${value === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>`;
    case 'AbsoluteTime': {
      // value is either a datetime-local string or "@AOS0+30" / "@LOS0-60"
      const rel = /^@(AOS0|LOS0)([+-]\d+)$/.exec(value ?? '');
      const isRel  = !!rel;
      const relPt  = rel?.[1] ?? 'AOS0';
      const relOff = rel ? parseInt(rel[2], 10) : 0;
      const absVal = isRel ? '' : (value ?? '');
      const badge  = isRel ? `${relPt} ${relOff >= 0 ? '+' : ''}${relOff} s` : '';
      return `<div class="sc-dt-wrap" data-uid="${uid}">
        <div class="sc-dt-abs-row"${isRel ? ' style="display:none"' : ''}>
          <input type="datetime-local" ${a} value="${absVal}" step="1" />
          <button class="sc-dt-btn" type="button" tabindex="-1" title="Open calendar">📅</button>
        </div>
        <div class="sc-dt-rel-row"${isRel ? '' : ' style="display:none"'}>
          <span class="sc-dt-rel-badge">${badge}</span>
          <button class="sc-dt-rel-clear" type="button" tabindex="-1" title="Switch to fixed time">×</button>
        </div>
        <div class="sc-dt-pills">
          <button class="sc-dt-q" type="button" data-point="AOS0" tabindex="-1">AOS0</button>
          <button class="sc-dt-q" type="button" data-point="LOS0" tabindex="-1">LOS0</button>
          <span class="sc-dt-off-wrap">
            <span class="sc-dt-off-lbl">±</span>
            <input class="sc-dt-off" type="number" value="${relOff}" step="1" tabindex="-1" title="Offset in seconds" />
            <span class="sc-dt-off-lbl">s</span>
          </span>
        </div>
      </div>`;
    }
    case 'Long': case 'Integer': case 'Short': case 'Byte':
    case 'Double': case 'Float': case 'Amount':
      return `<input type="number" ${a} value="${value ?? ''}" />`;
    case 'List': case 'ArgumentView':
      return `<textarea class="sc-pv-inp sc-pv-area" data-uid="${uid}" placeholder="JSON array">${value ?? ''}</textarea>`;
    default:
      return `<input type="text" ${a} value="${value ?? ''}" />`;
  }
}

// ── Procedure list ────────────────────────────────────────────────

const SCHED_PARAMS = new Set(['doSchedule', 'scheduleTime', 'subscheduleId', 'use_cop1', 'list_tc_cop1']);

function _renderProcList() {
  const el = document.getElementById('sc-proc-list');
  if (!el) return;
  if (!_procedures.length) {
    el.innerHTML = '<div class="sc-empty">Search and add procedures above.</div>';
    return;
  }

  el.innerHTML = _procedures.map((item, pi) => {
    const name         = _shortName(item.def);
    const headerParams = item.def.procedureParameters.filter(p => SCHED_PARAMS.has(p.name) && p.name !== 'list_tc_cop1');
    const missionParams= item.def.procedureParameters.filter(p => !SCHED_PARAMS.has(p.name));

    const renderParams = params => params.map(p => `
      <div class="sc-param-row2">
        <label class="sc-pv-lbl" title="${p.valueType}">${p.name}</label>
        <span class="sc-pv-type">${p.valueType}</span>
        ${_paramInput(p, item.values[p.name], `${pi}-${p.name}`)}
      </div>`).join('');

    return `<div class="sc-proc-item" data-pi="${pi}" draggable="true">
      <div class="sc-proc-item-hdr">
        <span class="sc-drag-handle" title="Drag to reorder">⠿</span>
        <span class="sc-proc-name" title="${item.def.procedureName}">${name}</span>
        <span class="sc-proc-num">${pi + 1}</span>
        <button class="sc-proc-del" data-pi="${pi}" title="Remove">✕</button>
      </div>
      ${headerParams.length  ? `<div class="sc-params-group sc-params-sched">${renderParams(headerParams)}</div>`  : ''}
      ${missionParams.length ? `<div class="sc-params-group">${renderParams(missionParams)}</div>` : ''}
    </div>`;
  }).join('');

  // Wire value inputs (non-AbsoluteTime — those are handled by .sc-dt-wrap below)
  el.querySelectorAll('.sc-pv-inp').forEach(inp => {
    if (inp.closest('.sc-dt-wrap')) return; // AbsoluteTime handled separately
    const update = () => {
      const [pi, ...rest] = (inp.dataset.uid ?? '').split('-');
      const paramName = rest.join('-');
      if (_procedures[+pi]) _procedures[+pi].values[paramName] = inp.value;
    };
    inp.addEventListener('change', update);
    inp.addEventListener('input',  update);
  });

  // Wire AbsoluteTime datetime wrap: calendar, AOS0/LOS0 pills, clear
  el.querySelectorAll('.sc-dt-wrap').forEach(wrap => {
    const uid     = wrap.dataset.uid;
    const absRow  = wrap.querySelector('.sc-dt-abs-row');
    const relRow  = wrap.querySelector('.sc-dt-rel-row');
    const dtInp   = wrap.querySelector('.sc-pv-inp');
    const badge   = wrap.querySelector('.sc-dt-rel-badge');
    const offInp  = wrap.querySelector('.sc-dt-off');

    function _storeVal(val) {
      const [pi, ...rest] = (uid ?? '').split('-');
      const paramName = rest.join('-');
      if (_procedures[+pi]) _procedures[+pi].values[paramName] = val;
    }

    function _applyRel(point) {
      const off = parseInt(offInp?.value ?? '0', 10) || 0;
      const sign = off >= 0 ? '+' : '';
      badge.textContent = `${point} ${sign}${off} s`;
      absRow.style.display = 'none';
      relRow.style.display = '';
      _storeVal(`@${point}${sign}${off}`);
    }

    // 📅 calendar button
    wrap.querySelector('.sc-dt-btn')?.addEventListener('click', () => {
      try { dtInp?.showPicker?.(); } catch { dtInp?.focus(); }
    });

    // AOS0 / LOS0 pills → switch to relative mode
    wrap.querySelectorAll('.sc-dt-q').forEach(btn => {
      btn.addEventListener('click', () => _applyRel(btn.dataset.point));
    });

    // ± offset change → update relative value if already in relative mode
    offInp?.addEventListener('change', () => {
      if (relRow.style.display !== 'none') {
        const m = badge.textContent.match(/^(AOS0|LOS0)/);
        if (m) _applyRel(m[1]);
      }
    });

    // × clear → back to absolute mode
    wrap.querySelector('.sc-dt-rel-clear')?.addEventListener('click', () => {
      absRow.style.display = '';
      relRow.style.display = 'none';
      dtInp.value = '';
      _storeVal('');
    });

    // Absolute datetime input change
    dtInp?.addEventListener('change', () => _storeVal(dtInp.value));
    dtInp?.addEventListener('input',  () => _storeVal(dtInp.value));
  });

  // Wire delete buttons
  el.querySelectorAll('.sc-proc-del').forEach(btn => {
    btn.addEventListener('click', () => {
      _procedures.splice(parseInt(btn.dataset.pi, 10), 1);
      _renderProcList();
    });
  });

  // Wire drag-and-drop reorder
  el.querySelectorAll('.sc-proc-item').forEach(item => {
    const pi = parseInt(item.dataset.pi, 10);

    item.addEventListener('dragstart', e => {
      _dragSrcIdx = pi;
      item.classList.add('sc-drag-src');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      _dragSrcIdx = null;
      el.querySelectorAll('.sc-proc-item').forEach(i =>
        i.classList.remove('sc-drag-src', 'sc-drag-over'));
    });

    item.addEventListener('dragover', e => {
      if (_dragSrcIdx === null || _dragSrcIdx === pi) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.querySelectorAll('.sc-proc-item').forEach(i => i.classList.remove('sc-drag-over'));
      item.classList.add('sc-drag-over');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('sc-drag-over');
    });

    item.addEventListener('drop', e => {
      e.preventDefault();
      if (_dragSrcIdx === null || _dragSrcIdx === pi) return;
      const [src] = _procedures.splice(_dragSrcIdx, 1);
      const targetIdx = _dragSrcIdx < pi ? pi - 1 : pi;
      _procedures.splice(targetIdx, 0, src);
      _renderProcList();
    });
  });
}

function _addProcedure(def) {
  const defaults = {};
  for (const p of def.procedureParameters) {
    defaults[p.name] = p.value != null ? String(p.value) : '';
  }
  _procedures.push({ def, values: defaults });
  _renderProcList();
}

// ── Search / dropdown ─────────────────────────────────────────────

function _matchScore(proc, q) {
  const s   = _shortName(proc).toLowerCase();
  const qlo = q.toLowerCase();
  if (s === qlo)        return 3;
  if (s.startsWith(qlo)) return 2;
  if (s.includes(qlo))   return 1;
  return 0;
}

function _renderSearch() {
  const inp  = document.getElementById('sc-search-inp');
  const drop = document.getElementById('sc-search-drop');
  const stat = document.getElementById('sc-db-status');
  if (!drop) return;

  if (stat) {
    if (_dbLoading)   stat.textContent = 'Loading…';
    else if (!_db.length) stat.textContent = _sat() ? 'No procedures loaded' : 'Select a satellite';
    else stat.textContent = `${_db.length} procedures`;
  }

  const q = _searchQuery.trim();
  if (!q || !_db.length || !_dropdownOpen) { drop.style.display = 'none'; return; }

  const results = _db
    .map(p => ({ p, s: _matchScore(p, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || _shortName(a.p).localeCompare(_shortName(b.p)))
    .slice(0, 40);

  if (!results.length) { drop.style.display = 'none'; return; }

  drop.style.display = 'block';
  drop.innerHTML = results.map(({ p }) => {
    const short = _shortName(p);
    const safe  = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hi    = short.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
    return `<div class="sc-drop-item" data-name="${p.procedureName}">
      <span class="sc-drop-short">${hi}</span>
      <span class="sc-drop-nparams">${p.procedureParameters.length} params</span>
    </div>`;
  }).join('');

  drop.querySelectorAll('.sc-drop-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      const def = _db.find(p => p.procedureName === item.dataset.name);
      if (def) _addProcedure(def);
      _searchQuery  = '';
      _dropdownOpen = false;
      if (inp) inp.value = '';
      drop.style.display = 'none';
    });
  });
}

// ── Pass list ─────────────────────────────────────────────────────

function _renderPasses() {
  const el = document.getElementById('sc-pass-list');
  if (!el) return;
  const passes = _futurePasses();
  if (!passes.length) {
    el.innerHTML = '<div class="sc-empty">No upcoming passes for this satellite.</div>';
    return;
  }
  el.innerHTML = passes.map((p, i) => {
    const sel = _selectedPasses.has(i);
    const dur = _fmtDuration(new Date(p.end) - new Date(p.start));
    const elv = p.maxEl != null ? `${p.maxEl.toFixed(0)}°` : '—';
    return `<div class="sc-pass-row ${sel ? 'sc-pass-sel' : ''}" data-idx="${i}">
      <span class="sc-pass-check">✓</span>
      <div class="sc-pass-info">
        <span class="sc-pass-time">${_fmtTime(p.start)}</span>
        <span class="sc-pass-meta">${p.station ?? '—'} · ${dur} · max ${elv}</span>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sc-pass-row').forEach(row => {
    row.addEventListener('click', () => {
      const i = parseInt(row.dataset.idx, 10);
      if (_selectedPasses.has(i)) _selectedPasses.delete(i);
      else _selectedPasses.add(i);
      _renderPasses();
      _updateSelCount();
    });
  });
}

function _updateSelCount() {
  const el = document.getElementById('sc-sel-count');
  if (el) el.textContent = _selectedPasses.size
    ? `${_selectedPasses.size} pass${_selectedPasses.size > 1 ? 'es' : ''} selected`
    : 'No passes selected';
}

// ── Satellite selector ────────────────────────────────────────────

function _renderSatSelect() {
  const sel = document.getElementById('sc-sat-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select satellite —</option>' +
    store.satellites.map(s =>
      `<option value="${s.id}" ${s.id === _satId ? 'selected' : ''}>${s.name}</option>`).join('');
}

// ── Init ──────────────────────────────────────────────────────────

export function initScheduler() {
  if (!document.getElementById('sc-sat-select')) return;

  _satId = store.satellites[0]?.id ?? null;
  _renderSatSelect();
  _renderPasses();
  _renderProcList();
  _updateSelCount();
  _renderSearch();

  if (_satId) _loadDb();

  document.getElementById('sc-sat-select')?.addEventListener('change', e => {
    _satId = e.target.value || null;
    _selectedPasses.clear();
    _db = [];
    _renderPasses();
    _updateSelCount();
    _renderSearch();
    if (_satId) _loadDb();
  });

  document.getElementById('sc-select-all')?.addEventListener('click', () => {
    const passes = _futurePasses();
    if (_selectedPasses.size === passes.length) _selectedPasses.clear();
    else passes.forEach((_, i) => _selectedPasses.add(i));
    _renderPasses();
    _updateSelCount();
  });

  const inp  = document.getElementById('sc-search-inp');
  const drop = document.getElementById('sc-search-drop');

  inp?.addEventListener('input', () => {
    _searchQuery  = inp.value;
    _dropdownOpen = true;
    _renderSearch();
  });
  inp?.addEventListener('focus', () => {
    _dropdownOpen = true;
    _renderSearch();
  });
  inp?.addEventListener('blur', () => {
    setTimeout(() => { _dropdownOpen = false; if (drop) drop.style.display = 'none'; }, 150);
  });
  inp?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { _dropdownOpen = false; if (drop) drop.style.display = 'none'; inp.blur(); }
  });

  store.subscribe(key => {
    if (key === 'satellites') _renderSatSelect();
    if (key === 'satPasses')  _renderPasses();
  });
}
