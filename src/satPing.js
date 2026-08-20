import { store }              from './store.js';
import { fetchSatTelemetry } from './satTelemetry.js';
import { fetchSatPasses }    from './satPasses.js';
import { fetchSatTle }       from './satTle.js';
import { fetchSatAntennas } from './satAntennas.js';
import { fetchSatGnss }           from './satGnss.js';
import { fetchSatGnssMitigation } from './satGnssMitigation.js';
import { fetchSatEventBaseline }  from './satEventBaseline.js';
import { fetchSatGroundEvents }   from './satGroundEvents.js';
import { fetchSatMissionMode }    from './satMissionMode.js';
import { fetchSatGlobals }        from './satGlobals.js';
import { fetchSatVersions }       from './satVersions.js';
import { satSubsystemOrigin, satSubsystemPingOrigin, SUBSYSTEMS } from './satSubsystems.js';
import { satIsSimulated, fetchSatTimeOffset, hasSatTimeOffset, satEffectiveNow } from './satSimu.js';

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
// volume for no freshness benefit. Each key gets its own independent cadence,
// tracked the same way the pre-existing globals/versions slow cycle already
// worked. Telemetry doesn't need 20s either, except while a pass is actually
// running — see _inPassWindow and CADENCE_MS.idleTm below.
const CADENCE_MS = {
  passes:        2  * 60_000, // schedule + procedure history
  tle:           30 * 60_000, // also pushed live via apiPoller's tleUpdate
  antennas:      30 * 60_000, // near-static ground-station roster
  eventBaseline: 30 * 60_000, // "N-days-ago" snapshot (see alertWindow.js), changes slowly
  groundEvents:  60_000,      // rolling N-day aggregate (see alertWindow.js)
  missionMode:   60_000,      // on/off flag — only changes via the Fleet row's own Enable/Disable action
  globals:       30 * 60_000, // SCC's own globals blob — pre-existing cadence
  versions:      6 * 3600_000, // the five :5000/{scc,sccRo,gnm,fds,mic}Info probes (satVersions.js).
                               // Split off `globals`, which it used to ride: five requests every
                               // 30min per satellite (10/h) to report SOFTWARE VERSION STRINGS,
                               // which change on a deployment, not on a timescale any dashboard
                               // needs to track. 6h still catches a deploy within one shift.
  gnssMitigation: 30 * 60_000, // rare-event counter — no benefit polling faster than the slow cycle
  subsystemProbe: 30 * 60_000, // SCC/FDS/GNM/MIC reachability — a VPN's routing doesn't change mid-session,
                                // first probe still fires on the very first 'ok' cycle since _due() treats
                                // "never fetched" as due, only the REPEATS are slow-cadence
  timeOffset:    2  * 60_000, // simulated satellites only (satSimu.js) — same cadence as passes, frequent
                               // enough to notice a paused/reset/rebased sim within a couple minutes
  idleTm:        5  * 60_000, // telemetry + GNSS while NOT in a pass — see _inPassWindow below
};
const _lastFetchMs = {}; // `${satId}:${key}` → timestamp of last completed fetch

function _due(satId, key) {
  return Date.now() - (_lastFetchMs[`${satId}:${key}`] ?? 0) > CADENCE_MS[key];
}

// Grace period after LOS before telemetry drops back to the idle cadence, so
// the ground segment has time to finish injecting everything the pass
// delivered. Measured against real data, reception lands inside the pass window
// itself (a 12.5-minute pass's rows were all stamped within it), so this is
// deliberately generous insurance rather than a tuned value.
const POST_PASS_MARGIN_MS = 10 * 60_000;

