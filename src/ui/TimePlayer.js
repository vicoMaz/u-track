import { store }                        from '../store.js';
import { propagate }                    from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { scheduleTmrFetch }             from '../tmrData.js';
import { requestTmrGapDownload }        from '../tmrGapDownload.js';
import { fetchPassGsCoords, buildPolarSVG, computePolarPoints, computePolarMarkers } from './passPolar.js';
import { fetchProcedureReport, procedureReportHTML } from './procedureReport.js';
import { fetchEbn0Series, ebn0HTML } from './ebn0.js';
import { wireLinkedCursor } from './passCursor.js';
import { satSubsystemHost }             from '../satSubsystems.js';
import { satSunExclDeg, satEarthExclDeg, MODEL_STAR_TRACKERS } from '../satStarTracker.js';
import { showActionToast }              from './actionToast.js';

function _grafanaLokiUrl(grafanaHost, fromMs, toMs) {
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

function _grafanaHost() {
  return satSubsystemHost(store.trackedSat?.noradId, 'sccRo') || null;
}


const EPOCH = new Date();
let playing = false;
let speed = 1;
let scrubOffsetSec = 0;
let lastRaf = null;
let lastTs = null;

const playBtn     = document.getElementById('play-btn');
const nowBtn      = document.getElementById('now-btn');
const speedSel    = document.getElementById('speed-select');
const scrub       = document.getElementById('time-scrub');
const dateInput   = document.getElementById('date-input');
const scaleSlider = document.getElementById('scale-slider');
const scaleField  = document.getElementById('scale-field');
const ganttEl       = document.getElementById('timeline-gantt');
const ganttCursor   = document.getElementById('gantt-cursor');
const ganttPasses   = document.getElementById('gantt-passes');
const ganttEclipse  = document.getElementById('gantt-eclipse');
const ganttStt      = document.getElementById('gantt-stt');
const ganttStt1     = document.getElementById('gantt-stt1');
const ganttStt2     = document.getElementById('gantt-stt2');
const ganttStt1Row  = document.getElementById('gantt-stt1-row');
const ganttStt2Row  = document.getElementById('gantt-stt2-row');
const ganttSttCollapseBtn = document.getElementById('gantt-stt-collapse');
const ganttTmr      = document.getElementById('gantt-tmr');
const ganttSlots    = document.getElementById('gantt-slots');
const ganttRuler    = document.getElementById('gantt-ruler');

const ganttToggleBtn = document.getElementById('gantt-toggle');
const trackingViewEl = document.getElementById('tracking-view');

// ── Layout sync: called after gantt expand/collapse or on resize ──────────────
let _syncInProgress = false;
function _syncLayout() {
  if (!ganttEl || _syncInProgress) return;
  _syncInProgress = true;
  const ganttH  = ganttEl.offsetHeight;
  const playerH = 48;
  const offset  = ganttH + playerH;
  if (trackingViewEl) trackingViewEl.style.bottom = `${offset}px`;
  document.documentElement.style.setProperty('--gantt-offset', `${offset + 12}px`);
  window.dispatchEvent(new Event('resize'));        // Cesium / Leaflet reflow
  _syncInProgress = false;
}

// Zoom / view state — the visible time window in seconds offset from EPOCH
const MIN_SPAN_SEC  =      300; // 5 minutes
const MAX_SPAN_SEC  = 60 * 86400; // 60 days
let viewStartSec = -604800;  // initial: −7 days
let viewEndSec   =  604800;  // initial: +7 days

// Eclipse windows computed once per satellite, for a fixed ±14-day range around EPOCH
const ECLIPSE_HALF_SEC = 14 * 86400;
const R_EARTH_KM = 6371;
let _eclipseWindows = [];
let _sttPerConeWindows = []; // [ [{start,end}...] per cone index ]
let _sttFusedWindows   = []; // blinded only when EVERY cone is simultaneously blinded
let _eclipseJobSat  = null;

// Plain-object vector helpers — this loop runs many times per satellite
// (5-min steps over ±14 days), so it stays in ECI with plain arithmetic
// rather than pulling in Cesium's Matrix3/Quaternion types here.
function _dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function _cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function _sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function _normalize(v) {
  const m = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  return m > 1e-9 ? { x: v.x / m, y: v.y / m, z: v.z / m } : { x: 0, y: 0, z: 1 };
}

// Mirrors SatEntity.js's _computeOrientation + _updateStarTrackerCones' per-
// cone boresight, in plain ECI vectors (angle-between/magnitude are
// rotation-invariant, so skipping the gmst→ECEF step SatEntity.js needs for
// on-globe rendering gives the identical result). 'anti-sun' cones always
// point -sun; 'body' cones need the actual attitude basis (xECI=sun,
// yECI/zECI completing the frame via Gram-Schmidt against zenith — same
// degenerate-case fallback as SatEntity.js when sun≈zenith).
function _sttConeBoresightEci(eciPos, sunDir, cfg) {
  if (cfg.mode !== 'body') return { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z };
  const rMag = Math.sqrt(eciPos.x ** 2 + eciPos.y ** 2 + eciPos.z ** 2);
  const zenith = { x: eciPos.x / rMag, y: eciPos.y / rMag, z: eciPos.z / rMag };
  const xECI = sunDir;
  const dot  = _dot(zenith, xECI);
  const yRaw = _sub(zenith, { x: xECI.x * dot, y: xECI.y * dot, z: xECI.z * dot });
  const yLen = Math.sqrt(yRaw.x ** 2 + yRaw.y ** 2 + yRaw.z ** 2);
  if (yLen < 1e-6) return { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z }; // degenerate: sun ≈ zenith
  const yECI = { x: yRaw.x / yLen, y: yRaw.y / yLen, z: yRaw.z / yLen };
  const zECI = _cross(xECI, yECI);
  // Same arrow-labeled-frame → raw-basis conversion as SatEntity.js's
  // _updateStarTrackerCones: (-dir.z,-dir.y,-dir.x) weights (xECI,yECI,zECI).
  const { dir } = cfg;
  return _normalize({
    x: -dir.z * xECI.x - dir.y * yECI.x - dir.x * zECI.x,
    y: -dir.z * xECI.y - dir.y * yECI.y - dir.x * zECI.y,
    z: -dir.z * xECI.z - dir.y * yECI.z - dir.x * zECI.z,
  });
}

function _isConeBlinded(eciPos, sunDir, cfg, sunExclDeg, earthExclDeg) {
  const rMag = Math.sqrt(eciPos.x ** 2 + eciPos.y ** 2 + eciPos.z ** 2);
  const nadir = { x: -eciPos.x / rMag, y: -eciPos.y / rMag, z: -eciPos.z / rMag };
  const boresight = _sttConeBoresightEci(eciPos, sunDir, cfg);
  const sunAngleDeg    = Math.acos(Math.max(-1, Math.min(1, _dot(boresight, sunDir)))) * 180 / Math.PI;
  const earthAngleDeg  = Math.acos(Math.max(-1, Math.min(1, _dot(boresight, nadir))))  * 180 / Math.PI;
  const earthRadiusDeg = Math.asin(Math.max(-1, Math.min(1, R_EARTH_KM / rMag))) * 180 / Math.PI;
  return sunAngleDeg < sunExclDeg || earthAngleDeg < earthRadiusDeg + earthExclDeg;
}
let _passWindows    = []; // [{ start: ms, end: ms, pass: fullPassObj }]

// ── Pass tooltip ──────────────────────────────────────────────────
let _ganttTooltip = null;
let _ttHideTimer  = null;
let _ttAnchorX    = 0;   // clientX at mouseenter — used to re-anchor after async polar injection
let _ttAnchorY    = 0;

function _fmtDT(d) {
  if (!d) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth()+1)}-${d.getUTCFullYear()} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function _fmtDurPass(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };
