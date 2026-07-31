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
// simpler and predictable.
import { satSubsystemOrigin } from './satSubsystems.js';

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

// ── Time offset ─────────────────────────────────────────────────────────
//
// A simulated satellite's own subsystems may be internally operating as if
// it's a completely different date than real wall-clock time (e.g. the sim
// environment thinks it's Feb 2026 while the browser's Date.now() says
// July 2026) — every time-windowed fetch/label elsewhere in the app that
// computes its own Date.now() for THIS satellite's data would otherwise be
// silently wrong (querying an empty window, or showing "163 days ago" for
// something the simulation considers current).
//
// Auto-detected, not manually entered: SCC exposes its own idea of "now" at
// GET /api/v1/time ({"serverTime": "<ISO>"}) — confirmed live. Comparing
// that against this browser's own Date.now() at fetch time gives a stable
// offset for as long as the simulated clock keeps advancing at normal
// speed (the common case) — no manual maintenance, and it self-corrects if
// the simulation is paused/reset/rebased, next time this refetches (see
// satPing.js's 'timeOffset' cadence).
const _offsetMsCache = new Map(); // noradId → ms (serverTime - Date.now() at fetch time)

export async function fetchSatTimeOffset(sat) {
  if (!satIsSimulated(sat.noradId)) return; // real satellites' own clocks should already read real time — nothing to correct
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return;
  try {
    const res = await fetch(`${origin}/api/v1/time`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return;
    const { serverTime } = await res.json();
    const serverMs = Date.parse(serverTime);
    if (Number.isFinite(serverMs)) _offsetMsCache.set(sat.noradId, serverMs - Date.now());
  } catch { /* offline or aborted — keep whatever offset (possibly none) is already cached */ }
}

// "Now", from this satellite's own point of view — plain Date.now() for a
// non-simulated satellite (offset defaults to 0, i.e. no correction) or one
// whose offset hasn't been fetched yet, so every call site can use this
// unconditionally instead of branching on satIsSimulated itself.
export function satEffectiveNow(noradId) {
  return Date.now() + (_offsetMsCache.get(noradId) ?? 0);
}

// Whether this satellite's offset has ever actually been resolved — lets a
// caller (satPing.js's own first-cycle handling) tell "no correction needed,
// this is a real satellite" apart from "this IS simulated but its offset
// hasn't landed yet, satEffectiveNow is still silently returning uncorrected
// Date.now()" — a distinction satEffectiveNow's own 0-default deliberately
// erases for every OTHER call site, which don't need it.
export function hasSatTimeOffset(noradId) {
  return _offsetMsCache.has(noradId);
}
