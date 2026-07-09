import { store, PALETTE, GS_PALETTE } from '../store.js';
import { parseTLE, propagate } from '../tle.js';
import { persistSatellite, persistStation, deleteServerSatellite, deleteServerStation, updateServerStation } from '../apiPoller.js';
import { satBaseUrl, setSatBaseUrl, satJwt, setSatJwt, pingSatellite, getPingIntervalSec, restartPingPoller } from '../satPing.js';
import { getTmConfig, setTmConfig, fetchSatTelemetry } from '../satTelemetry.js';

// ─── Icons ────────────────────────────────────────────────────────────────

const SVG_EYE     = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_CIRCLE  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`;

// ─── ID-key helpers for change detection ─────────────────────────────────

let _satIdKey = '';
let _gsIdKey  = '';
const _satListKey = () => store.satellites.map(s => s.id).join('\0');
const _gsListKey  = () => store.groundStations.map(g => g.id).join('\0');

// ─── Satellite side-panel list (visibility toggles only) ──────────────────

function renderSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const item = document.createElement('div');
    item.className = 'sat-item' + (sat.id === store.trackedSatId ? ' tracking' : '');
    item.dataset.itemId = sat.id;
    item.style.setProperty('--sat-color', sat.color);
    const hidden = sat.visible === false;
    item.innerHTML = `
      <span class="sat-dot" style="background:${sat.color}"></span>
      <span class="sat-name" data-id="${sat.id}" title="Centre view">${sat.name}</span>
      <button class="vis-btn ${hidden ? 'vis-off' : ''}" data-id="${sat.id}" title="${hidden ? 'Show' : 'Hide'}">${hidden ? SVG_EYE_OFF : SVG_EYE}</button>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('.sat-name').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      store.setTrackedSat(id === store.trackedSatId ? null : id);
    });
  });
  list.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', () => store.toggleSatVisibility(btn.dataset.id));
  });
}

// Patch visibility + tracking state without rebuilding the list
function _patchSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  for (const sat of store.satellites) {
    const item = list.querySelector(`[data-item-id="${sat.id}"]`);
    if (!item) { renderSatList(); return; }
    const hidden = sat.visible === false;
    item.classList.toggle('tracking', sat.id === store.trackedSatId);
    const btn = item.querySelector('.vis-btn');
    if (btn) {
      btn.classList.toggle('vis-off', hidden);
      btn.title     = hidden ? 'Show' : 'Hide';
      btn.innerHTML = hidden ? SVG_EYE_OFF : SVG_EYE;
    }
  }
}

// ─── GS side-panel list (visibility + footprint toggles) ─────────────────

