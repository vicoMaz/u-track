// Full pass detail — eclipse bar, polar ground-track plot, Eb/N0 chart with
// linked cursor, procedure history, and the async procedure-execution report.
// This is the content that used to live in the hover tooltip (see
// passTooltip.js); it's heavy enough (several async-loaded charts) that it
// now opens as a slide-in panel on click instead, keeping the hover itself
// fast and simple. One singleton panel, shared by every view that shows
// passes (Fleet pass-dots, Weekly Schedule, the gantt timeline).
import { store } from '../store.js';
import { fetchPassGsCoords, buildPolarSVG, computePolarPoints, computePolarMarkers } from './passPolar.js';
import { fetchProcedureReport, procedureReportHTML } from './procedureReport.js';
import { fetchEbn0Series, fetchTcEbn0Series, ebn0HTML } from './ebn0.js';
import { fetchScheduledProcedures, scheduledProceduresHTML } from './scheduledProcedures.js';
import { wireLinkedCursor } from './passCursor.js';
import { openAzElModal } from './passAzElModal.js';
import { satSubsystemHost } from '../satSubsystems.js';
import { fmtDuration, fmtDateTimeShort, fmtTimeOnly, grafanaLokiUrl, grafanaModalTitle, LOKI_PROC_PAD_MS, passEclipseBarHTML } from './passTooltip.js';
import './grafanaModal.js'; // side-effect import: registers the click-to-popup handler used by the co-tt-link anchors below (idempotent alongside passTooltip.js's own import of it)

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };

function _passDetailContent(pass, grafanaHost, sat) {
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  const rawLogLink = (!pass.future && grafanaHost)
    ? `<a href="${grafanaLokiUrl(grafanaHost, pass.start.getTime() - 30000, pass.end.getTime() + 30000)}" target="_blank" rel="noopener" class="pdp-raw-logs">Raw logs ↗</a>`
    : '';
  const hdr = `<div class="co-tt-header">${pass.station ?? '—'}${netTag}${rawLogLink}</div>`;
  const eclBar = passEclipseBarHTML(sat?.satrec, pass.start, pass.end);
  const details = `<div class="co-tt-section-title">Pass details</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
    ${eclBar}
    <div class="co-tt-details-row">
      <div class="polar-slot"></div>
      <div class="ebn0-slot">${pass.future ? '' : '<div class="ebn0-loading">Collecting metrics…</div>'}</div>
    </div>`;
  const reportSlot = '<div class="proc-report-slot"></div>';
  if (pass.future) {
    return hdr + details + `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>
      <div class="pass-procs-slot"><div class="co-tt-note">Checking SCC for scheduled procedures…</div></div>`;
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
      const fromMs = pr.startMs - LOKI_PROC_PAD_MS, toMs = pr.endMs + LOKI_PROC_PAD_MS;
      const url = grafanaLokiUrl(grafanaHost, fromMs, toMs);
      return `<a href="${url}" target="_blank" rel="noopener" data-grafana-modal data-loki-host="${grafanaHost}" data-loki-start="${fromMs}" data-loki-end="${toMs}" data-loki-nominal-start="${pr.startMs}" data-loki-nominal-end="${pr.endMs}" data-grafana-title="${grafanaModalTitle(sat, pass, pr)}" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${procDur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}${procDur}</div>`;
  }).join('');
  return hdr + details + historyTitle + `<div class="co-tt-procs">${procs}</div>` + reportSlot;
}

let _panelEl = null, _bodyEl = null, _titleEl = null, _microscopeBtn = null;
let _openGen = 0; // guards against a slower, superseded openPassDetail() call
                  // injecting stale content after a newer one has taken over
let _currentSat = null, _currentPass = null; // whatever openPassDetail most recently opened — read by the microscope button's single, permanently-attached click handler below

function _ensurePanel() {
  if (_panelEl) return;
  _panelEl = document.createElement('div');
  _panelEl.className = 'pdp-panel';
  _panelEl.innerHTML = `
    <div class="pdp-header">
      <span class="pdp-title"></span>
      <div class="pdp-header-actions">
        <button type="button" class="pdp-microscope" title="Open in Pass Analyzer">🔬</button>
        <button type="button" class="pdp-close" title="Close">×</button>
      </div>
    </div>
    <div class="pdp-body"></div>`;
  document.body.appendChild(_panelEl);
  _bodyEl        = _panelEl.querySelector('.pdp-body');
  _titleEl       = _panelEl.querySelector('.pdp-title');
  _microscopeBtn = _panelEl.querySelector('.pdp-microscope');
  _panelEl.querySelector('.pdp-close').addEventListener('click', closePassDetail);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePassDetail(); });
  // Dispatched, not a direct import of PassAnalyzer.js/main.js — this module
  // doesn't need to know the Pass Analyzer tab exists at all, just announce
  // the intent; main.js (which already depends on both) does the actual
  // tab-switch + selection.
  _microscopeBtn.addEventListener('click', () => {
    if (!_currentPass) return;
    document.dispatchEvent(new CustomEvent('pda:open-pass', { detail: { sat: _currentSat, pass: _currentPass } }));
  });
}

