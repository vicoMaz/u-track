import { satSubsystemOrigin } from './satSubsystems.js';

// ── Gap-detection strategy ──────────────────────────────────────────────
// Earlier version of this file chunked each interpass void into fixed 90-min
// buckets and asked "does ANY row exist in this bucket" (maxLimit=1). That has
// two real precision holes: (1) a single stray sample near either edge of a
// bucket paints the WHOLE 90 minutes as covered, hiding a genuine multi-tens-
// of-minutes outage sitting inside it; (2) any void shorter than 20 min was
// never probed at all, just assumed clean. Both are the same root problem —
// checking *existence in a bucket* instead of the *actual gap structure*.
//
// This version walks the real onBoardTime-ordered samples (same pattern
// satGnss.js already uses for a similar problem) and measures the actual
// delta between consecutive real timestamps. A gap is only ever bounded by
// real data, never by an arbitrary grid — and because one request can return
// up to MAX_ROWS consecutive real samples, a long, densely-covered void often
// resolves in far fewer requests than the old fixed-bucket scan, while a
// short interpass void that used to be skipped entirely now costs one cheap
// request instead of zero (a real, unavoidable trade for actually checking it).
//
// IMPORTANT — confirmed empirically against the real API: `orderBy=onBoardTime`
// returns rows NEWEST-FIRST (descending), not ascending. The walk below moves
// backward from `end` toward `start` to match that — querying forward and
// trusting ascending order was tried first and is why an earlier version of
// this fix reported almost every interpass void as one giant false gap (the
// very first "row" processed was actually the newest sample in the window,
// so the cursor jumped straight to near the end on the first comparison).
// Rows within a single page are still sorted locally before use — cheap for
// <=MAX_ROWS items — so this doesn't re-depend on the API's order being
// exactly this and staying that way.
const MAX_ROWS         = 1000;         // per-request cap — matches satGnss.js's proven-safe value
const GAP_THRESHOLD_MS = 10 * 60_000;  // silence >= this between two real samples counts as a gap.
                                        // The one genuine judgment call in this file — tune against
                                        // real telemetry cadence if it over/under-reports in practice.
const MIN_CANDIDATE_MS = 60_000;       // floor below which a void isn't worth a request at all
const RETRIES = 2;                     // a page failing outright shouldn't end the whole scan
const RETRY_DELAY_MS = 250;
const PRE_MS  = 24 * 3_600_000; // extend back 24 h before first pass to catch its TMR buffer
const CONCURRENCY = 6; // candidates walked in parallel — each candidate's own pagination is
                        // inherently sequential (a page's cursor depends on the previous page)

// Each row on the Visualizer's TMR gantt track independently detects gaps
// against its own onboard packet store's TM/param — BUS (OBSW HK PLT) and
// PAY (OBSW HK PAY MGT) are separate stores, so a gap in one says nothing
// about coverage in the other. The filter/param below are also spelled out
// in each row's tooltip in index.html — keep both in sync if these change.
export const TMR_SOURCES = {
  bus: { filter: 'TM_3_25_OBSW_HK_PLT',     param: 'GENE_AM_CCSDSAPID' },
  pay: { filter: 'TM_3_25_OBSW_HK_PAY_MGT', param: 'GENE_AM_CCSDSAPID' },
};

const _ctrl     = new Map(); // `${noradId}:${source}` → AbortController
const _debounce = new Map(); // `${noradId}:${source}` → timer handle

const _sleep = ms => new Promise(r => setTimeout(r, ms));

function _rowTime(row) {
  const t = row?.onBoardTime ?? row?.generationTime ?? row?.receptionTime ?? row?.time;
  return t ? new Date(t).getTime() : null;
}

function _buildUrl(sccOrigin, startMs, endMs, maxLimit, filter, param) {
  return `${sccOrigin}/api/v1/parameters`
    + `?start=${encodeURIComponent(new Date(startMs).toISOString())}`
    + `&end=${encodeURIComponent(new Date(endMs).toISOString())}`
    + `&orderBy=onBoardTime`
    + `&filter=${encodeURIComponent(filter)}`
    + `&requestedParameters=${encodeURIComponent(param)}`
    + `&maxLimit=${maxLimit}`;
}

