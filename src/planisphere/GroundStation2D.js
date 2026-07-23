import L from 'leaflet';

const R_EARTH = 6371; // km

// `maskDeg` (optional) is a minimum elevation angle: the classic
// ground-coverage-angle formula λ = acos((Re/(Re+h))·cosε) − ε, which
// reduces to the plain horizon formula when ε = 0 (the default for every
// ground station that doesn't set one).
function capRho(orbitAlt, maskDeg = 0) {
  const eps = maskDeg * Math.PI / 180;
  const ratio = Math.min(1, (R_EARTH / (R_EARTH + orbitAlt)) * Math.cos(eps));
  return Math.max(0, Math.acos(ratio) - eps);
}

// ── Non-polar cap: azimuth sweep ──────────────────────────────────────────────
// For non-polar caps the atan2 denominator (cosρ − sinφgs·sinφ) is provably > 0
// at all boundary azimuths, so there are no spurious longitude jumps — only real
// antimeridian crossings are possible.
function capPolygon(lat, lon, rho, N = 90) {
  const φgs    = lat * Math.PI / 180;
  const λgs    = lon * Math.PI / 180;
  const sinφgs = Math.sin(φgs), cosφgs = Math.cos(φgs);
  const cosRho = Math.cos(rho),  sinRho  = Math.sin(rho);

  const pts = [];
  for (let i = 0; i <= N; i++) {
    const az   = (2 * Math.PI * i) / N;
    const sinφ = sinφgs * cosRho + cosφgs * sinRho * Math.cos(az);
    const φ    = Math.asin(Math.max(-1, Math.min(1, sinφ)));
    const λ    = λgs + Math.atan2(
      Math.sin(az) * sinRho * cosφgs,
      cosRho - sinφgs * sinφ
    );
    pts.push([φ * 180 / Math.PI, ((λ * 180 / Math.PI) + 540) % 360 - 180]);
  }
  return pts;
}

// ── Polar cap: "hood" polygon ─────────────────────────────────────────────────
// When the cap contains a geographic pole the correct Mercator representation is
// a boundary arc sweeping lon −180→+180 plus a closing edge at lat ±89°.
// Boundary equation (spherical law of cosines solved for φ at each λ):
//   sin(φ)·sin(φgs) + cos(φ)·cos(φgs)·cos(λ−λgs) = cos(ρ)
//
// The two raw solutions φ₀ and φ₁ may lie outside [−π/2, π/2].  We normalize
// each to [−π, π] first; only values then still in [−π/2, π/2] are valid
// latitudes.  (e.g. a raw 272.9° normalises to −87.1°, which is valid.)
function polarCapPolygon(lat, lon, rho, N = 180) {
  const isNorth = lat > 0;
  const φgs  = lat * Math.PI / 180;
  const A    = Math.sin(φgs);
  const cosρ = Math.cos(rho);
  const TWO_PI  = 2 * Math.PI;
  const HALF_PI = Math.PI / 2;

  function normRad(a) {
    a = a % TWO_PI;
    if (a > Math.PI)  a -= TWO_PI;
    if (a < -Math.PI) a += TWO_PI;
    return a;
  }

  const pts = [];
  for (let i = 0; i <= N; i++) {
    const lonDeg = -180 + 360 * i / N;
    const B      = Math.cos(φgs) * Math.cos((lonDeg - lon) * Math.PI / 180);
    const denom  = Math.sqrt(A * A + B * B);
    if (denom < 1e-10) continue;

    const sinT   = Math.max(-1, Math.min(1, cosρ / denom));
    const base   = Math.asin(sinT);
    const offset = Math.atan2(B, A);

    const r0 = normRad(base - offset);
    const r1 = normRad(Math.PI - base - offset);

    const v0 = Math.abs(r0) <= HALF_PI ? r0 : null;
    const v1 = Math.abs(r1) <= HALF_PI ? r1 : null;

    let φ;
    if (v0 !== null && v1 !== null) {
      φ = isNorth ? Math.min(v0, v1) : Math.max(v0, v1);
    } else if (v0 !== null) {
      φ = v0;
    } else if (v1 !== null) {
      φ = v1;
    } else {
      continue;
    }
    pts.push([φ * 180 / Math.PI, lonDeg]);
  }

  // Close at the pole edge so the hood fills to ±89°
  const poleEdge = isNorth ? 89 : -89;
  pts.push([poleEdge,  180]);
  pts.push([poleEdge, -180]);
  return pts;
}

