import { store }                        from '../store.js';
import { propagate }                    from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { scheduleTmrFetch, TMR_SOURCES } from '../tmrData.js';
import { schedulePlanFetch }            from '../planData.js';
import { requestTmrGapDownload, fetchNextPassProcedures, findMatchingGapProcedure } from '../tmrGapDownload.js';
import { satSunExclDeg, satEarthExclDeg, MODEL_STAR_TRACKERS } from '../satStarTracker.js';
import { sampleAttitudeTable, DEFAULT_MAX_GAP_MS } from '../attitudeSample.js';
import { resolveRealAttitudeEntries, scheduleAttitudeFetch, applyRealAttitudeModelCorrection } from '../satAttitudeReal.js';
import { showActionToast }              from './actionToast.js';
import { passSimpleTooltipContent, hydratePassGeometry, hydrateScheduledProcedures, hydratePassStatusDots } from './passTooltip.js';
import { invalidateAllScheduledProcedures } from './scheduledProcedures.js';
import { escapeHtml }                   from './logView.js';
import { satSubsystemOrigin }           from '../satSubsystems.js';
import { fetchTcPackets, matchScheduledTargets, collectArguments, argUnitLabel, TC_114_NAME_RE, tcAckStatus } from '../tcPackets.js';
import { fetchTmPacket, extractTmParam } from '../satTelemetry.js';


const EPOCH = new Date();
let playing = false;
let speed = 1;
let scrubOffsetSec = 0;
let lastRaf = null;
let lastTs = null;

const playBtn     = document.getElementById('play-btn');
const nowBtn      = document.getElementById('now-btn');
const homeBtn     = document.getElementById('home-btn');
const recenterBtn = document.getElementById('recenter-btn');
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
const sttPovOpenBtn = document.getElementById('stt-pov-open-btn'); // click handler lives in sttPovWidget.js — referenced here only for the pan-gesture exemption below
const ganttTmr      = document.getElementById('gantt-tmr');
const ganttTmrPay   = document.getElementById('gantt-tmr-pay');
const ganttSlots    = document.getElementById('gantt-slots');
const ganttTimetag  = document.getElementById('gantt-timetag');
const ganttTimetagFilterBtn = document.getElementById('gantt-timetag-filter-btn');
const ganttRuler    = document.getElementById('gantt-ruler');
const ganttCrosshair      = document.getElementById('gantt-crosshair');
const ganttCrosshairLabel = document.getElementById('gantt-crosshair-label');

const ganttToggleBtn = document.getElementById('gantt-toggle');
const trackingViewEl = document.getElementById('tracking-view');

function _setGanttCollapsed(collapsed) {
  document.body.classList.toggle('gantt-collapsed', collapsed);
  if (ganttToggleBtn) ganttToggleBtn.textContent = collapsed ? '▼' : '▲';
  // ResizeObserver handles the layout sync after the height change
}

// The toggle can only OPEN the gantt when a satellite is tracked — there's
// nothing to show otherwise (every row's data is per-satellite). Native
// `disabled` both blocks the click and gives a visual affordance (see
// #gantt-toggle:disabled in style.css) — no separate guard needed in the
// click handler itself.
function _syncGanttToggleEnabled() {
  if (ganttToggleBtn) ganttToggleBtn.disabled = !store.trackedSat;
}

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

// Zoom / view state — the visible time window in seconds offset from EPOCH.
// VIEW_HALF_SEC is the single source of truth for "how far out the gantt can
// ever show" — it bounds the initial view, the max zoom-out, the manual
// date-jump clamp, AND the eclipse/STT precompute window (ECLIPSE_HALF_SEC)
// below, so every row shares the same horizon at max zoom-out instead of each
// one running out of data at a different point (eclipse/STT were previously
// precomputed to ±14 days while passes/TMR were only ever fetched for ±7 —
// and the view could zoom out to ±30, exposing both mismatches at once).
const VIEW_HALF_SEC = 5 * 86400; // ±5 days
const MIN_SPAN_SEC  = 300;       // 5 minutes
const MAX_SPAN_SEC  = VIEW_HALF_SEC * 2;
let viewStartSec = -VIEW_HALF_SEC;
let viewEndSec   =  VIEW_HALF_SEC;

// Eclipse/STT windows computed once per satellite, for a ±VIEW_HALF_SEC range
// around EPOCH — matches the max zoom-out so this data never runs out inside
// the visible view (see VIEW_HALF_SEC above).
const ECLIPSE_HALF_SEC = VIEW_HALF_SEC;
const R_EARTH_KM = 6371;
// Top-of-atmosphere altitude (~Kármán line) — the actual optical edge that
// blinds a star tracker via atmospheric glow/scatter, not the solid surface.
// Used as the geometric Earth radius for blinding purposes instead of plain
// R_EARTH_KM; the solid radius is kept separately (earthRadiusDeg) only for
// drawing Earth's true disk size in the STT POV widget (sttPov.js).
const EARTH_LIMB_KM = 100;
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
// Removes `boresight`'s component from `candidate` and renormalizes — null
// if what's left is too small to normalize safely (candidate ≈ ±boresight).
function _gramSchmidtUp(candidate, boresight) {
  const d = _dot(candidate, boresight);
  const raw = { x: candidate.x - boresight.x * d, y: candidate.y - boresight.y * d, z: candidate.z - boresight.z * d };
  const len = Math.sqrt(raw.x ** 2 + raw.y ** 2 + raw.z ** 2);
  return len > 1e-6 ? { x: raw.x / len, y: raw.y / len, z: raw.z / len } : null;
}

// Rotates vector `v` by quaternion `q` ({x,y,z,w}, scalar-last — the
// convention store.attitude's posted entries use, same as Cesium.Quaternion,
// NOT satStarTracker.js's bodyDirFromQuat's scalar-first convention, which is
// a different fixed constant unrelated to this live table). Standard
// optimized quaternion-vector rotation (avoids a full quaternion multiply).
function _rotateByQuat(q, v) {
  const t = _cross({ x: q.x, y: q.y, z: q.z }, v);
  t.x *= 2; t.y *= 2; t.z *= 2;
  const c = _cross({ x: q.x, y: q.y, z: q.z }, t);
  return { x: v.x + q.w * t.x + c.x, y: v.y + q.w * t.y + c.y, z: v.z + q.w * t.z + c.z };
}