// Fetches up to `maxLimit` onBoardTime-ordered (ascending) rows in [startMs, endMs].
// Retries on failure/non-2xx; throws once exhausted (or on abort) rather than
// silently returning an empty page — callers decide what "we don't actually
// know" should mean for them instead of it being indistinguishable from "confirmed empty".
async function _queryPage(sccOrigin, startMs, endMs, maxLimit, filter, param, signal) {
  const url = _buildUrl(sccOrigin, startMs, endMs, maxLimit, filter, param);
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data[0]) ? data[0] : (data.parameters ?? data ?? []);
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt === RETRIES) throw e;
      await _sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error('unreachable');
}

async function _hasAnyData(sccOrigin, startMs, endMs, filter, param, signal) {
  const rows = await _queryPage(sccOrigin, startMs, endMs, 1, filter, param, signal);
  return rows.length > 0;
}

// Runs `worker` over `items` with up to `concurrency` in flight at once — no
// batch barriers, so a slow request doesn't stall the whole cohort behind it.
async function _pooledMap(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

// Merge overlapping/adjacent {start,end} (ms) intervals — e.g. two ground
// stations catching the same pass, or two overlapping download commands —
// so the gap search below never straddles a window that's already covered
// from more than one source.
function _mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

function _mergePassIntervals(pastPasses, toMs) {
  return _mergeIntervals(pastPasses.map(p => ({ start: toMs(p.start), end: toMs(p.end) })));
}

// The strict void between one pass ending and the next starting — passes themselves are
// known-covered (ground contact happened), so only these in-between stretches are real
// gap candidates. Also covers the lead-in before the first pass and the trailing edge
// up to "now".
function _gapCandidates(rangeStart, rangeEnd, passIntervals) {
  const candidates = [];
  let cursor = rangeStart;
  for (const iv of passIntervals) {
    const s = Math.max(iv.start, rangeStart);
    const e = Math.min(iv.end, rangeEnd);
    if (s > cursor) candidates.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < rangeEnd) candidates.push({ start: cursor, end: rangeEnd });
  return candidates;
}

// Walks one candidate void through the REAL recorded samples (not a
// fixed-size existence probe), so a real gap is found exactly regardless of
// what data exists elsewhere in the same stretch. Walks BACKWARD from `end`
// toward `start` (matching the API's real newest-first order — see the file
// header comment); each page can cover from seconds to many hours of real
// time depending on how dense the telemetry actually is — continuous
// coverage resolves in very few requests, and any genuine silence is
// bounded by real timestamps, never a coarse grid.
async function _walkCandidate(sccOrigin, start, end, filter, param, signal) {
  const gaps = []; // discovered newest-first, reversed to chronological order before returning
  let cursor = end; // upper bound; walks backward toward `start`
  // Hard iteration cap. The loop below is bounded only by `cursor` decreasing,
  // and that depends on API data rather than on arithmetic (see the
  // Math.min guard at the bottom) — so an explicit ceiling is what guarantees
  // termination. A dense 24h candidate at the ~3.5k rows/h seen live needs
  // ~84 pages, so 120 leaves real headroom while still bounding the damage:
  // each page is a MAX_ROWS request occupying one of the browser's 6
  // connections to this origin. Unlike satGnss's equivalent walk, whose window
  // provably shrinks by at least MIN_WINDOW_MS per iteration, nothing here is
  // structurally monotonic.
  const MAX_PAGES = 120;
  let pages = 0;
  try {
    while (cursor > start) {
      if (++pages > MAX_PAGES) {
        // Out of budget with data still unwalked. Report only what was
        // confirmed and treat the remainder as covered — the same
        // "don't paint a gap we're not sure about" bias as the catch below.
        console.warn(`[tmr] ${filter}: page cap (${MAX_PAGES}) hit, ${new Date(start).toISOString()}..${new Date(cursor).toISOString()} left unwalked`);
        return gaps.reverse();
      }
      const rows = await _queryPage(sccOrigin, start, cursor, MAX_ROWS, filter, param, signal);
      if (!rows.length) {
        if (cursor - start >= GAP_THRESHOLD_MS) gaps.push({ start, end: cursor });
        return gaps.reverse();
      }
      // Sort ascending locally rather than trust the API's order to hold —
      // cheap for <=MAX_ROWS rows, and makes the delta logic below unambiguous.
      const times = rows.map(_rowTime).filter(t => t != null).sort((a, b) => a - b);
      if (!times.length) {
        if (cursor - start >= GAP_THRESHOLD_MS) gaps.push({ start, end: cursor });
        return gaps.reverse();
      }

      const latestT = times[times.length - 1];
      if (cursor - latestT >= GAP_THRESHOLD_MS) gaps.push({ start: latestT, end: cursor });
      for (let i = times.length - 1; i > 0; i--) {
        if (times[i] - times[i - 1] >= GAP_THRESHOLD_MS) gaps.push({ start: times[i - 1], end: times[i] });
      }

      const earliestT = times[0];
      if (rows.length < MAX_ROWS) {
        // Not capped, so this page saw everything back to `start` — check the
        // leading edge too, then we're done with this candidate.
        if (earliestT - start >= GAP_THRESHOLD_MS) gaps.push({ start, end: earliestT });
        return gaps.reverse();
      }
      // Capped: there may be more (older) data before `earliestT` we haven't
      // seen yet. Re-query [start, earliestT) next iteration. If the true
      // count is exactly MAX_ROWS, the next page simply comes back empty —
      // one cheap extra request, not a bug.
      //
      // Math.min, not a bare assignment: `earliestT` comes from _rowTime, a
      // fallback chain (onBoardTime ?? generationTime ?? receptionTime ?? time),
      // while _queryPage orders and filters on onBoardTime specifically. A page
      // whose rows lack onBoardTime — or an on-board clock reset making it
      // inconsistent with generationTime, which for store-and-forward TM can
      // differ by hours — yields an `earliestT` ABOVE `cursor`. The bare
      // assignment then moved the cursor backward-in-name-only: the next query
      // covered the same or a wider range, returned the same superset, and the
      // loop went stationary — an unbounded stream of MAX_ROWS requests at full
      // speed. Forcing a strict decrease makes progress arithmetic, not
      // data-dependent.
      cursor = Math.min(cursor - 1, earliestT - 1);
    }
  } catch (e) {
    if (signal.aborted) throw e; // let abort unwind the whole scan
    // A real (non-abort) failure mid-walk — conservative fallback: keep whatever
    // gaps were already confirmed before the failure and drop the unresolved
    // remainder rather than guessing, same "don't paint a gap we're not sure
    // about" bias the rest of this file uses.
  }
  return gaps.reverse();
}

// ── PAY: download-coverage gap detection ─────────────────────────────────
// Confirmed live against the real ground segment: unlike BUS, PAY packets
// aren't streamed continuously — they only exist on the ground once a
// specific store-and-forward command has pulled them down, so checking
// sample DENSITY the way _walkCandidate does flags every stretch where the
// payload was simply idle as a false "gap", even though nothing was ever
// missing — it just hadn't been requested yet (entirely normal). The real
// signal is whether a download command's OWN requested time range has ever
// covered a given stretch, regardless of whether the resulting TM has
// streamed back yet.
//
// That command is TC_15_9_OBSW_PAY_DLNK_BETWEEN (PUS-15,9 "downlink packets
// between two times", the PAY-store variant — TC_15_9_OBSW_DLNK_BETWEEN,
// no "_PAY_", is the separate BUS-store one). Its decoded arguments carry
// the exact requested range as OBSW_AR_S15_T1 (lower bound) / OBSW_AR_S15_T2
// (upper bound). This deliberately does NOT touch TC_15_10_..._DEL_PKT_STORE_...
// (the separate delete-contents command) — only the plain download, which
// has no delete side effect of its own.
const PAY_DLNK_PACKET_NAME = 'TC_15_9_OBSW_PAY_DLNK_BETWEEN';
// The endpoint has no server-side name/filter param (confirmed live — name,
// filter, packetName, spacePacketName are all silently ignored), so every
// packet in a queried window comes back at full weight (each echoes its
// whole field/container schema, not just this one's few KB of interest) —
// paginating in day-sized chunks bounds how much of that gets pulled at
// once for a potentially multi-day analysis range.
const PAY_DLNK_CHUNK_MS = 24 * 3_600_000;
const PAY_DLNK_MAX_LIMIT = 2000; // headroom over the observed ~1000 packets/22h density

function _extractT1T2(rootContainer) {
  let t1 = null, t2 = null;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.subContainers) && node.subContainers.length) {
      for (const c of node.subContainers) walk(c);
      return;
    }
    if (node.name === 'OBSW_AR_S15_T1') t1 = node.physicalValue?.value ?? node.rawValue?.value ?? null;
    if (node.name === 'OBSW_AR_S15_T2') t2 = node.physicalValue?.value ?? node.rawValue?.value ?? null;
  })(rootContainer);
  if (!t1 || !t2) return null;
  const start = new Date(t1).getTime(), end = new Date(t2).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

