// For a FUTURE pass, procedure-history (satPasses.js) has nothing yet — those
// procedures haven't executed. What we CAN show instead is what's already
// queued for that pass on SCC, via the same GET /api/v1/procedure-scheduler
// endpoint the TMR-gap-download feature (tmrGapDownload.js) already reads to
// check for an existing request. Deliberately read-only (GET only, never
// POST) — this module never schedules anything, only reports what's already
// scheduled.
import { satSubsystemOrigin } from '../satSubsystems.js';

// SCC's own /api/v1/events uses a DIFFERENT id space than the sccRo-sourced
// store.satPasses list (same caveat tmrGapDownload.js's _nextSccPass notes) —
// so the matching pass event is found by station + AOS time within a
// tolerance, not by reusing pass.id directly.
const MATCH_TOLERANCE_MS = 10 * 60_000;

// Exported for procedureCatalog.js's own scheduleProcedure — it needs the
// exact same SCC-event-id lookup to POST a new procedure onto this pass.
export async function matchSccPassId(origin, pass, signal) {
  const start = new Date(pass.start.getTime() - 30 * 60_000).toISOString();
  const end   = new Date(pass.end.getTime()   + 30 * 60_000).toISOString();
  const url = `${origin}/api/v1/events`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&maxLimit=100`
    + `&onBoardEventsTime=onBoardTime`
    + `&groundEventsTime=onBoardTime`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const events = await res.json();
  const targetMs = pass.start.getTime();
  let best = null, bestDelta = Infinity;
  for (const e of events) {
    if (e.category !== 'SATELLITE_PASS') continue;
    const st = e.pass?.groundStationId ?? e.content ?? null;
    if (pass.station && st && st !== pass.station) continue;
    const delta = Math.abs(new Date(e.start).getTime() - targetMs);
    if (delta < bestDelta) { bestDelta = delta; best = e; }
  }
  return best && bestDelta <= MATCH_TOLERANCE_MS ? best.id : null;
}

// `${noradId}|${passId}` → Promise<Array|null> — cached so hovering a pass in
// the tooltip and then clicking it open in the panel a moment later don't
// each pay for their own round trip. null = SCC unreachable, [] = nothing
// scheduled yet, distinguished so the UI can tell "unknown" from "empty".
const _cache = new Map();

export async function fetchScheduledProcedures(sat, pass) {
  const key = `${sat.noradId}|${pass.id}`;
  if (_cache.has(key)) return _cache.get(key);
  const promise = (async () => {
    const origin = satSubsystemOrigin(sat.noradId, 'scc');
    if (!origin) return null;
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const eventId = await matchSccPassId(origin, pass, ctrl.signal);
      if (!eventId) return null;
      const res = await fetch(`${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  _cache.set(key, promise);
  return promise;
}

// Drops the cached result for this pass so the NEXT fetchScheduledProcedures
// call actually hits SCC again instead of replaying a stale answer —
// Scheduler.js calls this right after successfully scheduling or
// unscheduling a procedure on a pass, since otherwise the "scheduled
// procedures" list would keep showing the pre-change state indefinitely
// (this cache has no TTL of its own; it's keyed purely on satId+passId).
export function invalidateScheduledProcedures(sat, pass) {
  _cache.delete(`${sat.noradId}|${pass.id}`);
}

// Same idea as invalidateScheduledProcedures, but for callers that scheduled
// something WITHOUT going through a specific FDS-space pass object — e.g.
// tmrGapDownload.js's gap-download button, which schedules onto whatever SCC
// itself reports as the satellite's next pass (a separate, SCC-event-space
// lookup that doesn't resolve back to one of THIS module's own pass.id keys
// without another round trip). Dropping the whole cache is cheap (it's just
// unresolved/resolved Promises, no in-flight requests get cancelled) and
// guarantees correctness regardless of which pass actually got the new entry.
export function invalidateAllScheduledProcedures() {
  _cache.clear();
}

function _paramValue(parameters, name) {
  return parameters?.find(p => p.name === name)?.value ?? null;
}

// procs: null (SCC unreachable / couldn't match the pass — "unknown", not
// "empty"), [] (reached SCC, genuinely nothing queued), or an array of
// procedure-scheduler entries ({name, parameters, ...} — GET's response
// shape does NOT mirror the POST payload's field names, see
// tmrGapDownload.js's findMatchingGapProcedure for the same note).
export function scheduledProceduresHTML(procs, fmtTimeOnly) {
  if (procs == null) return `<div class="co-tt-note">Could not reach SCC to check scheduled procedures</div>`;
  if (!procs.length) return `<div class="co-tt-note">Nothing scheduled on SCC yet</div>`;
  const rows = procs.map((p, i) => {
    const name = (p.name ?? '?').split('.').pop();
    const schedTime = _paramValue(p.parameters, 'scheduleTime');
    const when = schedTime && !isNaN(Date.parse(schedTime)) ? fmtTimeOnly(Date.parse(schedTime)).slice(0, 8) : '';
    return `<div class="co-tt-proc co-tt-scheduled" title="${p.name ?? ''}">
      <span class="co-tt-num">${i + 1}</span>
      <span class="co-tt-pname">${name}</span>
      ${when ? `<span class="co-tt-dur">${when}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="co-tt-procs">${rows}</div>`;
}
