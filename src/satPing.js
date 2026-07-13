import { store }              from './store.js';
import { fetchSatTelemetry } from './satTelemetry.js';
import { fetchSatPasses }    from './satPasses.js';
import { fetchSatTle }       from './satTle.js';
import { fetchSatAntennas } from './satAntennas.js';
import { fetchSatGnss }           from './satGnss.js';
import { fetchSatEventBaseline }  from './satEventBaseline.js';
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
    const fdsOrigin = satSubsystemOrigin(sat.noradId, 'fds');
    await fetch(`${fdsOrigin}/api/v1/ping`, {
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

async function _pingAndReschedule(sat) {
  try {
    await _ping(sat);
    if (store.pingStatus[sat.id] === 'ok') {
      await Promise.all([fetchSatTelemetry(sat), fetchSatPasses(sat), fetchSatTle(sat), fetchSatAntennas(sat), fetchSatGnss(sat), fetchSatEventBaseline(sat)]);
    }
  } catch { /* never let an error kill the cycle */ }
  _schedTimers[sat.id] = setTimeout(() => _pingAndReschedule(sat), getPingIntervalSec() * 1000);
}

function _startSat(sat) {
  clearTimeout(_schedTimers[sat.id]);
  _pingAndReschedule(sat);
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