// Every PAY_DLNK_BETWEEN command's requested [T1,T2] range, chunk-fetched
// across [rangeStart, rangeEnd]. Best-effort per chunk — a failed chunk just
// leaves that stretch unconfirmed (falls through to "gap") rather than the
// whole scan aborting, same conservative bias the rest of this file uses.
async function _fetchPayDownloadRanges(sat, rangeStart, rangeEnd, signal) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return [];
  const ranges = [];
  for (let chunkStart = rangeStart; chunkStart < rangeEnd; chunkStart += PAY_DLNK_CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + PAY_DLNK_CHUNK_MS, rangeEnd);
    const params = new URLSearchParams({
      start: new Date(chunkStart).toISOString(),
      end:   new Date(chunkEnd).toISOString(),
      maxLimit: String(PAY_DLNK_MAX_LIMIT),
    });
    let data;
    try {
      const res = await fetch(`${origin}/api/v1/tc-packets?${params}`, { signal });
      if (!res.ok) continue;
      data = await res.json();
    } catch (e) {
      if (signal.aborted) throw e;
      continue;
    }
    for (const p of data) {
      if (p.spacePacket?.name !== PAY_DLNK_PACKET_NAME) continue;
      const range = _extractT1T2(p.spacePacket.rootContainer);
      if (range) ranges.push(range);
    }
  }
  return ranges;
}

