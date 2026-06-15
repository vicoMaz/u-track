import { store, PALETTE, GS_PALETTE } from '../store.js';
import { fetchTLE, parseTLE, propagate } from '../tle.js';
import { persistSatellite, persistStation, deleteServerSatellite, deleteServerStation, updateServerStation } from '../apiPoller.js';

// ─── Icons ────────────────────────────────────────────────────────────────

const SVG_EYE     = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_CIRCLE  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`;

// ─── Satellite side-panel list (visibility toggles only) ──────────────────

function renderSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const item = document.createElement('div');
    item.className = 'sat-item' + (sat.id === store.trackedSatId ? ' tracking' : '');
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

// ─── GS side-panel list (visibility + footprint toggles) ─────────────────

function renderGsList() {
  const list = document.getElementById('gs-list');
  if (!list) return;
  list.innerHTML = '';
  for (const gs of store.groundStations) {
    const item = document.createElement('div');
    item.className = 'gs-item';
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

// ─── Settings view: full satellite list ──────────────────────────────────

function renderSettingsSatList() {
  const list = document.getElementById('st-sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const item = document.createElement('div');
    item.className = 'st-item';
    item.style.setProperty('--sat-color', sat.color);
    item.innerHTML = `
      <span class="st-color-dot" style="background:${sat.color}"></span>
      <span class="st-item-name">${sat.name}</span>
      <span class="st-item-meta">#${sat.noradId} · ${sat.model ?? '12U'}</span>
      <button class="remove-btn" data-id="${sat.id}" data-norad="${sat.noradId}" title="Remove">×</button>
    `;
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
let pendingTLE = null;
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

async function finaliseSatellite({ satrec, noradId, tleName, line1, line2, statusEl }) {
  const nameInput = document.getElementById('name-input');
  const testResult = propagate(satrec, store.currentTime);
  if (!testResult) throw new Error(`Cannot propagate NORAD ${noradId} — object may have decayed or re-entered.`);

  statusEl.remove();
  const id    = `sat-${Date.now()}`;
  const color = nextColor();
  const name  = nameInput.value.trim() || tleName || `SAT-${noradId}`;
  store.addSatellite({ id, noradId, name, color, satrec, model: selectedModel });
  persistSatellite(name, line1, line2, selectedModel);
  document.getElementById('norad-input').value = '';
  nameInput.value = '';
}

async function addSatellite() {
  const noradInput = document.getElementById('norad-input');
  const addBtn     = document.getElementById('add-sat-btn');

  if (pendingTLE) {
    const tle = pendingTLE; pendingTLE = null;
    noradInput.style.borderColor = '';
    await addSatelliteFromTLE(tle);
    return;
  }

  const raw = noradInput.value.trim();
  if (!raw) return;
  if (!/^\d{1,9}$/.test(raw)) { _flash(noradInput, '#ff3860'); return; }
  if (store.satellites.some(s => s.noradId === raw)) { _flash(noradInput, '#ffbe0b'); return; }

  addBtn.disabled = true; addBtn.textContent = '…';
  const statusEl = _statusEl('Fetching ' + raw + '…');
  try {
    const { satrec, name: tleName, line1, line2 } = await fetchTLE(raw);
    await finaliseSatellite({ satrec, noradId: raw, tleName, line1, line2, statusEl });
  } catch (err) {
    statusEl.className = 'sat-error';
    statusEl.textContent = 'Error: ' + err.message;
    setTimeout(() => statusEl.remove(), 4000);
  } finally { addBtn.disabled = false; addBtn.textContent = 'Add'; }
}

async function addSatelliteFromTLE(parsed) {
  const addBtn = document.getElementById('add-sat-btn');
  document.getElementById('norad-input').value = '';
  addBtn.disabled = true; addBtn.textContent = '…';
  const statusEl = _statusEl('Adding satellite…');
  try {
    const { satrec, name: tleName, noradId, line1, line2 } = parsed;
    if (store.satellites.some(s => s.noradId === noradId)) throw new Error(`NORAD ${noradId} already loaded.`);
    await finaliseSatellite({ satrec, noradId, tleName, line1, line2, statusEl });
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

  const noradInput = document.getElementById('norad-input');
  noradInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addSatellite(); });
  noradInput?.addEventListener('paste', e => {
    const text = e.clipboardData.getData('text');
    if (/^[12] /m.test(text) && text.includes('\n')) {
      e.preventDefault();
      try {
        pendingTLE = parseTLE(text);
        noradInput.value = pendingTLE.noradId;
        noradInput.style.borderColor = '#c77dff';
        const nameInput = document.getElementById('name-input');
        if (!nameInput.value.trim() && pendingTLE.name) nameInput.value = pendingTLE.name;
      } catch {
        pendingTLE = null; _flash(noradInput, '#ff3860');
      }
    }
  });
  noradInput?.addEventListener('input', () => {
    if (pendingTLE) { pendingTLE = null; noradInput.style.borderColor = ''; }
  });

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

  const allBtn = document.getElementById('gs-footprint-all-btn');
  allBtn?.addEventListener('click', () => {
    const allOn = store.groundStations.every(g => g.showFootprint);
    for (const gs of store.groundStations) gs.showFootprint = !allOn;
    store.notify('groundStations');
  });

  store.subscribe((key) => {
    if (key === 'satellites' || key === 'trackedSatId') {
      renderSatList();
      renderSettingsSatList();
    }
    if (key === 'groundStations') {
      renderGsList();
      if (!_skipGsSettingsRender) renderSettingsGsList();
      const allOn = store.groundStations.length > 0 && store.groundStations.every(g => g.showFootprint);
      allBtn?.classList.toggle('active', allOn);
    }
  });

  renderSatList();
  renderGsList();
  renderSettingsSatList();
  renderSettingsGsList();
}