// The satellite's (xECI, yECI, zECI) body-axis basis at `date` — real
// attitude (MIC-fetched, then legacy posted, SLERPed via the shared
// attitudeSample.js utility) when available for `date`, else the same
// Default Sun Pointing assumption SatEntity.js's own _computeOrientation
// fallback uses (X=sun, Y=zenith projected perpendicular to sun via
// Gram-Schmidt, Z completes the frame). Mirrors SatEntity.js's
// _attitudeFromTable/_computeOrientation exactly, just in ECI instead of
// ECEF — skips its gmst rotation entirely, since angle-between/magnitude
// (all _isConeBlinded/computeSttGeometry actually need) are
// rotation-invariant, so this gives identical results without needing gmst
// here at all. Null if degenerate (no real attitude AND sun≈zenith).
function _attitudeBasisEci(noradId, date, eciPos, sunDir) {
  const tMs = date.getTime();
  const realEntries = resolveRealAttitudeEntries(noradId, tMs);
  const att = store.attitude[noradId]; // legacy externally-posted — separate from MIC, lower-priority fallback
  const entries = realEntries ?? (att?.entries?.length ? att.entries : null);
  if (entries) {
    let q = sampleAttitudeTable(entries, tMs, DEFAULT_MAX_GAP_MS);
    if (q && realEntries) { // real (MIC) branch only, never legacy-posted
      const model = store.satellites.find(s => s.noradId === noradId)?.model;
      q = applyRealAttitudeModelCorrection(q, model);
    }
    if (q) {
      return {
        xECI: _rotateByQuat(q, { x: 1, y: 0, z: 0 }),
        yECI: _rotateByQuat(q, { x: 0, y: 1, z: 0 }),
        zECI: _rotateByQuat(q, { x: 0, y: 0, z: 1 }),
      };
    }
  }
  const rMag = Math.sqrt(eciPos.x ** 2 + eciPos.y ** 2 + eciPos.z ** 2);
  const zenith = { x: eciPos.x / rMag, y: eciPos.y / rMag, z: eciPos.z / rMag };
  const xECI = sunDir;
  const dot  = _dot(zenith, xECI);
  const yRaw = _sub(zenith, { x: xECI.x * dot, y: xECI.y * dot, z: xECI.z * dot });
  const yLen = Math.sqrt(yRaw.x ** 2 + yRaw.y ** 2 + yRaw.z ** 2);
  if (yLen < 1e-6) return null; // degenerate: sun ≈ zenith
  const yECI = { x: yRaw.x / yLen, y: yRaw.y / yLen, z: yRaw.z / yLen };
  const zECI = _cross(xECI, yECI);
  return { xECI, yECI, zECI };
}

// Mirrors SatEntity.js's _computeOrientation + _updateStarTrackerCones' per-
// cone boresight, in plain ECI vectors (see _attitudeBasisEci above for why
// ECI, skipping SatEntity.js's gmst→ECEF step, gives identical results).
// 'anti-sun' cones always point -sun (this mode has no attitude dependency
// at all, real or assumed). 'body' cones (all current models, including
// 12U — see MODEL_STAR_TRACKERS) need the actual attitude basis (real when
// available, else Default Sun Pointing).
function _sttConeBoresightEci(eciPos, sunDir, cfg, noradId, date) {
  if (cfg.mode !== 'body') return { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z };
  const basis = _attitudeBasisEci(noradId, date, eciPos, sunDir);
  if (!basis) return { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z }; // degenerate fallback
  const { xECI, yECI, zECI } = basis;
  // Same arrow-labeled-frame → raw-basis conversion as SatEntity.js's
  // _updateStarTrackerCones: (-dir.z,-dir.y,-dir.x) weights (xECI,yECI,zECI).
  const { dir } = cfg;
  return _normalize({
    x: -dir.z * xECI.x - dir.y * yECI.x - dir.x * zECI.x,
    y: -dir.z * xECI.y - dir.y * yECI.y - dir.x * zECI.y,
    z: -dir.z * xECI.z - dir.y * yECI.z - dir.x * zECI.z,
  });
}

function _angleDeg(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, _dot(a, b)))) * 180 / Math.PI;
}

function _isConeBlinded(eciPos, sunDir, cfg, sunExclDeg, earthExclDeg, noradId, date) {
  const rMag = Math.sqrt(eciPos.x ** 2 + eciPos.y ** 2 + eciPos.z ** 2);
  const nadir = { x: -eciPos.x / rMag, y: -eciPos.y / rMag, z: -eciPos.z / rMag };
  const boresight = _sttConeBoresightEci(eciPos, sunDir, cfg, noradId, date);
  const sunAngleDeg    = _angleDeg(boresight, sunDir);
  const earthAngleDeg  = _angleDeg(boresight, nadir);
  const earthLimbRadiusDeg = Math.asin(Math.max(-1, Math.min(1, (R_EARTH_KM + EARTH_LIMB_KM) / rMag))) * 180 / Math.PI;
  return sunAngleDeg < sunExclDeg || earthAngleDeg < earthLimbRadiusDeg + earthExclDeg;
}

// Projects unit vector `v` into the local (up, right) frame around
// `boresight` as {az, dist} degrees — dist is the angular separation from
// boresight (the same value _isConeBlinded already computes for sun/earth),
// az is rotation around it measured from `up` toward `right`. Degenerate at
// dist≈180° (v opposite boresight — a real, if momentary, case for any
// 'body'-mode cone whose attitude currently has it facing the sun/nadir
// dead-on) — az is meaningless there, but that case renders off the edge of
// any reasonable POV circle anyway, so it doesn't matter.
// Near dist≈0° (v≈boresight) or dist≈180° (v≈-boresight), both dot(v,up)
// and dot(v,right) collapse toward zero together,
// since v is then nearly (anti)parallel to boresight and up/right are both
// perpendicular to it. atan2 of two near-zero, floating-point-noisy values
// is essentially a random angle that changes wildly frame to frame even
// though the real geometry barely moved — visually, the point spins rapidly
// around the rim instead of sitting still. Same threshold/pattern as
// _gramSchmidtUp's own degenerate check above: below it, azimuth is
// genuinely undefined, so freeze it at a fixed reference (0°) instead of
// rendering whatever noise atan2 happens to return.
function _projectAroundBoresight(v, boresight, up, right) {
  const uComp = _dot(v, up), rComp = _dot(v, right);
  const az = (uComp * uComp + rComp * rComp) > 1e-12 ? Math.atan2(rComp, uComp) * 180 / Math.PI : 0;
  return { az, dist: _angleDeg(boresight, v) };
}

