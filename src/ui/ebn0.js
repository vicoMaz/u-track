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
import { satSubsystemOrigin } from '../satSubsystems.js';
import { MARKER_COLORS, MARKER_PX_RADIUS } from './passPolar.js';

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
// RF-chain metrics at all. ksat/skynopy have no equivalent metric recorded for
// this satellite yet (empty in /filters) — nothing to query for those.
const EBN0_METRIC_BY_NETWORK = {
  leaf: 'ebn0',
  minimum: 'eb_n0_ratio',
};

const _cache = new Map(); // `${noradId}|${startMs}|${endMs}|${network}` → [{t,v}] | null

export async function fetchEbn0Series(noradId, startMs, endMs, network) {
  const metricName = EBN0_METRIC_BY_NETWORK[network];
  if (!metricName) return null;
  const key = `${noradId}|${startMs}|${endMs}|${network}`;
  if (_cache.has(key)) return _cache.get(key);
  const rows = await _fetchMetric(noradId, metricName, startMs, endMs, 8000);
  const series = rows
    ? rows.map(r => ({ t: new Date(r.timestamp).getTime(), v: r.value })).sort((a, b) => a.t - b.t)
    : [];
  const result = series.length ? series : null;
  _cache.set(key, result);
  return result;
}

// CHART_W is an internal viewBox unit, not a pixel size — the SVG renders at
// width:100% (see buildEbn0SVG) so it stretches to fill whatever the flex
// layout gives it, without hardcoding (and without growing) the tooltip.
// Exported so the linked-cursor wiring (passCursor.js) can convert mouse
// position ↔ viewBox coordinates without duplicating these constants.
export const CHART_W = 300, CHART_H = 190;
export const PAD_L = 26, PAD_R = 6, PAD_T = 8, PAD_B = 14;

// Procedure-execution strip drawn below the main plot area (only when the
// pass has procedures) — numbered bars 1,2,3... spanning each procedure's
// start→end, on the same time axis as the Eb/N0 curve above them. Anchored
// to the x-axis line itself (CHART_H - PAD_B), not the outer CHART_H — PAD_B
// exists to leave room for the y-axis "lo" label, which sits to the left of
// the axis, not below it, so the bars can sit right under the line.
const BAR_ROW_GAP = 3, BAR_ROW_H = 11, BAR_BOTTOM_PAD = 2;
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
export function ebn0Scales(series, procedures, fallbackRange) {
  let t0, t1;
  if (series?.length) {
    t0 = series[0].t;
    t1 = series[series.length - 1].t;
  } else if (fallbackRange) {
    ({ t0, t1 } = fallbackRange);
  } else {
    t0 = 0; t1 = 1;
  }
  if (procedures?.length) {
    for (const pr of procedures) {
      if (pr.startMs != null) t0 = Math.min(t0, pr.startMs);
      if (pr.endMs   != null) t1 = Math.max(t1, pr.endMs);
    }
  }
  const vals = series?.length ? series.map(s => s.v) : null;
  const vMin = vals ? Math.min(...vals) : 0;
  const vMax = vals ? Math.max(...vals) : 1;
  const vPad = vals ? Math.max(0.2, (vMax - vMin) * 0.15) : 0;
  const lo = vMin - vPad, hi = vMax + vPad;
  const xScale = t => t1 === t0 ? PAD_L : PAD_L + (t - t0) / (t1 - t0) * (CHART_W - PAD_L - PAD_R);
  const yScale = v => CHART_H - PAD_B - (hi === lo ? 0 : (v - lo) / (hi - lo) * (CHART_H - PAD_T - PAD_B));
  return { t0, t1, lo, hi, xScale, yScale };
}

