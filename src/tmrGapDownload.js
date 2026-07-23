// Requests a PUS-15 downlink-between-instants procedure on SCC to backfill a TMR
// gap, scheduled against the soonest upcoming pass. Mirrors the reference
// `schedule_procedure`/`get_passes` Python script: same SCC box, but port 15000
// (not FDS's 15500) for both the pass-events lookup and the procedure POST.
import { satSubsystemOrigin } from './satSubsystems.js';

// Template supplied by ops. scheduleTime / downlinkStartTime / downlinkEndTime
// are always overwritten per-request; packetToDownlinkFrom is now also
// overwritten — see PACKET_STORES below — everything else (doSchedule: false,
// etc.) is left exactly as given.
const PROCEDURE_TEMPLATE = {
  procedureName: 'procedures.elem.U_SPACE_FSW_CONTROL.PUS_15_TM_STORAGE_AND_RETRIEVAL.ELEM_FSW_DOWNLINK_BETWEEN_INSTANTS_VIA_PUS_15',
  procedureDescription: '',
  scheduled: false,
  activityId: '',
  procedureParameters: [
    { name: 'doSchedule', type: 'java.lang.Boolean', subType: null, valueType: 'Boolean', subValueType: null, value: false, enumValues: null, elementParameter: null },
    { name: 'scheduleTime', type: 'java.time.Instant', subType: null, valueType: 'AbsoluteTime', subValueType: null, value: null, enumValues: null, elementParameter: null },
    { name: 'subscheduleId', type: 'java.lang.Long', subType: null, valueType: 'Long', subValueType: null, value: 0, enumValues: null, elementParameter: null },
    { name: 'packetToDownlinkFrom', type: 'fr.cnes.scc.procedure.generator.internalclasses.enumerated.OBSW_AR_S15_STORE_ID_Enum', subType: null, valueType: 'Enum', subValueType: null, value: 'HKTM', enumValues: ['CRIT_EVT', 'EVT', 'HKTM', 'DIAG', 'ASYNC', 'FDTM'], elementParameter: null },
    { name: 'downlinkStartTime', type: 'java.time.Instant', subType: null, valueType: 'AbsoluteTime', subValueType: null, value: null, enumValues: null, elementParameter: null },
    { name: 'downlinkEndTime', type: 'java.time.Instant', subType: null, valueType: 'AbsoluteTime', subValueType: null, value: null, enumValues: null, elementParameter: null },
  ],
};

// Prerequisite: if a pass has zero procedures scheduled on it yet, the TM/TC link
// itself hasn't been set up — schedule this first, unmodified, before the actual
// gap-download procedure.
const TMTC_LINK_TEMPLATE = {
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

// Requested for every TMR gap download — HKTM was originally the only store
// requested; ops asked for ASYNC/EVT/CRIT_EVT downlinked too, so one gap
// download now schedules FOUR separate downlink-between-instants requests
// (same gap window each time, one per store). DIAG and FDTM — also valid
// per the template's own packetToDownlinkFrom enumValues — are deliberately
// NOT requested here.
const PACKET_STORES = ['HKTM', 'ASYNC', 'EVT', 'CRIT_EVT'];

function _buildPayload(gapStart, gapEnd, requestedAt, packetStore) {
  const payload = JSON.parse(JSON.stringify(PROCEDURE_TEMPLATE));
  const set = (name, value) => { payload.procedureParameters.find(p => p.name === name).value = value; };
  set('scheduleTime', _isoNanos(requestedAt));
  set('downlinkStartTime', _isoNanos(gapStart));
  set('downlinkEndTime', _isoNanos(gapEnd));
  set('packetToDownlinkFrom', packetStore);
  return payload;
}

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

// Requests a TMR gap downlink for every store in PACKET_STORES, scheduled on
// the next pass. If that pass has no procedures scheduled on it yet, the
// TM/TC link procedure is scheduled first (a pass with nothing on it hasn't
// had its link established). Sequential, not parallel — same style as the
// link-establish step before it, and avoids firing 4 near-simultaneous
// writes at the procedure-scheduler endpoint. Throws on the first failure
// (with which store failed in the message) rather than trying the rest —
// callers should catch and surface the message (no swallowed/silent
// failures here, since this is a real operational request, not a
// background poll).
export async function requestTmrGapDownload(sat, gap) {
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

    const gapStart    = gap.start instanceof Date ? gap.start : new Date(gap.start);
    const gapEnd      = gap.end   instanceof Date ? gap.end   : new Date(gap.end);
    const requestedAt = new Date();

    for (const store of PACKET_STORES) {
      const payload = _buildPayload(gapStart, gapEnd, requestedAt, store);
      try {
        await _scheduleProcedure(origin, pass.id, payload, ctrl.signal);
      } catch (err) {
        throw new Error(`${store} downlink request failed: ${err.message}`);
      }
    }

    return { eventId: pass.id, linkEstablished, pass, stores: PACKET_STORES };
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

// Pure — no network. Finds a scheduled PUS-15 downlink procedure (from
// `scheduled`, as returned by fetchNextPassProcedures below) whose
// downlinkStartTime/downlinkEndTime both fall within ±15 min of this gap's own
// bounds. Returns the matching procedure entry, or null.
//
// NOTE: GET /api/v1/procedure-scheduler's response shape does NOT mirror the
// POST payload's field names — confirmed live against a real scheduled
// request: the procedure name comes back as `.name` (not `.procedureName`)
// and its parameter list as `.parameters` (not `.procedureParameters`). Only
// each individual parameter entry's own shape ({name, value, ...}) matches.
export function findMatchingGapProcedure(scheduled, gap) {
  if (!scheduled?.length) return null;
  const gapStart = (gap.start instanceof Date ? gap.start : new Date(gap.start)).getTime();
  const gapEnd   = (gap.end   instanceof Date ? gap.end   : new Date(gap.end)).getTime();
  return scheduled.find(proc => {
    if (proc.name !== PROCEDURE_TEMPLATE.procedureName) return false;
    const dlStart = Date.parse(_paramValue(proc.parameters, 'downlinkStartTime'));
    const dlEnd   = Date.parse(_paramValue(proc.parameters, 'downlinkEndTime'));
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
