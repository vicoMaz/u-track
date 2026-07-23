import { store } from '../store.js';

// ─── Custom Points side-panel — add/remove arbitrary lat/lon markers ──────
// Rendered on the globe and 2D map via store.groundStations (see
// store.js's _rebuildGroundStations, which folds store.customPoints in
// alongside the antenna-derived ground stations).

function renderPointsList() {
  const list = document.getElementById('pt-list');
  if (!list) return;
  list.innerHTML = '';
  for (const p of store.customPoints) {
    const item = document.createElement('div');
    item.className = 'pt-item';
    item.innerHTML = `
      <div class="pt-item-row">
        <span class="pt-dot"></span>
        <span class="pt-name" title="${p.name}">${p.name}</span>
        <button class="remove-btn" data-id="${p.id}" title="Remove">×</button>
      </div>
      <div class="pt-coords">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}${p.mask != null ? ` · ${p.mask}° mask` : ''}</div>
    `;
    item.querySelector('.remove-btn').addEventListener('click', () => store.removeCustomPoint(p.id));
    list.appendChild(item);
  }
}

function _flash(input) {
  input.style.borderColor = '#ff3860';
  setTimeout(() => (input.style.borderColor = ''), 1500);
}

function addPoint() {
  const nameInput = document.getElementById('pt-name-input');
  const latInput  = document.getElementById('pt-lat-input');
  const lonInput  = document.getElementById('pt-lon-input');
  const maskInput = document.getElementById('pt-mask-input');

  const name = nameInput.value.trim();
  const lat  = parseFloat(latInput.value);
  const lon  = parseFloat(lonInput.value);

  if (!name)                                            { _flash(nameInput); return; }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)    { _flash(latInput);  return; }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180)  { _flash(lonInput);  return; }

  let mask = null;
  if (maskInput.value.trim() !== '') {
    mask = parseFloat(maskInput.value);
    if (!Number.isFinite(mask) || mask < 0 || mask > 90) { _flash(maskInput); return; }
  }

  store.addCustomPoint(name, lat, lon, mask);
  nameInput.value = '';
  latInput.value  = '';
  lonInput.value  = '';
  maskInput.value = '';
  nameInput.focus();
}

export function initPointsPanel() {
  document.getElementById('pt-add-btn')?.addEventListener('click', addPoint);
  ['pt-name-input', 'pt-lat-input', 'pt-lon-input', 'pt-mask-input'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') addPoint(); });
  });

  document.getElementById('points-toggle')?.addEventListener('click', () => {
    document.getElementById('points-panel').classList.toggle('collapsed');
  });

  store.subscribe((key) => {
    if (key === 'customPoints') renderPointsList();
  });

  renderPointsList();
}
