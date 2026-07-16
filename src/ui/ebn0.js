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
import { MARKER_COLORS } from './passPolar.js';

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

// Matches passPolar.js's marker dot sizes exactly (apogee is drawn slightly
// larger there too) so the same moment reads as the same-sized dot on both charts.
const MARKER_RADIUS = { aos: 2.5, los: 2.5, maskEntry: 2.5, maskExit: 2.5, apogee: 3 };

// Exported so passCursor.js can compute x/y for an arbitrary point (e.g. one
// snapped from the polar plot) without re-deriving the value/time scale.
export function ebn0Scales(series) {
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const vMin = Math.min(...series.map(s => s.v));
  const vMax = Math.max(...series.map(s => s.v));
  const vPad = Math.max(0.2, (vMax - vMin) * 0.15);
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
function _markerDots(series, markers) {
  if (!markers) return '';
  return Object.entries(MARKER_COLORS).map(([key, color]) => {
    const marker = markers[key];
    if (!marker) return '';
    const { xScale, yScale } = ebn0Scales(series);
    const p = _nearestByTime(series, marker.t);
    const x = xScale(p.t), y = yScale(p.v);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${MARKER_RADIUS[key]}" fill="${color}" stroke="#12121e" stroke-width="0.6"/>`;
  }).join('');
}

// No background/border — sits directly on the tooltip's own dark background,
// like the polar plot. A transparent hit-rect drives the shared hover cursor
// (see passCursor.js), wired up separately once this markup is in the live DOM.
export function buildEbn0SVG(series, markers) {
  if (!series?.length) return '';
  const { xScale, yScale, lo, hi } = ebn0Scales(series);
  const pathD = series.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join('');

  return `<svg width="100%" height="${CHART_H}" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="ebn0-chart">
    <text x="${PAD_L - 4}" y="${PAD_T + 3}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${hi.toFixed(1)}</text>
    <text x="${PAD_L - 4}" y="${CHART_H - PAD_B}" text-anchor="end" fill="#5a5a8a" font-size="7" font-family="monospace">${lo.toFixed(1)}</text>
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${CHART_H - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    <line x1="${PAD_L}" y1="${CHART_H - PAD_B}" x2="${CHART_W - PAD_R}" y2="${CHART_H - PAD_B}" stroke="#2a2a44" stroke-width="0.7"/>
    <path d="${pathD}" fill="none" stroke="#a78bfa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    ${_markerDots(series, markers)}
    <line class="ebn0-cursor-line" x1="0" y1="${PAD_T}" x2="0" y2="${CHART_H - PAD_B}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.7" stroke-dasharray="2,2" visibility="hidden"/>
    <circle class="ebn0-cursor-dot" r="3" fill="#fff" stroke="#a78bfa" stroke-width="0.8" visibility="hidden"/>
    <rect class="ebn0-cursor-label-bg" width="1" height="10" rx="2" fill="#12121e" stroke="#2a2a4a" stroke-width="0.6" visibility="hidden"/>
    <text class="ebn0-cursor-text" x="0" y="${PAD_T - 2}" font-size="6.5" font-family="monospace" fill="#ddd" text-anchor="middle" visibility="hidden"></text>
    <rect class="ebn0-hit" x="${PAD_L}" y="${PAD_T}" width="${CHART_W - PAD_L - PAD_R}" height="${CHART_H - PAD_T - PAD_B}" fill="transparent"/>
  </svg>`;
}

export function ebn0HTML(series, markers) {
  if (!series?.length) {
    return `<div class="ebn0-block">
      <div class="co-tt-note">No Eb/N0 data found</div>
    </div>`;
  }
  const vals = series.map(s => s.v);
  const min = Math.min(...vals).toFixed(2);
  const max = Math.max(...vals).toFixed(2);
  const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  return `<div class="ebn0-block">
    ${buildEbn0SVG(series, markers)}
    <div class="ebn0-stats">min ${min} · avg ${avg} · max ${max} dB</div>
  </div>`;
}