export function closePassDetail() {
  _openGen++; // invalidate any in-flight hydration for whatever was open
  _panelEl?.classList.remove('pdp-open');
  store.clearSelectedPass();
}

export async function openPassDetail(pass, sat, groundStations) {
  _ensurePanel();
  const myGen = ++_openGen;

  _currentSat = sat;
  _currentPass = pass;
  // No TC packets / procedure data exists yet for a pass that hasn't
  // happened — nothing for the Analyzer to show, so hide the entry point
  // rather than let it open to an empty state.
  _microscopeBtn.style.display = pass.future ? 'none' : '';

  // Lets every view that renders pass dots (currently just the Fleet table)
  // highlight whichever one this panel is now showing, without each opener
  // having to know or care who else might want to reflect the selection.
  store.setSelectedPass(sat?.id ?? null, pass.start.getTime());

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

  if (pass.future && sat) {
    fetchScheduledProcedures(sat, pass).then(procs => {
      if (myGen !== _openGen) return;
      const slot = _bodyEl.querySelector('.pass-procs-slot');
      if (slot) slot.innerHTML = scheduledProceduresHTML(procs, fmtTimeOnly);
    });
  }

  // Ground-station coords (cached lat/lon + antenna mask) are typically much
  // faster than the Eb/N0 telemetry query below (an SCC parameter fetch with
  // up to a 15s timeout), so the polar plot renders as soon as ITS OWN
  // promise resolves instead of waiting on the slow one too — the ebn0-slot
  // keeps its "Collecting metrics…" placeholder (set synchronously above)
  // until its own fetch actually finishes.
  const coordsPromise = sat?.satrec
    ? fetchPassGsCoords(sat, pass, groundStations)
    : Promise.resolve(null);

  const polarReadyPromise = coordsPromise.then(coords => {
    if (myGen !== _openGen) return { polarPoints: null, markers: null };
    let polarPoints = null, markers = null;
    const polarSlot = _bodyEl.querySelector('.polar-slot');
    const svg = coords ? buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask) : '';
    if (svg && polarSlot) {
      polarSlot.outerHTML = `<div class="polar-wrap">${svg}
        <button type="button" class="pv-azel-btn" title="Show this pass as an azimuth/elevation (Cartesian) plot">⤢ Cartesian</button>
      </div>`;
      _bodyEl.querySelector('.pv-azel-btn')?.addEventListener('click', () =>
        openAzElModal(pass, sat, coords.lat, coords.lon, coords.rxMask));
      polarPoints = computePolarPoints(pass, sat, coords.lat, coords.lon);
      markers = computePolarMarkers(polarPoints, coords.rxMask);
    }
    return { polarPoints, markers };
  });

  const ebn0Promise  = (!pass.future && sat?.noradId)
    ? fetchEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime(), pass.network)
    : Promise.resolve(null);
  const tcEbn0Promise = (!pass.future && sat?.noradId)
    ? fetchTcEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime())
    : Promise.resolve(null);

  // The ebn0 chart still needs mask markers to dot itself correctly, so it
  // waits on polarReadyPromise too — but that promise has almost always
  // already resolved (and painted the polar plot) well before this settles.
  const [{ polarPoints, markers }, series, tcSeries] = await Promise.all([polarReadyPromise, ebn0Promise, tcEbn0Promise]);
  if (myGen !== _openGen) return;

  const polarEl = _bodyEl.querySelector('.pass-polar');
  const ebn0Slot = _bodyEl.querySelector('.ebn0-slot');
  const ebn0Range = { t0: pass.start.getTime(), t1: pass.end.getTime() };
  if (ebn0Slot) ebn0Slot.outerHTML = ebn0HTML(series, markers, pass.procedures, ebn0Range, tcSeries);
  const ebn0El = _bodyEl.querySelector('.ebn0-chart');

  wireLinkedCursor(polarEl, polarPoints, ebn0El, series, pass.procedures, tcSeries, ebn0Range);
}
