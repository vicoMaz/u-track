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
// rather than something scraped from logs.
//
// Three things about that endpoint shape everything below, all confirmed
// live (PANDORE, sccRo 172.17.203.5:15500, 2026-08-24):
//
//  1. It echoes each packet's FULL field/container schema, not just its
//     values — ~20KB for an ordinary TC, ~260KB for a TC_6_2 memory load.
//     One real pass (2188 packets) is ~440MB of JSON. The responses ARE
//     gzipped though (which every browser asks for and curl doesn't):
//     the same 1000-packet page is 176MB raw but 3.1MB on the wire, 2.3s.
//     So the wire cost is fine and the MEMORY cost is the real one — hence
//     _lightPacket below, which keeps the decoded arguments and drops the
//     schema echo they were extracted from: that same pass is 75MB retained
//     instead of 440MB, and it would be a tenth of that again but for the
//     memory blocks TC_6_2 legitimately carries as argument values.
//  2. When maxLimit caps the result it returns the NEWEST packets, not the
//     oldest. The panel's old "Showing first 1000" banner was, in fact,
//     showing the LAST 1000 of the pass.
//  3. There is no offset/continuation parameter to page with — its whole
//     query surface is start/end/filter/maxLimit (checked against the
//     server's own /api/v1/openapi.json). So more-than-one-page passes are
//     walked by TIME instead: re-query the same window with an earlier
//     `end` each round, the same way tmrData.js walks /api/v1/parameters.
//     `end` is inclusive, which the cursor step below relies on.
import { satSubsystemOrigin } from './satSubsystems.js';

// One request's cap. Big enough that an ordinary pass finishes in a single
// round trip, small enough that one page's JSON.parse is a ~180MB spike and
// not a ~440MB one.
export const TC_PAGE_LIMIT = 1000;

// Ceiling across ALL pages of one walk — a backstop against a stuck cursor
// or a genuinely absurd pass, not an expected limit. For scale: the densest
// real pass measured (PANDORE 2026-08-24T14:26, a memory-load burst that
// sent 1993 packets in 9 seconds) totalled 2188. A walk that hits this stops
// and marks its result `.partial` (see below).
export const TC_MAX_PACKETS = 20_000;

// passTooltip.js's hover dots only need "did ANY TC get acknowledged", never
// the list — one small newest-first page answers that, instead of walking a
// whole pass because a mouse crossed a dot. See fetchTcPacketsProbe.
export const TC_PROBE_LIMIT = 200;

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

// `${noradId}|${startMs}|${endMs}` → Promise<Array|null>. This was the only
// per-pass fetch helper in the codebase without one — every sibling has the
// same map (scheduledProcedures.js, ebn0.js, satBoardEventTm.js,
// procedureCatalog.js, passPolar.js) — and it is also by far the heaviest
// (see the file header): a single page load was observed pulling the SAME
// 503KB response twice because TimePlayer and Scheduler each asked for the
// same pass independently, and a dense pass is three orders of magnitude
// bigger than that.
//
// The promise is stored BEFORE it settles, so simultaneous callers — the four
// surfaces that request per-pass TC data, plus a mouse crossing several pass
// dots at once — share one walk instead of racing several.
//
// Bounded, unlike every sibling cache in the codebase, because unlike them a
// single entry here is BIG: the decoded arguments of one real memory-load
// pass (815 TC_6_2 packets, each carrying its ~97KB uploaded memory block as
// an argument value) come to ~75MB. A few passes' worth is a reasonable
// price for not re-walking them; every pass anyone has ever clicked is not.
// Insertion-ordered eviction (Map iteration order) — plain oldest-out, no
// recency tracking, since the access pattern is "the pass currently open,
// from four surfaces at once" rather than anything worth an LRU.
const _cache = new Map();
const _CACHE_MAX = 4;

// fetchTcPacketsProbe's own map, kept apart from _cache on purpose: its
// entries are deliberately INCOMPLETE (one newest-first page), and letting a
// hover's partial answer satisfy a later "give me the whole pass" call — or
// the reverse — would be a silent wrong answer in one direction and a wasted
// full walk in the other. Roomier because a probe entry is ~200 packets with
// no decoded arguments (see _lightPacket's withArgs) — kilobytes, not
// megabytes — and hovering dozens of pass dots in a row is the normal way to
// use the Fleet view.
const _probeCache = new Map();
const _PROBE_CACHE_MAX = 100;

function _remember(map, key, promise, max) {
  map.set(key, promise);
  while (map.size > max) map.delete(map.keys().next().value); // oldest first
}

