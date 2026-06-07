import { store, PALETTE, GS_PALETTE } from '../store.js';
import { fetchTLE, propagate } from '../tle.js';
import { persistSatellite, persistStation, deleteServerSatellite, deleteServerStation } from '../apiPoller.js';

function nextColor() {
  return PALETTE[store.satellites.length % PALETTE.length];
}

function renderSatList() {
  const list = document.getElementById('sat-list');
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const item = document.createElement('div');
    item.className = 'sat-item' + (sat.id === store.trackedSatId ? ' tracking' : '');
    item.style.setProperty('--sat-color', sat.color);
    item.innerHTML = `
      <span class="sat-name" data-id="${sat.id}" title="Centre view on this satellite">${sat.name}</span>
      <span class="sat-norad">#${sat.noradId}</span>
      <button class="remove-btn" data-id="${sat.id}" data-norad="${sat.noradId}" title="Remove">×</button>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll('.sat-name').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      store.setTrackedSat(id === store.trackedSatId ? null : id);
    });
  });

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteServerSatellite(btn.dataset.norad);
      store.removeSatellite(btn.dataset.id);
    });
  });
}

async function addSatellite() {
  const noradInput = document.getElementById('norad-input');
  const nameInput = document.getElementById('name-input');
  const addBtn = document.getElementById('add-sat-btn');

  const noradId = noradInput.value.trim();
  if (!noradId) return;
  if (!/^\d{1,9}$/.test(noradId)) {
    noradInput.style.borderColor = '#ff3860';
    setTimeout(() => (noradInput.style.borderColor = ''), 1500);
    return;
  }
  if (store.satellites.some(s => s.noradId === noradId)) {
    noradInput.style.borderColor = '#ffbe0b';
    setTimeout(() => (noradInput.style.borderColor = ''), 1500);
    return;
  }

  addBtn.disabled = true;
  addBtn.textContent = '…';

  const statusEl = document.createElement('div');
  statusEl.className = 'sat-loading';
  statusEl.textContent = `Fetching ${noradId}…`;
  document.getElementById('sat-list').prepend(statusEl);

  try {
    const { satrec, name: tleName, line1, line2 } = await fetchTLE(noradId);

    const testResult = propagate(satrec, store.currentTime);
    if (!testResult) {
      throw new Error(`Cannot propagate NORAD ${noradId} — object may have decayed or re-entered. Try 25544 (ISS).`);
    }

    statusEl.remove();

    const id    = `sat-${Date.now()}`;
    const color = nextColor();
    const name  = nameInput.value.trim() || tleName || `SAT-${noradId}`;

    store.addSatellite({ id, noradId, name, color, satrec, model: '12U' });
    persistSatellite(name, line1, line2);
    noradInput.value = '';
    nameInput.value  = '';
  } catch (err) {
    statusEl.className = 'sat-error';
    statusEl.textContent = `Error: ${err.message}`;
    setTimeout(() => statusEl.remove(), 4000);
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = 'Add';
  }
}

// ─── Ground stations ──────────────────────────────────────────────────────

function renderGsList() {
  const list = document.getElementById('gs-list');
  list.innerHTML = '';
  for (const gs of store.groundStations) {
    const item = document.createElement('div');
    item.className = 'gs-item';
    item.style.setProperty('--gs-color', gs.color);
    item.innerHTML = `
      <span class="gs-name">${gs.name}</span>
      <span class="gs-coords-display">${gs.lat.toFixed(2)}°, ${gs.lon.toFixed(2)}°</span>
      <label class="footprint-toggle" title="Show visibility footprint">
        <input type="checkbox" class="fp-cb" data-id="${gs.id}" ${gs.showFootprint ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
      <button class="remove-btn" data-id="${gs.id}" title="Remove">×</button>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll('.fp-cb').forEach(cb => {
    cb.addEventListener('change', () => store.toggleGSFootprint(cb.dataset.id));
  });
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteServerStation(btn.dataset.id);
      store.removeGroundStation(btn.dataset.id);
    });
  });
}

async function addGroundStation() {
  const nameInput = document.getElementById('gs-name-input');
  const latInput  = document.getElementById('gs-lat-input');
  const lonInput  = document.getElementById('gs-lon-input');

  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    latInput.style.borderColor = '#ff3860';
    lonInput.style.borderColor = '#ff3860';
    setTimeout(() => {
      latInput.style.borderColor = '';
      lonInput.style.borderColor = '';
    }, 1500);
    return;
  }

  const localId   = `gs-${Date.now()}`;
  const color     = GS_PALETTE[store.groundStations.length % GS_PALETTE.length];
  const name      = nameInput.value.trim() || `GS-${localId}`;
  const shortName = '';

  // Add to store immediately with local id; then get the server-assigned id
  store.addGroundStation({ id: localId, name, lat, lon, color });

  persistStation(name, shortName, lat, lon, localId).then(serverId => {
    if (serverId !== localId) {
      // Atomically swap the id so all subscribers (map, list, delete buttons) stay consistent
      const gs = store.groundStations.find(g => g.id === localId);
      if (gs) {
        gs.id = serverId;
        store.notify('groundStations');
      }
    }
  });

  nameInput.value = '';
  latInput.value  = '';
  lonInput.value  = '';
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initInputPanel() {
  document.getElementById('add-sat-btn').addEventListener('click', addSatellite);
  document.getElementById('norad-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSatellite();
  });

  document.getElementById('add-gs-btn').addEventListener('click', addGroundStation);
  document.getElementById('gs-lon-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addGroundStation();
  });

  document.getElementById('sat-toggle').addEventListener('click', () => {
    document.getElementById('sat-panel').classList.toggle('collapsed');
  });

  document.getElementById('gs-toggle').addEventListener('click', () => {
    document.getElementById('gs-panel').classList.toggle('collapsed');
  });

  const allBtn = document.getElementById('gs-footprint-all-btn');
  allBtn.addEventListener('click', () => {
    const allOn = store.groundStations.every(g => g.showFootprint);
    const target = !allOn;
    for (const gs of store.groundStations) gs.showFootprint = target;
    store.notify('groundStations');
  });

  store.subscribe((key) => {
    if (key === 'satellites' || key === 'trackedSatId') renderSatList();
    if (key === 'groundStations') {
      renderGsList();
      const allOn = store.groundStations.length > 0 && store.groundStations.every(g => g.showFootprint);
      allBtn.classList.toggle('active', allOn);
    }
  });

  renderSatList();
  renderGsList();
}
