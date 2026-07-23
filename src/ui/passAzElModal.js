// Standalone popup showing a pass's azimuth/elevation trajectory as a
// Cartesian plot — opened by the polar plot's "⤢ Cartesian" button (see
// passPolar.js's buildAzElSVG). Deliberately simple: no linked cursor / Eb/N0
// pairing like the polar plot itself has (passCursor.js) — just a one-shot
// alternate read of the same pass geometry. One singleton overlay, shared by
// every polar plot in the app (PassDetailPanel.js, PassAnalyzer.js).
import { buildAzElSVG } from './passPolar.js';

let _overlay = null, _bodyEl = null, _titleEl = null;

function _ensure() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'avm-overlay';
  _overlay.innerHTML = `
    <div class="avm-backdrop"></div>
    <div class="avm-card">
      <div class="avm-header">
        <span class="avm-title"></span>
        <button type="button" class="avm-close" title="Close">×</button>
      </div>
      <div class="avm-body"></div>
    </div>`;
  document.body.appendChild(_overlay);
  _bodyEl  = _overlay.querySelector('.avm-body');
  _titleEl = _overlay.querySelector('.avm-title');
  _overlay.querySelector('.avm-close').addEventListener('click', closeAzElModal);
  _overlay.querySelector('.avm-backdrop').addEventListener('click', closeAzElModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _overlay.classList.contains('avm-open-state')) closeAzElModal();
  });
}

export function closeAzElModal() {
  _overlay?.classList.remove('avm-open-state');
}

export function openAzElModal(pass, sat, lat, lon, rxMask) {
  _ensure();
  _titleEl.textContent = `${sat?.name ?? '—'} · ${pass.station ?? '—'} · Azimuth / Elevation`;
  const svg = buildAzElSVG(pass, sat, lat, lon, rxMask);
  _bodyEl.innerHTML = svg || `<div class="co-tt-note">Not enough geometry to plot this pass.</div>`;
  _overlay.classList.add('avm-open-state');
}