const _PROC_CH  = { SUCCESS: '●', FAILURE: '✗', CANCELLED: '◌' };

function _passTooltipHTML(pass, grafanaHost) {
  const start = pass.start instanceof Date ? pass.start : new Date(pass.start);
  const end   = pass.end   instanceof Date ? pass.end   : new Date(pass.end);
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  const hdr   = `<div class="co-tt-header">${pass.station ?? '—'}${netTag}</div>`;
  const details = `<div class="co-tt-section-title">Pass details</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">AOS</span>${_fmtDT(start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">LOS</span>${_fmtDT(end)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${_fmtDurPass(end - start)}</div>
    <div class="co-tt-details-row">
      <div class="polar-slot"></div>
      <div class="ebn0-slot"></div>
    </div>`;
  const reportSlot = '<div class="proc-report-slot"></div>';
  if (pass.future) return hdr + details + `<div class="co-tt-future-status co-dot-future" style="margin-top:6px">○ SCHEDULED</div>`;
  const historyTitle = `<div class="co-tt-sep"></div><div class="co-tt-section-title">Procedure history</div>`;
  if (!pass.procedures?.length) {
    const passLink = grafanaHost
      ? `<a href="${_grafanaLokiUrl(grafanaHost, start.getTime() - 30000, end.getTime() + 30000)}" target="_blank" rel="noopener" class="co-tt-proc co-tt-ok co-tt-link" style="margin-top:6px">● PASS OCCURRED ↗</a>`
      : `<div class="co-tt-proc co-tt-ok" style="margin-top:6px">● PASS OCCURRED</div>`;
    return hdr + details + historyTitle + passLink + reportSlot;
  }
  const procs = pass.procedures.map((pr, i) => {
    const cls  = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const ch   = _PROC_CH[pr.status]  ?? '●';
    const num  = `<span class="co-tt-num">${i + 1}</span>`;
    const name = `<span class="co-tt-pname">${ch} ${pr.name}</span>`;
    const pdur = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${_fmtDurPass(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost) {
      const url = _grafanaLokiUrl(grafanaHost, pr.startMs - 1000, pr.endMs + 1000);
      return `<a href="${url}" target="_blank" rel="noopener" class="co-tt-proc co-tt-link ${cls}">${num}${name}${pdur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}">${num}${name}${pdur}</div>`;
  }).join('');
  return hdr + details + historyTitle + `<div class="co-tt-procs">${procs}</div>` + reportSlot;
}

function _posTooltipAt(clientX, clientY) {
  if (!_ganttTooltip) return;
  const pad = 14;
  let x = clientX + pad, y = clientY + pad;
  const w = _ganttTooltip.offsetWidth  || 250;
  const h = _ganttTooltip.offsetHeight || 120;
  if (x + w > window.innerWidth  - 8) x = clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = clientY - h - pad;
  _ganttTooltip.style.left = `${x}px`;
  _ganttTooltip.style.top  = `${y}px`;
}

async function _showPassTooltip(e, pass) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  const grafanaHost = _grafanaHost();
  _ganttTooltip.innerHTML     = _passTooltipHTML(pass, grafanaHost);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
  // Async: resolve procedure-execution report, inject when ready
  if (!pass.future && grafanaHost) {
    const startMs = pass.start instanceof Date ? pass.start.getTime() : pass.start;
    const endMs   = pass.end   instanceof Date ? pass.end.getTime()   : pass.end;
    fetchProcedureReport(grafanaHost, startMs, endMs).then(report => {
      if (_ganttTooltip.style.display === 'none') return;
      const slot = _ganttTooltip.querySelector('.proc-report-slot');
      if (slot) { slot.outerHTML = procedureReportHTML(report); _posTooltipAt(_ttAnchorX, _ttAnchorY); }
    });
  }
  // Eb/N0 series and polar coords are fetched in parallel, but injected and
  // cursor-linked together — the shared hover needs both charts in the DOM at
  // once, so neither pops in independently ahead of the other.
  const sat = store.trackedSat;
  const pStartMs = pass.start instanceof Date ? pass.start.getTime() : pass.start;
  const pEndMs   = pass.end   instanceof Date ? pass.end.getTime()   : pass.end;
  const ebn0Promise = (!pass.future && sat?.noradId)
    ? fetchEbn0Series(sat.noradId, pStartMs, pEndMs, pass.network)
    : Promise.resolve(null);
  const coordsPromise = sat?.satrec
    ? fetchPassGsCoords(sat, pass, store.groundStations)
    : Promise.resolve(null);

  const [series, coords] = await Promise.all([ebn0Promise, coordsPromise]);
  if (_ganttTooltip.style.display === 'none') return;

  let polarPoints = null, markers = null;
  const polarSlot = _ganttTooltip.querySelector('.polar-slot');
  if (coords && polarSlot) {
    polarSlot.outerHTML = buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask);
    polarPoints = computePolarPoints(pass, sat, coords.lat, coords.lon);
    markers = computePolarMarkers(polarPoints, coords.rxMask);
  }
  const polarEl = _ganttTooltip.querySelector('.pass-polar');

  const ebn0Slot = _ganttTooltip.querySelector('.ebn0-slot');
  if (ebn0Slot) ebn0Slot.outerHTML = ebn0HTML(series, markers, pass.procedures, { t0: pStartMs, t1: pEndMs });
  const ebn0El = _ganttTooltip.querySelector('.ebn0-chart');

  _posTooltipAt(_ttAnchorX, _ttAnchorY); // re-anchor: tooltip may now be taller
  wireLinkedCursor(polarEl, polarPoints, ebn0El, series, pass.procedures);
}

