// Scheduler (new feature, step 1 of several to come) — a dedicated tab that
// operates on one satellite + one pass at a time, same shape as
// PassAnalyzer.js's own _currentSat/_selectedPass state. This first slice is
// the picker: choose a satellite, see its Eclipse/Pass/Plan/TMR gantt (the
// same rows TimePlayer.js's own live gantt draws, minus STT — this view has
// no scrubber to make that meaningful against), click a pass to select it.
// Later features build on top of the module state below.
import { store } from '../store.js';
import { propagate } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { schedulePlanFetch } from '../planData.js';
import { scheduleTmrFetch, TMR_SOURCES } from '../tmrData.js';
import { requestTmrGapDownload, findMatchingGapProcedure, fetchNextPassProcedures, TMTC_LINK_TEMPLATE } from '../tmrGapDownload.js';
import { satSubsystemOrigin } from '../satSubsystems.js';
import { satIsSimulated, satEffectiveNow, hasSatTimeOffset } from '../satSimu.js';
import { fetchTcPackets, matchScheduledTargets, collectArguments, argUnitLabel, TC_114_NAME_RE, tcAckStatus } from '../tcPackets.js';
import { fetchTmPacket, extractTmParam } from '../satTelemetry.js';
import {
  fmtDuration, fmtTimeOnly, passSimpleTooltipContent, positionTooltip,
  hydratePassGeometry, hydrateScheduledProcedures, hydratePassStatusDots, passEclipseBarHTML, passGeometryHTML,
} from './passTooltip.js';
import { escapeHtml } from './logView.js';
import { fetchPassGsCoords, computePolarPoints, computePolarMarkers } from './passPolar.js';
import { fetchScheduledProcedures, invalidateScheduledProcedures, invalidateAllScheduledProcedures } from './scheduledProcedures.js';
import { fetchProcedureCatalog, scheduleProcedure, unscheduleProcedure, reorderScheduledProcedure } from './procedureCatalog.js';
import { showActionToast, showWarningToast } from './actionToast.js';

// ±5 days — matches satPasses.js's own fetch window exactly, so the Pass row
// never claims to show a span it doesn't actually have data for. Eclipse and
// Plan are computed/fetched against this SAME window once per satellite
// selection (see _selectSatellite) rather than recomputed on every render,
// both because eclipse propagation isn't free (see _scheduleEclipseWork's own
// comment) and so all three rows stay aligned to one frozen time axis instead
// of each drifting against its own idea of "now".
const WINDOW_MS = 5 * 24 * 3_600_000;

// Same outcome→color mapping ChadOps.js's _passDots uses for its own pass
// dots (not exported there, so duplicated here — same precedent as
// SatInfo.js's _monCls/_currentPass already set for this exact situation).
const _OUTCOME_COLOR = { SUCCESS: '#44dd88', FAILURE: '#ff4466', CANCELLED: '#ff8c00' };
const _FUTURE_COLOR  = '#556688';

// Same plan-status palette TimePlayer.js's own _planColor uses (not exported
// there either).
const _PLAN_STATUS_COLOR = {
  DRAFT:      '#8a8a9e',
  RELEASED:   '#5ec8ff',
  SUBMITTED:  '#1e4d8c',
  ACTIVATED:  '#ff9500',
  TERMINATED: '#ff4d4d',
};
const _PLAN_DEFAULT_COLOR = '#8a8a9e';

// ── Pass/Plan hover tooltips ───────────────────────────────────────
//
// Same co-tooltip singleton + show/hide-soon rhythm as TimePlayer.js's own
// gantt tooltip (_ganttTooltip there). The Pass tooltip reuses
// passSimpleTooltipContent/hydratePassGeometry/hydrateScheduledProcedures
// directly — those are genuinely shared exports, already used by ChadOps.js
// and TimePlayer.js for this exact same content, and (being shared) still
// format dates via passTooltip.js's own fmtDateTimeShort. Every OTHER
// timestamp on this tab — Plan/Eclipse/TMR-gap tooltips, the pass list, the
// selected-pass card, the hover crosshair — is this file's own markup, so it
// uses _fmtDT below instead: dd/mm/yyyy HH:mm:ss, per Victor's own
// preference for this tab specifically (not applied to fmtDateTimeShort
// itself, which would silently reformat Fleet/Visualizer/Agenda too).
let _tooltipEl   = null;
let _ttHideTimer = null;

// Same shape as TimePlayer.js's own (private, not exported) _fmtDT — just
// dd/mm/yyyy instead of dd-mm-yyyy. _fmtDTInput is the same thing minus the
// " UTC" suffix — used for the editable date/time argument field
// (_procArgRowHTML) where a trailing unit label would just be noise to type
// around, not a display label.
function _fmtDTInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function _fmtDT(d) {
  if (!d) return '—';
  return `${_fmtDTInput(d)} UTC`;
}

// Compact date for the "All passes" list row (.sch-pass-list-date) — dd/mm
// HH:mm:ss, no year (that list is a fixed ±5-day window around today, so the
// year is never in doubt) and no " UTC" suffix (implicit, same as every
// other timestamp on this tab). .sch-pass-list-date/-dur are flex-shrink:0
// in that row, so the ONLY column that can absorb a long date string is
// .sch-pass-list-stn — freeing these characters is what lets the station/
// antenna name actually render instead of being ellipsis-clipped to one
// letter (see .sch-pass-list-stn's own comment in style.css).
function _fmtDTCompact(d) {
  if (!d) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function _hideTooltipSoon() {
  clearTimeout(_ttHideTimer);
  _ttHideTimer = setTimeout(() => { if (_tooltipEl) _tooltipEl.style.display = 'none'; }, 300);
}

function _showPassTooltip(e, pass, sat) {
  if (!_tooltipEl) return;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a pass, not a gap
  _tooltipEl.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _tooltipEl.innerHTML     = passSimpleTooltipContent(pass, sat);
  _tooltipEl.style.display = 'block';
  positionTooltip(e, _tooltipEl);
  hydratePassGeometry(_tooltipEl, e, pass, sat);
  hydrateScheduledProcedures(_tooltipEl, pass, sat);
  hydratePassStatusDots(_tooltipEl, pass, sat);
}

// `comments` is a JSON-encoded string (pass-geometry metadata) — parsed into
// readable "key: value" pairs when it's actually JSON, shown as-is otherwise
// rather than a raw escaped blob. Same as TimePlayer.js's own _formatPlanComment.
function _formatPlanComment(raw) {
  if (!raw) return '—';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
  } catch { /* not JSON — fall through to raw text */ }
  return raw;
}

function _planTooltipHTML(plan) {
  // Same color the bar itself uses, so the pill and the bar always agree.
  const c    = _PLAN_STATUS_COLOR[plan.status] ?? _PLAN_DEFAULT_COLOR;
  const pill = `<span class="co-pill" style="background:${c}22; color:${c}; border:1px solid ${c}66;">${escapeHtml(plan.status ?? '—')}</span>`;
  const hdr   = `<div class="co-tt-header">PLAN ${pill}</div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">FROM</span>${_fmtDT(new Date(plan.start))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">TO</span>${_fmtDT(new Date(plan.end))}</div>`;
  const rows = [
    ['REC',  plan.recipient ?? '—'],
    ['KEY',  plan.key ?? '—'],
    ['NOTE', _formatPlanComment(plan.comments)],
  ].map(([lbl, val]) => `<div class="co-tt-time-row"><span class="co-tt-time-lbl">${lbl}</span>${escapeHtml(String(val))}</div>`).join('');
  return hdr + times + rows;
}

function _showPlanTooltip(e, plan) {
  if (!_tooltipEl) return;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a plan, not a gap
  _tooltipEl.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _tooltipEl.innerHTML     = _planTooltipHTML(plan);
  _tooltipEl.style.display = 'block';
  positionTooltip(e, _tooltipEl);
}

// Same shape as _planTooltipHTML — start/end/duration for one shadow window.
function _eclipseTooltipHTML(win) {
  const hdr   = `<div class="co-tt-header">ECLIPSE <span class="co-pill" style="background:#2244cc22; color:#6a8fff; border:1px solid #2244cc66;">UMBRA</span></div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">FROM</span>${_fmtDT(new Date(win.start))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">TO</span>${_fmtDT(new Date(win.end))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(win.end - win.start)}</div>`;
  return hdr + times;
}

function _showEclipseTooltip(e, win) {
  if (!_tooltipEl) return;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows an eclipse window, not a gap
  _tooltipEl.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _tooltipEl.innerHTML     = _eclipseTooltipHTML(win);
  _tooltipEl.style.display = 'block';
  positionTooltip(e, _tooltipEl);
}

// Same gap-download button/SCC-match "pending" status as TimePlayer.js's own
// _gapTooltipHTML — this view used to be read-only here, but there's no
// actual reason a gap found in the Scheduler tab shouldn't be actionable the
// same way it is from the live gantt, so this now mirrors that behavior
// (button/cache/click-handler all duplicated below, same "not exported
// there either" precedent the rest of this file already follows for
// TimePlayer.js internals).
function _passLabel(pass) {
  if (!pass) return '—';
  return pass.groundStationId ? `${pass.groundStationId} (${_fmtDT(pass.start)})` : _fmtDT(pass.start);
}

function _tmrGapTooltipHTML(gap, match, pass) {
  const urgency     = _tmrGapUrgency(gap);
  const urgencyHtml = urgency
    ? `<div class="co-tt-gap-status co-tt-gap-${urgency}">${urgency === 'lost'
        ? 'Past the ~3-day onboard TM buffer limit — likely already overwritten onboard.'
        : 'Approaching the ~3-day onboard TM buffer limit.'}</div>`
    : '';
  const hdr   = `<div class="co-tt-header">TMR GAP</div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">FROM</span>${_fmtDT(new Date(gap.start))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">TO</span>${_fmtDT(new Date(gap.end))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(gap.end - gap.start)}</div>`;
  if (match) {
    const status = `<div class="co-tt-gap-status">TMR was requested in pass ${_passLabel(pass)}</div>`;
    const btn = `<button type="button" class="co-tt-gap-btn" disabled>Download Gap TMR</button>`;
    return hdr + times + status + urgencyHtml + btn;
  }
  const btn = `<button type="button" class="co-tt-gap-btn">Download Gap TMR</button>`;
  return hdr + times + urgencyHtml + btn;
}

// Ground truth for "is this requested?" is SCC's own scheduled-procedures
// list on the satellite's next pass (see tmrGapDownload.js's
// fetchNextPassProcedures/findMatchingGapProcedure) — not a local flag —
// same cache shape as TimePlayer.js's own _sccPassCache (duplicated, not
// shared, since that one is module-private there too). Cached per satellite:
// all of a satellite's gaps share the same "next pass", so one fetch serves
// every gap via the pure, no-network findMatchingGapProcedure.
const SCC_CHECK_TTL_MS = 30_000;
const _sccPassCache = new Map(); // satId → { atMs, data: {pass, scheduled} | null }
let _openGapTooltip = null; // { gap, sat, source } while a gap tooltip is visible — lets a background refresh patch it in place

// Returns whatever's currently cached (possibly stale, possibly null if never
// fetched) and, if it's stale/forced, kicks off a background refresh that
// re-renders the TMR rows and the open gap tooltip (if any) once it resolves.
function _getSccPassCheck(sat, { forceRefresh = false } = {}) {
  const cached = _sccPassCache.get(sat.id);
  const stale  = !cached || (Date.now() - cached.atMs) > SCC_CHECK_TTL_MS;
  if (forceRefresh || stale) {
    // Stamp "in flight" now so concurrent callers within this same render
    // pass (one per gap) don't each trigger their own redundant fetch.
    _sccPassCache.set(sat.id, { atMs: Date.now(), data: cached?.data ?? null });
    fetchNextPassProcedures(sat).then(data => {
      _sccPassCache.set(sat.id, { atMs: Date.now(), data });
      _renderGanttTmrRows();
      if (_openGapTooltip?.sat.id === sat.id && _tooltipEl.style.display !== 'none') {
        _renderGapTooltip(_openGapTooltip.gap, _openGapTooltip.sat, _openGapTooltip.source);
        positionTooltip({ clientX: _ttAnchorX, clientY: _ttAnchorY }, _tooltipEl);
      }
    });
  }
  return cached?.data ?? null;
}

function _renderGapTooltip(gap, sat, source) {
  const data  = _sccPassCache.get(sat.id)?.data ?? null;
  const match = findMatchingGapProcedure(data?.scheduled, gap, source);
  _tooltipEl.innerHTML = _tmrGapTooltipHTML(gap, match, data?.pass);
  const btn = _tooltipEl.querySelector('.co-tt-gap-btn');
  if (btn && !btn.disabled) {
    btn.addEventListener('click', async () => {
      btn.disabled    = true;
      btn.textContent = 'Requesting…';
      try {
        const { linkEstablished } = await requestTmrGapDownload(sat, gap, source);
        _getSccPassCheck(sat, { forceRefresh: true }); // reflect the new request as soon as it lands
        // The new procedure landed on SCC's own "next pass" for this
        // satellite, not necessarily _selectedPass — but there's no cheap
        // way to know without another round trip, so drop the WHOLE
        // scheduled-procedures cache (see invalidateAllScheduledProcedures'
        // own comment) and, if the left column happens to be showing a
        // future pass right now, refresh it immediately so the new request
        // shows up without waiting for the next unrelated re-render.
        invalidateAllScheduledProcedures();
        if (_selectedPass?.future) _renderProcedurePanel(_selectedPass, sat);
        showActionToast(linkEstablished
          ? 'TM/TC link + TMR gap download scheduled on the next pass.'
          : 'TMR gap download scheduled on the next pass.');
      } catch (err) {
        showActionToast(`Request failed: ${err.message}`);
        btn.disabled    = false;
        btn.textContent = 'Download Gap TMR';
      }
    });
  }
}

// Anchor coords for the (possibly-async) background refresh above to
// reposition the still-open tooltip against — same "last known mouse
// position" convention TimePlayer.js's own _ttAnchorX/_ttAnchorY follow.
let _ttAnchorX = 0, _ttAnchorY = 0;

function _showTmrGapTooltip(e, gap, sat, source) {
  if (!_tooltipEl) return;
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = { gap, sat, source };
  _tooltipEl.className = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _renderGapTooltip(gap, sat, source);
  _tooltipEl.style.display = 'block';
  positionTooltip(e, _tooltipEl);
  _getSccPassCheck(sat); // uses cache if fresh; refreshes in the background otherwise
}

// "Now" line + hover crosshair DOM refs — populated by initScheduler,
// read/written by _updateNowLine and the pointermove crosshair handler.
let _nowLineEl        = null;
let _crosshairEl      = null;
let _crosshairLabelEl = null;

// True only while the Scheduler tab is the visible one. Gates the gantt
// renders, the 1Hz overlay tick and the TMR gap scan — all of which used to run
// from page load whether or not this tab was ever opened. Module-level (not
// inside initScheduler) because _applySelection below is module-level too and
// has to be able to flip it: arriving from a pass tooltip goes through
// main.js's switchTab(), which changes the view WITHOUT clicking the tab
// button, so the click listener that normally calls _activate never fires.
let _active = false;
let _pendingSelect = false; // a boot-time auto-pick _renderSelector deferred until first open
let _satId = null;
let _selectedPass = null; // the actual pass object, not just a start-time key — read directly by later features
let _winT0 = null, _winT1 = null; // HARD outer bounds, frozen at satellite-selection time — see _selectSatellite. Eclipse/Plan data is fetched/computed for exactly this span, so zoom/pan (below) is clamped to it — past this edge there's simply no data to show, on ANY row, the same "one consistent boundary" reasoning TimePlayer.js's own VIEW_HALF_SEC comment gives.
let _viewT0 = null, _viewT1 = null; // CURRENT visible window — starts equal to [_winT0,_winT1] (fully zoomed out), moved by wheel-zoom/drag-pan within it
let _eclipseWindows = [];         // [{start,end}] in ms, within [_winT0,_winT1] — filled in by _scheduleEclipseWork

// The closest you can ever zoom in. Originally matched TimePlayer.js's own
// MIN_SPAN_SEC (300s = 5min) exactly; tightened further per Victor's own
// request for this tab specifically (not applied to TimePlayer.js's live
// gantt, whose scrubber has different needs) — 2min instead of 5min. No
// separate max: the max span is just the full [_winT0,_winT1] horizon itself
// (mirrors TimePlayer's MAX_SPAN_SEC = VIEW_HALF_SEC*2), so zooming out has
// nowhere further to go once the whole horizon is visible.
const MIN_SPAN_MS = 2 * 60_000;

function _viewSpan() { return _viewT1 - _viewT0; }

// Hard-stops pan/zoom at [_winT0,_winT1] — shifts the view back into range
// without ever touching its span, so this never fights whatever zoom level
// the user is currently at (same approach as TimePlayer.js's own
// _clampView, adapted from relative seconds to absolute ms).
function _clampView() {
  const maxSpan = _winT1 - _winT0;
  if (_viewT1 - _viewT0 >= maxSpan) { _viewT0 = _winT0; _viewT1 = _winT1; return; }
  if (_viewT0 < _winT0) {
    const span = _viewT1 - _viewT0;
    _viewT0 = _winT0;
    _viewT1 = _viewT0 + span;
  } else if (_viewT1 > _winT1) {
    const span = _viewT1 - _viewT0;
    _viewT1 = _winT1;
    _viewT0 = _viewT1 - span;
  }
}

function _sat() {
  return store.satellites.find(s => s.id === _satId) ?? null;
}

// Mirrors PassAnalyzer.js's own _updateHash/setSelection hash-persistence —
// same reasoning: a reload or a copy-pasted link should land back on the
// SAME satellite+pass, not just the tab. Prefixed with the tab name (unlike
// Analyzer's bare "<sat>/pass/<ms>") so main.js's startup hash-restore can
// tell the two tools' selections apart — see its own comment there. Reads
// current state directly rather than taking sat/pass params since its
// callers below don't all have a `sat` object already in hand locally.
function _updateHash() {
  // Only the visible tab owns the URL. Without this guard the chain was:
  // initScheduler -> _renderSelector -> (satellites not loaded yet)
  // -> _selectSatellite(null) -> here -> location.hash = 'scheduler'; and then
  // main.js's startup hash-restore, which runs AFTER every initX(), read that
  // back as "the tab the user was last on" and clicked it. Net effect: the app
  // booted into the Scheduler instead of the Visualizer on every single load,
  // which is also what dragged in the procedure catalog, the per-pass
  // scheduled-procedure lookups, the +/-5-day eclipse/STT precompute and the
  // TMR gap scan at startup. Confirmed by reading the rendered DOM: #scheduler
  // -view carried .active on a plain load of "/".
  if (!_active) return;
  const sat = _sat();
  location.hash = (sat && _selectedPass)
    ? `scheduler/${encodeURIComponent(sat.name.toLowerCase())}/pass/${_selectedPass.start.getTime()}`
    : 'scheduler';
}

// "Now", from the currently selected satellite's own point of view — plain
// Date.now() for a real satellite (or when none is selected); corrected by
// the satellite's own SCC-reported clock offset when it's simulated (see
// satSimu.js). satPasses.js already fetches this satellite's pass data
// against satEffectiveNow, so every "now"-relative thing on this tab (the
// ±WINDOW_MS window itself, the gantt's "now" line, T-MINUS countdowns, the
// "Next pass" shortcut) has to agree with THAT clock too, or a simulated
// satellite whose sim time runs far from real wall-clock time would show a
// window with no data in it, or a countdown to a pass that's already past
// from its own clock's point of view.
function _now() {
  const sat = _sat();
  return sat ? satEffectiveNow(sat.noradId) : Date.now();
}

// Chronological — the gantt reads left-to-right as time passing, so display
// order should match, unlike PassAnalyzer's own newest-first TC list (a
// different reading direction for a different purpose).
function _passes() {
  return _satId ? (store.satPasses[_satId] ?? []).slice().sort((a, b) => a.start - b.start) : [];
}

function _plans() {
  return _satId ? (store.satPlans[_satId] ?? []) : [];
}

// Selects the closest upcoming (or still in-progress) pass — the "Next
// pass" button's shortcut for jumping straight there instead of hunting for
// it on the gantt. No-op if there isn't one in the currently fetched
// [_winT0,_winT1] horizon (the button is disabled in that case — see
// _renderGantt's own selBody template).
function _selectNextUpcomingPass() {
  const now = _now();
  const next = _passes().find(p => p.end.getTime() > now);
  if (!next) return;
  _selectedPass = next;
  _updateHash();
  _renderGantt();
}

// Steps the current selection by `dir` (-1 previous, +1 next) through the
// chronologically sorted pass list — matched back to the CURRENT selection
// by start time (same lookup the click-to-select handler in initScheduler
// already uses), not index, since _passes() is recomputed fresh every call
// rather than cached. No-op at either end of the list (the </> buttons are
// disabled there too — see _renderGantt).
function _stepSelectedPass(dir) {
  if (!_selectedPass) return;
  const passes = _passes();
  const idx = passes.findIndex(p => p.start.getTime() === _selectedPass.start.getTime());
  if (idx === -1) return;
  const nextIdx = idx + dir;
  if (nextIdx < 0 || nextIdx >= passes.length) return;
  _selectedPass = passes[nextIdx];
  _updateHash();
  _renderGantt();
}

