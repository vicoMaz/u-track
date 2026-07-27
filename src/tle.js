import * as satellite from 'satellite.js';

const TLE_URL = (noradId) =>
  `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=TLE`;

export async function fetchTLE(noradId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  let res;
  try {
    res = await fetch(TLE_URL(noradId), { signal: ac.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Celestrak request timed out (10 s)' : e.message);
  } finally {
    clearTimeout(timer);
  }
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
 * Parse a raw TLE string (2-line or 3-line with name) without fetching.
 * Returns { satrec, name, noradId, line1, line2 } or throws.
 */
export function parseTLE(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const line1 = lines.find(l => l.startsWith('1 ') && l.length >= 60);
  const line2 = lines.find(l => l.startsWith('2 ') && l.length >= 60);
  if (!line1 || !line2) throw new Error('Could not find valid TLE lines (need lines starting with "1 " and "2 ")');

  const nameIdx = lines.indexOf(line1) - 1;
  const name = (nameIdx >= 0 && !lines[nameIdx].startsWith('1 ') && !lines[nameIdx].startsWith('2 '))
    ? lines[nameIdx]
    : null;

  const noradId = line2.substring(2, 7).trim();
  const satrec  = satellite.twoline2satrec(line1, line2);
  if (satrec.error !== 0) throw new Error(`SGP4 initialisation error ${satrec.error}`);
  return { satrec, name, noradId, line1, line2 };
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

function _tleChecksum(line) {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

// Deterministic (same seed → same id every time, so re-adding the same
// simulated satellite name doesn't accumulate a fresh id each attempt) —
// biased into a high sub-range that's at least unlikely to collide with a
// REAL NORAD number already loaded in this app; the 5-digit TLE field
// caps this at 99999 regardless, so an absolute guarantee isn't possible.
// The existing "already loaded" duplicate check in InputPanel.js is the
// real backstop if two different names ever do collide.
function _fakePlaceholderNoradId(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 90000 + (h % 9000);
}

/**
 * A syntactically valid, always-propagatable TLE for a satellite with no
 * real orbital data of its own — some simulated satellites (satSimu.js)
 * genuinely have none published anywhere, since they're not real orbiting
 * objects, which makes GNM's TLE lookup fail outright rather than just
 * being unreachable. satrec is required elsewhere in the app (every
 * consumer either assumes a real object or has to be individually
 * null-guarded — see the investigation behind this function), and a
 * simulated satellite is already excluded from the Globe/Map (the only
 * place its ACTUAL position would matter), so a generic, physically
 * arbitrary low-Earth orbit satisfies every existing assumption without
 * touching any of those call sites.
 *
 * Every field below is padded to the EXACT column width satellite.js's own
 * twoline2satrec reads (see node_modules/satellite.js/dist/io.js's
 * substring offsets) — confirmed live: a naive hand-built TLE that's a
 * character short on ANY field before mean motion cascades into every
 * field after it silently reading the wrong slice (mean motion ends up
 * reading 5.5 instead of the intended 15.5, giving a ~2x-too-large orbit)
 * without ever raising satrec.error.
 */
export function placeholderTLE(seed) {
  const noradId  = _fakePlaceholderNoradId(seed || 'SIMU');
  const noradStr = String(noradId).padStart(5, '0');

  const now   = new Date();
  const year  = now.getUTCFullYear();
  const yy    = String(year % 100).padStart(2, '0');
  const dayOfYear = (now.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const intDay    = Math.floor(dayOfYear);
  const epochDayStr = String(intDay).padStart(3, '0') + (dayOfYear - intDay).toFixed(8).slice(1); // "DDD.DDDDDDDD" — 12 chars

  const l1 = [
    '1 ', noradStr,                 // satnum [2,7)
    'U ', `${yy}900A  `,            // classification + intl designator — cosmetic, unread by twoline2satrec
    ' ', yy,                        // epochyr [18,20)
    epochDayStr,                    // epochdays [20,32)
    ' ', ' .00000000',              // ndot [33,43)
    ' ', ' 00000', '-0',            // nddot mantissa+exponent — zero
    ' ', ' 00000', '-0',            // bstar mantissa+exponent — zero (no drag)
    ' ', '0', ' ', '0001',          // ephemeris type + element set — cosmetic
  ].join('');
  const l2 = [
    '2 ', noradStr, ' ',
    '51.6000'.padStart(8),          // inclo [8,16) — arbitrary, ISS-like
    ' ', '0.0000'.padStart(8),      // nodeo [17,25)
    ' ', '0001000',                 // ecco  [26,33) — near-circular
    ' ', '0.0000'.padStart(8),      // argpo [34,42)
    ' ', '0.0000'.padStart(8),      // mo    [43,51)
    ' ', '15.50000000',             // no    [52,63) — ~400km circular orbit
    '00001',                        // rev number — cosmetic
  ].join('');

  return { line1: l1 + _tleChecksum(l1), line2: l2 + _tleChecksum(l2) };
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