function _hidePassTooltipSoon() {
  clearTimeout(_ttHideTimer);
  _ttHideTimer = setTimeout(() => { if (_ganttTooltip) _ganttTooltip.style.display = 'none'; }, 300);
}

// ── TMR gap tooltip (anchored at the cursor, like the pass tooltip) ──
function _fmtGapDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function _gapTooltipHTML(gap) {
  const start = new Date(gap.start);
  const end   = new Date(gap.end);
  const hdr   = `<div class="co-tt-header">TMR GAP · ${_fmtGapDuration(end - start)}</div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">FROM</span>${_fmtDT(start)}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">TO</span>${_fmtDT(end)}</div>`;
  const btn   = `<button type="button" class="co-tt-gap-btn">Download Gap TMR</button>`;
  return hdr + times + btn;
}

function _showGapTooltip(e, gap, sat) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _ganttTooltip.innerHTML     = _gapTooltipHTML(gap);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
  const btn = _ganttTooltip.querySelector('.co-tt-gap-btn');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled    = true;
    btn.textContent = 'Requesting…';
    try {
      const { linkEstablished } = await requestTmrGapDownload(sat, gap);
      showActionToast(linkEstablished
        ? 'TM/TC link + TMR gap download scheduled on the next pass.'
        : 'TMR gap download scheduled on the next pass.');
    } catch (err) {
      showActionToast(`Request failed: ${err.message}`);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Download Gap TMR';
    }
  });
}

