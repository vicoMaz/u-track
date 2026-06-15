import { store } from './store.js';

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

// ── IP helpers ────────────────────────────────────────────────────

export function satBaseUrl(satId) {
  return localStorage.getItem(`sat-baseurl-${satId}`) ?? '';
}

export function setSatBaseUrl(satId, ip) {
  if (ip) localStorage.setItem(`sat-baseurl-${satId}`, ip);
  else     localStorage.removeItem(`sat-baseurl-${satId}`);
}

// ── Ping logic ────────────────────────────────────────────────────

async function _ping(sat) {
  const ip = satBaseUrl(sat.id);
  if (!ip) {
    _lastPingMs[sat.id] = Date.now();
    store.setPingStatus(sat.id, 'unconfigured');
    return;
  }
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    await fetch(`http://${ip}:15000/api/v1/ping`, {
      method: 'GET',
      mode:   'no-cors', // only care if server responds, not the body
      signal: ctrl.signal,
    });
    store.setPingStatus(sat.id, 'ok');
  } catch (e) {
    store.setPingStatus(sat.id, e.name === 'AbortError' ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
    _lastPingMs[sat.id] = Date.now();
  }
}

function _pingAll() {
  for (const sat of store.satellites) _ping(sat);
}

export function pingSatellite(satId) {
  const sat = store.satellites.find(s => s.id === satId);
  if (sat) _ping(sat);
}

// ── Poller lifecycle ──────────────────────────────────────────────

let _timer = null;

function _startPoller() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(_pingAll, getPingIntervalSec() * 1000);
}

export function restartPingPoller() {
  _pingAll();
  _startPoller();
}

export function initSatPing() {
  _pingAll();
  _startPoller();
  store.subscribe(key => {
    if (key === 'satellites') _pingAll();
  });
}