// Star tracker POV geometry for one cone at one instant — same underlying
// math as _isConeBlinded above (boresight/sun-angle/earth-angle), reused
// rather than re-derived so sttPovWidget.js's circular view can never drift
// out of sync with what the gantt's own STT row is actually showing. Adds a
// 2D projection: a local (up, right) frame perpendicular to the boresight,
// built from the orbit normal (cross(position, velocity)) as a stable "roll"
// reference — an 'anti-sun' cone's boresight has no roll of its own to
// borrow (by construction, its boresight = -sunDir exactly, so its
// Sun-to-boresight angle is always precisely 180° and Sun exclusion can
// never actually trigger for it, only Earth crossing into view does; no
// current model uses this mode, but the geometry still has to handle it).
// This gives every model a consistent, non-arbitrary orientation to render
// against instead of an undefined one. Returns null if the satellite can't
// currently be propagated (e.g. decayed).
export function computeSttGeometry(sat, date, cfg, sunExclDeg, earthExclDeg) {
  const r = propagate(sat.satrec, date);
  if (!r) return null;
  const { eciPos, eciVel } = r;
  const sunDir = sunDirectionECI(date);
  const rMag = Math.sqrt(eciPos.x ** 2 + eciPos.y ** 2 + eciPos.z ** 2);
  const nadir = { x: -eciPos.x / rMag, y: -eciPos.y / rMag, z: -eciPos.z / rMag };
  const boresight = _sttConeBoresightEci(eciPos, sunDir, cfg, sat.noradId, date);

  const sunAngleDeg    = _angleDeg(boresight, sunDir);
  const earthAngleDeg  = _angleDeg(boresight, nadir);
  // Solid-body radius — Earth's true disk size, for drawing it in sttPov.js.
  const earthRadiusDeg = Math.asin(Math.max(-1, Math.min(1, R_EARTH_KM / rMag))) * 180 / Math.PI;
  // Top-of-atmosphere radius — the actual blinding threshold (see
  // EARTH_LIMB_KM above), and what's drawn as the faint "Earth Limb" ring
  // just outside the solid disk.
  const earthLimbRadiusDeg = Math.asin(Math.max(-1, Math.min(1, (R_EARTH_KM + EARTH_LIMB_KM) / rMag))) * 180 / Math.PI;
  // Kept separate (not just their OR) so sttPov.js can highlight whichever
  // specific threshold ring was actually crossed instead of a generic
  // "something is blinded" indicator — either can be true independently
  // (fused STT blinding is only "every cone blinded", but a single cone can
  // be blinded by Sun, Earth, or both at once).
  const sunBlinded   = sunAngleDeg < sunExclDeg;
  const earthBlinded = earthAngleDeg < earthLimbRadiusDeg + earthExclDeg;
  const blinded = sunBlinded || earthBlinded;

  const orbitNormal = _normalize(_cross(eciPos, eciVel));
  const up = _gramSchmidtUp(orbitNormal, boresight)
    ?? _gramSchmidtUp({ x: 0, y: 0, z: 1 }, boresight)
    ?? { x: 1, y: 0, z: 0 };
  const right = _cross(boresight, up);

  return {
    blinded, sunBlinded, earthBlinded, sunAngleDeg, earthAngleDeg, earthRadiusDeg, earthLimbRadiusDeg, sunExclDeg, earthExclDeg,
    sun:   _projectAroundBoresight(sunDir, boresight, up, right),
    earth: _projectAroundBoresight(nadir,  boresight, up, right),
  };
}

let _passWindows    = []; // [{ start: ms, end: ms, pass: fullPassObj }]
let _planWindows    = []; // [{ start: ms, end: ms, plan: fullPlanObj }] — see planData.js; per-satellite, same scoping as _passWindows

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

// Fast, synchronous hover preview — see passTooltip.js. Full detail (polar
// plot, Eb/N0 chart, procedure history/report) lives in PassAnalyzer.js
// instead, reached via this tooltip's own "Open with Pass Analyzer" button.
function _showPassTooltip(e, pass) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a pass, not a gap
  _ganttTooltip.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _ganttTooltip.innerHTML     = passSimpleTooltipContent(pass, store.trackedSat);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
  hydratePassGeometry(_ganttTooltip, e, pass, store.trackedSat);
  hydrateScheduledProcedures(_ganttTooltip, pass, store.trackedSat);
  hydratePassStatusDots(_ganttTooltip, pass, store.trackedSat);
}

// `comments` is a JSON-encoded string (pass-geometry metadata) — parsed into
// readable "key: value" pairs when it's actually JSON, shown as-is otherwise
// rather than a raw escaped blob.
function _formatPlanComment(raw) {
  if (!raw) return '—';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
  } catch { /* not JSON — fall through to raw text */ }
  return raw;
}

function _planTooltipHTML(plan) {
  // Same color the bar itself uses (_planColor, defined below) — so the
  // pill and the bar always agree, and any status this app doesn't have a
  // dedicated color for yet (see _PLAN_STATUS_COLOR's own comment) still
  // reads clearly instead of silently having no status shown at all.
  const c   = _planColor(plan.status);
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
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a plan, not a gap
  _ganttTooltip.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _ganttTooltip.innerHTML     = _planTooltipHTML(plan);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
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

function _passLabel(pass) {
  if (!pass) return '—';
  return pass.groundStationId ? `${pass.groundStationId} (${_fmtDT(pass.start)})` : _fmtDT(pass.start);
}

// The onboard TM store is a circular buffer holding ~3 days before newer
// telemetry starts overwriting the oldest — so an ungrounded gap becomes
// increasingly urgent to download as it approaches that limit, then (once
// past it) is likely gone for good. Judged from real wall-clock time against
// the gap's own end (the most recent moment still missing), not the
// simulated/scrubbed time — the buffer ages in the real world regardless of
// what the timeline is currently scrubbed to.
const GAP_WARN_MS = 2 * 86_400_000; // 2 days: getting close to being overwritten
const GAP_LOST_MS = 3 * 86_400_000; // 3 days: the buffer's approximate hold time

function _gapAgeMs(gap) {
  return Date.now() - gap.end;
}

// null (not yet urgent) | 'warn' (2-3 days) | 'lost' (past 3 days)
function _gapUrgency(gap) {
  const age = _gapAgeMs(gap);
  if (age >= GAP_LOST_MS) return 'lost';
  if (age >= GAP_WARN_MS) return 'warn';
  return null;
}

const _GAP_URGENCY_STATUS = {
  warn: 'Approaching the ~3-day onboard TM buffer limit — download soon or this data will be overwritten.',
  lost: 'Past the ~3-day onboard TM buffer limit — this data has likely already been overwritten onboard.',
};

// `match` is a scheduled-procedure object from findMatchingGapProcedure (or
// null/undefined if none matched, or the check hasn't resolved yet — either
// way the button stays enabled; only a confirmed match greys it out). `pass`
// is the separate {groundStationId, start} the match was found on — it's not
// a field of `match` itself (findMatchingGapProcedure returns the raw
// scheduled-procedure entry, which has no knowledge of which pass it's on).
function _gapTooltipHTML(gap, match, pass) {
  const start = new Date(gap.start);
  const end   = new Date(gap.end);
  const hdr   = `<div class="co-tt-header">TMR GAP · ${_fmtGapDuration(end - start)}</div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">FROM</span>${_fmtDT(start)}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">TO</span>${_fmtDT(end)}</div>`;
  const urgency     = _gapUrgency(gap);
  const urgencyHtml = urgency ? `<div class="co-tt-gap-status co-tt-gap-${urgency}">${_GAP_URGENCY_STATUS[urgency]}</div>` : '';
  if (match) {
    const status = `<div class="co-tt-gap-status">TMR was requested in pass ${_passLabel(pass)}</div>`;
    const btn = `<button type="button" class="co-tt-gap-btn" disabled>Download Gap TMR</button>`;
    return hdr + times + status + urgencyHtml + btn;
  }
  const btn = `<button type="button" class="co-tt-gap-btn">Download Gap TMR</button>`;
  return hdr + times + urgencyHtml + btn;
}

// Gaps with a successful/already-scheduled download request — rendered
// green/diagonal-dashed, contained to the gap's own start→end bounds (see
// _renderGanttTmr). Once the backfill actually lands, the gap simply stops
// appearing in gapWindows and the full green coverage bar shows through
// underneath — no separate "success" rendering needed.
//
// Ground truth for "is this requested?" is SCC's own scheduled-procedures
// list on the satellite's next pass (see tmrGapDownload.js's
// fetchNextPassProcedures/findMatchingGapProcedure) — not a local flag — so
// this is naturally shared across every client looking at the same
// satellite, and survives a reload for free. Cached per satellite (all of a
// satellite's gaps share the same "next pass", so one fetch serves every gap
// via the pure, no-network findMatchingGapProcedure).
const SCC_CHECK_TTL_MS = 30_000;
const _sccPassCache = new Map(); // satId → { atMs, data: {pass, scheduled} | null }
let _openGapTooltip = null; // { gap, sat } while a gap tooltip is visible — lets a background refresh patch it in place

// Returns whatever's currently cached (possibly stale, possibly null if never
// fetched) and, if it's stale/forced, kicks off a background refresh that
// re-renders the TMR row and the open gap tooltip (if any) once it resolves.
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
      if (_openGapTooltip?.sat.id === sat.id && _ganttTooltip.style.display !== 'none') {
        _renderGapTooltip(_openGapTooltip.gap, _openGapTooltip.sat, _openGapTooltip.source);
        _posTooltipAt(_ttAnchorX, _ttAnchorY);
      }
    });
  }
  return cached?.data ?? null;
}

