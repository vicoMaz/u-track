import { store } from '../store.js';
import { propagate } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';

const MU  = 398600.4418; // km³/s²
const R_E = 6371;        // km
const DEG = 180 / Math.PI;

export function initOrbitInspector() {
  const select = document.getElementById('oi-sat-select');
  if (!select) return;

  let liveTimer     = null;
  let selectedSatId = null;
  let cachedEclipse = null; // { fraction, eclipseMin, sunMin } — recomputed on sat change only
  let cachedEvents  = [];   // upcoming eclipse transitions — fixed absolute times, refreshed when stale

  function getSelectedSat() {
    return store.satellites.find(s => s.id === selectedSatId) ?? null;
  }

  function renderSelector() {
    const prev = selectedSatId;
    if (store.satellites.length === 0) {
      select.innerHTML = '<option value="">— no satellites loaded —</option>';
      selectedSatId = null;
    } else {
      select.innerHTML = store.satellites.map(s =>
        `<option value="${s.id}">${s.name}</option>`).join('');
      const stillThere = prev && store.satellites.some(s => s.id === prev);
      selectedSatId = stillThere ? prev : store.satellites[0].id;
      select.value = selectedSatId;
    }
    renderContent();
  }

  select.addEventListener('change', () => {
    selectedSatId = select.value || null;
    cachedEclipse = null;
    cachedEvents  = [];
    renderContent();
  });

  function renderContent() {
    const content = document.getElementById('oi-content');
    if (!content) return;
    const sat = getSelectedSat();
    if (!sat?.satrec) {
      content.innerHTML = '<div class="oi-empty">Add a satellite to inspect its orbit.</div>';
      stopLive();
      return;
    }
    const n        = sat.satrec.no;
    const periodMs = (2 * Math.PI / n) * 60000;
    cachedEclipse  = computeEclipseOrbit(sat.satrec, store.currentTime, periodMs);
    cachedEvents   = computeUpcomingEvents(sat.satrec, store.currentTime);
    content.innerHTML = buildHTML(sat, cachedEclipse);
    updateLive(sat);
    startLive(sat);
  }

  function startLive(sat) {
    stopLive();
    liveTimer = setInterval(() => updateLive(sat), 1000);
  }

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function updateLive(sat) {
    const t = store.currentTime;
    const r = propagate(sat.satrec, t);
    if (!r) return;

    const vel   = Math.sqrt(r.eciVel.x**2 + r.eciVel.y**2 + r.eciVel.z**2);
    const inEcl = isInEclipse(r.eciPos, sunDirectionECI(t));

    setText('oi-live-alt', `${r.alt.toFixed(1)} km`);
    setText('oi-live-vel', `${vel.toFixed(3)} km/s`);
    setText('oi-live-lat', `${r.lat >= 0 ? '+' : ''}${r.lat.toFixed(4)}°`);
    setText('oi-live-lon', `${r.lon >= 0 ? '+' : ''}${r.lon.toFixed(4)}°`);

    const eclEl = document.getElementById('oi-live-ecl');
    if (eclEl) {
      eclEl.textContent = inEcl ? '● Shadow' : '☀ Sunlit';
      eclEl.className   = `oi-live-ecl ${inEcl ? 'oi-ecl-shadow' : 'oi-ecl-sun'}`;
    }

    const stateEl = document.getElementById('oi-eclipse-state');
    if (stateEl) {
      stateEl.textContent = inEcl ? '● IN SHADOW' : '☀ IN SUNLIGHT';
      stateEl.className   = `oi-eclipse-state ${inEcl ? 'oi-state-shadow' : 'oi-state-sun'}`;
    }

    // Drop past events; recompute only when the cache runs dry
    cachedEvents = cachedEvents.filter(ev => ev.t > t);
    if (cachedEvents.length < 2) cachedEvents = computeUpcomingEvents(sat.satrec, t);

    const eventsEl = document.getElementById('oi-events-list');
    if (eventsEl) eventsEl.innerHTML = renderEvents(cachedEvents, t);
  }

  store.subscribe(key => {
    if (key === 'satellites') renderSelector();
  });

  renderSelector();
}

// ── HTML builder ──────────────────────────────────────────────────

