// The full procedure catalog (GET /api/v1/procedure — every procedure SCC
// knows how to run, as opposed to procedure-scheduler's GET, which lists only
// what's actually queued on one specific pass event). Backs the Scheduler
// tab's "Schedule a procedure" search/picker.
import { satSubsystemOrigin } from '../satSubsystems.js';
import { matchSccPassId } from './scheduledProcedures.js';

// noradId → Promise<Array|null> — cached per satellite for the session; the
// catalog is effectively static (SCC's own procedure library), not worth
// refetching on every satellite reselect.
const _catalogCache = new Map();

// Logged (not swallowed silently) — this endpoint is new to the app as of
// this feature, unlike procedure-scheduler/events which are already proven
// reachable elsewhere, so a failure here is worth being able to diagnose
// from the console instead of just seeing an opaque "could not reach SCC" in
// the UI (which fetchProcedureCatalog still returns null for, same
// null-means-unreachable convention scheduledProcedures.js's own
// fetchScheduledProcedures uses).
export async function fetchProcedureCatalog(sat) {
  if (_catalogCache.has(sat.noradId)) return _catalogCache.get(sat.noradId);
  const promise = (async () => {
    const origin = satSubsystemOrigin(sat.noradId, 'scc');
    if (!origin) {
      console.warn(`[procedureCatalog] no SCC origin configured for satellite ${sat.noradId} — set it under Settings`);
      return null;
    }
    const url   = `${origin}/api/v1/procedure`;
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        console.warn(`[procedureCatalog] GET ${url} → HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.warn(`[procedureCatalog] GET ${url} → expected an array, got:`, data);
        return [];
      }
      if (data.length && !('name' in data[0])) {
        console.warn(`[procedureCatalog] entries have no "name" field — check the real shape:`, JSON.stringify(data[0]));
      }
      return data;
    } catch (err) {
      console.warn(`[procedureCatalog] GET ${url} failed (network error or CORS) —`, err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  _catalogCache.set(sat.noradId, promise);
  return promise;
}

// POSTs `procedureName` onto `pass` with `procedureParameters` (built by
// Scheduler.js's own _onScheduleProcClick from whatever parameter schema it
// found on the catalog entry, with the user's form edits applied — see
// _findProcParams there). Same procedure-scheduler POST tmrGapDownload.js's
// own _scheduleProcedure uses; defaults to [] for a genuinely parameterless
// procedure, or when no parameter schema was found on the catalog entry at
// all (there's no way to know a given entry's schema for certain from GET
// /api/v1/procedure's own response alone — see Scheduler.js's own note).
export async function scheduleProcedure(sat, pass, procedureName, procedureParameters = []) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) throw new Error('SCC not configured for this satellite');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const eventId = await matchSccPassId(origin, pass, ctrl.signal);
    if (!eventId) throw new Error('Could not match this pass to an SCC event');
    const payload = {
      procedureName,
      procedureDescription: '',
      scheduled: false,
      activityId: '',
      procedureParameters,
    };
    const res = await fetch(`${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  ctrl.signal,
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Confirmed live: DELETE /api/v1/procedure-scheduler?id=<eventId>&procedureIndex=<n>
// — unlike the GET response's own id/activityId (always null on a
// not-yet-executed entry — see Scheduler.js's _scheduledProcEntryId... now
// removed, since it turned out unnecessary), a scheduled procedure is
// identified by its plain 0-based INDEX within that GET's own array, not by
// any id field on the entry itself.
export async function unscheduleProcedure(sat, pass, procedureIndex) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) throw new Error('SCC not configured for this satellite');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const eventId = await matchSccPassId(origin, pass, ctrl.signal);
    if (!eventId) throw new Error('Could not match this pass to an SCC event');
    const url = `${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}&procedureIndex=${encodeURIComponent(procedureIndex)}`;
    const res = await fetch(url, { method: 'DELETE', signal: ctrl.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Confirmed live: PUT /api/v1/procedure-scheduler?id=<eventId>&previousIndex=<n>&newIndex=<m>,
// no body — moves the procedure currently at previousIndex to newIndex
// (both 0-based, into the same array fetchScheduledProcedures/DELETE's own
// procedureIndex both key off). Backs the Scheduler tab's drag-to-reorder.
export async function reorderScheduledProcedure(sat, pass, previousIndex, newIndex) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) throw new Error('SCC not configured for this satellite');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const eventId = await matchSccPassId(origin, pass, ctrl.signal);
    if (!eventId) throw new Error('Could not match this pass to an SCC event');
    const url = `${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}&previousIndex=${encodeURIComponent(previousIndex)}&newIndex=${encodeURIComponent(newIndex)}`;
    const res = await fetch(url, { method: 'PUT', signal: ctrl.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