// Whether this satellite could plausibly have new telemetry right now.
//
// Spacecraft TM is store-and-forward: it only reaches the ground during a
// pass. Verified against the live SCC — for one satellite, an 18-hour
// /api/v1/parameters query returned 1000 rows ALL stamped inside a single
// 12.5-minute pass, and two multi-hour windows containing no pass returned
// exactly 0 rows. So polling telemetry every 20s between passes re-fetched an
// unchanged packet: not stale data, no data. At ~2.7 passes/day that is ~4% of
// the day where the answer can actually change.
//
// Returns true (poll normally) when the pass list is empty rather than false.
// That covers "passes haven't loaded yet", "FDS is unreachable", and "this
// satellite has no schedule at all" — in each case we don't know when contact
// happens, and the safe default is to keep looking rather than go blind. The
// caller pairs this with an idle cadence rather than stopping outright, so an
// unscheduled or overrunning contact is still picked up within CADENCE_MS.idleTm
// instead of waiting for the next scheduled pass.
function _inPassWindow(sat) {
  const passes = store.satPasses[sat.id];
  if (!passes?.length) return true;
  // satEffectiveNow, not Date.now(): a simulated satellite's passes are stamped
  // in its own sim time (see satSimu.js), so comparing against wall clock would
  // put every one of them permanently outside their pass windows.
  const now = satEffectiveNow(sat.noradId);
  return passes.some(p => now >= p.start.getTime() && now <= p.end.getTime() + POST_PASS_MARGIN_MS);
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
      // A simulated satellite's very FIRST cycle needs its clock offset
      // resolved BEFORE fetchSatPasses/fetchSatTelemetry compute their own
      // query window from satEffectiveNow — racing it (as every LATER cycle
      // still safely does, below) sent that first fetch against plain,
      // uncorrected Date.now(), which can be months off from where this
      // satellite's own data actually lives (see satSimu.js's own comment).
      // passes' 2-minute cadence gate (CADENCE_MS.passes) then left it
      // showing nothing/wrong for a full cycle before self-correcting —
      // confirmed live as the ~1min-vs-~1s Fleet load gap between simulated
      // and real satellites. Gated on hasSatTimeOffset (not just "is this
      // cycle due"), so this awaited branch only ever fires once per
      // satellite — once an offset lands, every later cycle falls through
      // to the normal parallel race, whose staleness is fine.
      if (satIsSimulated(sat.noradId) && !hasSatTimeOffset(sat.noradId) && _due(sat.id, 'timeOffset')) {
        _markFetched(sat.id, 'timeOffset');
        await fetchSatTimeOffset(sat);
      }

      // Telemetry and GNSS are the only two fetches on every cycle, and both
      // read spacecraft TM — so both follow the pass window. In pass: every
      // cycle, as before. Out of pass: CADENCE_MS.idleTm, purely as a safety
      // net for contacts the schedule doesn't know about.
      //
      // Everything below stays ungated on purpose: `passes` is what tells us
      // when the next window IS, groundEvents/missionMode are ground-side and
      // move independently of contact, and the rest are already on slow
      // cadences. The ping itself also stays every cycle — it answers "is the
      // box reachable", which has nothing to do with whether the spacecraft is
      // overhead, and it's a single no-cors request.
      const fetches = [];
      const inPass = _inPassWindow(sat);
      if (inPass || _due(sat.id, 'idleTm')) {
        if (!inPass) _markFetched(sat.id, 'idleTm');
        fetches.push(fetchSatTelemetry(sat), fetchSatGnss(sat));
      }
      if (_due(sat.id, 'passes'))        { _markFetched(sat.id, 'passes');        fetches.push(fetchSatPasses(sat)); }
      if (_due(sat.id, 'tle'))           { _markFetched(sat.id, 'tle');           fetches.push(fetchSatTle(sat)); }
      if (_due(sat.id, 'antennas'))      { _markFetched(sat.id, 'antennas');      fetches.push(fetchSatAntennas(sat)); }
      if (_due(sat.id, 'eventBaseline')) { _markFetched(sat.id, 'eventBaseline'); fetches.push(fetchSatEventBaseline(sat)); }
      if (_due(sat.id, 'groundEvents'))  { _markFetched(sat.id, 'groundEvents');  fetches.push(fetchSatGroundEvents(sat)); }
      if (_due(sat.id, 'missionMode'))   { _markFetched(sat.id, 'missionMode');   fetches.push(fetchSatMissionMode(sat)); }
      if (_due(sat.id, 'globals'))       { _markFetched(sat.id, 'globals');       fetches.push(fetchSatGlobals(sat)); }
      if (_due(sat.id, 'versions'))      { _markFetched(sat.id, 'versions');      fetches.push(fetchSatVersions(sat)); }
      if (_due(sat.id, 'gnssMitigation')) { _markFetched(sat.id, 'gnssMitigation'); fetches.push(fetchSatGnssMitigation(sat)); }
      if (_due(sat.id, 'subsystemProbe')) { _markFetched(sat.id, 'subsystemProbe'); fetches.push(_probeSubsystems(sat)); }
      // Every cycle AFTER the first already has an offset cached (however
      // slightly stale) — safe to race here like any other cadence-gated
      // fetch, since passes/telemetry's own window only needs to be
      // approximately right, not exactly current-to-the-second. _due is
      // already false here on the very cycle the block above just ran
      // (same _markFetched call), so this never double-fetches.
      if (satIsSimulated(sat.noradId) && _due(sat.id, 'timeOffset')) { _markFetched(sat.id, 'timeOffset'); fetches.push(fetchSatTimeOffset(sat)); }
      await Promise.all(fetches);
    }
  } catch (e) {
    // Never let an error kill the cycle — the chain must keep rescheduling below
    // whatever happens. But it is logged now: this catch previously swallowed
    // silently, and a single missing import in _inPassWindow therefore turned
    // into "every fetch stops after cycle 1" with nothing on the console to say
    // so. Individual fetch modules already handle their own network failures, so
    // anything arriving here is a programming error worth seeing.
    console.warn(`[satPing] cycle failed for ${sat.name ?? sat.id}:`, e);
  }
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

