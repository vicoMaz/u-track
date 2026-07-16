// Per-satellite star tracker cone settings (Sun/Earth exclusion half-angles,
// show/hide) — localStorage-backed and read fresh on every call, same pattern
// as satSubsystems.js. That means SatEntity.js's Cesium CallbackProperty
// rendering picks up Settings-modal edits live, on the very next render tick,
// with no entity rebuild required.
export const SUN_EXCL_DEFAULT_DEG   = 35;
export const EARTH_EXCL_DEFAULT_DEG = 22;

function _numOr(raw, fallback) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function satSunExclDeg(noradId) {
  return _numOr(localStorage.getItem(`sat-sun-excl-${noradId}`), SUN_EXCL_DEFAULT_DEG);
}
export function setSatSunExclDeg(noradId, deg) {
  if (deg === '' || deg == null || !Number.isFinite(+deg)) localStorage.removeItem(`sat-sun-excl-${noradId}`);
  else localStorage.setItem(`sat-sun-excl-${noradId}`, String(+deg));
}

export function satEarthExclDeg(noradId) {
  return _numOr(localStorage.getItem(`sat-earth-excl-${noradId}`), EARTH_EXCL_DEFAULT_DEG);
}
export function setSatEarthExclDeg(noradId, deg) {
  if (deg === '' || deg == null || !Number.isFinite(+deg)) localStorage.removeItem(`sat-earth-excl-${noradId}`);
  else localStorage.setItem(`sat-earth-excl-${noradId}`, String(+deg));
}

// Whole star-tracker visualization (FOV cone + both exclusion cones) as one group.
export function satStarTrackerConesVisible(noradId) {
  return localStorage.getItem(`sat-startracker-vis-${noradId}`) !== '0'; // default: visible
}
export function setSatStarTrackerConesVisible(noradId, visible) {
  localStorage.setItem(`sat-startracker-vis-${noradId}`, visible ? '1' : '0');
}