// The pass chronologically right after the current selection — backs the
// "NEXT PASS AOS+0" quick-fill button on a date/time procedure argument
// (see _renderProcDetailView). null if nothing's selected or the selection
// is already the last pass in the fetched window.
function _nextPassAfterSelected() {
  if (!_selectedPass) return null;
  const passes = _passes();
  const idx = passes.findIndex(p => p.start.getTime() === _selectedPass.start.getTime());
  if (idx === -1 || idx + 1 >= passes.length) return null;
  return passes[idx + 1];
}

// ── Eclipse computation ──────────────────────────────────────────
//
// Adapted from TimePlayer.js's own _eclipseSttWork, minus the star-tracker
// cone-blinding half (this view has no STT row to feed) — same generator +
// time-budgeted chunk runner (_runEclipseChunk below) rather than one flat
// loop: confirmed live there that a flat ±5-day/1-min-step loop (~14400 SGP4
// propagations) is a single main-thread stall, visible as a hitch, every
// time the selected satellite changes — hence the chunking.
// Step was 5 min; tightened to 1 min (same reasoning as TimePlayer.js's own
// _eclipseSttWork) so bar edges and the hover tooltip's start/end times are
// accurate to the minute instead of only to the nearest 5-minute bucket.
const ECLIPSE_STEP_MS = 60_000;

function* _eclipseWork(sat, t0, t1) {
  const windows = [];
  let inEcl = false, wStart = 0;
  const d = new Date();
  for (let t = t0; t <= t1; t += ECLIPSE_STEP_MS) {
    d.setTime(t);
    const r = propagate(sat.satrec, d);
    if (r) {
      const ecl = isInEclipse(r.eciPos, sunDirectionECI(d));
      if (ecl && !inEcl)      { wStart = t; inEcl = true; }
      else if (!ecl && inEcl) { windows.push({ start: wStart, end: t }); inEcl = false; }
    }
    yield;
  }
  if (inEcl) windows.push({ start: wStart, end: t1 });
  _eclipseWindows = windows;
}

let _eclipseGen    = null; // in-flight generator, identity-checked to detect supersession
let _eclipseJobSat = null; // which satellite id _eclipseWindows (or the in-flight job) is actually for

function _runEclipseChunk(gen, satId) {
  if (_eclipseGen !== gen) return; // superseded by a newer satellite switch — abandon quietly
  const budgetStart = performance.now();
  let result;
  do { result = gen.next(); } while (!result.done && performance.now() - budgetStart < 8);
  if (result.done) {
    _eclipseGen = null;
    if (_satId === satId) _renderGantt();
  } else {
    setTimeout(() => _runEclipseChunk(gen, satId), 0);
  }
}

function _scheduleEclipseWork(sat, t0, t1) {
  if (_eclipseJobSat === sat.id) return; // already computed (or computing) for this exact selection
  _eclipseJobSat = sat.id;
  _eclipseWindows = [];
  if (!sat.satrec) return;
  const gen = _eclipseWork(sat, t0, t1);
  _eclipseGen = gen;
  setTimeout(() => _runEclipseChunk(gen, sat.id), 0);
}

// ── TMR gap fetch ──────────────────────────────────────────────────
//
// One row per source (see tmrData.js's TMR_SOURCES — BUS/PAY are separate
// onboard packet stores, independently gapped). Reuses TimePlayer.js's own
// scheduleTmrFetch/store.setTmrWindows wholesale — same shared, satId-keyed
// store.satTmr this view and the live gantt both read, so a fetch already
// done for one is available to the other for free instead of duplicating
// the (real, network-bound) gap-detection work tmrData.js's own header
// comment describes. Needs at least one PAST pass to anchor its query range
// (see tmrData.js's _fetchTmrWindows) — a satellite with none yet just shows
// an empty row until one exists, same as TimePlayer.js's own _triggerTmr.
// _tmrFetchKey guards this the same way _timetagFetchKey guards _triggerTimetag
// below. It matters more here: store.setSatPasses notifies a bare 'satPasses'
// key with no satId and no change detection, every 2 minutes per satellite, and
// this used to re-arm the ENTIRE gap scan on each one — one _hasAnyData probe
// over ~6 days plus one backward walk per interpass void, six-wide, across two
// sources. Measured shape: 76-124 /api/v1/parameters requests per scan, and
// _fetchTmrWindows aborts the previous scan on entry, so on a multi-satellite
// fleet most scans were killed before finishing. The work was done, thrown
// away, and the row frequently never painted.
//
// The inputs are completed passes, which change a few times a day, so keying on
// "which past passes do I have" is enough — a recomputation with the same key
// returns a byte-identical answer.
let _tmrFetchKey = null;

function _triggerTmr() {
  const sat = _sat();
  if (!sat) return;
  const past = _passes().filter(p => !p.future);
  if (!past.length) return;
  const key = `${sat.id}:${past.length}:${past[past.length - 1].start.getTime()}`;
  if (_tmrFetchKey === key) return; // same satellite, same completed passes — nothing to recompute
  _tmrFetchKey = key;
  for (const source of Object.keys(TMR_SOURCES)) {
    scheduleTmrFetch(sat, past, source, windows => store.setTmrWindows(sat.id, source, windows));
  }
}

// ── Timetag row ──────────────────────────────────────────────────
//
// One tick per PUS(11,4) "insert TC in subschedule" command found in the
// satellite's most recent PAST pass — placed at the target TC's OWN scheduled
// execution time (OBSW_AR_S11_ABS_TIME_TAG), not at the TC_11_4 envelope's
// send time, since the point of this row is "when will this actually fire",
// not "when was it uplinked". Colored by SSID (OBSW_AR_S11_SUBSCHEDULE_ID) so
// a glance says which subschedule a command lives in; the last-known
// ENABLED/DISABLED status per SSID comes from the latest live HK_CCSW packet
// (OBSW_AM_S11_STSUB_<n>) — both field sets confirmed live against sccRo,
// 2026-07-29/30.
//
// Only "the previous pass" is ever analyzed (not the currently selected one,
// and not a rolling history) — per instruction, this row answers "what did
// we just tell it to do", not a general command-schedule audit.

// Same 8-hue dark-mode categorical steps as the app's own dataviz reference
// palette (validated: adjacent-pair CVD ΔE >= 8.4, normal-vision >= 19.3 on a
// dark surface) — a 9th+ SSID (OBSW_AM_S11_STSUB goes up to 10) folds to the
// neutral fallback below rather than inventing a 9th hue, per that palette's
// own rule.
const _SSID_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const _SSID_COLOR_FALLBACK = '#778';
function _ssidColor(ssid) {
  const n = Number(ssid);
  return Number.isInteger(n) && n >= 1 && n <= _SSID_COLORS.length ? _SSID_COLORS[n - 1] : _SSID_COLOR_FALLBACK;
}

const HK_CCSW_PACKET  = 'TM_3_25_OBSW_HK_CCSW';
const HK_CCSW_MAX_SSID = 10; // OBSW_AM_S11_STSUB_1..10 — confirmed live, 2026-07-30 sccRo sample

// The satellite's most recent COMPLETED pass — TC_11_4 commands are only
// ever uplinked during a real pass, so this is the window the whole row
// analyzes. null if the satellite has no past pass in the currently fetched
// ±WINDOW_MS horizon yet.
function _previousPass() {
  const past = _passes().filter(p => !p.future);
  return past.length ? past[past.length - 1] : null;
}

// Latest known per-SSID enable state, straight off HK_CCSW — a plain object
// {1: 'ENABLED', 2: 'DISABLED', ...}, only for whichever slots the packet
// actually reported. HK_CCSW only downlinks during a pass (like all HK), so
// this looks back 5 days (matches satPasses.js's own ±5d fetch window) rather
// than a short "now-ish" window, in case the satellite's last contact wasn't
// recent. null if no HK_CCSW packet was found at all in that window.
async function _fetchCcswSubscheduleStatus(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;
  // satEffectiveNow: plain Date.now() for a real satellite (see satSimu.js);
  // for a simulated one, corrected by its own SCC-reported clock offset, so
  // this actually lands on the window HK_CCSW downlinked in (same reasoning
  // satTelemetry.js's own fetchSatTelemetry follows).
  const nowMs = satEffectiveNow(sat.noradId);
  const end   = new Date(nowMs + 10_000).toISOString();
  const start = new Date(nowMs - 5 * 24 * 3_600_000).toISOString();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const pkt = await fetchTmPacket(origin, HK_CCSW_PACKET, { start, end }, ctrl.signal);
    if (!pkt) return null;
    const status = {};
    for (let n = 1; n <= HK_CCSW_MAX_SSID; n++) {
      const p = extractTmParam(pkt, `OBSW_AM_S11_STSUB_${n}`);
      if (p?.value != null) status[n] = String(p.value).toUpperCase();
    }
    return status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A logical "what's actually scheduled" identity — name + arguments + the
// exact instant it's due to fire. Two TC_11_4 envelopes sharing this key are
// the SAME command inserted into two different subschedules (a primary/
// backup redundancy pattern), not two independent commands that happen to
// collide — see _buildTimetagEntries' own comment.
function _timetagGroupKey(targetName, args, dateMs) {
  const argsKey = args.map(a => `${a.name}=${a.value}`).sort().join(',');
  return `${targetName ?? '?'}@${dateMs ?? '?'}::${argsKey}`;
}

// Every TC_11_4 in the pass, resolved to its target command + grouped by
// _timetagGroupKey — so a command inserted into two SSIDs at the same
// execution time (SCC generates a fresh, separately-id'd sibling packet for
// the target EACH time it's inserted, so matching by packet id would treat
// them as two unrelated commands) collapses into ONE entry carrying both
// SSIDs, per instruction. Sorted chronologically by scheduled execution time
// for a stable, readable order.
async function _buildTimetagEntries(sat, pass) {
  const packets = await fetchTcPackets(sat, pass.start.getTime(), pass.end.getTime());
  if (!packets) return null;
  const { targetFor } = matchScheduledTargets(packets);
  const groups = new Map(); // key -> entry
  for (const p of packets) {
    if (!TC_114_NAME_RE.test(p.name)) continue;
    // Only a CONFIRMED insert — the envelope's OWN full verification chain
    // (tcAckStatus — see its own comment) resolved all the way to 'exec-ok'
    // — actually landed in the onboard schedule. Checking acceptance alone
    // isn't enough: confirmed live (LEONAV-1, PT01-02, 2026-07-30) a TC_11_4
    // can be ACCEPTED (envelope well-formed) and still get rejected during
    // EXECUTION — e.g. an invalid time tag, which only ever shows up in the
    // started/progress/completed stages, never in acceptance itself — so an
    // acceptance-only check let a genuinely-failed insert through here.
    // Still-pending (no completion report yet) is excluded for the same
    // reason as a straight rejection: plotting either here would claim
    // something's scheduled that isn't confirmed to be.
    if (tcAckStatus(p.acks) !== 'exec-ok') continue;
    const target = targetFor.get(p.id);
    if (!target) continue;
    const dateRaw = p.args114?.date;
    const dateMs = typeof dateRaw === 'number' ? dateRaw : Date.parse(dateRaw);
    if (!Number.isFinite(dateMs)) continue; // no scheduled time found to place this at — nothing to draw
    const args = [];
    collectArguments(target.raw?.spacePacket?.rootContainer, args);
    const key = _timetagGroupKey(target.name, args, dateMs);
    let entry = groups.get(key);
    if (!entry) {
      entry = { name: target.name, description: target.description, args, dateMs, ssids: [] };
      groups.set(key, entry);
    }
    const ssid = p.args114?.ssid;
    if (ssid != null && !entry.ssids.includes(ssid)) entry.ssids.push(ssid);
  }
  return [...groups.values()].sort((a, b) => a.dateMs - b.dateMs);
}

let _timetagEntries  = null; // grouped entries for _timetagFetchKey's pass, or null before the first fetch / on fetch failure
let _timetagCcsw     = null; // {ssid: 'ENABLED'|'DISABLED'} from the latest HK_CCSW snapshot, or null
let _timetagFetchKey = null; // `${satId}:${previousPass.start}` this data was actually fetched for — re-fetched only when it changes

// Same "fetch once per selection, patch the row when it resolves" shape as
// _triggerTmr/_renderGanttTmrRows above — _timetagFetchKey (compared AFTER
// the await, not just before) is what discards a stale response if the
// satellite or previous-pass identity changed again while this was in flight,
// same pattern PassAnalyzer.js's own _procReportGen/_procCatalogGen use.
async function _triggerTimetag() {
  const sat  = _sat();
  const prev = sat ? _previousPass() : null;
  if (!sat || !prev) {
    _timetagEntries = null; _timetagCcsw = null; _timetagFetchKey = null;
    _renderGanttTimetagRow();
    return;
  }
  const key = `${sat.id}:${prev.start.getTime()}`;
  if (_timetagFetchKey === key) return; // already fetched (or in flight) for this exact satellite+pass
  _timetagFetchKey = key;
  const [entries, ccsw] = await Promise.all([
    _buildTimetagEntries(sat, prev),
    _fetchCcswSubscheduleStatus(sat),
  ]);
  if (_timetagFetchKey !== key) return; // superseded while in flight — a newer call already owns the row
  _timetagEntries = entries;
  _timetagCcsw    = ccsw;
  _renderGanttTimetagRow();
}

// A merged (multi-SSID) entry is colored by whichever of its SSIDs is
// currently ENABLED in HK_CCSW — that's the one that will actually fire. An
// entry with none enabled (or status unknown entirely) falls back to its
// lowest SSID number, so the color is still deterministic rather than
// arbitrary.
function _timetagLineColor(ssids) {
  if (!ssids.length) return _SSID_COLOR_FALLBACK;
  const enabled = ssids.find(s => _timetagCcsw?.[s] === 'ENABLED');
  return _ssidColor(enabled ?? ssids.slice().sort((a, b) => a - b)[0]);
}

// A raw physicalValue float (e.g. an orbit bulletin's ECI position in
// meters) comes back with double-precision noise out to ~16 significant
// digits — not meaningfully more precise for an operator's glance, and the
// main reason these rows were wrapping. 3dp is plenty for m/m/s/s-scale
// bulletin values; ints/strings/enums pass through unchanged.
function _fmtArgValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)
    ? value.toFixed(3)
    : String(value);
}

function _timetagTooltipHTML(entry) {
  const hdr  = `<div class="co-tt-header">${escapeHtml(entry.name)}</div>`;
  const date = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">SCHED</span>${_fmtDT(new Date(entry.dateMs))}</div>`;
  const ssidRows = entry.ssids.length
    ? entry.ssids.slice().sort((a, b) => a - b).map(s => {
        const status = _timetagCcsw?.[s] ?? 'UNKNOWN';
        const cls = status === 'ENABLED' ? 'co-tt-ok' : status === 'DISABLED' ? 'co-tt-fail' : '';
        return `<div class="co-tt-time-row"><span class="co-tt-time-lbl">SSID ${s}</span><span class="${cls}">${status}</span></div>`;
      }).join('')
    : `<div class="co-tt-time-row"><span class="co-tt-time-lbl">SSID</span>—</div>`;
  // co-tt-nowrap on the value: .co-tt-time-row is shared with tooltips that
  // DO want prose to wrap (e.g. a Plan's free-text NOTE row) — forcing nowrap
  // there globally would break those, so it's opt-in per value here instead.
  const args = entry.args.length
    ? entry.args.map(a => {
        const unit = argUnitLabel(a.unit);
        return `<div class="co-tt-time-row"><span class="co-tt-time-lbl">${escapeHtml(a.name)}</span><span class="co-tt-nowrap">${escapeHtml(_fmtArgValue(a.value))}${unit ? ` ${escapeHtml(unit)}` : ''}</span></div>`;
      }).join('')
    : `<div class="co-tt-note">No arguments</div>`;
  return hdr + date + ssidRows + `<div class="co-tt-sep"></div>` + args;
}

function _showTimetagTooltip(e, entry) {
  if (!_tooltipEl) return;
  clearTimeout(_ttHideTimer);
  _tooltipEl.className = 'co-tooltip sch-timetag-tooltip'; // wider — long OBSW_* labels wrap otherwise (see .sch-timetag-tooltip)
  _openGapTooltip = null; // this tooltip now shows a timetag entry, not a gap
  _tooltipEl.innerHTML     = _timetagTooltipHTML(entry);
  _tooltipEl.style.display = 'block';
  positionTooltip(e, _tooltipEl);
}

// SSID checkbox filter (the funnel icon next to the Timetag label) — which
// SSIDs are hidden right now. A persistent viewing preference like
// PassAnalyzer.js's _paCol1Width/_ebn0Span, not per-pass state: left as-is
// across a satellite/pass reselection rather than reset, so "just show me
// SSID 1" stays in effect while stepping through passes to find it.
let _timetagHiddenSsids = new Set();

// An entry with no ssids at all (shouldn't normally happen post-acceptance-
// filter, but is possible if args114's own ssid extraction came back null)
// is never hidden by this — there's nothing to filter it BY, so hiding it
// would just be silently dropping data the filter had no opinion on.
function _timetagEntryVisible(entry) {
  return !entry.ssids.length || entry.ssids.some(s => !_timetagHiddenSsids.has(s));
}

// Point events, not spans — _barHTML(dateMs, dateMs, ...) collapses to its
// own 0.3%-width floor, which is exactly the thin tick this row wants, so no
// new bar-drawing primitive is needed here. data-idx still indexes into the
// FULL _timetagEntries (not the filtered subset) so _showTimetagTooltip's
// lookup stays correct regardless of which entries got skipped.
function _renderGanttTimetag(container, t0, t1) {
  if (!container) return;
  _updateTimetagFilterBtn();
  if (!_timetagEntries?.length) { container.innerHTML = ''; return; }
  // No title= — the custom _showTimetagTooltip below already covers this,
  // and a native title tooltip stacking on top of it on the same hover reads
  // as a broken double-tooltip (same reasoning the Pass row's own bars follow).
  container.innerHTML = _timetagEntries.map((entry, i) => {
    if (!_timetagEntryVisible(entry)) return '';
    return _barHTML(entry.dateMs, entry.dateMs, t0, t1, _timetagLineColor(entry.ssids), ` data-idx="${i}"`);
  }).join('');
  container.querySelectorAll('.gantt-bar[data-idx]').forEach(bar => {
    const entry = _timetagEntries[Number(bar.dataset.idx)];
    if (!entry) return;
    bar.style.cursor = 'help'; // same hover-only (no click action) cursor the Eclipse row's own bars use
    bar.addEventListener('mouseenter', e => _showTimetagTooltip(e, entry));
    bar.addEventListener('mouseleave', _hideTooltipSoon);
  });
}

// Re-renders just the Timetag row against the current view range — used by
// _triggerTimetag's async resolution, same "just this row" scope
// _renderGanttTmrRows keeps for its own async TMR refresh.
function _renderGanttTimetagRow() {
  if (_viewT0 == null) return;
  _renderGanttTimetag(document.getElementById('sch-gantt-timetag'), _viewT0, _viewT1);
}

// Highlights the funnel icon whenever a filter is actually narrowing the row
// — otherwise a filter left on from an earlier click would silently thin the
// row out with no visible reason why.
function _updateTimetagFilterBtn() {
  document.getElementById('sch-timetag-filter-btn')
    ?.classList.toggle('sch-timetag-filter-btn-active', _timetagHiddenSsids.size > 0);
}

// Every SSID actually present across the current entries, not the full 1-10
// HK_CCSW range — no point offering a checkbox for a subschedule nothing in
// this pass used.
function _timetagKnownSsids() {
  const set = new Set();
  for (const entry of _timetagEntries ?? []) for (const s of entry.ssids) set.add(s);
  return [...set].sort((a, b) => a - b);
}

function _timetagFilterMenuHTML() {
  const ssids = _timetagKnownSsids();
  if (!ssids.length) return `<div class="sam-menu-section">Filter by SSID</div><div class="co-tt-note" style="padding:4px 8px 6px;">No SSIDs in the current pass</div>`;
  const rows = ssids.map(s => {
    const checked = !_timetagHiddenSsids.has(s);
    // Same latest-HK_CCSW status _timetagTooltipHTML's own per-SSID rows
    // show — lets an operator tell "hidden because I don't care about it
    // right now" (checkbox) apart from "hidden because it's DISABLED
    // onboard and won't fire anyway" (status) without opening a tooltip.
    const status    = _timetagCcsw?.[s] ?? 'UNKNOWN';
    const statusCls = status === 'ENABLED' ? 'co-tt-ok' : status === 'DISABLED' ? 'co-tt-fail' : '';
    return `<label class="sch-ssid-filter-row">
      <input type="checkbox" data-ssid="${s}"${checked ? ' checked' : ''} />
      <span class="sch-ssid-filter-swatch" style="background:${_ssidColor(s)}"></span>
      SSID ${s}
      <span class="sch-ssid-filter-status ${statusCls}">${status}</span>
    </label>`;
  }).join('');
  const reset = _timetagHiddenSsids.size ? `<button type="button" class="sam-menu-item sch-ssid-filter-reset">Show all</button>` : '';
  return `<div class="sam-menu-section">Filter by SSID</div>${rows}${reset}`;
}

