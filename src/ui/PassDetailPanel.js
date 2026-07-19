// Full pass detail — eclipse bar, polar ground-track plot, Eb/N0 chart with
// linked cursor, procedure history, and the async procedure-execution report.
// This is the content that used to live in the hover tooltip (see
// passTooltip.js); it's heavy enough (several async-loaded charts) that it
// now opens as a slide-in panel on click instead, keeping the hover itself
// fast and simple. One singleton panel, shared by every view that shows
// passes (Fleet pass-dots, Weekly Schedule, the gantt timeline).
import { propagate }                    from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { fetchPassGsCoords, buildPolarSVG, computePolarPoints, computePolarMarkers, MARKER_COLORS } from './passPolar.js';
import { fetchProcedureReport, procedureReportHTML } from './procedureReport.js';
import { fetchEbn0Series, ebn0HTML } from './ebn0.js';
import { wireLinkedCursor } from './passCursor.js';
import { satSubsystemHost } from '../satSubsystems.js';
import { fmtDuration, fmtDateTimeShort, grafanaLokiUrl } from './passTooltip.js';

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };

function _passEclipseBar(satrec, start, end) {
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

function _fmtTimeOnly(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// Apogee + antenna-mask AOS/LOS as text, reusing the exact colors/symbols the
// polar plot already marks them with (MARKER_COLORS, ▲/▼) so the two read as
// the same information, not a second unrelated summary. Mask AOS/LOS is where
// the pass track actually crosses the antenna's elevation mask (maskEntry/
// maskExit) — not the raw 0°-horizon AOS/LOS, which is often unusable there.
function _passGeometryHTML(markers) {
  if (!markers) return '';
  const { apogee, maskEntry, maskExit } = markers;
  const rows = [];
  if (apogee) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.apogee}">APOGEE</span><span class="pdp-geo-val">${_fmtTimeOnly(apogee.t)} · ${apogee.el.toFixed(0)}°</span></div>`);
  }
  if (maskEntry) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.maskEntry}">▲ MASK AOS</span><span class="pdp-geo-val">${_fmtTimeOnly(maskEntry.t)} · ${maskEntry.el.toFixed(0)}°</span></div>`);
  }
  if (maskExit) {
    rows.push(`<div class="pdp-geo-row"><span class="pdp-geo-lbl" style="color:${MARKER_COLORS.maskExit}">▼ MASK LOS</span><span class="pdp-geo-val">${_fmtTimeOnly(maskExit.t)} · ${maskExit.el.toFixed(0)}°</span></div>`);
  }
  return rows.join('');
}

function _passDetailContent(pass, grafanaHost, sat) {
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  const rawLogLink = (!pass.future && grafanaHost)
    ? `<a href="${grafanaLokiUrl(grafanaHost, pass.start.getTime() - 30000, pass.end.getTime() + 30000)}" target="_blank" rel="noopener" class="pdp-raw-logs">Raw logs ↗</a>`
    : '';
  const hdr = `<div class="co-tt-header">${pass.station ?? '—'}${netTag}${rawLogLink}</div>`;
  const eclBar = _passEclipseBar(sat?.satrec, pass.start, pass.end);
  const details = `<div class="co-tt-section-title">Pass details</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
    ${eclBar}
    <div class="co-tt-details-row">
      <div class="polar-slot"></div>
      <div class="ebn0-slot"></div>
    </div>
    <div class="pass-geometry-slot"></div>`;
  const reportSlot = '<div class="proc-report-slot"></div>';
  if (pass.future) {
    return hdr + details + `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>`;
  }
  const historyTitle = `<div class="co-tt-sep"></div><div class="co-tt-section-title">Procedure history</div>`;
  if (!pass.procedures?.length) {
    return hdr + details + historyTitle + `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>` + reportSlot;
  }
  const procs = pass.procedures.map((pr, i) => {
    const cls     = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const num     = `<span class="co-tt-num">${i + 1}</span>`;
    const name    = `<span class="co-tt-pname">${pr.name}</span>`;
    const procDur = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${fmtDuration(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost) {
      const url = grafanaLokiUrl(grafanaHost, pr.startMs - 1000, pr.endMs + 1000);
      return `<a href="${url}" target="_blank" rel="noopener" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${procDur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}${procDur}</div>`;
  }).join('');
  return hdr + details + historyTitle + `<div class="co-tt-procs">${procs}</div>` + reportSlot;
}

let _panelEl = null, _bodyEl = null, _titleEl = null;
let _openGen = 0; // guards against a slower, superseded openPassDetail() call
                  // injecting stale content after a newer one has taken over

function _ensurePanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.className = 'pdp-panel';
  _panelEl.innerHTML = `
    <div class="pdp-header">
      <span class="pdp-title"></span>
      <button type="button" class="pdp-close" title="Close">×</button>
    </div>
    <div class="pdp-body"></div>`;
  document.body.appendChild(_panelEl);
  _bodyEl  = _panelEl.querySelector('.pdp-body');
  _titleEl = _panelEl.querySelector('.pdp-title');
  _panelEl.querySelector('.pdp-close').addEventListener('click', closePassDetail);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePassDetail(); });
}

