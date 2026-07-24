// Hover preview for a pass. Originally grew to hold a polar ground-track
// plot, an Eb/N0 chart with a linked cursor, and an async procedure-execution
// report all at once — heavy and slow to read on a routine hover. That full
// visual/async detail now lives in PassDetailPanel.js's slide-in panel,
// opened on click. This tooltip stays synchronous-feeling for everything that
// doesn't need a network round trip (satellite, station, timing, the full
// procedure list — all already on the `pass`/`sat` objects), and layers in
// just the pass-geometry numbers (apogee, antenna-mask AOS/LOS) once the
// ground-station lookup resolves — real information, not a chart.
import { store } from '../store.js';
import { propagate } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { fetchPassGsCoords, computePolarPoints, computePolarMarkers, MARKER_COLORS } from './passPolar.js';
import { fetchScheduledProcedures, scheduledProceduresHTML } from './scheduledProcedures.js';
import { satSubsystemHost } from '../satSubsystems.js';
import './grafanaModal.js'; // side-effect import: registers the click-to-popup handler used by the co-tt-link anchors below

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };

export function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function fmtDateTimeShort(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function fmtTimeOnly(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// A procedure's recorded startMs/endMs is often off by a few seconds from
// when Loki actually received the corresponding log lines — a tight window
// was cutting real lines off. Widened padding means adjacent procedures'
// lines routinely show up too now; the log pop-up (grafanaModal.js) marks
// those as dimmed context via the matching data-loki-nominal-* attributes
// below, rather than this trying to guess a padding tight enough to exclude
// them (which is exactly what was cutting real lines off before).
export const LOKI_PROC_PAD_MS = 8000;

export function grafanaLokiUrl(grafanaHost, fromMs, toMs) {
  return `http://${grafanaHost}:3000/a/grafana-lokiexplore-app/explore/service/-scc/logs`
    + `?patterns=%5B%5D&from=${fromMs}&to=${toMs}`
    + `&var-lineFormat=&var-ds=P8E80F9AEF21F6940`
    + `&var-filters=service_name%7C%3D%7C%2Fscc`
    + `&var-fields=&var-levels=&var-metadata=&var-jsonFields=`
    + `&var-patterns=&var-lineFilterV2=&var-lineFilters=`
    + `&timezone=browser&var-all-fields=&userDisplayedFields=false`
    + `&displayedFields=%5B%5D&urlColumns=%5B%5D`
    + `&visualizationType=%22logs%22&prettifyLogMessage=false`
    + `&sortOrder=%22Descending%22&wrapLogMessage=false`;
}

// Antenna-mask AOS, apogee, antenna-mask LOS — one compact line, chronological
// (mask entry happens first, apogee mid-pass, mask exit last). Reuses the
// exact colors and label notation the polar plot itself marks them with
// (MARKER_COLORS, plain "▲{el}°" / "{el}°" / "▼{el}°" — the plot has no text
// labels beyond that either), just with the crossing time added since the
// plot has no room for it. Mask AOS/LOS is where the pass track actually
// crosses the ground station's elevation mask (maskEntry/maskExit) — not the
// raw 0°-horizon AOS/LOS, which is often unusable there.
export function passGeometryHTML(markers) {
  if (!markers) return '';
  const { apogee, maskEntry, maskExit } = markers;
  const items = [];
  if (maskEntry) {
    items.push(`<span class="pdp-geo-item" style="color:${MARKER_COLORS.maskEntry}">▲ ${fmtTimeOnly(maskEntry.t).slice(0, 8)} · ${maskEntry.el.toFixed(0)}°</span>`);
  }
  if (apogee) {
    items.push(`<span class="pdp-geo-item" style="color:${MARKER_COLORS.apogee}">${apogee.el.toFixed(0)}°</span>`);
  }
  if (maskExit) {
    items.push(`<span class="pdp-geo-item" style="color:${MARKER_COLORS.maskExit}">▼ ${fmtTimeOnly(maskExit.t).slice(0, 8)} · ${maskExit.el.toFixed(0)}°</span>`);
  }
  if (!items.length) return '';
  return `<div class="pdp-geo-line">${items.join('')}</div>`;
}

// Compact one-line summary for the Grafana log pop-up's own title — separate
// from the anchor's native `title` attribute (kept as just the procedure
// name, for a sane browser hover tooltip). Packs in the satellite/pass/
// procedure-window context so the pop-up answers "what am I looking at"
// without the tooltip/panel it was opened from still being visible.
export function grafanaModalTitle(sat, pass, pr) {
  const satPart  = sat?.name ?? '';
  const netTag   = pass.network ? ` ${pass.network}` : '';
  const passPart = `${pass.station ?? '—'}${netTag}`;
  const timePart = `${fmtTimeOnly(pr.startMs).slice(0, 8)}–${fmtTimeOnly(pr.endMs).slice(0, 8)} UTC`;
  return [satPart, passPart, pr.name, timePart].filter(Boolean).join(' · ');
}

// Full procedure list (names, not a count) — all synchronous, `pass.procedures`
// is already resolved on the pass object, no fetch needed for this part.
function _procedureListHTML(pass, grafanaHost, sat) {
  if (pass.future) {
    return `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>
      <div class="pass-procs-slot"><div class="co-tt-note">Checking SCC for scheduled procedures…</div></div>`;
  }
  const procs = pass.procedures;
  if (!procs?.length) return `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>`;
  const rows = procs.map((pr, i) => {
    const num  = `<span class="co-tt-num">${i + 1}</span>`;
    const name = `<span class="co-tt-pname">${pr.name}</span>`;
    if (pr.notStarted) {
      // Scheduled but the pass ended before it ever started (satPasses.js) —
      // no real dates to show, nothing to link to Grafana for, and already
      // sorted last. Reuses the muted "not a real outcome" treatment.
      return `<div class="co-tt-proc co-tt-scheduled" title="${pr.name}">${num}${name}</div>`;
    }
    const cls  = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    if (grafanaHost && pr.startMs && pr.endMs) {
      const fromMs = pr.startMs - LOKI_PROC_PAD_MS, toMs = pr.endMs + LOKI_PROC_PAD_MS;
      const url = grafanaLokiUrl(grafanaHost, fromMs, toMs);
      return `<a href="${url}" target="_blank" rel="noopener" data-grafana-modal data-loki-host="${grafanaHost}" data-loki-start="${fromMs}" data-loki-end="${toMs}" data-loki-nominal-start="${pr.startMs}" data-loki-nominal-end="${pr.endMs}" data-grafana-title="${grafanaModalTitle(sat, pass, pr)}" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}</div>`;
  }).join('');
  return `<div class="co-tt-procs">${rows}</div>`;
}

// Shadow/sun split over the pass duration — moved here from PassDetailPanel.js
// (still used there too) since it's pure, synchronous SGP4 propagation + a
// sun-vector check every 30s across the pass, no network round trip, so it
// fits this tooltip's own "stays synchronous-feeling" rule just as well as
// the slide-in's.
export function passEclipseBarHTML(satrec, start, end) {
  if (!satrec || !start || !end) return '';
  const STEP = 30_000; // 30s samples
  let shadow = 0, sun = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += STEP) {
    const d = new Date(t);
    const r = propagate(satrec, d);
    if (!r?.eciPos) continue;
    if (isInEclipse(r.eciPos, sunDirectionECI(d))) shadow++; else sun++;
  }
  const total = shadow + sun;
  if (!total) return '';
  const eclPct = Math.round((shadow / total) * 100);
  const sunPct = 100 - eclPct;
  const fmtMin = m => `${m}m`;
  const durMin = Math.round((end - start) / 60_000);
  const eclMin = Math.round(shadow / total * durMin);
  const sunMin = durMin - eclMin;
  return `
    <div class="co-tt-ecl-bar">
      <div class="oi-eclipse-bar">
        <div class="oi-eclipse-seg oi-seg-shadow" style="width:${eclPct}%">${eclPct > 15 ? fmtMin(eclMin) : ''}</div>
        <div class="oi-eclipse-seg oi-seg-sun"    style="width:${sunPct}%">${sunPct > 15 ? fmtMin(sunMin) : ''}</div>
      </div>
      <div class="oi-eclipse-legend">
        <span class="oi-ecl-shadow">● ${eclPct}% shadow</span>
        <span class="oi-ecl-sun">☀ ${sunPct}% sun</span>
      </div>
    </div>`;
}

export function passSimpleTooltipContent(pass, sat) {
  const grafanaHost = sat ? (satSubsystemHost(sat.noradId, 'sccRo') || null) : null;
  const satName = sat ? `<span class="co-tt-sat-name" style="color:${sat.color}">${sat.name}</span> ` : '';
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  // Same entry point into Pass Analyzer as PassDetailPanel.js's microscope
  // button — hidden for a future pass (nothing for the Analyzer to show yet,
  // same gating PassDetailPanel.js uses there) and when there's no real
  // satellite (Analyzer needs one). data-pda-* carries just enough to
  // re-find the sat/pass in the store at click time (see the delegated
  // listener below) rather than trying to serialize the actual objects.
  const microscope = (sat && !pass.future)
    ? `<span class="co-tt-microscope" data-pda-microscope data-pda-sat-id="${sat.id}" data-pda-pass-start="${pass.start.getTime()}" title="Open in Pass Analyzer">🔬</span>`
    : '';
  const hdr = `<div class="co-tt-header">${satName}${pass.station ?? '—'}${netTag}${microscope}</div>`;
  const eclBar = passEclipseBarHTML(sat?.satrec, pass.start, pass.end);
  const details = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
    ${eclBar}
    <div class="pass-geometry-slot"></div>`;
  return hdr + details + _procedureListHTML(pass, grafanaHost, sat);
}

// Global delegated handler (not wired per-caller), registered once as a
// side effect of importing this module — same rationale grafanaModal.js's
// own document-level listener uses: this tooltip's HTML is rebuilt fresh on
// every hover across several independent callers (ChadOps.js,
// WeeklySchedule.js, TimePlayer.js), so a single listener here is simpler
// than wiring one at each call site. Looks the sat/pass back up from the
// store rather than trying to serialize the actual objects into the DOM.
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pda-microscope]');
  if (!el) return;
  const sat = store.satellites.find(s => s.id === el.dataset.pdaSatId);
  const startMs = Number(el.dataset.pdaPassStart);
  const pass = sat ? (store.satPasses[sat.id] ?? []).find(p => p.start.getTime() === startMs) : null;
  if (!sat || !pass) return;
  // The hover tooltip itself has no reason to stay open once we've
  // navigated away to a different tab entirely.
  const tooltip = el.closest('.co-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  document.dispatchEvent(new CustomEvent('pda:open-pass', { detail: { sat, pass } }));
});

// Per-element generation counters (not a single module-level counter) — each
// caller's tooltip DOM element is independent (ChadOps.js/TimePlayer.js each
// keep their own shared element for several hover types, WeeklySchedule.js
// uses createPassTooltip()'s), so hovering a pass in one view must not
// invalidate an in-flight hydration for a different element elsewhere.
const _hydrateGen = new WeakMap();

// Fetches ground-station coords (cached inside passPolar.js) and fills in
// `el`'s .pass-geometry-slot once resolved. Exported standalone (not just
// used inside createPassTooltip()'s showForPass) so a caller managing its own
// tooltip element directly — e.g. ChadOps.js, which reuses one shared tooltip
// for several hover types — can still get the async geometry line without
// adopting the whole factory.
export async function hydratePassGeometry(el, e, pass, sat) {
  const myGen = (_hydrateGen.get(el) ?? 0) + 1;
  _hydrateGen.set(el, myGen);
  if (!sat?.satrec) return;
  const coords = await fetchPassGsCoords(sat, pass, store.groundStations);
  if (_hydrateGen.get(el) !== myGen || el.style.display === 'none') return; // superseded or closed
  if (!coords) return;
  const pts     = computePolarPoints(pass, sat, coords.lat, coords.lon);
  const markers = computePolarMarkers(pts, coords.rxMask);
  const slot = el.querySelector('.pass-geometry-slot');
  if (slot) { slot.innerHTML = passGeometryHTML(markers); positionTooltip(e, el); }
}

// Separate generation map from _hydrateGen above — this and hydratePassGeometry
// run concurrently on the same element from the same hover, so sharing one
// counter would have each call's increment spuriously supersede the other.
const _procHydrateGen = new WeakMap();

// Future passes have no procedure-history yet (nothing has executed), but
// SCC may already have procedures queued on it — fills the placeholder set by
// _procedureListHTML with whatever fetchScheduledProcedures finds.
export async function hydrateScheduledProcedures(el, pass, sat) {
  if (!pass.future || !sat) return;
  const myGen = (_procHydrateGen.get(el) ?? 0) + 1;
  _procHydrateGen.set(el, myGen);
  const procs = await fetchScheduledProcedures(sat, pass);
  if (_procHydrateGen.get(el) !== myGen || el.style.display === 'none') return;
  const slot = el.querySelector('.pass-procs-slot');
  if (slot) slot.innerHTML = scheduledProceduresHTML(procs, fmtTimeOnly);
}

export function positionTooltip(e, el) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const w = el.offsetWidth  || 200;
  const h = el.offsetHeight || 90;
  if (x + w > window.innerWidth  - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  x = Math.max(8, Math.min(x, window.innerWidth  - w - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

// Self-contained tooltip: creates its own DOM element, manages show/hide timing
// (stays open while hovered, 800ms grace on leave, dismiss on outside click).
// `element` is exposed so a caller with an unrelated but similarly-shaped
// hover (e.g. TimePlayer.js's TMR gap tooltip) can share the same instance
// instead of standing up its own show/hide/position machinery.
export function createPassTooltip() {
  const el = document.createElement('div');
  el.className = 'co-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);

  let hideTimer = null;
  const cancelHide   = () => clearTimeout(hideTimer);
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { el.style.display = 'none'; }, 800); };
  el.addEventListener('mouseenter', cancelHide);
  el.addEventListener('mouseleave', scheduleHide);
  document.addEventListener('click', e => {
    if (el.style.display !== 'none' && !el.contains(e.target)) el.style.display = 'none';
  });

  function showForPass(e, pass, sat) {
    cancelHide();
    el.innerHTML = passSimpleTooltipContent(pass, sat);
    el.style.display = 'block';
    positionTooltip(e, el);
    hydratePassGeometry(el, e, pass, sat);
    hydrateScheduledProcedures(el, pass, sat);
  }

  return { element: el, showForPass, cancelHide, scheduleHide };
}