let _timetagFilterMenuEl = null;

function _ensureTimetagFilterMenu() {
  if (_timetagFilterMenuEl) return _timetagFilterMenuEl;
  const el = document.createElement('div');
  el.className = 'sam-menu';
  el.style.display = 'none';
  document.body.appendChild(el);
  document.addEventListener('click', e => {
    if (el.style.display !== 'none' && !el.contains(e.target) && !e.target.closest('#sch-timetag-filter-btn')) {
      el.style.display = 'none';
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') el.style.display = 'none'; });
  _timetagFilterMenuEl = el;
  return el;
}

function _renderTimetagFilterMenu() {
  const menu = _ensureTimetagFilterMenu();
  menu.innerHTML = _timetagFilterMenuHTML();
  menu.querySelectorAll('input[data-ssid]').forEach(cb => {
    cb.addEventListener('change', () => {
      const s = Number(cb.dataset.ssid);
      if (cb.checked) _timetagHiddenSsids.delete(s); else _timetagHiddenSsids.add(s);
      _renderTimetagFilterMenu(); // refresh (the "Show all" row appears/disappears with the count)
      _renderGanttTimetagRow();
    });
  });
  menu.querySelector('.sch-ssid-filter-reset')?.addEventListener('click', () => {
    _timetagHiddenSsids.clear();
    _renderTimetagFilterMenu();
    _renderGanttTimetagRow();
  });
}

// Click-to-open on the funnel icon, click-outside/Escape-to-close — same
// shape as satActionsMenu.js's own wireSatActionsIcon, just a single static
// button (wired once in initScheduler) instead of one per fleet row.
function _wireTimetagFilterBtn() {
  const btn = document.getElementById('sch-timetag-filter-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const menu = _ensureTimetagFilterMenu();
    const wasOpen = menu.style.display !== 'none';
    if (wasOpen) { menu.style.display = 'none'; return; }
    _renderTimetagFilterMenu();
    menu.style.display = 'block';
    const rect = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 160;
    let x = rect.left;
    let y = rect.bottom + 4;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (y + menu.offsetHeight > window.innerHeight - 8) y = rect.top - menu.offsetHeight - 4;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top  = Math.max(8, y) + 'px';
  });
}

// Same "~3-day onboard TM buffer" urgency thresholds TimePlayer.js's own
// _gapUrgency uses (duplicated, not exported there either — same "not
// exported there either" precedent _PLAN_STATUS_COLOR above already
// follows). Judged from real wall-clock time against the gap's own end, not
// the (view-only, non-scrubbing) time axis — the onboard buffer ages in the
// real world regardless of what span this gantt happens to be zoomed to.
const TMR_GAP_WARN_MS = 2 * 86_400_000; // 2 days: getting close to being overwritten
const TMR_GAP_LOST_MS = 3 * 86_400_000; // 3 days: the buffer's approximate hold time
function _tmrGapUrgency(gap) {
  const age = Date.now() - gap.end;
  if (age >= TMR_GAP_LOST_MS) return 'lost';
  if (age >= TMR_GAP_WARN_MS) return 'warn';
  return null;
}

// ── Rendering ────────────────────────────────────────────────────

// Same adaptive interval table TimePlayer.js's own _tickInterval/_fmtTick
// use (duplicated, not exported there either — same precedent
// _PLAN_STATUS_COLOR above already follows). Fixed day-boundary ticks were
// fine back when this view had no zoom, but wheel-zoom/drag-pan (added
// since) can narrow the view down to MIN_SPAN_MS (2 min) — at that span a
// day-boundary-only ruler would usually show NO ticks at all. Targets ~8
// ticks across whatever span is currently visible, snapping to the largest
// interval at or below that ideal spacing.
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

// Ruler ticks scale with the current zoom (_tickInterval/_fmtTick above) —
// mirrors TimePlayer.js's own _updateGanttRuler, just building an HTML
// string instead of appending DOM nodes (this view re-renders via
// innerHTML wholesale, not incrementally). The "now" marker used to live
// here too but is now the full-height #sch-gantt-now-full overlay
// (_updateNowLine below) — spans the actual rows, not just this ruler strip.
function _rulerHTML(t0, t1) {
  const rangeMs  = t1 - t0;
  const interval = _tickInterval(rangeMs);
  const first    = Math.ceil(t0 / interval) * interval;
  const ticks = [];
  for (let t = first; t <= t1; t += interval) {
    const pct   = (t - t0) / rangeMs * 100;
    const label = _fmtTick(t, rangeMs);
    ticks.push(`<div class="sch-gantt-tick" style="left:${pct.toFixed(2)}%"><span class="sch-gantt-tick-label">${label}</span></div>`);
  }
  return ticks.join('');
}

// Full-height red "now" line (#sch-gantt-now-full, see style.css) — ticked on
// an interval (see initScheduler) rather than only redrawn on satellite
// select/zoom/pan, so it stays accurate even while the view sits idle at its
// most zoomed-in span (MIN_SPAN_MS = 2 min), where a few minutes of drift
// would otherwise be visible as a wrongly-placed line.
function _updateNowLine() {
  if (!_nowLineEl) return;
  if (_viewT0 == null) { _nowLineEl.style.display = 'none'; return; }
  const pct = (_now() - _viewT0) / (_viewT1 - _viewT0) * 100;
  if (pct < 0 || pct > 100) { _nowLineEl.style.display = 'none'; return; }
  _nowLineEl.style.display = 'block';
  _nowLineEl.style.left = `${pct.toFixed(3)}%`;
}

// "5d 3h 12m 44s" (or "-5d 3h..." once past) — same Dd/Hh/Mm/Ss breakdown
// regardless of magnitude, since a pass in the fetched ±5-day window can be
// anywhere from seconds to days out. Leading zero units are dropped (no
// "0d" for a same-day pass) but once a bigger unit is shown, every smaller
// one after it stays even at 0 (e.g. "2h 0m 15s"), so the string doesn't
// visually jump in length/shape tick to tick as smaller units roll over.
function _fmtCountdown(deltaMs) {
  const past    = deltaMs < 0;
  const totalSec = Math.floor(Math.abs(deltaMs) / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  if (d || h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return (past ? '-' : '') + parts.join(' ');
}

// Ticks the selected-pass card's countdown-to-AOS (#sch-selpass-countdown)
// on the same 1s interval _updateNowLine already runs on (see
// initScheduler) — a static "at render time" value would drift stale
// within seconds otherwise, same reasoning the "now" line itself is ticked
// rather than only redrawn on selection change.
function _updateSelPassCountdown() {
  const el = document.getElementById('sch-selpass-countdown');
  if (!el || !_selectedPass) return;
  el.textContent = _fmtCountdown(_selectedPass.start.getTime() - _now());
}

// Shared by the hover crosshair below AND the "pick from timeline" feature
// (see _enterDateTimePickMode) — the fraction [0,1] across the Pass row's
// own track a given clientX falls at, or null if outside it. Pivots off the
// Pass row specifically, same convention _onWheel already uses ("any of the
// three would do; they're all the same width").
function _ganttFracAtClientX(clientX) {
  if (_viewT0 == null) return null;
  const passTrack = document.getElementById('sch-gantt-pass');
  if (!passTrack) return null;
  const rect = passTrack.getBoundingClientRect();
  if (!rect.width) return null;
  const f = (clientX - rect.left) / rect.width;
  return f < 0 || f > 1 ? null : f;
}

// Hover crosshair (#sch-gantt-crosshair, see style.css) — follows the mouse
// across the Eclipse/Pass/Plan tracks and reads out the time under the
// cursor, no click required (contrast with the Pass row's click-to-select).
function _updateCrosshair(clientX) {
  if (!_crosshairEl) return;
  const f = _ganttFracAtClientX(clientX);
  if (f == null) { _hideCrosshair(); return; }
  const t = _viewT0 + f * _viewSpan();
  _crosshairEl.style.display = 'block';
  _crosshairEl.style.left    = `${(f * 100).toFixed(3)}%`;
  if (_crosshairLabelEl) _crosshairLabelEl.textContent = _fmtDT(new Date(t));
}

function _hideCrosshair() {
  if (_crosshairEl) _crosshairEl.style.display = 'none';
}

// "Pick from timeline" — an alternative to typing/using the calendar widget
// (below) for a date/time argument: click the button on that argument's row,
// then click a point on the gantt itself to use that instant. _procArgKey
// (module-level) is which argument is currently awaiting that click, or
// null when no pick is in progress; the crosshair turns #008cff (see
// style.css's .sch-gantt-crosshair-picking) as the visual cue that the next
// gantt click will be consumed as a pick rather than doing its usual thing
// (pass-select / pan). Re-renders the argument form on enter/exit so the
// triggering button's own "active" state (and its label) stays in sync.
let _procDateTimePickKey = null;

function _enterDateTimePickMode(key) {
  _procDateTimePickKey = key;
  _crosshairEl?.classList.add('sch-gantt-crosshair-picking');
  _renderProcDetailView();
}
function _exitDateTimePickMode() {
  _procDateTimePickKey = null;
  _crosshairEl?.classList.remove('sch-gantt-crosshair-picking');
  _renderProcDetailView();
}

// ── Calendar picker (📅 button on a date/time argument) ─────────────
//
// A fully custom, in-house calendar+time widget — NOT <input
// type="datetime-local">'s own native popup, whose clock display follows
// the browser/OS locale and, confirmed live, still shows AM/PM regardless
// of any lang override, same underlying limitation that pushed the text
// field itself (_fmtDTInput/_parseDTInput) off that control in the first
// place. Building this in-house is the only way the CLICK-to-pick path
// stays 24h too. Every commit here goes through _commitCalendarValue, which
// writes the exact same {dt: <_dateToDatetimeLocalUTC string>} shape typing
// into the text field does — this widget is just another way to arrive at
// that same value, not a parallel source of truth.
let _procCalendarKey   = null; // arg key whose picker is open, or null
let _procCalendarMonth = null; // Date (UTC, day=1) — the month currently shown, independent of the field's own value until a day is actually clicked

const _CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function _dateOnlyISO(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function _openCalendarPicker(key, base) {
  _procCalendarKey   = key;
  _procCalendarMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  _renderProcDetailView();
}
function _closeCalendarPicker() {
  _procCalendarKey = null;
  _renderProcDetailView();
}

// The value this picker is currently editing, read from its OWN row's text
// field rather than _procArgValues directly — the text field is already the
// single rendered source of truth for "what this argument's value looks
// like right now" (typed edit, quickfill, pick-from-timeline, or schema
// default, whichever applies), so reading it back here avoids re-deriving
// that same fallback chain a second time.
function _calendarCurrentBase(panelOrRow) {
  const textEl = panelOrRow.closest('.sch-proc-arg-datetime')?.querySelector('.sch-proc-arg-dt');
  if (!textEl) return new Date();
  return _parseDTInput(textEl.value) ?? _datetimeLocalUTCToDate(textEl.dataset.fallback) ?? new Date();
}

function _commitCalendarValue(key, d) {
  _procArgValues[key] = { ..._procArgValues[key], dt: _dateToDatetimeLocalUTC(d) };
  _renderProcDetailView(); // _procCalendarKey is untouched — the panel stays open, now reflecting the new value
}

// 42 cells (6 full weeks), Sunday-first — leading/trailing days from the
// adjacent month fill out the grid (dimmed, still clickable) rather than
// leaving blank cells, same layout a native date picker uses.
function _calendarDaysHTML(monthStart, selectedDate) {
  const year  = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const firstWeekday    = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth     = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const todayIso    = _dateOnlyISO(new Date());
  const selectedIso = selectedDate ? _dateOnlyISO(selectedDate) : null;

  const cells = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ d: daysInPrevMonth - i, dateUTC: new Date(Date.UTC(year, month - 1, daysInPrevMonth - i)), dim: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, dateUTC: new Date(Date.UTC(year, month, d)), dim: false });
  }
  for (let d = 1; cells.length < 42; d++) {
    cells.push({ d, dateUTC: new Date(Date.UTC(year, month + 1, d)), dim: true });
  }

  return cells.map(c => {
    const iso = _dateOnlyISO(c.dateUTC);
    const cls = ['sch-dtcal-day'];
    if (c.dim) cls.push('sch-dtcal-day-dim');
    if (iso === todayIso) cls.push('sch-dtcal-day-today');
    if (iso === selectedIso) cls.push('sch-dtcal-day-selected');
    return `<button type="button" class="${cls.join(' ')}" data-cal-date="${iso}">${c.d}</button>`;
  }).join('');
}

function _calendarPickerHTML(key, base) {
  const month = _procCalendarMonth ?? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const monthLabel = `${_CAL_MONTH_NAMES[month.getUTCMonth()]} ${month.getUTCFullYear()}`;
  const dowRow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(l => `<span class="sch-dtcal-dow">${l}</span>`).join('');
  const p = n => String(n).padStart(2, '0');
  return `<div class="sch-dt-picker" data-arg-key="${escapeHtml(key)}">
    <div class="sch-dtcal-header">
      <button type="button" class="sch-dtcal-nav" data-cal-nav="-1" title="Previous month">‹</button>
      <span class="sch-dtcal-month">${monthLabel}</span>
      <button type="button" class="sch-dtcal-nav" data-cal-nav="1" title="Next month">›</button>
    </div>
    <div class="sch-dtcal-dow-row">${dowRow}</div>
    <div class="sch-dtcal-grid">${_calendarDaysHTML(month, base)}</div>
    <div class="sch-dtcal-time">
      <input type="number" min="0" max="23" class="sch-dtcal-time-input" data-cal-time="h" value="${p(base.getUTCHours())}" />
      <span>:</span>
      <input type="number" min="0" max="59" class="sch-dtcal-time-input" data-cal-time="m" value="${p(base.getUTCMinutes())}" />
      <span>:</span>
      <input type="number" min="0" max="59" class="sch-dtcal-time-input" data-cal-time="s" value="${p(base.getUTCSeconds())}" />
      <span class="sch-dtcal-tz">UTC</span>
    </div>
    <div class="sch-dtcal-footer">
      <button type="button" class="sch-nav-btn sch-dtcal-today-btn">Today</button>
      <button type="button" class="sch-nav-btn sch-dtcal-close-btn">Done</button>
    </div>
  </div>`;
}

// The panel is position:fixed (style.css) so it always lands fully inside
// the viewport regardless of where its argument row happens to sit in the
// (scrollable) procedure-detail column — same edge-avoidance shape
// passTooltip.js's own positionTooltip already uses: flip above the 📅
// button if there's no room below, clamp horizontally. Called after every
// render while the picker is open (_renderProcDetailView), not just once on
// open, since switching months/days can change the panel's own height.
function _positionCalendarPicker() {
  const panel = document.querySelector('.sch-dt-picker');
  const btn   = document.querySelector('.sch-proc-arg-cal-btn.sch-proc-pick-btn-active');
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth  || 224;
  const h = panel.offsetHeight || 260;
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = r.top - h - 4; // no room below — open above instead
  top = Math.max(8, top);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  panel.style.top  = `${top}px`;
  panel.style.left = `${left}px`;
}

// Shared by all three rows — a plain proportional bar clipped to [0,100]%,
// skipped entirely if it'd round away to nothing. data-start is added by the
// caller (via extraAttrs) for all three rows — Pass, Plan, and Eclipse are
// all hoverable (tooltip), and Pass is additionally clickable.
function _barHTML(startMs, endMs, t0, t1, color, extraAttrs = '') {
  const l = Math.max(0, Math.min(100, (startMs - t0) / (t1 - t0) * 100));
  const r = Math.max(0, Math.min(100, (endMs   - t0) / (t1 - t0) * 100));
  const w = Math.max(r - l, 0.3); // floor so a short window stays visible/clickable at this window's scale
  if (r - l <= 0 && w <= 0) return '';
  return `<div class="gantt-bar" style="left:${l.toFixed(3)}%;width:${w.toFixed(3)}%;background:${color}"${extraAttrs}></div>`;
}

function _passBarHTML(p, t0, t1) {
  const startMs = p.start.getTime(), endMs = p.end.getTime();
  const color = p.future ? _FUTURE_COLOR : (_OUTCOME_COLOR[p.outcome] ?? _OUTCOME_COLOR.SUCCESS);
  const selected = _selectedPass && _selectedPass.start.getTime() === startMs;
  // No title= — the hover tooltip (_showPassTooltip, wired in _renderGantt)
  // already covers this, and a native title tooltip stacking on top of the
  // custom one on the same hover reads as a broken double-tooltip.
  const attrs = ` data-start="${startMs}"${selected ? ' data-selected="1"' : ''}`;
  return _barHTML(startMs, endMs, t0, t1, color, attrs);
}

// Adapted from TimePlayer.js's own _renderGanttTmr — bars are colored by
// urgency the same way there, and hovering one now opens the same
// actionable gap tooltip (_showTmrGapTooltip), SCC-match "pending" state
// included. Three layers, drawn in this order — green coverage first, gap
// overlays second (never clear the green, just paint over it), grey "not
// checked yet" last:
//   1. green bar spanning [rangeStart, rangeEnd] — the queried range itself
//   2. dark/amber/red/green-dashed bars for actual gapWindows, by
//      _tmrGapUrgency and (green-dashed, overriding amber) whether a
//      matching download is already pending — see the isPending check below
//   3. grey bar from rangeEnd (or any still-open trailing gap, whichever is
//      earlier) to the end of the view — real future time AND a gap that
//      hasn't had a chance to close yet both read as "not known", not as a
//      confirmed anomaly the same dark fill as #2 would imply.
function _renderGanttTmr(container, source, t0, t1) {
  if (!container) return;
  container.innerHTML = '';
  const sat = _sat();
  const tmr = sat ? store.satTmr[sat.id]?.[source] : null;
  if (!tmr) return;
  const { rangeStart, rangeEnd, gapWindows } = tmr;
  const rangeMs = t1 - t0;

  const lCov = Math.max(0, (rangeStart - t0) / rangeMs * 100);
  const rCov = Math.min(100, (rangeEnd - t0) / rangeMs * 100);
  if (rCov - lCov > 0.01) {
    const cov = document.createElement('div');
    cov.className        = 'gantt-bar';
    cov.style.left       = `${lCov.toFixed(3)}%`;
    cov.style.width      = `${(rCov - lCov).toFixed(3)}%`;
    cov.style.background = '#00cc66';
    cov.style.boxShadow  = '0 0 6px #00cc6666';
    container.appendChild(cov);
  }

  // Same green/diagonal-dashed "already requested" treatment TimePlayer.js's
  // own _renderGanttTmr gives a gap with a matching PUS-15 downlink already
  // scheduled on SCC's next pass (findMatchingGapProcedure) — checked
  // against the SAME _sccPassCache this file's own gap tooltip populates
  // (_getSccPassCheck), so hovering a gap and seeing this bar agree on the
  // same underlying data. Priority order matches TimePlayer.js's own: lost
  // (data probably already gone — more urgent/irreversible than "a request
  // is in flight") beats pending.
  const sccData = sat ? _getSccPassCheck(sat) : null;
  let greyStart = rangeEnd;
  for (const gap of gapWindows) {
    const { start, end } = gap;
    if (end >= rangeEnd - 1000) { greyStart = Math.min(greyStart, start); continue; }
    const urgency   = _tmrGapUrgency(gap);
    const isPending = !!findMatchingGapProcedure(sccData?.scheduled, gap, source);
    const l  = (start - t0) / rangeMs * 100;
    const r  = (end   - t0) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    const cls = urgency === 'lost' ? 'gantt-bar-gap-lost'
              : isPending          ? 'gantt-bar-gap-pending'
              : urgency === 'warn' ? 'gantt-bar-gap-warn'
              : 'gantt-bar-gap';
    bar.className = `gantt-bar ${cls}`;
    bar.style.left  = `${lc.toFixed(3)}%`;
    bar.style.width = `${(rc - lc).toFixed(3)}%`;
    if (cls === 'gantt-bar-gap') bar.style.background = '#12121e';
    bar.addEventListener('mouseenter', e => _showTmrGapTooltip(e, gap, sat, source));
    bar.addEventListener('mouseleave', _hideTooltipSoon);
    container.appendChild(bar);
  }

  if (t1 > greyStart) {
    const lFut = Math.max(0, (Math.max(greyStart, t0) - t0) / rangeMs * 100);
    if (100 - lFut > 0.01) {
      const bar = document.createElement('div');
      bar.className = 'gantt-bar gantt-bar-future';
      bar.style.left  = `${lFut.toFixed(3)}%`;
      bar.style.width = `${(100 - lFut).toFixed(3)}%`;
      bar.title = 'Not available yet';
      container.appendChild(bar);
    }
  }
}

// Re-renders just the two TMR rows against the current view range — used by
// _getSccPassCheck's background refresh (a satellite selection's SCC-match
// status resolving async, well after the initial _renderGantt already ran),
// same "just these rows" scope TimePlayer.js's own _renderGanttTmrRows keeps
// rather than the full _renderGantt (which would also re-run pass/plan/
// eclipse work this refresh has no bearing on).
function _renderGanttTmrRows() {
  if (_viewT0 == null) return;
  _renderGanttTmr(document.getElementById('sch-gantt-tmr-bus'), 'bus', _viewT0, _viewT1);
  _renderGanttTmr(document.getElementById('sch-gantt-tmr-pay'), 'pay', _viewT0, _viewT1);
}

// AOS/mask/apogee/LOS line for the selected-pass panel — same
// passGeometryHTML content the hover tooltip shows (via hydratePassGeometry
// there), but reimplemented as a plain fetch-then-fill rather than reusing
// hydratePassGeometry itself: that helper's own repositioning call
// (positionTooltip) assumes a floating tooltip anchored to a mouse event,
// neither of which applies to this persistent, normally-flowed panel.
// _geoCache avoids a redundant re-fetch (and a network round trip) on every
// pan/zoom re-render while the SAME pass stays selected — _renderGantt runs
// on every one of those, but the geometry for a given pass never changes.
let _geoCache = null; // { key: pass.start.getTime(), markers }
let _geoGen   = 0;    // guards a slower in-flight fetch against a newer selection superseding it

// Locks #sch-selected-body's height to the tallest a real pass selection has
// ever needed (SAT/STN/DATE/DUR rows + eclipse bar + geometry line, once
// resolved) so switching to the "No pass selected" placeholder — a single
// short line — doesn't shrink the panel, and with it, per .sch-main-row's
// stretch alignment, the gantt panel too. Only grows, never shrinks: an
// earlier/shorter measurement (e.g. before geometry resolves) just reuses
// whatever taller height a previous pass already established.
// Seeded from style.css's own #sch-selected-body min-height floor (132px),
// not 0 — otherwise the FIRST real measurement (possibly shorter than that
// floor, e.g. before the async geometry line resolves) would set an inline
// min-height smaller than it, overriding the CSS floor and shrinking the
// panel right when a pass gets selected instead of only ever growing it.
let _selBodyMinHeightPx = 132;
function _syncSelBodyMinHeight(selBody) {
  const h = selBody.scrollHeight;
  if (h > _selBodyMinHeightPx) {
    _selBodyMinHeightPx = h;
    selBody.style.minHeight = `${_selBodyMinHeightPx}px`;
  }
}

function _applyGeoSlot(markers) {
  const slot = document.querySelector('#sch-selected-body .pass-geometry-slot');
  if (slot && markers) slot.innerHTML = passGeometryHTML(markers);
  const selBody = document.getElementById('sch-selected-body');
  if (selBody) _syncSelBodyMinHeight(selBody);
}

async function _hydrateSelectedPassGeometry(pass, sat) {
  const key = pass.start.getTime();
  if (_geoCache?.key === key) { _applyGeoSlot(_geoCache.markers); return; }
  if (!sat?.satrec) return;
  const myGen = ++_geoGen;
  const coords = await fetchPassGsCoords(sat, pass, store.groundStations);
  if (myGen !== _geoGen) return; // superseded by a newer selection
  if (!coords) return;
  const pts     = computePolarPoints(pass, sat, coords.lat, coords.lon);
  const markers = computePolarMarkers(pts, coords.rxMask);
  _geoCache = { key, markers };
  _applyGeoSlot(markers);
}

// ── Left column: scheduled / executed procedures for the selected pass ────
//
// Future pass: SCC may already have procedures queued on it — fetched via
// the same fetchScheduledProcedures TimePlayer.js/passTooltip.js's own hover
// tooltip uses, but rendered with this file's OWN markup (not the shared
// scheduledProceduresHTML) since this view needs interactive rows —
// click one to load it (name + its already-scheduled argument values) into
// the right column's argument form, and an X to unschedule it — that the
// shared, non-interactive tooltip version has no use for.
// Past pass: real procedure-history already sits on the pass object itself
// (satPasses.js's own `procedures` field, populated at fetch time — no
// extra round trip needed), plus a button to open the FULL detail (TC args,
// ack/failure reasons, Loki log) in Pass Analyzer, which this column
// deliberately doesn't try to replicate.
let _procGen = 0; // guards the async future-pass fetch against a newer selection superseding it
let _procPanelKey; // last _selectedPass.start.getTime() (or null) the panel was actually rendered for — see _renderGantt's own guard
let _scheduledProcsForPass = null; // the array fetchScheduledProcedures last resolved for the CURRENT future pass — rows reference it by index for click-to-view/unschedule, rather than re-parsing the rendered HTML

function _pastProcListHTML(pass) {
  const procs = pass.procedures ?? [];
  if (!procs.length) return '<div class="sch-empty-inline">No procedures executed on this pass.</div>';
  return procs.map(p => {
    const color = _OUTCOME_COLOR[p.status] ?? _OUTCOME_COLOR.SUCCESS;
    const time  = p.startMs != null ? fmtTimeOnly(p.startMs).slice(0, 8) : '—';
    return `<div class="sch-proc-row">
      <span class="sch-proc-dot" style="background:${color}"></span>
      <span class="sch-proc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <span class="sch-proc-time">${time}</span>
    </div>`;
  }).join('');
}

// A scheduled entry is identified for unscheduling/reordering by its plain
// 0-based INDEX within fetchScheduledProcedures' own array (confirmed live:
// DELETE .../procedure-scheduler?id=<eventId>&procedureIndex=<n>, PUT
// .../procedure-scheduler?id=<eventId>&previousIndex=<n>&newIndex=<m>) —
// not by any id/activityId field on the entry itself, which SCC always
// returns as null for a not-yet-executed entry. data-idx on each row
// already carries this.
function _scheduledProcListHTML(procs) {
  if (procs == null) return '<div class="sch-empty-inline">Could not reach SCC to check scheduled procedures.</div>';
  if (!procs.length) return '<div class="sch-empty-inline">Nothing scheduled on SCC yet.</div>';
  return procs.map((p, i) => {
    const name = (p.name ?? '?').split('.').pop();
    return `<div class="sch-scheduled-proc-row" data-idx="${i}" title="Click to view/edit its arguments">
      <span class="sch-scheduled-proc-num">${i + 1}</span>
      <span class="sch-scheduled-proc-handle" draggable="true" title="Drag to reorder">⠿</span>
      <span class="sch-scheduled-proc-name">${escapeHtml(name)}</span>
      <button type="button" class="sch-scheduled-proc-x" data-idx="${i}" title="Unschedule">✕</button>
    </div>`;
  }).join('');
}

// FLIP-animates a DOM reorder inside `container`: captures every row's
// position BEFORE `mutate()` runs, then — after it's moved the actual
// element(s) — offsets each row by however far it visually jumped and
// transitions that offset back to zero, so the reorder reads as rows
// sliding into place rather than an instant snap. Also renumbers the
// .sch-scheduled-proc-num badges to match each row's new position, so the
// visible order number stays honest DURING the drag preview too, not just
// after the drop settles.
function _animateProcRowMove(container, mutate) {
  const before = new Map(
    [...container.querySelectorAll('.sch-scheduled-proc-row')].map(r => [r, r.getBoundingClientRect()])
  );
  mutate();
  [...container.querySelectorAll('.sch-scheduled-proc-row')].forEach((row, i) => {
    const numEl = row.querySelector('.sch-scheduled-proc-num');
    if (numEl) numEl.textContent = i + 1;
    const from = before.get(row);
    if (!from) return;
    const to = row.getBoundingClientRect();
    const dy = from.top - to.top;
    if (!dy) return;
    row.style.transition = 'none';
    row.style.transform  = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      row.style.transition = 'transform 160ms ease';
      row.style.transform  = '';
    });
  });
}

