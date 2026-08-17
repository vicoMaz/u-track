// Fetches and charts the downlink Eb/N0 time series for a pass, from the
// satellite's own GNM (Ground Network Manager) metrics endpoint.
//
// Uses the general /api/v1/data/metrics endpoint (found in GNM's own frontend
// bundle — it's what GNM's own metrics-explorer page calls), not the narrower
// /api/v1/data/metrics/pass-metrics?pass_id=... one. pass-metrics ignores
// start/end entirely once pass_id is given and only ever returns ~5000 rows
// spanning a couple minutes near the end of whatever pass most recently got
// data — this endpoint properly filters by time range and metric name, and
// actually honors `limit` (verified: limit=5000/8000/20000 → exactly that
// many rows back, no hidden cap). It also doesn't need satellite_id/pass_id —
// each satellite has its own GNM host, so the origin alone scopes the query.
//
// TC Eb/N0 = 10·log10(SBT_AM_RX_DEMOD_EB / SBT_AM_RX_DEMOD_N0), from the
// satellite's own SCC telemetry (packet TM_3_25_OBSW_HK_SBT). This measures
// how well the satellite is receiving uplink TCs — overlaid on the same chart.
import { satSubsystemOrigin } from '../satSubsystems.js';
import { MARKER_COLORS, MARKER_PX_RADIUS } from './passPolar.js';

// ── TC Eb/N0 — SCC telemetry fetch ───────────────────────────────

const SBT_PACKET = 'TM_3_25_OBSW_HK_SBT';

async function _fetchSccParam(noradId, packet, param, startMs, endMs) {
  const origin = satSubsystemOrigin(noradId, 'scc');
  if (!origin) return null;
  const url = `${origin}/api/v1/parameters`
    + `?start=${encodeURIComponent(new Date(startMs).toISOString())}`
    + `&end=${encodeURIComponent(new Date(endMs).toISOString())}`
    + `&orderBy=onBoardTime`
    + `&filter=${encodeURIComponent(packet)}`
    + `&requestedParameters=${encodeURIComponent(param)}`
    + `&maxLimit=8000`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data[0]) ? data[0]
               : Array.isArray(data.parameters) ? data.parameters
               : Array.isArray(data) ? data : null;
    if (!rows) return null;
    return rows.map(row => {
      const t = row?.onBoardTime ?? row?.generationTime ?? row?.receptionTime;
      const pParam = row.parameter;
      let v = null;
      if (pParam) {
        const pv = pParam.physicalValue ?? pParam.engValue;
        v = pv != null ? parseFloat(pv.value ?? pv.stringValue ?? pv)
          : pParam.value !== undefined ? parseFloat(pParam.value) : null;
      } else {
        const pv = row.physicalValue ?? row.engValue;
        v = pv != null ? parseFloat(pv.value ?? pv.stringValue ?? pv)
          : row.value !== undefined ? parseFloat(row.value) : null;
      }
      return t && v != null && !isNaN(v) ? { t: new Date(t).getTime(), v } : null;
    }).filter(Boolean).sort((a, b) => a.t - b.t);
  } catch { return null; }
}

const _tcCache = new Map();

// `fresh` (default false, every existing caller) skips the cache READ so a
// still-open window (same noradId/startMs/endMs as an earlier call) forces
// an actual re-fetch instead of replaying whatever was cached the first
// time — PassAnalyzer.js's live-pass poll needs this: it re-queries the
// SAME [pass.start, pass.end] window every 5s while the pass is still in
// progress, and the server itself already clamps that to whatever samples
// actually exist "so far", so there's no need to vary the window per tick.
// Still WRITES the cache afterward either way, so a later non-live caller
// asking for this exact window (e.g. re-opening the same completed pass)
// still benefits from it.
export async function fetchTcEbn0Series(noradId, startMs, endMs, { fresh = false } = {}) {
  const key = `tc|${noradId}|${startMs}|${endMs}`;
  if (!fresh && _tcCache.has(key)) return _tcCache.get(key);

  const [ebRows, n0Rows] = await Promise.all([
    _fetchSccParam(noradId, SBT_PACKET, 'SBT_AM_RX_DEMOD_EB', startMs, endMs),
    _fetchSccParam(noradId, SBT_PACKET, 'SBT_AM_RX_DEMOD_N0', startMs, endMs),
  ]);

  let result = null;
  if (ebRows?.length && n0Rows?.length) {
    const series = [];
    for (const eb of ebRows) {
      // Match to nearest N0 sample (same packet → timestamps should align exactly)
      const n0 = n0Rows.reduce((best, r) =>
        Math.abs(r.t - eb.t) < Math.abs(best.t - eb.t) ? r : best
      );
      if (Math.abs(n0.t - eb.t) < 5000 && eb.v > 0 && n0.v > 0) {
        series.push({ t: eb.t, v: 10 * Math.log10(eb.v / n0.v) });
      }
    }
    if (series.length) result = series;
  }
  _tcCache.set(key, result);
  return result;
}

