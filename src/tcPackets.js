// TC packet fetch + PUS(11,4) "insert time-tagged command" parsing — shared
// between PassAnalyzer.js's own TC list and Scheduler.js's Timetag gantt row
// (both need the same "what got scheduled, into which SSID, for when"
// extraction against the same live data). Originally lived only in
// PassAnalyzer.js; factored out here once a second consumer needed it, so
// the two can't drift apart on what's genuinely a shared parsing problem,
// not two independent ones.
//
// The TC list comes from SCC's own /api/v1/tc-packets endpoint — confirmed
// live to exist on sccRo (172.17.208.5:15500), same read-only mirror every
// other per-pass fetch in this app already uses. It's a real, structured
// ledger (id, generation/reception time, the decoded packet name+description)
// rather than something scraped from logs — but confirmed live it's also
// genuinely slow at volume: it echoes each packet's FULL field/container
// schema, not just its value, so one real 14-minute pass (392 packets) came
// back as a 10MB response in ~2.6s. Kept to a modest maxLimit here for that
// reason — see TC_MAX_LIMIT below.
import { satSubsystemOrigin } from './satSubsystems.js';

export const TC_MAX_LIMIT = 1000; // a typical pass sends under 1000 TC packets — confirmed live a busy 14-min pass hit 392 (10MB, ~2.6s); the 20s abort timeout below is the backstop for whatever pass exceeds that

// TC_11_4 schedules another TC packet for later execution — it carries that
// target TC's name, a date, and a sub-schedule id (SSID) as arguments (each
// TC_11_4 wraps exactly one target). Confirmed live against real packets
// (2026-07-29, sccRo): OBSW_AR_S11_SUBSCHEDULE_ID (int, the SSID) and
// OBSW_AR_S11_ABS_TIME_TAG (ISO string, the scheduled execution time) — see
// _extract114Args' matcher lists below, chosen to match both those exact
// names and plausible variants, via a full recursive walk (_deepFindArg)
// rather than a hardcoded path, since the exact container nesting isn't
// documented anywhere this app has access to.
// Real names carry a descriptive suffix (e.g. "TC_11_4_OBSW_INSERT_TC"), not
// just the bare "TC_11_4" — and \b is no help distinguishing "TC_11_4_..."
// from "TC_11_129_..." since _ is a word character, not a boundary. Anchored
// at the start; the minor number "4" must be followed by "_" or end-of-string
// specifically, so it doesn't also match TC_11_40, TC_11_129, etc.
export const TC_114_NAME_RE = /^TC_11_4(?:_|$)/;

// Confirmed live: this TC never gets an acceptance report back, by SCC/OBSW
// design (not a real ack-chain gap) — excluded from the TC "unacked" pass-
// health dot (PassAnalyzer.js's .pa-details DATA row) so it doesn't trip the
// orange warning on every pass that happens to send one.
export const TC_UNACKED_EXCLUDE = new Set(['TC_179_7_SBT_SET_MODULATION_MODE']);

// A handful of guessed field PATHS (rootContainer.entries, etc.) never
// matched anything against real data — rather than guess a 4th or 5th exact
// path, this walks the ENTIRE raw packet looking for any {name, value}-shaped
// object whose name matches, regardless of how deep it's nested or what its
// parent containers are called. Skips the packet's own top-level id/
// generationTime/receptionTime so the packet's own timestamp is never
// mistaken for the scheduled-execution-date argument.
const _TOP_LEVEL_SKIP = new Set(['id', 'generationTime', 'receptionTime']);

function _deepFindArg(obj, matchers, isRoot, seen) {
  if (obj == null || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = _deepFindArg(item, matchers, false, seen);
      if (found != null) return found;
    }
    return null;
  }
  const name = typeof obj.name === 'string' ? obj.name : (typeof obj.parameter?.name === 'string' ? obj.parameter.name : null);
  if (name && matchers.some(m => name.toLowerCase().includes(m))) {
    const v = obj.value?.value ?? obj.engValue?.value ?? obj.rawValue?.value ?? (typeof obj.value !== 'object' ? obj.value : null);
    if (v != null && typeof v !== 'object') return v;
  }
  for (const key of Object.keys(obj)) {
    if (isRoot && _TOP_LEVEL_SKIP.has(key)) continue;
    const found = _deepFindArg(obj[key], matchers, false, seen);
    if (found != null) return found;
  }
  return null;
}