function _renderProcedurePanel(pass, sat) {
  const body = document.getElementById('sch-scheduled-procs');
  if (!body) return;
  if (!pass) { body.innerHTML = ''; _scheduledProcsForPass = null; return; }

  if (pass.future) {
    body.innerHTML = '<div class="sch-empty-inline">Loading…</div>';
    const myGen = ++_procGen;
    fetchScheduledProcedures(sat, pass).then(procs => {
      if (myGen !== _procGen) return; // superseded by a newer selection
      _scheduledProcsForPass = procs;
      body.innerHTML = _scheduledProcListHTML(procs);

      body.querySelectorAll('.sch-scheduled-proc-row').forEach(row => {
        row.addEventListener('click', e => {
          // The X has its own handler below, and the drag handle's plain
          // click (as opposed to an actual drag) shouldn't also select this
          // row for viewing — both are excluded here.
          if (e.target.closest('.sch-scheduled-proc-x') || e.target.closest('.sch-scheduled-proc-handle')) return;
          const entry = _scheduledProcsForPass?.[Number(row.dataset.idx)];
          if (!entry) return;
          // entry already has .name/.parameters, the exact shape
          // _findProcParams' first candidate ('parameters') expects — no
          // conversion needed to load it straight into the argument form.
          _selectedProc = entry;
          _procArgValues = {};
          _procListRowCounts = {};
          _renderProcDetailView();
        });
      });
      body.querySelectorAll('.sch-scheduled-proc-x').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation(); // don't also trigger the row's own click-to-view handler above
          const idx = Number(btn.dataset.idx);
          const entry = _scheduledProcsForPass?.[idx];
          if (!entry) return;
          btn.disabled = true;
          try {
            await unscheduleProcedure(sat, pass, idx);
            invalidateScheduledProcedures(sat, pass);
            // This pass may be the SAME "next pass" the TMR gap dashes'
            // pending check (_getSccPassCheck/_sccPassCache) is reading —
            // unscheduling the matching downlink procedure should drop a
            // gap back from green-dashed to its plain urgency color right
            // away, not after the cache's own 30s TTL happens to lapse.
            // force-refresh resolves async and re-renders the TMR rows
            // itself once it lands (see _getSccPassCheck's own comment).
            _getSccPassCheck(sat, { forceRefresh: true });
            showActionToast(`Unscheduled ${(entry.name ?? '').split('.').pop()}`);
            _renderProcedurePanel(pass, sat); // refresh the list from a clean (post-invalidation) fetch
          } catch (err) {
            showWarningToast(`Failed to unschedule: ${err.message}`);
            btn.disabled = false;
          }
        });
      });

      // Drag-to-reorder — native HTML5 drag/drop, initiated only from the
      // ⠿ handle (draggable="true" lives on the handle, not the row, so a
      // plain click/drag anywhere else on the row never starts one). Rows
      // reorder LIVE as you drag over them (the dragged row's actual DOM
      // element relocates on every dragover, FLIP-animated via
      // _animateProcRowMove) rather than only snapping into place on drop —
      // by the time dragend fires, the DOM is already showing the final
      // order, so dragend just has to read it off and confirm it with SCC.
      // dragover must call preventDefault() or the browser refuses to
      // allow a drop at all — that's not optional, it's how a drop target
      // opts in per the spec.
      let draggedRow = null;
      let dragFromIdx = null;

      body.querySelectorAll('.sch-scheduled-proc-handle').forEach(handle => {
        handle.addEventListener('dragstart', e => {
          const row = handle.closest('.sch-scheduled-proc-row');
          draggedRow  = row;
          dragFromIdx = Number(row.dataset.idx);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.dataset.idx);
          // Deferred one frame — Chrome/Firefox both render the drag
          // "ghost" image from the element's state at drag START, so
          // dimming it immediately would dim the ghost too, not just the
          // row left behind.
          requestAnimationFrame(() => row.classList.add('sch-scheduled-proc-row-dragging'));
        });
        handle.addEventListener('dragend', async () => {
          const row = draggedRow;
          draggedRow = null;
          if (!row) return;
          row.classList.remove('sch-scheduled-proc-row-dragging');
          const finalIdx = [...body.querySelectorAll('.sch-scheduled-proc-row')].indexOf(row);
          if (finalIdx === -1 || finalIdx === dragFromIdx) return; // dropped back where it started — nothing to confirm
          try {
            await reorderScheduledProcedure(sat, pass, dragFromIdx, finalIdx);
            invalidateScheduledProcedures(sat, pass);
            _getSccPassCheck(sat, { forceRefresh: true }); // same "keep the gap dashes honest" reasoning as the unschedule handler above
          } catch (err) {
            showWarningToast(`Failed to reorder: ${err.message}`);
          }
          // Refresh either way: success needs the server's own confirmed
          // order (in case it normalizes differently than our optimistic
          // DOM move), failure needs to revert the optimistic move outright.
          _renderProcedurePanel(pass, sat);
        });
      });
      body.querySelectorAll('.sch-scheduled-proc-row').forEach(row => {
        row.addEventListener('dragover', e => {
          e.preventDefault();
          if (!draggedRow || row === draggedRow) return;
          const rect   = row.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          // Skip the animated move entirely if the dragged row is already
          // sitting exactly where this dragover would put it — otherwise
          // every tiny mouse movement within the same row re-triggers the
          // FLIP transition for no actual change, which reads as jitter.
          const alreadyThere = before
            ? row.previousElementSibling === draggedRow
            : row.nextElementSibling === draggedRow;
          if (alreadyThere) return;
          _animateProcRowMove(body, () => {
            row.insertAdjacentElement(before ? 'beforebegin' : 'afterend', draggedRow);
          });
        });
      });
    });
    return;
  }

  ++_procGen; // invalidate any in-flight future-pass fetch from the PREVIOUS selection
  _scheduledProcsForPass = null;
  body.innerHTML = _pastProcListHTML(pass)
    + `<button type="button" class="sch-nav-btn sch-open-analyzer-btn" id="sch-open-analyzer-btn">Open in Pass Analyzer 🔬</button>`;
  // Dispatched, not a direct import of PassAnalyzer.js/main.js — same
  // decoupling passTooltip.js's own "Open with Pass Analyzer" button uses
  // (see there); main.js already listens for this to switch tabs + set the
  // selection.
  document.getElementById('sch-open-analyzer-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('pda:open-pass', { detail: { sat, pass } }));
  });
}

// ── Right column: search + pick a procedure, then fill in its arguments ───
//
// Catalog is fetched once per satellite selection (see _selectSatellite) and
// cached by procedureCatalog.js itself besides — re-filtered locally on
// every keystroke rather than re-fetched, since GET /api/v1/procedure is
// SCC's whole procedure library, not something that changes pass-to-pass.
// The search bar (.sch-proc-search-wrap) stays visible at all times; only
// its dropdown list (.sch-proc-catalog) toggles, floating open while the
// input has focus and closing on blur/Escape/picking a row. The argument
// form (.sch-proc-detail-view) renders directly below it and just
// re-renders in place when a different procedure is picked — no separate
// "view" swap and no back button needed, since the search bar never leaves.
let _procCatalog = null;  // [{...}] | null (unreachable) — whatever the last fetch resolved to, for the CURRENTLY selected satellite
let _procCatalogGen = 0;  // guards against a slower fetch from a previous satellite landing after a newer one's
let _selectedProc = null; // the FULL catalog entry object picked (not just its name — the argument form needs whatever else the entry carries), or null
let _procArgValues = {};  // paramKey → current form value, rebuilt fresh every time a procedure is (re)selected
let _procListRowCounts = {}; // a List-typed param's own key → current row count, once touched by Add/Remove (see _procListRowCount) — rebuilt fresh alongside _procArgValues

function _procDisplayName(fullName) {
  return (fullName ?? '').split('.').pop();
}

// GET /api/v1/procedure's exact field name for a catalog entry's full
// dotted name isn't confirmed (this endpoint is new to the app — confirmed
// live it's NOT "name", unlike procedure-scheduler's responses) — falls
// back across the field names procedure-scheduler/tmrGapDownload.js's own
// payloads and responses actually use, plus a couple other plausible ones,
// so a shape mismatch shows SOMETHING (with a console warning from
// fetchProcedureCatalog pointing at the real shape) instead of silently
// rendering blank rows.
function _procName(p) {
  return p?.name ?? p?.procedureName ?? p?.id ?? '';
}

// Looks for a parameters/arguments array under any of the field names a
// procedure-shaped object has been seen using elsewhere in this app —
// tmrGapDownload.js's own POST payloads call it procedureParameters,
// procedure-scheduler's GET responses call it parameters (see
// scheduledProcedures.js's own note on the two NOT matching). Which one (if
// either) GET /api/v1/procedure's catalog entries carry isn't confirmed —
// this checks every plausible name rather than assuming one. Returns null
// (not []) when nothing matches, so callers can tell "no schema found" from
// "schema found, genuinely zero parameters".
function _findProcParams(proc) {
  const candidates = ['parameters', 'procedureParameters', 'params', 'arguments', 'args'];
  for (const key of candidates) {
    if (Array.isArray(proc?.[key])) return proc[key];
  }
  return null;
}

function _procParamKey(param, i) {
  return param?.name ?? param?.id ?? String(i);
}

// A boolean parameter is detected either by its CURRENT value already being
// a real JS boolean, or by its type/valueType field naming one — the only
// confirmed convention this app has for that is tmrGapDownload.js's own
// hand-built payloads (`type: 'java.lang.Boolean'`, `valueType: 'Boolean'`,
// e.g. its clearAfterDownload param), which GET /api/v1/procedure's own
// catalog entries may or may not mirror exactly — checking for "bool"
// case-insensitively in either field covers both that exact convention and
// plausible variants without assuming one precise string.
function _isProcParamBoolean(p) {
  if (typeof p?.value === 'boolean') return true;
  const typeStr = String(p?.type ?? p?.valueType ?? '').toLowerCase();
  return typeStr.includes('bool');
}

// A date/time parameter is detected by type/valueType naming one — the only
// confirmed convention this app has is tmrGapDownload.js's own hand-built
// payloads (`type: 'java.time.Instant'`, `valueType: 'AbsoluteTime'`, e.g.
// its tMinDumpTmR_obt/tMaxDumpTmR_obt params).
function _isProcParamDateTime(p) {
  const typeStr = String(p?.type ?? p?.valueType ?? '').toLowerCase();
  return typeStr.includes('instant') || typeStr.includes('absolutetime');
}

// A numeric parameter (Long/Integer/Short/Byte/Double/Float) — same
// type/valueType sniff as the boolean/datetime checks above. Matters because
// _procArgValue otherwise sends an EDITED numeric field's raw <input>.value
// straight through, which is always a JS string — SCC's own reflective
// invocation of the underlying Java method then fails with
// "IllegalArgumentException: argument type mismatch" trying to pass a String
// where a Long/int/double is expected (confirmed live, 2026-07-30: editing
// subscheduleId — a java.lang.Long — reproduced exactly this). An UNTOUCHED
// numeric field never hit this: its value comes straight from the schema's
// own p.value, already a real JSON number.
function _isProcParamNumeric(p) {
  const typeStr = String(p?.type ?? p?.valueType ?? '').toLowerCase();
  return ['long', 'int', 'short', 'byte', 'double', 'float'].some(t => typeStr.includes(t));
}

// A List-typed parameter — e.g. ELEM_FSW_PUS140_CHANGE_PARAMETER's own
// parametersToChange, whatever its actual per-entry shape turns out to be
// (unconfirmed — GET /api/v1/procedure hasn't been inspected for this entry
// specifically; see _procListElementFields' own fallback for the "shape
// unknown" case). Detected by its CURRENT value already being a real JS
// array, by type/valueType naming one, or by carrying a non-null
// elementParameter (a field every hand-built payload in this app sets
// explicitly to null — see tmrGapDownload.js's own params — which only makes
// sense as a real schema slot SCC's own catalog entries can populate for
// exactly this case). Sending a scalar where SCC expects a real array here is
// a confirmed live 500 ("expected a list but received a scalar value") — this
// and _procListRowHTML/_procListFieldValue below exist so a List param gets a
// real add/remove-row editor instead of falling through to the plain
// single-line text input every OTHER unrecognized type gets, which can never
// produce a genuine array.
function _isProcParamList(p) {
  if (Array.isArray(p?.value)) return true;
  if (p?.elementParameter != null) return true;
  const typeStr = String(p?.type ?? p?.valueType ?? '').toLowerCase();
  return typeStr.includes('list') || typeStr.includes('collection') || typeStr.endsWith('[]');
}

// True when each list entry is itself a multi-field struct (elementParameter
// is an array of field schemas — e.g. a {parameterId, value}-shaped pair,
// though the exact fields depend entirely on whatever SCC's own catalog
// entry sends, read generically below rather than assumed) rather than a
// single scalar (elementParameter absent or a lone schema object, e.g. a
// plain List<String>).
function _procListIsStruct(p) {
  return Array.isArray(p?.elementParameter) && p.elementParameter.length > 0;
}