function buildHTML(sat, eclipse) {
  const sr = sat.satrec;
  const n           = sr.no;
  const periodMin   = (2 * Math.PI / n);
  const periodMs    = periodMin * 60000;
  const a           = Math.cbrt(MU * ((periodMin * 60) / (2 * Math.PI)) ** 2);
  const e           = sr.ecco;
  const i           = sr.inclo * DEG;
  const raan        = ((sr.nodeo  * DEG) % 360 + 360) % 360;
  const omega       = ((sr.argpo  * DEG) % 360 + 360) % 360;
  const M           = ((sr.mo     * DEG) % 360 + 360) % 360;
  const revPerDay   = n * 1440 / (2 * Math.PI);
  const perigee     = a * (1 - e) - R_E;
  const apogee      = a * (1 + e) - R_E;

  const epochDate   = epochToDate(sr.epochyr, sr.epochdays);
  const ageDays     = (Date.now() - epochDate.getTime()) / 86400000;
  const ageCls      = ageDays > 7 ? 'oi-stale-bad' : ageDays > 3 ? 'oi-stale-warn' : 'oi-stale-ok';
  const ageLabel    = ageDays > 7 ? '⚠ Stale' : ageDays > 3 ? '⚠ Old' : '✓ Fresh';

  const orbitType   = classifyOrbit(i, a);

  const { fraction, eclipseMin, sunMin } = eclipse;
  const eclPct = (fraction * 100).toFixed(1);
  const sunPct = ((1 - fraction) * 100).toFixed(1);

  return `
    <div class="oi-grid">

      <div class="oi-card">
        <div class="oi-card-title">Keplerian Elements</div>
        <table class="oi-table">
          <tr><td>Semi-major axis</td>  <td class="oi-val">${a.toFixed(2)} km</td></tr>
          <tr><td>Eccentricity</td>     <td class="oi-val">${e.toFixed(7)}</td></tr>
          <tr><td>Inclination</td>      <td class="oi-val">${i.toFixed(4)}°</td></tr>
          <tr><td>RAAN (Ω)</td>         <td class="oi-val">${raan.toFixed(4)}°</td></tr>
          <tr><td>Arg. perigee (ω)</td> <td class="oi-val">${omega.toFixed(4)}°</td></tr>
          <tr><td>Mean anomaly (M)</td> <td class="oi-val">${M.toFixed(4)}°</td></tr>
          <tr><td>Period</td>           <td class="oi-val">${periodMin.toFixed(2)} min</td></tr>
          <tr><td>Mean motion</td>      <td class="oi-val">${revPerDay.toFixed(8)} rev/day</td></tr>
          <tr><td>Perigee alt.</td>     <td class="oi-val">${perigee.toFixed(1)} km</td></tr>
          <tr><td>Apogee alt.</td>      <td class="oi-val">${apogee.toFixed(1)} km</td></tr>
        </table>
      </div>

      <div class="oi-card">
        <div class="oi-card-title">TLE Info</div>
        <table class="oi-table">
          <tr><td>Orbit type</td>     <td class="oi-val">${orbitType}</td></tr>
          <tr><td>TLE epoch</td>      <td class="oi-val">${fmtDateTime(epochDate)}</td></tr>
          <tr><td>TLE age</td>        <td class="oi-val ${ageCls}">${ageDays.toFixed(2)} days &nbsp;${ageLabel}</td></tr>
          <tr><td>B* drag term</td>   <td class="oi-val">${sr.bstar.toExponential(4)}</td></tr>
        </table>
      </div>

      <div class="oi-card">
        <div class="oi-card-title">Current State <span class="oi-live-badge">LIVE</span></div>
        <table class="oi-table">
          <tr><td>Altitude</td>  <td class="oi-val" id="oi-live-alt">—</td></tr>
          <tr><td>Velocity</td>  <td class="oi-val" id="oi-live-vel">—</td></tr>
          <tr><td>Latitude</td>  <td class="oi-val" id="oi-live-lat">—</td></tr>
          <tr><td>Longitude</td> <td class="oi-val" id="oi-live-lon">—</td></tr>
          <tr><td>Eclipse</td>   <td class="oi-live-ecl" id="oi-live-ecl">—</td></tr>
        </table>
      </div>

      <div class="oi-card oi-card-eclipse">
        <div class="oi-card-title">Eclipse per Orbit</div>
        <div id="oi-eclipse-state" class="oi-eclipse-state">—</div>
        <div class="oi-eclipse-bar">
          <div class="oi-eclipse-seg oi-seg-shadow" style="width:${eclPct}%">${fmtMin(eclipseMin)}</div>
          <div class="oi-eclipse-seg oi-seg-sun"    style="width:${sunPct}%">${fmtMin(sunMin)}</div>
        </div>
        <div class="oi-eclipse-legend">
          <span class="oi-ecl-shadow">● ${eclPct}% shadow</span>
          <span class="oi-ecl-sun">☀ ${sunPct}% sun</span>
        </div>
        <div class="oi-card-subtitle">Upcoming transitions</div>
        <div id="oi-events-list" class="oi-events-list"></div>
      </div>

    </div>
  `;
}

