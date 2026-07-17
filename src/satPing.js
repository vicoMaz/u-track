import { store }              from './store.js';
import { fetchSatTelemetry } from './satTelemetry.js';
import { fetchSatPasses }    from './satPasses.js';
import { fetchSatTle }       from './satTle.js';
import { fetchSatAntennas } from './satAntennas.js';
import { fetchSatGnss }           from './satGnss.js';
import { fetchSatEventBaseline }  from './satEventBaseline.js';
import { fetchSatGroundEvents }   from './satGroundEvents.js';
import { fetchSatGlobals }        from './satGlobals.js';
import { fetchSatVersions }       from './satVersions.js';
import { satSubsystemOrigin } from './satSubsystems.js';

const PING_TIMEOUT = 5_000;

// ── Interval (user-configurable, stored in localStorage) ──────────

export function getPingIntervalSec() {
  return Math.max(5, parseInt(localStorage.getItem('ping-interval') ?? '20', 10));
}

// ── Per-satellite timing (for animation sync) ─────────────────────

const _lastPingMs = {}; // satId → timestamp of last completed ping

export function getPingElapsedSec(satId) {
  return _lastPingMs[satId] ? (Date.now() - _lastPingMs[satId]) / 1000 : 0;
}

export function getLastPingMs(satId) {
  return _lastPingMs[satId] ?? null;
}

// ── IP helpers ────────────────────────────────────────────────────

// Keyed by noradId so the IP persists across page reloads (local sat IDs are time-based)
export function satBaseUrl(noradId) {
  return localStorage.getItem(`sat-baseurl-${noradId}`) ?? '';
}