// Normalizes elementParameter into "one or more field schemas per row",
// regardless of which shape SCC's catalog actually sent: an array (struct
// row, one schema per field), a lone object (scalar row, one field), or
// nothing at all. That last case is NOT "schema unknown", though it looks
// that way at first — confirmed live (PANDORE, ELEM_FSW_PUS140_CHANGE_
// PARAMETER's parametersToChange, a List<Enum> of 759 choices):
// elementParameter is null, but the ELEMENT's own type/choices still ride
// along on the LIST param itself (subType/subValueType instead of
// type/valueType, and — for an enum list specifically — enumValues sitting
// directly on p, not nested under elementParameter at all). Carrying those
// over is what lets _procListFieldInputHTML draw a real dropdown (or coerce
// a numeric entry correctly, for a List<Long> like sampleRatesToAdd) instead
// of a typeless, enum-blind text input that silently drops which values
// were even valid.
function _procListElementFields(p) {
  const ep = p?.elementParameter;
  if (Array.isArray(ep) && ep.length) return ep;
  if (ep && typeof ep === 'object') return [{ ...ep, name: ep.name ?? 'value' }];
  return [{
    name: 'value',
    type: p?.subType ?? null,
    valueType: p?.subValueType ?? null,
    enumValues: p?.enumValues ?? null,
    elementParameter: null,
    value: null,
  }];
}

// The schema's own original value for row `rowIdx` (undefined if that row
// didn't exist in p.value — e.g. a row added via the + button, past the end
// of whatever SCC's catalog shipped as a default) — struct rows pick the
// field out by name, scalar rows use the row's own value directly.
function _procListFieldOriginalValue(p, field, rowIdx) {
  const rowVal = Array.isArray(p?.value) ? p.value[rowIdx] : undefined;
  if (rowVal === undefined) return null;
  return _procListIsStruct(p) ? (rowVal?.[field.name] ?? null) : rowVal;
}

// Composite _procArgValues key for one field of one row of a list param —
// deliberately reuses the SAME flat _procArgValues store and data-arg-key
// convention every scalar param already uses, so a struct row's individual
// fields get boolean/enum/numeric coercion and the generic delegated input
// listener (_renderProcDetailView) entirely for free, with no parallel
// storage or event-wiring of their own.
function _procListFieldKey(key, rowIdx, fieldName) {
  return `${key}[${rowIdx}].${fieldName}`;
}

// How many rows to render/submit for this list param — the schema's own
// p.value length until the operator adds or removes a row, at which point
// _procListRowCounts[key] becomes the source of truth (see the Add/Remove
// button handlers in _renderProcDetailView). Defaults to 1 (not 0) when the
// schema has no rows of its own, so a list param opens with one blank entry
// ready to fill in rather than an empty state the operator has to click
// "Add entry" on first — explicitly removing that one row (via ✕) still
// reaches 0 for the genuinely-empty-list case.
function _procListRowCount(p, key) {
  if (Object.prototype.hasOwnProperty.call(_procListRowCounts, key)) return _procListRowCounts[key];
  const schemaLen = Array.isArray(p?.value) ? p.value.length : 0;
  return schemaLen || 1;
}

// One list-row field's current value — _procArgValue for everything except a
// detected date/time sub-field: nested list rows only ever get a plain text
// input (see _procListFieldInputHTML — the full calendar/seconds-offset
// picker is a top-level-only widget), so a nested "datetime" field is just
// passed through as typed text rather than run through _procArgValue's own
// datetime branch, which expects the {dt, offsetSec} object shape only that
// picker's dedicated listeners ever write (a plain string there would be
// silently ignored in favor of the original schema value instead).
function _procListFieldValue(f, fieldKey) {
  if (_isProcParamDateTime(f)) return _procArgValues[fieldKey] ?? f.value ?? '';
  return _procArgValue(f, fieldKey);
}

// Short, human-readable type hint shown next to each argument's label (see
// _renderProcDetailView) — derived from whichever of type/valueType is
// present (tmrGapDownload.js's own params always set both, e.g.
// `type: 'java.lang.Boolean', valueType: 'Boolean'`), collapsed to the
// plain word an operator would actually expect (int/double/boolean/...)
// rather than the raw Java-style class name. Falls back to that raw
// string's last dotted segment for a type this app hasn't seen before,
// rather than showing nothing at all.
function _procParamTypeLabel(p) {
  if (_isProcParamList(p)) return 'list';
  const raw = String(p?.type ?? p?.valueType ?? '').toLowerCase();
  if (!raw) return '';
  if (raw.includes('bool'))                     return 'boolean';
  if (raw.includes('instant') || raw.includes('absolutetime')) return 'datetime';
  if (raw.includes('double') || raw.includes('float'))         return 'double';
  if (raw.includes('long'))                     return 'long';
  if (raw.includes('int'))                      return 'int';
  if (raw.includes('string'))                   return 'string';
  if (raw.includes('enum'))                     return 'enum';
  return raw.split('.').pop();
}

// datetime-local inputs have no timezone of their own (the spec treats the
// value as bare wall-clock, no zone) — every OTHER timestamp in this app is
// UTC (fmtDateTimeShort etc. all label it explicitly), so this reads/writes
// that same field using UTC getters/setters rather than the browser's own
// local timezone, to avoid silently scheduling the wrong actual instant.
function _dateToDatetimeLocalUTC(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`
       + `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}
function _datetimeLocalUTCToDate(str) {
  if (!str) return null;
  const d = new Date(`${str}Z`); // appending Z is what makes this parse as UTC, not local
  return isNaN(d.getTime()) ? null : d;
}

// Parses the date/time argument field's own dd/mm/yyyy HH:mm:ss text back
// into a UTC Date, or null if it doesn't match/isn't a real date. Native
// <input type="datetime-local">'s displayed format follows the browser's own
// UI locale, not the page's — an el.lang="en-GB" override turned out not to
// be honored consistently there (confirmed live: still showing mm/dd/yyyy
// AM/PM), so that field is a plain text input instead (see
// _procArgRowHTML/its dedicated change listener in _renderProcDetailView),
// fully under this app's own formatting rather than the browser's.
function _parseDTInput(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const dd = Number(m[1]), mo = Number(m[2]), yyyy = Number(m[3]);
  const hh = Number(m[4]), mi = Number(m[5]), ss = m[6] !== undefined ? Number(m[6]) : 0;
  if (mo < 1 || mo > 12 || hh > 23 || mi > 59 || ss > 59) return null;
  const d = new Date(Date.UTC(yyyy, mo - 1, dd, hh, mi, ss));
  // Date.UTC silently rolls an out-of-range day (e.g. 31/02) into the next
  // month rather than rejecting it — round-tripping the parsed day/month/
  // year against what actually landed catches that instead of silently
  // scheduling the wrong date.
  if (d.getUTCDate() !== dd || d.getUTCMonth() !== mo - 1 || d.getUTCFullYear() !== yyyy) return null;
  return d;
}

