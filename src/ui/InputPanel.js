import { store, PALETTE, GS_PALETTE } from '../store.js';
import { fetchTLE, parseTLE, propagate } from '../tle.js';
import { persistSatellite, persistStation, deleteServerSatellite, deleteServerStation } from '../apiPoller.js';

// ─── Eye icons ────────────────────────────────────────────────────────────

const SVG_EYE = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

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
      <button class="vis-btn ${hidden ? 'vis-off' : ''}" data-id="${gs.id}" title="${hidden ? 'Show' : 'Hide'}">${hidden ? SVG_EYE_OFF : SVG_EYE}</button>
      <label class="footprint-toggle" title="Show footprint">
        <input type="checkbox" class="fp-cb" data-id="${gs.id}" ${gs.showFootprint ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', () => store.toggleGSVisibility(btn.dataset.id));
  });
  list.querySelectorAll('.fp-cb').forEach(cb => {
    cb.addEventListener('change', () => store.toggleGSFootprint(cb.dataset.id));
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

function renderSettingsGsList() {
  const list = document.getElementById('st-gs-list');
  if (!list) return;
  list.innerHTML = '';
  for (const gs of store.groundStations) {
    const item = document.createElement('div');
    item.className = 'st-item';
    item.style.setProperty('--gs-color', gs.color);
    item.innerHTML = `
      <span class="st-color-dot" style="background:${gs.color}"></span>
      <span class="st-item-name">${gs.name}</span>
      <span class="st-item-meta">${gs.lat.toFixed(2)}°, ${gs.lon.toFixed(2)}°</span>
      <button class="remove-btn" data-id="${gs.id}" title="Remove">×</button>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteServerStation(btn.dataset.id);
      store.removeGroundStation(btn.dataset.id);
    });
  });
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
      renderSettingsGsList();
      const allOn = store.groundStations.length > 0 && store.groundStations.every(g => g.showFootprint);
      allBtn?.classList.toggle('active', allOn);
    }
  });

  renderSatList();
  renderGsList();
  renderSettingsSatList();
  renderSettingsGsList();
}
