// Per-satellite "notify me 1 min before this satellite's next pass" via the
// browser's own OS-level Notification API — deliberately NOT actionToast.js's
// in-app toast, since the whole point is surfacing this even when the tab
// isn't focused (actionToast.js's warning toast already covers the
// tab-focused case for other conditions).
//
// Enabled per satellite, localStorage-backed — same sat-<flag>-${noradId}
// pattern satSimu.js's own satIsSimulated/setSatIsSimulated use.
import { store } from './store.js';

const _cache = new Map(); // noradId → boolean

export function satPassNotifyEnabled(noradId) {
  if (_cache.has(noradId)) return _cache.get(noradId);
  const v = localStorage.getItem(`sat-passnotify-${noradId}`) === '1';
  _cache.set(noradId, v);
  return v;
}

export function setSatPassNotifyEnabled(noradId, enabled) {
  if (enabled) localStorage.setItem(`sat-passnotify-${noradId}`, '1');
  else localStorage.removeItem(`sat-passnotify-${noradId}`);
  _cache.set(noradId, enabled);
}

// Chrome only shows its OS-level permission prompt in response to a real
// user gesture (a toggle click qualifies, a background timer does not) — the
// Settings toggle's own click handler calls this directly, synchronously in
// that gesture, rather than initPassNotify's background tick ever trying to.
// Returns false for "asked and refused" as much as "browser doesn't support
// Notification at all" — the caller doesn't need to tell those apart, both
// mean the toggle can't actually do anything if turned on.
export async function requestPassNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

const LEAD_MS = 60_000; // fire 1 min before AOS0 (pass.start — satPasses.js)
const TICK_MS = 5_000;  // frequent enough that the 1-min lead window is never stepped over between checks

// One notification per pass, not re-fired every tick for the whole time
// msUntil stays inside the lead window — keyed by satId+its own AOS time (not
// just satId) so the NEXT pass, once this one's past, notifies again on its
// own right.
const _notified = new Set();

function _tick() {
  const now = Date.now();
  for (const sat of store.satellites) {
    if (!satPassNotifyEnabled(sat.noradId)) continue;
    if (Notification.permission !== 'granted') continue; // revoked from Chrome's own site settings since the toggle was turned on — nothing to do until the user re-grants it
    const next = (store.satPasses[sat.id] ?? []).find(p => p.future);
    if (!next) continue;
    const startMs = next.start.getTime();
    const msUntil = startMs - now;
    if (msUntil > LEAD_MS || msUntil <= 0) continue;
    const key = `${sat.id}|${startMs}`;
    if (_notified.has(key)) continue;
    _notified.add(key);
    new Notification(`${sat.name} — pass in 1 min`, {
      body: `AOS ${next.start.toISOString().replace('T', ' ').slice(0, 19)} UTC${next.station ? ' · ' + next.station : ''}`,
      tag: key, // replaces rather than stacks if somehow triggered twice for the same pass
    });
  }
  // Unbounded growth guard for a long-running tab — an entry over an hour
  // past its own AOS is definitely done mattering.
  for (const key of _notified) {
    if (now - Number(key.split('|')[1]) > 3_600_000) _notified.delete(key);
  }
}

export function initPassNotify() {
  if (!('Notification' in window)) return;
  setInterval(_tick, TICK_MS);
}
