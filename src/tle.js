import * as satellite from 'satellite.js';

const TLE_URL = (noradId) =>
  `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=TLE`;

export async function fetchTLE(noradId) {
  const res = await fetch(TLE_URL(noradId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Find TLE lines by content, not position — handles 2-line and 3-line formats
  const line1 = lines.find(l => l.startsWith('1 ') && l.length >= 60);
  const line2 = lines.find(l => l.startsWith('2 ') && l.length >= 60);

  if (!line1 || !line2) {
    console.error('[TLE] raw response lines:', lines);
    throw new Error(`No valid TLE lines found for NORAD ${noradId}`);
  }

  // Name is the line immediately before line1, if any
  const nameIdx = lines.indexOf(line1) - 1;
  const name = nameIdx >= 0 && !lines[nameIdx].startsWith('1 ') && !lines[nameIdx].startsWith('2 ')
    ? lines[nameIdx]
    : `SAT-${noradId}`;

  const satrec = satellite.twoline2satrec(line1, line2);
  if (satrec.error !== 0) throw new Error(`SGP4 init error ${satrec.error}`);
  return { satrec, name: name.trim(), line1, line2 };
}

/**
 * Propagate satellite to date.
 * Returns { lat, lon, alt, eciPos, eciVel } or null on error.
 */
export function propagate(satrec, date) {
  const posVel = satellite.propagate(satrec, date);
  if (!posVel || !posVel.position) return null;
  const { position: eciPos, velocity: eciVel } = posVel;
  // SGP4 can return NaN for decayed or unsupported objects — treat as failure
  if (!isFinite(eciPos.x) || !isFinite(eciPos.y) || !isFinite(eciPos.z)) return null;
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(eciPos, gmst);
  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(geo.height)) return null;
  return {
    lat,
    lon,
    alt: geo.height, // km
    eciPos,
    eciVel,
    gmst,
  };
}

/** ECI position → Cesium Cartesian3 (meters) */
export function eciToCartesian3(eciPos, gmst) {
  const ecef = satellite.eciToEcf(eciPos, gmst);
  // eslint-disable-next-line no-undef
  return Cesium.Cartesian3.fromElements(
    ecef.x * 1000,
    ecef.y * 1000,
    ecef.z * 1000
  );
}