// Measured pixel offsets from gantt left/right edges to track start/end — set by _alignGantt()
let _ganttL = 68;
let _ganttR = 8;

// Drag-to-pan state
let _pan = null; // { startX, startViewStart, startViewEnd, trackW }

function _beginPan(clientX, trackW) {
  _pan = { startX: clientX, startViewStart: viewStartSec, startViewEnd: viewEndSec, trackW };
}
function _movePan(clientX) {
  if (!_pan) return;
  const dx  = clientX - _pan.startX;
  const span = _pan.startViewEnd - _pan.startViewStart;
  const dSec = -(dx / _pan.trackW) * span;
  viewStartSec = _pan.startViewStart + dSec;
  viewEndSec   = _pan.startViewEnd   + dSec;
  _scheduleApplyView();
}
function _endPan() { _pan = null; }

// pointermove (and rapid trackpad wheel ticks) can fire far more often than
// the display refreshes — without this, every single event triggered a full
// innerHTML rebuild of all four gantt rows (TMR/Passes/Eclipse/STT) plus
// re-wiring every pass bar's hover/click listeners, well over 60×/sec during
// a drag. Coalesces any burst within one frame into a single rebuild using
// whatever view range is current when the frame actually renders.
let _applyViewRaf = null;
function _scheduleApplyView() {
  if (_applyViewRaf) return;
  _applyViewRaf = requestAnimationFrame(() => {
    _applyViewRaf = null;
    _applyView();
  });
}

function _viewSpan()    { return viewEndSec - viewStartSec; }
function _viewStartMs() { return EPOCH.getTime() + viewStartSec * 1000; }
function _viewRangeMs() { return _viewSpan() * 1000; }

function formatDisplay(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getUTCDate())}-${p(date.getUTCMonth() + 1)}-${date.getUTCFullYear()} `
       + `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

function parseDisplay(str) {
  // Accepts "DD-MM-YYYY HH:MM:SS" or "DD-MM-YYYY HH:MM"
  const m = str.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, dd, mo, yyyy, hh, mm, ss = '0'] = m;
  const d = new Date(Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mm, +ss));
  return isNaN(d) ? null : d;
}

function applyTime() {
  const t = new Date(EPOCH.getTime() + scrubOffsetSec * 1000);
  store.setTime(t);
  // Keep scrubber thumb within the current view (it may be clamped by browser if outside range)
  scrub.value = Math.max(viewStartSec, Math.min(viewEndSec, scrubOffsetSec));
  nowBtn.classList.toggle('active', Math.abs(scrubOffsetSec) < 2);
  if (document.activeElement !== dateInput) {
    dateInput.value = formatDisplay(t);
  }
  _updateGanttCursor();
}

function tick(ts) {
  if (!playing) return;
  if (lastTs !== null) {
    const dt = (ts - lastTs) / 1000;
    scrubOffsetSec += dt * speed;
    scrubOffsetSec = Math.max(-MAX_SPAN_SEC / 2, Math.min(MAX_SPAN_SEC / 2, scrubOffsetSec));
    applyTime();
  }
  lastTs = ts;
  lastRaf = requestAnimationFrame(tick);
}

function startPlay() {
  playing = true;
  lastTs = null;
  playBtn.textContent = '⏸';
  playBtn.classList.add('playing');
  lastRaf = requestAnimationFrame(tick);
}

function stopPlay() {
  playing = false;
  playBtn.textContent = '▶';
  playBtn.classList.remove('playing');
  if (lastRaf) cancelAnimationFrame(lastRaf);
}

function step(deltaSec) {
  stopPlay();
  scrubOffsetSec = Math.max(-MAX_SPAN_SEC / 2, Math.min(MAX_SPAN_SEC / 2, scrubOffsetSec + deltaSec));
  applyTime();
}

// ── Gantt helpers ────────────────────────────────────────────────────────────

function _renderBars(container, windows, color, shadow = '') {
  if (!container) return;
  container.innerHTML = '';
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();
  for (const { start, end } of windows) {
    const l  = (start - tMin) / rangeMs * 100;
    const r  = (end   - tMin) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    bar.className        = 'gantt-bar';
    bar.style.left       = `${lc.toFixed(3)}%`;
    bar.style.width      = `${(rc - lc).toFixed(3)}%`;
    bar.style.background = color;
    if (shadow) bar.style.boxShadow = shadow;
    container.appendChild(bar);
  }
}