// The base Date a date/time parameter's picker + offset field should start
// from: whatever's already been entered this session, else the schema's own
// current value, else "now" — shared between rendering the field and
// computing its final value so both agree on the same fallback.
function _procDateTimeBase(p, key) {
  const stored = _procArgValues[key];
  if (stored?.dt) {
    const d = _datetimeLocalUTCToDate(stored.dt);
    if (d) return d;
  }
  if (p.value) {
    const d = new Date(p.value);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

// Reads back a parameter's CURRENT form value (edited or original) in
// whatever shape scheduleProcedure's own payload expects:
//   - boolean param → a real JS boolean (a <select>'s .value is always a
//     string, so an edited "false" needs coercing back, not sent as-is)
//   - date/time param → picker + "seconds offset" field combined into one
//     instant, formatted as the 9-digit-nanosecond ISO string
//     tmrGapDownload.js's own _isoNanos uses for this same param type
//     (the one confirmed format SCC's procedure-scheduler accepts for a
//     java.time.Instant/AbsoluteTime field)
//   - numeric param → a real JS number (same "the <input>'s .value is
//     always a string" problem the boolean case has — see
//     _isProcParamNumeric's own comment)
//   - anything else (string/enum) → the stored/original value unchanged;
//     an enum's value IS meant to be its plain string name
//   - list param → a real JS array, one entry per row currently in the
//     editor (see _procListRowHTML/_procListRowCount), each entry itself
//     built by recursing this same function (or, for a nested "datetime"
//     field, _procListFieldValue's plain-text passthrough — see its own
//     comment) per element field. This is the fix for the confirmed live
//     SCC 500 ("expected a list but received a scalar value") — every OTHER
//     branch below can only ever produce a scalar.
function _procArgValue(p, key) {
  if (_isProcParamList(p)) {
    const fields = _procListElementFields(p);
    const isStruct = _procListIsStruct(p);
    const rowCount = _procListRowCount(p, key);
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      if (isStruct) {
        const obj = {};
        fields.forEach(f => {
          const fieldKey = _procListFieldKey(key, i, f.name);
          obj[f.name] = _procListFieldValue({ ...f, value: _procListFieldOriginalValue(p, f, i) }, fieldKey);
        });
        rows.push(obj);
      } else {
        const f = fields[0];
        const fieldKey = _procListFieldKey(key, i, f.name);
        rows.push(_procListFieldValue({ ...f, value: _procListFieldOriginalValue(p, f, i) }, fieldKey));
      }
    }
    return rows;
  }
  if (_isProcParamDateTime(p)) {
    const base      = _procDateTimeBase(p, key);
    const offsetSec = Number(_procArgValues[key]?.offsetSec ?? 0) || 0;
    const final      = new Date(base.getTime() + offsetSec * 1000);
    return final.toISOString().replace('Z', '000000Z');
  }
  let raw = _procArgValues[key] ?? _procParamSchemaDefault(p);
  if (_isProcParamBoolean(p)) return typeof raw === 'boolean' ? raw : raw === 'true';
  if (_isProcParamNumeric(p) && typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n; // an unparseable edit (rare — the field is free text) falls through and is sent as-is, same as today, rather than silently becoming 0/NaN
  }
  return raw;
}

function _isDoScheduleParam(p) {
  return (p?.name ?? '').toLowerCase() === 'doschedule';
}
// A second, independent way a procedure gates scheduleTime/subscheduleId —
// confirmed live (PANDORE, 172.17.203.1): ELEM_FSW_PUS140_CHANGE_PARAMETER
// has no doSchedule at all, instead a tcUploadMode enum (SEND_NOW /
// SEND_NOW_AND_VERIFY / SCHEDULE_SLOW_PUS / SCHEDULE_FAST_COP1) — the two
// mechanisms never coexist on one procedure, so _renderProcDetailView treats
// whichever ONE of these it finds as "the gate param" (see _gateParam).
function _isTcUploadModeParam(p) {
  return (p?.name ?? '').toLowerCase() === 'tcuploadmode';
}
// scheduleTime/subscheduleId — the two arguments a gate param controls (see
// _renderProcDetailView's collapsible group). scheduleTime already defaults
// to "now" for free via _procDateTimeBase's own null-value fallback; no
// special-casing needed there.
function _isGatedScheduleParam(p) {
  const n = (p?.name ?? '').toLowerCase();
  return n === 'scheduletime' || _isSubscheduleParam(p);
}
// tcUploadMode values that mean "send it now" — scheduleTime/subscheduleId
// stay hidden for these (and while unset — same "hidden until the operator
// actively asks for scheduling" default doSchedule's own null→false already
// follows). Exclusion-based rather than an explicit SCHEDULE_* allow-list:
// a future upload mode this app hasn't seen yet defaults to SHOWING the
// schedule fields, which is the safer failure direction (an operator can
// see and ignore an irrelevant field far more easily than one they never
// knew existed).
const TC_UPLOAD_MODE_HIDES_SCHEDULE = new Set(['SEND_NOW', 'SEND_NOW_AND_VERIFY']);

// Whichever kind of gate param this procedure has (doSchedule or
// tcUploadMode) says whether scheduleTime/subscheduleId should currently be
// SHOWN, given that param's own current value.
function _gateShowsSchedule(gateParam, value) {
  if (_isDoScheduleParam(gateParam))     return value === true;
  if (_isTcUploadModeParam(gateParam))   return value != null && !TC_UPLOAD_MODE_HIDES_SCHEDULE.has(value);
  return false;
}
function _isSubscheduleParam(p) {
  const n = (p?.name ?? '').toLowerCase();
  return n === 'subscheduleid' || n === 'subschedule';
}

// SCC's own schema default for this param, with two NAMED exceptions where
// the raw catalog entry genuinely ships none at all — deliberately not a
// blanket "first enumValues entry" fallback for every enum missing one
// (most have no sensible default to guess at; a wrong guess sent silently
// is worse than a blank field the operator has to notice and fill in):
//  - tcUploadMode (confirmed live: value:null despite it mattering — it's
//    what gates scheduleTime/subscheduleId's own visibility above)
//    defaults to SEND_NOW_AND_VERIFY specifically, not its own first
//    enumValues entry (SEND_NOW, no verification) — silently skipping the
//    verify step because a field happened to render blank is the wrong
//    direction to fail in.
//  - subscheduleId falls back to 0, per its own pre-existing special-case
function _procParamSchemaDefault(p) {
  if (p?.value != null) return p.value;
  if (_isTcUploadModeParam(p)) return 'SEND_NOW_AND_VERIFY';
  if (_isSubscheduleParam(p)) return 0;
  return null;
}

// Floating dropdown (.sch-proc-catalog, see style.css) — shown while the
// search input has focus, hidden on blur/Escape/picking a row, rather than
// always occupying its own permanent space in the column.
function _showProcCatalogDropdown() {
  document.getElementById('sch-proc-catalog')?.classList.add('sch-proc-catalog-open');
}
function _hideProcCatalogDropdown() {
  document.getElementById('sch-proc-catalog')?.classList.remove('sch-proc-catalog-open');
}

// Type-to-search replacement for a plain enumValues <select> — some of
// these lists are genuinely huge (confirmed live: parametersToChange offers
// 759 choices), where blind-scrolling a native dropdown is unworkable.
// Same "type to search, click to pick, floats open on focus" interaction
// the procedure search box itself already uses (#sch-proc-search/
// .sch-proc-catalog) — reused here rather than inventing a second combobox
// pattern. Deliberately keeps data-arg-key on the text input itself (not a
// separate hidden field) — the generic delegated input listener already
// wired in _renderProcDetailView picks up every keystroke exactly like any
// other free-text field, so a typed value that's never actually picked from
// the list still gets sent as typed (same "SCC's own response is the
// validation backstop" trust model every other unrecognized-type field in
// this app already follows) — clicking an option is a shortcut, not a gate.
function _procEnumComboHTML(key, value, extraClass = '') {
  const val = value != null ? String(value) : '';
  return `<div class="sch-combo" data-combo-key="${escapeHtml(key)}">
    <input type="text" class="sch-proc-arg-input sch-combo-input${extraClass ? ' ' + extraClass : ''}" data-arg-key="${escapeHtml(key)}" data-combo-key="${escapeHtml(key)}" value="${escapeHtml(val)}" autocomplete="off" spellcheck="false" />
    <span class="sch-combo-caret">▾</span>
    <div class="sch-combo-list" data-combo-key="${escapeHtml(key)}"></div>
  </div>`;
}

// Capped the same way the procedure-search dropdown itself already caps its
// own (also potentially long) list — narrowing via the search box is the
// intended way to reach a specific entry, not scrolling a 759-row panel.
const PROC_COMBO_CAP = 200;

function _comboOptionsHTML(enumValues, query) {
  const q = query.trim().toLowerCase();
  const filtered = q ? enumValues.filter(v => String(v).toLowerCase().includes(q)) : enumValues;
  if (!filtered.length) return '<div class="sch-empty-inline">No matches</div>';
  const rows = filtered.slice(0, PROC_COMBO_CAP).map(v => {
    const s = String(v);
    return `<div class="sch-combo-option" data-value="${escapeHtml(s)}">${escapeHtml(s)}</div>`;
  }).join('');
  const trunc = filtered.length > PROC_COMBO_CAP
    ? `<div class="sch-combo-trunc">+${filtered.length - PROC_COMBO_CAP} more — keep typing to narrow</div>`
    : '';
  return rows + trunc;
}

// key -> that field's own enumValues array, for whichever combos the render
// below actually drew. A side-channel rather than a value threaded through
// _procArgRowHTML/_procListRowHTML/_procListFieldInputHTML's own return-a-
// string signatures (same reasoning _procArgValues itself is module state:
// those render functions are already several .map() layers deep, and
// plumbing one more parameter through every level for a single consumer —
// _wireProcEnumCombos, called once after the HTML above is actually in the
// DOM — isn't worth it). Reset at the top of every _renderProcDetailView()
// call so a stale entry from a previous procedure/render never lingers.
let _procComboEnums = new Map();

// One argument row's HTML — a true/false <select> for a detected boolean, a
// type-to-search combo (_procEnumComboHTML) for an enum, a datetime picker +
// seconds-offset + quick-fill buttons for a detected date/time param, a
// plain text input otherwise. Extracted from the main render loop so the
// exact same per-param rendering applies whether a param sits in the normal
// flow or inside the doSchedule-gated collapsible group below.
function _procArgRowHTML(p, key) {
  const label     = p.name ?? p.id ?? key;
  const typeStr   = _procParamTypeLabel(p);
  // title= — the label truncates with an ellipsis past its own fixed
  // column width now (see .sch-proc-arg-label's own comment), so the full
  // name is still one hover away instead of just gone.
  const labelHTML = `<span class="sch-proc-arg-label" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}`
    + (typeStr ? ` <span class="sch-proc-arg-type">${escapeHtml(typeStr)}</span>` : '')
    + `</span>`;
  const value = _procArgValues[key] ?? _procParamSchemaDefault(p) ?? '';

  if (_isProcParamList(p)) return _procListRowHTML(p, key, labelHTML);

  if (_isProcParamDateTime(p)) {
    const base      = _procDateTimeBase(p, key);
    const offsetSec = _procArgValues[key]?.offsetSec ?? 0;
    // Plain text, not <input type="datetime-local"> — that control's
    // displayed format follows the browser's own UI locale (confirmed live:
    // even with a lang="en-GB" override on the element, Chrome kept showing
    // mm/dd/yyyy AM/PM), which datetime-local's CSS pseudo-elements can't
    // override either (they only style the native widget, not reorder its
    // fields or force 24h). A plain text field formatted/parsed by THIS
    // app (_fmtDTInput/_parseDTInput) is the only way to guarantee
    // dd/mm/yyyy HH:mm:ss regardless of the browser/OS locale.
    // The 📅 button opens _calendarPickerHTML below (a custom widget, not
    // the native picker — see its own header comment for why) right under
    // this field, toggled via _procCalendarKey.
    const calendarHTML = _procCalendarKey === key ? _calendarPickerHTML(key, base) : '';
    // Label, date/time inputs, AND the quickfill shortcuts all share one
    // row now — .sch-proc-arg-datetime itself wraps (flex-wrap) onto a
    // second line if the panel's too narrow to fit everything, rather than
    // forcing the quickfill buttons onto their own line unconditionally.
    return `<div class="sch-proc-arg-row">
      ${labelHTML}
      <div class="sch-proc-arg-field">
        <div class="sch-proc-arg-datetime">
          <input type="text" placeholder="dd/mm/yyyy HH:mm:ss" class="sch-proc-arg-input sch-proc-arg-dt" data-arg-key="${escapeHtml(key)}" data-fallback="${_dateToDatetimeLocalUTC(base)}" value="${_fmtDTInput(base)}" />
          <button type="button" class="sch-nav-btn sch-proc-arg-cal-btn${_procCalendarKey === key ? ' sch-proc-pick-btn-active' : ''}" data-arg-key="${escapeHtml(key)}" title="Pick from calendar">📅</button>
          <span class="sch-proc-arg-offset-lbl">UTC&nbsp;+</span>
          <input type="number" class="sch-proc-arg-input sch-proc-arg-offset" data-arg-key="${escapeHtml(key)}" data-arg-subkey="offsetSec" value="${offsetSec}" />
          <span class="sch-proc-arg-offset-lbl">s</span>
          <button type="button" class="sch-nav-btn sch-proc-quickfill-btn" data-arg-key="${escapeHtml(key)}" data-quickfill="los"${_selectedPass ? '' : ' disabled'}>CURRENT LOS+0</button>
          <button type="button" class="sch-nav-btn sch-proc-quickfill-btn" data-arg-key="${escapeHtml(key)}" data-quickfill="aos"${_nextPassAfterSelected() ? '' : ' disabled'}>NEXT AOS+0</button>
          <button type="button" class="sch-nav-btn sch-proc-pick-btn${_procDateTimePickKey === key ? ' sch-proc-pick-btn-active' : ''}" data-arg-key="${escapeHtml(key)}" title="Click a point on the timeline below to set this time">⏱ Pick</button>
          ${calendarHTML}
        </div>
      </div>
    </div>`;
  }
  return `<div class="sch-proc-arg-row">
    ${labelHTML}
    <div class="sch-proc-arg-field">${_procScalarFieldHTML(p, key, value)}</div>
  </div>`;
}

// The FIELD half only (no row/label wrapper) for a boolean/enum/plain-text
// param — never called for datetime or list (those have their own,
// structurally different, full-row rendering above). Factored out of
// _procArgRowHTML so _procGateHeaderHTML (below) can put a gate param's own
// field on the SAME line as the collapsible group's own toggle, instead of
// duplicating this select/combo/input logic a second time.
function _procScalarFieldHTML(p, key, value) {
  if (_isProcParamBoolean(p)) {
    const boolValue = typeof value === 'boolean' ? value : value === 'true';
    return `<select class="sch-proc-arg-select" data-arg-key="${escapeHtml(key)}">
      <option value="true"${boolValue ? ' selected' : ''}>true</option>
      <option value="false"${!boolValue ? ' selected' : ''}>false</option>
    </select>`;
  }
  if (Array.isArray(p.enumValues) && p.enumValues.length) {
    _procComboEnums.set(key, p.enumValues);
    // Confirmed live: this combo can render blank even though SCC's own
    // catalog entry clearly has a default selected somewhere — same
    // "GET /api/v1/procedure's exact shape isn't fully confirmed" gap
    // fetchProcedureCatalog's own warnings cover for the catalog LIST
    // shape (see its "no name field" warning), just not yet for a
    // parameter's own default-value field. Logs the raw param object once
    // per empty enum so the real field name (defaultValue? currentValue?
    // something under enumValues itself?) is visible instead of guessing.
    if (value === '' || value == null) {
      console.warn(`[Scheduler] enum param "${key}" has no resolved value — check the real default-value field:`, JSON.parse(JSON.stringify(p)));
    }
    return _procEnumComboHTML(key, value);
  }
  return `<input type="text" class="sch-proc-arg-input" data-arg-key="${escapeHtml(key)}" value="${escapeHtml(String(value))}" />`;
}

// The gate param's (doSchedule/tcUploadMode) OWN row doubles as the
// collapsible group's header — replaces what used to be TWO separate rows
// (the gate param, rendered like any other argument; a static "Schedule
// timing" toggle below it) with ONE: click the chevron/label to toggle
// manually, or just change the field itself — still the exact same live
// select/combo, wired the exact same generic way every other field is — to
// drive it automatically via _gateShowsSchedule (see the 'change' listener
// in _renderProcDetailView), same as before this merge.
function _procGateHeaderHTML(gateParam, gateKey, value) {
  const label   = gateParam.name ?? gateParam.id ?? gateKey;
  const typeStr = _procParamTypeLabel(gateParam);
  return `<div class="sch-proc-arg-row sch-proc-gated-header">
    <button type="button" class="sch-proc-gated-toggle" id="sch-proc-gated-toggle">
      <span class="sch-proc-gated-chevron">${_procScheduleGroupCollapsed ? '▸' : '▾'}</span>
      <span class="sch-proc-arg-label" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}${typeStr ? ` <span class="sch-proc-arg-type">${escapeHtml(typeStr)}</span>` : ''}</span>
    </button>
    <div class="sch-proc-arg-field">${_procScalarFieldHTML(gateParam, gateKey, value)}</div>
  </div>`;
}

// One element field's plain input — a true/false <select> for a detected
// boolean sub-field, an enumValues-backed <select> for an enum sub-field,
// plain text otherwise (including a detected date/time sub-field — see
// _procListFieldValue's own comment on why that one doesn't get the full
// picker widget here). Deliberately reuses data-arg-key (not a bespoke
// data-list-* attribute) so the generic delegated input listener already
// wired in _renderProcDetailView picks these up for free — no separate event
// plumbing needed for a nested field, same as every top-level scalar field.
function _procListFieldInputHTML(f, fieldKey) {
  const value = _procArgValues[fieldKey] ?? f.value ?? '';
  if (_isProcParamBoolean(f)) {
    const boolValue = typeof value === 'boolean' ? value : value === 'true';
    return `<select class="sch-proc-arg-select sch-proc-list-input" data-arg-key="${escapeHtml(fieldKey)}">
      <option value="true"${boolValue ? ' selected' : ''}>true</option>
      <option value="false"${!boolValue ? ' selected' : ''}>false</option>
    </select>`;
  }
  if (Array.isArray(f.enumValues) && f.enumValues.length) {
    _procComboEnums.set(fieldKey, f.enumValues);
    return _procEnumComboHTML(fieldKey, value, 'sch-proc-list-input');
  }
  const placeholder = _isProcParamDateTime(f) ? ' placeholder="e.g. 2026-07-30T12:00:00.000000000Z"' : '';
  return `<input type="text" class="sch-proc-arg-input sch-proc-list-input" data-arg-key="${escapeHtml(fieldKey)}" value="${escapeHtml(String(value))}"${placeholder} />`;
}

// A List-typed argument's own row — one block per current row (see
// _procListRowCount, which defaults this to 1 rather than 0), each holding
// one input per element field (struct rows get one labeled input per field;
// scalar rows get a single bare input), a per-row remove button, and an "Add
// entry" button below the last row (or in place of any rows at all, if the
// operator has removed every row down to a genuinely empty list — e.g. "no
// parameters to change" — rather than that being the untouched default).
// Field values are read fresh from the CURRENT
// _procArgValues/original-schema state on every render (same as every other
// param type in this file), not cached anywhere — see
// _procListFieldOriginalValue for the untouched-row fallback.
function _procListRowHTML(p, key, labelHTML) {
  const fields    = _procListElementFields(p);
  const isStruct  = _procListIsStruct(p);
  const rowCount  = _procListRowCount(p, key);
  const rowsHTML = [];
  for (let i = 0; i < rowCount; i++) {
    const fieldsHTML = fields.map(f => {
      const fieldKey    = _procListFieldKey(key, i, f.name);
      const fieldSchema = { ...f, value: _procListFieldOriginalValue(p, f, i) };
      const fieldLabel  = isStruct ? `<span class="sch-proc-list-field-label">${escapeHtml(f.name ?? '')}</span>` : '';
      return `<div class="sch-proc-list-field">${fieldLabel}${_procListFieldInputHTML(fieldSchema, fieldKey)}</div>`;
    }).join('');
    rowsHTML.push(`<div class="sch-proc-list-row">
      <div class="sch-proc-list-row-fields">${fieldsHTML}</div>
      <button type="button" class="sch-nav-btn sch-proc-list-remove-btn" data-list-key="${escapeHtml(key)}" data-row-idx="${i}" title="Remove this entry">✕</button>
    </div>`);
  }
  const body = rowCount
    ? rowsHTML.join('')
    : `<div class="sch-empty-inline sch-proc-list-empty">No entries.</div>`;
  // sch-proc-arg-row-list keeps this one in a COLUMN (label above body,
  // unlike every other arg type's now-inline label+field row) — a list
  // needs the vertical room for potentially several/struct rows below its
  // own label, not squeezed onto one line with them.
  // The add button sits on the SAME line as the label now (a small icon
  // button, not its own full "+ Add entry" row below the list) — same
  // small-bordered-icon-button treatment .co-actions-btn/.co-track-btn
  // already use elsewhere in this app, just here it's the row header's own
  // right-aligned action rather than a per-row one.
  return `<div class="sch-proc-arg-row sch-proc-arg-row-list">
    <div class="sch-proc-list-header">
      ${labelHTML}
      <button type="button" class="sch-proc-list-add-btn" data-list-key="${escapeHtml(key)}" title="Add entry">+</button>
    </div>
    <div class="sch-proc-list">${body}</div>
  </div>`;
}

// Collapse state for the doSchedule-gated group — which .sch-selectedProc
// this state currently belongs to is tracked separately (_procScheduleGroupForProc)
// so a NEW procedure selection resets it fresh (from doSchedule's own
// value), while an incidental re-render of the SAME procedure (e.g. the
// pass-selection-change re-render in _renderGantt) doesn't stomp over a
// manual toggle or the doSchedule-driven auto-toggle below.
let _procScheduleGroupCollapsed = true;
let _procScheduleGroupForProc   = null;

// Renders the argument form directly below the (always-visible) search
// bar — name, one row per detected parameter (see _procArgRowHTML), and the
// Schedule row. A placeholder shows instead when nothing's picked yet. No
// back button: the search bar stays visible and usable the whole time, so
// picking a different procedure just re-renders this in place. Called once
// when a procedure is picked, and again whenever the SELECTED PASS changes
// (future vs past changes whether Schedule is enabled — see _renderGantt's
// own procPanelKey guard).
//
// A procedure with a "doSchedule" boolean OR a "tcUploadMode" enum argument
// (never both — see _isTcUploadModeParam's own comment) gets scheduleTime/
// subscheduleId folded into a collapsible group right after that gate
// param's own row: collapsed while _gateShowsSchedule says its current value
// means "don't show", expanded once it doesn't — kept in sync automatically
// as the gate's own selector changes, but also manually toggleable
// regardless of that value (see the ▸/▾ button).
function _renderProcDetailView() {
  const detailView = document.getElementById('sch-proc-detail-view');
  if (!detailView) return;
  _procComboEnums = new Map(); // fresh per render — see its own comment
  if (!_selectedProc) {
    detailView.innerHTML = '<div class="sch-empty-inline">Search above and pick a procedure to configure its arguments.</div>';
    _procScheduleGroupForProc = null;
    return;
  }
  const name   = _procName(_selectedProc);
  const params = _findProcParams(_selectedProc);
  const gateParam = params?.find(p => _isDoScheduleParam(p) || _isTcUploadModeParam(p)) ?? null;

  if (_selectedProc !== _procScheduleGroupForProc) {
    _procScheduleGroupForProc = _selectedProc;
    _procScheduleGroupCollapsed = gateParam
      ? !_gateShowsSchedule(gateParam, _procArgValue(gateParam, _procParamKey(gateParam, params.indexOf(gateParam))))
      : true;
  }

  let argRowsHTML;
  if (!params?.length) {
    argRowsHTML = params
      ? '<div class="sch-empty-inline">This procedure takes no parameters.</div>'
      : '<div class="sch-empty-inline">No parameter schema found for this procedure — scheduling with none.</div>';
  } else {
    const flatRows = [];
    const gatedRows = [];
    let gateInsertIdx = -1;
    params.forEach((p, i) => {
      const key = _procParamKey(p, i);
      if (gateParam && _isGatedScheduleParam(p)) {
        gatedRows.push(_procArgRowHTML(p, key));
        return;
      }
      // Rendered as the collapsible group's own header below instead of a
      // normal row — gateInsertIdx marks where it would have landed, so the
      // group ends up in the SAME position in the list its own row used to.
      if (p === gateParam) { gateInsertIdx = flatRows.length; return; }
      flatRows.push(_procArgRowHTML(p, key));
    });
    // Group always renders once there's a gate param — even the (unlikely)
    // case of zero actual gated rows still needs SOMEWHERE to show the gate
    // param's own field, now that it no longer gets a normal row of its own.
    if (gateParam) {
      const gateKey  = _procParamKey(gateParam, params.indexOf(gateParam));
      const gateValue = _procArgValues[gateKey] ?? _procParamSchemaDefault(gateParam) ?? '';
      const bodyHTML = gatedRows.length ? `<div class="sch-proc-gated-body">${gatedRows.join('')}</div>` : '';
      const groupHTML = `<div class="sch-proc-gated-group${_procScheduleGroupCollapsed ? ' sch-proc-gated-collapsed' : ''}">
        ${_procGateHeaderHTML(gateParam, gateKey, gateValue)}
        ${bodyHTML}
      </div>`;
      flatRows.splice(gateInsertIdx, 0, groupHTML);
    }
    argRowsHTML = flatRows.join('');
  }

  const canSchedule = !!(_selectedPass && _selectedPass.future);

  detailView.innerHTML = `
    <div class="sch-proc-detail-header">
      <span class="sch-proc-detail-name" title="${escapeHtml(name)}">${escapeHtml(_procDisplayName(name))}</span>
    </div>
    <div class="sch-proc-arg-list">${argRowsHTML}</div>
    <div class="sch-proc-schedule-row">
      <button type="button" class="sch-nav-btn sch-proc-schedule-btn" id="sch-proc-schedule-btn"${canSchedule ? '' : ' disabled'} title="${canSchedule ? '' : 'Select an upcoming pass to schedule onto'}">Schedule</button>
    </div>
  `;

  // A date/time param's two fields (picker + seconds offset) share one
  // logical key but write to different SUB-fields of a {dt, offsetSec}
  // object (see _procDateTimeBase/_procArgValue) — data-arg-subkey marks
  // which; every other param type has no subkey and just overwrites its
  // key directly with the plain string value. The picker itself
  // (.sch-proc-arg-dt) is excluded here — its own text needs parsing before
  // it's a valid .dt value, handled by its dedicated listener below instead
  // of this generic raw-el.value one.
  detailView.querySelectorAll('input[data-arg-key]:not(.sch-proc-arg-dt), select[data-arg-key]').forEach(el => {
    el.addEventListener('input', () => {
      const key = el.dataset.argKey;
      const subkey = el.dataset.argSubkey;
      if (subkey) {
        _procArgValues[key] = { ..._procArgValues[key], [subkey]: el.value };
      } else {
        _procArgValues[key] = el.value;
      }
    });
  });
  // Type-to-search dropdown for every enum combo just drawn (see
  // _procEnumComboHTML) — purely the SHOW/FILTER/CLOSE behavior; the input's
  // own value (typed OR filled in by clicking an option below) is already
  // captured by the generic listener directly above, same as any other text
  // field, so nothing here touches _procArgValues itself.
  detailView.querySelectorAll('.sch-combo').forEach(wrap => {
    const key = wrap.dataset.comboKey;
    const enumValues = _procComboEnums.get(key) ?? [];
    const input = wrap.querySelector('.sch-combo-input');
    const list  = wrap.querySelector('.sch-combo-list');
    if (!input || !list) return;

    const renderList = query => {
      list.innerHTML = _comboOptionsHTML(enumValues, query);
      list.classList.add('sch-combo-list-open');
      // mousedown, not click — fires BEFORE the input's own blur (which
      // closes this list), same ordering fix the procedure search box's own
      // catalog rows already need (see _renderProcCatalogList's comment).
      list.querySelectorAll('.sch-combo-option').forEach(opt => {
        opt.addEventListener('mousedown', e => {
          e.preventDefault(); // don't let the browser shift focus around on mousedown
          input.value = opt.dataset.value;
          // Both events, deliberately: 'input' feeds the generic per-
          // keystroke value-storage listener above (same as any real
          // keystroke would); 'change' is what the gate-param listener
          // below listens for specifically — see its own comment on why
          // that one can't just reuse 'input' the way a plain field does.
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          list.classList.remove('sch-combo-list-open');
        });
      });
    };
    // Opening the list always starts from the FULL set, not filtered by
    // whatever's already selected — filtering by the current (committed)
    // value was showing just that one row, so changing a prior pick meant
    // deleting the text by hand before anything else appeared (confirmed
    // live — reported after re-opening a combo that already had a value).
    // select() on top: text typed immediately replaces the old value
    // instead of appending to it, same as a browser URL bar.
    input.addEventListener('focus', () => { renderList(''); input.select(); });
    // Typing is the one case that SHOULD filter by the current text — this
    // fires on every keystroke, same "narrows as you type" behavior a
    // search box is expected to have.
    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('blur', () => list.classList.remove('sch-combo-list-open'));
    input.addEventListener('keydown', e => { if (e.key === 'Escape') input.blur(); });
  });
  // Add/remove a row of a List-typed argument (see _isProcParamList/
  // _procListRowHTML) — unlike every other field edit above (which mutates
  // _procArgValues in place with no re-render), these change the row COUNT,
  // so the panel has to re-render regardless.
  detailView.querySelectorAll('.sch-proc-list-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.listKey;
      const p = params.find((pp, i) => _procParamKey(pp, i) === key);
      if (!p) return;
      _procListRowCounts[key] = _procListRowCount(p, key) + 1;
      _renderProcDetailView();
    });
  });
  detailView.querySelectorAll('.sch-proc-list-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.listKey;
      const rowIdx = Number(btn.dataset.rowIdx);
      const p = params.find((pp, i) => _procParamKey(pp, i) === key);
      if (!p) return;
      const fields = _procListElementFields(p);
      const count  = _procListRowCount(p, key);
      // Resolve every SURVIVING row's current value (edited, or still the
      // schema's own original — _procListFieldValue/_procArgValue already
      // know how to tell those apart) BEFORE touching anything. The
      // untouched-row fallback is keyed to a row's OLD index into the
      // schema's own p.value array (_procListFieldOriginalValue) — once rows
      // below the removed one shift down a slot, that positional fallback
      // would silently start reading the WRONG original entry for any row
      // that was never edited. Resolving first and writing the result back
      // as an explicit override at each row's NEW index sidesteps that.
      const resolved = [];
      for (let j = 0; j < count; j++) {
        if (j === rowIdx) continue;
        resolved.push(fields.map(f =>
          _procListFieldValue({ ...f, value: _procListFieldOriginalValue(p, f, j) }, _procListFieldKey(key, j, f.name))
        ));
      }
      fields.forEach(f => { for (let j = 0; j < count; j++) delete _procArgValues[_procListFieldKey(key, j, f.name)]; });
      resolved.forEach((rowValues, newIdx) => {
        fields.forEach((f, fi) => { _procArgValues[_procListFieldKey(key, newIdx, f.name)] = rowValues[fi]; });
      });
      _procListRowCounts[key] = count - 1;
      _renderProcDetailView();
    });
  });
  // dd/mm/yyyy HH:mm:ss text → the same {dt: <_dateToDatetimeLocalUTC
  // string>} shape the generic listener above writes for every other
  // date/time sub-field, kept on `change` (not `input`) so an in-progress,
  // not-yet-valid keystroke doesn't get judged before the user's done
  // typing. An unparseable result reverts to data-fallback (this field's
  // last known-good value, refreshed below on every successful parse)
  // rather than leaving invalid text silently ignored at submit time.
  detailView.querySelectorAll('.sch-proc-arg-dt').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.argKey;
      const d = _parseDTInput(el.value);
      if (!d) {
        showWarningToast('Invalid date/time — use dd/mm/yyyy HH:mm:ss');
        el.value = _fmtDTInput(_datetimeLocalUTCToDate(el.dataset.fallback));
        return;
      }
      const iso = _dateToDatetimeLocalUTC(d);
      _procArgValues[key] = { ..._procArgValues[key], dt: iso };
      el.dataset.fallback = iso;
      el.value = _fmtDTInput(d); // normalizes formatting (zero-padding etc.)
    });
  });
  // 📅 button → toggles _calendarPickerHTML open/closed for this row.
  // stopPropagation keeps this same click from also being seen by the
  // document-level outside-click-closes listener (initScheduler) — without
  // it, that listener would see the click land outside the (not-yet-open)
  // panel and immediately close what this handler just opened.
  detailView.querySelectorAll('.sch-proc-arg-cal-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.argKey;
      if (_procCalendarKey === key) { _closeCalendarPicker(); return; }
      _openCalendarPicker(key, _calendarCurrentBase(btn));
    });
  });
  // Prev/next month — only moves _procCalendarMonth (which month is
  // DISPLAYED), never touches the argument's actual value.
  detailView.querySelectorAll('.sch-dtcal-nav').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const m = _procCalendarMonth ?? new Date();
      _procCalendarMonth = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + Number(btn.dataset.calNav), 1));
      _renderProcDetailView();
    });
  });
  // Day click — keeps whatever time-of-day this field currently has
  // (_calendarCurrentBase), only swaps the date part, so picking a day
  // never silently resets an already-set time back to 00:00:00.
  detailView.querySelectorAll('.sch-dtcal-day').forEach(cell => {
    cell.addEventListener('click', e => {
      e.stopPropagation();
      const panel = cell.closest('.sch-dt-picker');
      const key = panel?.dataset.argKey;
      if (!key) return;
      const [y, mo, d] = cell.dataset.calDate.split('-').map(Number);
      const base = _calendarCurrentBase(panel);
      _procCalendarMonth = new Date(Date.UTC(y, mo - 1, 1));
      _commitCalendarValue(key, new Date(Date.UTC(y, mo - 1, d, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds())));
    });
  });
  // HH/MM/SS — keeps whatever date this field currently has, only swaps the
  // time-of-day part. `change` (not `input`), same "don't judge a
  // not-yet-finished edit" reasoning the text field's own listener uses.
  detailView.querySelectorAll('.sch-dtcal-time-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const panel = inp.closest('.sch-dt-picker');
      const key = panel?.dataset.argKey;
      if (!key) return;
      const base = _calendarCurrentBase(panel);
      const clamp = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max);
      const h  = clamp(panel.querySelector('[data-cal-time="h"]').value, 23);
      const mi = clamp(panel.querySelector('[data-cal-time="m"]').value, 59);
      const s  = clamp(panel.querySelector('[data-cal-time="s"]').value, 59);
      _commitCalendarValue(key, new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, mi, s)));
    });
  });
  detailView.querySelectorAll('.sch-dtcal-today-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.closest('.sch-dt-picker')?.dataset.argKey;
      if (!key) return;
      const now = new Date();
      _procCalendarMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      _commitCalendarValue(key, now);
    });
  });
  detailView.querySelectorAll('.sch-dtcal-close-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); _closeCalendarPicker(); });
  });
  // The gate param ALSO drives the gated group's collapse state — on top of
  // the generic value-storage listener above. 'change', deliberately NOT
  // 'input': doSchedule is a plain <select>, where the two fire together on
  // every selection either way, but tcUploadMode (enum) is now the type-to-
  // search combo's free-text <input> (see _procEnumComboHTML) — 'input'
  // fires on every SEARCH keystroke, not just a real pick, and this handler
  // calls _renderProcDetailView(), which tears down and rebuilds the whole
  // form (including this very input) — on 'input' that killed focus after
  // the first character typed (confirmed live). 'change' only fires once a
  // value actually COMMITS: a select's own choice, or (via the combo's own
  // option-click handler, which dispatches both) an option actually picked
  // — never a bare keystroke.
  if (gateParam) {
    const gateKey = _procParamKey(gateParam, params.indexOf(gateParam));
    detailView.querySelectorAll('[data-arg-key]').forEach(el => {
      if (el.dataset.argKey !== gateKey) return;
      el.addEventListener('change', () => {
        const value = _isDoScheduleParam(gateParam) ? el.value === 'true' : el.value;
        _procScheduleGroupCollapsed = !_gateShowsSchedule(gateParam, value);
        _renderProcDetailView();
      });
    });
  }
  // Manual override — expand/collapse regardless of the gate param's value.
  document.getElementById('sch-proc-gated-toggle')?.addEventListener('click', () => {
    _procScheduleGroupCollapsed = !_procScheduleGroupCollapsed;
    _renderProcDetailView();
  });
  // Quick-fill a date/time param straight from the current/next pass's own
  // LOS/AOS — re-renders the whole view (not just this one field) since
  // it's the simplest way to reflect the new value in the picker.
  detailView.querySelectorAll('.sch-proc-quickfill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.quickfill === 'los' ? _selectedPass?.end : _nextPassAfterSelected()?.start;
      if (!target) return;
      _procArgValues[btn.dataset.argKey] = { dt: _dateToDatetimeLocalUTC(target), offsetSec: 0 };
      _renderProcDetailView();
    });
  });
  // Toggles pick mode for this field — the actual gantt click that
  // consumes it is handled once, globally, in initScheduler (not
  // per-render here), since the click lands on the gantt body, not on
  // anything in this view.
  detailView.querySelectorAll('.sch-proc-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.argKey;
      if (_procDateTimePickKey === key) _exitDateTimePickMode();
      else _enterDateTimePickMode(key);
    });
  });
  document.getElementById('sch-proc-schedule-btn')?.addEventListener('click', _onScheduleProcClick);
  if (_procCalendarKey) _positionCalendarPicker();
}