// ── Eclipse computation ───────────────────────────────────────────

function computeEclipseOrbit(satrec, fromDate, periodMs) {
  const SAMPLES = 120;
  const stepMs  = periodMs / SAMPLES;
  let eclSamples = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t   = new Date(fromDate.getTime() + i * stepMs);
    const pos = propagate(satrec, t);
    if (!pos?.eciPos) continue;
    if (isInEclipse(pos.eciPos, sunDirectionECI(t))) eclSamples++;
  }
  const fraction   = eclSamples / SAMPLES;
  const periodMin  = periodMs / 60000;
  return { fraction, eclipseMin: fraction * periodMin, sunMin: (1 - fraction) * periodMin };
}

function computeUpcomingEvents(satrec, fromDate, maxEvents = 6) {
  const n        = satrec.no;
  const periodMs = (2 * Math.PI / n) * 60000;
  const stepMs   = 60000; // 1-min resolution
  const steps    = Math.ceil((periodMs * 3) / stepMs);
  const events   = [];
  let prevState  = null;
  for (let i = 0; i <= steps && events.length < maxEvents; i++) {
    const t   = new Date(fromDate.getTime() + i * stepMs);
    const pos = propagate(satrec, t);
    if (!pos?.eciPos) continue;
    const inEcl = isInEclipse(pos.eciPos, sunDirectionECI(t));
    if (prevState !== null && inEcl !== prevState) events.push({ t, enteringShadow: inEcl });
    prevState = inEcl;
  }
  return events;
}

function renderEvents(events, now) {
  if (events.length === 0) return '<div class="oi-no-events">No transitions in next 3 orbits</div>';
  return events.map(ev => {
    const deltaMs = ev.t - now;
    const abs = Math.abs(deltaMs);
    const mm  = Math.floor(abs / 60000);
    const ss  = String(Math.floor((abs % 60000) / 1000)).padStart(2, '0');
    const cls   = ev.enteringShadow ? 'oi-ev-shadow' : 'oi-ev-sun';
    const badge = ev.enteringShadow
      ? '<span class="oi-badge oi-badge-shadow">UMBRA IN</span>'
      : '<span class="oi-badge oi-badge-sun">UMBRA OUT</span>';
    return `<div class="oi-event ${cls}">
      ${badge}
      <span class="oi-ev-time">${fmtDateTime(ev.t)}</span>
      <span class="oi-ev-delta">in ${mm}m${ss}s</span>
    </div>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────

function epochToDate(epochyr, epochdays) {
  const year = epochyr < 57 ? 2000 + epochyr : 1900 + epochyr;
  const d = new Date(Date.UTC(year, 0, 1));
  d.setTime(d.getTime() + (epochdays - 1) * 86400000);
  return d;
}

function classifyOrbit(incDeg, a) {
  const alt = a - R_E;
  let regime = alt < 2000 ? 'LEO' : alt < 35286 ? 'MEO' : alt < 36286 ? 'GEO' : 'HEO';
  let sub = '';
  if (incDeg < 5 || incDeg > 175)                        sub = 'Equatorial';
  else if (regime === 'LEO' && incDeg > 95 && incDeg < 105) sub = 'SSO';
  else if (incDeg > 85 && incDeg < 95)                   sub = 'Polar';
  else if (incDeg > 80)                                   sub = 'Near-polar';
  return sub ? `${regime} — ${sub}` : regime;
}

function fmtDateTime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function fmtMin(min) {
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