export function setSatBaseUrl(noradId, ip) {
  if (ip) localStorage.setItem(`sat-baseurl-${noradId}`, ip);
  else     localStorage.removeItem(`sat-baseurl-${noradId}`);
  // Persist to server so it survives localStorage clears and server restarts
  fetch(`/api/satellites/${noradId}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ baseUrl: ip || null }),
  }).catch(() => {});
}

// JWT tokens are per-satellite and stored client-side only (never sent to the local server)
export function satJwt(noradId) {
  return localStorage.getItem(`sat-jwt-${noradId}`) ?? '';
}

export function setSatJwt(noradId, token) {
  if (token) localStorage.setItem(`sat-jwt-${noradId}`, token);
  else       localStorage.removeItem(`sat-jwt-${noradId}`);
}

// ── Ping logic ────────────────────────────────────────────────────

async function _ping(sat) {
  const ip = satBaseUrl(sat.noradId);
  if (!ip) {
    _lastPingMs[sat.id] = Date.now();
    store.setPingStatus(sat.id, 'unconfigured');
    return;
  }
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const sccRoOrigin = satSubsystemOrigin(sat.noradId, 'sccRo');
    await fetch(`${sccRoOrigin}/api/v1/ping`, {
      method: 'GET',
      mode:   'no-cors',
      signal: ctrl.signal,
    });
    // Set timestamp BEFORE notifying so animation delay is computed correctly
    _lastPingMs[sat.id] = Date.now();
    store.setPingStatus(sat.id, 'ok');
  } catch (e) {
    // Do NOT update _lastPingMs on failure — the elapsed counter should show
    // how long ago the satellite was last reachable, not when we last tried.
    store.setPingStatus(sat.id, e.name === 'AbortError' ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-satellite chained scheduling ─────────────────────────────
// Each satellite gets its own setTimeout chain so the next ping fires
// exactly `period` seconds after the previous one COMPLETED — no drift.

const _schedTimers = {}; // satId → timer handle

// Most polled data doesn't actually change every ping cycle (default 20s) —
// TLEs update ~2×/day (and already arrive live via apiPoller's tleUpdate
// feed), the antenna roster is near-static config, event baselines/ground
// event counts are rolling aggregates that shift slowly, and the pass
// schedule + procedure history only change a few times a day outside of an
// active pass. Polling all of these every 20s per satellite was pure request
// volume for no freshness benefit. Only telemetry genuinely needs 20s.
// Each key gets its own independent cadence, tracked the same way the
// pre-existing globals/versions slow cycle already worked.
const CADENCE_MS = {
  passes:        2  * 60_000, // schedule + procedure history
  tle:           30 * 60_000, // also pushed live via apiPoller's tleUpdate
  antennas:      30 * 60_000, // near-static ground-station roster
  eventBaseline: 30 * 60_000, // "24h-ago" snapshot, changes ~hourly at most
  groundEvents:  60_000,      // rolling 24h aggregate
  globals:       30 * 60_000, // software versions — pre-existing cadence
};
const _lastFetchMs = {}; // `${satId}:${key}` → timestamp of last completed fetch

function _due(satId, key) {
  return Date.now() - (_lastFetchMs[`${satId}:${key}`] ?? 0) > CADENCE_MS[key];
}
function _markFetched(satId, key) {
  _lastFetchMs[`${satId}:${key}`] = Date.now();
}

// Bumped on every _startSat call (satellite added, or a manual force-ping
// click) so an OLDER, still-running _pingAndReschedule chain can tell it's
// been superseded and quietly stop rescheduling itself instead of running
// forever in parallel with the newer one — e.g. two rapid force-ping clicks
// on the same row would otherwise leave that satellite pinging at double
// rate permanently, not just once.
const _gen = {}; // satId → generation counter

async function _pingAndReschedule(sat, myGen) {
  try {
    await _ping(sat);
    if (store.pingStatus[sat.id] === 'ok') {
      const fetches = [fetchSatTelemetry(sat), fetchSatGnss(sat)];
      if (_due(sat.id, 'passes'))        { _markFetched(sat.id, 'passes');        fetches.push(fetchSatPasses(sat)); }
      if (_due(sat.id, 'tle'))           { _markFetched(sat.id, 'tle');           fetches.push(fetchSatTle(sat)); }
      if (_due(sat.id, 'antennas'))      { _markFetched(sat.id, 'antennas');      fetches.push(fetchSatAntennas(sat)); }
      if (_due(sat.id, 'eventBaseline')) { _markFetched(sat.id, 'eventBaseline'); fetches.push(fetchSatEventBaseline(sat)); }
      if (_due(sat.id, 'groundEvents'))  { _markFetched(sat.id, 'groundEvents');  fetches.push(fetchSatGroundEvents(sat)); }
      if (_due(sat.id, 'globals'))       { _markFetched(sat.id, 'globals');       fetches.push(fetchSatGlobals(sat), fetchSatVersions(sat)); }
      await Promise.all(fetches);
    }
  } catch { /* never let an error kill the cycle */ }
  if (_gen[sat.id] !== myGen) return; // superseded by a newer _startSat call — let this chain end here
  _schedTimers[sat.id] = setTimeout(() => _pingAndReschedule(sat, myGen), getPingIntervalSec() * 1000);
}

function _startSat(sat) {
  clearTimeout(_schedTimers[sat.id]);
  // Mark started immediately — _pingAndReschedule only overwrites this with
  // the real timer handle once its first cycle's ping+fetches finish (which
  // can take over a second). Without this, a 'satellites' notification that
  // fires mid-cycle (e.g. apiPoller's tleUpdate, or another satellite being
  // added) finds the guard below still falsy and restarts EVERY satellite
  // again on top of its already-in-flight chain — confirmed via tracing that
  // this was quadrupling ping/fetch volume in practice, not a one-off blip.
  _schedTimers[sat.id] = true;
  const myGen = (_gen[sat.id] ?? 0) + 1;
  _gen[sat.id] = myGen;
  _pingAndReschedule(sat, myGen);
}

export function pingSatellite(satId) {
  const sat = store.satellites.find(s => s.id === satId);
  if (sat) _startSat(sat);
}

export function restartPingPoller() {
  for (const sat of store.satellites) _startSat(sat);
}

export function initSatPing() {
  for (const sat of store.satellites) _startSat(sat);
  store.subscribe(key => {
    if (key !== 'satellites') return;
    // Start any newly added satellites; existing timers keep running
    for (const sat of store.satellites) {
      if (!_schedTimers[sat.id]) _startSat(sat);
    }
  });
}