function _renderProcCatalogList() {
  const list = document.getElementById('sch-proc-catalog');
  if (!list) return;
  if (_procCatalog == null) {
    list.innerHTML = '<div class="sch-empty-inline">Could not reach SCC to list procedures.</div>';
    return;
  }
  const search = (document.getElementById('sch-proc-search')?.value ?? '').trim().toLowerCase();
  const filtered = search
    ? _procCatalog.filter(p => _procName(p).toLowerCase().includes(search))
    : _procCatalog;
  if (!filtered.length) {
    list.innerHTML = _procCatalog.length
      ? '<div class="sch-empty-inline">No matching procedures.</div>'
      : '<div class="sch-empty-inline">SCC returned an empty procedure list.</div>';
    return;
  }
  // Capped — the catalog can be very long (per this feature's own "long
  // list" premise) and the search box is meant to narrow it down rather
  // than rendering thousands of rows at once for an unfiltered/short query.
  const PROC_LIST_CAP = 200;
  list.innerHTML = filtered.slice(0, PROC_LIST_CAP).map(p => {
    const name = _procName(p);
    return `<div class="sch-proc-catalog-row" data-name="${escapeHtml(name)}" title="${escapeHtml(name)}">${escapeHtml(_procDisplayName(name))}</div>`;
  }).join('');
  // mousedown, not click — click fires AFTER the search input's own blur
  // (which hides this dropdown, see initScheduler's blur handler), so by
  // the time a click would land the row is already gone from the DOM.
  // mousedown fires first, while the row is still there.
  list.querySelectorAll('.sch-proc-catalog-row').forEach(row => {
    row.addEventListener('mousedown', e => {
      e.preventDefault(); // don't let the browser shift focus around on mousedown
      const name = row.dataset.name;
      _selectedProc = filtered.find(p => _procName(p) === name) ?? { name };
      _procArgValues = {};
      _procListRowCounts = {};
      const searchInput = document.getElementById('sch-proc-search');
      if (searchInput) searchInput.value = ''; // fresh, unfiltered list next time this reopens
      _hideProcCatalogDropdown();
      _renderProcDetailView();
    });
  });
}

// Fetches the catalog for `sat` (once per satellite selection — see
// _selectSatellite) and renders the (unfiltered) list once it resolves.
function _loadProcedureCatalog(sat) {
  _procCatalog = null;
  _selectedProc = null;
  _procArgValues = {};
  _procListRowCounts = {};
  const myGen = ++_procCatalogGen;
  _renderProcDetailView();
  _renderProcCatalogList();
  fetchProcedureCatalog(sat).then(catalog => {
    if (myGen !== _procCatalogGen) return; // superseded by a newer satellite selection
    // Filters out compiler/closure-generated internal procedures (name
    // contains "$", e.g. "SAT_PERFORM_NCUBEMKII_MISSION$_run_closure1") —
    // not meant to be manually scheduled by an operator, same reasoning a
    // Java/Kotlin/Scala "$"-mangled synthetic class name is never something
    // a caller invokes directly.
    _procCatalog = Array.isArray(catalog) ? catalog.filter(p => !_procName(p).includes('$')) : catalog;
    _renderProcCatalogList();
  });
}