function _alignGantt() {
  if (!scrub || !ganttEl) return;
  const sr = scrub.getBoundingClientRect();
  const gr = ganttEl.getBoundingClientRect();
  _ganttL = Math.round(sr.left - gr.left);
  _ganttR = Math.round(gr.right - sr.right);
  ganttEl.style.setProperty('--track-ml', `${_ganttL}px`);
  ganttEl.style.setProperty('--track-mr', `${_ganttR}px`);
  _updateGanttRuler();
  _updateGanttCursor();
}

function _updateGanttCursor() {
  if (!ganttCursor || !ganttEl) return;
  const f = (scrubOffsetSec - viewStartSec) / _viewSpan();
  const trackW = ganttEl.offsetWidth - _ganttL - _ganttR;
  ganttCursor.style.left = `${(_ganttL + f * trackW).toFixed(1)}px`;
}

// Render pass bars with per-bar tooltip events
function _renderGanttPasses() {
  if (!ganttPasses) return;
  ganttPasses.innerHTML = '';
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();
  for (const { start, end, pass } of _passWindows) {
    const l  = (start - tMin) / rangeMs * 100;
    const r  = (end   - tMin) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    bar.className       = 'gantt-bar';
    bar.style.left      = `${lc.toFixed(3)}%`;
    bar.style.width     = `${(rc - lc).toFixed(3)}%`;
    bar.style.background = '#ff3060';
    bar.style.boxShadow  = '0 0 8px #ff306099';
    if (pass) {
      bar.addEventListener('mouseenter', e => _showPassTooltip(e, pass));
      bar.addEventListener('mouseleave', _hidePassTooltipSoon);
      if (!pass.future) {
        const gh = _grafanaHost();
        if (gh) {
          const start = pass.start instanceof Date ? pass.start : new Date(pass.start);
          const end   = pass.end   instanceof Date ? pass.end   : new Date(pass.end);
          bar.style.cursor = 'pointer';
          bar.addEventListener('click', () => {
            window.open(_grafanaLokiUrl(gh, start.getTime() - 30000, end.getTime() + 30000), '_blank', 'noopener');
          });
        }
      }
    }
    ganttPasses.appendChild(bar);
  }
}
function _renderGanttEclipse() {
  if (ganttEclipse) ganttEclipse.style.background = '#e6b800aa'; // bright sun-yellow
  _renderBars(ganttEclipse, _eclipseWindows, '#2244cc', '0 0 8px #4466ffcc');
}

function _renderGanttStt() {
  _renderBars(ganttStt,  _sttFusedWindows,         '#ff3030', '0 0 8px #ff6060cc');
  _renderBars(ganttStt1, _sttPerConeWindows[0] ?? [], '#ff3030', '0 0 8px #ff6060cc');
  _renderBars(ganttStt2, _sttPerConeWindows[1] ?? [], '#ff3030', '0 0 8px #ff6060cc');
}

// STT1/STT2 detail rows show only when the "STT" fused row is expanded, AND
// (for STT2) only when the tracked satellite's model actually has a second
// unit (12U has one, FF has two) — called on expand/collapse toggle and
// whenever the tracked satellite (or its model) changes.
let _sttDetailExpanded = false;
function _refreshSttRowVisibility() {
  const cones = MODEL_STAR_TRACKERS[store.trackedSat?.model] ?? MODEL_STAR_TRACKERS['12U'];
  const showStt1 = _sttDetailExpanded;
  const showStt2 = _sttDetailExpanded && cones.length > 1;
  ganttStt1Row?.classList.toggle('gantt-collapsed', !showStt1);
  ganttStt2Row?.classList.toggle('gantt-collapsed', !showStt2);
}

function _renderGanttTmr() {
  if (!ganttTmr) return;
  ganttTmr.innerHTML = '';
  ganttTmr.style.background = '';  // reset
  const sat = store.trackedSat;
  const tmr = sat ? store.satTmr[sat.id] : null;
  if (!tmr) return;

  const { rangeStart, rangeEnd, gapWindows } = tmr;
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();

  // Green coverage bar spanning the queried range
  const lCov  = (rangeStart - tMin) / rangeMs * 100;
  const rCov  = (rangeEnd   - tMin) / rangeMs * 100;
  const lcCov = Math.max(0, lCov);
  const rcCov = Math.min(100, rCov);
  if (rcCov - lcCov > 0.01) {
    const cov = document.createElement('div');
    cov.className        = 'gantt-bar';
    cov.style.left       = `${lcCov.toFixed(3)}%`;
    cov.style.width      = `${(rcCov - lcCov).toFixed(3)}%`;
    cov.style.background = '#00cc66';
    cov.style.boxShadow  = '0 0 6px #00cc6666';
    ganttTmr.appendChild(cov);
  }

  // Dark overlay bars for gap periods — appended directly, never clears the green bar
  for (const { start, end } of gapWindows) {
    const l  = (start - tMin) / rangeMs * 100;
    const r  = (end   - tMin) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    bar.className        = 'gantt-bar gantt-bar-gap';
    bar.style.left       = `${lc.toFixed(3)}%`;
    bar.style.width      = `${(rc - lc).toFixed(3)}%`;
    bar.style.background = '#12121e';
    bar.addEventListener('mouseenter', e => _showGapTooltip(e, { start, end }, sat));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    ganttTmr.appendChild(bar);
  }
}

