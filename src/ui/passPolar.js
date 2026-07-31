import { propagate } from '../tle.js';
import { satSubsystemOrigin } from '../satSubsystems.js';

// ── GMST + Az/El ─────────────────────────────────────────────────────────────

function _gmstRad(date) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T  = (JD - 2451545.0) / 36525;
  const g  = 280.46061837 + 360.98564736629 * (JD - 2451545.0)
           + 0.000387933 * T * T - T * T * T / 38710000;
  return ((g % 360) + 360) % 360 * (Math.PI / 180);
}

function _azel(satrec, lat, lon, date) {
  const pos = propagate(satrec, date);
  if (!pos) return null;
  const { x, y, z } = pos.eciPos;
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  const θ = _gmstRad(date);
  const sx =  x * Math.cos(θ) + y * Math.sin(θ);
  const sy = -x * Math.sin(θ) + y * Math.cos(θ);
  const sz = z;
  const Re = 6378.137;
  const ox = Re * Math.cos(φ) * Math.cos(λ);
  const oy = Re * Math.cos(φ) * Math.sin(λ);
  const oz = Re * Math.sin(φ);
  const dx = sx - ox, dy = sy - oy, dz = sz - oz;
  const cφ = Math.cos(φ), sφ = Math.sin(φ), cλ = Math.cos(λ), sλ = Math.sin(λ);
  const S =  sφ*cλ*dx + sφ*sλ*dy - cφ*dz;
  const E = -sλ*dx    + cλ*dy;
  const Z =  cφ*cλ*dx + cφ*sλ*dy + sφ*dz;
  const rng = Math.sqrt(S*S + E*E + Z*Z);
  if (rng < 1) return null;
  return {
    az: ((Math.atan2(E, -S) * 180 / Math.PI) + 360) % 360,
    el:   Math.asin(Math.max(-1, Math.min(1, Z / rng))) * 180 / Math.PI,
  };
}

// ── Async coord + mask resolver ───────────────────────────────────────────────

// `${noradId}:${station}` → {lat, lon, rxMask?}
const _coordsCache   = new Map();
// host → Promise<Array> dedupe
const _antennaPending = new Map();
// host → Array of antenna objects
const _antennaCache  = new Map();

