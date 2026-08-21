// Which basemap the Visualizer draws, picked from the map dropdown in the
// Visualizer's subtab bar. Shared by the 3D globe and the 2D planisphere so the
// two subtabs always agree.
//
// Its own module — not a function on GlobeView — because MapView needs it too,
// and importing GlobeView from MapView would drag Cesium into the planisphere's
// chunk: GlobeView and SatEntity evaluate `Cesium.*` at MODULE scope, so that
// import would throw for anyone opening the 2D subtab without having loaded
// Cesium, and it would undo the code splitting that keeps the globe out of the
// initial bundle (see main.js's ensureGlobe).
//
// 'offline' is deliberately listed but not implemented: the dropdown shows it
// disabled as a placeholder for a future local tile pyramid. Anything asking for
// it falls back to 'base' rather than rendering nothing.
export const MAP_STYLES = ['base', 'satellite', 'offline'];

const KEY = 'map-style';

export function mapStyle() {
  const v = localStorage.getItem(KEY);
  return v === 'satellite' ? v : 'base';
}

const _listeners = [];
export function onMapStyleChange(fn) { _listeners.push(fn); }

// Returns false and changes nothing for a style that isn't implemented — today
// that means 'offline'. Rejecting rather than folding it to 'base' is what makes
// the disabled option genuinely inert: folding meant that selecting Offline while
// on Satellite silently dropped you back to Base, i.e. it *did* something.
// The caller uses the return value to put the <select> back where it was.
export function setMapStyle(style) {
  if (style !== 'base' && style !== 'satellite') return false;
  if (style === mapStyle()) return true;
  localStorage.setItem(KEY, style);
  for (const fn of _listeners) {
    // One view failing to re-apply must not stop the other from doing so.
    try { fn(style); } catch (e) { console.warn('[mapStyle] listener failed:', e); }
  }
  return true;
}