// Only past passes are cached. A live pass is still accumulating packets, so a
// cached answer for it would freeze the TC list mid-pass.
const _cacheable = endMs => endMs < Date.now();

// Every TC packet of [startMs, endMs], across as many pages as that takes.
//
// `onPage` (optional) is called with the packets accumulated SO FAR after
// each page lands — the same array instance, sorted, that the promise
// eventually resolves to — so a caller can paint a long walk progressively
// instead of staring at a spinner until the last page. It does NOT fire for
// a caller that joined an already-in-flight or cached walk (there are no
// pages left to report); those still get the full result from the promise.
//
// The resolved array carries `.partial = true` if the walk stopped early —
// TC_MAX_PACKETS reached, a page failed mid-walk, or a cursor that couldn't
// advance — meaning "there is more of this pass that isn't in here". Absent
// (undefined) means the walk genuinely reached the start of the window.
export async function fetchTcPackets(sat, startMs, endMs, { onPage } = {}) {
  const key = `${sat.noradId}|${startMs}|${endMs}`;
  if (_cacheable(endMs) && _cache.has(key)) return _cache.get(key);
  // Dropped from the cache again if the walk didn't actually get the whole
  // pass. Caching is here to stop four surfaces re-pulling the same hundreds
  // of megabytes, not to pin an SCC hiccup for the life of the tab: a failed
  // (null) or short (.partial) walk would otherwise be replayed forever, and
  // re-opening the panel — the obvious thing to try — would change nothing.
  const promise = _fetchTcPacketsUncached(sat, startMs, endMs, onPage)
    .then(result => {
      if (result == null || result.partial) _cache.delete(key);
      return result;
    });
  if (_cacheable(endMs)) _remember(_cache, key, promise, _CACHE_MAX);
  return promise;
}

// The newest TC_PROBE_LIMIT packets of the window and nothing older — for
// callers that only need a yes/no about the pass (tcPacketsAcked) rather
// than its contents. Same shape as fetchTcPackets' result, always flagged
// `.partial` when it comes back full, since by construction it may well be.
export async function fetchTcPacketsProbe(sat, startMs, endMs) {
  const key = `${sat.noradId}|${startMs}|${endMs}`;
  if (_cacheable(endMs) && _probeCache.has(key)) return _probeCache.get(key);
  const promise = (async () => {
    const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
    if (!origin) return null;
    // withArgs:false — tcPacketsAcked reads names and acks, never arguments,
    // and decoding them is what makes a packet heavy. A probe's packets
    // therefore carry `args: []`; nothing but the dots may read this result.
    const page = await _fetchTcPage(origin, startMs, endMs, TC_PROBE_LIMIT, { withArgs: false });
    if (page == null) { _probeCache.delete(key); return null; } // same reason as fetchTcPackets': don't pin a failure
    page.sort(_byGenerationTime);
    if (page.length === TC_PROBE_LIMIT) page.partial = true;
    return page;
  })();
  if (_cacheable(endMs)) _remember(_probeCache, key, promise, _PROBE_CACHE_MAX);
  return promise;
}

const _byGenerationTime = (a, b) => (a.generationTime ?? 0) - (b.generationTime ?? 0);

// Walks the window newest-first, one TC_PAGE_LIMIT page at a time, stepping
// `end` back to the oldest packet each page returned (see the file header:
// no offset parameter exists, so time IS the cursor).
async function _fetchTcPacketsUncached(sat, startMs, endMs, onPage) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;

  const out  = [];
  const seen = new Set();
  let cursor  = endMs;
  let partial = false;

  while (cursor >= startMs) {
    const page = await _fetchTcPage(origin, startMs, cursor, TC_PAGE_LIMIT);
    if (page == null) {
      // A failed page with nothing behind it is indistinguishable from "SCC
      // unreachable" and reported as such (null). A failed page PART WAY
      // through a walk is different: the packets already in hand are real,
      // so they're kept and flagged as incomplete rather than thrown away.
      if (!out.length) return null;
      partial = true;
      break;
    }
    let fresh = 0;
    for (const p of page) {
      if (seen.has(p.id)) continue; // re-read across an inclusive page boundary — see the cursor step below
      seen.add(p.id);
      out.push(p);
      fresh++;
    }
    out.sort(_byGenerationTime);
    if (fresh && onPage) onPage(out);

    // Short page ⇒ maxLimit never bit ⇒ this page saw everything back to
    // `startMs`. The one cheap extra request happens when the true count is
    // an exact multiple of TC_PAGE_LIMIT: the next page comes back empty.
    if (page.length < TC_PAGE_LIMIT) break;
    if (out.length >= TC_MAX_PACKETS) { partial = true; break; }

    const times = page.map(p => p.generationTime).filter(t => t != null);
    if (!times.length) { partial = true; break; } // a full page with no usable timestamp — nothing to step the cursor by

    // `end` is inclusive, so the cursor lands ON the oldest packet seen
    // rather than one millisecond before it: packets sharing that exact
    // millisecond can be split across a page boundary (real bursts hit
    // ~250 TC/s, several per millisecond), and stepping past it would drop
    // whichever ones fell off the far side. The re-read is deduped by id
    // above. When a page brought nothing new at all, that same inclusivity
    // would spin forever — step strictly past it in that case instead.
    const next = fresh ? Math.min(...times) : Math.min(...times) - 1;
    // Only if it actually moves. `next === cursor` means a whole page came
    // from one millisecond and there may be more of it we can never reach
    // through this API — stop and say so rather than loop on it.
    if (next >= cursor) { partial = true; break; }
    cursor = next;
  }

  if (partial) out.partial = true;
  return out;
}

