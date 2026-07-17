import { store } from '../store.js';
import { propagate } from '../tle.js';

const strip   = document.getElementById('gantt-sat-info');
const nameEl  = document.getElementById('gsi-name');
const latEl   = document.getElementById('gsi-lat');
const lonEl   = document.getElementById('gsi-lon');
const altEl   = document.getElementById('gsi-alt');
const velEl   = document.getElementById('gsi-vel');
const nextEl  = document.getElementById('gsi-next');

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

function update() {
  const sat = store.trackedSat; // O(1) Map lookup
  if (!sat) { strip.classList.add('hidden'); return; }

  // Use position already computed by SatEntity this tick; fall back to own propagation
  const pos = store.positions[sat.noradId] ?? propagate(sat.satrec, store.currentTime);
  if (!pos) { strip.classList.add('hidden'); return; }

  strip.classList.remove('hidden');
  strip.style.setProperty('--sat-color', sat.color);

  nameEl.textContent  = sat.name;
  latEl.textContent   = `${fmt(pos.lat)}°`;
  lonEl.textContent   = `${fmt(pos.lon)}°`;
  altEl.textContent   = `${pos.alt.toFixed(0)} km`;

  const v = pos.eciVel;
  velEl.textContent = `${Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2).toFixed(2)} km/s`;

  const nowMs = store.currentTime.getTime();
  const next  = _nextPass(sat.id, nowMs);
  nextEl.textContent = next ? `${_fmtCountdown(next.startMs - nowMs)} · ${next.station}` : '—';
}

export function initSatInfo() {
  store.subscribe((key) => {
    if (key === 'currentTime' || key === 'trackedSatId' || key === 'satellites' || key === 'satPasses') update();
  });
  update();
}
