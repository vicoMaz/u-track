import { store } from '../store.js';
import { propagate } from '../tle.js';
import { satJwt } from '../satPing.js';
import { satAttitudeMode, setSatAttitudeMode, attitudeDisplayState, scheduleAttitudeFetch } from '../satAttitudeReal.js';
import { scheduleTelemetryFetch, telemetryDisplayState } from '../satTelemetryReal.js';
import { positionTooltip } from './passTooltip.js';

const strip        = document.getElementById('gantt-sat-info');
const nameEl        = document.getElementById('gsi-name');
const posEl         = document.getElementById('gsi-pos');
const modeEl        = document.getElementById('gsi-mode');
const gncEl         = document.getElementById('gsi-gnc');
const battEl        = document.getElementById('gsi-batt');
const attEl         = document.getElementById('gsi-attitude');
const attToggleBtn  = document.getElementById('gsi-attitude-toggle');
const nextEl        = document.getElementById('gsi-next');

// Same self-contained "nice" hover tooltip ChadOps.js builds per-caller
// (.co-tooltip + positionTooltip from passTooltip.js) rather than a native
// title attribute — shown on hovering the toggle itself (its cursor:help
// is the "?" affordance, not a separate icon to hover over).
const _attTooltip = document.createElement('div');
_attTooltip.className = 'co-tooltip';
_attTooltip.style.display = 'none';
document.body.appendChild(_attTooltip);
let _attTooltipHideTimer = null;
const _hideAttTooltip     = () => { clearTimeout(_attTooltipHideTimer); _attTooltip.style.display = 'none'; };
const _scheduleAttTooltipHide = () => { clearTimeout(_attTooltipHideTimer); _attTooltipHideTimer = setTimeout(_hideAttTooltip, 800); };
const _cancelAttTooltipHide   = () => clearTimeout(_attTooltipHideTimer);
_attTooltip.addEventListener('mouseenter', _cancelAttTooltipHide);
_attTooltip.addEventListener('mouseleave', _scheduleAttTooltipHide);
document.addEventListener('click', e => {
  if (_attTooltip.style.display !== 'none' && !_attTooltip.contains(e.target)) _hideAttTooltip();
}, true);

function _attHelpHTML(sat, atMs) {
  if (!satJwt(sat.noradId)) {
    return `<div>No MIC token configured for this satellite.</div><div>Add one in Settings to enable real attitude.</div>`;
  }
  const state = attitudeDisplayState(sat, atMs);
  if (state.reason === 'future' || state.reason === 'fast-forward') {
    return `<div>${_CONSTANT_TOOLTIP[state.reason]}</div>`;
  }
  return `<div>Enable to show real attitude from MIC.</div><div>Disable for constant sun pointing.</div>`;
}

// What to show/why, per telemetryDisplayState's `reason`.
const _TM_TOOLTIP = {
  future:          'Future time — telemetry only exists for the past.',
  'fast-forward':  'Playback is too fast for telemetry to keep up — slow to 10x or below.',
  'no-data':       'No telemetry data available for this time yet.',
};

// Mirrors ChadOps.js's _monPillCls 3-tier bucketing (not exported there, so
// duplicated here) — applied as text color instead of a pill badge to fit
// this panel's compact width.
function _monCls(status) {
  if (!status || status === 'NOMINAL') return 'gsi-mon-nominal';
  if (status === 'WATCH' || status === 'WARNING') return 'gsi-mon-warn';
  return 'gsi-mon-crit';
}

// What to show/why, per attitudeDisplayState's `reason` — "make very clear
// what you're using to show the attitude" (real data vs constant, and why).
const _CONSTANT_LABEL = {
  future:          'Sun Pointing',
  'toggle-off':    'Sun Pointing',
  'no-token':      'Sun Pointing',
  'mic-unreachable': 'Sun Pointing',
  'fast-forward':  'Sun Pointing',
  'no-data':       'Sun Pointing',
};
const _CONSTANT_TOOLTIP = {
  future:            'Future time — attitude restitution only exists for the past.',
  'toggle-off':       'Real attitude disabled — click the toggle to enable.',
  'no-token':         "No MIC token configured for this satellite — add one in Settings.",
  'mic-unreachable':  'MIC is unreachable for this satellite right now.',
  'fast-forward':     'Playback is too fast for real attitude to keep up — slow to 10x or below to re-enable.',
  'no-data':          'No attitude data available for this time yet — showing default Sun Pointing.',
};

function fmt(n, dec = 2) {
  return n >= 0 ? ` ${n.toFixed(dec)}` : `${n.toFixed(dec)}`;
}

// Soonest pass with start after the currently displayed (possibly scrubbed)
// simulated time — not pass.future, which is fixed at fetch time against
// real wall-clock time and wouldn't track the scrubber.
function _nextPass(satId, atMs) {
  const passes = store.satPasses[satId];
  if (!passes?.length) return null;
  let best = null;
  for (const p of passes) {
    const startMs = (p.start instanceof Date ? p.start : new Date(p.start)).getTime();
    if (startMs > atMs && (!best || startMs < best.startMs)) best = { startMs, station: p.station };
  }
  return best;
}