async function _fetchMetric(noradId, name, startMs, endMs, limit) {
  const origin = satSubsystemOrigin(noradId, 'gnm');
  if (!origin) return null;
  const params = new URLSearchParams({
    start: new Date(startMs).toISOString(),
    end:   new Date(endMs).toISOString(),
    name,
    limit: String(limit),
  });
  try {
    const res = await fetch(`${origin}/api/v1/data/metrics?${params}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Each ground network integration reports the same physical quantity under a
// different metric name — confirmed via /api/v1/data/metrics/filters, which
// lists per-origin metric names. "leaf" (e.g. IS01-xx) uses "ebn0"; "minimum"
// (PAM/STC/HBX/KRX/KUX) uses "eb_n0_ratio" and doesn't have the rest of leaf's
// RF-chain metrics at all; "skynopy" uses "downlink_modem_baseband_eb_n0".
// ksat has no equivalent metric recorded for this satellite yet (empty in
// /filters) — nothing to query for that one.
const EBN0_METRIC_BY_NETWORK = {
  leaf: 'ebn0',
  minimum: 'eb_n0_ratio',
  skynopy: 'downlink_modem_baseband_eb_n0',
};

const _cache = new Map(); // `${noradId}|${startMs}|${endMs}|${network}` → [{t,v}] | null

// `fresh` — see fetchTcEbn0Series's own comment above, same reasoning,
// same live-poll caller.
export async function fetchEbn0Series(noradId, startMs, endMs, network, { fresh = false } = {}) {
  const metricName = EBN0_METRIC_BY_NETWORK[network];
  if (!metricName) return null;
  const key = `${noradId}|${startMs}|${endMs}|${network}`;
  if (!fresh && _cache.has(key)) return _cache.get(key);
  const rows = await _fetchMetric(noradId, metricName, startMs, endMs, 8000);
  const series = rows
    ? rows.map(r => ({ t: new Date(r.timestamp).getTime(), v: r.value })).sort((a, b) => a.t - b.t)
    : [];
  const result = series.length ? series : null;
  _cache.set(key, result);
  return result;
}

// GNM's own cumulative "TM packets received" counter (origin "gnm", so it's
// network-agnostic unlike leaf's frame-level counters) — a few hundred
// lightweight samples for a whole pass, vs. the multi-hundred-MB it'd cost to
// fetch every individual /tm-packets record just to count them (confirmed
// live: ~2000 real TM packets in a 13-minute pass at ~70KB/record). Returned
// as raw {t,v} counter samples, NOT yet diffed into per-bucket deltas —
// PassAnalyzer.js's _tmReceiveHistogram does that, pairing it against the
// pass log's own CaduCodec loss errors for the failed side of the same bars.
const _tmCounterCache = new Map();

export async function fetchTmPacketsCounterSeries(noradId, startMs, endMs) {
  const key = `tmcnt|${noradId}|${startMs}|${endMs}`;
  if (_tmCounterCache.has(key)) return _tmCounterCache.get(key);
  const rows = await _fetchMetric(noradId, 'tm_packets_counter', startMs, endMs, 8000);
  const series = rows
    ? rows.map(r => ({ t: new Date(r.timestamp).getTime(), v: r.value })).sort((a, b) => a.t - b.t)
    : [];
  const result = series.length ? series : null;
  _tmCounterCache.set(key, result);
  return result;
}

// Whether at least one real TM packet arrived during the pass — a positive
// delta between two consecutive counter samples (same "cumulative counter,
// diff consecutive samples" reading PassAnalyzer.js's own
// _tmReceiveHistogram uses for its "received" bars; a negative delta means
// the counter reset, e.g. a link drop/reconnect mid-pass, not a real
// un-received packet, so it's skipped rather than counted). Deliberately
// NOT "does the Eb/N0 carrier-quality series have samples" — that only means
// the ground station stayed locked on the carrier, and says nothing about
// whether any packet was actually decoded. Shared by PassAnalyzer.js's own
// TM status dot and passTooltip.js's hover-tooltip copy of it, so the two
// can't drift onto different criteria for the same claim.
export function tmPacketsReceived(counterSamples) {
  if (!counterSamples?.length) return false;
  const sorted = counterSamples.slice().sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].v - sorted[i - 1].v > 0) return true;
  }
  return false;
}

// CHART_W is an internal viewBox unit, not a pixel size — the SVG renders at
// width:100% (see buildEbn0SVG) so it stretches to fill whatever the flex
// layout gives it, without hardcoding (and without growing) the tooltip.
// Exported so the linked-cursor wiring (passCursor.js) can convert mouse
// position ↔ viewBox coordinates without duplicating these constants.
export const CHART_W = 300, CHART_H = 190;
// PAD_L/PAD_R no longer need to reserve room for the axis labels themselves —
// both the left dB axis (buildEbn0SVG) and the right TC/TM quantity axis
// (_quantityAxisSVG) now draw their labels INSIDE the plot area, overlaid
// near the curve rather than sitting in a dedicated side margin (with a
// stroke halo — see .ebn0-axis-label in style.css — so they stay legible
// over the curve/histogram bars). These just need to clear the axis line
// itself, same scale as PAD_T/PAD_B.
export const PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 14;

// Procedure-execution strip drawn below the main plot area (only when the
// pass has procedures) — numbered bars 1,2,3... spanning each procedure's
// start→end, on the same time axis as the Eb/N0 curve above them. Anchored
// to the x-axis line itself (CHART_H - PAD_B), not the outer CHART_H — PAD_B
// exists to leave room for the y-axis "lo" label, which sits to the left of
// the axis, not below it, so the bars can sit right under the line.
const BAR_ROW_GAP = 3, BAR_ROW_H = 11, BAR_BOTTOM_PAD = 2;
// Exported so a caller sizing the chart to fill an exact available pixel
// height (PassAnalyzer.js) can subtract this extension up front — buildEbn0SVG
// adds it to `height` internally (see `totalH`) whenever the pass has
// procedures, so the SVG's actual total height ends up taller than the
// `height` a caller passed in.
export const PROC_BAR_STRIP_H = BAR_ROW_GAP + BAR_ROW_H + BAR_BOTTOM_PAD;
const _PROC_BAR_COLOR = { SUCCESS: '#00cc66', FAILURE: '#ff4455', CANCELLED: '#ff8c00' };

// Initial guess for marker/cursor dot radius (viewBox units, assumes ~1:1
// render scale) — corrected to an exact pixel match with the polar plot's
// dots once mounted, via syncEbn0DotSizes() below, since this chart's actual
// viewBox-unit-to-pixel ratio isn't known until it's actually laid out.
const MARKER_RADIUS = {
  aos: MARKER_PX_RADIUS.standard, los: MARKER_PX_RADIUS.standard,
  maskEntry: MARKER_PX_RADIUS.standard, maskExit: MARKER_PX_RADIUS.standard,
  apogee: MARKER_PX_RADIUS.apogee,
};

// Exported so passCursor.js can compute x/y for an arbitrary point (e.g. one
// snapped from the polar plot) without re-deriving the value/time scale.
//
// `procedures`, if given, extends the time domain to cover every procedure's
// start→end too — a procedure often starts executing right at AOS or keeps
// running past LOS, outside the window where the GNM actually reported Eb/N0
// samples, so without this the procedure bars would fall entirely outside
// [t0,t1] and never draw. Passing the same `procedures` wherever `ebn0Scales`
// is called (buildEbn0SVG, passCursor.js) keeps the curve, markers, cursor,
// and bars all mapped through one consistent scale.
// `fallbackRange` ({t0,t1} ms) is used only when there's no series — lets the
// empty-plot case (no Eb/N0 metric for this network/pass) still frame its
// x-axis on the pass's own AOS→LOS span, so procedure bars land in the right
// place instead of the chart having no time domain to scale against at all.
// `width`/`height` default to CHART_W/CHART_H (every existing caller) — a
// caller building a differently-proportioned chart (e.g. a wide full-width
// one) passes its own, and must pass the SAME values to every other function
// here that also takes them, so everything stays mapped through one scale.
//
// `spanMode` picks what the x-axis actually spans:
//   'pass'       — exactly fallbackRange (the pass's own AOS0→LOS0), full
//                  stop. A procedure that starts before AOS or keeps running
//                  past LOS just gets visually clipped at the edge instead of
//                  widening the axis, so the chart reads as "this pass," not
//                  "however long the longest procedure happened to run."
//                  PassAnalyzer.js's span-toggle button defaults to this.
//   'procedures' (this function's own default, unchanged prior behavior) —
//                  series bounds extended to cover every procedure's
//                  start→end, so an overrunning procedure's bar is shown in
//                  full even though that stretches the axis past the pass's
//                  own start/end.
// The parameter defaults to 'procedures' (not 'pass') so every OTHER
// existing caller that doesn't know about span modes keeps its exact prior
// behavior unchanged. Falls back to the 'procedures' computation whenever
// 'pass' is requested without a fallbackRange to clamp to — nothing to
// clamp against otherwise.
//
// `viewRange` ({t0,t1} ms), optional: overrides the X-axis domain alone —
// scroll-to-zoom (PassAnalyzer.js's own wheel handler on the chart) narrows
// this without touching anything else. Deliberately applied AFTER `lo`/`hi`
// would be computed either way (see below): the Y (dB) domain is always
// derived from the FULL series, never the current view window, so the
// vertical scale stays fixed while zooming in/out on time — a curve zoomed
// into a flat 5-minute slice reads at the same vertical scale as the whole
// pass, rather than the axis rescaling to whatever that slice's own min/max
// happens to be. `t0`/`t1` (the full, un-zoomed domain) are still returned
// alongside the effective ones, so the wheel handler has real outer bounds
// to clamp zoom-out against without recomputing this same domain logic
// itself.
export function ebn0Scales(series, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H, spanMode = 'procedures', viewRange = null) {
  let t0, t1;
  if (spanMode === 'pass' && fallbackRange) {
    ({ t0, t1 } = fallbackRange);
  } else if (series?.length) {
    t0 = series[0].t;
    t1 = series[series.length - 1].t;
  } else if (series2?.length) {
    t0 = series2[0].t;
    t1 = series2[series2.length - 1].t;
  } else if (fallbackRange) {
    ({ t0, t1 } = fallbackRange);
  } else {
    t0 = 0; t1 = 1;
  }
  if (spanMode !== 'pass' || !fallbackRange) {
    if (series2?.length) {
      t0 = Math.min(t0, series2[0].t);
      t1 = Math.max(t1, series2[series2.length - 1].t);
    }
    if (procedures?.length) {
      for (const pr of procedures) {
        if (pr.startMs != null) t0 = Math.min(t0, pr.startMs);
        if (pr.endMs   != null) t1 = Math.max(t1, pr.endMs);
      }
    }
  }
  const fullT0 = t0, fullT1 = t1;
  if (viewRange) { t0 = viewRange.t0; t1 = viewRange.t1; }
  const vals = [
    ...(series?.length  ? series.map(s => s.v)  : []),
    ...(series2?.length ? series2.map(s => s.v) : []),
  ];
  const vMin = vals.length ? Math.min(...vals) : 0;
  const vMax = vals.length ? Math.max(...vals) : 1;
  const vPad = vals.length ? Math.max(0.2, (vMax - vMin) * 0.15) : 0;
  const lo = vMin - vPad, hi = vMax + vPad;
  const xScale = t => t1 === t0 ? PAD_L : PAD_L + (t - t0) / (t1 - t0) * (width - PAD_L - PAD_R);
  const yScale = v => height - PAD_B - (hi === lo ? 0 : (v - lo) / (hi - lo) * (height - PAD_T - PAD_B));
  return { t0, t1, lo, hi, xScale, yScale, fullT0, fullT1 };
}

// Exported so PassAnalyzer.js's fixed-position value readout (see
// _updateEbn0Readout there) can look up the same nearest-sample-by-time
// point this module already uses internally for markers/cursor snapping,
// without a third private copy of the same handful of lines.
export function nearestByTime(points, t) {
  let best = points[0], bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.t - t);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return best;
}

// Dots the same AOS/LOS/apogee/mask-entry/mask-exit moments the polar plot
// marks (see passPolar.js's computePolarMarkers), in the same colors, snapped
// to the nearest actual Eb/N0 sample — so a dip/spike here can be read
// against a specific point in the pass geometry.
function _markerDots(series, markers, xScale, yScale) {
  if (!markers) return '';
  return Object.entries(MARKER_COLORS).map(([key, color]) => {
    const marker = markers[key];
    if (!marker) return '';
    const p = nearestByTime(series, marker.t);
    const x = xScale(p.t), y = yScale(p.v);
    return `<circle class="ebn0-marker-dot" data-marker="${key}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${MARKER_RADIUS[key]}" fill="${color}" stroke="#12121e" stroke-width="0.6"/>`;
  }).join('');
}

// Numbered bars (1, 2, 3…) spanning each procedure's start→end time, drawn in
// their own strip below the main plot — same numbering as the tooltip's
// "Procedure history" list, so a dip/spike in Eb/N0 can be tied to whichever
// procedure was executing at that moment. `xScale`/`t0`/`t1` come from the
// SAME ebn0Scales(series, procedures) call used for the curve above, whose
// domain already extends to cover every procedure (see ebn0Scales) — so this
// clamp is just a safety margin, not what makes the bars visible.
function _procedureBars(procedures, xScale, t0, t1, height = CHART_H) {
  if (!procedures?.length) return '';
  const y = height - PAD_B + BAR_ROW_GAP;
  const midY = y + BAR_ROW_H / 2 + 2.6; // matches the number label's own baseline below
  return procedures.map((pr, i) => {
    if (pr.startMs == null || pr.endMs == null) return '';
    const s = Math.max(pr.startMs, t0), e = Math.min(pr.endMs, t1);
    if (e <= s) return '';
    const x1 = xScale(s);
    const w  = Math.max(xScale(e) - x1, 1.5);
    const color = _PROC_BAR_COLOR[pr.status] ?? _PROC_BAR_COLOR.SUCCESS;
    const cx = x1 + w / 2;
    // A procedure that started before this chart's own [t0,t1] window, or is
    // still running past it, gets clamped to it by s/e above — common in
    // spanMode:'pass' (ebn0Scales), where the axis is fixed to the pass's own
    // AOS0→LOS0 regardless of how long the procedure actually ran. Without
    // some marker, a clamped bar looks IDENTICAL to one that genuinely
    // started/ended right at the chart's edge — an ellipsis just inside the
    // clipped end (not outside the rect, which risks overflowing the plot's
    // own thin R/L padding) says "this keeps going past what you see here."
    const truncatedLeft  = pr.startMs < t0;
    const truncatedRight = pr.endMs   > t1;
    const truncLeft  = truncatedLeft  ? `<text class="ebn0-proc-bar-trunc" x="${(x1 + 2).toFixed(1)}" y="${midY.toFixed(1)}" text-anchor="start" fill="${color}">⋯</text>` : '';
    const truncRight = truncatedRight ? `<text class="ebn0-proc-bar-trunc" x="${(x1 + w - 2).toFixed(1)}" y="${midY.toFixed(1)}" text-anchor="end" fill="${color}">⋯</text>` : '';
    const truncTitle = (truncatedLeft || truncatedRight) ? ' (continues beyond the current chart span)' : '';
    // data-proc-idx matches this procedure's index in the SAME pass.procedures
    // array the Procedures panel numbers its pills 1,2,3... from (PassAnalyzer.js's
    // _procHistoryHTML) — lets a pill click find and glow this exact bar
    // (see _glowEbn0Bar) without either side needing to compare names/times.
    return `<g class="ebn0-proc-bar" data-proc-idx="${i}">
      <rect x="${x1.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BAR_ROW_H}" rx="2" fill="${color}" fill-opacity="0.28" stroke="${color}" stroke-width="0.7"><title>${i + 1}. ${pr.name ?? ''}${truncTitle}</title></rect>
      ${truncLeft}${truncRight}
      <text class="ebn0-proc-num" x="${cx.toFixed(1)}" y="${midY.toFixed(1)}" text-anchor="middle">${i + 1}</text>
    </g>`;
  }).join('');
}

// Height scale for the TC-send histogram bars below — expressed as a RATE
// (TCs/sec) rather than a fixed count per bucket, so it stays meaningful
// however PassAnalyzer.js's own HIST_BUCKET_MS is tuned: a bucket sending
// at TC_HIST_SCALE_RATE reaches TC_HIST_MAX_FRAC of the plot's OWN height
// (PAD_T..height-PAD_B), deliberately capped well under 1.0 so even a busy
// burst leaves the Eb/N0 curve above it legible instead of the overlay ever
// filling the whole plot. Its own scale, not shared with TM_HIST_SCALE_RATE
// below — TC volume is naturally far lower than TM (commands sent vs.
// packets received), so sharing one rate between them made the TC bars read
// as almost nothing next to TM.
const TC_HIST_SCALE_RATE = 5; // TCs per second (25 per 5s bucket)
const TC_HIST_MAX_FRAC = 0.30;

// Both histograms now share one origin at the plot's own vertical center
// (rather than the TC one sitting on the x-axis baseline) — TC-sent grows up
// from it, TM-received grows down from it (see _tmHistogramBars below), so
// uplink and downlink activity read as two halves of one symmetric strip
// instead of two overlaid-at-the-bottom bars competing for the same space.
// TC_HIST_MAX_FRAC (0.30) is still expressed against the FULL plot height —
// deliberately, so a max-height TC bar is the exact same absolute pixel
// height it was before this split (0.30 of the full height always fits
// inside the half-height budget above center, since 0.30 < 0.5 — the capH
// clamp below is just a safety net for a pathological burst, not the normal
// limiter).
function _histCenterY(height = CHART_H) {
  return PAD_T + (height - PAD_T - PAD_B) / 2;
}

// A few px of transparent breathing room straddling the shared center line —
// without it, a bucket with BOTH TC and TM activity draws its green rects
// bottom-to-top and top-to-bottom against the exact same y, so they visually
// fuse into one solid block with no seam marking where uplink ends and
// downlink begins. Split half-above/half-below center so the two bars stay
// exactly as tall as before (still measured from center, just center moved
// out by GAP/2 in each direction) rather than the gap eating into either
// one's own height budget.
const HIST_CENTER_GAP = 3;

function _tcHistBaselineY(height = CHART_H) {
  return _histCenterY(height) - HIST_CENTER_GAP / 2;
}

function _tmHistBaselineY(height = CHART_H) {
  return _histCenterY(height) + HIST_CENTER_GAP / 2;
}

// Stacked green/red bars, one per PassAnalyzer.js's _tcSendHistogram bucket —
// green from the shared center line up for the bucket's non-failed sends,
// red stacked directly on top for the failed portion of that SAME bucket.
// Both segments are scaled by the identical factor so the red/green split
// stays proportional to the real failed/total ratio even once a bucket's
// total is clamped. Drawn overlaid directly on the plot area (not a separate
// strip like _procedureBars below the axis) — clamped against [t0,t1] the
// same way _procedureBars is, since a bucket can straddle the edge of the
// chart's own time domain.
function _tcHistogramBars(histogram, xScale, t0, t1, height = CHART_H) {
  if (!histogram?.length) return '';
  const baseline = _tcHistBaselineY(height);
  const plotH    = height - PAD_T - PAD_B;
  const capH     = baseline - PAD_T; // room available going up before hitting the top of the plot
  return histogram.map(b => {
    const s = Math.max(b.t, t0), e = Math.min(b.tEnd, t1);
    if (e <= s || !b.sent) return '';
    const x1 = xScale(s);
    const w  = Math.max(xScale(e) - x1, 1);
    const scaleTc = TC_HIST_SCALE_RATE * (b.tEnd - b.t) / 1000; // bucket's own duration × the target rate = the count that reaches TC_HIST_MAX_FRAC
    let hTotal  = (b.sent   / scaleTc) * TC_HIST_MAX_FRAC * plotH;
    let hFailed = (b.failed / scaleTc) * TC_HIST_MAX_FRAC * plotH;
    if (hTotal > capH) { const k = capH / hTotal; hTotal *= k; hFailed *= k; } // keep the green/red ratio intact if a pathological burst would otherwise overflow the plot
    const hGreen = hTotal - hFailed;
    const title = `<title>${b.sent} TC${b.sent === 1 ? '' : 's'} sent${b.failed ? ` · ${b.failed} failed` : ''}</title>`;
    const greenRect = hGreen > 0.05
      ? `<rect x="${x1.toFixed(1)}" y="${(baseline - hGreen).toFixed(1)}" width="${w.toFixed(1)}" height="${hGreen.toFixed(1)}" fill="#00cc66" fill-opacity="0.55"/>`
      : '';
    const redRect = hFailed > 0.05
      ? `<rect x="${x1.toFixed(1)}" y="${(baseline - hGreen - hFailed).toFixed(1)}" width="${w.toFixed(1)}" height="${hFailed.toFixed(1)}" fill="#ff4455" fill-opacity="0.7"/>`
      : '';
    return `<g class="ebn0-tc-hist-bar">${title}${greenRect}${redRect}</g>`;
  }).join('');
}

// TM-received rate at which a bucket reaches TM_HIST_MAX_FRAC of the plot's
// half-height — a "full" bar means 375 TM packets in a 5s bucket
// (HIST_BUCKET_MS, PassAnalyzer.js). Deliberately its
// own scale, not shared with TC_HIST_SCALE_RATE above — TM volume runs far
// higher than TC (packets received vs. commands sent), so the two need
// independent full-bar references or whichever one is naturally busier
// visually swamps the other.
const TM_HIST_SCALE_RATE = 75; // TM packets/sec (received + lost combined); 375 per 5s bucket
const TM_HIST_MAX_FRAC = 0.30;

// Mirrors _tcHistogramBars, growing DOWN from the shared center line instead
// of up — green (received, from PassAnalyzer.js's _tmReceiveHistogram, itself
// diffed from GNM's tm_packets_counter) touches the origin, red (lost, from
// the pass log's own CaduCodec "packet lost" errors) stacks below it, same
// "away from center = failure" convention as the TC bars above.
function _tmHistogramBars(histogram, xScale, t0, t1, height = CHART_H) {
  if (!histogram?.length) return '';
  const baseline = _tmHistBaselineY(height);
  const plotH    = height - PAD_T - PAD_B;
  const capH     = (height - PAD_B) - baseline; // room available going down before hitting the baseline
  return histogram.map(b => {
    const s = Math.max(b.t, t0), e = Math.min(b.tEnd, t1);
    if (e <= s || !(b.received || b.lost)) return '';
    const x1 = xScale(s);
    const w  = Math.max(xScale(e) - x1, 1);
    const scaleTm = TM_HIST_SCALE_RATE * (b.tEnd - b.t) / 1000;
    let hTotal = ((b.received + b.lost) / scaleTm) * TM_HIST_MAX_FRAC * plotH;
    let hLost  = (b.lost                / scaleTm) * TM_HIST_MAX_FRAC * plotH;
    if (hTotal > capH) { const k = capH / hTotal; hTotal *= k; hLost *= k; }
    const hGreen = hTotal - hLost;
    const title = `<title>${b.received} TM received${b.lost ? ` · ${b.lost} lost` : ''}</title>`;
    const greenRect = hGreen > 0.05
      ? `<rect x="${x1.toFixed(1)}" y="${baseline.toFixed(1)}" width="${w.toFixed(1)}" height="${hGreen.toFixed(1)}" fill="#00cc66" fill-opacity="0.55"/>`
      : '';
    const redRect = hLost > 0.05
      ? `<rect x="${x1.toFixed(1)}" y="${(baseline + hGreen).toFixed(1)}" width="${w.toFixed(1)}" height="${hLost.toFixed(1)}" fill="#ff4455" fill-opacity="0.7"/>`
      : '';
    return `<g class="ebn0-tm-hist-bar">${title}${greenRect}${redRect}</g>`;
  }).join('');
}

// Right-side "quantity" axis — a double-headed arrow (chevron up at top,
// chevron down at bottom) with TC/TM tags AND their own full-bar rate (the
// count at which a bucket reaches TC_HIST_MAX_FRAC/TM_HIST_MAX_FRAC height —
// see TC_HIST_SCALE_RATE/TM_HIST_SCALE_RATE), mirroring the left dB axis's
// hi/lo number labels but for the TC-sent/TM-received histogram bars: those
// grow UP (TC, _tcHistogramBars) and DOWN (TM, _tmHistogramBars) from the
// shared center line (_histCenterY), and this axis names which direction is
// which AND what "full height" actually means in each direction. Reads the
// rate constants directly (module scope) rather than taking them as
// params — this is the one place they need to be shown, not computed with.
function _quantityAxisSVG(width, height) {
  const x = width - PAD_R, labelX = x - 4;
  const yTop = PAD_T, yBot = height - PAD_B;
  // One line per end instead of a tag + a separate rate line + a separately
  // drawn chevron path — folding the arrowhead into the text itself (▲/▼)
  // frees up the vertical room that used to buy only a 6.5-7px font, letting
  // this run at 10px instead: readable at a glance rather than squinted at.
  // text-anchor="end" (not "start") + labelX to the LEFT of the axis line —
  // like the left dB axis, this now draws INSIDE the plot area (over the
  // curve/bars) rather than in a dedicated side margin, so PAD_R only needs
  // to clear the axis line itself, not the label text too.
  const topY = yTop + 9;
  const botY = yBot;
  const lineTop = topY + 5, lineBot = botY - 14;
  return `
    <text class="ebn0-axis-label" x="${labelX}" y="${topY}" text-anchor="end">▲TC ${TC_HIST_SCALE_RATE}/s</text>
    ${lineBot > lineTop ? `<line x1="${x}" y1="${lineTop}" x2="${x}" y2="${lineBot}" stroke="#5a5a8a" stroke-width="0.8"/>` : ''}
    <text class="ebn0-axis-label" x="${labelX}" y="${botY}" text-anchor="end">▼TM ${TM_HIST_SCALE_RATE}/s</text>
  `;
}

// No background/border — sits directly on the tooltip's own dark background,
// like the polar plot. A transparent hit-rect drives the shared hover cursor
// (see passCursor.js), wired up separately once this markup is in the live DOM.
//
// With no series (metric unavailable for this pass/network), still draws the
// empty axes + procedure bars (if any) so the procedure-timing strip stays
// visible instead of disappearing along with the missing curve — and a faint
// centered note in place of the data line, rather than replacing the whole
// block with a one-line text note.
export function buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H, tcHistogram, tmHistogram, spanMode = 'procedures', viewRange = null) {
  const hasSeries  = !!series?.length;
  const hasSeries2 = !!series2?.length;
  if (!hasSeries && !hasSeries2 && !procedures?.length && !fallbackRange) return '';
  const { xScale, yScale, lo, hi, t0, t1 } = ebn0Scales(series, procedures, fallbackRange, series2, width, height, spanMode, viewRange);
  const pathD  = hasSeries  ? series.map( (p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('') : '';
  const pathD2 = hasSeries2 ? series2.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('') : '';
  const hasBars = procedures?.some(pr => pr.startMs != null && pr.endMs != null);
  const totalH  = hasBars ? (height - PAD_B + BAR_ROW_GAP + BAR_ROW_H + BAR_BOTTOM_PAD) : height;
  const hasAny  = hasSeries || hasSeries2;
  const hasHist = !!(tcHistogram?.length || tmHistogram?.length);

  return `<svg width="100%" height="${totalH}" viewBox="0 0 ${width} ${totalH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="ebn0-chart">
    ${hasAny ? `<text class="ebn0-axis-label" x="${PAD_L + 4}" y="${PAD_T + 10}" text-anchor="start">${hi.toFixed(1)} dB</text>
    <text class="ebn0-axis-label" x="${PAD_L + 4}" y="${height - PAD_B}" text-anchor="start">${lo.toFixed(1)}</text>` : ''}
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${height - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    <line x1="${PAD_L}" y1="${height - PAD_B}" x2="${width - PAD_R}" y2="${height - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    ${hasHist ? `<line x1="${PAD_L}" y1="${_histCenterY(height).toFixed(1)}" x2="${width - PAD_R}" y2="${_histCenterY(height).toFixed(1)}" stroke="#3a3a5a" stroke-width="0.5" stroke-dasharray="1.5,1.5"/>` : ''}
    ${hasHist ? _quantityAxisSVG(width, height) : ''}
    ${_tcHistogramBars(tcHistogram, xScale, t0, t1, height)}
    ${_tmHistogramBars(tmHistogram, xScale, t0, t1, height)}
    ${hasSeries2 ? `<path d="${pathD2}" fill="none" stroke="#4ad4ff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85"/>` : ''}
    ${hasSeries  ? `<path d="${pathD}"  fill="none" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    ${_markerDots(series, markers, xScale, yScale)}` : ''}
    ${!hasAny ? `<text x="${(PAD_L + width - PAD_R) / 2}" y="${(PAD_T + height - PAD_B) / 2}" text-anchor="middle" dominant-baseline="middle" fill="#4a4a6a" font-size="9" font-family="monospace" font-style="italic">(No Eb/N0 metric)</text>` : ''}
    ${hasBars ? _procedureBars(procedures, xScale, t0, t1, height) : ''}
    <line class="ebn0-cursor-line" x1="0" y1="${PAD_T}" x2="0" y2="${height - PAD_B}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.7" stroke-dasharray="2,2" visibility="hidden"/>
    <rect class="ebn0-hit" x="${PAD_L}" y="${PAD_T}" width="${width - PAD_L - PAD_R}" height="${height - PAD_T - PAD_B}" fill="transparent"/>
  </svg>`;
}

// Paints the live (already flex-laid-out) legend directly onto the canvas,
// leaf element by leaf element — NOT via a <foreignObject> embedded in the
// chart's SVG, which was the first approach here: Chrome taints a canvas
// against toBlob()/toDataURL() the moment it's drawn an <img> whose SVG
// contains a <foreignObject>, even when every byte of that foreignObject's
// content is inline and same-origin. That's a hard browser restriction, not
// a bug in the markup, so there's no fixing it from this side — painting
// primitives instead sidesteps it entirely.
// offsetX/offsetY position the legend's own top-left (in unscaled CSS px)
// within the destination canvas. Reads each element's REAL rect from the
// browser's own layout (already resolved the flex-wrap/centering/gaps) —
// only leaves (a swatch, or a childless text-bearing element) are drawn; an
// intermediate wrapper (.ebn0-legend-grp etc.) is just recursed through.
function _paintLegendOnCanvas(ctx, legendEl, scale, offsetX, offsetY) {
  const legendRect = legendEl.getBoundingClientRect();
  const walk = (node) => {
    const isSwatch = node.classList.contains('ebn0-legend-swatch');
    if (!isSwatch && node.children.length > 0) {
      for (const child of node.children) walk(child);
      return;
    }
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (offsetX + (r.left - legendRect.left)) * scale;
    const y = (offsetY + (r.top - legendRect.top)) * scale;
    const cs = getComputedStyle(node);
    if (isSwatch) {
      ctx.fillStyle = cs.backgroundColor;
      ctx.fillRect(x, y, r.width * scale, r.height * scale);
      return;
    }
    const text = node.textContent.trim();
    if (!text) return;
    ctx.fillStyle = cs.color;
    ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * scale}px ${cs.fontFamily}`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  };
  walk(legendEl);
}

// Rasterizes the live <svg class="ebn0-chart"> — plus, if present, its
// sibling <div class="ebn0-legend"> — to a single PNG and writes it to the
// clipboard, falling back to a plain download if the clipboard isn't
// available (see the secure-context comment further down). The SVG itself
// paints no background (it sits directly on its panel's own dark background,
// like the polar plot) and uses a percentage width/height that only resolves
// against a real layout container — neither survives being decoded
// standalone as an <img>, so a background fill and explicit pixel dimensions
// are stamped onto a clone before serializing it, leaving the live elements
// untouched. The legend (plain HTML, not SVG) is composited onto the SAME
// canvas afterward via _paintLegendOnCanvas.
//
// passInfo ({ satellite, antenna, date }, all optional) prints as a small
// right-aligned header strip above the chart — plain ctx.fillText, not DOM
// layout, since it's just 2-3 short known-in-advance lines rather than
// anything that needs real flex layout the way the legend does. A PNG copied
// out of the Analyzer is meant to stand alone (pasted into a chat/ticket,
// away from the pass it came from), so it carries which pass it is with it.
//
// Resolves to 'clipboard' or 'download' (whichever actually happened) or
// false (no chart to capture) — never rejects on a clipboard failure
// specifically, that's caught internally to trigger the download fallback;
// a genuine rejection here means something else went wrong (image decode,
// canvas, etc.) and the caller should treat it as a hard failure.
export async function copyEbn0ChartPNG(el, background = '#12121e', passInfo = null) {
  const svgEl    = el.matches?.('.ebn0-chart') ? el : el.querySelector('.ebn0-chart');
  const legendEl = el.matches?.('.ebn0-block') ? el.querySelector('.ebn0-legend') : null;
  if (!svgEl) return false;
  const svgRect    = svgEl.getBoundingClientRect();
  const legendRect = legendEl?.getBoundingClientRect();
  if (!svgRect.width || !svgRect.height) return false;

  const totalW = svgRect.width;
  const legendH = legendRect?.height ? legendRect.height + 4 : 0; // +4 breathing room between chart and legend
  const headerLines = passInfo ? [passInfo.satellite, passInfo.antenna, passInfo.date].filter(Boolean) : [];
  const HEADER_LINE_H = 12;
  const headerH = headerLines.length ? headerLines.length * HEADER_LINE_H + 6 : 0;
  const totalH = headerH + svgRect.height + legendH;
  const scale = window.devicePixelRatio || 1;
  const w = Math.round(totalW * scale), h = Math.round(totalH * scale);

  const chartClone = svgEl.cloneNode(true);
  chartClone.setAttribute('width', svgRect.width);
  chartClone.setAttribute('height', svgRect.height);
  const svgText = new XMLSerializer().serializeToString(chartClone);
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, headerH * scale, svgRect.width * scale, svgRect.height * scale);
    if (legendEl && legendRect?.height) {
      const offsetX = legendRect.left - svgRect.left; // legend's left edge relative to the chart's — normally ~0, not assumed
      _paintLegendOnCanvas(ctx, legendEl, scale, offsetX, headerH + svgRect.height + 4);
    }
    if (headerLines.length) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const padRight = 6 * scale, padTop = 3 * scale;
      headerLines.forEach((line, i) => {
        const isSatName = i === 0; // satellite name stands out; antenna/date read as secondary detail
        ctx.font = `${isSatName ? '700' : '400'} ${(isSatName ? 11 : 9.5) * scale}px 'Courier New', monospace`;
        ctx.fillStyle = isSatName ? '#e8e8f0' : '#8888aa';
        ctx.fillText(line, w - padRight, padTop + i * HEADER_LINE_H * scale);
      });
      ctx.textAlign = 'left';
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return false;
    // navigator.clipboard.write needs a "secure context" — HTTPS, or
    // localhost/127.0.0.1 specifically — which a plain-HTTP LAN/VPN address
    // (confirmed live: http://<vpn-ip>:5173) does NOT qualify as, so the API
    // is either missing entirely or its write() rejects there, even though
    // the exact same code works fine at http://localhost:5173. Rather than
    // just failing in that case, fall back to a plain browser download of
    // the same PNG — still gets the user their image, just pasted-from-
    // downloads instead of pasted-from-clipboard.
    if (window.isSecureContext && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return 'clipboard';
      } catch { /* fall through to the download below */ }
    }
    const pngUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = `ebn0-${Date.now()}.png`;
      a.click();
      return 'download';
    } finally {
      URL.revokeObjectURL(pngUrl);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Corrects marker dot sizes to an exact pixel match with the polar plot's
// dots, once this chart is actually laid out (its rendered width isn't known
// at HTML-string-build time — it stretches to fill variable flex space).
// Reads the viewBox straight off the live element rather than assuming
// CHART_W, since a caller may have built this chart at a custom width.
export function syncEbn0DotSizes(ebn0El) {
  if (!ebn0El) return;
  const rect = ebn0El.getBoundingClientRect();
  if (!rect.width) return;
  const vbWidth = ebn0El.viewBox?.baseVal?.width || CHART_W;
  const scale = vbWidth / rect.width; // viewBox units per actual rendered px
  ebn0El.querySelectorAll('.ebn0-marker-dot').forEach(el => {
    const px = el.dataset.marker === 'apogee' ? MARKER_PX_RADIUS.apogee : MARKER_PX_RADIUS.standard;
    el.setAttribute('r', (px * scale).toFixed(2));
  });
}

export function ebn0HTML(series, markers, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H, tcHistogram, tmHistogram, spanMode = 'procedures', viewRange = null) {
  const hasAny = series?.length || series2?.length;
  if (!hasAny) {
    const svg = buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width, height, tcHistogram, tmHistogram, spanMode, viewRange);
    return svg
      ? `<div class="ebn0-block">${svg}</div>`
      : `<div class="ebn0-block"><div class="co-tt-note">No Eb/N0 data found</div></div>`;
  }

  function _stats(s) {
    const vals = s.map(p => p.v);
    return {
      min: Math.min(...vals).toFixed(2),
      max: Math.max(...vals).toFixed(2),
      avg: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
    };
  }

  const tmStats = series?.length  ? _stats(series)  : null;
  const tcStats = series2?.length ? _stats(series2) : null;
  // Pass-wide totals for the histogram's own legend row — the bars
  // themselves only show a per-bucket breakdown (via each bar's <title>).
  // Bucket width is read off the data itself (tEnd - t) rather than a local
  // constant, since PassAnalyzer.js's TC_HIST_BUCKET_MS is the one place
  // that actually owns it.
  const tcHistTotals = tcHistogram?.length
    ? tcHistogram.reduce((acc, b) => ({ sent: acc.sent + b.sent, failed: acc.failed + b.failed }), { sent: 0, failed: 0 })
    : null;
  const tcHistBucketS = tcHistogram?.length ? (tcHistogram[0].tEnd - tcHistogram[0].t) / 1000 : null;
  const tmHistTotals = tmHistogram?.length
    ? tmHistogram.reduce((acc, b) => ({ received: acc.received + b.received, lost: acc.lost + b.lost }), { received: 0, lost: 0 })
    : null;
  const tmHistBucketS = tmHistogram?.length ? (tmHistogram[0].tEnd - tmHistogram[0].t) / 1000 : null;

  // One fused line instead of one row per metric — each group keeps just its
  // color swatch(es) + bare numbers (min/avg/max, or sent/failed for the
  // histograms), in the SAME order every time. Full wording moves into each
  // group's own title="" tooltip rather than disappearing. The TM/TC line
  // groups still get a short colored tag (swatch color alone read as too
  // thin a clue) — the ↑/↓ histogram groups instead share ONE green/red
  // swatch pair between them (same ok/fail meaning both times, no need to
  // repeat it) and use a visibly bigger arrow glyph as their own clue.
  const hasTcHist = !!tcHistTotals?.sent;
  const hasTmHist = !!(tmHistTotals && (tmHistTotals.received || tmHistTotals.lost));
  const legendGroups = [
    tmStats && `<span class="ebn0-legend-grp" title="TM Eb/N0 — min / avg / max">
      <span class="ebn0-legend-swatch ebn0-swatch-tm"></span><span class="ebn0-legend-tag ebn0-tag-tm">TM</span><span class="ebn0-stats">${tmStats.min}/${tmStats.avg}/${tmStats.max}dB</span>
    </span>`,
    tcStats && `<span class="ebn0-legend-grp" title="TC Eb/N0 — min / avg / max">
      <span class="ebn0-legend-swatch ebn0-swatch-tc"></span><span class="ebn0-legend-tag ebn0-tag-tc">TC</span><span class="ebn0-stats">${tcStats.min}/${tcStats.avg}/${tcStats.max}dB</span>
    </span>`,
    (hasTcHist || hasTmHist) ? `<span class="ebn0-legend-grp" title="Green = TC sent OK / TM received · Red = TC failed / TM lost">
      <span class="ebn0-legend-swatch ebn0-swatch-tc-ok"></span><span class="ebn0-legend-swatch ebn0-swatch-tc-fail"></span>
    </span>` : null,
    hasTcHist ? `<span class="ebn0-legend-grp" title="TC sent ↑ (${tcHistBucketS}s buckets) — sent / failed">
      <span class="ebn0-legend-arrow">↑</span><span class="ebn0-stats">${tcHistTotals.sent}/${tcHistTotals.failed}</span>
    </span>` : null,
    hasTmHist ? `<span class="ebn0-legend-grp" title="TM received ↓ (${tmHistBucketS}s buckets) — received / lost">
      <span class="ebn0-legend-arrow">↓</span><span class="ebn0-stats">${tmHistTotals.received}/${tmHistTotals.lost}</span>
    </span>` : null,
  ].filter(Boolean);

  return `<div class="ebn0-block">
    ${buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width, height, tcHistogram, tmHistogram, spanMode, viewRange)}
    <div class="ebn0-legend">
      <div class="ebn0-legend-row">${legendGroups.join('<span class="ebn0-legend-sep">·</span>')}</div>
    </div>
  </div>`;
}
