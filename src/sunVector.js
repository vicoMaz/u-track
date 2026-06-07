const J2000_MS   = Date.UTC(2000, 0, 1, 12, 0, 0);
const R_EARTH_KM = 6371;

/**
 * Returns true when the satellite (eciPos in km) is in Earth's umbra.
 * sunDir must be the unit ECI vector toward the Sun.
 */
export function isInEclipse(eciPosKm, sunDir) {
  const rMag = Math.sqrt(eciPosKm.x ** 2 + eciPosKm.y ** 2 + eciPosKm.z ** 2);
  if (rMag < R_EARTH_KM) return false;
  // Cosine of angle between satellite position and sun direction
  const cosA = (eciPosKm.x * sunDir.x + eciPosKm.y * sunDir.y + eciPosKm.z * sunDir.z) / rMag;
  if (cosA >= 0) return false; // satellite on the sun side — no shadow possible
  // Perpendicular distance from satellite to the Earth-sun axis
  const perp = rMag * Math.sqrt(Math.max(0, 1 - cosA * cosA));
  return perp < R_EARTH_KM;
}
const DEG      = Math.PI / 180;
const EPSILON  = 23.439 * DEG;         // obliquity (constant for our precision)
const COS_EPS  = Math.cos(EPSILON);
const SIN_EPS  = Math.sin(EPSILON);

let _cacheT = -Infinity;
let _cacheX = 0, _cacheY = 0, _cacheZ = 0;

/** Returns a unit ECI vector pointing Earth→Sun at `date`. Memoized at 1 s resolution. */
export function sunDirectionECI(date) {
  const t = date.getTime();
  if (Math.abs(t - _cacheT) < 1000) return { x: _cacheX, y: _cacheY, z: _cacheZ };
  _cacheT = t;
  const days   = (t - J2000_MS) / 86400000;
  const L      = (280.46 + 0.9856474 * days) * DEG;
  const g      = (357.528 + 0.9856003 * days) * DEG;
  const lambda = L + 1.915 * Math.sin(g) * DEG;
  const cosL   = Math.cos(lambda);
  const sinL   = Math.sin(lambda);
  _cacheX = cosL;
  _cacheY = COS_EPS * sinL;
  _cacheZ = SIN_EPS * sinL;
  return { x: _cacheX, y: _cacheY, z: _cacheZ };
}
