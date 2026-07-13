import { satSubsystemOrigin } from './satSubsystems.js';

const FINE_MS = 90 * 60_000; // interpass gaps longer than this get sub-probed at this resolution
                              // instead of trusting one hit for the whole span
const MIN_SEGMENT_MS = 20 * 60_000; // floor segment size — back-to-back passes shouldn't create sliver windows
const RETRIES = 2; // a probe now paints a real gap on a single "no data" — don't trust one failed request
const RETRY_DELAY_MS = 250;
const FILTER  = 'TM_3_25_OBSW_HK_PLT';
const PARAM   = 'OBSW_AM_SID';
const PRE_MS  = 24 * 3_600_000; // extend back 24 h before first pass to catch its TMR buffer
const CONCURRENCY = 6; // keep in flight continuously — no barrier stalls between rounds

const _ctrl     = new Map(); // noradId → AbortController
const _debounce = new Map(); // noradId → timer handle

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// Throws on a failed/errored request — callers must distinguish "confirmed empty"
// from "we don't actually know" so a network blip doesn't get rendered as a real gap.
async function _hasData(sccOrigin, startMs, endMs, signal) {
  const url = `${sccOrigin}/api/v1/parameters`
    + `?start=${encodeURIComponent(new Date(startMs).toISOString())}`
    + `&end=${encodeURIComponent(new Date(endMs).toISOString())}`
    + `&orderBy=onBoardTime`
    + `&filter=${encodeURIComponent(FILTER)}`
    + `&requestedParameters=${encodeURIComponent(PARAM)}`
    + `&maxLimit=1`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data[0]) ? data[0] : (data.parameters ?? data ?? []);
  return rows.length > 0;
}

// Retries on failure (timeout, connection reset, non-2xx) before giving up and
// treating the segment as uncovered — a single request now determines a whole
// segment's color, so it needs to be trustworthy rather than fast-and-lucky.
async function _probe(sccOrigin, startMs, endMs, signal) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await _hasData(sccOrigin, startMs, endMs, signal);
    } catch {
      if (signal.aborted || attempt === RETRIES) return false;
      await _sleep(RETRY_DELAY_MS);
    }
  }
  return false;
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

// Merge overlapping/adjacent pass intervals (e.g. two ground stations catching the same
// pass) so the gap search below never straddles a pass's own known-covered window.
function _mergePassIntervals(pastPasses, toMs) {
  const intervals = pastPasses
    .map(p => ({ start: toMs(p.start), end: toMs(p.end) }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
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

// One probe per candidate gap — a single hit anywhere in a *short* gap means the recorder
// was covering it, so the whole gap counts as green. But trusting one hit doesn't scale to
// long gaps — a real multi-hour outage in the middle of an otherwise-long gap would hide
// behind a stray data point near either edge — so any candidate longer than FINE_MS gets
// sub-chunked at that resolution instead, matching the original gap-detection resolution.
function _buildSegments(candidates) {
  const segments = [];
  for (const { start, end } of candidates) {
    if (end - start < MIN_SEGMENT_MS) continue; // too small to reliably flag as a real gap
    for (let t = start; t < end; t += FINE_MS) {
      segments.push({ start: t, end: Math.min(t + FINE_MS, end) });
    }
  }
  return segments;
}

export function scheduleTmrFetch(sat, pastPasses, onDone) {
  clearTimeout(_debounce.get(sat.noradId));
  _debounce.set(sat.noradId, setTimeout(() => {
    _fetchTmrWindows(sat, pastPasses).then(result => {
      if (result) onDone(result);
    });
  }, 400));
}

async function _fetchTmrWindows(sat, pastPasses) {
  _ctrl.get(sat.noradId)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(sat.noradId, ctrl);
  const { signal } = ctrl;

  const ip = satSubsystemOrigin(sat.noradId, 'scc');
  if (!ip || !pastPasses.length) return null;

  const toMs       = t => (t instanceof Date ? t : new Date(t)).getTime();
  const rangeStart = Math.min(...pastPasses.map(p => toMs(p.start))) - PRE_MS;
  const rangeEnd   = Date.now();

  // Fast path: satellite with zero TMR data ever — one probe instead of the full scan.
  if (!(await _probe(ip, rangeStart, rangeEnd, signal))) {
    if (signal.aborted) return null;
    _ctrl.delete(sat.noradId);
    return { rangeStart, rangeEnd, gapWindows: [{ start: rangeStart, end: rangeEnd }] };
  }
  if (signal.aborted) return null;

  const passIntervals = _mergePassIntervals(pastPasses, toMs);
  const candidates    = _gapCandidates(rangeStart, rangeEnd, passIntervals);
  const segments       = _buildSegments(candidates);

  const results = await _pooledMap(segments, seg => _probe(ip, seg.start, seg.end, signal), CONCURRENCY);
  segments.forEach((seg, i) => { seg.covered = results[i]; });

  if (signal.aborted) return null;
  _ctrl.delete(sat.noradId);

  // A failed probe segment IS a gap window directly — passes already carved the
  // known-covered stretches out of `candidates`, so no covered→gap inversion needed.
  // Merge adjacent uncovered segments so consecutive FINE_MS sub-chunks don't leave seams.
  const gapWindows = [];
  let cur = null;
  for (const seg of segments) {
    if (!seg.covered) {
      if (cur) cur.end = seg.end;
      else cur = { start: seg.start, end: seg.end };
    } else if (cur) {
      gapWindows.push(cur);
      cur = null;
    }
  }
  if (cur) gapWindows.push(cur);

  return { rangeStart, rangeEnd, gapWindows };
}
