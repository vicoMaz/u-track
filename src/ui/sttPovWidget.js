// Docked "star tracker POV" panel — opened via the camera-icon button in the
// gantt's STT row label (index.html's #stt-pov-open-btn). NOT wired to clicks on the
// STT track itself: #timeline-gantt's drag-to-pan pointerdown handler
// (TimePlayer.js) calls preventDefault()+setPointerCapture() on every
// pointerdown inside the gantt except a small explicit exemption list, which
// silently swallows plain clicks on anything else in there — the button is
// in that exemption list, a bare track element can't be. Unlike the pass
// polar plot's modal (passAzElModal.js), this one stays open and LIVE-updates as
// store.currentTime advances (play/scrub/pan), showing the tracked
// satellite's star tracker(s) right now — one small circle per physical
// unit (see sttPov.js for the drawing, TimePlayer.js's computeSttGeometry
// for the geometry).
import { store } from '../store.js';
import { MODEL_STAR_TRACKERS, satSunExclDeg, satEarthExclDeg, ST_FOV_HALF_ANGLE_DEG } from '../satStarTracker.js';
import { computeSttGeometry } from './TimePlayer.js';
import { buildSttPovSVG } from './sttPov.js';

// Diagonal-arrows icons for the expand/shrink toggle (see .stt-pov-expand) —
// arrows pointing away from each other (expand) vs. toward each other
// (shrink), same stroke-icon language as InputPanel.js's SVG_EYE etc.
const SVG_EXPAND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="20" y1="4" x2="13" y2="11"/><polyline points="20 11 20 4 13 4"/><line x1="4" y1="20" x2="11" y2="13"/><polyline points="4 13 4 20 11 20"/></svg>`;
const SVG_SHRINK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

let _panelEl = null, _bodyEl = null, _legendEl = null, _expandBtn = null;
let _open = false;
let _expanded = false; // ×1.75 toggle — see .stt-pov-expanded (style.css)

function _ensurePanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.className = 'stt-pov-panel';
  _panelEl.innerHTML = `
    <div class="stt-pov-header">
      <span class="stt-pov-title">STT POV</span>
      <span class="stt-pov-legend"></span>
      <button type="button" class="stt-pov-expand" title="Expand ×1.75">${SVG_EXPAND}</button>
      <button type="button" class="stt-pov-close" title="Close">×</button>
    </div>
    <div class="stt-pov-body"></div>`;
  document.getElementById('timeline-gantt')?.appendChild(_panelEl);
  _bodyEl    = _panelEl.querySelector('.stt-pov-body');
  _legendEl  = _panelEl.querySelector('.stt-pov-legend');
  _expandBtn = _panelEl.querySelector('.stt-pov-expand');
  _panelEl.querySelector('.stt-pov-close').addEventListener('click', closeSttPov);
  _expandBtn.addEventListener('click', () => {
    _expanded = !_expanded;
    _panelEl.classList.toggle('stt-pov-expanded', _expanded);
    _expandBtn.innerHTML = _expanded ? SVG_SHRINK : SVG_EXPAND;
    _expandBtn.title     = _expanded ? 'Shrink to normal size' : 'Expand ×1.75';
  });
}

export function closeSttPov() {
  _open = false;
  _panelEl?.classList.remove('stt-pov-open');
}

export function openSttPov() {
  _ensurePanel();
  _open = true;
  _panelEl.classList.add('stt-pov-open');
  _render();
}

function _render() {
  if (!_open || !_bodyEl) return;
  const sat = store.trackedSat;
  if (!sat?.satrec) {
    _bodyEl.innerHTML = `<div class="stt-pov-empty">No satellite tracked.</div>`;
    if (_legendEl) _legendEl.textContent = '';
    return;
  }
  const cones        = MODEL_STAR_TRACKERS[sat.model] ?? MODEL_STAR_TRACKERS['12U'];
  const sunExclDeg    = satSunExclDeg(sat.noradId);
  const earthExclDeg  = satEarthExclDeg(sat.noradId);
  // .stt-pov-panel's default max-width is sized for two 196px circles side by
  // side (FF's STT1+STT2) — without this, a single-STT satellite's panel is
  // still stretched that wide by the header's legend text alone, leaving one
  // circle looking small in a lot of empty space. This narrows the cap to fit
  // just the one circle, so the legend truncates (it already can, via its
  // existing ellipsis overflow) instead of forcing the whole panel wide.
  _panelEl.classList.toggle('stt-pov-single', cones.length === 1);
  // Same exact per-satellite values the rings inside each circle are drawn
  // at (see sttPov.js) — spelled out once here instead of per-circle, since
  // both cones of a given satellite always share the same Sun/Earth
  // exclusion settings (only the FOV constant is fixed across satellites).
  if (_legendEl) {
    _legendEl.textContent = `${ST_FOV_HALF_ANGLE_DEG}° Usable FOV · ${earthExclDeg}° Earth exclusion · ${sunExclDeg}° Sun exclusion`;
  }
  _bodyEl.innerHTML = cones.map((cfg, i) => {
    const geom  = computeSttGeometry(sat, store.currentTime, cfg, sunExclDeg, earthExclDeg);
    const label = cones.length > 1 ? `STT${i + 1}` : 'STT';
    return buildSttPovSVG(geom, label);
  }).join('');
}

export function initSttPovWidget() {
  document.getElementById('stt-pov-open-btn')?.addEventListener('click', openSttPov);
  store.subscribe((key) => {
    if (_open && (key === 'currentTime' || key === 'trackedSatId' || key === 'satellites' || key === 'realAttitude' || key === 'playbackSpeed')) _render();
  });
}