function _renderGapTooltip(gap, sat, source) {
  const data  = _sccPassCache.get(sat.id)?.data ?? null;
  const match = findMatchingGapProcedure(data?.scheduled, gap, source);
  _ganttTooltip.innerHTML = _gapTooltipHTML(gap, match, data?.pass);
  const btn = _ganttTooltip.querySelector('.co-tt-gap-btn');
  if (btn && !btn.disabled) {
    btn.addEventListener('click', async () => {
      btn.disabled    = true;
      btn.textContent = 'Requesting…';
      try {
        const { linkEstablished } = await requestTmrGapDownload(sat, gap, source);
        _getSccPassCheck(sat, { forceRefresh: true }); // reflect the new request as soon as it lands
        // Drops the pass tooltip's own scheduled-procedures cache (see
        // scheduledProcedures.js's invalidateAllScheduledProcedures) so the
        // NEXT hover over that pass — here or in Scheduler.js — shows the
        // request that just landed instead of replaying the pre-request
        // list from cache.
        invalidateAllScheduledProcedures();
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

function _showGapTooltip(e, gap, sat, source) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = { gap, sat, source };
  _ganttTooltip.className = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _renderGapTooltip(gap, sat, source);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
  _getSccPassCheck(sat); // uses cache if fresh; refreshes in the background otherwise
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

// Hard-stops pan/zoom at ±VIEW_HALF_SEC — the shared horizon every row's own
// data is bounded to one way or another (TMR's own fetch range, eclipse/STT's
// precompute window, passes' fetch window — each a bit different, see
// VIEW_HALF_SEC's own comment above). Past it, a row's bars simply stop
// rendering while others may still show something, or vice versa — dragging
// the view out there shows a different "runs out" edge per row instead of
// one consistent boundary. Span itself is never touched, only shifted back
// into range, so this never fights the current zoom level.
function _clampView() {
  if (viewStartSec < -VIEW_HALF_SEC) {
    const span = viewEndSec - viewStartSec;
    viewStartSec = -VIEW_HALF_SEC;
    viewEndSec   = viewStartSec + span;
  } else if (viewEndSec > VIEW_HALF_SEC) {
    const span = viewEndSec - viewStartSec;
    viewEndSec   = VIEW_HALF_SEC;
    viewStartSec = viewEndSec - span;
  }
}

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
  store.setPlaying(true); // see store.js's own comment — satAttitudeReal.js's speed cutoff needs this, not just playbackSpeed
  lastTs = null;
  playBtn.textContent = '⏸';
  playBtn.classList.add('playing');
  lastRaf = requestAnimationFrame(tick);
}

function stopPlay() {
  playing = false;
  store.setPlaying(false);
  playBtn.textContent = '▶';
  playBtn.classList.remove('playing');
  if (lastRaf) cancelAnimationFrame(lastRaf);
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

// Hover crosshair — follows the mouse (no click effect) across whichever row
// is under the cursor and reads out the time there. Purely a hover aid, same
// idea as Scheduler.js's own _updateCrosshair, but positioned in the same
// px-based coordinate system #gantt-cursor already uses (_ganttL + f*trackW)
// rather than that file's %-based overlay — this file already has that exact
// math proven out for #gantt-cursor, so the crosshair just reuses it instead
// of introducing a second, parallel positioning scheme.
function _updateGanttCrosshair(clientX) {
  if (!ganttCrosshair || !ganttEl) return;
  const trackW = ganttEl.offsetWidth - _ganttL - _ganttR;
  if (trackW <= 0) { _hideGanttCrosshair(); return; }
  const rect = ganttEl.getBoundingClientRect();
  const xInTrack = clientX - rect.left - _ganttL;
  if (xInTrack < 0 || xInTrack > trackW) { _hideGanttCrosshair(); return; }
  const f = xInTrack / trackW;
  const t = _viewStartMs() + f * _viewRangeMs();
  ganttCrosshair.style.display = 'block';
  ganttCrosshair.style.left    = `${(_ganttL + xInTrack).toFixed(1)}px`;
  if (ganttCrosshairLabel) ganttCrosshairLabel.textContent = _fmtDT(new Date(t));
}
function _hideGanttCrosshair() {
  if (ganttCrosshair) ganttCrosshair.style.display = 'none';
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
    }
    ganttPasses.appendChild(bar);
  }
}

// Status → color, shared by the gantt bar fill and the tooltip's status
// pill (see _planTooltipHTML) — see planData.js's PlanSummaryStatus for the
// full enum this covers.
const _PLAN_STATUS_COLOR = {
  DRAFT:      '#8a8a9e', // grey
  RELEASED:   '#5ec8ff', // light blue
  SUBMITTED:  '#1e4d8c', // dark blue
  ACTIVATED:  '#ff9500', // orange
  TERMINATED: '#ff4d4d', // red
};
const _PLAN_DEFAULT_COLOR = '#8a8a9e'; // any future/unrecognized status — grey, same as DRAFT
function _planColor(status) {
  return _PLAN_STATUS_COLOR[status] ?? _PLAN_DEFAULT_COLOR;
}

// Render plan bars (MIC Plan distribution — see planData.js) with a hover
// tooltip only, no click-through detail panel (unlike passes, there's no
// separate "plan detail" view to open).
function _renderGanttPlans() {
  if (!ganttSlots) return;
  ganttSlots.innerHTML = '';
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();
  for (const { start, end, plan } of _planWindows) {
    const l  = (start - tMin) / rangeMs * 100;
    const r  = (end   - tMin) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    bar.className         = 'gantt-bar';
    bar.style.left        = `${lc.toFixed(3)}%`;
    bar.style.width       = `${(rc - lc).toFixed(3)}%`;
    bar.style.background  = _planColor(plan.status);
    bar.style.cursor      = 'help';
    bar.addEventListener('mouseenter', e => _showPlanTooltip(e, plan));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    ganttSlots.appendChild(bar);
  }
}
// Same hover-tooltip convention as _showPlanTooltip — reuses the shared
// _ganttTooltip singleton and _fmtDT/_fmtGapDuration formatters already
// defined above for the Pass/Plan rows.
function _eclipseTooltipHTML(win) {
  const hdr   = `<div class="co-tt-header">ECLIPSE <span class="co-pill" style="background:#2244cc22; color:#6a8fff; border:1px solid #2244cc66;">SHADOW</span></div>`;
  const times = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">START</span>${_fmtDT(new Date(win.start))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">END</span>${_fmtDT(new Date(win.end))}</div>`
              + `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${_fmtGapDuration(win.end - win.start)}</div>`;
  return hdr + times;
}

function _showEclipseTooltip(e, win) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows an eclipse window, not a gap
  _ganttTooltip.className     = 'co-tooltip'; // reset — see _showTimetagTooltip's own wider variant
  _ganttTooltip.innerHTML     = _eclipseTooltipHTML(win);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
}

// Render eclipse bars with per-bar hover tooltip — same shape as
// _renderGanttPlans (hoverable, not clickable — there's no eclipse detail
// view to open).
function _renderGanttEclipse() {
  if (!ganttEclipse) return;
  ganttEclipse.style.background = '#e6b800aa'; // bright sun-yellow
  ganttEclipse.innerHTML = '';
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();
  for (const win of _eclipseWindows) {
    const l  = (win.start - tMin) / rangeMs * 100;
    const r  = (win.end   - tMin) / rangeMs * 100;
    const lc = Math.max(0, l);
    const rc = Math.min(100, r);
    if (rc - lc < 0.01) continue;
    const bar = document.createElement('div');
    bar.className        = 'gantt-bar';
    bar.style.left        = `${lc.toFixed(3)}%`;
    bar.style.width       = `${(rc - lc).toFixed(3)}%`;
    bar.style.background  = '#2244cc';
    bar.style.boxShadow   = '0 0 8px #4466ffcc';
    bar.style.cursor      = 'help';
    bar.addEventListener('mouseenter', e => _showEclipseTooltip(e, win));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    ganttEclipse.appendChild(bar);
  }
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

// One TMR row per source (see tmrData.js's TMR_SOURCES) — BUS and PAY are
// independent onboard packet stores with independent gap coverage, so each
// gets its own track/container and is rendered separately.
function _renderGanttTmrRows() {
  _renderGanttTmr(ganttTmr,    'bus');
  _renderGanttTmr(ganttTmrPay, 'pay');
}

function _renderGanttTmr(container, source) {
  if (!container) return;
  container.innerHTML = '';
  container.style.background = '';  // reset
  const sat = store.trackedSat;
  const tmr = sat ? store.satTmr[sat.id]?.[source] : null;
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
    container.appendChild(cov);
  }

  // Dark overlay bars for gap periods — appended directly, never clears the green bar.
  // A gap already requested (a matching PUS-15 downlink scheduled on SCC's
  // next pass — see _getSccPassCheck/findMatchingGapProcedure) renders
  // green/diagonal-dashed, contained to the gap's own bounds (no extension).
  // Once the backfill actually lands, the gap simply stops appearing in
  // gapWindows and the full green coverage bar shows through automatically —
  // nothing extra to draw for that case.
  //
  // Priority when a gap is BOTH requested AND past the buffer limit: red wins
  // — the data being probably-already-gone is the more urgent, irreversible
  // fact, more important to see at a glance than "a request is in flight".
  //
  // A gap whose end lands (essentially) exactly on rangeEnd is still OPEN —
  // nothing has closed it yet, because no pass has happened since it started
  // to actually bring that data down. That's not the same kind of fact as a
  // gap fully bounded between two passes that have BOTH already happened (a
  // confirmed anomaly) — it's handled below the loop instead, folded into
  // the grey "not available yet" treatment rather than a severity color.
  const sccData = sat ? _getSccPassCheck(sat) : null;
  let greyStart = rangeEnd;
  for (const { start, end } of gapWindows) {
    if (end >= rangeEnd - 1000) { greyStart = Math.min(greyStart, start); continue; }
    const isPending = !!findMatchingGapProcedure(sccData?.scheduled, { start, end }, source);
    const urgency   = _gapUrgency({ start, end });

    const l  = (start - tMin) / rangeMs * 100;
    const r  = (end   - tMin) / rangeMs * 100;
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
    bar.addEventListener('mouseenter', e => _showGapTooltip(e, { start, end }, sat, source));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    container.appendChild(bar);
  }

  // Grey "not available yet" bar — covers both real future time (the
  // visible view can extend up to +5 days ahead of "now") AND, per
  // greyStart above, any still-open trailing gap that's happened but
  // couldn't have been downlinked yet either. Neither is a confirmed
  // anomaly the way a fully-bounded historical gap is — without this,
  // both would render with the exact same plain dark background as a
  // genuine .gantt-bar-gap, misleadingly implying lost data.
  const viewEndMs = tMin + rangeMs;
  if (viewEndMs > greyStart) {
    const lFut  = (Math.max(greyStart, tMin) - tMin) / rangeMs * 100;
    const lcFut = Math.max(0, lFut);
    if (100 - lcFut > 0.01) {
      const bar = document.createElement('div');
      bar.className = 'gantt-bar gantt-bar-future';
      bar.style.left  = `${lcFut.toFixed(3)}%`;
      bar.style.width = `${(100 - lcFut).toFixed(3)}%`;
      bar.title = 'Not available yet';
      container.appendChild(bar);
    }
  }
}

// ── Timetag row ──────────────────────────────────────────────────
//
// Ported from Scheduler.js's own Timetag row (same underlying data/grouping
// — see that file's header comment for the full rationale) — one tick per
// PUS(11,4) "insert TC in subschedule" command found in the satellite's most
// recent PAST pass, placed at the target TC's OWN scheduled execution time,
// colored by SSID (OBSW_AR_S11_SUBSCHEDULE_ID), with the last-known
// ENABLED/DISABLED status per SSID coming from the latest live HK_CCSW
// packet. Rendered here via plain createElement (this file's own convention
// — see _renderGanttEclipse/_renderGanttTmr above) rather than Scheduler.js's
// innerHTML-string _barHTML, but the data layer underneath is otherwise the
// same, duplicated rather than shared (same "not exported there either"
// precedent every other row in this file already follows for its Scheduler.js
// counterpart).

// Same 8-hue dark-mode categorical steps as Scheduler.js's own _SSID_COLORS.
const _SSID_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const _SSID_COLOR_FALLBACK = '#778';
function _ssidColor(ssid) {
  const n = Number(ssid);
  return Number.isInteger(n) && n >= 1 && n <= _SSID_COLORS.length ? _SSID_COLORS[n - 1] : _SSID_COLOR_FALLBACK;
}

const HK_CCSW_PACKET   = 'TM_3_25_OBSW_HK_CCSW';
const HK_CCSW_MAX_SSID = 10; // OBSW_AM_S11_STSUB_1..10 — confirmed live, 2026-07-30 sccRo sample

// The satellite's most recent COMPLETED pass — same definition as
// Scheduler.js's own _previousPass, just reading store.satPasses directly
// (this file has no standing _passes() helper of its own to reuse).
function _previousPass(sat) {
  const passes = store.satPasses[sat.id] ?? [];
  const past = passes.filter(p => !p.future);
  return past.length ? past[past.length - 1] : null;
}

// Latest known per-SSID enable state, straight off HK_CCSW. Windowed off
// plain Date.now() (not EPOCH/scrubOffsetSec) — same real-wall-clock
// reasoning this file's own _gapAgeMs/_getSccPassCheck already use for "how
// fresh is this": HK_CCSW's own last-known state doesn't depend on wherever
// the timeline happens to be scrubbed to.
async function _fetchCcswSubscheduleStatus(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;
  const nowMs = Date.now();
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

// Same "name+args+exec-time" grouping key as Scheduler.js's own
// _timetagGroupKey — collapses a command inserted into two SSIDs at the same
// execution time into one entry carrying both SSIDs.
function _timetagGroupKey(targetName, args, dateMs) {
  const argsKey = args.map(a => `${a.name}=${a.value}`).sort().join(',');
  return `${targetName ?? '?'}@${dateMs ?? '?'}::${argsKey}`;
}

// Same shape as Scheduler.js's own _buildTimetagEntries — see that file's
// comment for why only a CONFIRMED ('exec-ok') insert counts.
async function _buildTimetagEntries(sat, pass) {
  const packets = await fetchTcPackets(sat, pass.start.getTime(), pass.end.getTime());
  if (!packets) return null;
  const { targetFor } = matchScheduledTargets(packets);
  const groups = new Map(); // key -> entry
  for (const p of packets) {
    if (!TC_114_NAME_RE.test(p.name)) continue;
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
// Scheduler.js's own _triggerTimetag — triggered on trackedSatId/satPasses
// changes (see initTimePlayer's store.subscribe block) rather than a pass
// selection, since this file has no pass-selection concept of its own.
async function _triggerTimetag() {
  const sat  = store.trackedSat;
  const prev = sat ? _previousPass(sat) : null;
  if (!sat || !prev) {
    _timetagEntries = null; _timetagCcsw = null; _timetagFetchKey = null;
    _renderGanttTimetag();
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
  _renderGanttTimetag();
}

// Same "colored by whichever SSID is currently ENABLED, else lowest SSID
// number" rule as Scheduler.js's own _timetagLineColor.
function _timetagLineColor(ssids) {
  if (!ssids.length) return _SSID_COLOR_FALLBACK;
  const enabled = ssids.find(s => _timetagCcsw?.[s] === 'ENABLED');
  return _ssidColor(enabled ?? ssids.slice().sort((a, b) => a - b)[0]);
}

// Same 3dp-for-non-integers formatting as Scheduler.js's own _fmtArgValue.
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
  const args = entry.args.length
    ? entry.args.map(a => {
        const unit = argUnitLabel(a.unit);
        return `<div class="co-tt-time-row"><span class="co-tt-time-lbl">${escapeHtml(a.name)}</span><span class="co-tt-nowrap">${escapeHtml(_fmtArgValue(a.value))}${unit ? ` ${escapeHtml(unit)}` : ''}</span></div>`;
      }).join('')
    : `<div class="co-tt-note">No arguments</div>`;
  return hdr + date + ssidRows + `<div class="co-tt-sep"></div>` + args;
}

function _showTimetagTooltip(e, entry) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a timetag entry, not a gap
  _ganttTooltip.className   = 'co-tooltip sch-timetag-tooltip'; // wider — long OBSW_* labels wrap otherwise (see .sch-timetag-tooltip)
  _ganttTooltip.innerHTML     = _timetagTooltipHTML(entry);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
}

// SSID checkbox filter (the funnel icon next to the Timetag label) — same
// persistent-viewing-preference reasoning as Scheduler.js's own
// _timetagHiddenSsids: left as-is across a satellite switch, not reset.
let _timetagHiddenSsids = new Set();

function _timetagEntryVisible(entry) {
  return !entry.ssids.length || entry.ssids.some(s => !_timetagHiddenSsids.has(s));
}

// Point events, not spans — same 0.3%-width floor Scheduler.js's own
// _barHTML uses for the identical reason (a short window stays
// visible/hoverable at any zoom), just built via createElement instead of an
// HTML string, matching every other row in this file.
function _renderGanttTimetag() {
  if (!ganttTimetag) return;
  _updateTimetagFilterBtn();
  ganttTimetag.innerHTML = '';
  if (!_timetagEntries?.length) return;
  const tMin    = _viewStartMs();
  const rangeMs = _viewRangeMs();
  _timetagEntries.forEach(entry => {
    if (!_timetagEntryVisible(entry)) return;
    const l = (entry.dateMs - tMin) / rangeMs * 100;
    if (l < -1 || l > 101) return; // well outside the view — nothing to draw
    const lc = Math.max(0, Math.min(100, l));
    const bar = document.createElement('div');
    bar.className        = 'gantt-bar';
    bar.style.left        = `${lc.toFixed(3)}%`;
    bar.style.width       = `0.3%`;
    bar.style.background  = _timetagLineColor(entry.ssids);
    bar.style.cursor      = 'help'; // same hover-only (no click action) cursor the Eclipse row's own bars use
    bar.addEventListener('mouseenter', e => _showTimetagTooltip(e, entry));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    ganttTimetag.appendChild(bar);
  });
}

// Highlights the funnel icon whenever a filter is actually narrowing the row
// — same reasoning as Scheduler.js's own _updateTimetagFilterBtn.
function _updateTimetagFilterBtn() {
  ganttTimetagFilterBtn?.classList.toggle('sch-timetag-filter-btn-active', _timetagHiddenSsids.size > 0);
}

// Every SSID actually present across the current entries — same as
// Scheduler.js's own _timetagKnownSsids.
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
    if (el.style.display !== 'none' && !el.contains(e.target) && !e.target.closest('#gantt-timetag-filter-btn')) {
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
      _renderGanttTimetag();
    });
  });
  menu.querySelector('.sch-ssid-filter-reset')?.addEventListener('click', () => {
    _timetagHiddenSsids.clear();
    _renderTimetagFilterMenu();
    _renderGanttTimetag();
  });
}

// Click-to-open on the funnel icon, click-outside/Escape-to-close — same
// shape as Scheduler.js's own _wireTimetagFilterBtn.
function _wireTimetagFilterBtn() {
  if (!ganttTimetagFilterBtn) return;
  ganttTimetagFilterBtn.addEventListener('click', e => {
    e.stopPropagation();
    const menu = _ensureTimetagFilterMenu();
    const wasOpen = menu.style.display !== 'none';
    if (wasOpen) { menu.style.display = 'none'; return; }
    _renderTimetagFilterMenu();
    menu.style.display = 'block';
    const rect = ganttTimetagFilterBtn.getBoundingClientRect();
    const w = menu.offsetWidth || 160;
    let x = rect.left;
    let y = rect.bottom + 4;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (y + menu.offsetHeight > window.innerHeight - 8) y = rect.top - menu.offsetHeight - 4;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top  = Math.max(8, y) + 'px';
  });
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

// Fetch plans for the tracked satellite's gantt fixed max window (EPOCH ±
// VIEW_HALF_SEC — same horizon every other row is bounded to, see
// VIEW_HALF_SEC's own comment) then render. Per-satellite, same scoping as
// TMR/attitude — see planData.js's own header comment for why (each
// satellite's own MIC box hosts its own Plan distribution instance,
// authenticated with that satellite's own MIC token).
function _updateGanttPlans() {
  const sat = store.trackedSat;
  if (!sat) return;
  const rangeStart = EPOCH.getTime() - VIEW_HALF_SEC * 1000;
  const rangeEnd   = EPOCH.getTime() + VIEW_HALF_SEC * 1000;
  schedulePlanFetch(sat, rangeStart, rangeEnd, plans => store.setPlans(sat.id, plans));
}

// Compute eclipse + STT-blinding windows for a fixed ±5-day range then render.
// Both share the same propagate()/sunDirectionECI() per-step results — STT
// blinding just adds a couple of dot products + one acos + one asin on top
// of samples already being computed for the eclipse line, so it's a small
// fraction of extra work, not extra propagate() calls.
// ±5-day span ÷ 1-min step ≈ 14400 SGP4 propagations — run as one flat loop
// this was a single uninterrupted main-thread stall (visible as a hitch)
// every time the tracked satellite changed or "Now" was pressed. This
// generator does the exact same work but yields after each sample, so a
// runner (_runEclipseChunk) can process it in ~8ms time-sliced bursts across
// multiple ticks instead of one blocking burst — same total work, but no
// single frame gets blocked long enough to be noticeable.
// Step was 5 min; tightened to 1 min so eclipse bar edges (and the hover
// tooltip's start/end times) are accurate to the minute instead of only to
// the nearest 5-minute bucket.
function* _eclipseSttWork(sat) {
  const tMin = EPOCH.getTime() - ECLIPSE_HALF_SEC * 1000;
  const tMax = EPOCH.getTime() + ECLIPSE_HALF_SEC * 1000;
  const STEP = 60 * 1000;
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

      const blindedFlags = cones.map(cfg => _isConeBlinded(r.eciPos, sunDir, cfg, sunExclDeg, earthExclDeg, sat.noradId, d));
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
  _clampView();
  scrub.min = viewStartSec;
  scrub.max = viewEndSec;
  _renderGanttTmrRows();
  _renderGanttPasses();
  _renderGanttPlans();
  _renderGanttTimetag();
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

  _wireTimetagFilterBtn();

  playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

  // NOW — jumps the cursor to the current UTC time and re-centers the view on
  // it, but leaves the current zoom (view span) exactly as the user left it.
  nowBtn.addEventListener('click', () => {
    EPOCH.setTime(Date.now());
    _eclipseJobSat = null;
    scrubOffsetSec = 0;
    const span = _viewSpan(); // preserve current zoom
    viewStartSec = -span / 2;
    viewEndSec   =  span / 2;
    applyTime();
    _applyView();
    _updateGanttEclipse();
    _updateGanttPlans(); // EPOCH moved — the fixed max window it's fetched for moved with it
    if (!playing) startPlay();
  });

  // HOME — NOW's old behavior: jump to the current UTC time AND reset the
  // zoom back to the default ±VIEW_HALF_SEC window.
  homeBtn.addEventListener('click', () => {
    EPOCH.setTime(Date.now());
    _eclipseJobSat = null;
    scrubOffsetSec = 0;
    viewStartSec = -VIEW_HALF_SEC;
    viewEndSec   =  VIEW_HALF_SEC;
    applyTime();
    _applyView();
    _updateGanttEclipse();
    _updateGanttPlans(); // EPOCH moved — the fixed max window it's fetched for moved with it
    if (!playing) startPlay();
  });

  // RECENTER — pure view operation: re-centers the (unchanged) zoom span on
  // wherever the cursor currently sits, without touching time or playback.
  // Undoes drifting the view away from the cursor via pan/wheel-zoom.
  recenterBtn.addEventListener('click', () => {
    const span = _viewSpan();
    viewStartSec = scrubOffsetSec - span / 2;
    viewEndSec   = scrubOffsetSec + span / 2;
    _applyView();
  });

  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); store.setPlaybackSpeed(speed); });

  scrub.addEventListener('input', () => {
    stopPlay();
    scrubOffsetSec = Number(scrub.value);
    applyTime();
  });

  // Manual date jump — parse DD-MM-YYYY HH:MM:SS on Enter or blur
  const commitDateInput = () => {
    const parsed = parseDisplay(dateInput.value);
    if (!parsed) { dateInput.value = formatDisplay(new Date(EPOCH.getTime() + scrubOffsetSec * 1000)); return; }
    stopPlay();
    scrubOffsetSec = (parsed.getTime() - EPOCH.getTime()) / 1000;
    scrubOffsetSec = Math.max(-VIEW_HALF_SEC, Math.min(VIEW_HALF_SEC, scrubOffsetSec));
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
      _triggerTimetag(); // "previous pass" (what the row's built from) can change with either
    }
    if (key === 'trackedSatId') {
      if (ganttTmr)    ganttTmr.innerHTML    = '';
      if (ganttTmrPay) ganttTmrPay.innerHTML = '';
      if (ganttStt)  ganttStt.innerHTML  = '';
      if (ganttStt1) ganttStt1.innerHTML = '';
      if (ganttStt2) ganttStt2.innerHTML = '';
      if (ganttSlots) ganttSlots.innerHTML = '';
      if (ganttTimetag) ganttTimetag.innerHTML = '';
      _planWindows = [];
      _eclipseJobSat = null;
      _refreshSttRowVisibility();
      _updateGanttEclipse();
      _updateGanttPlans(); // fetch for the newly-tracked satellite (own MIC token/host — see planData.js)
      _setGanttCollapsed(!store.trackedSat);
      _syncGanttToggleEnabled();
      // ResizeObserver handles _syncLayout when gantt visibility/height changes
    }
    if (key === 'tmrData') {
      _renderGanttTmrRows();
    }
    if (key === 'plans') {
      const sat = store.trackedSat;
      _planWindows = sat ? (store.satPlans[sat.id] ?? []).map(plan => ({ start: plan.start, end: plan.end, plan })) : [];
      _renderGanttPlans();
    }
    // Real attitude (MIC) — only ever actively fetched for the single
    // currently-tracked satellite, same scoping SatInfo.js/sttPovWidget.js
    // already use. See satAttitudeReal.js's scheduleAttitudeFetch for the
    // debounce/ceiling mechanics that keep this cheap under both scrubbing
    // and continuous playback.
    if (key === 'currentTime' || key === 'trackedSatId') {
      const sat = store.trackedSat;
      if (sat) scheduleAttitudeFetch(sat.noradId, store.currentTime.getTime());
    }
  });
  _updateGanttPasses();
  _updateGanttEclipse();
  if (store.trackedSat) scheduleAttitudeFetch(store.trackedSat.noradId, store.currentTime.getTime()); // also run on init

  // Plans (MIC Plan distribution — see planData.js): per-satellite, same
  // scoping as TMR/attitude (own guard against no-tracked-satellite, see
  // _updateGanttPlans). Fetched once on init, again whenever the tracked
  // satellite or EPOCH changes (trackedSatId subscriber above / Now/Home
  // click handlers), and periodically on this timer to pick up status
  // transitions (DRAFT → RELEASED → ... — see planData.js's
  // PlanSummaryStatus) that happen without any local trigger. Same 30s scale
  // as this file's own SCC_CHECK_TTL_MS for a similar "recheck occasionally,
  // the API is cheap" case.
  _updateGanttPlans();
  setInterval(_updateGanttPlans, 30_000);

  // TMR fetch helper — debounced so rapid satPasses updates don't abort each other.
  // Fetches every source (BUS/PAY — see tmrData.js's TMR_SOURCES) independently,
  // each landing in its own gantt row via store.setTmrWindows(satId, source, ...).
  const _triggerTmr = () => {
    const sat = store.trackedSat;
    if (!sat) return;
    const past = (store.satPasses[sat.id] ?? []).filter(p => !p.future);
    if (!past.length) return;
    for (const source of Object.keys(TMR_SOURCES)) {
      scheduleTmrFetch(sat, past, source, windows => store.setTmrWindows(sat.id, source, windows));
    }
  };
  _triggerTmr();      // also run on init in case passes are already loaded
  _triggerTimetag();  // same — the "previous pass" it needs may already be loaded

  // Wheel zoom on scrubber or gantt
  scrub.addEventListener('wheel',   _onWheel, { passive: false });
  ganttEl?.addEventListener('wheel', _onWheel, { passive: false });

  // Drag-to-pan on gantt (skip the collapse toggle buttons — preventDefault +
  // setPointerCapture below hijacks click delivery for anything inside the
  // gantt that isn't exempted here, so any future clickable control added
  // inside #timeline-gantt needs to be added to this check too, same as the
  // STT POV button was. The STT POV panel itself (sttPovWidget.js) is
  // exempted wholesale via .closest() rather than listing its close button
  // individually — it's appended as a child of #timeline-gantt (so its own
  // clicks bubble to this same handler) but is built lazily, well after this
  // listener is wired, so there's no element reference to compare against
  // the way the three static buttons below have.
  ganttEl?.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // sttPovOpenBtn specifically needs .contains(), not === — it has an SVG
    // icon inside it (path/circle children), so a real click's e.target is
    // almost always one of those descendants, never the <button> itself.
    // The other two are plain text-content buttons, where a text node click
    // still reports the button element as e.target, so === already worked —
    // left as-is rather than changed speculatively. #gsi-attitude-toggle
    // (SatInfo.js) lives inside #gantt-sat-info, itself positioned inside
    // #timeline-gantt (same reasoning as the STT POV panel below) — exempted
    // by selector rather than an element reference for the same reason.
    // Timetag row's own funnel icon (opens the SSID filter menu) needs the
    // same exemption Scheduler.js's own pan-pointerdown handler already
    // gives its .sch-timetag-filter-btn, for the identical reason.
    if (e.target === ganttToggleBtn || e.target === ganttSttCollapseBtn || sttPovOpenBtn?.contains(e.target)
      || e.target.closest?.('.stt-pov-panel') || e.target.closest?.('#gsi-attitude-toggle')
      || e.target.closest?.('.sch-timetag-filter-btn')) return;
    e.preventDefault();
    ganttEl.setPointerCapture(e.pointerId);
    ganttEl.style.cursor = 'grabbing';
    _beginPan(e.clientX, ganttEl.offsetWidth - _ganttL - _ganttR);
  });
  ganttEl?.addEventListener('pointermove', e => {
    if (_pan) _movePan(e.clientX);
    _updateGanttCrosshair(e.clientX);
  });
  ganttEl?.addEventListener('pointerup',   () => { _endPan(); ganttEl.style.cursor = ''; });
  ganttEl?.addEventListener('pointercancel', () => { _endPan(); ganttEl.style.cursor = ''; });
  ganttEl?.addEventListener('pointerleave', _hideGanttCrosshair);

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


  // Gantt collapse toggle — disabled (see _syncGanttToggleEnabled) when
  // nothing is tracked, but guard here too rather than trust the DOM
  // `disabled` attribute alone.
  ganttToggleBtn?.addEventListener('click', () => {
    if (!store.trackedSat) return;
    _setGanttCollapsed(!document.body.classList.contains('gantt-collapsed'));
  });

  // Auto-collapsed with nothing tracked (there's nothing to show yet), auto-
  // opens the moment a satellite is selected — overrides whatever the manual
  // toggle above last left it at, since the trigger here is "is there
  // anything to look at", not a user preference to remember.
  _setGanttCollapsed(!store.trackedSat);
  _syncGanttToggleEnabled();

  // ResizeObserver fires whenever the gantt's actual rendered height changes
  // (initial layout, collapse/expand, content updates) — no rAF race condition
  if (ganttEl) new ResizeObserver(_syncLayout).observe(ganttEl);

  // Keep window resize for gantt track alignment (scrubber position-dependent)
  window.addEventListener('resize', () => { _alignGantt(); _syncLayout(); });

  speed = Number(speedSel.value);
  store.setPlaybackSpeed(speed);
  applyTime();
  startPlay();
}