// Stops a satellite's poll chain for good. Bumping the generation is what
// actually does it: _pingAndReschedule checks _gen against the value it was
// started with and returns instead of rescheduling, so even a cycle already
// in flight ends at its next reschedule point rather than living on. Clearing
// the per-satellite bookkeeping too, so a later re-add starts from a clean
// slate rather than inheriting a removed satellite's cadence timestamps.
export function stopSatPing(satId) {
  _gen[satId] = (_gen[satId] ?? 0) + 1;
  if (typeof _schedTimers[satId] !== 'boolean') clearTimeout(_schedTimers[satId]);
  delete _schedTimers[satId];
  delete _lastPingMs[satId];
  delete _failCount[satId];
  for (const key of Object.keys(_lastFetchMs)) {
    if (key.startsWith(`${satId}:`)) delete _lastFetchMs[key];
  }
}

// Cold-start spreading (two parts).
//
// Nothing is cadence-gated on a satellite's first cycle, because _due() treats
// "never fetched" as due — so cycle 1 fires every slow-cadence key at once.
// Measured: 38 requests for a single satellite inside the first second, and a
// fleet multiplies that. It is the peak stress moment on the backends and it
// lands on top of whatever else the page is doing at load.
//
// FIRST_CYCLE_STAGGER_MS spaces the satellites apart — on its own that already
// spreads most of the burst, since it moves whole cycles rather than individual
// requests. _seedSlowKeys then pushes a SHORT list of keys out to a random point
// inside SLOW_KEY_SPREAD_MS. Everything the Fleet table actually renders fires
// immediately; see SLOW_KEYS below for the rule and for what it cost to get
// wrong.
const FIRST_CYCLE_STAGGER_MS = 500;
const SLOW_KEY_SPREAD_MS     = 45_000;

// A key may only be jittered if the Fleet table renders WITHOUT it — i.e. its
// absence leaves no visibly wrong value on screen. That rule was learned the
// hard way; three keys originally listed here each broke it:
//   - eventBaseline: _alertsCell computes the BRD delta as
//     `(bVal != null && bBase != null) ? bVal - bBase : 0`, so no baseline means
//     every board-alert count renders a confident 0 rather than "—".
//   - gnssMitigation: _mitigationRow prints "N×/17d" from it; without it the
//     GNSS column's cycle count sat blank for up to the full spread.
//   - antennas: the Visualizer's satellite panel groups ground stations by
//     network from this roster, so the groups appeared late and empty.
// What's left is safe: tle only refreshes an age the Fleet already derives from
// the satrec loaded with /api/satellites, and globals/versions/subsystemProbe
// only decorate link badges and distinguish a read-only VPN.
const SLOW_KEYS = ['tle', 'globals', 'versions', 'subsystemProbe'];

// _due() compares against CADENCE_MS, so backdating _lastFetchMs to
// (now - cadence + delay) makes the key come due exactly `delay` from now.
function _seedSlowKeys(satId) {
  for (const key of SLOW_KEYS) {
    const delay = Math.random() * SLOW_KEY_SPREAD_MS;
    _lastFetchMs[`${satId}:${key}`] = Date.now() - CADENCE_MS[key] + delay;
  }
}

export function initSatPing() {
  // Staggered only here, on the initial fleet load. pingSatellite (the Fleet
  // row's force-ping) and restartPingPoller both go straight to _startSat —
  // those are explicit user actions and should feel immediate.
  store.satellites.forEach((sat, i) => {
    _seedSlowKeys(sat.id);
    setTimeout(() => _startSat(sat), i * FIRST_CYCLE_STAGGER_MS);
  });
  store.subscribe(key => {
    if (key !== 'satellites') return;
    // Start any newly added satellites; existing timers keep running
    for (const sat of store.satellites) {
      if (!_schedTimers[sat.id]) { _seedSlowKeys(sat.id); _startSat(sat); }
    }
    // ...and stop any whose satellite is gone. store.removeSatellite deletes
    // every per-satellite store key but can't call in here (store.js can't
    // import this module without a cycle), so reaping from the notification
    // it already fires is what keeps a removed satellite from polling
    // forever: the chain closes over the `sat` OBJECT, not a store lookup, so
    // nothing else in it ever notices the satellite is gone. Left running it
    // kept issuing ~1,100 requests/hour to hosts the operator explicitly
    // removed, and each cycle re-created the very store keys removeSatellite
    // had just deleted. Doing it here (not at the delete button) also covers
    // any future removal path for free.
    for (const satId of Object.keys(_schedTimers)) {
      if (!store.satellites.some(s => s.id === satId)) stopSatPing(satId);
    }
  });
}