async function _getFdsAntennas(host) {
  if (_antennaCache.has(host)) return _antennaCache.get(host);
  if (_antennaPending.has(host)) return _antennaPending.get(host);
  const p = fetch(`${host}/api/v1/data/antennas`, { signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .then(data => {
      const list = Array.isArray(data) ? data : (data?.antennas ?? data?.items ?? []);
      _antennaCache.set(host, list);
      _antennaPending.delete(host);
      return list;
    });
  _antennaPending.set(host, p);
  return p;
}

async function _fetchMask(host, antennaId) {
  try {
    const res = await fetch(
      `${host}/api/v1/data/antennas/mask/${encodeURIComponent(antennaId)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.rx_mask ?? data.rxMask ?? null;
  } catch { return null; }
}

// Finds the FDS antenna matching a station code/name — shared by both the
// mask lookup and the lat/lon fallback below, so there's exactly one
// matching rule instead of two that could disagree.
function _matchAntenna(antennas, station) {
  const stLC = station.toLowerCase();
  return antennas.find(a => a.local_id === station || a.remote_id === station)
    ?? antennas.find(a => a.location?.site_id === station)
    ?? antennas.find(a => {
      const id = (a.local_id ?? a.remote_id ?? '').toLowerCase();
      return id && (id.includes(stLC) || stLC.includes(id));
    });
}

// `${host}:${antennaId}` → rx_mask array | null
const _maskCache = new Map();

async function _resolveMask(host, antennas, station) {
  const antenna = _matchAntenna(antennas, station);
  if (!antenna) return { antenna: null, mask: null };
  const antennaId = antenna.local_id ?? antenna.remote_id ?? station;
  const cacheKey = `${host}:${antennaId}`;
  if (_maskCache.has(cacheKey)) return { antenna, mask: _maskCache.get(cacheKey) };
  const mask = await _fetchMask(host, antennaId);
  _maskCache.set(cacheKey, mask);
  return { antenna, mask };
}

/**
 * Resolve ground station lat/lon AND rx_mask for a pass.
 * Strategy:
 *   1. lat/lon from store.groundStations if already loaded (fast, no fetch)
 *   2. rx_mask ALWAYS resolved via the FDS antenna list + mask endpoint,
 *      regardless of where lat/lon came from — mask crossings used to only
 *      show up when the slower FDS path also happened to be the one that
 *      supplied lat/lon, so the same pass could show antenna-mask AOS/LOS
 *      in one place and not another depending on whether store.groundStations
 *      happened to already have this station cached at that exact moment.
 *   3. lat/lon falls back to the matched FDS antenna's coordinates if step 1
 *      didn't resolve them
 * Returns {lat, lon, rxMask} or null. Cached (both lat/lon and mask) so
 * repeat calls for the same pass — e.g. the hover tooltip and then the
 * detail panel a moment later — get the identical result instead of two
 * independent, potentially-differently-timed resolutions.
 */
export async function fetchPassGsCoords(sat, pass, groundStations) {
  const station = pass.station;
  if (!station || station === '—') return null;

  let lat = null, lon = null;
  if (groundStations?.length) {
    const stLC = station.toLowerCase();
    const gs = groundStations.find(g =>
      g.satId === sat.id &&
      g.name.toLowerCase() === stLC &&
      (pass.network == null || g.network === pass.network)
    ) ?? groundStations.find(g =>
      g.satId === sat.id && g.name.toLowerCase() === stLC
    );
    if (gs) { lat = gs.lat; lon = gs.lon; }
  }

  const host = satSubsystemOrigin(sat.noradId, 'gnm');
  if (!host) return lat != null ? { lat, lon, rxMask: null } : null;

  const cacheKey = `${sat.noradId}:${station}`;
  if (_coordsCache.has(cacheKey)) return _coordsCache.get(cacheKey);

  try {
    const antennas = await _getFdsAntennas(host);
    const { antenna, mask } = await _resolveMask(host, antennas, station);

    if (lat == null) {
      if (!antenna) {
        const ids = antennas.map(a => a.local_id ?? a.remote_id ?? '?');
        console.warn('[polar] no antenna matched', JSON.stringify(station), '— FDS local_ids:', ids);
        return null;
      }
      const coordsObj = antenna.location?.coordinates ?? antenna.location ?? {};
      lat = coordsObj.latitude  ?? coordsObj.lat  ?? null;
      lon = coordsObj.longitude ?? coordsObj.lon  ?? null;
      if (lat == null) console.warn('[polar] antenna found but no coords — location:', antenna.location);
    }

    const coords = { lat, lon, rxMask: mask };
    if (lat != null) _coordsCache.set(cacheKey, coords);
    return lat != null ? coords : null;
  } catch {
    return lat != null ? { lat, lon, rxMask: null } : null;
  }
}

// ── Synchronous SVG builder ───────────────────────────────────────────────────

// Shared polar-canvas geometry — exported so linked-cursor wiring (passCursor.js)
// can convert between mouse position and canvas coordinates without duplicating
// these constants.
export const POLAR_VIEWBOX = 130;
const POLAR_RENDER_PX = 200; // <svg width="200"> below — the polar plot's fixed rendered size
const CX = 65, CY = 65, R = 54;
const DOT_R = 2.5, APOGEE_DOT_R = 3, CURSOR_DOT_R = 3; // in viewBox units

// Marker dot sizes as ACTUAL RENDERED PIXELS (not viewBox units) — the polar
// plot renders at a fixed 200px regardless of viewBox, so this scale factor
// is constant. Exported so ebn0.js can size its own AOS/LOS/mask/apogee dots
// to match: the Eb/N0 chart stretches to fill variable flex space
// (width:100%, viewBox 300 units), so its viewBox-unit-to-pixel ratio is
// different and changes with layout — using the same *number* of viewBox
// units on both charts does NOT produce the same *visual* size.
export const MARKER_PX_RADIUS = {
  standard: DOT_R * (POLAR_RENDER_PX / POLAR_VIEWBOX),
  apogee: APOGEE_DOT_R * (POLAR_RENDER_PX / POLAR_VIEWBOX),
};

function _toXY(az, el) {
  const r = R * (1 - el / 90);
  const a = az * Math.PI / 180;
  return [+(CX + r * Math.sin(a)).toFixed(1), +(CY - r * Math.cos(a)).toFixed(1)];
}

// Sampled az/el trajectory for a pass, each point tagged with its timestamp and
// canvas (x,y) — the same sampling buildPolarSVG uses, exposed so external code
// (the linked Eb/N0 cursor) can map mouse position ↔ time without re-propagating.
export function computePolarPoints(pass, sat, lat, lon) {
  const t0 = (pass.start instanceof Date ? pass.start : new Date(pass.start)).getTime();
  const t1 = (pass.end   instanceof Date ? pass.end   : new Date(pass.end)).getTime();
  const pts = [];
  for (let t = t0; t <= t1 + 15_000; t += 30_000) {
    const tc = Math.min(t, t1);
    const ae = _azel(sat.satrec, lat, lon, new Date(tc));
    if (ae && ae.el >= 0) {
      const [x, y] = _toXY(ae.az, ae.el);
      pts.push({ t: tc, az: ae.az, el: ae.el, x, y });
    }
  }
  return pts;
}

// Colors for the AOS/LOS/mask-entry/mask-exit/apogee markers — exported so the
// Eb/N0 chart (ebn0.js) can dot the same moments in the same colors, letting a
// dip/spike there be read against a specific point in the pass geometry.
export const MARKER_COLORS = {
  aos: '#00ff9d',
  los: '#ff6060',
  maskEntry: '#00cfff',
  maskExit: '#ff9900',
  apogee: '#ffe066',
};

// AOS/LOS/apogee/mask-entry/mask-exit — the same "moments of interest" the
// polar plot marks, computed once so ebn0.js can dot its own chart at the
// matching timestamps with the matching colors.
export function computePolarMarkers(pts, rxMask) {
  if (!pts?.length) return null;
  const aos = pts[0];
  const los = pts[pts.length - 1];
  let apogee = pts[0];
  for (const p of pts) if (p.el > apogee.el) apogee = p;

  let maskEntry = null, maskExit = null;
  if (Array.isArray(rxMask) && rxMask.length >= 360) {
    for (const p of pts) {
      const minEl = rxMask[Math.round(p.az) % 360] ?? 0;
      if (p.el >= minEl) { if (!maskEntry) maskEntry = p; maskExit = p; }
    }
  }
  return { aos, los, apogee, maskEntry, maskExit };
}

/**
 * Build the polar plot SVG given explicit lat/lon and optional rx_mask array.
 * rxMask: 360-element array where rxMask[az] = min elevation (deg) at that azimuth.
 * Returns an SVG string, or '' if not enough elevation points.
 */
export function buildPolarSVG(pass, sat, lat, lon, rxMask) {
  const r30 = +(R * 2/3).toFixed(1);
  const r60 = +(R * 1/3).toFixed(1);

  const pts = computePolarPoints(pass, sat, lat, lon);
  if (pts.length < 2) return '';

  const toXY = ({az, el}) => _toXY(az, el);

  const pathD   = pts.map((p, i) => { const [x,y]=toXY(p); return `${i?'L':'M'}${x},${y}`; }).join('');
  const { aos, los, apogee, maskEntry, maskExit } = computePolarMarkers(pts, rxMask);
  const [ax,ay]   = toXY(aos);
  const [lx,ly]   = toXY(los);
  const [apx,apy] = toXY(apogee);

  // Label placed radially outward from centre
  const radLabel = (x, y, text, color) => {
    const dx = x - CX, dy = y - CY;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    const ox = +(x + dx/d * 10).toFixed(1);
    const oy = +(y + dy/d * 10).toFixed(1);
    const anchor = dx > 1 ? 'start' : dx < -1 ? 'end' : 'middle';
    return `<text x="${ox}" y="${oy}" text-anchor="${anchor}" fill="${color}" font-size="7" font-family="monospace">${text}</text>`;
  };

  // Build antenna mask polygon (blocked region = shaded outward from mask boundary)
  let maskSVG = '';
  if (Array.isArray(rxMask) && rxMask.length >= 360) {
    const maskPts  = Array.from({ length: 360 }, (_, az) => toXY({ az, el: Math.max(0, Math.min(90, rxMask[az] ?? 0)) }));
    const outerPts = Array.from({ length: 360 }, (_, az) => toXY({ az, el: 0 }));
    const maskPath  = maskPts.map( ([x,y], i) => `${i?'L':'M'}${x},${y}`).join('') + 'Z';
    const outerPath = outerPts.map(([x,y], i) => `${i?'L':'M'}${x},${y}`).join('') + 'Z';
    maskSVG = `<path d="${outerPath} ${maskPath}" fill="rgba(255,80,40,0.18)" fill-rule="evenodd" stroke="none"/>
    <path d="${maskPath}" fill="none" stroke="rgba(255,100,50,0.55)" stroke-width="0.8"/>`;
  }

  // Mask entry/exit marker SVG. Label the satellite's own sampled elevation
  // at the crossing point (maskEntry.el/maskExit.el) — NOT rxMask[az], the
  // mask's threshold elevation at that azimuth. The two are close by
  // construction (a crossing is where sat el first reaches the mask's minEl)
  // but not identical, since points are only sampled every 30s and the mask
  // varies continuously with azimuth — using rxMask[az] here made this label
  // disagree with the tooltip's one-liner, which (correctly) shows the same
  // maskEntry/maskExit points' .el.
  let maskMarkerSVG = '';
  if (maskEntry && maskExit) {
    const [mex, mey] = toXY(maskEntry);
    const [mlx, mly] = toXY(maskExit);
    const elIn  = maskEntry.el.toFixed(0);
    const elOut = maskExit.el.toFixed(0);
    maskMarkerSVG = `
    <circle cx="${mex}" cy="${mey}" r="${DOT_R}" fill="${MARKER_COLORS.maskEntry}"/>
    ${radLabel(mex, mey, `▲${elIn}°`, MARKER_COLORS.maskEntry)}
    <circle cx="${mlx}" cy="${mly}" r="${DOT_R}" fill="${MARKER_COLORS.maskExit}"/>
    ${radLabel(mlx, mly, `▼${elOut}°`, MARKER_COLORS.maskExit)}`;
  }

  return `<svg width="200" height="200" viewBox="0 0 ${POLAR_VIEWBOX} ${POLAR_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" class="pass-polar">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="#0c0c1c" stroke="#2a2a44" stroke-width="0.8"/>
    ${maskSVG}
    <circle cx="${CX}" cy="${CY}" r="${r30}" fill="none" stroke="#1e1e38" stroke-width="0.7" stroke-dasharray="2,2"/>
    <circle cx="${CX}" cy="${CY}" r="${r60}" fill="none" stroke="#1e1e38" stroke-width="0.7" stroke-dasharray="2,2"/>
    <line x1="${CX}" y1="${CY-R}" x2="${CX}" y2="${CY+R}" stroke="#1e1e38" stroke-width="0.7"/>
    <line x1="${CX-R}" y1="${CY}" x2="${CX+R}" y2="${CY}" stroke="#1e1e38" stroke-width="0.7"/>
    <text x="${CX}" y="${CY-R-3}" text-anchor="middle" fill="#5a5a8a" font-size="8" font-family="monospace">N</text>
    <text x="${CX}" y="${CY+R+9}" text-anchor="middle" fill="#5a5a8a" font-size="8" font-family="monospace">S</text>
    <text x="${CX+R+5}" y="${CY+3}" text-anchor="start" fill="#5a5a8a" font-size="8" font-family="monospace">E</text>
    <text x="${CX-R-5}" y="${CY+3}" text-anchor="end"   fill="#5a5a8a" font-size="8" font-family="monospace">W</text>
    <text x="${CX+r30+2}" y="${CY-1}" fill="#2e2e52" font-size="6" font-family="monospace">30°</text>
    <text x="${CX+r60+2}" y="${CY-1}" fill="#2e2e52" font-size="6" font-family="monospace">60°</text>
    <path d="${pathD}" fill="none" stroke="#ff3060" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${ax}" cy="${ay}" r="${DOT_R}" fill="${MARKER_COLORS.aos}"/>
    <circle cx="${lx}" cy="${ly}" r="${DOT_R}" fill="${MARKER_COLORS.los}"/>
    ${maskMarkerSVG}
    <circle cx="${apx}" cy="${apy}" r="${APOGEE_DOT_R}" fill="${MARKER_COLORS.apogee}"/>
    ${radLabel(apx, apy, `${apogee.el.toFixed(0)}°`, MARKER_COLORS.apogee)}
    <circle class="polar-cursor-dot" r="${CURSOR_DOT_R}" fill="#fff" stroke="#ff3060" stroke-width="1" visibility="hidden"/>
    <rect class="polar-cursor-label-bg" width="1" height="9" rx="2" fill="#12121e" stroke="#2a2a4a" stroke-width="0.6" visibility="hidden"/>
    <text class="polar-cursor-text" x="0" y="0" font-size="6" font-family="monospace" fill="#ddd" text-anchor="middle" visibility="hidden"></text>
    <circle class="polar-hit" cx="${CX}" cy="${CY}" r="${R}" fill="transparent"/>
  </svg>`;
}

// ── Cartesian (azimuth/elevation) plot — the polar plot's alternate view ───
// Same underlying geometry (same pts/markers/rxMask, see computePolarPoints/
// computePolarMarkers above) — just plotted as X=azimuth, Y=elevation instead
// of radially. Opened from the polar plot's "⤢ Cartesian" button (see
// passAzElModal.js) as a standalone, larger view — deliberately NOT wired
// into passCursor.js's linked-cursor/Eb0 pairing; it's a simple self-
// contained alternate read of the same pass, not a second interactive chart.
const AZEL_W = 640, AZEL_H = 340;
const AZEL_PAD_L = 36, AZEL_PAD_R = 14, AZEL_PAD_T = 14, AZEL_PAD_B = 56;
const AZEL_CHART_W = AZEL_W - AZEL_PAD_L - AZEL_PAD_R;
const AZEL_CHART_H = AZEL_H - AZEL_PAD_T - AZEL_PAD_B;

/**
 * Build the Cartesian az/el plot SVG. Same signature as buildPolarSVG.
 * Returns an SVG string, or '' if not enough elevation points.
 */
export function buildAzElSVG(pass, sat, lat, lon, rxMask) {
  const pts = computePolarPoints(pass, sat, lat, lon);
  if (pts.length < 2) return '';

  const maskVals = Array.isArray(rxMask) && rxMask.length >= 360 ? rxMask : null;
  const maskPeak = maskVals ? Math.max(0, ...maskVals.filter(Number.isFinite)) : 0;
  const dataMaxEl = Math.max(5, maskPeak, ...pts.map(p => p.el));
  const yMax  = Math.min(90, Math.max(20, Math.ceil((dataMaxEl + 2) / 5) * 5));
  const yStep = yMax <= 30 ? 5 : yMax <= 60 ? 10 : 20;

  const xOf = az => +(AZEL_PAD_L + (az / 360) * AZEL_CHART_W).toFixed(1);
  const yOf = el => +(AZEL_PAD_T + AZEL_CHART_H - (Math.max(0, Math.min(yMax, el)) / yMax) * AZEL_CHART_H).toFixed(1);

  // Gridlines + axis tick labels
  let gridSVG = '';
  for (let az = 0; az <= 360; az += 60) {
    const x = xOf(az);
    gridSVG += `<line x1="${x}" y1="${AZEL_PAD_T}" x2="${x}" y2="${AZEL_PAD_T + AZEL_CHART_H}" stroke="#1e1e38" stroke-width="1"/>
      <text x="${x}" y="${AZEL_PAD_T + AZEL_CHART_H + 16}" text-anchor="middle" fill="#5a5a8a" font-size="10" font-family="monospace">${az}°</text>`;
  }
  for (let el = 0; el <= yMax; el += yStep) {
    const y = yOf(el);
    gridSVG += `<line x1="${AZEL_PAD_L}" y1="${y}" x2="${AZEL_PAD_L + AZEL_CHART_W}" y2="${y}" stroke="#1e1e38" stroke-width="1"/>
      <text x="${AZEL_PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="#5a5a8a" font-size="10" font-family="monospace">${el}°</text>`;
  }

  // Rx mask — defined for every azimuth, so no wraparound gap to split unlike the trajectory below
  const MASK_COLOR = '#ff6432'; // matches the polar plot's own mask shading hue — same meaning, same color
  let maskSVG = '';
  if (maskVals) {
    const maskD = Array.from({ length: 360 }, (_, az) => `${az ? 'L' : 'M'}${xOf(az)},${yOf(maskVals[az] ?? 0)}`).join('');
    maskSVG = `<path d="${maskD}" fill="none" stroke="${MASK_COLOR}" stroke-width="1.5"/>`;
  }

  // Trajectory — split into a new subpath wherever azimuth wraps around
  // 0°/360° (a pass crossing due north), otherwise that wrap draws one long
  // spurious line straight across the chart instead of exiting one edge and
  // re-entering the other.
  const TRAJ_COLOR = '#ff3060'; // matches the polar plot's own trajectory stroke
  let trajD = '';
  pts.forEach((p, i) => {
    const wrapped = i > 0 && Math.abs(p.az - pts[i - 1].az) > 180;
    trajD += `${i === 0 || wrapped ? 'M' : 'L'}${xOf(p.az)},${yOf(p.el)}`;
  });
  const trajSVG = `<path d="${trajD}" fill="none" stroke="${TRAJ_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  const { aos, los, apogee, maskEntry, maskExit } = computePolarMarkers(pts, rxMask);
  const dot   = (p, color, r = 3.5) => `<circle cx="${xOf(p.az)}" cy="${yOf(p.el)}" r="${r}" fill="${color}"/>`;
  const label = (p, text, color) =>
    `<text x="${xOf(p.az)}" y="${yOf(p.el) - 8}" text-anchor="middle" fill="${color}" font-size="9" font-family="monospace">${text}</text>`;

  const markersSVG = `
    ${dot(aos, MARKER_COLORS.aos)}${label(aos, `AOS ${aos.el.toFixed(0)}°`, MARKER_COLORS.aos)}
    ${dot(los, MARKER_COLORS.los)}${label(los, `LOS ${los.el.toFixed(0)}°`, MARKER_COLORS.los)}
    ${dot(apogee, MARKER_COLORS.apogee, 4)}${label(apogee, `${apogee.el.toFixed(0)}°`, MARKER_COLORS.apogee)}
    ${maskEntry ? dot(maskEntry, MARKER_COLORS.maskEntry) + label(maskEntry, `▲${maskEntry.el.toFixed(0)}°`, MARKER_COLORS.maskEntry) : ''}
    ${maskExit  ? dot(maskExit,  MARKER_COLORS.maskExit)  + label(maskExit,  `▼${maskExit.el.toFixed(0)}°`, MARKER_COLORS.maskExit)  : ''}`;

  // Legend — only lists what's actually drawn (e.g. no "Rx Mask" swatch when this pass has none)
  const legendItems = [
    maskVals ? { color: MASK_COLOR, label: 'Rx Mask', line: true } : null,
    { color: TRAJ_COLOR, label: 'Trajectory', line: true },
    { color: MARKER_COLORS.aos, label: 'AOS' },
    { color: MARKER_COLORS.los, label: 'LOS' },
    maskEntry ? { color: MARKER_COLORS.maskEntry, label: 'Mask entry' } : null,
    maskExit  ? { color: MARKER_COLORS.maskExit,  label: 'Mask exit'  } : null,
    { color: MARKER_COLORS.apogee, label: 'Apogee' },
  ].filter(Boolean);
  let lx = AZEL_PAD_L;
  const ly = AZEL_H - 16;
  let legendSVG = '';
  for (const item of legendItems) {
    legendSVG += item.line
      ? `<line x1="${lx}" y1="${ly - 3}" x2="${lx + 14}" y2="${ly - 3}" stroke="${item.color}" stroke-width="2"/>`
      : `<circle cx="${lx + 7}" cy="${ly - 3}" r="3.5" fill="${item.color}"/>`;
    legendSVG += `<text x="${lx + 18}" y="${ly}" fill="#9aa" font-size="10" font-family="monospace">${item.label}</text>`;
    lx += 18 + item.label.length * 6 + 16;
  }

  return `<svg width="100%" viewBox="0 0 ${AZEL_W} ${AZEL_H}" xmlns="http://www.w3.org/2000/svg" class="pass-azel">
    <rect x="${AZEL_PAD_L}" y="${AZEL_PAD_T}" width="${AZEL_CHART_W}" height="${AZEL_CHART_H}" fill="#0c0c1c" stroke="#2a2a44" stroke-width="1"/>
    ${gridSVG}
    ${maskSVG}
    ${trajSVG}
    ${markersSVG}
    ${legendSVG}
  </svg>`;
}

// Legacy sync wrapper (returns '' when no store.groundStations — use the async flow instead)
export function buildPassPolarSVG(pass, sat, groundStations) {
  if (!sat?.satrec || !groundStations?.length) return '';
  const stLC = pass.station?.toLowerCase() ?? '';
  const gs = groundStations.find(g =>
    g.satId === sat.id && g.name.toLowerCase() === stLC &&
    (pass.network == null || g.network === pass.network)
  ) ?? groundStations.find(g => g.satId === sat.id && g.name.toLowerCase() === stLC);
  if (!gs) return '';
  return buildPolarSVG(pass, sat, gs.lat, gs.lon);
}
