import { propagate } from '../tle.js';

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
  const p = fetch(`http://${host}:15602/api/v1/data/antennas`, { signal: AbortSignal.timeout(5000) })
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
      `http://${host}:15602/api/v1/data/antennas/mask/${encodeURIComponent(antennaId)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.rx_mask ?? data.rxMask ?? null;
  } catch { return null; }
}

/**
 * Resolve ground station lat/lon (and rx_mask) for a pass.
 * Strategy:
 *   1. store.groundStations (already loaded)
 *   2. FDS antenna list → match by ID (pass.station may be the short code) or name
 *   3. Fetch mask for the matched antenna_id
 * Returns {lat, lon, rxMask?} or null.
 */
export async function fetchPassGsCoords(sat, pass, groundStations) {
  // 1. groundStations store
  if (groundStations?.length) {
    const stLC = pass.station?.toLowerCase() ?? '';
    const gs = groundStations.find(g =>
      g.satId === sat.id &&
      g.name.toLowerCase() === stLC &&
      (pass.network == null || g.network === pass.network)
    ) ?? groundStations.find(g =>
      g.satId === sat.id && g.name.toLowerCase() === stLC
    );
    if (gs) return { lat: gs.lat, lon: gs.lon };
  }

  const station = pass.station;
  if (!station || station === '—') return null;

  const ip = localStorage.getItem(`sat-baseurl-${sat.noradId}`) ?? '';
  if (!ip) return null;
  const host = ip.replace(/\.\d+$/, '.3');

  const cacheKey = `${sat.noradId}:${station}`;
  if (_coordsCache.has(cacheKey)) return _coordsCache.get(cacheKey);

  try {
    const antennas = await _getFdsAntennas(host);

    // FDS fields: local_id, remote_id, location.site_id, location.coordinates
    const stLC = station.toLowerCase();
    let antenna = antennas.find(a => a.local_id === station || a.remote_id === station)
      ?? antennas.find(a => a.location?.site_id === station)
      ?? antennas.find(a => {
        const id = (a.local_id ?? a.remote_id ?? '').toLowerCase();
        return id && (id.includes(stLC) || stLC.includes(id));
      });

    if (!antenna) {
      const ids = antennas.map(a => a.local_id ?? a.remote_id ?? '?');
      console.warn('[polar] no antenna matched', JSON.stringify(station), '— FDS local_ids:', ids);
      return null;
    }

    // Coordinates are under location.coordinates
    const coordsObj = antenna.location?.coordinates ?? antenna.location ?? {};
    let lat = coordsObj.latitude  ?? coordsObj.lat  ?? null;
    let lon = coordsObj.longitude ?? coordsObj.lon  ?? null;

    if (lat == null) {
      console.warn('[polar] antenna found but no coords — location:', antenna.location);
    }

    // Fetch the rx mask (360-element elevation array, one value per azimuth degree)
    const antennaId = antenna.local_id ?? antenna.remote_id ?? station;
    const rxMask = await _fetchMask(host, antennaId);

    const coords = { lat, lon, rxMask };
    if (lat != null) _coordsCache.set(cacheKey, coords);
    return lat != null ? coords : null;
  } catch { return null; }
}

// ── Synchronous SVG builder ───────────────────────────────────────────────────

/**
 * Build the polar plot SVG given explicit lat/lon and optional rx_mask array.
 * rxMask: 360-element array where rxMask[az] = min elevation (deg) at that azimuth.
 * Returns an SVG string, or '' if not enough elevation points.
 */
export function buildPolarSVG(pass, sat, lat, lon, rxMask) {
  const CX = 65, CY = 65, R = 54;
  const r30 = +(R * 2/3).toFixed(1);
  const r60 = +(R * 1/3).toFixed(1);

  const t0 = (pass.start instanceof Date ? pass.start : new Date(pass.start)).getTime();
  const t1 = (pass.end   instanceof Date ? pass.end   : new Date(pass.end)).getTime();

  const pts = [];
  for (let t = t0; t <= t1 + 15_000; t += 30_000) {
    const ae = _azel(sat.satrec, lat, lon, new Date(Math.min(t, t1)));
    if (ae && ae.el >= 0) pts.push(ae);
  }
  if (pts.length < 2) return '';

  const toXY = ({az, el}) => {
    const r = R * (1 - el / 90);
    const a = az * Math.PI / 180;
    return [+(CX + r * Math.sin(a)).toFixed(1), +(CY - r * Math.cos(a)).toFixed(1)];
  };

  const pathD   = pts.map((p, i) => { const [x,y]=toXY(p); return `${i?'L':'M'}${x},${y}`; }).join('');
  const [ax,ay] = toXY(pts[0]);
  const [lx,ly] = toXY(pts[pts.length-1]);

  // Apogee = max elevation point
  let apIdx = 0;
  pts.forEach((p, i) => { if (p.el > pts[apIdx].el) apIdx = i; });
  const [apx, apy] = toXY(pts[apIdx]);

  // Mask entry/exit = first/last point above the rx_mask threshold
  let maskEntry = null, maskExit = null;
  if (Array.isArray(rxMask) && rxMask.length >= 360) {
    for (const p of pts) {
      const minEl = rxMask[Math.round(p.az) % 360] ?? 0;
      if (p.el >= minEl) { if (!maskEntry) maskEntry = p; maskExit = p; }
    }
  }

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

  // Mask entry/exit marker SVG
  let maskMarkerSVG = '';
  if (maskEntry && maskExit) {
    const [mex, mey] = toXY(maskEntry);
    const [mlx, mly] = toXY(maskExit);
    const elIn  = (rxMask[Math.round(maskEntry.az) % 360] ?? maskEntry.el).toFixed(0);
    const elOut = (rxMask[Math.round(maskExit.az)  % 360] ?? maskExit.el ).toFixed(0);
    maskMarkerSVG = `
    <circle cx="${mex}" cy="${mey}" r="2.5" fill="#00cfff"/>
    ${radLabel(mex, mey, `▲${elIn}°`, '#00cfff')}
    <circle cx="${mlx}" cy="${mly}" r="2.5" fill="#ff9900"/>
    ${radLabel(mlx, mly, `▼${elOut}°`, '#ff9900')}`;
  }

  return `<svg width="200" height="200" viewBox="0 0 130 130" xmlns="http://www.w3.org/2000/svg" class="pass-polar">
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
    <circle cx="${ax}" cy="${ay}" r="2.5" fill="#00ff9d"/>
    <circle cx="${lx}" cy="${ly}" r="2.5" fill="#ff6060"/>
    ${maskMarkerSVG}
    <circle cx="${apx}" cy="${apy}" r="3" fill="#ffe066"/>
    ${radLabel(apx, apy, `${pts[apIdx].el.toFixed(0)}°`, '#ffe066')}
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
