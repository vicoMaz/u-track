// Requests a PUS-15 downlink-between-instants procedure on SCC to backfill a TMR
// gap, scheduled against the soonest upcoming pass. Mirrors the reference
// `schedule_procedure`/`get_passes` Python script: same SCC box, but port 15000
// (not FDS's 15500) for both the pass-events lookup and the procedure POST.
import { satSubsystemOrigin } from './satSubsystems.js';

// BUS and PAY each get ONE call to their own dedicated "download this packet
// store" procedure — not one call per individual packet store (that's the
// older ELEM_FSW_DOWNLINK_BETWEEN_INSTANTS_VIA_PUS_15 approach this replaces
// for BUS, which needed 4 separate calls via its packetToDownlinkFrom enum).
// Confirmed live against a real scheduled instance on SCC (procedure-
// scheduler's GET, which echoes back exactly what was submitted): both
// SUBSYS_FSW_*_DOWNLOAD_PACKET_STORE procedures share the identical 3-param
// shape below, differing only in which packet store they act on.
const DOWNLOAD_PROCEDURE_NAME = {
  bus: 'procedures.subsys.FSW.SUBSYS_FSW_ROUTINE_DOWNLOAD_PACKET_STORE',
  pay: 'procedures.subsys.FSW.SUBSYS_FSW_PAYLOAD_DOWNLOAD_PACKET_STORE',
};

function _downloadPacketStorePayload(procedureName, gapStart, gapEnd) {
  return {
    procedureName,
    procedureDescription: '',
    scheduled: false,
    activityId: '',
    procedureParameters: [
      { name: 'tMinDumpTmR_obt', type: 'java.time.Instant', subType: null, valueType: 'AbsoluteTime', subValueType: null, value: _isoNanos(gapStart), enumValues: null, elementParameter: null },
      { name: 'tMaxDumpTmR_obt', type: 'java.time.Instant', subType: null, valueType: 'AbsoluteTime', subValueType: null, value: _isoNanos(gapEnd),   enumValues: null, elementParameter: null },
      // false: only pull the data down, never clear the onboard store — a
      // separate, deliberate operator action, not implied by a plain download.
      { name: 'clearAfterDownload', type: 'java.lang.Boolean', subType: null, valueType: 'Boolean', subValueType: null, value: false, enumValues: null, elementParameter: null },
    ],
  };
}

// Prerequisite: if a pass has zero procedures scheduled on it yet, the TM/TC link
// itself hasn't been set up — schedule this first, unmodified, before the actual
// gap-download procedure. Exported so Scheduler.js's own "Establish TMTC" shortcut
// (next to the procedure search bar) can schedule the identical procedure+params
// by hand, on demand, instead of only ever getting it as an implicit side effect
// of a gap-download request.
export const TMTC_LINK_TEMPLATE = {
  procedureName: 'procedures.ops.PASS.OPS_PASS_ESTABLISH_TMTC_LINK',
  procedureDescription: '',
  scheduled: false,
  activityId: '',
  procedureParameters: [
    { name: 'cop1FrameType', type: 'procedureUtils.systemEnum.groundEnum.Cop1FrameTypeEnum', subType: null, valueType: 'Enum', subValueType: null, value: 'AD', enumValues: ['AD', 'BD'], elementParameter: null },
  ],
};

// Events endpoint wants millisecond ISO (matches the reference script's format_iso);
// the procedure payload's java.time.Instant fields want 9-digit nanosecond ISO.
const _isoMillis = date => date.toISOString();
const _isoNanos  = date => date.toISOString().replace('Z', '000000Z');

// Finds the soonest upcoming SATELLITE_PASS event from SCC's own /api/v1/events —
// deliberately NOT the FDS-sourced store.satPasses list, since procedure-scheduler
// expects an event id from SCC's own id space. Returns the bits needed both to
// schedule against it (id) and to describe it in the UI (groundStationId, start).
async function _nextSccPass(origin, signal) {
  const now = new Date();
  const end = new Date(now.getTime() + 5 * 86400_000);
  const url = `${origin}/api/v1/events`
    + `?start=${encodeURIComponent(_isoMillis(now))}`
    + `&end=${encodeURIComponent(_isoMillis(end))}`
    + `&maxLimit=100`
    + `&onBoardEventsTime=onBoardTime`
    + `&groundEventsTime=onBoardTime`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`events query failed: HTTP ${res.status}`);
  const events = await res.json();
  // API returns newest-first; reverse to chronological order like the reference script does
  const passes = events.filter(e => e.category === 'SATELLITE_PASS').reverse();
  if (!passes.length) throw new Error('no upcoming pass found in the next 5 days');
  const p = passes[0];
  return {
    id: p.id,
    groundStationId: p.pass?.groundStationId ?? p.content ?? null,
    start: new Date(p.start),
  };
}