export function closePassDetail() {
  _openGen++; // invalidate any in-flight hydration for whatever was open
  _panelEl?.classList.remove('pdp-open');
}

export async function openPassDetail(pass, sat, groundStations) {
  _ensurePanel();
  const myGen = ++_openGen;

  const grafanaHost = sat ? (satSubsystemHost(sat.noradId, 'sccRo') || null) : null;
  // Satellite identity is the primary panel title (colored like everywhere
  // else the app identifies a satellite by color) — which pass/station is
  // detail within that, shown in the content's own header below.
  _titleEl.innerHTML = sat
    ? `<span class="pdp-sat-name" style="color:${sat.color}">${sat.name}</span>`
    : (pass.station ?? '—');
  _bodyEl.innerHTML = _passDetailContent(pass, grafanaHost, sat);
  _panelEl.classList.add('pdp-open');

  if (!pass.future && grafanaHost) {
    fetchProcedureReport(grafanaHost, pass.start.getTime(), pass.end.getTime()).then(report => {
      if (myGen !== _openGen) return;
      const slot = _bodyEl.querySelector('.proc-report-slot');
      if (slot) slot.outerHTML = procedureReportHTML(report);
    });
  }

  // Eb/N0 series and polar coords are fetched in parallel, but injected and
  // cursor-linked together — the linked hover needs both charts in the DOM
  // at once, so neither can pop in independently ahead of the other.
  const ebn0Promise = (!pass.future && sat?.noradId)
    ? fetchEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime(), pass.network)
    : Promise.resolve(null);
  const coordsPromise = sat?.satrec
    ? fetchPassGsCoords(sat, pass, groundStations)
    : Promise.resolve(null);

  const [series, coords] = await Promise.all([ebn0Promise, coordsPromise]);
  if (myGen !== _openGen) return;

  let polarPoints = null, markers = null;
  const polarSlot = _bodyEl.querySelector('.polar-slot');
  if (coords && polarSlot) {
    polarSlot.outerHTML = buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask);
    polarPoints = computePolarPoints(pass, sat, coords.lat, coords.lon);
    markers = computePolarMarkers(polarPoints, coords.rxMask);
  }
  const polarEl = _bodyEl.querySelector('.pass-polar');

  const geoSlot = _bodyEl.querySelector('.pass-geometry-slot');
  if (geoSlot) geoSlot.innerHTML = _passGeometryHTML(markers);

  const ebn0Slot = _bodyEl.querySelector('.ebn0-slot');
  if (ebn0Slot) ebn0Slot.outerHTML = ebn0HTML(series, markers, pass.procedures, { t0: pass.start.getTime(), t1: pass.end.getTime() });
  const ebn0El = _bodyEl.querySelector('.ebn0-chart');

  wireLinkedCursor(polarEl, polarPoints, ebn0El, series, pass.procedures);
}