// ── Antimeridian split for non-polar caps ─────────────────────────────────────
// Adds interpolated edge points at ±180° so each segment closes without a
// diagonal line. Two crossings produce 3 raw segments; the first and last are
// on the same side and are merged into one polygon.
function splitAtAntimeridian(pts) {
  const raw = [];
  let current = [];

  for (let i = 0; i < pts.length; i++) {
    current.push(pts[i]);
    if (i < pts.length - 1) {
      const dlon = pts[i + 1][1] - pts[i][1];
      if (Math.abs(dlon) > 180) {
        const edge  = dlon > 0 ? -180 : 180;           // edge on pts[i]'s side
        const lon0  = pts[i][1],     lat0 = pts[i][0];
        const lon1u = dlon > 0 ? pts[i + 1][1] - 360 : pts[i + 1][1] + 360;
        const t     = (edge - lon0) / (lon1u - lon0);
        const crossLat = lat0 + t * (pts[i + 1][0] - lat0);

        current.push([crossLat, edge]);
        raw.push(current);
        current = [[crossLat, -edge]];
      }
    }
  }
  if (current.length > 1) raw.push(current);

  // 2 crossings → 3 raw pieces; merge first & last (same antimeridian side)
  if (raw.length === 3) return [[...raw[2], ...raw[0]], raw[1]];
  return raw.length ? raw : [pts];
}

// ─────────────────────────────────────────────────────────────────────────────

export class GroundStation2D {
  constructor(map, gs) {
    this._map        = map;
    this._gs         = gs;
    this._footprints = [];
    this._build();
  }

  _build() {
    const { lat, lon, name, color } = this._gs;

    const icon = L.divIcon({
      html: `<div style="
        width:10px;height:10px;
        background:${color};
        border:2px solid #fff;
        border-radius:1px;
        transform:rotate(45deg);
        box-shadow:0 0 4px ${color}88;
      "></div>`,
      className: '',
      iconSize:   [14, 14],
      iconAnchor: [7, 7],
    });

    this._marker = L.marker([lat, lon], { icon })
      .bindTooltip(name, { permanent: false, direction: 'top', offset: [0, -6] })
      .addTo(this._map);
  }

  setVisible(v) {
    if (v) {
      if (!this._map.hasLayer(this._marker)) this._marker.addTo(this._map);
    } else {
      this._marker.remove();
      for (const p of this._footprints) p.remove();
      this._footprints = [];
    }
  }

  updateFootprint(orbitAlt, show) {
    for (const p of this._footprints) p.remove();
    this._footprints = [];
    if (!show) return;

    const rho     = capRho(orbitAlt, this._gs.mask ?? 0);
    const rhoDeg  = rho * 180 / Math.PI;
    const isPolar = Math.abs(this._gs.lat) + rhoDeg >= 90;

    const segments = isPolar
      ? [polarCapPolygon(this._gs.lat, this._gs.lon, rho)]
      : splitAtAntimeridian(capPolygon(this._gs.lat, this._gs.lon, rho));

    const style = {
      color:       this._gs.color,
      weight:      1.5,
      opacity:     0.8,
      fillColor:   this._gs.color,
      fillOpacity: 0.10,
    };
    this._footprints = segments.map(s => L.polygon(s, style).addTo(this._map));
  }

  destroy() {
    this._marker.remove();
    for (const p of this._footprints) p.remove();
  }
}