function renderGsList() {
  const list = document.getElementById('gs-list');
  if (!list) return;
  list.innerHTML = '';
  for (const gs of store.groundStations) {
    const item = document.createElement('div');
    item.className = 'gs-item';
    item.dataset.itemId = gs.id;
    item.style.setProperty('--gs-color', gs.color);
    const hidden = gs.visible === false;
    item.innerHTML = `
      <span class="sat-dot" style="background:${gs.color}"></span>
      <span class="gs-name">${gs.name}</span>
      <button class="vis-btn ${hidden ? 'vis-off' : ''}" data-id="${gs.id}" title="${hidden ? 'Show station' : 'Hide station'}">${hidden ? SVG_EYE_OFF : SVG_EYE}</button>
      <button class="fp-btn ${gs.showFootprint ? '' : 'fp-off'}" data-id="${gs.id}" title="${gs.showFootprint ? 'Hide coverage' : 'Show coverage'}">${SVG_CIRCLE}</button>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', () => store.toggleGSVisibility(btn.dataset.id));
  });
  list.querySelectorAll('.fp-btn').forEach(btn => {
    btn.addEventListener('click', () => store.toggleGSFootprint(btn.dataset.id));
  });
}

// Patch visibility + footprint state without rebuilding the list
function _patchGsList() {
  const list = document.getElementById('gs-list');
  if (!list) return;
  for (const gs of store.groundStations) {
    const item = list.querySelector(`[data-item-id="${gs.id}"]`);
    if (!item) { renderGsList(); return; }
    const hidden = gs.visible === false;
    const visBtn = item.querySelector('.vis-btn');
    if (visBtn) {
      visBtn.classList.toggle('vis-off', hidden);
      visBtn.title     = hidden ? 'Show station' : 'Hide station';
      visBtn.innerHTML = hidden ? SVG_EYE_OFF : SVG_EYE;
    }
    const fpBtn = item.querySelector('.fp-btn');
    if (fpBtn) {
      fpBtn.classList.toggle('fp-off', !gs.showFootprint);
      fpBtn.title = gs.showFootprint ? 'Hide coverage' : 'Show coverage';
    }
  }
}

// ─── Settings ping status dots ───────────────────────────────────────────

const _PING_TIPS = { ok: 'Server reachable', pending: 'Pinging…', timeout: 'Timeout', error: 'Unreachable', unconfigured: 'No server IP set' };

function _applySettingsPingDot(el, satId) {
  if (!el) return;
  const ps = store.pingStatus[satId] ?? 'unconfigured';
  el.className = 'st-ping-status st-ping-' + (ps === 'ok' ? 'ok' : ps === 'unconfigured' ? 'none' : 'err');
  el.title = _PING_TIPS[ps] ?? ps;
}

function _updateSettingsPingDots() {
  const list = document.getElementById('st-sat-list');
  if (!list) return;
  for (const sat of store.satellites) {
    const dot = list.querySelector(`.st-ping-status[data-sat-id="${sat.id}"]`);
    _applySettingsPingDot(dot, sat.id);
  }
}

// ─── Settings view: full satellite list ──────────────────────────────────

const TM_FIELDS = [
  { key: 'sysMode',   label: 'SYS mode' },
  { key: 'gncMode',   label: 'GNC mode' },
  { key: 'battery',   label: 'Battery'  },
  { key: 'battSoc',   label: 'SoC [%]', formula: model => model === 'FF'
      ? '−361.07 + 18.55 × V<sub>Batt</sub>'
      : '−361.5 + 27.86 × V<sub>Batt</sub>' },
  { key: 'evtNormal', label: 'Evt Norm' },
  { key: 'evtLow',    label: 'Evt Low'  },
  { key: 'evtMed',    label: 'Evt Med'  },
  { key: 'evtHigh',   label: 'Evt High' },
  { key: 'rw1',       label: 'RW 1'     },
  { key: 'rw2',       label: 'RW 2'     },
  { key: 'rw3',       label: 'RW 3'     },
  { key: 'rw4',       label: 'RW 4'     },
  { key: 'uptime',    label: 'Uptime'   },
];

function renderSettingsSatList() {
  const list = document.getElementById('st-sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const cfg  = getTmConfig(sat.noradId, sat.model);
    const item = document.createElement('div');
    item.className = 'st-item st-sat-item';
    item.style.setProperty('--sat-color', sat.color);
    item.innerHTML = `
      <div class="st-item-row">
        <div class="st-item-info">
          <span class="st-item-name">${sat.name}</span>
          <span class="st-item-meta">#${sat.noradId} · ${sat.model ?? '12U'}</span>
        </div>
        <span class="st-ping-status" data-sat-id="${sat.id}" title=""></span>
        <input class="st-field-baseurl" value="${satBaseUrl(sat.noradId)}" placeholder="Server IP" title="API server IP — e.g. 172.17.206.1">
        <input class="st-field-jwt" type="password" value="${satJwt(sat.noradId)}" placeholder="JWT token (attitude)" title="Bearer token for attitude endpoint — stored in browser localStorage only">
        <button class="st-tm-toggle" title="Configure TM parameter mapping">▸ TM</button>
        <button class="remove-btn" data-id="${sat.id}" data-norad="${sat.noradId}" title="Remove">×</button>
      </div>
      <div class="st-tm-config" hidden>
        <div class="st-tm-grid">
          <span></span>
          <span class="st-tm-col-header">Packet</span>
          <span class="st-tm-col-header">Parameter</span>
          ${TM_FIELDS.map(f => f.formula
            ? `<span class="st-tm-label">${f.label}</span><span class="st-tm-formula">${f.formula(sat.model)}</span>`
            : `<span class="st-tm-label">${f.label}</span>
            <input class="st-tm-field" data-key="${f.key}" data-sub="packet" value="${cfg[f.key].packet}" spellcheck="false">
            <input class="st-tm-field" data-key="${f.key}" data-sub="param"  value="${cfg[f.key].param}"  spellcheck="false">`
          ).join('')}
        </div>
        <button class="st-tm-save">Save</button>
      </div>
    `;

    const ipIn  = item.querySelector('.st-field-baseurl');
    const saveIp = () => {
      setSatBaseUrl(sat.noradId, ipIn.value.trim());
      store.setSatTelemetry(sat.id, null);  // clear stale data while reconnecting
      store.setSatPasses(sat.id, []);
      pingSatellite(sat.id);
    };
    ipIn.addEventListener('blur',    saveIp);
    ipIn.addEventListener('keydown', e => { if (e.key === 'Enter') ipIn.blur(); });

    const jwtIn   = item.querySelector('.st-field-jwt');
    const saveJwt = () => setSatJwt(sat.noradId, jwtIn.value.trim());
    jwtIn.addEventListener('blur',    saveJwt);
    jwtIn.addEventListener('keydown', e => { if (e.key === 'Enter') jwtIn.blur(); });

    const toggle    = item.querySelector('.st-tm-toggle');
    const tmSection = item.querySelector('.st-tm-config');
    toggle.addEventListener('click', () => {
      const open = tmSection.hasAttribute('hidden');
      tmSection.toggleAttribute('hidden', !open);
      toggle.textContent = open ? '▾ TM' : '▸ TM';
      toggle.classList.toggle('open', open);
    });

    const saveBtn = item.querySelector('.st-tm-save');
    saveBtn.addEventListener('click', () => {
      const newCfg = {};
      item.querySelectorAll('.st-tm-field').forEach(inp => {
        const { key, sub } = inp.dataset;
        if (!newCfg[key]) newCfg[key] = { ...cfg[key] };
        newCfg[key][sub] = inp.value.trim() || cfg[key][sub];
      });
      setTmConfig(sat.noradId, newCfg);
      fetchSatTelemetry(sat);
      saveBtn.textContent = 'Saved ✓';
      saveBtn.disabled = true;
      setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 1500);
    });

    list.appendChild(item);
  }
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteServerSatellite(btn.dataset.norad);
      store.removeSatellite(btn.dataset.id);
    });
  });
}

// ─── Settings view: full GS list ─────────────────────────────────────────

let _skipGsSettingsRender = false;

function renderSettingsGsList() {
  const list = document.getElementById('st-gs-list');
  if (!list) return;
  list.innerHTML = '';
  for (const gs of store.groundStations) {
    const item = document.createElement('div');
    item.className = 'st-item st-gs-editable';
    item.style.setProperty('--gs-color', gs.color);
    item.innerHTML = `
      <input class="st-field-name" value="${gs.name}" maxlength="30" title="Name">
      <input class="st-field-lat" type="number" value="${gs.lat}" min="-90" max="90" step="any" title="Latitude">
      <input class="st-field-lon" type="number" value="${gs.lon}" min="-180" max="180" step="any" title="Longitude">
      <button class="remove-btn" title="Remove">×</button>
    `;

    const nameIn = item.querySelector('.st-field-name');
    const latIn  = item.querySelector('.st-field-lat');
    const lonIn  = item.querySelector('.st-field-lon');

    function tryUpdate() {
      const name = nameIn.value.trim() || gs.name;
      const lat  = parseFloat(latIn.value);
      const lon  = parseFloat(lonIn.value);
      if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
      if (name === gs.name && lat === gs.lat && lon === gs.lon) return;
      _skipGsSettingsRender = true;
      store.updateGroundStation(gs.id, { name, lat, lon });
      _skipGsSettingsRender = false;
      updateServerStation(gs.id, name, lat, lon);
    }

    [nameIn, latIn, lonIn].forEach(inp => {
      inp.addEventListener('blur', tryUpdate);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });

    item.querySelector('.remove-btn').addEventListener('click', () => {
      deleteServerStation(gs.id);
      store.removeGroundStation(gs.id);
    });

    list.appendChild(item);
  }
}

// ─── Model toggle ─────────────────────────────────────────────────────────

const modelToggle = document.getElementById('model-toggle');
let selectedModel = '12U';
if (modelToggle) {
  modelToggle.addEventListener('click', () => {
    selectedModel = selectedModel === '12U' ? 'FF' : '12U';
    modelToggle.textContent = selectedModel;
    modelToggle.classList.toggle('ff-active', selectedModel === 'FF');
  });
}

// ─── Add satellite ────────────────────────────────────────────────────────

function nextColor() {
  return PALETTE[store.satellites.length % PALETTE.length];
}

async function finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl }) {
  const nameInput = document.getElementById('name-input');
  const testResult = propagate(satrec, store.currentTime);
  if (!testResult) throw new Error('Cannot propagate — object may have decayed.');

  statusEl.remove();
  const id    = `sat-${Date.now()}`;
  const color = nextColor();
  const name  = nameInput.value.trim() || satId || `SAT-${noradId}`;
  store.addSatellite({ id, noradId, name, color, satrec, model: selectedModel });
  await persistSatellite(name, line1, line2, selectedModel, satId);
  setSatBaseUrl(noradId, ip);
  nameInput.value = '';
}

async function addSatellite() {
  const satIdInput = document.getElementById('sat-id-input');
  const satIpInput = document.getElementById('sat-ip-input');
  const addBtn     = document.getElementById('add-sat-btn');

  const satId = satIdInput.value.trim();
  const ip    = satIpInput.value.trim();
  if (!satId) { _flash(satIdInput, '#ff3860'); return; }
  if (!ip)    { _flash(satIpInput, '#ff3860'); return; }

  addBtn.disabled = true; addBtn.textContent = '…';
  const statusEl = _statusEl(`Fetching TLE for ${satId}…`);
  try {
    const host = ip.replace(/\.\d+$/, '.3');
    const res  = await fetch(`http://${host}:15602/api/v1/data/orbit/best-tle?satellite_id=${encodeURIComponent(satId)}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = body.match(/No satellite with id (.+)/)?.[0]
                  ?? body.match(/Caused by \d+: (.+)/)?.[1]
                  ?? `FDS returned ${res.status}`;
      throw new Error(detail.trim());
    }
    const data = await res.json();
    if (!data.first_line || !data.second_line) throw new Error('No TLE in response');

    const { satrec, noradId, line1, line2 } = parseTLE(`${data.first_line}\n${data.second_line}`);
    if (store.satellites.some(s => s.noradId === noradId)) throw new Error(`Already loaded (NORAD ${noradId})`);

    await finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl });
    satIdInput.value = '';
    satIpInput.value = '';
  } catch (err) {
    statusEl.className = 'sat-error';
    statusEl.textContent = 'Error: ' + err.message;
    setTimeout(() => statusEl.remove(), 4000);
  } finally { addBtn.disabled = false; addBtn.textContent = 'Add'; }
}

