// Requests a PUS-15 downlink-between-instants procedure on SCC to backfill a TMR
// gap, scheduled against the soonest upcoming pass. Mirrors the reference
// `schedule_procedure`/`get_passes` Python script: same SCC box, but port 15000
// (not FDS's 15500) for both the pass-events lookup and the procedure POST.
import { satSubsystemOrigin } from './satSubsystems.js';

// Template supplied by ops — only the three Instant fields below are ever
// overwritten (scheduleTime / downlinkStartTime / downlinkEndTime). Everything
// else (packetToDownlinkFrom: HKTM, doSchedule: false, etc.) is left exactly as given.
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

function _buildPayload(gapStart, gapEnd, requestedAt) {
  const payload = JSON.parse(JSON.stringify(PROCEDURE_TEMPLATE));
  const set = (name, value) => { payload.procedureParameters.find(p => p.name === name).value = value; };
  set('scheduleTime', _isoNanos(requestedAt));
  set('downlinkStartTime', _isoNanos(gapStart));
  set('downlinkEndTime', _isoNanos(gapEnd));
  return payload;
}

// Finds the soonest upcoming SATELLITE_PASS event from SCC's own /api/v1/events —
// deliberately NOT the FDS-sourced store.satPasses list, since procedure-scheduler
// expects an event id from SCC's own id space.
async function _nextSccPassId(origin, signal) {
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
  return passes[0].id;
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
// (a pass with nothing on it hasn't had its link established). Throws on failure —
// callers should catch and surface the message (no swallowed/silent failures here,
// since this is a real operational request, not a background poll).
export async function requestTmrGapDownload(sat, gap) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) throw new Error('SCC not configured for this satellite');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const eventId  = await _nextSccPassId(origin, ctrl.signal);
    const existing = await _listScheduledProcedures(origin, eventId, ctrl.signal);

    let linkEstablished = false;
    if (!existing.length) {
      await _scheduleProcedure(origin, eventId, TMTC_LINK_TEMPLATE, ctrl.signal);
      linkEstablished = true;
    }

    const gapStart = gap.start instanceof Date ? gap.start : new Date(gap.start);
    const gapEnd   = gap.end   instanceof Date ? gap.end   : new Date(gap.end);
    const payload  = _buildPayload(gapStart, gapEnd, new Date());
    await _scheduleProcedure(origin, eventId, payload, ctrl.signal);

    return { eventId, linkEstablished };
  } finally {
    clearTimeout(timer);
  }
}