async function _onScheduleProcClick() {
  const sat = _sat();
  if (!sat || !_selectedPass || !_selectedProc) return;
  const btn = document.getElementById('sch-proc-schedule-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }
  try {
    const name   = _procName(_selectedProc);
    const params = _findProcParams(_selectedProc);
    // Re-applies the form's edited values onto a COPY of each original
    // param object — preserving whatever type/valueType/enumValues/etc.
    // fields the schema itself carries, since sending those back unchanged
    // (only `value` edited) is far safer than rebuilding a param object
    // from scratch in a shape this app doesn't actually know for certain.
    // _procArgValue coerces a detected boolean param back to a real JS
    // boolean — its <select> only ever stores the STRING 'true'/'false' as
    // an edit (every form element's own .value is a string), which would
    // otherwise get sent to SCC as literally the string "false" instead of
    // the boolean false.
    const procedureParameters = params
      ? params.map((p, i) => ({ ...p, value: _procArgValue(p, _procParamKey(p, i)) }))
      : [];
    await scheduleProcedure(sat, _selectedPass, name, procedureParameters);
    // Drop the cached GET result BEFORE refreshing — fetchScheduledProcedures
    // caches per satId+passId with no TTL, so without this the left column
    // would just replay the pre-schedule list forever instead of picking up
    // what was just added.
    invalidateScheduledProcedures(sat, _selectedPass);
    _getSccPassCheck(sat, { forceRefresh: true }); // same "keep the gap dashes honest" reasoning as the unschedule handler in _renderProcedurePanel
    showActionToast(`Scheduled ${_procDisplayName(name)} on this pass`);
    // Refresh the left column so the newly-scheduled procedure shows up
    // (only meaningful for a future pass — past ones don't take new
    // procedures, and _renderProcedurePanel's own future-check is a no-op
    // guard against calling this on one anyway).
    if (_selectedPass.future) _renderProcedurePanel(_selectedPass, sat);
  } catch (err) {
    showWarningToast(`Failed to schedule procedure: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Schedule'; }
  }
}

// SCC namespaces procedure names per-mission — confirmed live: this app's
// procedure-catalog warnings (fetchProcedureCatalog) showed real entries
// shaped like "procedures.mission.pandore.subsys.PLCU...", not the bare
// "procedures.ops.PASS...." TMTC_LINK_TEMPLATE hardcodes (borrowed from
// tmrGapDownload.js, whose own gap-download flow has this same assumption
// baked in). A literal string match against a different mission's namespace
// just silently fails against SCC — resolved here from the already-fetched
// catalog instead (matched by its own tail segment, namespace-agnostic), so
// the shortcut still finds the right procedure regardless of which
// mission's SCC it's pointed at. Falls back to the hardcoded name only if
// the catalog hasn't loaded yet or genuinely has no match.
const TMTC_LINK_TAIL = TMTC_LINK_TEMPLATE.procedureName.split('.').pop();

// null only means "catalog loaded, but genuinely nothing in it matches" —
// callers should treat that as a real "not found", not silently retry the
// hardcoded guess (which just repeats the same failure). Returns the
// hardcoded name as a best-effort guess when the catalog hasn't loaded at
// all yet (no evidence either way).
function _resolveTmtcLinkProcedureName() {
  if (!Array.isArray(_procCatalog)) return TMTC_LINK_TEMPLATE.procedureName;
  const entry = _procCatalog.find(p => _procName(p).split('.').pop() === TMTC_LINK_TAIL);
  return entry ? _procName(entry) : null;
}

// "Establish TMTC" shortcut — schedules OPS_PASS_ESTABLISH_TMTC_LINK
// (cop1FrameType: AD) directly onto the selected pass, bypassing the
// search/pick/argument-form flow above entirely: this procedure takes the
// same one fixed param every time (TMTC_LINK_TEMPLATE, shared with
// tmrGapDownload.js's own gap-download flow, which schedules this exact
// same procedure+params as an implicit prerequisite already), so there's
// nothing for a form to usefully ask the operator — only its NAME needs
// resolving per-mission (see _resolveTmtcLinkProcedureName above). No
// confirm() gate — same "fires immediately, acknowledged via a toast"
// convention satActionsMenu.js's mission-mode buttons use for the same
// reason (a real, deliberate action against a real satellite, not a
// destructive one).
async function _onEstablishTmtcClick() {
  const sat = _sat();
  if (!sat || !_selectedPass) return;
  const btn = document.getElementById('sch-establish-tmtc-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }
  try {
    const procedureName = _resolveTmtcLinkProcedureName();
    if (procedureName === null) {
      showWarningToast(`OPS_PASS_ESTABLISH_TMTC_LINK isn't in this satellite's procedure catalog — search "TMTC" above to find its real name for this mission.`);
      return;
    }
    await scheduleProcedure(sat, _selectedPass, procedureName, TMTC_LINK_TEMPLATE.procedureParameters);
    invalidateScheduledProcedures(sat, _selectedPass);
    _getSccPassCheck(sat, { forceRefresh: true }); // same "keep the gap dashes honest" reasoning as _onScheduleProcClick above
    showActionToast(`Scheduled ${_procDisplayName(procedureName)} on this pass`);
    if (_selectedPass.future) _renderProcedurePanel(_selectedPass, sat);
  } catch (err) {
    showWarningToast(`Failed to establish TMTC link: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = !_selectedPass; btn.textContent = 'Establish TMTC'; }
  }
}

// Green ring + neutral grey center on a future pass's dot in the "All
// passes" list — same "what's already queued on SCC" data passTooltip.js's
// own hover tooltip shows (fetchScheduledProcedures), just surfaced as a
// persistent glance-able mark instead of something you only see on hover.
// Only checked for FUTURE passes — a past pass's dot already carries its own
// outcome color (success/failure/cancelled), nothing left to "have
// scheduled" on it. Re-run on every render (the list's innerHTML is rebuilt
// wholesale in _renderGantt below, wiping any previous mark), but
// fetchScheduledProcedures' own per-sat+pass cache means every call after
// the first for a given pass resolves instantly instead of re-hitting SCC —
// cheap even across a fast pan/zoom re-render. Looked back up by data-start
// rather than closing over the row element directly, since a slower fetch
// resolving after the list was rebuilt again (different satellite, say)
// would otherwise mark a detached — or worse, since rows get reused by
// position, a WRONG — row.
function _markScheduledPassDots(sat, passes, passListEl) {
  for (const p of passes) {
    if (!p.future) continue;
    const startMs = p.start.getTime();
    fetchScheduledProcedures(sat, p).then(procs => {
      if (!procs?.length) return;
      const row = passListEl.querySelector(`.sch-pass-list-row[data-start="${startMs}"]`);
      const dot = row?.querySelector('.sch-pass-list-dot');
      if (!dot) return;
      dot.classList.add('sch-pass-list-dot-scheduled');
      // Grey center replacing _FUTURE_COLOR — inline, since it was set
      // inline in the first place (this row's own template literal above)
      // and a class-based override would need !important to win over it.
      dot.style.background = '#667';
    });
  }
}

function _renderGantt() {
  const ruler       = document.getElementById('sch-gantt-ruler');
  const eclipseTrack = document.getElementById('sch-gantt-eclipse');
  const passTrack    = document.getElementById('sch-gantt-pass');
  const planTrack    = document.getElementById('sch-gantt-plan');
  const tmrBusTrack  = document.getElementById('sch-gantt-tmr-bus');
  const tmrPayTrack  = document.getElementById('sch-gantt-tmr-pay');
  const timetagTrack = document.getElementById('sch-gantt-timetag'); // see _renderGanttTimetag/_triggerTimetag
  const selBody      = document.getElementById('sch-selected-body');
  const passListEl   = document.getElementById('sch-pass-list');
  if (!passTrack) return;

  const sat = _sat();
  if (!sat || _viewT0 == null) {
    if (ruler) ruler.innerHTML = '';
    if (eclipseTrack) { eclipseTrack.innerHTML = ''; eclipseTrack.style.background = ''; }
    if (passTrack)  passTrack.innerHTML  = '<div class="sch-empty">No satellite selected.</div>';
    if (planTrack)  planTrack.innerHTML  = '';
    if (tmrBusTrack) tmrBusTrack.innerHTML = '';
    if (tmrPayTrack) tmrPayTrack.innerHTML = '';
    if (timetagTrack) timetagTrack.innerHTML = '';
    if (selBody) selBody.innerHTML = '<div class="sch-empty">No satellite selected.</div>';
    if (passListEl) passListEl.innerHTML = '<div class="sch-empty-inline">No satellite selected.</div>';
    _renderProcedurePanel(null, sat);
    _updateNowLine();
    return;
  }

  const t0 = _viewT0, t1 = _viewT1;
  if (ruler) ruler.innerHTML = _rulerHTML(t0, t1);
  _updateNowLine();

  // Eclipse: bright sun-yellow track background, blue bars for actual
  // shadow windows — same convention _renderGanttEclipse (TimePlayer.js)
  // uses, "away from color = in sunlight" being the default rather than
  // something drawn.
  if (eclipseTrack) {
    eclipseTrack.style.background = '#e6b800aa';
    eclipseTrack.innerHTML = _eclipseWindows.map(w =>
      _barHTML(w.start, w.end, t0, t1, '#2244cc', ` data-start="${w.start}"`)).join('');
    eclipseTrack.querySelectorAll('.gantt-bar[data-start]').forEach(bar => {
      const startMs = Number(bar.dataset.start);
      const win = _eclipseWindows.find(w => w.start === startMs);
      if (!win) return;
      bar.style.cursor = 'help';
      bar.addEventListener('mouseenter', e => _showEclipseTooltip(e, win));
      bar.addEventListener('mouseleave', _hideTooltipSoon);
    });
  }

  const passes = _passes();
  passTrack.innerHTML = passes.length
    ? passes.map(p => _passBarHTML(p, t0, t1)).join('')
    : '<div class="sch-empty">No passes found for this satellite.</div>';
  // Hover tooltip — matched back to the full pass object by its own
  // data-start (set in _passBarHTML), same lookup-by-start-time the click
  // handler in initScheduler already uses to select a pass.
  passTrack.querySelectorAll('.gantt-bar[data-start]').forEach(bar => {
    const startMs = Number(bar.dataset.start);
    const pass = passes.find(p => p.start.getTime() === startMs);
    if (!pass) return;
    bar.addEventListener('mouseenter', e => _showPassTooltip(e, pass, sat));
    bar.addEventListener('mouseleave', _hideTooltipSoon);
  });

  // All-passes list (.sch-pass-list-panel, see style.css) — an alternative
  // to clicking a bar on the Pass row above: same chronological `passes`
  // array, same selection (_selectedPass = pass; _renderGantt()), just a
  // scrollable list instead of a proportional timeline, for when picking by
  // name/date is easier than finding the right bar at the current zoom.
  if (passListEl) {
    passListEl.innerHTML = passes.length
      ? passes.map(p => {
          const startMs  = p.start.getTime();
          const selected = _selectedPass && _selectedPass.start.getTime() === startMs;
          const color    = p.future ? _FUTURE_COLOR : (_OUTCOME_COLOR[p.outcome] ?? _OUTCOME_COLOR.SUCCESS);
          return `
            <div class="sch-pass-list-row${selected ? ' sch-pass-list-row-selected' : ''}" data-start="${startMs}">
              <span class="sch-pass-list-dot" style="background:${color}"></span>
              <span class="sch-pass-list-stn">${p.station ?? '—'}</span>
              <span class="sch-pass-list-date">${_fmtDTCompact(p.start)}</span>
              <span class="sch-pass-list-dur">${fmtDuration(p.end - p.start)}</span>
            </div>`;
        }).join('')
      : '<div class="sch-empty-inline">No passes found for this satellite.</div>';
    passListEl.querySelectorAll('.sch-pass-list-row[data-start]').forEach(row => {
      const startMs = Number(row.dataset.start);
      const pass = passes.find(p => p.start.getTime() === startMs);
      if (!pass) return;
      row.addEventListener('click', () => { _selectedPass = pass; _updateHash(); _renderGantt(); });
    });
    _markScheduledPassDots(sat, passes, passListEl);
  }

  if (planTrack) {
    const plans = _plans();
    // data-start, no title= — same reasoning as _passBarHTML: the hover
    // tooltip (_showPlanTooltip below) replaces the native one rather than
    // stacking alongside it.
    planTrack.innerHTML = plans.map(pl =>
      _barHTML(pl.start, pl.end, t0, t1, _PLAN_STATUS_COLOR[pl.status] ?? _PLAN_DEFAULT_COLOR,
        ` data-start="${pl.start}"`)).join('');
    planTrack.querySelectorAll('.gantt-bar[data-start]').forEach(bar => {
      const startMs = Number(bar.dataset.start);
      const plan = plans.find(pl => pl.start === startMs);
      if (!plan) return;
      bar.addEventListener('mouseenter', e => _showPlanTooltip(e, plan));
      bar.addEventListener('mouseleave', _hideTooltipSoon);
    });
  }

  _renderGanttTmr(tmrBusTrack, 'bus', t0, t1);
  _renderGanttTmr(tmrPayTrack, 'pay', t0, t1);
  _renderGanttTimetag(timetagTrack, t0, t1);

  // Left column re-renders (and, for a future pass, re-fetches) only when
  // the SELECTED PASS actually changes, not on every _renderGantt() call —
  // this function also runs on every pan/zoom tick, which would otherwise
  // thrash the panel (and re-hit fetchScheduledProcedures, cache or not)
  // many times a second while dragging.
  const procPanelKey = _selectedPass ? _selectedPass.start.getTime() : null;
  if (procPanelKey !== _procPanelKey) {
    _procPanelKey = procPanelKey;
    _renderProcedurePanel(_selectedPass, sat);
    // Re-check "can schedule onto this pass" (future vs past) if the detail
    // view (with a procedure already picked) is what's currently showing.
    if (_selectedProc) _renderProcDetailView();
    // Searching for a procedure to schedule is meaningless with no pass to
    // schedule it onto — disabled (not just left enabled-but-pointless)
    // native disabled both blocks focus/typing and gives the visual
    // affordance, same reasoning #gantt-toggle's own disabled state uses.
    const procSearchInput = document.getElementById('sch-proc-search');
    if (procSearchInput) {
      procSearchInput.disabled = !_selectedPass;
      procSearchInput.placeholder = _selectedPass ? 'Search procedures…' : 'Select a pass first';
      if (!_selectedPass) _hideProcCatalogDropdown();
    }
    // Same gating as the search input just to its left — nothing to
    // establish a TMTC link ONTO without a pass selected.
    const establishTmtcBtn = document.getElementById('sch-establish-tmtc-btn');
    if (establishTmtcBtn) establishTmtcBtn.disabled = !_selectedPass;
  }

  if (!selBody) return;
  if (!_selectedPass) {
    const hasNext = _passes().some(p => p.end.getTime() > _now());
    selBody.innerHTML = `
      <div class="sch-next-pass-empty">
        <span class="sch-empty-inline">No pass selected.</span>
        <button class="sch-nav-btn sch-next-pass-btn" id="sch-next-pass-btn"${hasNext ? '' : ' disabled'}>Next pass ▸</button>
      </div>
    `;
    document.getElementById('sch-next-pass-btn')?.addEventListener('click', _selectNextUpcomingPass);
    return;
  }
  const selPasses = _passes();
  const passIdx   = selPasses.findIndex(p => p.start.getTime() === _selectedPass.start.getTime());
  const atFirst   = passIdx <= 0;
  const atLast    = passIdx === -1 || passIdx >= selPasses.length - 1;
  selBody.innerHTML = `
    <div class="sch-selpass-card">
      <div class="sch-selpass-nav">
        <button class="sch-nav-btn" id="sch-pass-prev-btn" title="Previous pass"${atFirst ? ' disabled' : ''}>‹</button>
        <button class="sch-nav-btn" id="sch-pass-next-btn" title="Next pass"${atLast ? ' disabled' : ''}>›</button>
      </div>
      <div class="co-tt-time-row"><span class="co-tt-time-lbl">SAT</span>${sat.name}</div>
      <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(_selectedPass.end - _selectedPass.start)}</div>
      <div class="co-tt-time-row"><span class="co-tt-time-lbl">STN</span>${_selectedPass.station ?? '—'}${_selectedPass.network ? `<span class="co-tt-network">${_selectedPass.network}</span>` : ''}</div>
      <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${_fmtDT(_selectedPass.start)}</div>
      <div class="co-tt-time-row"><span class="co-tt-time-lbl">T-MINUS</span><span id="sch-selpass-countdown">${_fmtCountdown(_selectedPass.start.getTime() - _now())}</span></div>
      ${passEclipseBarHTML(sat.satrec, _selectedPass.start, _selectedPass.end)}
      <div class="pass-geometry-slot"></div>
    </div>
  `;
  document.getElementById('sch-pass-prev-btn')?.addEventListener('click', () => _stepSelectedPass(-1));
  document.getElementById('sch-pass-next-btn')?.addEventListener('click', () => _stepSelectedPass(1));
  _syncSelBodyMinHeight(selBody);
  _hydrateSelectedPassGeometry(_selectedPass, sat);
}

// pointermove (and rapid trackpad wheel ticks) can fire far more often than
// the display refreshes — coalesces any burst within one frame into a
// single rebuild, same reasoning (and same fix) as TimePlayer.js's own
// _scheduleApplyView.
let _renderRaf = null;
function _scheduleRender() {
  if (_renderRaf) return;
  _renderRaf = requestAnimationFrame(() => { _renderRaf = null; _renderGantt(); });
}

// ── Zoom / pan ───────────────────────────────────────────────────

// Wheel zoom: keep the time under the cursor fixed, rescale the view — same
// math as TimePlayer.js's own _onWheel, just against absolute ms instead of
// seconds-from-EPOCH, and pivoting off the Pass row's own track (any of the
// three would do; they're all the same width) rather than a scrub input
// this view doesn't have.
function _onWheel(e) {
  const passTrack = document.getElementById('sch-gantt-pass');
  if (_viewT0 == null || !passTrack) return;
  e.preventDefault();
  const rect = passTrack.getBoundingClientRect();
  if (!rect.width) return;
  const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const pivot   = _viewT0 + f * _viewSpan();
  const factor  = e.deltaY < 0 ? 0.6 : 1 / 0.6;
  const maxSpan = _winT1 - _winT0;
  const newSpan = Math.max(MIN_SPAN_MS, Math.min(maxSpan, _viewSpan() * factor));
  _viewT0 = pivot - f * newSpan;
  _viewT1 = pivot + (1 - f) * newSpan;
  _clampView();
  _scheduleRender();
}

// Drag-to-pan state — same left-drags-view-right relationship (and RAF
// batching via _scheduleRender) as TimePlayer.js's own _beginPan/_movePan.
let _pan = null; // { startX, startT0, startT1, trackW }

function _beginPan(clientX, trackW) {
  _pan = { startX: clientX, startT0: _viewT0, startT1: _viewT1, trackW };
}
function _movePan(clientX) {
  if (!_pan) return;
  const dx   = clientX - _pan.startX;
  const span = _pan.startT1 - _pan.startT0;
  const dMs  = -(dx / _pan.trackW) * span;
  _viewT0 = _pan.startT0 + dMs;
  _viewT1 = _pan.startT1 + dMs;
  _clampView();
  _scheduleRender();
}
function _endPan() { _pan = null; }

// Set at freeze time (below) to the satellite's id whenever the window was
// just frozen for a SIMULATED satellite whose clock offset (satSimu.js)
// hadn't resolved yet — satPing.js's own fetch is async and starts only
// once that satellite's ping cycle gets going, which this tab's auto-select
// (initScheduler's _renderSelector, on the very first store.satellites
// populate) can easily beat, especially for the FIRST satellite in the
// list, selected the instant it exists. Confirmed live: a simulated
// satellite in that slot froze its window against plain, uncorrected
// Date.now() and stayed wrong even after the real offset landed, since
// _selectSatellite otherwise only ever runs again on an actual selection
// change. null once corrected (see _recheckPendingOffsetCorrection below) or
// whenever nothing needs correcting in the first place.
let _pendingOffsetCorrectionSatId = null;

// Freezes a new ±WINDOW_MS window around "now" for this satellite, kicks off
// the eclipse computation and the plan fetch against it, and clears any
// selection carried over from a different satellite (which would otherwise
// be actively misleading, not just harmless leftover state).
// `userInitiated` gates the one side effect that reaches outside this module:
// store.setTrackedSat below. False for the boot-time auto-pick of
// store.satellites[0], true when a person actually chose this satellite (the
// selector's change event, or arriving from a pass tooltip / a URL hash).
// GlobeView.js's own comment spells out why that distinction matters —
// "no satellite should be tracked by default, since tracking drives extra
// background requests (TMR gap scan) that shouldn't fire until the user
// actually picks a satellite" — and this auto-pick was the only startup path
// that set it. Safe to gate: Scheduler writes trackedSatId but never reads it.
function _selectSatellite(satId, userInitiated = false) {
  _satId = satId;
  _selectedPass = null;
  _updateHash();
  const sat = _sat();
  if (!sat) {
    _pendingOffsetCorrectionSatId = null;
    _winT0 = _winT1 = _viewT0 = _viewT1 = null;
    _procCatalog = null;
    _selectedProc = null;
    _procArgValues = {};
    _procListRowCounts = {};
    ++_procCatalogGen; // invalidate any in-flight fetch from a previous satellite
    _renderProcDetailView();
    _renderProcCatalogList();
    _renderGantt();
    return;
  }
  // Keep the Visualizer pointed at whatever satellite is open in Scheduler —
  // switching tabs mid-task (e.g. to eyeball where it is right now before
  // queuing a procedure) should land on the right one, not whatever was
  // tracked last. Same store call Fleet's own one-click "track" icon uses.
  // Only on a deliberate choice, though — see the userInitiated comment above.
  if (userInitiated) store.setTrackedSat(sat.id);
  // satEffectiveNow, not Date.now(): satPasses.js fetches this satellite's
  // own pass data centered on ITS effective now (real Date.now() for a
  // normal satellite, clock-offset-corrected for a simulated one — see
  // satSimu.js) — this window has to match that exactly, or a simulated
  // satellite running on a sim clock far from real wall-clock time would
  // freeze a window with no pass data anywhere in it (see WINDOW_MS's own
  // comment).
  _pendingOffsetCorrectionSatId = (satIsSimulated(sat.noradId) && !hasSatTimeOffset(sat.noradId)) ? sat.id : null;
  const now = satEffectiveNow(sat.noradId);
  _winT0 = now - WINDOW_MS;
  _winT1 = now + WINDOW_MS;
  _viewT0 = _winT0; // fully zoomed out by default — same starting point as TimePlayer.js's own ±VIEW_HALF_SEC default
  _viewT1 = _winT1;
  _scheduleEclipseWork(sat, _winT0, _winT1);
  schedulePlanFetch(sat, _winT0, _winT1, plans => store.setPlans(sat.id, plans));
  _triggerTmr();
  _triggerTimetag();
  _loadProcedureCatalog(sat);
  _renderGantt();
}

// Runs on the same 1s tick as _updateNowLine/_updateSelPassCountdown (see
// initScheduler) — catches the moment a still-pending simulated satellite's
// clock offset (see _pendingOffsetCorrectionSatId's own comment) actually
// resolves, and re-freezes the window/eclipse/plan/TMR/timetag fetches
// against the now-corrected satEffectiveNow by just re-running the normal
// selection path. No-ops (cheap: two comparisons) once nothing's pending, or
// if the selection has since moved on to a different satellite — in which
// case there's nothing left here worth correcting.
function _recheckPendingOffsetCorrection() {
  if (_pendingOffsetCorrectionSatId == null || _pendingOffsetCorrectionSatId !== _satId) return;
  const sat = _sat();
  if (!sat || !hasSatTimeOffset(sat.noradId)) return;
  _selectSatellite(sat.id);
}

// Shared by setSchedulerSelection and restoreSchedulerSelection below — both
// land on the same satellite+pass, just gated differently for their two
// different callers (see each one's own comment).
function _applySelection(sat, pass) {
  // Reached via switchTab(), which doesn't click the tab button, so the gate has
  // to be opened here or the gantt would stay blank on a view the user is
  // looking at. Nothing is owed afterwards — the _selectSatellite below does
  // the same work _activate would have.
  _active = true;
  _pendingSelect = false;
  if (_satId !== sat.id) {
    const select = document.getElementById('sch-sat-select');
    if (select) select.value = sat.id;
    _selectSatellite(sat.id, true); // arrived here from a tooltip button or a URL hash — a real choice
  }
  // Re-resolved from THIS module's own _passes() rather than trusting the
  // passed-in pass object directly — by identity it's already the same
  // store.satPasses entry, but matching by start time keeps this robust
  // regardless, same "look it back up from the store" reasoning main.js's
  // own _restorePassSelection follows.
  const match = _passes().find(p => p.start.getTime() === pass.start.getTime());
  if (!match) return; // not in this satellite's currently fetched pass window
  _selectedPass = match;
  _updateHash();
  _renderGantt();
}

// Entry point for the pass tooltip's "Schedule procedures" button
// (passTooltip.js's _procedureListHTML), dispatched as sch:open-pass and
// wired up centrally in main.js — same shape as PassAnalyzer.js's own
// setSelection/pda:open-pass pair. Only meaningful for a future pass (the
// button itself is gated the same way _procedureListHTML gates on
// pass.future) — a past pass has nothing here to schedule.
export function setSchedulerSelection(sat, pass) {
  if (!sat || !pass?.future) return;
  _applySelection(sat, pass);
}

// Entry point for main.js's startup hash-restore, reading back the
// "scheduler/<sat>/pass/<ms>" shape _updateHash below writes. Deliberately
// NOT future-gated like setSchedulerSelection above — unlike the
// sch:open-pass bridge (always "queue something on this specific upcoming
// pass"), a reload/shared link can just as legitimately point at a past
// pass someone was reviewing (the pass list and gantt bars both let you
// pick either).
export function restoreSchedulerSelection(sat, pass) {
  if (!sat || !pass) return;
  _applySelection(sat, pass);
}

// Left column's (Scheduled procedures) width in px — dragged via
// .sch-schedule-divider (see _wireScheduleDivider below), same convention as
// PassAnalyzer.js's _paCol1Width/.pa-col-resizer: a column-width preference
// is a plain pixel amount an operator drags to taste, not a proportion of
// window size. 413px default (vs. an even 50/50 split): the left column is
// only ever a compact one-line-per-row list, while the right one holds the
// search box, catalog dropdown and argument form, which need most of the
// room. Module-level so it survives re-renders of either column.
let _schSplit = 413;
const SCH_SPLIT_MIN = 160;
const SCH_SPLIT_MAX = 640;

function _wireScheduleDivider() {
  const panel  = document.getElementById('sch-schedule-panel');
  const handle = document.getElementById('sch-schedule-divider');
  if (!panel || !handle) return;
  panel.style.setProperty('--sch-split', `${_schSplit}px`);
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.classList.add('sch-schedule-divider-active');
    const startX = e.clientX;
    const startW = _schSplit;
    const onMove = ev => {
      _schSplit = Math.min(SCH_SPLIT_MAX, Math.max(SCH_SPLIT_MIN, startW + (ev.clientX - startX)));
      panel.style.setProperty('--sch-split', `${_schSplit}px`);
    };
    const onUp = () => {
      handle.classList.remove('sch-schedule-divider-active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

export function initScheduler() {
  const select    = document.getElementById('sch-sat-select');
  const passTrack = document.getElementById('sch-gantt-pass');
  if (!select || !passTrack) return;

  _wireScheduleDivider();
  _wireTimetagFilterBtn();

  // Singleton hover tooltip for the Pass/Plan rows — same co-tooltip element
  // + hover-into-it-cancels-hide behavior as TimePlayer.js's own _ganttTooltip.
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'co-tooltip';
  _tooltipEl.style.display = 'none';
  document.body.appendChild(_tooltipEl);
  _tooltipEl.addEventListener('mouseenter', () => clearTimeout(_ttHideTimer));
  _tooltipEl.addEventListener('mouseleave', _hideTooltipSoon);

  // Establish TMTC — registered ONCE here, not inside _renderProcDetailView.
  // That function only ever runs once a procedure has already been picked
  // from the search/catalog (see _renderGantt's own `if (_selectedProc)`
  // guard), but this button is the shortcut that's meant to bypass picking
  // a procedure entirely — wiring it there meant a fresh pass selection,
  // with no procedure ever opened, left the click with no listener at all
  // and the button a silent no-op. The button itself is a static element
  // outside the detail view (sch-proc-search-wrap, not sch-proc-detail-view)
  // and never gets torn down/rebuilt, so one-time wiring here is enough —
  // its disabled state alone (toggled in _renderGantt) tracks pass selection.
  document.getElementById('sch-establish-tmtc-btn')?.addEventListener('click', _onEstablishTmtcClick);

  // Calendar picker (_calendarPickerHTML) dismissal — registered ONCE here
  // rather than inside _renderProcDetailView (which reruns on every keystroke/
  // interaction; a listener added there every time would stack duplicates).
  // Every interactive control INSIDE the panel already stops propagation on
  // its own click (see their handlers above), so this only ever sees a
  // genuine outside click.
  document.addEventListener('click', e => {
    if (_procCalendarKey && !e.target.closest('.sch-dt-picker')) _closeCalendarPicker();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _procCalendarKey) _closeCalendarPicker();
  });

  // Sticks with whichever satellite was already chosen across a
  // store.satellites refresh, rather than resetting to the first one.
  function _renderSelector() {
    const prev = _satId;
    if (!store.satellites.length) {
      select.innerHTML = '<option value="">— no satellites loaded —</option>';
      _selectSatellite(null);
      return;
    }
    // style="color:${s.color}" — the same per-satellite accent color the
    // Fleet row dot/gantt bars already use elsewhere (ChadOps.js's
    // --scc-color, InputPanel.js's --sat-dot), applied to the option itself
    // since a native <select>'s closed state can't host an actual colored
    // dot element. "🧪 SIM" suffix mirrors ChadOps.js's/InputPanel.js's own
    // simu badge text (same "not exported there either" — a <select>'s
    // options are plain text, so this can't reuse their .co-simu-badge/
    // .st-simu-badge markup, only the label itself).
    select.innerHTML = store.satellites.map(s => {
      const label = satIsSimulated(s.noradId) ? `${s.name}  🧪 SIM` : s.name;
      return `<option value="${s.id}" style="color:${s.color}">${label}</option>`;
    }).join('');
    const stillThere = prev && store.satellites.some(s => s.id === prev);
    const nextId = stillThere ? prev : store.satellites[0].id;
    select.value = nextId;
    // Options are up to date; the expensive part waits. _selectSatellite pulls
    // the procedure catalog, MIC plans and +/-5 days of eclipse/STT geometry, so
    // while this tab has never been opened all that is owed rather than done —
    // _activate() settles the debt on first open.
    if (!_active) { _pendingSelect = true; return; }
    if (nextId !== prev) _selectSatellite(nextId);
    else _renderGantt();
  }

  // First open of the Scheduler tab: pay off whatever _renderSelector deferred,
  // then behave normally from here on.
  function _activate() {
    if (_active) return; // idempotent: clicking the already-active tab must not redo the work
    _active = true;
    if (_pendingSelect) {
      _pendingSelect = false;
      _selectSatellite(select.value || null); // auto-pick, so NOT user-initiated — see _selectSatellite
    } else {
      _renderGantt();
    }
  }

  select.addEventListener('change', () => _selectSatellite(select.value || null, true));

  passTrack.addEventListener('click', e => {
    const bar = e.target.closest('.gantt-bar[data-start]');
    if (!bar) return;
    const startMs = Number(bar.dataset.start);
    const pass = _passes().find(p => p.start.getTime() === startMs);
    if (!pass) return;
    _selectedPass = pass;
    _updateHash();
    _renderGantt();
  });

  // Wheel-zoom + drag-to-pan, scoped to the ruler+rows wrapper (not the
  // panel title) — same pointer-capture approach TimePlayer.js's own gantt
  // uses. Pass bars ARE exempted (confirmed live: calling preventDefault()
  // on pointerdown suppresses the resulting click entirely, even for a
  // perfectly still, zero-movement press — not just a drag past some
  // threshold), same as TimePlayer.js exempts its own toggle buttons from
  // this same pointerdown handler for the same underlying reason. A click
  // that starts ON a bar always means "select this pass", never "begin a
  // pan from here" — dragging still works from anywhere else in the track.
  const body = document.getElementById('sch-gantt-body');
  body?.addEventListener('wheel', _onWheel, { passive: false });
  body?.addEventListener('pointerdown', e => {
    if (_procDateTimePickKey) return; // let the plain click below resolve into a pick instead of a pan
    if (e.button !== 0 || _viewT0 == null) return;
    if (e.target.closest?.('.gantt-bar[data-start]')) return;
    if (e.target.closest?.('.sch-timetag-filter-btn')) return; // the funnel icon's own click, not a pan start — same exemption pass bars get above
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    body.style.cursor = 'grabbing';
    _beginPan(e.clientX, passTrack.offsetWidth);
  });
  // "Pick from timeline" (see _enterDateTimePickMode) — capture phase, so
  // this runs BEFORE passTrack's own bubble-phase click-to-select-pass
  // listener above and can swallow the click before that fires. Works
  // anywhere on the gantt body, not just the Pass row, since any track
  // shares the same time axis.
  body?.addEventListener('click', e => {
    if (!_procDateTimePickKey) return;
    e.preventDefault();
    e.stopPropagation();
    const f = _ganttFracAtClientX(e.clientX);
    if (f != null) {
      const t = _viewT0 + f * _viewSpan();
      const key = _procDateTimePickKey;
      _procArgValues[key] = { ..._procArgValues[key], dt: _dateToDatetimeLocalUTC(new Date(t)) };
    }
    _exitDateTimePickMode();
  }, true);
  body?.addEventListener('pointermove', e => {
    if (_pan) _movePan(e.clientX);
    _updateCrosshair(e.clientX);
  });
  body?.addEventListener('pointerup',     () => { _endPan(); body.style.cursor = ''; });
  body?.addEventListener('pointercancel', () => { _endPan(); body.style.cursor = ''; });
  body?.addEventListener('pointerleave', _hideCrosshair);

  // "Now" line + hover crosshair overlay refs (see style.css's
  // .sch-gantt-overlay). Ticked on an interval rather than only redrawn on
  // render — see _updateNowLine's own comment for why.
  _nowLineEl        = document.getElementById('sch-gantt-now-full');
  _crosshairEl      = document.getElementById('sch-gantt-crosshair');
  _crosshairLabelEl = document.getElementById('sch-gantt-crosshair-label');
  setInterval(() => {
    if (!_active) return; // all three only move pixels on a gantt that isn't on screen
    _updateNowLine(); _updateSelPassCountdown(); _recheckPendingOffsetCorrection();
  }, 1000);

  // Right column: the catalog dropdown floats open only while actively
  // searching — shown on focus (rendering whatever's already fetched, even
  // before typing, so it isn't just a blank panel), re-filtered locally on
  // every keystroke (no re-fetch per keystroke — see _renderProcCatalogList),
  // hidden on blur or Escape. The Schedule button itself is wired in
  // _renderProcDetailView instead — it's created fresh each time that view
  // renders, not a static element here.
  const procSearchInput = document.getElementById('sch-proc-search');
  procSearchInput?.addEventListener('focus', () => {
    _renderProcCatalogList();
    _showProcCatalogDropdown();
  });
  procSearchInput?.addEventListener('input', _renderProcCatalogList);
  procSearchInput?.addEventListener('blur', _hideProcCatalogDropdown);
  procSearchInput?.addEventListener('keydown', e => {
    if (e.key === 'Escape') procSearchInput.blur(); // triggers the blur handler above
  });

  store.subscribe(key => {
    // _renderSelector stays ungated: it only rebuilds the <select>'s options
    // (and defers the actual selection when inactive — see its own comment), so
    // the dropdown is correct the instant the tab opens. Everything else here
    // renders a gantt nobody is looking at, and _triggerTmr in particular
    // re-arms the TMR gap scan — 76-124 requests to SCC per run.
    if (key === 'satellites') _renderSelector();
    if (!_active) return;
    if (key === 'satPasses')  { _renderGantt(); _triggerTmr(); _triggerTimetag(); }
    if (key === 'plans')      _renderGantt();
    if (key === 'tmrData')    _renderGantt();
  });

  // Tab gate. Mirrors ChadOps.js's own start()/stop() wiring — this module used
  // to do all of the below at boot regardless of whether the Scheduler was ever
  // opened: auto-select satellite[0], track it, fetch the whole SCC procedure
  // catalog, fetch MIC plans, precompute +/-5 days of eclipse/star-tracker
  // geometry, and issue one scheduled-procedure lookup per future pass.
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'scheduler') _activate();
      else _active = false;
    });
  });

  _renderSelector();
}