export function extract114Args(raw) {
  const ssid = _deepFindArg(raw, ['ssid', 'subschedule', 'sub_schedule', 'sub-schedule'], true, new Set());
  const date = _deepFindArg(raw, ['scheduledate', 'scheduletime', 'schedule_date', 'schedule_time',
    'executiondate', 'executiontime', 'execution_date', 'execution_time', 'targetdate', 'targettime'], true, new Set())
    ?? _deepFindArg(raw, ['date', 'time'], true, new Set());
  return (ssid != null || date != null) ? { ssid, date } : null;
}

export async function fetchTcPackets(sat, startMs, endMs) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;
  const params = new URLSearchParams({
    start: new Date(startMs).toISOString(),
    end:   new Date(endMs).toISOString(),
    maxLimit: String(TC_MAX_LIMIT),
  });
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${origin}/api/v1/tc-packets?${params}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    // Mapped down to the lightweight fields the LIST rendering needs — each
    // packet also echoes its full parameter/container schema (rootContainer),
    // tens of KB per packet, that a plain "what got sent" list has no use
    // for. `raw` keeps a REFERENCE to the untouched original (no extra copy —
    // it's already sitting in memory from this same res.json() call) so a
    // click on a row can walk its rootContainer for the full argument
    // breakdown on demand, without a second fetch.
    return data
      .map(p => {
        const name = p.spacePacket?.name ?? '—';
        return {
          id:             p.id,
          generationTime: p.generationTime ? new Date(p.generationTime).getTime() : null,
          receptionTime:  p.receptionTime  ? new Date(p.receptionTime).getTime()  : null,
          name,
          description:    p.spacePacket?.description ?? '',
          args114:        TC_114_NAME_RE.test(name) ? extract114Args(p) : null,
          // PUS TC verification chain the SCC already attaches to each
          // packet: acceptance is the onboard software's accept/reject of
          // the command (~ "reception"), started/progress/completed are its
          // execution report chain. Each is null (not SUCCESS/FAILURE) when
          // that report never came — a lot of TCs only ever get an
          // acceptance report, or none at all.
          acks: {
            acceptance: p.acceptance ?? null,
            started:    p.started    ?? null,
            progress:   p.progress   ?? null,
            completed:  p.completed  ?? null,
          },
          raw:            p,
        };
      })
      .sort((a, b) => (a.generationTime ?? 0) - (b.generationTime ?? 0));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// TC_11_4's target isn't parsed from an argument — it's found by matching
// timestamps: SCC generates the TC_11_4 "envelope" and the TC it schedules
// as sibling packets around the same moment. An exact-millisecond match
// turned out too strict against real data — this instead takes the CLOSEST
// other packet within MATCH_TOLERANCE_MS, so a few ms (or more) of real
// processing/logging jitter between the two doesn't break the match. Each
// target is claimed by at most one TC_11_4.
const MATCH_TOLERANCE_MS = 3000;

export function matchScheduledTargets(packets) {
  const used = new Set();
  const targetFor = new Map(); // TC_11_4 packet id -> its target packet
  for (const p of packets) {
    if (!TC_114_NAME_RE.test(p.name) || p.generationTime == null) continue;
    let best = null, bestDelta = Infinity;
    for (const o of packets) {
      if (o === p || used.has(o.id) || TC_114_NAME_RE.test(o.name) || o.generationTime == null) continue;
      const delta = Math.abs(o.generationTime - p.generationTime);
      if (delta < bestDelta) { bestDelta = delta; best = o; }
    }
    if (best && bestDelta <= MATCH_TOLERANCE_MS) { used.add(best.id); targetFor.set(p.id, best); }
  }
  return { targetFor, consumedIds: used };
}