function _nearestByTime(points, t) {
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
    const p = _nearestByTime(series, marker.t);
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
function _procedureBars(procedures, xScale, t0, t1) {
  if (!procedures?.length) return '';
  const y = CHART_H - PAD_B + BAR_ROW_GAP;
  return procedures.map((pr, i) => {
    if (pr.startMs == null || pr.endMs == null) return '';
    const s = Math.max(pr.startMs, t0), e = Math.min(pr.endMs, t1);
    if (e <= s) return '';
    const x1 = xScale(s);
    const w  = Math.max(xScale(e) - x1, 1.5);
    const color = _PROC_BAR_COLOR[pr.status] ?? _PROC_BAR_COLOR.SUCCESS;
    const cx = x1 + w / 2;
    return `<g class="ebn0-proc-bar">
      <rect x="${x1.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BAR_ROW_H}" rx="2" fill="${color}" fill-opacity="0.28" stroke="${color}" stroke-width="0.7"><title>${i + 1}. ${pr.name ?? ''}</title></rect>
      <text class="ebn0-proc-num" x="${cx.toFixed(1)}" y="${(y + BAR_ROW_H / 2 + 2.6).toFixed(1)}" text-anchor="middle">${i + 1}</text>
    </g>`;
  }).join('');
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
export function buildEbn0SVG(series, markers, procedures, fallbackRange) {
  const hasSeries = !!series?.length;
  if (!hasSeries && !procedures?.length && !fallbackRange) return '';
  const { xScale, yScale, lo, hi, t0, t1 } = ebn0Scales(series, procedures, fallbackRange);
  const pathD = hasSeries ? series.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('') : '';
  const hasBars = procedures?.some(pr => pr.startMs != null && pr.endMs != null);
  const totalH = hasBars ? (CHART_H - PAD_B + BAR_ROW_GAP + BAR_ROW_H + BAR_BOTTOM_PAD) : CHART_H;

  return `<svg width="100%" height="${totalH}" viewBox="0 0 ${CHART_W} ${totalH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="ebn0-chart">
    ${hasSeries ? `<text x="${PAD_L - 4}" y="${PAD_T + 3}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${hi.toFixed(1)}</text>
    <text x="${PAD_L - 4}" y="${CHART_H - PAD_B}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${lo.toFixed(1)}</text>` : ''}
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${CHART_H - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    <line x1="${PAD_L}" y1="${CHART_H - PAD_B}" x2="${CHART_W - PAD_R}" y2="${CHART_H - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    ${hasSeries ? `<path d="${pathD}" fill="none" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    ${_markerDots(series, markers, xScale, yScale)}` : `<text x="${(PAD_L + CHART_W - PAD_R) / 2}" y="${(PAD_T + CHART_H - PAD_B) / 2}" text-anchor="middle" dominant-baseline="middle" fill="#4a4a6a" font-size="9" font-family="monospace" font-style="italic">(No Eb/N0 metric)</text>`}
    ${hasBars ? _procedureBars(procedures, xScale, t0, t1) : ''}
    <line class="ebn0-cursor-line" x1="0" y1="${PAD_T}" x2="0" y2="${CHART_H - PAD_B}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.7" stroke-dasharray="2,2" visibility="hidden"/>
    <circle class="ebn0-cursor-dot" r="${MARKER_PX_RADIUS.cursor}" fill="#fff" stroke="#a78bfa" stroke-width="0.8" visibility="hidden"/>
    <rect class="ebn0-cursor-label-bg" width="1" height="10" rx="2" fill="#12121e" stroke="#2a2a4a" stroke-width="0.6" visibility="hidden"/>
    <text class="ebn0-cursor-text" x="0" y="${PAD_T - 2}" font-size="6.5" font-family="monospace" fill="#ddd" text-anchor="middle" visibility="hidden"></text>
    <rect class="ebn0-hit" x="${PAD_L}" y="${PAD_T}" width="${CHART_W - PAD_L - PAD_R}" height="${CHART_H - PAD_T - PAD_B}" fill="transparent"/>
  </svg>`;
}

// Corrects marker/cursor dot sizes to an exact pixel match with the polar
// plot's dots, once this chart is actually laid out (its rendered width isn't
// known at HTML-string-build time — it stretches to fill variable flex space).
export function syncEbn0DotSizes(ebn0El) {
  if (!ebn0El) return;
  const rect = ebn0El.getBoundingClientRect();
  if (!rect.width) return;
  const scale = CHART_W / rect.width; // viewBox units per actual rendered px
  ebn0El.querySelectorAll('.ebn0-marker-dot').forEach(el => {
    const px = el.dataset.marker === 'apogee' ? MARKER_PX_RADIUS.apogee : MARKER_PX_RADIUS.standard;
    el.setAttribute('r', (px * scale).toFixed(2));
  });
  const cursorDot = ebn0El.querySelector('.ebn0-cursor-dot');
  if (cursorDot) cursorDot.setAttribute('r', (MARKER_PX_RADIUS.cursor * scale).toFixed(2));
}

export function ebn0HTML(series, markers, procedures, fallbackRange) {
  if (!series?.length) {
    const svg = buildEbn0SVG(series, markers, procedures, fallbackRange);
    return svg
      ? `<div class="ebn0-block">${svg}</div>`
      : `<div class="ebn0-block"><div class="co-tt-note">No Eb/N0 data found</div></div>`;
  }
  const vals = series.map(s => s.v);
  const min = Math.min(...vals).toFixed(2);
  const max = Math.max(...vals).toFixed(2);
  const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  return `<div class="ebn0-block">
    ${buildEbn0SVG(series, markers, procedures, fallbackRange)}
    <div class="ebn0-legend">
      <span class="ebn0-legend-swatch"></span><span class="ebn0-legend-label">TM Eb/N0</span>
      <span class="ebn0-stats">min ${min} · mean ${avg} · max ${max} dB</span>
    </div>
  </div>`;
}