async function _listScheduledProcedures(origin, eventId, signal) {
  const res = await fetch(`${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}`, { signal });
  if (!res.ok) throw new Error(`procedure list query failed: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function _scheduleProcedure(origin, eventId, payload, signal) {
  const res = await fetch(`${origin}/api/v1/procedure-scheduler?id=${encodeURIComponent(eventId)}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
  }
}

// Requests a TMR gap downlink, scheduled on the next pass. If that pass has no
// procedures scheduled on it yet, the TM/TC link procedure is scheduled first
// (a pass with nothing on it hasn't had its link established). One call to
// the source's own DOWNLOAD_PROCEDURE_NAME — covers every packet store that
// source has in one shot, no per-store looping. Throws on failure — callers
// should catch and surface the message (no swallowed/silent failures here,
// since this is a real operational request, not a background poll).
export async function requestTmrGapDownload(sat, gap, source = 'bus') {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) throw new Error('SCC not configured for this satellite');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const pass     = await _nextSccPass(origin, ctrl.signal);
    const existing = await _listScheduledProcedures(origin, pass.id, ctrl.signal);

    let linkEstablished = false;
    if (!existing.length) {
      await _scheduleProcedure(origin, pass.id, TMTC_LINK_TEMPLATE, ctrl.signal);
      linkEstablished = true;
    }

    const gapStart = gap.start instanceof Date ? gap.start : new Date(gap.start);
    const gapEnd   = gap.end   instanceof Date ? gap.end   : new Date(gap.end);
    const procedureName = DOWNLOAD_PROCEDURE_NAME[source] ?? DOWNLOAD_PROCEDURE_NAME.bus;

    try {
      await _scheduleProcedure(origin, pass.id, _downloadPacketStorePayload(procedureName, gapStart, gapEnd), ctrl.signal);
    } catch (err) {
      throw new Error(`${source.toUpperCase()} downlink request failed: ${err.message}`);
    }

    return { eventId: pass.id, linkEstablished, pass };
  } finally {
    clearTimeout(timer);
  }
}

// ± tolerance when matching a scheduled procedure's downlink window against a
// gap's own bounds — an already-scheduled request's times won't be pixel-exact
// against the gap as currently computed (TMR data keeps arriving), so an exact
// match would almost never fire.
const MATCH_TOLERANCE_MS = 15 * 60 * 1000;

function _paramValue(parameters, name) {
  return parameters?.find(p => p.name === name)?.value ?? null;
}

// Pure — no network. Finds a scheduled downlink procedure (from `scheduled`,
// as returned by fetchNextPassProcedures below) matching this gap's source —
// its DOWNLOAD_PROCEDURE_NAME, with tMinDumpTmR_obt/tMaxDumpTmR_obt both
// falling within ±15 min of this gap's own bounds. Returns the matching
// procedure entry, or null.
//
// NOTE: GET /api/v1/procedure-scheduler's response shape does NOT mirror the
// POST payload's field names — confirmed live against a real scheduled
// request: the procedure name comes back as `.name` (not `.procedureName`)
// and its parameter list as `.parameters` (not `.procedureParameters`). Only
// each individual parameter entry's own shape ({name, value, ...}) matches.
export function findMatchingGapProcedure(scheduled, gap, source = 'bus') {
  if (!scheduled?.length) return null;
  const gapStart = (gap.start instanceof Date ? gap.start : new Date(gap.start)).getTime();
  const gapEnd   = (gap.end   instanceof Date ? gap.end   : new Date(gap.end)).getTime();
  const procName = DOWNLOAD_PROCEDURE_NAME[source] ?? DOWNLOAD_PROCEDURE_NAME.bus;
  return scheduled.find(proc => {
    if (proc.name !== procName) return false;
    const dlStart = Date.parse(_paramValue(proc.parameters, 'tMinDumpTmR_obt'));
    const dlEnd   = Date.parse(_paramValue(proc.parameters, 'tMaxDumpTmR_obt'));
    if (!Number.isFinite(dlStart) || !Number.isFinite(dlEnd)) return false;
    return Math.abs(dlStart - gapStart) <= MATCH_TOLERANCE_MS
        && Math.abs(dlEnd   - gapEnd)   <= MATCH_TOLERANCE_MS;
  }) ?? null;
}

// Fetches the next pass + whatever's already scheduled on it, ONCE per
// satellite — callers check as many gaps as they like against the same result
// via findMatchingGapProcedure (all of a satellite's gaps share the same "next
// pass", so there's no need to repeat this network round-trip per gap).
// Returns null on any failure (no SCC configured, no upcoming pass, network
// error) — callers should treat null as "unknown", not "not requested", so a
// transient error doesn't wrongly revert a gap's pending state.
export async function fetchNextPassProcedures(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const pass      = await _nextSccPass(origin, ctrl.signal);
    const scheduled = await _listScheduledProcedures(origin, pass.id, ctrl.signal);
    return { pass, scheduled };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
