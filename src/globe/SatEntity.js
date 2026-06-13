import { propagate, eciToCartesian3 } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { store } from '../store.js';

/* global Cesium */

const ORBIT_STEPS = 120;
const ARROW_LEN_KM = 640;
const MODEL_BASE_SCALE = 800;

const MODEL_URIS = {
  '12U': '/models/12UV1.gltf',
  'FF':  '/models/FFV1.gltf',
};

// FF model rotation bias: 90° around X, 180° around Z (body-frame, post-multiplied).
const _r = d => (d * Math.PI) / 180;
const _ffBias = (() => {
  const qx  = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, _r(90),  new Cesium.Quaternion());
  const qz  = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, _r(180), new Cesium.Quaternion());
  return Cesium.Quaternion.multiply(qx, qz, new Cesium.Quaternion());
})();

// Module-level scratch objects — reused every frame, never allocated in hot path
const _scratchM3  = new Cesium.Matrix3();
const _scratchCol = new Cesium.Cartesian3();

export class SatEntity {
  constructor(viewer, sat) {
    this.viewer = viewer;
    this.sat = sat;
    this.cesiumColor = Cesium.Color.fromCssColorString(sat.color);
    this._entities = [];
    this._bodyEntity   = null;
    this._panelsEntity = null;
    this._orbitEntity  = null;
    this._xArrow = null;
    this._yArrow = null;
    this._zArrow = null;
    this._sunArrow = null;
    this._posProp    = null;
    this._orientProp = null;
    this._cachedOrbit  = null;
    this._lastOrbitMs  = -Infinity;
    this._lastOrbitWall = -Infinity;
    this._inEclipse = false; // updated each frame; drives sun arrow colour + label
    // Preallocated tip Cartesian3 objects — mutated in place, no per-frame allocation
    this._xTip   = new Cesium.Cartesian3();
    this._yTip   = new Cesium.Cartesian3();
    this._zTip   = new Cesium.Cartesian3();
    this._sunTip = new Cesium.Cartesian3();
    // Stable two-element arrays whose [1] element is the tip above (reference never changes)
    this._xPos   = null; // set to [origin, this._xTip] in _build
    this._yPos   = null;
    this._zPos   = null;
    this._sunPos = null;
  }

  update(date) {
    const r = propagate(this.sat.satrec, date);
    if (!r) return;
    store.positions[this.sat.noradId] = r; // share with SatInfo — avoids double propagation

    const origin = eciToCartesian3(r.eciPos, r.gmst);

    const nowMs    = date.getTime();
    const wallMs   = Date.now();
    const simDelta = Math.abs(nowMs - this._lastOrbitMs);
    // Recompute if sim time moved AND (wall-clock throttle passed OR it's a big scrub jump)
    if ((simDelta > 5000 || !this._cachedOrbit)
        && (wallMs - this._lastOrbitWall > 500 || simDelta > 600_000)) {
      const pts = this._computeOrbit(date);
      if (pts) { this._cachedOrbit = pts; this._lastOrbitMs = nowMs; this._lastOrbitWall = wallMs; }
    }

    if (!this._bodyEntity) {
      if (!this._cachedOrbit) return;
      this._build(origin, r, date);
    } else {
      const q = this._computeOrientation(r, date); // compute once, reuse for arrows
      this._posProp.setValue(origin);
      this._orientProp.setValue(this._modelOrientation(q));
      this._updateArrows(origin, r, date, q);
    }
  }

  _build(origin, r, date) {
    const col = this.cesiumColor;

    this._posProp    = new Cesium.ConstantPositionProperty(origin);
    this._orientProp = new Cesium.ConstantProperty(this._modelOrientation(this._computeOrientation(r, date)));

    const scaleCb = new Cesium.CallbackProperty(
      () => store.satScale * MODEL_BASE_SCALE, false
    );

    this._bodyEntity = this._add({
      position:    this._posProp,
      orientation: this._orientProp,
      model: {
        uri: MODEL_URIS[this.sat.model] ?? MODEL_URIS['12U'],
        scale: scaleCb,
        minimumPixelSize: 12,
        silhouetteColor: col,
        silhouetteSize: 1,
      },
      label: {
        text: this.sat.name,
        font: '11px sans-serif',
        fillColor: col,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    // Orbit trace
    this._orbitEntity = this._add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => this._cachedOrbit, false),
        width: 1.5,
        material: col.withAlpha(0.45),
        arcType: Cesium.ArcType.NONE,
      },
    });

