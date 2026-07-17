import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

const PACKET      = 'TM_3_25_OBSW_HK_GNSS_RTE';
const LOOKBACK_MS = 7 * 86400_000;     // how far back we're willing to search
const MAX_ROWS    = 1000;              // per-request cap
const INITIAL_WINDOW_MS = 10 * 60_000; // 10 min — safely under MAX_ROWS even for the
                                        // busiest satellite observed (~3.5k rows/h)
const MIN_WINDOW_MS     = 60_000;      // floor — stop shrinking and just use what we get

async function _queryParam(sccOrigin, param, startMs, endMs, signal) {
  const url = `${sccOrigin}/api/v1/parameters`
    + `?start=${encodeURIComponent(new Date(startMs).toISOString())}`
    + `&end=${encodeURIComponent(new Date(endMs).toISOString())}`
    + `&orderBy=onBoardTime`
    + `&filter=${encodeURIComponent(PACKET)}`
    + `&requestedParameters=${encodeURIComponent(param)}`
    + `&maxLimit=${MAX_ROWS}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data[0])) return data[0];        // [[...rows...]]
    if (Array.isArray(data.parameters)) return data.parameters;
    if (Array.isArray(data)) return data;
    return null;
  } catch { return null; }
}

function _rowTime(row) {
  const t = row?.onBoardTime ?? row?.generationTime ?? row?.receptionTime ?? row?.time;
  return t ? new Date(t) : null;
}

function _rowValue(row, param) {
  if (row == null) return null;
  // Direct key (CSV-style or flat object)
  if (row[param] !== undefined) return String(row[param]);
  // SCC format: { parameter: { physicalValue: { value: "..." }, ... }, onBoardTime, ... }
  const pParam = row.parameter;
  if (pParam) {
    const pv = pParam.physicalValue ?? pParam.engValue;
    if (pv != null) return String(pv.value ?? pv.stringValue ?? pv);
    if (pParam.value !== undefined) return String(pParam.value);
  }
  // Flat physicalValue / engValue wrappers
  const pv = row.physicalValue ?? row.engValue;
  if (pv != null) return String(pv.value ?? pv.stringValue ?? pv);
  if (row.value !== undefined) return String(row.value);
  return null;
}

// Searches backward from "now" for the most recent row matching `matchFn`. Starts
// with a narrow recent slice and widens whenever a slice comes back empty but fully
// seen — cheap for the common case (a recent match resolves in one request), and
// correctly reaches the full LOOKBACK_MS window regardless of how bursty the
// satellite's sample rate is. A flat row cap alone silently truncates the effective
// search depth on busy satellites (confirmed: one satellite's 1000-row cap covered
// 7 days-in-theory but only ~17 minutes in practice at its peak rate) — so if a
// slice comes back AT the cap, we can't trust "no match" for it and retry that same
// slice narrower instead of advancing past data we never actually saw.
async function _searchBackward(origin, param, signal, matchFn) {
  const now     = Date.now();
  const floorMs = now - LOOKBACK_MS;
  let sliceEnd  = now + 10_000; // small buffer for clock skew
  let sliceMs   = INITIAL_WINDOW_MS;

  while (sliceEnd > floorMs) {
    const sliceStart = Math.max(floorMs, sliceEnd - sliceMs);
    const rows = await _queryParam(origin, param, sliceStart, sliceEnd, signal);
    if (rows === null) return null; // request failed — don't loop forever on a dead link

    if (rows.length >= MAX_ROWS && sliceMs > MIN_WINDOW_MS) {
      // Denser than assumed — can't trust "no match" here, retry this slice narrower.
      // Shrink hard (÷4, not ÷2): a capped request still costs a full MAX_ROWS
      // transfer regardless of the divisor, so converging in fewer capped attempts
      // matters more than a smooth shrink curve — halving needed 3 full-cap requests
      // in a row against real dense data before finding a usable slice.
      sliceMs = Math.max(MIN_WINDOW_MS, Math.floor(sliceMs / 4));
      continue;
    }

    const match = rows.find(matchFn);
    if (match) return match;

    // Fully saw this slice, no match — advance the cursor back and widen for the next one.
    sliceEnd = sliceStart;
    sliceMs  = Math.min(sliceMs * 2, LOOKBACK_MS);
  }
  return null;
}

// Same widening-backward strategy as _searchBackward, but correlates two
// independently-requested parameters by their shared onBoardTime — the SCC's
// /api/v1/parameters endpoint only returns values for a single requested
// parameter per row, even when a packet sample carries several, so finding
// "last time A and B were both true in the same sample" needs both series
// pulled separately and matched by timestamp rather than a single combined row.
async function _searchBackwardPaired(origin, paramA, paramB, signal, isGoodA, isGoodB) {
  const now     = Date.now();
  const floorMs = now - LOOKBACK_MS;
  let sliceEnd  = now + 10_000;
  let sliceMs   = INITIAL_WINDOW_MS;

  while (sliceEnd > floorMs) {
    const sliceStart = Math.max(floorMs, sliceEnd - sliceMs);
    const [rowsA, rowsB] = await Promise.all([
      _queryParam(origin, paramA, sliceStart, sliceEnd, signal),
      _queryParam(origin, paramB, sliceStart, sliceEnd, signal),
    ]);
    if (rowsA === null || rowsB === null) return null;

    if ((rowsA.length >= MAX_ROWS || rowsB.length >= MAX_ROWS) && sliceMs > MIN_WINDOW_MS) {
      sliceMs = Math.max(MIN_WINDOW_MS, Math.floor(sliceMs / 4));
      continue;
    }

    const goodBTimes = new Set();
    for (const row of rowsB) {
      if (!isGoodB(row)) continue;
      const t = _rowTime(row)?.getTime();
      if (t != null) goodBTimes.add(t);
    }

    const match = rowsA.find(row => {
      if (!isGoodA(row)) return false;
      const t = _rowTime(row)?.getTime();
      return t != null && goodBTimes.has(t);
    });
    if (match) return match;

    sliceEnd = sliceStart;
    sliceMs  = Math.min(sliceMs * 2, LOOKBACK_MS);
  }
  return null;
}

// Cancel a satellite's still-running search rather than let it pile up alongside a
// new one — e.g. a manual "force ping" click while a slow widening search is still
// in flight would otherwise start a second, fully independent search chain.
const _ctrl = new Map(); // noradId → AbortController

// The full widening backward search is cheap when there's a recent good
// sample (resolves in ~1 request) but expensive when there isn't — it walks
// the entire 7-day lookback (up to ~18-20 requests) EVERY ~20s ping cycle
// for as long as a satellite has gone without one. Since the resolved value
// changes slowly, the full search now only runs on a 30-min cadence; every
// other cycle does a cheap forward-only check for anything newer than the
// last confirmed sample (a single narrow-window request, normally just
// "since last check") and otherwise keeps showing the last resolved value.
const FULL_SEARCH_INTERVAL_MS = 30 * 60_000;
const _lastFullSearchMs = {}; // noradId → timestamp of last full backward search
const _lastCheckedMs    = {}; // noradId → upper time bound already confirmed by a forward check
const _cached           = {}; // noradId → last resolved { lastBothGood, hkIsValid }

const _isFinesteering = row => _rowValue(row, 'GNSS_AM_TIMESYNC_STATUS')?.toUpperCase() === 'FINESTEERING';
const _isHkValid      = row => _rowValue(row, 'GNSS_AM_HW_HK_VALID')?.toUpperCase() === 'VALID';

// Looks for anything newer than the last confirmed sample in one narrow
// window — fetches GNSS_AM_HW_HK_VALID once and reuses it for both the
// "latest HW row" and the "paired good" checks (the full search below fetches
// it twice, once per helper, which is itself acceptable there since it only
// runs every 30 min — not worth touching that proven path for this).
async function _forwardCheck(ip, noradId, signal) {
  const from = _lastCheckedMs[noradId] ?? (Date.now() - 10 * 60_000);
  const to   = Date.now() + 10_000;
  const [hkRows, tsRows] = await Promise.all([
    _queryParam(ip, 'GNSS_AM_HW_HK_VALID', from, to, signal),
    _queryParam(ip, 'GNSS_AM_TIMESYNC_STATUS', from, to, signal),
  ]);
  if (hkRows === null || tsRows === null) return; // request failed — keep the cached value as-is

  const cur = _cached[noradId] ?? { lastBothGood: null, hkIsValid: null };

  if (hkRows.length) {
    const latestHw = hkRows[hkRows.length - 1]; // most recent row in this window
    cur.hkIsValid = _isHkValid(latestHw);
  }

  const goodTsAt = new Set(tsRows.filter(_isFinesteering).map(r => _rowTime(r)?.getTime()).filter(t => t != null));
  for (let i = hkRows.length - 1; i >= 0; i--) { // newest-first — first match found is the latest
    const row = hkRows[i];
    if (!_isHkValid(row)) continue;
    const t = _rowTime(row)?.getTime();
    if (t != null && goodTsAt.has(t)) { cur.lastBothGood = _rowTime(row); break; }
  }

  _cached[noradId] = cur;
  _lastCheckedMs[noradId] = to;
}

export async function fetchSatGnss(sat) {
  const ip = satSubsystemOrigin(sat.noradId, 'scc');
  if (!ip) return;

  _ctrl.get(sat.noradId)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(sat.noradId, ctrl);

  const dueForFullSearch = Date.now() - (_lastFullSearchMs[sat.noradId] ?? 0) > FULL_SEARCH_INTERVAL_MS;
  const timer = setTimeout(() => ctrl.abort(), dueForFullSearch ? 45_000 : 15_000);
  try {
    if (dueForFullSearch) {
      const [hwMatch, bothMatch] = await Promise.all([
        _searchBackward(ip, 'GNSS_AM_HW_HK_VALID', ctrl.signal, () => true), // just the latest row
        _searchBackwardPaired(ip, 'GNSS_AM_TIMESYNC_STATUS', 'GNSS_AM_HW_HK_VALID', ctrl.signal, _isFinesteering, _isHkValid),
      ]);
      if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
      const hwValue = hwMatch ? _rowValue(hwMatch, 'GNSS_AM_HW_HK_VALID') : null;
      _cached[sat.noradId] = {
        lastBothGood: bothMatch ? _rowTime(bothMatch) : null,
        hkIsValid:    hwValue == null ? null : hwValue.toUpperCase() === 'VALID',
      };
      _lastFullSearchMs[sat.noradId] = Date.now();
      _lastCheckedMs[sat.noradId]    = Date.now() + 10_000;
    } else {
      await _forwardCheck(ip, sat.noradId, ctrl.signal);
      if (ctrl.signal.aborted) return;
    }
    store.setSatGnss(sat.id, _cached[sat.noradId] ?? { lastBothGood: null, hkIsValid: null });
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.noradId) === ctrl) _ctrl.delete(sat.noradId);
  }
}
