import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

async function _fetchJson(fdsOrigin, path, signal) {
  const res = await fetch(`${fdsOrigin}${path}`, { signal });
  return res.ok ? res.json() : null;
}

// Determine pass outcome from its procedures list
function _passOutcome(procs) {
  if (!procs.length) return 'SUCCESS'; // no procedures → treat as success
  const acks = procs.map(p => p.status);
  if (acks.includes('FAILURE'))   return 'FAILURE';
  if (acks.includes('CANCELLED')) return 'CANCELLED';
  return 'SUCCESS';
}

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatPasses(sat) {
  const ip = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!ip) return;

  // ±5 days — matches TimePlayer.js's VIEW_HALF_SEC (the gantt's max zoom-out
  // and its eclipse/STT precompute window), so Passes/TMR never run out of
  // data at a different horizon than the other gantt rows.
  const now   = new Date();
  const start = new Date(now.getTime() - 5 * 24 * 3_600_000).toISOString();
  const end   = new Date(now.getTime() + 5 * 24 * 3_600_000).toISOString();

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // Fetch events and procedures in parallel — same time window
    const eventsPath = `/api/v1/events`
      + `?start=${encodeURIComponent(start)}`
      + `&end=${encodeURIComponent(end)}`
      + `&maxLimit=200`
      + `&onBoardEventsTime=onBoardTime`
      + `&groundEventsTime=receptionTime`;

    const procsPath = `/api/v1/procedure-history`
      + `?start=${encodeURIComponent(start)}`
      + `&end=${encodeURIComponent(end)}`
      + `&maxLimit=500`;

    const [eventsData, procsData] = await Promise.all([
      _fetchJson(ip, eventsPath,  ctrl.signal),
      _fetchJson(ip, procsPath,   ctrl.signal),
    ]);
    if (!eventsData) return;

    // Map each raw procedure to { name, status, startMs, endMs }
    const allProcs = (procsData ?? []).map(p => {
      const comp = p.completed;
      let status;
      if (!comp)                         status = 'CANCELLED';
      else if (comp.ack === 'SUCCESS')   status = 'SUCCESS';
      else if (comp.ack === 'FAILURE')   status = 'FAILURE';
      else                               status = 'CANCELLED';
      const startMs = new Date(p.started?.time ?? p.generationTime).getTime();
      const endMs   = comp?.time ? new Date(comp.time).getTime() : startMs + 60_000;
      return {
        name: p.name.split('.').pop(),
        status,
        time: new Date(p.generationTime).getTime(),
        startMs,
        endMs,
      };
    });

    // Build pass list, correlating procedures by generationTime falling within [aos0, los0]
    const passes = eventsData
      .filter(e => e.category === 'SATELLITE_PASS')
      .map(e => {
        const passStart = new Date(e.pass?.aos0 ?? e.start);
        const passEnd   = new Date(e.pass?.los0 ?? e.end);
        const isFuture  = passStart > now;

        const procs = isFuture ? [] : allProcs
          .filter(p => p.time >= passStart.getTime() && p.time <= passEnd.getTime())
          .sort((a, b) => a.startMs - b.startMs);

        const rawP = e.pass ?? {};
        return {
          id:         e.id,
          start:      passStart,
          end:        passEnd,
          aos5:       rawP.aos5 ? new Date(rawP.aos5) : null,
          los5:       rawP.los5 ? new Date(rawP.los5) : null,
          station:    rawP.groundStationId ?? e.content ?? '—',
          network:    rawP.network ?? null,
          gsRemoteId: rawP.remoteId ?? null,   // antenna ID for mask endpoint
          future:     isFuture,
          outcome:    isFuture ? null : _passOutcome(procs),
          procedures: procs,
        };
      })
      .sort((a, b) => a.start - b.start);

    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
    store.setSatPasses(sat.id, passes);
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