function _statusEl(text) {
  const el = document.createElement('div');
  el.className = 'sat-loading';
  el.textContent = text;
  document.getElementById('st-sat-list')?.prepend(el);
  return el;
}

function _flash(input, color) {
  input.style.borderColor = color;
  setTimeout(() => (input.style.borderColor = ''), 1500);
}

// ─── Add ground station ───────────────────────────────────────────────────

async function addGroundStation() {
  const nameInput = document.getElementById('gs-name-input');
  const latInput  = document.getElementById('gs-lat-input');
  const lonInput  = document.getElementById('gs-lon-input');
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    _flash(latInput, '#ff3860'); _flash(lonInput, '#ff3860');
    return;
  }
  const localId = `gs-${Date.now()}`;
  const color   = GS_PALETTE[store.groundStations.length % GS_PALETTE.length];
  const name    = nameInput.value.trim() || `GS-${localId}`;
  store.addGroundStation({ id: localId, name, lat, lon, color });
  persistStation(name, '', lat, lon, localId).then(serverId => {
    if (serverId !== localId) {
      const gs = store.groundStations.find(g => g.id === localId);
      if (gs) { gs.id = serverId; store.notify('groundStations'); }
    }
  });
  nameInput.value = ''; latInput.value = ''; lonInput.value = '';
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initInputPanel() {
  document.getElementById('add-sat-btn')?.addEventListener('click', addSatellite);
  document.getElementById('sat-ip-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') addSatellite(); });

  document.getElementById('add-gs-btn')?.addEventListener('click', addGroundStation);
  document.getElementById('gs-lon-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addGroundStation();
  });

  document.getElementById('gs-import-btn')?.addEventListener('click', () => {
    document.getElementById('gs-import-file')?.click();
  });
  document.getElementById('gs-import-file')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const data = JSON.parse(evt.target.result);
        if (!Array.isArray(data)) throw new Error('Expected an array');
        for (const entry of data) {
          const lat = parseFloat(entry.lat);
          const lon = parseFloat(entry.lon);
          if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
          const id    = `gs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const color = GS_PALETTE[store.groundStations.length % GS_PALETTE.length];
          const name  = String(entry.name || entry.shortName || '').trim() || `GS-${id}`;
          store.addGroundStation({ id, name, lat, lon, color });
          persistStation(name, '', lat, lon, id).then(serverId => {
            if (serverId !== id) {
              const gs = store.groundStations.find(g => g.id === id);
              if (gs) { gs.id = serverId; store.notify('groundStations'); }
            }
          });
        }
      } catch { /* invalid JSON — silent */ }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('sat-toggle')?.addEventListener('click', () => {
    document.getElementById('sat-panel').classList.toggle('collapsed');
  });
  document.getElementById('gs-toggle')?.addEventListener('click', () => {
    document.getElementById('gs-panel').classList.toggle('collapsed');
  });

  const satVisAllBtn = document.getElementById('sat-vis-all-btn');
  satVisAllBtn?.addEventListener('click', () => {
    const allOn = store.satellites.every(s => s.visible !== false);
    for (const s of store.satellites) s.visible = !allOn;
    store.notify('satellites');
  });

  const gsVisAllBtn  = document.getElementById('gs-vis-all-btn');
  gsVisAllBtn?.addEventListener('click', () => {
    const allOn = store.groundStations.every(g => g.visible !== false);
    for (const gs of store.groundStations) gs.visible = !allOn;
    store.notify('groundStations');
  });

  const allFpBtn = document.getElementById('gs-footprint-all-btn');
  allFpBtn?.addEventListener('click', () => {
    const allOn = store.groundStations.every(g => g.showFootprint);
    for (const gs of store.groundStations) gs.showFootprint = !allOn;
    store.notify('groundStations');
  });

  store.subscribe((key) => {
    if (key === 'pingStatus') {
      _updateSettingsPingDots();
    }
    if (key === 'satellites' || key === 'trackedSatId') {
      const newKey     = _satListKey();
      const idsChanged = newKey !== _satIdKey;
      _satIdKey = newKey;
      if (idsChanged) {
        renderSatList();
        renderSettingsSatList();
        _updateSettingsPingDots();
      } else {
        _patchSatList();
      }
      const allSatVis = store.satellites.length > 0 && store.satellites.every(s => s.visible !== false);
      satVisAllBtn?.classList.toggle('active', allSatVis);
    }
    if (key === 'groundStations') {
      const newKey     = _gsListKey();
      const idsChanged = newKey !== _gsIdKey;
      _gsIdKey = newKey;
      if (idsChanged) {
        renderGsList();
        if (!_skipGsSettingsRender) renderSettingsGsList();
      } else {
        _patchGsList();
        // Settings GS list only needs rebuild on add/remove, not vis/fp changes
      }
      const allGsVis = store.groundStations.length > 0 && store.groundStations.every(g => g.visible !== false);
      const allFp    = store.groundStations.length > 0 && store.groundStations.every(g => g.showFootprint);
      gsVisAllBtn?.classList.toggle('active', allGsVis);
      allFpBtn?.classList.toggle('active', allFp);
    }
  });

  // Ping interval setting
  const pingIntervalInput = document.getElementById('ping-interval-input');
  if (pingIntervalInput) {
    pingIntervalInput.value = getPingIntervalSec();
    const savePingInterval = () => {
      const v = Math.max(5, Math.min(300, parseInt(pingIntervalInput.value, 10) || 20));
      pingIntervalInput.value = v;
      localStorage.setItem('ping-interval', String(v));
      restartPingPoller();
    };
    pingIntervalInput.addEventListener('change', savePingInterval);
    pingIntervalInput.addEventListener('keydown', e => { if (e.key === 'Enter') pingIntervalInput.blur(); });
  }

  renderSatList();
  renderGsList();
  renderSettingsSatList();
  renderSettingsGsList();
  _satIdKey = _satListKey();
  _gsIdKey  = _gsListKey();
}