// One request. Returns the page's packets (newest-first, as the API sends
// them), or null if the request itself failed.
async function _fetchTcPage(origin, startMs, endMs, maxLimit, { withArgs = true } = {}) {
  const params = new URLSearchParams({
    start: new Date(startMs).toISOString(),
    end:   new Date(endMs).toISOString(),
    maxLimit: String(maxLimit),
  });
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${origin}/api/v1/tc-packets?${params}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data.map(p => _lightPacket(p, withArgs)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mapped down to the fields the UI actually reads, and — the point of this
// whole function — DROPPING the raw packet, whose echoed field/container
// schema is ~95% of its weight (file header). Everything that used to walk
// `raw` later is extracted here instead, while it's still in hand:
//   • `args`   — the decoded argument list (collectArguments), the only part
//                of rootContainer any caller ever wanted. Keeping it costs
//                ~34KB/packet against the ~200KB of keeping `raw`, and keeps
//                every consumer synchronous (a lazy per-row re-fetch would
//                have meant one request per row for the ~1000 TC_11_4
//                targets a memory-load pass schedules).
//   • `apid` / `sourceSeqCount` — PassAnalyzer's TM(1,8) failure-reason
//                lookup keys off these two.
function _lightPacket(p, withArgs = true) {
  const name = p.spacePacket?.name ?? '—';
  const args = [];
  if (withArgs) collectArguments(p.spacePacket?.rootContainer, args);
  return {
    id:             p.id,
    generationTime: p.generationTime ? new Date(p.generationTime).getTime() : null,
    receptionTime:  p.receptionTime  ? new Date(p.receptionTime).getTime()  : null,
    name,
    description:    p.spacePacket?.description ?? '',
    apid:           p.apid ?? null,
    sourceSeqCount: p.sourceSeqCount ?? null,
    args,
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
  };
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
  // Both sides split out ONCE rather than re-tested inside the inner loop.
  // This is O(envelopes × candidates) and a real pass now reaches ~1000 of
  // each (a memory upload is one TC_11_4 per block), so a regex per inner
  // iteration was a million of them per redraw — and every caller
  // (_tcPacketsHTML, tcPacketsAcked, both timetag builders) runs this.
  // `used` still has to be consulted inside the loop: it grows as matches
  // are claimed, which is the whole point of "each target claimed once".
  const envelopes  = packets.filter(p => TC_114_NAME_RE.test(p.name) && p.generationTime != null);
  const candidates = packets.filter(p => !TC_114_NAME_RE.test(p.name) && p.generationTime != null);
  for (const p of envelopes) {
    let best = null, bestDelta = Infinity;
    for (const o of candidates) {
      if (used.has(o.id)) continue;
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

// Whether at least one TC in the pass reached a real acceptance SUCCESS
// ('accepted' or 'exec-ok' above) — the single pass/fail signal
// PassAnalyzer.js's own TC status dot and passTooltip.js's hover-tooltip
// copy of it both show, so the two can't drift onto different criteria for
// the same claim. A TC_11_4's scheduled TARGET is excluded via
// matchScheduledTargets' consumedIds — it's a separately-timed nested event
// absorbed into its own envelope's row, not an independent send to judge on
// its own.
export function tcPacketsAcked(packets) {
  if (!packets?.length) return false;
  const { consumedIds } = matchScheduledTargets(packets);
  return packets.some(p => !consumedIds.has(p.id) && ['accepted', 'exec-ok'].includes(tcAckStatus(p.acks)));
}
