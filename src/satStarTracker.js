// Per-satellite star tracker cone settings (Sun/Earth exclusion half-angles,
// show/hide) — localStorage-backed, same pattern as satSubsystems.js. Reads
// are cached in memory so SatEntity.js's Cesium CallbackProperty rendering
// (which reads these every single render frame, for every cone) doesn't hit
// localStorage.getItem — a synchronous main-thread call — 60 times a second
// per satellite. Setters invalidate the cache immediately, so Settings-modal
// edits still apply on the very next render tick, same as before.
export const SUN_EXCL_DEFAULT_DEG   = 35;
export const EARTH_EXCL_DEFAULT_DEG = 22;
// Cosmetic FOV cone half-angle for the 3D globe rendering (SatEntity.js) —
// NOT a keep-out/exclusion angle (those are the two above, checked against
// sunAngleDeg/earthAngleDeg in TimePlayer.js's _isConeBlinded). Shared here
// so sttPov.js's POV widget draws the identical FOV reference ring the 3D
// cone's own visual size already represents, instead of a second, possibly-
// drifting copy of "15".
export const ST_FOV_HALF_ANGLE_DEG = 15;

function _numOr(raw, fallback) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

const _sunExclCache   = new Map(); // noradId → degrees
const _earthExclCache = new Map();
const _visCache        = new Map(); // noradId → boolean

export function satSunExclDeg(noradId) {
  if (_sunExclCache.has(noradId)) return _sunExclCache.get(noradId);
  const v = _numOr(localStorage.getItem(`sat-sun-excl-${noradId}`), SUN_EXCL_DEFAULT_DEG);
  _sunExclCache.set(noradId, v);
  return v;
}
export function setSatSunExclDeg(noradId, deg) {
  if (deg === '' || deg == null || !Number.isFinite(+deg)) localStorage.removeItem(`sat-sun-excl-${noradId}`);
  else localStorage.setItem(`sat-sun-excl-${noradId}`, String(+deg));
  _sunExclCache.delete(noradId);
}

export function satEarthExclDeg(noradId) {
  if (_earthExclCache.has(noradId)) return _earthExclCache.get(noradId);
  const v = _numOr(localStorage.getItem(`sat-earth-excl-${noradId}`), EARTH_EXCL_DEFAULT_DEG);
  _earthExclCache.set(noradId, v);
  return v;
}
export function setSatEarthExclDeg(noradId, deg) {
  if (deg === '' || deg == null || !Number.isFinite(+deg)) localStorage.removeItem(`sat-earth-excl-${noradId}`);
  else localStorage.setItem(`sat-earth-excl-${noradId}`, String(+deg));
  _earthExclCache.delete(noradId);
}

// Whole star-tracker visualization (FOV cone + both exclusion cones) as one group.
export function satStarTrackerConesVisible(noradId) {
  if (_visCache.has(noradId)) return _visCache.get(noradId);
  const v = localStorage.getItem(`sat-startracker-vis-${noradId}`) !== '0'; // default: visible
  _visCache.set(noradId, v);
  return v;
}
export function setSatStarTrackerConesVisible(noradId, visible) {
  localStorage.setItem(`sat-startracker-vis-${noradId}`, visible ? '1' : '0');
  _visCache.set(noradId, visible);
}

// Converts a QRot_RAL_Rs-style attitude quaternion (scalar-first: w,x,y,z —
// the sensor Rs frame's orientation relative to the satellite's body/RAL
// frame) into the resulting body-frame direction of the sensor's own local
// +Z (boresight) axis — i.e. the 3rd column of the equivalent rotation
// matrix. That body-frame vector is exactly what MODEL_STAR_TRACKERS' 'body'
// mode's `dir` expects (same frame as the X/Y/Z reference arrows in
// SatEntity.js's _computeOrientation).
export function bodyDirFromQuat(w, x, y, z) {
  return {
    x: 2 * (x * z + w * y),
    y: 2 * (y * z - w * x),
    z: 1 - 2 * (x * x + y * y),
  };
}