// ── Date ruler ───────────────────────────────────────────────────────────────

const _TICK_INTERVALS_MS = [
  60_000, 300_000, 600_000, 1_800_000, 3_600_000,
  7_200_000, 10_800_000, 21_600_000, 43_200_000,
  86_400_000, 172_800_000, 604_800_000,
];

function _tickInterval(spanMs) {
  const ideal = spanMs / 8;
  let best = _TICK_INTERVALS_MS[0];
  for (const t of _TICK_INTERVALS_MS) { if (t <= ideal) best = t; else break; }
  return best;
}

function _fmtTick(ms, spanMs) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (spanMs > 7 * 86_400_000)
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  if (spanMs > 86_400_000)
    return `${d.getUTCDate()}/${d.getUTCMonth()+1} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  if (spanMs > 3_600_000)
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function _updateGanttRuler() {
  if (!ganttRuler) return;
  ganttRuler.innerHTML = '';
  const rangeMs  = _viewRangeMs();
  const tMin     = _viewStartMs();
  const interval = _tickInterval(rangeMs);
  const first    = Math.ceil(tMin / interval) * interval;
  for (let t = first; t <= tMin + rangeMs; t += interval) {
    const pct = ((t - tMin) / rangeMs * 100).toFixed(3);
    const tick = document.createElement('div');
    tick.className  = 'gantt-tick';
    tick.style.left = `${pct}%`;
    const lbl = document.createElement('div');
    lbl.className   = 'gantt-tick-label';
    lbl.style.left  = `${pct}%`;
    lbl.textContent = _fmtTick(t, rangeMs);
    ganttRuler.appendChild(tick);
    ganttRuler.appendChild(lbl);
  }
}

// Build pass windows from store then render
function _updateGanttPasses() {
  const sat = store.trackedSat;
  const passes = sat ? (store.satPasses[sat.id] ?? []) : [];
  _passWindows = passes.map(p => ({
    start: (p.start instanceof Date ? p.start : new Date(p.start)).getTime(),
    end:   (p.end   instanceof Date ? p.end   : new Date(p.end)).getTime(),
    pass:  p,
  }));
  _renderGanttPasses();
}

// Compute eclipse + STT-blinding windows for a fixed ±14-day range then render.
// Both share the same propagate()/sunDirectionECI() per-step results — STT
// blinding just adds a couple of dot products + one acos + one asin on top
// of samples already being computed for the eclipse line, so it's a small
// fraction of extra work, not extra propagate() calls.
// ±14-day span ÷ 5-min step ≈ 8065 SGP4 propagations — run as one flat loop
// this was a single uninterrupted ~40-160ms main-thread stall (visible as a
// hitch) every time the tracked satellite changed or "Now" was pressed. This
// generator does the exact same work but yields after each sample, so a
// runner (_runEclipseChunk) can process it in ~8ms time-sliced bursts across
// multiple ticks instead of one blocking burst — same total work, but no
// single frame gets blocked long enough to be noticeable.
function* _eclipseSttWork(sat) {
  const tMin = EPOCH.getTime() - ECLIPSE_HALF_SEC * 1000;
  const tMax = EPOCH.getTime() + ECLIPSE_HALF_SEC * 1000;
  const STEP = 5 * 60 * 1000;
  const windows = [];
  let inEcl = false, wStart = 0;

  const cones = MODEL_STAR_TRACKERS[sat.model] ?? MODEL_STAR_TRACKERS['12U'];
  const coneStates = cones.map(() => ({ in: false, start: 0, windows: [] }));
  let fusedIn = false, fusedStart = 0;
  const fusedWindows = [];
  const sunExclDeg   = satSunExclDeg(sat.noradId);
  const earthExclDeg = satEarthExclDeg(sat.noradId);

  const d = new Date();
  for (let t = tMin; t <= tMax; t += STEP) {
    d.setTime(t);
    const r = propagate(sat.satrec, d);
    if (r) {
      const sunDir = sunDirectionECI(d);
      const ecl = isInEclipse(r.eciPos, sunDir);
      if (ecl && !inEcl)      { wStart = t; inEcl = true; }
      else if (!ecl && inEcl) { windows.push({ start: wStart, end: t }); inEcl = false; }

      const blindedFlags = cones.map(cfg => _isConeBlinded(r.eciPos, sunDir, cfg, sunExclDeg, earthExclDeg));
      blindedFlags.forEach((blinded, i) => {
        const cs = coneStates[i];
        if (blinded && !cs.in)      { cs.start = t; cs.in = true; }
        else if (!blinded && cs.in) { cs.windows.push({ start: cs.start, end: t }); cs.in = false; }
      });
      // Fused = STT1 OR STT2 availability — blinded only when EVERY cone is
      // simultaneously blinded (system stays usable as long as one unit isn't).
      const allBlinded = blindedFlags.every(b => b);
      if (allBlinded && !fusedIn)      { fusedStart = t; fusedIn = true; }
      else if (!allBlinded && fusedIn) { fusedWindows.push({ start: fusedStart, end: t }); fusedIn = false; }
    }
    yield;
  }
  if (inEcl) windows.push({ start: wStart, end: tMax });
  coneStates.forEach(cs => { if (cs.in) cs.windows.push({ start: cs.start, end: tMax }); });
  if (fusedIn) fusedWindows.push({ start: fusedStart, end: tMax });

  _eclipseWindows    = windows;
  _sttPerConeWindows = coneStates.map(cs => cs.windows);
  _sttFusedWindows   = fusedWindows;
}

let _eclipseGen = null; // the in-flight generator, if any — identity-checked below to detect supersession

function _runEclipseChunk(gen) {
  if (_eclipseGen !== gen) return; // a newer satellite switch superseded this job — abandon quietly
  const budgetStart = performance.now();
  let result;
  do { result = gen.next(); } while (!result.done && performance.now() - budgetStart < 8);
  if (result.done) {
    _eclipseGen = null;
    _renderGanttEclipse();
    _refreshSttRowVisibility();
    _renderGanttStt();
    _eclipseJobSat = null;
  } else {
    setTimeout(() => _runEclipseChunk(gen), 0);
  }
}

function _updateGanttEclipse() {
  const sat = store.trackedSat;
  if (!sat?.satrec || !ganttEclipse) return;
  if (_eclipseJobSat === sat.noradId) return;
  _eclipseJobSat = sat.noradId;
  const gen = _eclipseSttWork(sat);
  _eclipseGen = gen;
  setTimeout(() => _runEclipseChunk(gen), 0);
}

// Re-render all gantt layers and update scrubber range for the current view
function _applyView() {
  scrub.min = viewStartSec;
  scrub.max = viewEndSec;
  _renderGanttTmr();
  _renderGanttPasses();
  _renderGanttEclipse();
  _renderGanttStt();
  _updateGanttRuler();
  _updateGanttCursor();
}

// Wheel zoom: keep the time under the mouse cursor fixed, rescale the window
function _onWheel(e) {
  e.preventDefault();
  const sr     = scrub.getBoundingClientRect();
  const f      = Math.max(0, Math.min(1, (e.clientX - sr.left) / sr.width));
  const pivot  = viewStartSec + f * _viewSpan();
  const factor = e.deltaY < 0 ? 0.6 : 1 / 0.6;
  const newSpan = Math.max(MIN_SPAN_SEC, Math.min(MAX_SPAN_SEC, _viewSpan() * factor));
  viewStartSec = pivot - f * newSpan;
  viewEndSec   = pivot + (1 - f) * newSpan;
  _scheduleApplyView();
}

export function initTimePlayer() {
  ganttSttCollapseBtn?.addEventListener('click', () => {
    _sttDetailExpanded = !_sttDetailExpanded;
    ganttSttCollapseBtn.textContent = _sttDetailExpanded ? '▾' : '▸';
    _refreshSttRowVisibility();
    _syncLayout(); // row count changed → gantt height changed → resync offset
  });

  playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

  nowBtn.addEventListener('click', () => {
    EPOCH.setTime(Date.now());
    _eclipseJobSat = null;
    scrubOffsetSec = 0;
    viewStartSec = -604800;
    viewEndSec   =  604800;
    applyTime();
    _applyView();
    _updateGanttEclipse();
    if (!playing) startPlay();
  });

  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); });

  scrub.addEventListener('input', () => {
    stopPlay();
    scrubOffsetSec = Number(scrub.value);
    applyTime();
  });

  // Step buttons (−1d, −1h, +1h, +1d)
  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => step(Number(btn.dataset.step)));
  });

  // Manual date jump — parse DD-MM-YYYY HH:MM:SS on Enter or blur
  const commitDateInput = () => {
    const parsed = parseDisplay(dateInput.value);
    if (!parsed) { dateInput.value = formatDisplay(new Date(EPOCH.getTime() + scrubOffsetSec * 1000)); return; }
    stopPlay();
    scrubOffsetSec = (parsed.getTime() - EPOCH.getTime()) / 1000;
    scrubOffsetSec = Math.max(-604800, Math.min(604800, scrubOffsetSec));
    applyTime();
  };
  dateInput.addEventListener('blur',    commitDateInput);
  dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitDateInput(); dateInput.blur(); } });

  // Scale slider + field
  const applyScale = (raw) => {
    const v = Math.max(1, Math.min(1000, Math.round(+raw) || 500));
    scaleSlider.value = v;
    scaleField.value  = v;
    store.setScale(v);
  };
  scaleSlider.addEventListener('input',  () => applyScale(scaleSlider.value));
  scaleField.addEventListener('change',  () => applyScale(scaleField.value));
  scaleField.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyScale(scaleField.value); });

  // Repaint gantt when passes or tracked satellite change
  store.subscribe(key => {
    if (key === 'satPasses' || key === 'trackedSatId') {
      _updateGanttPasses();
      _triggerTmr();
    }
    if (key === 'trackedSatId') {
      if (ganttTmr)  ganttTmr.innerHTML  = '';
      if (ganttStt)  ganttStt.innerHTML  = '';
      if (ganttStt1) ganttStt1.innerHTML = '';
      if (ganttStt2) ganttStt2.innerHTML = '';
      _eclipseJobSat = null;
      _refreshSttRowVisibility();
      _updateGanttEclipse();
      // ResizeObserver handles _syncLayout when gantt visibility/height changes
    }
    if (key === 'tmrData') {
      _renderGanttTmr();
    }
  });
  _updateGanttPasses();
  _updateGanttEclipse();

  // TMR fetch helper — debounced so rapid satPasses updates don't abort each other
  const _triggerTmr = () => {
    const sat = store.trackedSat;
    if (!sat) return;
    const past = (store.satPasses[sat.id] ?? []).filter(p => !p.future);
    if (!past.length) return;
    scheduleTmrFetch(sat, past, windows => store.setTmrWindows(sat.id, windows));
  };
  _triggerTmr(); // also run on init in case passes are already loaded

  // Wheel zoom on scrubber or gantt
  scrub.addEventListener('wheel',   _onWheel, { passive: false });
  ganttEl?.addEventListener('wheel', _onWheel, { passive: false });

  // Drag-to-pan on gantt (skip the collapse toggle buttons)
  ganttEl?.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target === ganttToggleBtn || e.target === ganttSttCollapseBtn) return;
    e.preventDefault();
    ganttEl.setPointerCapture(e.pointerId);
    ganttEl.style.cursor = 'grabbing';
    _beginPan(e.clientX, ganttEl.offsetWidth - _ganttL - _ganttR);
  });
  ganttEl?.addEventListener('pointermove', e => { if (_pan) _movePan(e.clientX); });
  ganttEl?.addEventListener('pointerup',   () => { _endPan(); ganttEl.style.cursor = ''; });
  ganttEl?.addEventListener('pointercancel', () => { _endPan(); ganttEl.style.cursor = ''; });

  // Drag-to-pan on the time player scrub track
  const scrubWrap = scrub.parentElement;
  scrubWrap?.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target === scrub) return;
    e.preventDefault();
    scrubWrap.setPointerCapture(e.pointerId);
    scrubWrap.style.cursor = 'grabbing';
    _beginPan(e.clientX, scrub.offsetWidth);
  });
  scrubWrap?.addEventListener('pointermove', e => { if (_pan) _movePan(e.clientX); });
  scrubWrap?.addEventListener('pointerup',   () => { _endPan(); scrubWrap.style.cursor = ''; });
  scrubWrap?.addEventListener('pointercancel', () => { _endPan(); scrubWrap.style.cursor = ''; });

  // Pass tooltip element — reuses .co-tooltip CSS from ChadOps
  _ganttTooltip = document.createElement('div');
  _ganttTooltip.className   = 'co-tooltip';
  _ganttTooltip.style.display = 'none';
  document.body.appendChild(_ganttTooltip);
  _ganttTooltip.addEventListener('mouseenter', () => clearTimeout(_ttHideTimer));
  _ganttTooltip.addEventListener('mouseleave', _hidePassTooltipSoon);


  // Gantt collapse toggle
  ganttToggleBtn?.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('gantt-collapsed');
    if (ganttToggleBtn) ganttToggleBtn.textContent = collapsed ? '▼' : '▲';
    // ResizeObserver handles the layout sync after height changes
  });

  // ResizeObserver fires whenever the gantt's actual rendered height changes
  // (initial layout, collapse/expand, content updates) — no rAF race condition
  if (ganttEl) new ResizeObserver(_syncLayout).observe(ganttEl);

  // Keep window resize for gantt track alignment (scrubber position-dependent)
  window.addEventListener('resize', () => { _alignGantt(); _syncLayout(); });

  speed = Number(speedSel.value);
  applyTime();
  startPlay();
}
