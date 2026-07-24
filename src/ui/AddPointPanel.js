// Slide-in panel for adding a custom lat/lon point tied to a specific
// satellite — opened via the small "+ Point" row under that satellite's
// site list in the sat panel (see InputPanel.js's renderSatList). Reuses
// PassDetailPanel's .pdp-panel slide-in chrome so it looks/behaves the same
// as the existing pass detail panel, just docked with its own form content.
import { store } from '../store.js';
import { closePassDetail } from './PassDetailPanel.js';

let _panelEl = null, _satNameEl = null, _sat = null;

function _ensurePanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.className = 'pdp-panel pt-panel';
  _panelEl.innerHTML = `
    <div class="pdp-header">
      <span class="pdp-title">Add point — <span class="pt-panel-sat"></span></span>
      <button type="button" class="pdp-close" title="Close">×</button>
    </div>
    <div class="pdp-body">
      <div class="pt-add-form">
        <input id="pt-name-input" type="text" placeholder="Name" maxlength="30" autocomplete="off" />
        <div class="pt-coord-row">
          <input id="pt-lat-input" type="number" placeholder="Lat" step="any" min="-90" max="90" />
          <input id="pt-lon-input" type="number" placeholder="Lon" step="any" min="-180" max="180" />
        </div>
        <div class="pt-coord-row">
          <input id="pt-mask-input" type="number" placeholder="Mask ° (optional)" step="any" min="0" max="90"
                 title="Minimum elevation angle — draws the visibility circle on the surface below which the satellite is below this elevation as seen from this point. Leave blank for no circle." />
          <button id="pt-add-btn">Add</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(_panelEl);
  _satNameEl = _panelEl.querySelector('.pt-panel-sat');
  _panelEl.querySelector('.pdp-close').addEventListener('click', closeAddPointPanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAddPointPanel(); });

  _panelEl.querySelector('#pt-add-btn').addEventListener('click', _submit);
  ['pt-name-input', 'pt-lat-input', 'pt-lon-input', 'pt-mask-input'].forEach(id => {
    _panelEl.querySelector(`#${id}`).addEventListener('keydown', e => { if (e.key === 'Enter') _submit(); });
  });
}

function _flash(input) {
  input.style.borderColor = '#ff3860';
  setTimeout(() => (input.style.borderColor = ''), 1500);
}

function _submit() {
  if (!_sat) return;
  const nameInput = _panelEl.querySelector('#pt-name-input');
  const latInput  = _panelEl.querySelector('#pt-lat-input');
  const lonInput  = _panelEl.querySelector('#pt-lon-input');
  const maskInput = _panelEl.querySelector('#pt-mask-input');

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

  store.addCustomPoint(name, lat, lon, mask, _sat.id);
  closeAddPointPanel();
}

export function closeAddPointPanel() {
  _panelEl?.classList.remove('pdp-open');
}

export function openAddPointPanel(sat) {
  _ensurePanel();
  closePassDetail(); // don't stack two slide-ins on top of each other
  _sat = sat;
  _satNameEl.textContent = sat.name;
  _satNameEl.style.color = sat.color;
  _panelEl.querySelector('#pt-name-input').value = '';
  _panelEl.querySelector('#pt-lat-input').value  = '';
  _panelEl.querySelector('#pt-lon-input').value  = '';
  _panelEl.querySelector('#pt-mask-input').value = '';
  _panelEl.classList.add('pdp-open');
  _panelEl.querySelector('#pt-name-input').focus();
}