// `source` selects one of TMR_SOURCES (e.g. 'bus' | 'pay') — each fetched and
// debounced independently so one row's request never aborts the other's.
export function scheduleTmrFetch(sat, pastPasses, source, onDone) {
  const key = `${sat.noradId}:${source}`;
  clearTimeout(_debounce.get(key));
  _debounce.set(key, setTimeout(() => {
    _fetchTmrWindows(sat, pastPasses, source).then(result => {
      if (result) onDone(result);
    });
  }, 400));
}

async function _fetchTmrWindows(sat, pastPasses, source) {
  const key = `${sat.noradId}:${source}`;
  _ctrl.get(key)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(key, ctrl);
  const { signal } = ctrl;

  const { filter, param } = TMR_SOURCES[source];
  const ip = satSubsystemOrigin(sat.noradId, 'scc');
  if (!ip || !pastPasses.length) return null;

  const toMs       = t => (t instanceof Date ? t : new Date(t)).getTime();
  const rangeStart = Math.min(...pastPasses.map(p => toMs(p.start))) - PRE_MS;
  const rangeEnd   = Date.now();

  // Fast path: satellite with zero TMR data ever — one lightweight probe instead
  // of walking every candidate individually. A failure here (as opposed to a
  // confirmed-empty result) must NOT fall through to "whole range is a gap" —
  // that would paint an alarming false full-range gap from a transient network
  // blip instead of just leaving the previous (possibly still-loading) state alone.
  let anyData;
  try {
    anyData = await _hasAnyData(ip, rangeStart, rangeEnd, filter, param, signal);
  } catch {
    return null;
  }
  if (!anyData) {
    _ctrl.delete(key);
    return rangeEnd - rangeStart >= GAP_THRESHOLD_MS
      ? { rangeStart, rangeEnd, gapWindows: [{ start: rangeStart, end: rangeEnd }] }
      : { rangeStart, rangeEnd, gapWindows: [] };
  }

  const passIntervals = _mergePassIntervals(pastPasses, toMs);
  const candidates    = _gapCandidates(rangeStart, rangeEnd, passIntervals)
    .filter(c => c.end - c.start >= MIN_CANDIDATE_MS);

  let results;
  try {
    results = await _pooledMap(candidates, c => _walkCandidate(ip, c.start, c.end, filter, param, signal), CONCURRENCY);
  } catch {
    return null; // aborted mid-flight (superseded by a newer call) — discard silently
  }

  if (signal.aborted) return null;
  _ctrl.delete(key);

  return { rangeStart, rangeEnd, gapWindows: results.flat() };
}
