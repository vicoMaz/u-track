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
import { fetchPassGsCoords, computePolarPoints, computePolarMarkers, MARKER_COLORS } from './passPolar.js';
import { satSubsystemHost } from '../satSubsystems.js';

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

// Apogee + antenna-mask AOS/LOS as text, reusing the exact colors/symbols the
// polar plot marks them with (MARKER_COLORS, ▲/▼) so wherever this text shows
// up reads as the same information as the plot, not a second unrelated
// summary. Mask AOS/LOS is where the pass track actually crosses the ground
// station's elevation mask (maskEntry/maskExit) — not the raw 0°-horizon
// AOS/LOS, which is often unusable there.
export function passGeometryHTML(markers) {
  if (!markers) return '';
  const { apogee, maskEntry, maskExit } = markers;
  const rows = [];
  if (apogee) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.apogee}">APOGEE</span><span class="pdp-geo-val">${fmtTimeOnly(apogee.t)} · ${apogee.el.toFixed(0)}°</span></div>`);
  }
  if (maskEntry) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.maskEntry}">▲ MASK AOS</span><span class="pdp-geo-val">${fmtTimeOnly(maskEntry.t)} · ${maskEntry.el.toFixed(0)}°</span></div>`);
  }
  if (maskExit) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.maskExit}">▼ MASK LOS</span><span class="pdp-geo-val">${fmtTimeOnly(maskExit.t)} · ${maskExit.el.toFixed(0)}°</span></div>`);
  }
  return rows.join('');
}

// Full procedure list (names, not a count) — all synchronous, `pass.procedures`
// is already resolved on the pass object, no fetch needed for this part.
function _procedureListHTML(pass, grafanaHost) {
  if (pass.future) return `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>`;
  const procs = pass.procedures;
  if (!procs?.length) return `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>`;
  const rows = procs.map((pr, i) => {
    const cls  = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const num  = `<span class="co-tt-num">${i + 1}</span>`;
    const name = `<span class="co-tt-pname">${pr.name}</span>`;
    if (grafanaHost && pr.startMs && pr.endMs) {
      const url = grafanaLokiUrl(grafanaHost, pr.startMs - 1000, pr.endMs + 1000);
      return `<a href="${url}" target="_blank" rel="noopener" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}</div>`;
  }).join('');
  return `<div class="co-tt-procs">${rows}</div>`;
}

export function passSimpleTooltipContent(pass, sat) {
  const grafanaHost = sat ? (satSubsystemHost(sat.noradId, 'sccRo') || null) : null;
  const satName = sat ? `<span class="co-tt-sat-name" style="color:${sat.color}">${sat.name}</span> ` : '';
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  const hdr = `<div class="co-tt-header">${satName}${pass.station ?? '—'}${netTag}</div>`;
  const details = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
    <div class="pass-geometry-slot"></div>`;
  return hdr + details + _procedureListHTML(pass, grafanaHost);
}

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
  }

  return { element: el, showForPass, cancelHide, scheduleHide };
}
