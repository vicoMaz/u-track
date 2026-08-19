// Alert Analyzer tab's own data source — same GET /api/v1/events endpoint
// satGroundEvents.js already reads (sccRo, read-only — a pure read with no
// follow-up write, same reasoning as there), just kept as the RAW per-event
// list (id/category/criticality/start/content) instead of collapsed into
// 24h counts, and over a much wider window: this tab is for browsing
// history, not a live fleet-table glance.
import { satSubsystemOrigin } from './satSubsystems.js';

const LOOKBACK_MS = 7 * 24 * 3_600_000; // 7 days
const MAX_EVENTS  = 500;

// Ground (SCC parameter-threshold alarms) and Board (spacecraft-raised)
// criticality strings turned out to overlap almost completely — confirmed
// live against a real satellite's raw event data: both use NOMINAL/WATCH/
// WARNING/DISTRESS, they only differ on the TOP tier's own word (Ground:
// CRITICAL, Board: SEVERE — same rank, different label). One shared table
// covers both, no need to branch on source at all. NOMINAL folds into tier 1
// alongside WATCH — board occasionally reports a flagged on-board event as
// NOMINAL (presumably "raised, but not actually a problem"), Ground hasn't
// been observed emitting it as an alert at all, so either way it belongs in
// the mildest bucket. Falls back to tier 1 for anything unrecognized, rather
// than silently dropping the alert.
const _CRITICALITY_TIER = { NOMINAL: 1, WATCH: 1, WARNING: 2, DISTRESS: 3, CRITICAL: 4, SEVERE: 4 };

function _severityTier(rawCriticality) {
  return _CRITICALITY_TIER[rawCriticality?.toUpperCase() ?? ''] ?? 1;
}

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

// Returns null on any failure (no SCC-RO configured, network error, timeout)
// — callers should treat that as "unknown/unreachable", not "zero alerts".
export async function fetchSatAlerts(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;

  const now   = new Date();
  const start = new Date(now.getTime() - LOOKBACK_MS);
  const url = `${origin}/api/v1/events`
    + `?start=${encodeURIComponent(start.toISOString())}`
    + `&end=${encodeURIComponent(now.toISOString())}`
    + `&maxLimit=${MAX_EVENTS}`
    + `&onBoardEventsTime=onBoardTime`
    + `&groundEventsTime=receptionTime`;

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const events = await res.json();
    if (ctrl.signal.aborted) return null; // superseded or timed out
    // GROUND (SCC parameter-threshold alarms) and ON_BOARD (spacecraft-
    // raised) only — this same endpoint also returns SATELLITE_PASS entries
    // (satPasses.js's own concern), which aren't alerts.
    return events
      .filter(e => e.category === 'GROUND' || e.category === 'ON_BOARD')
      .map(e => ({
        id:          e.id,
        source:      e.category,                    // 'GROUND' | 'ON_BOARD'
        severity:    _severityTier(e.criticality),   // 1-4, normalized across both vocabularies — see _severityTier above
        rawSeverity: e.criticality ?? '',             // original SCC tag (e.g. "WATCH" or "SEVERE") — kept for the pill's own tooltip
        start:       new Date(e.start),
        message:     e.content ?? '',
        // The specific thing that fired — confirmed live: for GROUND this is
        // the monitoring rule/parameter identifier (e.g.
        // "GNC_AM_M2_RTE_RW_4_IT_WRN_UNAVL"), which `content` never actually
        // names; for ON_BOARD it's the EXACT source TM_5_* packet name (e.g.
        // "TM_5_4_OBSW_EVT_LIFE_STT"), letting satBoardEventTm.js query it
        // directly instead of guessing by nearby timestamp + description.
        eventName:   e.name ?? '',
      }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