function _fmtCountdown(ms) {
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function _updateAttitude(sat, atMs) {
  const state = attitudeDisplayState(sat, atMs);
  if (state.active === 'real') {
    attEl.textContent = 'From telemetry';
    attEl.className   = 'att-real';
    attEl.title       = 'Live attitude restitution from MIC.';
  } else {
    attEl.textContent = _CONSTANT_LABEL[state.reason] ?? 'Sun Pointing';
    attEl.className   = 'att-constant';
    attEl.title       = _CONSTANT_TOOLTIP[state.reason] ?? '';
  }

  const mode = satAttitudeMode(sat.noradId);
  const hasToken = !!satJwt(sat.noradId);
  const overridden = state.reason === 'future' || state.reason === 'fast-forward';
  attToggleBtn.setAttribute('aria-label', mode === 'real' ? 'auto' : 'sunP');
  attToggleBtn.className   = `gsi-att-toggle mode-${mode}`
                           + (hasToken ? '' : ' dim')
                           + (overridden ? ' overridden' : '');
  attToggleBtn.disabled = !hasToken; // nothing to toggle to without a token — explained in the hover tooltip instead
}

// sysMode/gncMode/battSoc, queried AT atMs (the currently displayed sim
// time — see satTelemetryReal.js) so the panel stays coherent with wherever
// TimePlayer is scrubbed to, not always "right now". Gated on playback speed
// exactly like real attitude: too fast for a 30s-bucket fetch to keep up.
function _updateTelemetryFields(sat, atMs) {
  scheduleTelemetryFetch(sat, atMs); // ensure coverage — no-op if already covered/too fast/future
  const state = telemetryDisplayState(sat, atMs);

  if (!state.active) {
    modeEl.textContent = '(-)'; modeEl.className = 'gsi-nil';
    gncEl.textContent  = '(-)'; gncEl.className  = 'gsi-nil';
    battEl.textContent = '(-)'; battEl.className = 'gsi-nil';
    modeEl.title = gncEl.title = battEl.title = _TM_TOOLTIP[state.reason] ?? '';
    return;
  }
  modeEl.title = gncEl.title = battEl.title = '';

  const { sample } = state;
  const sysVal = sample.sysMode?.value ?? null;
  modeEl.textContent = sysVal ?? '—';
  modeEl.className   = sysVal != null ? _monCls(sample.sysMode.status) : 'gsi-nil';

  const gncVal = sample.gncMode?.value ?? null;
  gncEl.textContent = gncVal ?? '—';
  gncEl.className   = gncVal != null ? _monCls(sample.gncMode.status) : 'gsi-nil';

  const battSoc = sample.battSoc?.value ?? null;
  battEl.textContent = battSoc != null ? `${battSoc}%` : '—';
  battEl.className   = battSoc != null ? _monCls(sample.battVoltage?.status) : 'gsi-nil';
}

function update() {
  const sat = store.trackedSat; // O(1) Map lookup
  if (!sat) { strip.classList.add('hidden'); return; }

  // Use position already computed by SatEntity this tick; fall back to own propagation
  const pos = store.positions[sat.noradId] ?? propagate(sat.satrec, store.currentTime);
  if (!pos) { strip.classList.add('hidden'); return; }

  strip.classList.remove('hidden');
  strip.style.setProperty('--sat-color', sat.color);

  nameEl.textContent = sat.name;
  posEl.textContent  = `${fmt(pos.lat)}° ${fmt(pos.lon)}° ${pos.alt.toFixed(0)}km`;

  const nowMs = store.currentTime.getTime();
  _updateTelemetryFields(sat, nowMs);
  _updateAttitude(sat, nowMs);

  const next  = _nextPass(sat.id, nowMs);
  nextEl.textContent = next ? `${_fmtCountdown(next.startMs - nowMs)} · ${next.station}` : '—';
}

export function initSatInfo() {
  store.subscribe((key) => {
    if (key === 'currentTime' || key === 'trackedSatId' || key === 'satellites' || key === 'satPasses' || key === 'realAttitude' || key === 'playbackSpeed' || key === 'satTelemetryReal') update();
  });
  attToggleBtn.addEventListener('click', () => {
    const sat = store.trackedSat;
    if (!sat) return;
    const next = satAttitudeMode(sat.noradId) === 'real' ? 'constant' : 'real';
    setSatAttitudeMode(sat.noradId, next);
    if (next === 'real') scheduleAttitudeFetch(sat.noradId, store.currentTime.getTime()); // don't wait for the next tick
    update();
    store.notify('realAttitude'); // ripples to the globe/STT POV widget
  });
  attToggleBtn.addEventListener('mouseenter', e => {
    const sat = store.trackedSat;
    if (!sat) return;
    _cancelAttTooltipHide();
    _attTooltip.innerHTML = _attHelpHTML(sat, store.currentTime.getTime());
    _attTooltip.style.display = 'block';
    positionTooltip(e, _attTooltip);
  });
  attToggleBtn.addEventListener('mousemove', e => positionTooltip(e, _attTooltip));
  attToggleBtn.addEventListener('mouseleave', _scheduleAttTooltipHide);
  update();
}
