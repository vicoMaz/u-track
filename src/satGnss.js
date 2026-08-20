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

// Searches backward from "now" for the most recent sample where both parameters
// are simultaneously good. Starts with a narrow recent slice and widens whenever a
// slice comes back empty but fully seen — cheap for the common case (a recent match
// resolves in one request), and correctly reaches the full LOOKBACK_MS window
// regardless of how bursty the satellite's sample rate is. A flat row cap alone
// silently truncates the effective search depth on busy satellites (confirmed: one
// satellite's 1000-row cap covered 7 days-in-theory but only ~17 minutes in practice
// at its peak rate) — so if a slice comes back AT the cap, we can't trust "no match"
// for it and retry that same slice narrower instead of advancing past data we never
// actually saw.
//
// The two parameters are requested independently and correlated by their shared
// onBoardTime, because the SCC's
// /api/v1/parameters endpoint only returns values for a single requested
// parameter per row, even when a packet sample carries several, so finding
// "last time A and B were both true in the same sample" needs both series
// pulled separately and matched by timestamp rather than a single combined row.
// `out` (optional) collects the first paramB row this walk sees, which is what
// lets fetchSatGnss below drop the separate _searchBackward(paramB) call that
// used to run alongside this one. That second walk requested paramB over the
// SAME window sequence as this one, so every single request was issued twice —
// measured live: every /api/v1/parameters URL in a page load appeared exactly
// 2×, and this endpoint is ~58% of the app's whole request volume.
//
// It reproduces the old pick rather than improving on it: that call passed
// `() => true`, and rows.find on an onBoardTime-ASCENDING page returns rows[0],
// so the value shown was the oldest row of the newest slice holding data — not
// literally the latest sample, despite its comment. out.firstB is the same
// rows[0] of the same first non-empty slice.
//
// One documented divergence: this walk narrows when EITHER series hits the row
// cap, the old one only when paramB did, so on a slice where only paramA is
// capped the two progressions differ by a window. Both pick from the same time
// neighbourhood, and the consumer is a coarse VALID/not flag, so this is
// accepted rather than worked around.
async function _searchBackwardPaired(origin, paramA, paramB, signal, isGoodA, isGoodB, out) {
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
    if (out && out.firstB === undefined && rowsB.length) out.firstB = rowsB[0];

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
// "latest HW row" and the "paired good" checks. The full search does the same
// now (see _searchBackwardPaired's `out` parameter); it used to run a second
// independent walk for that one value, duplicating every request.
async function _forwardCheck(ip, noradId, signal) {
  // Clamped to a 10-minute lookback. _lastCheckedMs only advances when BOTH
  // queries below succeed, so on a flapping backend `from` stayed put while
  // `to` tracked now — the window grew one ping period per failure until it
  // silently hit MAX_ROWS (at the ~3.5k rows/h density documented above, a
  // 30-minute window already exceeds the 1000-row cap), at which point the
  // oldest samples in it became invisible and hkIsValid could report stale.
  // Anything older than this is the 30-minute full search's job anyway.
  const now  = Date.now();
  const from = Math.max(_lastCheckedMs[noradId] ?? (now - 10 * 60_000), now - 10 * 60_000);
  const to   = now + 10_000;
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
  // sccRo, not scc: this is a read-only query, the endpoint is confirmed
  // byte-identical on the read-only mirror (probed live — same rows, same
  // 53,053-byte response), and moving it takes the app's single largest
  // request category off the write-capable box. It also means the GNSS panel
  // keeps working for a client whose VPN only routes to SCC RO.
  const ip = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!ip) return;

  _ctrl.get(sat.noradId)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(sat.noradId, ctrl);

  const dueForFullSearch = Date.now() - (_lastFullSearchMs[sat.noradId] ?? 0) > FULL_SEARCH_INTERVAL_MS;
  const timer = setTimeout(() => ctrl.abort(), dueForFullSearch ? 45_000 : 15_000);
  try {
    if (dueForFullSearch) {
      // One walk, not two — see _searchBackwardPaired's own comment. `hwOut`
      // collects the paramB row the old second walk existed to fetch.
      const hwOut = {};
      const bothMatch = await _searchBackwardPaired(
        ip, 'GNSS_AM_TIMESYNC_STATUS', 'GNSS_AM_HW_HK_VALID',
        ctrl.signal, _isFinesteering, _isHkValid, hwOut,
      );
      if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
      const hwValue = hwOut.firstB ? _rowValue(hwOut.firstB, 'GNSS_AM_HW_HK_VALID') : null;
      _cached[sat.noradId] = {
        lastBothGood: bothMatch ? _rowTime(bothMatch) : null,
        hkIsValid:    hwValue == null ? null : hwValue.toUpperCase() === 'VALID',
      };
      _lastCheckedMs[sat.noradId] = Date.now() + 10_000;
    } else {
      await _forwardCheck(ip, sat.noradId, ctrl.signal);
      if (ctrl.signal.aborted) return;
    }
    store.setSatGnss(sat.id, _cached[sat.noradId] ?? { lastBothGood: null, hkIsValid: null });
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    // Advances on ATTEMPT, not success, and so lives here rather than after
    // the assignment above — which the 45s watchdog's own early return and the
    // catch both skipped. A satellite whose SCC was slow or flapping therefore
    // had dueForFullSearch permanently true and re-ran the *expensive* backward
    // search every cycle instead of every 30 minutes, and since satPing awaits
    // this, each 45s abort stretched that satellite's whole poll cycle to ~65s.
    // A failed search should cost 30 minutes of backoff, not zero. Guarded on
    // dueForFullSearch so the cheap forward-check path doesn't keep pushing the
    // gate forward and starve the full search entirely.
    if (dueForFullSearch) _lastFullSearchMs[sat.noradId] = Date.now();
    if (_ctrl.get(sat.noradId) === ctrl) _ctrl.delete(sat.noradId);
  }
}
