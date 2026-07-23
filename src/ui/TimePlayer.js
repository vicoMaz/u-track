import { store }                        from '../store.js';
import { propagate }                    from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { scheduleTmrFetch, TMR_SOURCES } from '../tmrData.js';
import { requestTmrGapDownload, fetchNextPassProcedures, findMatchingGapProcedure } from '../tmrGapDownload.js';
import { satSunExclDeg, satEarthExclDeg, MODEL_STAR_TRACKERS } from '../satStarTracker.js';
import { showActionToast }              from './actionToast.js';
import { passSimpleTooltipContent, hydratePassGeometry } from './passTooltip.js';
import { openPassDetail }               from './PassDetailPanel.js';


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
const ganttRuler    = document.getElementById('gantt-ruler');

const ganttToggleBtn = document.getElementById('gantt-toggle');
const trackingViewEl = document.getElementById('tracking-view');

function _setGanttCollapsed(collapsed) {
  document.body.classList.toggle('gantt-collapsed', collapsed);
  if (ganttToggleBtn) ganttToggleBtn.textContent = collapsed ? '▼' : '▲';
  // ResizeObserver handles the layout sync after the height change
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

// Standard quaternion SLERP, shortest path, linear-interpolate-and-normalize
// fallback when the two orientations are nearly identical (avoids a sin(θ)≈0
// division). Same algorithm as Cesium.Quaternion.slerp, in plain JS.
function _slerpQuat(a, b, t) {
  let { x: bx, y: by, z: bz, w: bw } = b;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    const x = a.x + t * (bx - a.x), y = a.y + t * (by - a.y), z = a.z + t * (bz - a.z), w = a.w + t * (bw - a.w);
    const len = Math.sqrt(x * x + y * y + z * z + w * w);
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta  = theta0 * t;
  const sin0   = Math.sin(theta0);
  const s0 = Math.cos(theta) - dot * Math.sin(theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return { x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw };
}

// Binary-searches `entries` (sorted by .t, ms) for tMs and SLERPs the
// bracketing pair — same technique as SatEntity.js's _attitudeFromTable.
// Null if tMs falls outside the table's span (caller falls back to Default
// Sun Pointing, same as SatEntity.js does for the globe).
function _sampleAttitudeTable(entries, tMs) {
  const first = entries[0], last = entries[entries.length - 1];
  if (tMs < first.t || tMs > last.t) return null;
  let lo = 0, hi = entries.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= tMs) lo = mid; else hi = mid;
  }
  const a = entries[lo], b = entries[hi];
  const frac = b.t > a.t ? (tMs - a.t) / (b.t - a.t) : 0;
  return _slerpQuat(a.q, b.q, frac);
}

// The satellite's (xECI, yECI, zECI) body-axis basis at `date` — real posted
// attitude (store.attitude, SLERPed) when the sim time falls inside its
// table span, else the same Default Sun Pointing assumption SatEntity.js's
// own _computeOrientation fallback uses (X=sun, Y=zenith projected
// perpendicular to sun via Gram-Schmidt, Z completes the frame). Mirrors
// SatEntity.js's _attitudeFromTable/_computeOrientation exactly, just in ECI
// instead of ECEF — skips its gmst rotation entirely, since angle-between/
// magnitude (all _isConeBlinded/computeSttGeometry actually need) are
// rotation-invariant, so this gives identical results without needing gmst
// here at all. Null if degenerate (no real attitude AND sun≈zenith).
function _attitudeBasisEci(noradId, date, eciPos, sunDir) {
  const att = store.attitude[noradId];
  if (att?.entries?.length) {
    const q = _sampleAttitudeTable(att.entries, date.getTime());
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
// at all, real or assumed — 12U's own definition). 'body' cones need the
// actual attitude basis (real when available, else Default Sun Pointing).
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
  const earthRadiusDeg = Math.asin(Math.max(-1, Math.min(1, R_EARTH_KM / rMag))) * 180 / Math.PI;
  return sunAngleDeg < sunExclDeg || earthAngleDeg < earthRadiusDeg + earthExclDeg;
}

// Projects unit vector `v` into the local (up, right) frame around
// `boresight` as {az, dist} degrees — dist is the angular separation from
// boresight (the same value _isConeBlinded already computes for sun/earth),
// az is rotation around it measured from `up` toward `right`. Degenerate at
// dist≈180° (v opposite boresight, e.g. 12U's Sun by construction — see
// computeSttGeometry's own comment) — az is meaningless there, but that case
// renders off the edge of any reasonable POV circle anyway, so it doesn't matter.
// Near dist≈0° (v≈boresight) or dist≈180° (v≈-boresight — always EXACTLY
// 180° for 12U's Sun, by construction, see computeSttGeometry's own
// comment), both dot(v,up) and dot(v,right) collapse toward zero together,
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
// reference. 12U's anti-sun boresight has no roll of its own to borrow (by
// construction, its boresight = -sunDir exactly, so its Sun-to-boresight
// angle is always precisely 180° — Sun exclusion can never actually trigger
// for that model, only Earth crossing into view does) — this gives every
// model a consistent, non-arbitrary orientation to render against instead of
// an undefined one. Returns null if the satellite can't currently be
// propagated (e.g. decayed).
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
  const earthRadiusDeg = Math.asin(Math.max(-1, Math.min(1, R_EARTH_KM / rMag))) * 180 / Math.PI;
  // Kept separate (not just their OR) so sttPov.js can highlight whichever
  // specific threshold ring was actually crossed instead of a generic
  // "something is blinded" indicator — either can be true independently
  // (fused STT blinding is only "every cone blinded", but a single cone can
  // be blinded by Sun, Earth, or both at once).
  const sunBlinded   = sunAngleDeg < sunExclDeg;
  const earthBlinded = earthAngleDeg < earthRadiusDeg + earthExclDeg;
  const blinded = sunBlinded || earthBlinded;

  const orbitNormal = _normalize(_cross(eciPos, eciVel));
  const up = _gramSchmidtUp(orbitNormal, boresight)
    ?? _gramSchmidtUp({ x: 0, y: 0, z: 1 }, boresight)
    ?? { x: 1, y: 0, z: 0 };
  const right = _cross(boresight, up);

  return {
    blinded, sunBlinded, earthBlinded, sunAngleDeg, earthAngleDeg, earthRadiusDeg, sunExclDeg, earthExclDeg,
    sun:   _projectAroundBoresight(sunDir, boresight, up, right),
    earth: _projectAroundBoresight(nadir,  boresight, up, right),
  };
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
// plot, Eb/N0 chart, procedure history/report) opens in PassDetailPanel.js
// on click instead (see _renderGanttPasses).
function _showPassTooltip(e, pass) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = null; // this tooltip now shows a pass, not a gap
  _ganttTooltip.innerHTML     = passSimpleTooltipContent(pass, store.trackedSat);
  _ganttTooltip.style.display = 'block';
  _posTooltipAt(_ttAnchorX, _ttAnchorY);
  hydratePassGeometry(_ganttTooltip, e, pass, store.trackedSat);
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
        _renderGapTooltip(_openGapTooltip.gap, _openGapTooltip.sat);
        _posTooltipAt(_ttAnchorX, _ttAnchorY);
      }
    });
  }
  return cached?.data ?? null;
}

