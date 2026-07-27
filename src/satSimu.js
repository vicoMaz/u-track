// Per-satellite "simulated" tag — localStorage-backed, same pattern as
// satStarTracker.js/satSubsystems.js. A satellite tagged simulated has all
// the normal subsystem interfaces but isn't a real, currently-orbiting
// object — kept out of the Visualizer (GlobeView.js/MapView.js), where
// "where is it right now" only means something for something actually
// tracking real time, but still shown in Fleet (clearly labeled, see
// ChadOps.js) since ops still cares about its telemetry/procedures.
//
// A manual tag set at add-time, not auto-detected from FDS reachability —
// that's already probed asynchronously and can flap online/offline, which
// would make "which tab shows this satellite" flicker; a flag set once is
// simpler and predictable. Known limitation, accepted rather than solved
// here: a simulated satellite may run in a different epoch than real
// wall-clock time, so time-windowed fetches elsewhere (pass history, TC
// lookups, telemetry — all anchored to real Date.now()) will likely just
// show no data for it.
const _cache = new Map(); // noradId → boolean

export function satIsSimulated(noradId) {
  if (_cache.has(noradId)) return _cache.get(noradId);
  const v = localStorage.getItem(`sat-simu-${noradId}`) === '1';
  _cache.set(noradId, v);
  return v;
}

export function setSatIsSimulated(noradId, simulated) {
  if (simulated) localStorage.setItem(`sat-simu-${noradId}`, '1');
  else localStorage.removeItem(`sat-simu-${noradId}`);
  _cache.set(noradId, simulated);
}
