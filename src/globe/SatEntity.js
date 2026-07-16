import { propagate, eciToCartesian3 } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { store } from '../store.js';
import { satSunExclDeg, satEarthExclDeg, satStarTrackerConesVisible } from '../satStarTracker.js';

/* global Cesium */

const ORBIT_STEPS = 120;
const ARROW_LEN_KM = 640;
const MODEL_BASE_SCALE = 800;

// Star tracker: mounted on the anti-sun face — boresight computed directly
// as -sun (see _updateStarTrackerCone), independent of which axis the
// reference arrows label "+Z" (-Z is the one that currently faces the sun;
// see _computeArrowTips), so it comes out the opposite side of the satellite
// from the sun-facing face. Rendered as one translucent FOV cone along that
// boresight. The Sun/Earth exclusion angles (per-satellite configurable in
// Settings — satStarTracker.js) aren't drawn as their own cones; instead the
// FOV cone itself turns red whenever the sun or Earth (nadir direction) is
// currently inside that satellite's configured keep-out angle around the
// boresight.
const ST_HALF_ANGLE_DEG = 15;
const ST_LEN_KM = 500;
const R_EARTH_KM = 6371;
const ST_COLOR_OK  = Cesium.Color.DODGERBLUE;
const ST_COLOR_BAD = Cesium.Color.RED;
// Cone start-distance bias, proportional to satScale (found via the debug
// slider: 140km bias needed at scale=500 → 0.28 km per unit of scale). Scales
// linearly because satScale is just a rendered-mesh size multiplier — a
// bigger model needs the cone apex pushed proportionally further out.
const ST_BIAS_KM_PER_SCALE_UNIT = 140 / 500;

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

// Base rendered-model mounting bias, all models: 180° about Z. Found via the
// debug X/Y/Z rotation sliders and baked in as a permanent correction, on top
// of any model-specific bias (e.g. _ffBias) — rendered model only, never the
// reference arrows.
const _modelBiasZ180 = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, Math.PI, new Cesium.Quaternion());

// Module-level scratch objects — reused every frame, never allocated in hot path
const _scratchM3  = new Cesium.Matrix3();
const _scratchCol = new Cesium.Cartesian3();
const _scratchDir   = new Cesium.Cartesian3();
const _scratchAxis  = new Cesium.Cartesian3();
const _scratchSun   = new Cesium.Cartesian3();
const _scratchNadir = new Cesium.Cartesian3();

// Quaternion rotating local +Z onto an arbitrary unit direction — used to orient
// the star tracker cone (Cesium's CylinderGeometry is built along local Z).
function _quatFromZTo(dir, out) {
  const dot = Cesium.Cartesian3.dot(Cesium.Cartesian3.UNIT_Z, dir);
  if (dot > 0.9999999) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY, out);
  if (dot < -0.9999999) return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI, out);
  Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, dir, _scratchAxis);
  Cesium.Cartesian3.normalize(_scratchAxis, _scratchAxis);
  const angle = Math.acos(Cesium.Math.clamp(dot, -1, 1));
  return Cesium.Quaternion.fromAxisAngle(_scratchAxis, angle, out);
}