function _renderGapTooltip(gap, sat) {
  const data  = _sccPassCache.get(sat.id)?.data ?? null;
  const match = findMatchingGapProcedure(data?.scheduled, gap);
  _ganttTooltip.innerHTML = _gapTooltipHTML(gap, match, data?.pass);
  const btn = _ganttTooltip.querySelector('.co-tt-gap-btn');
  if (btn && !btn.disabled) {
    btn.addEventListener('click', async () => {
      btn.disabled    = true;
      btn.textContent = 'Requesting…';
      try {
        const { linkEstablished } = await requestTmrGapDownload(sat, gap);
        _getSccPassCheck(sat, { forceRefresh: true }); // reflect the new request as soon as it lands
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

function _showGapTooltip(e, gap, sat) {
  _ttAnchorX = e.clientX;
  _ttAnchorY = e.clientY;
  clearTimeout(_ttHideTimer);
  _openGapTooltip = { gap, sat };
  _renderGapTooltip(gap, sat);
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
      bar.style.cursor = 'pointer';
      bar.addEventListener('click', () => {
        _ganttTooltip.style.display = 'none';
        openPassDetail(pass, store.trackedSat, store.groundStations);
      });
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
  const sccData = sat ? _getSccPassCheck(sat) : null;
  for (const { start, end } of gapWindows) {
    const isPending = !!findMatchingGapProcedure(sccData?.scheduled, { start, end });
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
    bar.addEventListener('mouseenter', e => _showGapTooltip(e, { start, end }, sat));
    bar.addEventListener('mouseleave', _hidePassTooltipSoon);
    container.appendChild(bar);
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

  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); });

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
    }
    if (key === 'trackedSatId') {
      if (ganttTmr)    ganttTmr.innerHTML    = '';
      if (ganttTmrPay) ganttTmrPay.innerHTML = '';
      if (ganttStt)  ganttStt.innerHTML  = '';
      if (ganttStt1) ganttStt1.innerHTML = '';
      if (ganttStt2) ganttStt2.innerHTML = '';
      _eclipseJobSat = null;
      _refreshSttRowVisibility();
      _updateGanttEclipse();
      _setGanttCollapsed(!store.trackedSat);
      // ResizeObserver handles _syncLayout when gantt visibility/height changes
    }
    if (key === 'tmrData') {
      _renderGanttTmrRows();
    }
  });
  _updateGanttPasses();
  _updateGanttEclipse();

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
  _triggerTmr(); // also run on init in case passes are already loaded

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
    // left as-is rather than changed speculatively.
    if (e.target === ganttToggleBtn || e.target === ganttSttCollapseBtn || sttPovOpenBtn?.contains(e.target)
      || e.target.closest?.('.stt-pov-panel')) return;
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
    _setGanttCollapsed(!document.body.classList.contains('gantt-collapsed'));
  });

  // Auto-collapsed with nothing tracked (there's nothing to show yet), auto-
  // opens the moment a satellite is selected — overrides whatever the manual
  // toggle above last left it at, since the trigger here is "is there
  // anything to look at", not a user preference to remember.
  _setGanttCollapsed(!store.trackedSat);

  // ResizeObserver fires whenever the gantt's actual rendered height changes
  // (initial layout, collapse/expand, content updates) — no rAF race condition
  if (ganttEl) new ResizeObserver(_syncLayout).observe(ganttEl);

  // Keep window resize for gantt track alignment (scrubber position-dependent)
  window.addEventListener('resize', () => { _alignGantt(); _syncLayout(); });

  speed = Number(speedSel.value);
  applyTime();
  startPlay();
}