// Recursively walks a packet's decoded field tree (see extract114Args'
// comment above for why this is a full walk rather than a few guessed
// paths) collecting every leaf the SCC itself flagged argument:true — i.e.
// an actual value the ground supplied, not a fixed CCSDS/PUS header field.
// Confirmed live against real packets: leaves look like { name, description,
// physicalValue:{value}, rawValue:{value}, unit }.
export function collectArguments(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.subContainers) && node.subContainers.length) {
    for (const child of node.subContainers) collectArguments(child, out);
    return;
  }
  if (node.argument === true) {
    const value = node.physicalValue?.value ?? node.rawValue?.value ?? null;
    // Confirmed live: TC_11_4's own GENE_AR_TCPACKET field is a real
    // argument:true leaf that's genuinely always empty (value AND
    // description both null — an embedded-packet reference this endpoint
    // doesn't expand) — carries zero information, so skip it rather than
    // show a blank row. Anything with an actual value (including falsy
    // ones like 0 or an empty string) or at least a description still shows.
    if (value == null && !node.description) return;
    out.push({ name: node.name, description: node.description, value, unit: node.unit });
  }
}

// A leaf's own `unit` field (see collectArguments above) is NOT always the
// plain string every caller originally assumed — confirmed live: a plain
// enum/int/boolean argument carries unit:null, but one with a real physical
// unit (e.g. TC_200_6_UPLOAD_ORBIT_BULLETIN's position/velocity/time args)
// carries a full descriptor object instead — {unit:'m', description:'m',
// power:1, factor:1} — not a bare "m". Passing that object straight into a
// template string silently renders "[object Object]"; passing it into an
// escapeHtml(s) that calls s.replace(...) THROWS instead (s.replace is not a
// function), which is what broke PassAnalyzer.js's own args and, worse,
// silently killed Scheduler.js's whole Timetag tooltip (the thrown error
// aborted the tooltip's build before .innerHTML was ever assigned). This
// unwraps either shape down to the short label a UI actually wants to show.
export function argUnitLabel(unit) {
  if (unit == null) return null;
  return typeof unit === 'string' ? unit : (unit.unit ?? null);
}

// Collapses the 4-stage PUS TC verification chain (acceptance/started/
// progress/completed — see fetchTcPackets' own acks comment) into ONE
// status:
//   'pending'   — sent, no report back yet at all
//   'accepted'  — accepted; execution outcome not in yet
//   'exec-ok'   — execution completed successfully
//   'reject'    — REJECTED at acceptance — never got to execute
//   'exec-fail' — accepted, but execution failed
// Ordered so a FAILURE anywhere wins over a SUCCESS anywhere (a completed
// report can't undo a rejection that came before it), and acceptance
// FAILURE is distinguished from an execution FAILURE ('reject' vs
// 'exec-fail'), since "never ran" and "ran and failed" are different
// problems to chase. Originally private to PassAnalyzer.js's own TC list;
// moved here once Scheduler.js's Timetag row needed the same "is this
// TC_11_4 actually confirmed to have landed onboard" check and, confirmed
// live (LEONAV-1, PT01-02, 2026-07-30), checking acceptance alone wasn't
// enough — an insert can be ACCEPTED (envelope well-formed) and still fail
// during EXECUTION (e.g. an invalid time tag rejected only once OBSW
// actually tries the insert), which only ever shows up in started/progress/
// completed, never in acceptance itself.
export function tcAckStatus(acks) {
  if (!acks) return null;
  const { acceptance, started, progress, completed } = acks;
  if (acceptance?.ack === 'FAILURE') return 'reject';
  if ([started, progress, completed].some(a => a?.ack === 'FAILURE')) return 'exec-fail';
  if (completed?.ack === 'SUCCESS') return 'exec-ok';
  if (acceptance?.ack === 'SUCCESS') return 'accepted';
  return 'pending';
}
