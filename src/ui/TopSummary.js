// Fleet-wide summary in the top bar — satellite count, anomaly count, next
// pass across the whole fleet. Reuses severity.js's shared ranking (no new
// alert logic) and passTooltip.js's shared date formatter (same one
// ChadOps.js already uses for simu-time), so this is purely aggregation.
import { store }            from '../store.js';
import { worstSev, satSeverities, SEV, SEV_COLOR, SEV_LABEL } from './severity.js';
import { fmtDateTimeShort } from './passTooltip.js';
import { satEffectiveNow, satIsSimulated } from '../satSimu.js';

function _nextPass() {
  let soonest = null;
  for (const sat of store.satellites) {
    const next = (store.satPasses[sat.id] ?? []).find(p => p.future);
    if (next && (!soonest || next.start < soonest)) soonest = next.start;
  }
  return soonest;
}

// Every REAL (non-simulated) satellite currently inside a pass window
// (aos0→los0) right now — same aos0→los0 check ChadOps.js's own
// _currentPass uses for its per-row LIVE badge, just scanned across every
// satellite instead of one. Simulated satellites are deliberately excluded
// here, same reasoning GlobeView.js/MapView.js already exclude them from the
// Visualizer for: a simulated satellite's own satEffectiveNow can be
// offset by however far its sim environment's clock has drifted from real
// wall-clock time (see satSimu.js), so it can read as "in pass" against its
// OWN simulated now while nothing is actually happening right now in real
// time. Fleet's own per-row LIVE badge still shows it there (correctly,
// since it sits right next to a visible 🧪 SIM tag) — this top-bar badge has
// no room for that caveat, so it only ever fires for a satellite whose
// "right now" IS real right now.
function _fleetLivePasses() {
  return store.satellites.filter(sat => {
    if (satIsSimulated(sat.noradId)) return false;
    const now = satEffectiveNow(sat.noradId);
    const passes = store.satPasses[sat.id] ?? [];
    return passes.some(p => p.start <= now && now <= p.end);
  });
}

// Countdown format is a plain total-hours/minutes/seconds stopwatch reading
// (NOT a wall-clock "wraps at 24" time-of-day) — "in 50h 12min 07s" for a
// pass 2 days out reads unambiguously as a duration, where "50:12:07" could
// be misread as a wall-clock time. Seconds actually tick visibly since
// update() already runs every 1s (see initTopSummary's own setInterval).
// Clamped at 0 so a pass that's just barely started (between this tick's
// computation and the next one landing) doesn't show a negative countdown
// for the one tick it takes _fleetLivePasses above to catch up and switch
// views.
function _fmtCountdownHMS(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}min ${String(s).padStart(2, '0')}s`;
}

// Same 5 keys satSeverities (severity.js) always returns — display order
// matches roughly "how an operator would triage" (connectivity first,
// onboard state next, data freshness/ground events last).
const _SUBSYS_LABEL = { ping: 'Ping', mode: 'Mode', batt: 'Batt', gnss: 'GNSS', ground: 'Ground' };

// Popover content for the anomaly count — one row per satellite currently
// contributing to it (worstSev >= WARNING), each tagged with WHICH
// subsystem(s) are behind that and at what severity, so hovering the count
// answers "which satellite, and why" instead of just a bare number.
function _anomalyDetailHTML(sats) {
  const rows = sats.map(sat => {
    const sevs = satSeverities(sat);
    const bad  = Object.entries(sevs).filter(([, v]) => v >= SEV.WARNING);
    return { sat, bad };
  }).filter(({ bad }) => bad.length);

  if (!rows.length) return '<div class="tb-anom-empty">No anomalies — fleet nominal.</div>';

  return rows.map(({ sat, bad }) => {
    const subs = bad
      .sort((a, b) => b[1] - a[1]) // worst subsystem first within a satellite's own row
      .map(([key, v]) => `<span class="tb-anom-sub" style="color:${SEV_COLOR[v]}">${_SUBSYS_LABEL[key]} ${SEV_LABEL[v]}</span>`)
      .join('');
    return `<div class="tb-anom-row">
      <span class="tb-anom-dot" style="background:${sat.color}"></span>
      <span class="tb-anom-name">${sat.name}</span>
      <span class="tb-anom-subs">${subs}</span>
    </div>`;
  }).join('');
}

export function initTopSummary() {
  const countEl        = document.getElementById('tb-sat-count');
  const anomalyEl      = document.getElementById('tb-anomaly-count');
  const anomalyBox     = document.getElementById('tb-anomaly-stat');
  const anomalyPop     = document.getElementById('tb-anomaly-popover');
  const nextPassEl     = document.getElementById('tb-next-pass');
  const countdownEl    = document.getElementById('tb-nextpass-countdown');
  const nextPassNormal = document.getElementById('tb-nextpass-normal');
  const inPassBadge    = document.getElementById('tb-inpass-badge');
  const inPassText     = document.getElementById('tb-inpass-text');
  if (!countEl) return;

  // Same "click the real tab button" convention ChadOps.js's own track icon
  // uses (co-track-btn's handler) rather than importing switchTab from
  // main.js, which itself imports this module. Whole badge is one target,
  // not per-satellite — with more than one satellite in pass at once this
  // just lands on Fleet with all of them visible, rather than picking one
  // arbitrarily to focus.
  inPassBadge?.addEventListener('click', () => {
    document.querySelector('[data-tab="fleet"]')?.click();
  });

  function update() {
    const sats = store.satellites;
    countEl.textContent = String(sats.length);

    const anomalies = sats.filter(s => worstSev(s) >= SEV.WARNING).length;
    anomalyEl.textContent = String(anomalies);
    anomalyBox.classList.toggle('tb-anomaly-stat-warn', anomalies > 0);
    if (anomalyPop) anomalyPop.innerHTML = _anomalyDetailHTML(sats);

    // "In Pass" (glowing, same badge as the Fleet table's own LIVE tag)
    // takes over the whole stat while true — a pass actually happening right
    // now is more urgent than the countdown to the NEXT one, so there's no
    // point showing both at once. Names the actual satellite(s), not just a
    // generic "something's happening" — the point of naming them here is so
    // clicking through to Fleet isn't the only way to find out which one(s).
    const liveSats = _fleetLivePasses();
    const live = liveSats.length > 0;
    if (nextPassNormal) nextPassNormal.hidden = live;
    if (inPassBadge)    inPassBadge.hidden    = !live;
    if (live && inPassText) inPassText.textContent = `In Pass: ${liveSats.map(s => s.name).join(', ')}`;

    if (!live) {
      const next = _nextPass();
      nextPassEl.textContent = next ? fmtDateTimeShort(next) : '—';
      if (countdownEl) countdownEl.textContent = next ? `(in ${_fmtCountdownHMS(next.getTime() - Date.now())})` : '';
    }
  }

  store.subscribe(key => {
    if (['satellites', 'satTelemetry', 'satGroundEvents', 'satGnss', 'pingStatus', 'satPasses'].includes(key)) update();
  });
  // Store changes alone don't advance the countdown or catch the exact
  // moment a pass starts/ends — same 1s cadence NavClocks.js's own live
  // clocks and ChadOps.js's own "ago"/"next" labels already tick on.
  setInterval(update, 1000);
  update();
}
