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

export async function fetchTcEbn0Series(noradId, startMs, endMs) {
  const key = `tc|${noradId}|${startMs}|${endMs}`;
  if (_tcCache.has(key)) return _tcCache.get(key);

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
// `width`/`height` default to CHART_W/CHART_H (every existing caller) — a
// caller building a differently-proportioned chart (e.g. a wide full-width
// one) passes its own, and must pass the SAME values to every other function
// here that also takes them, so everything stays mapped through one scale.
export function ebn0Scales(series, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H) {
  let t0, t1;
  if (series?.length) {
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
function _procedureBars(procedures, xScale, t0, t1, height = CHART_H) {
  if (!procedures?.length) return '';
  const y = height - PAD_B + BAR_ROW_GAP;
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
export function buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H) {
  const hasSeries  = !!series?.length;
  const hasSeries2 = !!series2?.length;
  if (!hasSeries && !hasSeries2 && !procedures?.length && !fallbackRange) return '';
  const { xScale, yScale, lo, hi, t0, t1 } = ebn0Scales(series, procedures, fallbackRange, series2, width, height);
  const pathD  = hasSeries  ? series.map( (p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('') : '';
  const pathD2 = hasSeries2 ? series2.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('') : '';
  const hasBars = procedures?.some(pr => pr.startMs != null && pr.endMs != null);
  const totalH  = hasBars ? (height - PAD_B + BAR_ROW_GAP + BAR_ROW_H + BAR_BOTTOM_PAD) : height;
  const hasAny  = hasSeries || hasSeries2;

  return `<svg width="100%" height="${totalH}" viewBox="0 0 ${width} ${totalH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="ebn0-chart">
    ${hasAny ? `<text x="${PAD_L - 4}" y="${PAD_T + 3}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${hi.toFixed(1)}</text>
    <text x="${PAD_L - 4}" y="${height - PAD_B}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${lo.toFixed(1)}</text>` : ''}
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${height - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    <line x1="${PAD_L}" y1="${height - PAD_B}" x2="${width - PAD_R}" y2="${height - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    ${hasSeries2 ? `<path d="${pathD2}" fill="none" stroke="#4ad4ff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85"/>` : ''}
    ${hasSeries  ? `<path d="${pathD}"  fill="none" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    ${_markerDots(series, markers, xScale, yScale)}` : ''}
    ${!hasAny ? `<text x="${(PAD_L + width - PAD_R) / 2}" y="${(PAD_T + height - PAD_B) / 2}" text-anchor="middle" dominant-baseline="middle" fill="#4a4a6a" font-size="9" font-family="monospace" font-style="italic">(No Eb/N0 metric)</text>` : ''}
    ${hasBars ? _procedureBars(procedures, xScale, t0, t1, height) : ''}
    <line class="ebn0-cursor-line" x1="0" y1="${PAD_T}" x2="0" y2="${height - PAD_B}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.7" stroke-dasharray="2,2" visibility="hidden"/>
    <circle class="ebn0-cursor-dot"  r="${MARKER_PX_RADIUS.cursor}" fill="#fff" stroke="#a78bfa" stroke-width="0.8" visibility="hidden"/>
    <circle class="ebn0-cursor-dot2" r="${MARKER_PX_RADIUS.cursor}" fill="#fff" stroke="#4ad4ff" stroke-width="0.8" visibility="hidden"/>
    <rect  class="ebn0-cursor-label-bg"  width="1" height="9" rx="1.5" fill="#12121e" stroke="#2a2a4a" stroke-width="0.5" visibility="hidden"/>
    <text  class="ebn0-cursor-text"  x="0" y="0" font-size="6.5" font-family="monospace" fill="#a78bfa" text-anchor="middle" visibility="hidden"></text>
    <rect  class="ebn0-cursor-label-bg2" width="1" height="9" rx="1.5" fill="#12121e" stroke="#2a2a4a" stroke-width="0.5" visibility="hidden"/>
    <text  class="ebn0-cursor-text2" x="0" y="0" font-size="6.5" font-family="monospace" fill="#4ad4ff" text-anchor="middle" visibility="hidden"></text>
    <rect class="ebn0-hit" x="${PAD_L}" y="${PAD_T}" width="${width - PAD_L - PAD_R}" height="${height - PAD_T - PAD_B}" fill="transparent"/>
  </svg>`;
}

// Corrects marker/cursor dot sizes to an exact pixel match with the polar
// plot's dots, once this chart is actually laid out (its rendered width isn't
// known at HTML-string-build time — it stretches to fill variable flex space).
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
  const cursorDot = ebn0El.querySelector('.ebn0-cursor-dot');
  if (cursorDot) cursorDot.setAttribute('r', (MARKER_PX_RADIUS.cursor * scale).toFixed(2));
  const cursorDot2 = ebn0El.querySelector('.ebn0-cursor-dot2');
  if (cursorDot2) cursorDot2.setAttribute('r', (MARKER_PX_RADIUS.cursor * scale).toFixed(2));
}

export function ebn0HTML(series, markers, procedures, fallbackRange, series2, width = CHART_W, height = CHART_H) {
  const hasAny = series?.length || series2?.length;
  if (!hasAny) {
    const svg = buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width, height);
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

  return `<div class="ebn0-block">
    ${buildEbn0SVG(series, markers, procedures, fallbackRange, series2, width, height)}
    <div class="ebn0-legend">
      ${tmStats ? `<div class="ebn0-legend-row">
        <span class="ebn0-legend-swatch ebn0-swatch-tm"></span>
        <span class="ebn0-legend-label ebn0-label-tm">TM Eb/N0</span>
        <span class="ebn0-stats">min ${tmStats.min} · avg ${tmStats.avg} · max ${tmStats.max} dB</span>
      </div>` : ''}
      ${tcStats ? `<div class="ebn0-legend-row">
        <span class="ebn0-legend-swatch ebn0-swatch-tc"></span>
        <span class="ebn0-legend-label ebn0-label-tc">TC Eb/N0</span>
        <span class="ebn0-stats">min ${tcStats.min} · avg ${tcStats.avg} · max ${tcStats.max} dB</span>
      </div>` : ''}
    </div>
  </div>`;
}