    // ECI-frame arrows — stable arrays; tip Cartesian3s are mutated in place each frame
    const initQ = this._computeOrientation(r, date);
    this._computeArrowTips(origin, r, date, initQ);
    {
      this._xPos   = [origin, this._xTip];
      this._yPos   = [origin, this._yTip];
      this._zPos   = [origin, this._zTip];
      this._sunPos = [origin, this._sunTip];

        this._xArrow   = this._addArrow(() => this._xPos,   Cesium.Color.RED);
      this._yArrow   = this._addArrow(() => this._yPos,   Cesium.Color.LIME);
      this._zArrow   = this._addArrow(() => this._zPos,   Cesium.Color.DODGERBLUE);
      this._sunArrow = this._addArrow(() => this._sunPos, Cesium.Color.YELLOW);

      this._xLabel   = this._addLabel(() => this._xPos[1],   'X',   Cesium.Color.RED);
      this._yLabel   = this._addLabel(() => this._yPos[1],   'Y',   Cesium.Color.LIME);
      this._zLabel   = this._addLabel(() => this._zPos[1],   'Z',   Cesium.Color.DODGERBLUE);
      this._sunLabel = this._addLabel(() => this._sunPos[1], 'Sun', Cesium.Color.YELLOW);
      this._setLabelsVisible(false);
    }
  }

  // Orientation quaternion.
  // If current sim time falls inside the posted attitude table → SLERP.
  // Outside the table span → fall back to Default Sun Pointing.
  _computeOrientation(r, date) {
    const att = store.attitudes[this.sat.noradId];
    if (att?.entries?.length >= 2) {
      const entries = att.entries;
      const tNow = date.getTime();
      const tMin = entries[0].t;
      const tMax = entries[entries.length - 1].t;

      if (tNow >= tMin && tNow <= tMax) {
        // Find last entry with t <= tNow (correct bound covers all intervals)
        let lo = 0;
        for (let i = 1; i < entries.length; i++) {
          if (entries[i].t <= tNow) lo = i; else break;
        }
        lo = Math.min(lo, entries.length - 2); // clamp for tNow === tMax edge
        const e0 = entries[lo];
        const e1 = entries[lo + 1];
        const dt = e1.t - e0.t;
        if (dt === 0) return new Cesium.Quaternion(e0.q.x, e0.q.y, e0.q.z, e0.q.w);
        const t  = Math.max(0, Math.min(1, (tNow - e0.t) / dt));
        const q0 = new Cesium.Quaternion(e0.q.x, e0.q.y, e0.q.z, e0.q.w);
        const q1 = new Cesium.Quaternion(e1.q.x, e1.q.y, e1.q.z, e1.q.w);
        return Cesium.Quaternion.slerp(q0, q1, t, new Cesium.Quaternion());
      }
      // Outside span → fall through to sun pointing
    }

    const { eciPos, gmst } = r;

    const sun = sunDirectionECI(date); // unit vector in ECI

    // Primary (exact):   col-0 toward sun  →  displayed −Z faces sun
    const xECI = sun;

    // Secondary (best-effort): col-1 toward zenith (anti-nadir)  →  displayed −Y faces anti-nadir
    // Project zenith onto the plane perpendicular to the sun vector (Gram-Schmidt)
    const rLen = Math.sqrt(eciPos.x**2 + eciPos.y**2 + eciPos.z**2);
    if (!rLen) return Cesium.Quaternion.IDENTITY;
    const zenith = { x: eciPos.x/rLen, y: eciPos.y/rLen, z: eciPos.z/rLen };
    const dot    = zenith.x*xECI.x + zenith.y*xECI.y + zenith.z*xECI.z;
    const yRaw   = { x: zenith.x - dot*xECI.x, y: zenith.y - dot*xECI.y, z: zenith.z - dot*xECI.z };
    const yLen   = Math.sqrt(yRaw.x**2 + yRaw.y**2 + yRaw.z**2);
    if (yLen < 1e-6) return Cesium.Quaternion.IDENTITY; // sun ≈ zenith, degenerate
    const yECI = { x: yRaw.x/yLen, y: yRaw.y/yLen, z: yRaw.z/yLen };

    // Tertiary: col-2 completes the right-hand frame
    const zECI = cross(xECI, yECI);

    const c = Math.cos(gmst), s = Math.sin(gmst);
    function toEcef(v) {
      return new Cesium.Cartesian3(v.x*c + v.y*s, -v.x*s + v.y*c, v.z);
    }

    const m = new Cesium.Matrix3();
    Cesium.Matrix3.setColumn(m, 0, toEcef(xECI), m);
    Cesium.Matrix3.setColumn(m, 1, toEcef(yECI), m);
    Cesium.Matrix3.setColumn(m, 2, toEcef(zECI), m);

    return Cesium.Quaternion.fromRotationMatrix(m);
  }

  // Body-frame bias applied only to the rendered model, not to the reference arrows.
  _modelOrientation(q) {
    if (this.sat.model !== 'FF') return q;
    return Cesium.Quaternion.multiply(q, _ffBias, new Cesium.Quaternion());
  }

  _updateArrows(origin, r, date, q) {
    if (!this._xPos) return;
    // Update the base of every arrow to the current satellite position
    this._xPos[0] = this._yPos[0] = this._zPos[0] = this._sunPos[0] = origin;
    this._computeArrowTips(origin, r, date, q);
  }

  // Arrow tips mutated in-place into preallocated Cartesian3 objects (no allocations).
  _computeArrowTips(origin, r, date, q) {
    Cesium.Matrix3.fromQuaternion(q, _scratchM3);
    const len = ARROW_LEN_KM * 1000;

    function tipInto(out, cx, cy, cz) {
      out.x = origin.x + cx * len;
      out.y = origin.y + cy * len;
      out.z = origin.z + cz * len;
    }

    // col(i) negated inline — avoids Cartesian3 allocation per column
    Cesium.Matrix3.getColumn(_scratchM3, 2, _scratchCol);
    tipInto(this._xTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);

    Cesium.Matrix3.getColumn(_scratchM3, 1, _scratchCol);
    tipInto(this._yTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);

    Cesium.Matrix3.getColumn(_scratchM3, 0, _scratchCol);
    tipInto(this._zTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);

    const { eciPos, gmst } = r;
    const sun = sunDirectionECI(date); // cached — free second call
    this._inEclipse = isInEclipse(eciPos, sun);
    const sl = ARROW_LEN_KM;
    const sunEci = { x: eciPos.x + sun.x*sl, y: eciPos.y + sun.y*sl, z: eciPos.z + sun.z*sl };
    const sunEcef = eciToCartesian3(sunEci, gmst);
    this._sunTip.x = sunEcef.x; this._sunTip.y = sunEcef.y; this._sunTip.z = sunEcef.z;
  }

  _addLabel(posFn, text, color) {
    return this._add({
      position: new Cesium.CallbackProperty(posFn, false),
      label: {
        text,
        font: 'bold 12px sans-serif',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(6, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.9,
      },
    });
  }

  _addArrow(posFn, color) {
    return this._add({
      polyline: {
        positions: new Cesium.CallbackProperty(posFn, false),
        width: 4,
        material: new Cesium.PolylineArrowMaterialProperty(color),
        arcType: Cesium.ArcType.NONE,
      },
    });
  }

  _add(def) {
    const e = this.viewer.entities.add(def);
    this._entities.push(e);
    return e;
  }

  _computeOrbit(date) {
    const { no } = this.sat.satrec;
    if (!no || no <= 0) return null;
    const periodMs = (2 * Math.PI / no) * 60000;
    const stepMs = periodMs / ORBIT_STEPS;
    const t0 = date.getTime() - periodMs / 2;
    const pts = [];
    const d = new Date(); // reused — avoids 120 Date allocations per recompute
    for (let i = 0; i <= ORBIT_STEPS; i++) {
      d.setTime(t0 + i * stepMs);
      const r = propagate(this.sat.satrec, d);
      if (!r) continue;
      pts.push(eciToCartesian3(r.eciPos, r.gmst));
    }
    return pts.length >= 2 ? pts : null;
  }

  setSelected(selected) {
    this._setLabelsVisible(selected);
  }

  _setLabelsVisible(visible) {
    if (this._xLabel)   this._xLabel.show   = visible;
    if (this._yLabel)   this._yLabel.show   = visible;
    if (this._zLabel)   this._zLabel.show   = visible;
    if (this._sunLabel) this._sunLabel.show = visible;
  }

  ownsEntity(e) { return this._entities.includes(e); }
  getTrackEntity() { return this._bodyEntity; }

  destroy() {
    for (const e of this._entities) this.viewer.entities.remove(e);
    this._entities = [];
    this._bodyEntity = this._orbitEntity = null;
    this._xArrow = this._yArrow = this._zArrow = this._sunArrow = null;
    this._xLabel = this._yLabel = this._zLabel = this._sunLabel = null;
    this._posProp = this._orientProp = null;
    this._xPos = this._yPos = this._zPos = this._sunPos = null;
  }
}

function cross(a, b) {
  return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x };
}
function neg(v) {
  return new Cesium.Cartesian3(-v.x, -v.y, -v.z);
}
