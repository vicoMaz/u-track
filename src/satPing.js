import { store }              from './store.js';
import { fetchSatTelemetry } from './satTelemetry.js';
import { fetchSatPasses }    from './satPasses.js';
import { fetchSatTle }       from './satTle.js';
import { fetchSatAntennas } from './satAntennas.js';
import { fetchSatGnss }           from './satGnss.js';
import { fetchSatGnssMitigation } from './satGnssMitigation.js';
import { fetchSatEventBaseline }  from './satEventBaseline.js';
import { fetchSatGroundEvents }   from './satGroundEvents.js';
import { fetchSatGlobals }        from './satGlobals.js';
import { fetchSatVersions }       from './satVersions.js';
import { satSubsystemOrigin, satSubsystemPingOrigin, SUBSYSTEMS } from './satSubsystems.js';
import { satIsSimulated, fetchSatTimeOffset } from './satSimu.js';

const PING_TIMEOUT = 5_000;

// Consecutive ping failures before this client treats a satellite as
// unreachable on its own network and hides it (store.accessibleSatellites) —
// requiring a few in a row (rather than one) avoids a satellite flickering
// in/out of every list on a single dropped packet. At the default 20s
// interval that's ~1 minute to react to a genuine "my VPN doesn't route
// there" case, which is a stable condition, not a transient blip.
const ACCESSIBLE_FAIL_THRESHOLD = 3;
const _failCount = {}; // satId → consecutive timeout/error count

// Subsystems probed (in addition to SCC RO, which the main ping above
// already covers) purely to tell "fully reachable" apart from "read-only —
// only SCC RO is on my VPN" for store.readOnlyVpn's sake. Same no-cors
// reachability trick as the main ping: we don't care about the response,
// only whether the request completes vs. times out/network-errors.
const SUBSYSTEM_PROBE_KEYS = ['scc', 'fds', 'gnm', 'mic'];

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
    // Not configured yet is a setup concern, not a VPN-reachability one —
    // don't hide it for that.
    _failCount[sat.id] = 0;
    store.setSatAccessible(sat.id, true);
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
    _failCount[sat.id] = 0;
    store.setSatAccessible(sat.id, true);
  } catch (e) {
    // Do NOT update _lastPingMs on failure — the elapsed counter should show
    // how long ago the satellite was last reachable, not when we last tried.
    store.setPingStatus(sat.id, e.name === 'AbortError' ? 'timeout' : 'error');
    _failCount[sat.id] = (_failCount[sat.id] ?? 0) + 1;
    if (_failCount[sat.id] >= ACCESSIBLE_FAIL_THRESHOLD) store.setSatAccessible(sat.id, false);
  } finally {
    clearTimeout(timer);
  }
}

// Probes SCC/FDS/GNM/MIC reachability for one satellite — only meaningful
// once the main SCC RO ping above has already succeeded (see
// _pingAndReschedule's call site), so store.readOnlyVpn can tell "SCC RO
// only" apart from "satellite is down entirely" (the latter is
// store.satAccessible's job instead).
async function _probeSubsystems(sat) {
  await Promise.all(SUBSYSTEM_PROBE_KEYS.map(async key => {
    const origin = satSubsystemPingOrigin(sat.noradId, key);
    if (!origin) { store.setSubsystemReachable(sat.id, key, null); return; }
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
    try {
      await fetch(`${origin}${SUBSYSTEMS[key].pingPath}`, { method: 'GET', mode: 'no-cors', signal: ctrl.signal });
      store.setSubsystemReachable(sat.id, key, true);
    } catch {
      store.setSubsystemReachable(sat.id, key, false);
    } finally {
      clearTimeout(timer);
    }
  }));
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
  gnssMitigation: 30 * 60_000, // rare-event counter — no benefit polling faster than the slow cycle
  subsystemProbe: 30 * 60_000, // SCC/FDS/GNM/MIC reachability — a VPN's routing doesn't change mid-session,
                                // first probe still fires on the very first 'ok' cycle since _due() treats
                                // "never fetched" as due, only the REPEATS are slow-cadence
  timeOffset:    2  * 60_000, // simulated satellites only (satSimu.js) — same cadence as passes, frequent
                               // enough to notice a paused/reset/rebased sim within a couple minutes
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
      if (_due(sat.id, 'gnssMitigation')) { _markFetched(sat.id, 'gnssMitigation'); fetches.push(fetchSatGnssMitigation(sat)); }
      if (_due(sat.id, 'subsystemProbe')) { _markFetched(sat.id, 'subsystemProbe'); fetches.push(_probeSubsystems(sat)); }
      // Runs alongside (not before) the others below in the same
      // Promise.all — on this satellite's very FIRST cycle, fetchSatPasses/
      // fetchSatTelemetry may briefly race ahead of it and use no offset
      // yet; self-corrects on the next cycle, 2 minutes later, same as any
      // other cadence-gated fetch here would.
      if (satIsSimulated(sat.noradId) && _due(sat.id, 'timeOffset')) { _markFetched(sat.id, 'timeOffset'); fetches.push(fetchSatTimeOffset(sat)); }
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
