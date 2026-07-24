// Shared, Cesium-free quaternion SLERP + timestamped-table sampling — used by
// both SatEntity.js (3D globe, ECEF) and TimePlayer.js (STT geometry, ECI).
// Extracted from what used to be two hand-duplicated private copies so the
// gap guard below only needs to exist once.

// 3x the 30s target resolution satAttitudeReal.js fetches at — a bracketing
// pair further apart than this is NOT real, continuous coverage (just two
// unrelated samples from different scrub sessions, possibly hours apart) and
// must not be smoothly interpolated across as if it were.
export const DEFAULT_MAX_GAP_MS = 90_000;

// Standard quaternion SLERP, shortest path, linear-interpolate-and-normalize
// fallback when the two orientations are nearly identical (avoids a sin(θ)≈0
// division). Same algorithm as Cesium.Quaternion.slerp, in plain JS.
export function slerpQuat(a, b, t) {
  let { x: bx, y: by, z: bz, w: bw } = b;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    const x = a.x + t * (bx - a.x), y = a.y + t * (by - a.y), z = a.z + t * (bz - a.z), w = a.w + t * (bw - a.w);
    const len = Math.sqrt(x * x + y * y + z * z + w * w);
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta  = theta0 * t;
  const sin0   = Math.sin(theta0);
  const s0 = Math.cos(theta) - dot * Math.sin(theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return { x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw };
}

// Binary-searches `entries` (sorted by .t, ms) for tMs and SLERPs the
// bracketing pair. Null if tMs falls outside the table's span, OR if the
// bracketing pair itself is more than maxGapMs apart (see DEFAULT_MAX_GAP_MS)
// — either way the caller falls back to Default Sun Pointing.
export function sampleAttitudeTable(entries, tMs, maxGapMs = DEFAULT_MAX_GAP_MS) {
  if (!entries?.length) return null;
  const first = entries[0], last = entries[entries.length - 1];
  if (tMs < first.t || tMs > last.t) return null;
  let lo = 0, hi = entries.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= tMs) lo = mid; else hi = mid;
  }
  const a = entries[lo], b = entries[hi];
  if (b.t - a.t > maxGapMs) return null;
  const frac = b.t > a.t ? (tMs - a.t) / (b.t - a.t) : 0;
  return slerpQuat(a.q, b.q, frac);
}
