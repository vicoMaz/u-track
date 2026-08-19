// Cross-references a board (ON_BOARD) alert with the exact PUS Service 5
// (Event Report) TM packet that raised it.
//
// Fast path: satAlerts.js's own `eventName` field IS the exact source packet
// name for a board alert — confirmed live (e.g. "TM_5_4_OBSW_EVT_LIFE_STT")
// — so this can just ask /api/v1/tm-packets for it directly via `filter`.
//
// Fallback (older cached alert missing eventName, or an unexpected API
// shape): pulls EVERYTHING in a tight window around the alert's own
// onBoardTime instead — /api/v1/tm-packets needs either an EXACT name in
// `filter` or none at all; a broad prefix like "TM_5" returns an empty
// array, and no filter at all returns the satellite's entire packet history
// (confirmed live: 100+MB for one hour) — then keeps only TM_5_* candidates
// and matches by description text (SCC's own /api/v1/events `content` for a
// board alert is that same packet's own spacePacket.description verbatim),
// falling back further to "closest onBoardTime" if the wording doesn't
// match exactly.
import { satSubsystemOrigin } from './satSubsystems.js';

// ±5s margin around the alert's own onBoardTime — confirmed live the
// matching packet's own onBoardTime can land at the exact same millisecond,
// this just covers minor jitter without pulling in an unrelated event from
// the same busy window.
const MATCH_WINDOW_MS = 5_000;

// Keyed by alert.id (unique per SCC event) — a repeat alert's own several
// occurrences each get their own real packet, so this must NOT be keyed by
// the group's shared source+eventName the way AlertAnalyzer.js's own
// _groupAlerts key works.
const _cache = new Map(); // alert.id → Promise<summary|null>

function _packetSummary(p) {
  return {
    name:          p.spacePacket?.name ?? '',
    description:   p.spacePacket?.description ?? '',
    onBoardTime:   p.onBoardTime   ? new Date(p.onBoardTime)   : null,
    receptionTime: p.receptionTime ? new Date(p.receptionTime) : null,
  };
}

async function _queryWindow(origin, alert, filter, signal) {
  const start = new Date(alert.start.getTime() - MATCH_WINDOW_MS);
  const end   = new Date(alert.start.getTime() + MATCH_WINDOW_MS);
  const url = `${origin}/api/v1/tm-packets`
    + `?start=${encodeURIComponent(start.toISOString())}`
    + `&end=${encodeURIComponent(end.toISOString())}`
    + `&orderBy=onBoardTime`
    + (filter ? `&filter=${encodeURIComponent(filter)}` : '');
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return res.json();
}

async function _fetch(sat, alert) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc'); // same origin ebn0.js's own _fetchSccParam uses for /api/v1/parameters — confirmed live this endpoint answers on 'scc' (port 15000), not 'sccRo' (port 15500 didn't respond at all)
  if (!origin) return null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    if (alert.eventName?.startsWith('TM_5_')) {
      const exact = await _queryWindow(origin, alert, alert.eventName, ctrl.signal);
      if (exact?.length) return _packetSummary(exact[0]);
      // Named packet not found in the window — fall through to the broader
      // search below rather than giving up (e.g. onboard/reception timing
      // drifted further than MATCH_WINDOW_MS this once).
    }
    const packets = await _queryWindow(origin, alert, null, ctrl.signal);
    const candidates = Array.isArray(packets) ? packets.filter(p => p.spacePacket?.name?.startsWith('TM_5_')) : [];
    if (!candidates.length) return null;
    const exact = candidates.find(p => p.spacePacket?.description === alert.message);
    if (exact) return _packetSummary(exact);
    const alertMs = alert.start.getTime();
    const closest = candidates.reduce((best, p) => {
      const t     = p.onBoardTime ? new Date(p.onBoardTime).getTime() : Infinity;
      const bestT = best?.onBoardTime ? new Date(best.onBoardTime).getTime() : Infinity;
      return Math.abs(t - alertMs) < Math.abs(bestT - alertMs) ? p : best;
    }, null);
    return closest ? _packetSummary(closest) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns null if no TM_5_* packet was found (unreachable, genuinely
// nothing there, or a match outside ±MATCH_WINDOW_MS of both attempts).
export function fetchBoardEventPacket(sat, alert) {
  if (_cache.has(alert.id)) return _cache.get(alert.id);
  const promise = _fetch(sat, alert);
  _cache.set(alert.id, promise);
  return promise;
}
