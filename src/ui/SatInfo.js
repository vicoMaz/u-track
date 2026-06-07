import { store } from '../store.js';
import { propagate } from '../tle.js';

const card       = document.getElementById('sat-info');
const nameEl     = document.getElementById('sat-info-name');
const noradEl    = document.getElementById('sat-info-norad');
const latEl      = document.getElementById('sat-info-lat');
const lonEl      = document.getElementById('sat-info-lon');
const altEl      = document.getElementById('sat-info-alt');
const badgeEl    = document.getElementById('sat-time-badge');
const orbitDot   = document.getElementById('orbit-dot');
const orbitText  = document.getElementById('orbit-text');
const attDot     = document.getElementById('att-dot');
const attText    = document.getElementById('att-text');

const LIVE_THRESHOLD_MS = 2 * 60 * 1000;

// dot colours
const DOT_GREEN = '#00ff9d';
const DOT_AMBER = '#ffbe0b';
const DOT_GREY  = '#444';

function timeContext(simTime) {
  const delta = simTime.getTime() - Date.now();
  if (Math.abs(delta) < LIVE_THRESHOLD_MS) return 'live';
  return delta < 0 ? 'past' : 'future';
}

function fmtUTC(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth()+1)}-${d.getUTCFullYear()} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function fmt(n, dec = 2) {
  return n >= 0 ? ` ${n.toFixed(dec)}` : `${n.toFixed(dec)}`;
}

function update() {
  const sat = store.satellites.find(s => s.id === store.trackedSatId);
  if (!sat) { card.classList.add('hidden'); return; }

  const pos = propagate(sat.satrec, store.currentTime);
  if (!pos) { card.classList.add('hidden'); return; }

  card.classList.remove('hidden');
  card.style.setProperty('--sat-color', sat.color);

  nameEl.textContent  = sat.name;
  noradEl.textContent = `#${sat.noradId}`;
  latEl.textContent   = `${fmt(pos.lat)}°`;
  lonEl.textContent   = `${fmt(pos.lon)}°`;
  altEl.textContent   = `${pos.alt.toFixed(0)} km`;

  const ctx = timeContext(store.currentTime);

  // Time badge
  if (ctx === 'live') {
    badgeEl.className   = 'time-badge badge-live';
    badgeEl.textContent = '● LIVE';
  } else if (ctx === 'past') {
    badgeEl.className   = 'time-badge badge-past';
    badgeEl.textContent = '◷ PAST';
  } else {
    badgeEl.className   = 'time-badge badge-future';
    badgeEl.textContent = '◈ FUTURE';
  }

  // Orbit row — source only, no mode
  orbitDot.style.color = DOT_GREEN;
  orbitText.textContent = 'TLE (public)';

  // Attitude row
  const att = store.attitudes[sat.noradId];
  const entries = att?.entries;
  if (entries?.length) {
    const tNow = store.currentTime.getTime();
    const tMin = entries[0].t;
    const tMax = entries[entries.length - 1].t;
    const src  = att.source || 'unknown';

    if (tNow < tMin) {
      attDot.style.color  = DOT_GREY;
      attText.textContent = `Default Sun Pointing — TM starts ${fmtUTC(tMin)}`;
    } else if (tNow > tMax) {
      attDot.style.color  = DOT_GREY;
      attText.textContent = `Default Sun Pointing — TM ended ${fmtUTC(tMax)}`;
    } else {
      attDot.style.color  = ctx === 'live' ? DOT_GREEN : DOT_AMBER;
      attText.textContent = ctx === 'live'
        ? `Interpolated · Live TM (${src})`
        : `Interpolated · TM Replay (${src})`;
    }
  } else {
    attDot.style.color  = DOT_GREY;
    attText.textContent = 'Default Sun Pointing, No Telemetry Available';
  }
}

export function initSatInfo() {
  store.subscribe((key) => {
    if (key === 'currentTime' || key === 'trackedSatId' || key === 'satellites' || key === 'attitudes') update();
  });
  update();
}