export class SatEntity {
  constructor(viewer, sat) {
    this.viewer = viewer;
    this.sat = sat;
    this.cesiumColor = Cesium.Color.fromCssColorString(sat.color);
    this._renderedColor = sat.color; // snapshot — GlobeView uses this to detect color changes
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
    // Preallocated Cartesian3 objects — mutated in place every frame, no per-frame allocation
    this._xBase  = new Cesium.Cartesian3();
    this._yBase  = new Cesium.Cartesian3();
    this._zBase  = new Cesium.Cartesian3();
    this._sunBase= new Cesium.Cartesian3();
    this._xTip   = new Cesium.Cartesian3();
    this._yTip   = new Cesium.Cartesian3();
    this._zTip   = new Cesium.Cartesian3();
    this._sunTip = new Cesium.Cartesian3();
    // Stable two-element arrays — both elements are stable Cartesian3 refs mutated in place
    this._xPos   = null; // set to [this._xBase, this._xTip] in _build
    this._yPos   = null;
    this._zPos   = null;
    this._sunPos = null;
    // Star tracker FOV cone (+Z face) — position/orientation mutated in place
    // every frame; _stViolated flips the cone red when the sun or Earth is
    // currently inside this satellite's configured exclusion angle.
    this._starTrackerEntity = null;
    this._stConePos    = new Cesium.Cartesian3();
    this._stConeOrient = new Cesium.Quaternion();
    this._stViolated   = false;
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

    // ECI-frame arrows — all Cartesian3 elements are stable refs mutated in place
    const initQ = this._computeOrientation(r, date);
    Cesium.Cartesian3.clone(origin, this._xBase);
    Cesium.Cartesian3.clone(origin, this._yBase);
    Cesium.Cartesian3.clone(origin, this._zBase);
    Cesium.Cartesian3.clone(origin, this._sunBase);
    this._computeArrowTips(origin, r, date, initQ);
    {
      this._xPos   = [this._xBase,   this._xTip];
      this._yPos   = [this._yBase,   this._yTip];
      this._zPos   = [this._zBase,   this._zTip];
      this._sunPos = [this._sunBase, this._sunTip];

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

    // Star tracker FOV cone, sharing the apex/axis _updateStarTrackerCone
    // (called from _computeArrowTips above) already populated in
    // _stConePos/_stConeOrient. Color and show are CallbackProperty so the
    // Sun/Earth-exclusion violation state and the Settings-modal visibility
    // toggle apply live, on the next render tick — no entity rebuild needed.
    const stLenM    = ST_LEN_KM * 1000;
    const stRadiusM = stLenM * Math.tan(ST_HALF_ANGLE_DEG * Math.PI / 180);
    const stColor   = () => (this._stViolated ? ST_COLOR_BAD : ST_COLOR_OK);
    this._starTrackerEntity = this._add({
      position:    new Cesium.CallbackProperty(() => this._stConePos, false),
      orientation: new Cesium.CallbackProperty(() => this._stConeOrient, false),
      cylinder: {
        length: stLenM,
        topRadius: stRadiusM,
        bottomRadius: 0,
        // Entity.show is a plain boolean (not a reactive Property) — a
        // CallbackProperty assigned there is just always-truthy and never
        // actually re-evaluated. CylinderGraphics.show IS Property-typed, so
        // the live toggle (satellite visibility × the Settings-modal toggle)
        // has to live here instead — this is also why setVisible() below
        // skips this entity: e.show=v there is harmless/inert either way,
        // but relying on it would look like it "worked" while doing nothing.
        show: new Cesium.CallbackProperty(() => this.sat.visible !== false && satStarTrackerConesVisible(this.sat.noradId), false),
        material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => stColor().withAlpha(0.22), false)),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => stColor().withAlpha(0.7), false),
        outlineWidth: 1,
      },
    });
  }

  // Orientation quaternion.
  // If current sim time falls inside the posted attitude table → SLERP.
  // Outside the table span → fall back to Default Sun Pointing.
  _computeOrientation(r, date) {
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

  // Body-frame bias applied only to the rendered model, not to the reference
  // arrows (those are set straight from _computeOrientation's q, see update()
  // and _updateArrows below).
  _modelOrientation(q) {
    let out = Cesium.Quaternion.multiply(q, _modelBiasZ180, new Cesium.Quaternion());
    if (this.sat.model === 'FF') out = Cesium.Quaternion.multiply(out, _ffBias, new Cesium.Quaternion());
    return out;
  }

  _updateArrows(origin, r, date, q) {
    if (!this._xPos) return;
    Cesium.Cartesian3.clone(origin, this._xBase);
    Cesium.Cartesian3.clone(origin, this._yBase);
    Cesium.Cartesian3.clone(origin, this._zBase);
    Cesium.Cartesian3.clone(origin, this._sunBase);
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

    // Arrow ↔ column mapping. Column0 of the orientation matrix is the sun
    // direction (see _computeOrientation); the Z arrow uses -column0, so -Z
    // faces the sun (confirmed correct — this was briefly flipped to +column0
    // and then reverted back to this original mapping).
    // col(i) negated inline — avoids Cartesian3 allocation per column
    Cesium.Matrix3.getColumn(_scratchM3, 2, _scratchCol);
    tipInto(this._xTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);

    Cesium.Matrix3.getColumn(_scratchM3, 1, _scratchCol);
    tipInto(this._yTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);

    Cesium.Matrix3.getColumn(_scratchM3, 0, _scratchCol);
    tipInto(this._zTip, -_scratchCol.x, -_scratchCol.y, -_scratchCol.z);
    Cesium.Cartesian3.clone(_scratchCol, _scratchSun); // column0 = sun direction in ECEF (see _computeOrientation) — zTip above uses -column0, but _scratchCol itself is untouched by tipInto, so this is still +sun

    this._updateStarTrackerCone(origin, _scratchSun);

    const { eciPos, gmst } = r;
    const sun = sunDirectionECI(date); // cached — free second call
    this._inEclipse = isInEclipse(eciPos, sun);
    const sl = ARROW_LEN_KM;
    const sunEci = { x: eciPos.x + sun.x*sl, y: eciPos.y + sun.y*sl, z: eciPos.z + sun.z*sl };
    const sunEcef = eciToCartesian3(sunEci, gmst);
    this._sunTip.x = sunEcef.x; this._sunTip.y = sunEcef.y; this._sunTip.z = sunEcef.z;
  }

  // Boresight = -sun direction (the far side from the sun-facing face),
  // computed directly rather than read off an arrow so the tracker's
  // mounting face stays a physical fact, not tied to axis labeling.
  //
  // Cesium's CylinderGeometry is built along local +Z, so the cone's
  // orientation is "rotate +Z onto the boresight direction". Its position is
  // the geometry's centroid (Cesium cylinders are centered, not apex-anchored),
  // with bottomRadius=0 landing the apex exactly at the satellite and
  // topRadius=<cone radius> landing the wide end out along the boresight.
  //
  // Also checks the Sun/Earth exclusion angles here (not drawn as their own
  // cones — see ST_COLOR_BAD): angle between the boresight and the sun, and
  // between the boresight and nadir (ECEF is Earth-centered, so "toward
  // Earth" from the satellite's own ECEF position is just -normalize(origin)).
  _updateStarTrackerCone(origin, sunDirEcef) {
    Cesium.Cartesian3.negate(sunDirEcef, _scratchDir); // boresight = -sun, the other side
    const halfLen = (ST_LEN_KM * 1000) / 2;
    // Shifts apex + centroid together along the boresight, proportional to
    // the current model scale, so the cone's start point (apex) tracks the
    // visible edge of the (scaled) model instead of sitting at its origin.
    const biasM = ST_BIAS_KM_PER_SCALE_UNIT * store.satScale * 1000;
    this._stConePos.x = origin.x + _scratchDir.x * (halfLen + biasM);
    this._stConePos.y = origin.y + _scratchDir.y * (halfLen + biasM);
    this._stConePos.z = origin.z + _scratchDir.z * (halfLen + biasM);
    _quatFromZTo(_scratchDir, this._stConeOrient);

    Cesium.Cartesian3.normalize(origin, _scratchNadir);
    Cesium.Cartesian3.negate(_scratchNadir, _scratchNadir);

    const sunDot   = Cesium.Math.clamp(Cesium.Cartesian3.dot(_scratchDir, sunDirEcef), -1, 1);
    const earthDot = Cesium.Math.clamp(Cesium.Cartesian3.dot(_scratchDir, _scratchNadir), -1, 1);
    const sunAngleDeg   = Cesium.Math.toDegrees(Math.acos(sunDot));
    const earthAngleDeg = Cesium.Math.toDegrees(Math.acos(earthDot));

    // Earth's keep-out zone is centered on nadir but its true radius is the
    // planet's own angular size as seen from orbit (~65-70° at LEO), not just
    // satEarthExclDeg alone — otherwise the check only trips when the
    // boresight points within satEarthExclDeg of Earth's *center*, which
    // barely ever happens (it's a ~22°-wide cone vs. Earth's ~66°-wide disc).
    const rMag = Cesium.Cartesian3.magnitude(origin);
    const earthRadiusDeg = Cesium.Math.toDegrees(Math.asin(Cesium.Math.clamp((R_EARTH_KM * 1000) / rMag, -1, 1)));

    this._stViolated = sunAngleDeg   < satSunExclDeg(this.sat.noradId)
                     || earthAngleDeg < earthRadiusDeg + satEarthExclDeg(this.sat.noradId);
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

  // Skips the star tracker entity — its .show is a CallbackProperty that
  // already reads this.sat.visible itself (see _build), so a plain e.show=v
  // here would permanently overwrite/disable that live reactivity instead.
  setVisible(v) {
    for (const e of this._entities) {
      if (e === this._starTrackerEntity) continue;
      e.show = v;
    }
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
    this._starTrackerEntity = null;
  }
}

function cross(a, b) {
  return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x };
}
