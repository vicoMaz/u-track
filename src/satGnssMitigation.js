// Tracks how often the GNSS_MITIGATION procedure actually detects+fixes an
// abnormal GNSS configuration, vs. running as a silent health-check. Every
// occurrence that applies a fix logs this exact line to Grafana/Loki (on the
// same {service_name="/scc"} stream src/ui/procedureReport.js already
// queries) — most runs are silent, so this is the only signal available;
// procedure-history's own status field doesn't distinguish "ran clean" from
// "ran and fixed something" (only SUCCESS/FAILURE/CANCELLED).
import { store } from './store.js';
import { satSubsystemHost } from './satSubsystems.js';

const MATCH_QUERY = '{service_name="/scc"} |= "GNSS seems to be in an abnormal configuration"';

// Grafana's query_range hard-caps the queryable window at 30 days (verified
// live: a 90-day request errored with "the query time range exceeds the
// limit ... limit: 30d1h") — this is the largest single window obtainable in
// one query.
export const MITIGATION_WINDOW_DAYS = 30;
const WINDOW_MS = MITIGATION_WINDOW_DAYS * 86_400_000;

// >15x the worst case observed live across three real satellites (12/30d) —
// plenty of headroom before `saturated` below would ever actually trip.
const MAX_HITS = 200;

// Copied from procedureReport.js's _queryLoki rather than imported — kept as
// its own small copy, matching how satPasses.js/satGroundEvents.js each keep
// their own _ctrl Map rather than sharing one between unrelated fetch modules.
async function _queryLoki(grafanaHost, logql, startMs, endMs, limit) {
  const params = new URLSearchParams({
    host:  grafanaHost,
    query: logql,
    start: String(Math.round(startMs * 1e6)),
    end:   String(Math.round(endMs * 1e6)),
    limit: String(limit),
  });
  try {
    const res = await fetch(`/api/grafana-loki?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const lines = [];
    for (const stream of data?.data?.result ?? []) {
      for (const [ts, text] of stream.values) lines.push({ ts: Number(ts), text });
    }
    lines.sort((a, b) => a.ts - b.ts);
    return lines;
  } catch { return null; }
}

// Pure — no network. `hits` must already be ts-sorted ascending (guaranteed
// by _queryLoki above). Exported for testing without a live Grafana connection.
export function deriveGnssMitigationState(hits, windowStartMs) {
  return {
    count30d:  hits.length,
    lastMs:    hits.length ? hits[hits.length - 1].ts / 1e6 : null,
    windowStartMs,
    // If ever true, count/lastMs are both understated (there were more hits
    // than MAX_HITS could return) — not expected given the >15x headroom above.
    saturated: hits.length === MAX_HITS,
  };
}

const _ctrl = new Map(); // satId → AbortController — see satGroundEvents.js's _ctrl for the same rationale

export async function fetchSatGnssMitigation(sat) {
  const grafanaHost = satSubsystemHost(sat.noradId, 'sccRo');
  if (!grafanaHost) return;

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const end   = Date.now();
    const start = end - WINDOW_MS;
    const hits  = await _queryLoki(grafanaHost, MATCH_QUERY, start, end, MAX_HITS);
    if (ctrl.signal.aborted || hits === null) return; // superseded, timed out, or request failed — keep showing the last resolved value
    store.setSatGnssMitigation(sat.id, deriveGnssMitigationState(hits, start));
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