// Per-model star tracker mounting — single source of truth shared by
// SatEntity.js (renders the FOV cones on the globe) and TimePlayer.js
// (precomputes blinding-window timelines for the gantt). Two boresight
// modes:
//   'anti-sun' — boresight = -sun direction, recomputed every frame directly
//     from the sun vector (the original/only behavior, before any model had
//     real attitude data at all — no model currently uses this mode, but it
//     stays supported in case a future design genuinely has a fixed,
//     sun-relative rather than body-relative mount). Robust to the
//     orientation's degenerate case (sun ≈ zenith), where a body-frame
//     vector rotated by the attitude quaternion would jump discontinuously
//     — this mode never depends on attitude at all.
//   'body' — boresight is a fixed body-frame unit vector {x,y,z} (same frame
//     as the X/Y/Z reference arrows), rotated into ECEF/ECI by the
//     satellite's current attitude (real when available, else Default Sun
//     Pointing) — the physically-accurate mode, used by every model.
// `offsetKmPerScaleUnit` (km per unit of store.satScale, body frame, rotated
// the same way as `dir`) shifts the cone's start point sideways/along the
// body before the boresight bias push-out — for trackers not centered on the
// satellite's origin (e.g. two units side by side). Scaled by satScale (not
// a flat km value) because the rendered model grows/shrinks with the Scale
// slider, so a mounting offset found by eye at one scale has to track that
// to stay visually attached to the model at any other scale.
// `biasKmPerScaleUnit` is the per-model apex push-out tuning (see
// SatEntity.js's _updateStarTrackerCones) — found via the debug slider for
// 12U (140km at scale=500); a different model's mesh is a different
// scale/shape and needs its own value, not 12U's borrowed one.
export const MODEL_STAR_TRACKERS = {
  // 'body', not 'anti-sun': the STT's boresight should be wherever it's
  // physically mounted, rotated by whatever the satellite's actual current
  // attitude is (real when available, else Default Sun Pointing) — not
  // hardwired to always exactly equal -sun regardless of real attitude data
  // (that was the ORIGINAL simplification, back when no real attitude
  // existed at all — see 'anti-sun' mode's own doc comment above). dir =
  // {0,0,1} (the "Z arrow" direction) is chosen specifically so this
  // reproduces today's exact behavior under Default Sun Pointing (Z arrow
  // = -col0 = -sun under that assumption, by construction — see
  // _computeOrientation's fallback) while correctly diverging from it once
  // real attitude shows the satellite isn't perfectly sun-pointing.
  '12U': [
    { mode: 'body', dir: { x: 0, y: 0, z: 1 }, offsetKmPerScaleUnit: { x: 0, y: 0, z: 0 }, biasKmPerScaleUnit: 140 / 500 },
  ],
  // Two physical units, oriented per QRot_RAL_Rs STT1/STT2:
  //   STT1: [0.0, 0.70710678, -0.5, -0.5]
  //   STT2: [0.70710678, 0.0, -0.5, 0.5]
  // Origins found by eye with the debug X/Y/Z origin sliders (since removed
  // — see SatEntity.js's _updateStarTrackerCones), at scale=500:
  //   STT1: (-137, 70, 22) km    STT2: (-137, -70, 40) km
  'FF': [
    { mode: 'body', dir: bodyDirFromQuat(0.0, 0.70710678, -0.5, -0.5),
      offsetKmPerScaleUnit: { x: -137 / 500, y: 70 / 500, z: 22 / 500 }, biasKmPerScaleUnit: 0 },
    { mode: 'body', dir: bodyDirFromQuat(0.70710678, 0.0, -0.5, 0.5),
      offsetKmPerScaleUnit: { x: -137 / 500, y: -70 / 500, z: 40 / 500 }, biasKmPerScaleUnit: 0 },
  ],
};
