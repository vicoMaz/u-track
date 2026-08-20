import { propagate } from '../tle.js';
import * as satellite from 'satellite.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { store } from '../store.js';
import { satSunExclDeg, satEarthExclDeg, satStarTrackerConesVisible, MODEL_STAR_TRACKERS, ST_FOV_HALF_ANGLE_DEG } from '../satStarTracker.js';
import { sampleAttitudeTable, DEFAULT_MAX_GAP_MS } from '../attitudeSample.js';
import { resolveRealAttitudeEntries, applyRealAttitudeModelCorrection } from '../satAttitudeReal.js';

/* global Cesium */

const ORBIT_STEPS = 120;
const ARROW_LEN_KM = 640;
const MODEL_BASE_SCALE = 800;

// Star tracker: each satellite MODEL can carry one or more physical units
// (see MODEL_STAR_TRACKERS below), each rendered as its own translucent FOV
// cone. The Sun/Earth exclusion angles (per-satellite configurable in
// Settings — satStarTracker.js) aren't drawn as their own cones; instead each
// FOV cone turns red whenever the sun or Earth (nadir direction) is currently
// inside that satellite's configured keep-out angle around ITS boresight.
const ST_HALF_ANGLE_DEG = ST_FOV_HALF_ANGLE_DEG;
const ST_LEN_KM = 500;
const R_EARTH_KM = 6371;
// Top-of-atmosphere altitude (~Kármán line) — matches TimePlayer.js's
// EARTH_LIMB_KM, kept in sync so the 3D globe's cone coloring and the STT
// POV widget always agree on blinded/clear for the same satellite.
const EARTH_LIMB_KM = 100;
/** ECI position → Cesium Cartesian3 (meters).
 *  Lives here rather than in tle.js because it is the one function in that
 *  module that touched the global `Cesium`, and tle.js is imported by
 *  apiPoller/MapView/store — i.e. by code that must keep working when Cesium
 *  isn't loaded at all (it is fetched on demand now, see main.js's ensureGlobe).
 *  SatEntity.js is globe-only and already evaluates Cesium.* at module scope, so
 *  this is where the dependency belongs. Only ever called from this file. */
function eciToCartesian3(eciPos, gmst) {
  const ecef = satellite.eciToEcf(eciPos, gmst);
  return Cesium.Cartesian3.fromElements(ecef.x * 1000, ecef.y * 1000, ecef.z * 1000);
}

const ST_COLOR_OK  = Cesium.Color.DODGERBLUE;
const ST_COLOR_BAD = Cesium.Color.RED;

// Per-model star tracker mounting (MODEL_STAR_TRACKERS) now lives in
// satStarTracker.js — shared with TimePlayer.js's gantt blinding-window
// precomputation, which needs the identical cone definitions.

const MODEL_URIS = {
  '12U': '/models/12UV1.glb',
  'FF':  '/models/FFV1.glb',
};

// FF model rotation bias: 270° around X only (body-frame, post-multiplied).
// Found by eye with the debug X/Y/Z rotation sliders (since removed — see
// _modelOrientation) and baked in here as a permanent correction.
const _r = d => (d * Math.PI) / 180;
const _ffBias = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, _r(270), new Cesium.Quaternion());

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
const _scratchOffset = new Cesium.Cartesian3();
const _scratchBodyDir = new Cesium.Cartesian3();
// _computeOrientation/_attitudeFromTable's purely-internal intermediates —
// each is fully overwritten before being read, every call, by exactly one
// satellite at a time (SatEntity.update() runs sequentially per satellite,
// never concurrently), so sharing these across satellites/frames is safe.
// The QUATERNION EACH FUNCTION ACTUALLY RETURNS is deliberately NOT scratch
// — it can end up stored inside a Cesium ConstantProperty via setValue, and
// reusing that object across later frames would risk silently corrupting an
// already-rendered orientation if Cesium ever holds the reference rather
// than cloning it.
const _scratchZenith = { x: 0, y: 0, z: 0 };
const _scratchYRaw   = { x: 0, y: 0, z: 0 };
const _scratchYECI   = { x: 0, y: 0, z: 0 };
const _scratchZECI   = { x: 0, y: 0, z: 0 };
const _scratchXEcef  = new Cesium.Cartesian3();
const _scratchYEcef  = new Cesium.Cartesian3();
const _scratchZEcef  = new Cesium.Cartesian3();
const _scratchQGmst  = new Cesium.Quaternion();
const _scratchQBody  = new Cesium.Quaternion();

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
    // Star tracker FOV cones — one per entry in MODEL_STAR_TRACKERS[sat.model],
    // built in _build(). Each element: { entity, cfg, pos, orient, violated }
    // — pos/orient are mutated in place every frame; `violated` flips that
    // cone red when the sun or Earth is currently inside this satellite's
    // configured exclusion angle around ITS OWN boresight.
    this._starTrackers = [];
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

    // Star tracker FOV cone(s) — one entity per MODEL_STAR_TRACKERS entry for
    // this satellite's model, sharing the apex/axis _updateStarTrackerCones
    // (called from _computeArrowTips above) already populated into each
    // st.pos/st.orient. Color and show are CallbackProperty so the
    // Sun/Earth-exclusion violation state and the Settings-modal visibility
    // toggle apply live, on the next render tick — no entity rebuild needed.
    const stLenM    = ST_LEN_KM * 1000;
    const stRadiusM = stLenM * Math.tan(ST_HALF_ANGLE_DEG * Math.PI / 180);
    const cones = MODEL_STAR_TRACKERS[this.sat.model] ?? MODEL_STAR_TRACKERS['12U'];
    this._starTrackers = cones.map(cfg => {
      const st = { cfg, pos: new Cesium.Cartesian3(), orient: new Cesium.Quaternion(), violated: false };
      const stColor = () => (st.violated ? ST_COLOR_BAD : ST_COLOR_OK);
      // One scratch Color per cone per use (fill vs. outline need separate
      // instances — both callbacks can be evaluated within the same frame,
      // and each writes into its own via withAlpha's `result` param instead
      // of allocating a new Cesium.Color every single render frame.
      const fillScratch    = new Cesium.Color();
      const outlineScratch = new Cesium.Color();
      st.entity = this._add({
        position:    new Cesium.CallbackProperty(() => st.pos, false),
        orientation: new Cesium.CallbackProperty(() => st.orient, false),
        cylinder: {
          length: stLenM,
          topRadius: stRadiusM,
          bottomRadius: 0,
          // Entity.show is a plain boolean (not a reactive Property) — a
          // CallbackProperty assigned there is just always-truthy and never
          // actually re-evaluated. CylinderGraphics.show IS Property-typed, so
          // the live toggle (satellite visibility × the Settings-modal toggle)
          // has to live here instead — this is also why setVisible() below
          // skips these entities: e.show=v there is harmless/inert either way,
          // but relying on it would look like it "worked" while doing nothing.
          show: new Cesium.CallbackProperty(() => this.sat.visible !== false && satStarTrackerConesVisible(this.sat.noradId), false),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => stColor().withAlpha(0.22, fillScratch), false)),
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() => stColor().withAlpha(0.7, outlineScratch), false),
          outlineWidth: 1,
        },
      });
      return st;
    });

    // _computeArrowTips (called above, before this._starTrackers existed)
    // already tried to call _updateStarTrackerCones once, but it no-op'd via
    // its own `if (!this._starTrackers.length) return;` guard — at that point
    // this._starTrackers was still the constructor's empty array. Left alone,
    // every st.pos/st.orient would sit at their raw `new Cesium.Cartesian3()`/
    // `new Cesium.Quaternion()` default — (0,0,0) and (0,0,0,1) — until the
    // NEXT update() tick. (0,0,0) is Earth's own center: a genuinely
    // degenerate position with no defined longitude/latitude, and Cesium's
    // own render loop runs independently of our tick cadence, so it can (and
    // does) try to render this cylinder with that degenerate position before
    // any second tick ever arrives — crashing deep in its geometry-combining
    // pipeline ("Cannot read properties of undefined (reading 'longitude')").
    // Populate real values immediately, now that this._starTrackers actually
    // exists, using the same origin/_scratchSun _computeArrowTips already
    // computed for this satellite this call (nothing async has touched those
    // module-level scratch objects since).
    this._updateStarTrackerCones(origin, _scratchSun);
  }

  // Orientation quaternion.
  // Priority: real (MIC, live-fetched — satAttitudeReal.js) → legacy posted
  // (store.attitude, POST /api/attitude) → Default Sun Pointing.
  //
  // This SLERP path is what makes the star tracker's Sun-exclusion check
  // meaningful at all: under Default Sun Pointing alone, col-0 (body +X) is
  // *defined* to equal the sun direction every single frame, so the angle
  // between ANY body-frame-fixed direction and the sun is a mathematical
  // constant for the whole mission (proof: for fixed body dir (dx,dy,dz),
  // dot(dir_ECI, sun) = dx·dot(col0,sun) + dy·dot(col1,sun) + dz·dot(col2,sun)
  // = dx·1 + dy·0 + dz·0 = dx, always — col1/col2 are orthogonal to col0=sun
  // by construction). Only a real, independently-sourced attitude can make
  // that angle actually vary, which is exactly what these tables provide.
  _computeOrientation(r, date) {
    const { eciPos, gmst } = r;
    const tMs = date.getTime();

    const realEntries = resolveRealAttitudeEntries(this.sat.noradId, tMs);
    if (realEntries) {
      const q = this._attitudeFromTable(realEntries, tMs, gmst, true);
      if (q) return q;
    }

    // Legacy externally-posted attitude — unrelated to MIC, kept as a
    // lower-priority fallback for whatever else might still POST /api/attitude.
    const att = store.attitude[this.sat.noradId];
    if (att?.entries?.length) {
      const tableQ = this._attitudeFromTable(att.entries, tMs, gmst);
      if (tableQ) return tableQ;
    }

    const sun = sunDirectionECI(date); // unit vector in ECI

    // Primary (exact):   col-0 toward sun  →  displayed −Z faces sun
    const xECI = sun;

    // Secondary (best-effort): col-1 toward zenith (anti-nadir)  →  displayed −Y faces anti-nadir
    // Project zenith onto the plane perpendicular to the sun vector (Gram-Schmidt)
    const rLen = Math.sqrt(eciPos.x**2 + eciPos.y**2 + eciPos.z**2);
    if (!rLen) return Cesium.Quaternion.IDENTITY;
    const zenith = _scratchZenith;
    zenith.x = eciPos.x/rLen; zenith.y = eciPos.y/rLen; zenith.z = eciPos.z/rLen;
    const dot  = zenith.x*xECI.x + zenith.y*xECI.y + zenith.z*xECI.z;
    const yRaw = _scratchYRaw;
    yRaw.x = zenith.x - dot*xECI.x; yRaw.y = zenith.y - dot*xECI.y; yRaw.z = zenith.z - dot*xECI.z;
    const yLen = Math.sqrt(yRaw.x**2 + yRaw.y**2 + yRaw.z**2);
    if (yLen < 1e-6) return Cesium.Quaternion.IDENTITY; // sun ≈ zenith, degenerate
    const yECI = _scratchYECI;
    yECI.x = yRaw.x/yLen; yECI.y = yRaw.y/yLen; yECI.z = yRaw.z/yLen;

    // Tertiary: col-2 completes the right-hand frame
    const zECI = _scratchZECI;
    zECI.x = xECI.y*yECI.z - xECI.z*yECI.y;
    zECI.y = xECI.z*yECI.x - xECI.x*yECI.z;
    zECI.z = xECI.x*yECI.y - xECI.y*yECI.x;

    const c = Math.cos(gmst), s = Math.sin(gmst);
    function toEcef(v, out) {
      out.x = v.x*c + v.y*s; out.y = -v.x*s + v.y*c; out.z = v.z;
      return out;
    }

    Cesium.Matrix3.setColumn(_scratchM3, 0, toEcef(xECI, _scratchXEcef), _scratchM3);
    Cesium.Matrix3.setColumn(_scratchM3, 1, toEcef(yECI, _scratchYEcef), _scratchM3);
    Cesium.Matrix3.setColumn(_scratchM3, 2, toEcef(zECI, _scratchZEcef), _scratchM3);

    return Cesium.Quaternion.fromRotationMatrix(_scratchM3);
  }

  // SLERPs an attitude table (real from MIC, or legacy posted via POST
  // /api/attitude — same shape either way) to `tMs`, returning an ECEF
  // quaternion directly comparable to _computeOrientation's fallback — or
  // null if tMs falls outside the table's span, or the bracketing samples are
  // too far apart to trust (see attitudeSample.js's sampleAttitudeTable), so
  // the caller falls back further down the chain.
  //
  // Convention: each table entry is body→ECI, the same one
  // _computeOrientation's fallback builds (xECI/yECI/zECI) before its own
  // ECI→ECEF gmst rotation — NOT the separate scalar-first body-frame-offset
  // convention satStarTracker.js's bodyDirFromQuat uses for STT mounting.
  // Confirmed against MIC's real feed (satAttitudeReal.js's parseApm) by live
  // A/B comparison — MIC's raw (Q1,Q2,Q3,QC), plus a separate live-calibrated
  // body-frame correction (both applied in parseApm itself), already matches
  // this convention.
  // `isReal`: true only when `entries` came from resolveRealAttitudeEntries
  // — gates applyRealAttitudeModelCorrection to the real (MIC) branch,
  // never the legacy-posted one.
  _attitudeFromTable(entries, tMs, gmst, isReal = false) {
    let plainQ = sampleAttitudeTable(entries, tMs, DEFAULT_MAX_GAP_MS);
    if (!plainQ) return null;
    if (isReal) plainQ = applyRealAttitudeModelCorrection(plainQ, this.sat.model);

    _scratchQBody.x = plainQ.x; _scratchQBody.y = plainQ.y; _scratchQBody.z = plainQ.z; _scratchQBody.w = plainQ.w;
    Cesium.Quaternion.normalize(_scratchQBody, _scratchQBody);

    // Same ECI→ECEF rotation as toEcef() above, expressed as a quaternion
    // (rotation by -gmst about Z) instead of a per-column matrix transform.
    const qGmst = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, -gmst, _scratchQGmst);
    return Cesium.Quaternion.multiply(qGmst, _scratchQBody, new Cesium.Quaternion());
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

    this._updateStarTrackerCones(origin, _scratchSun);

    const { eciPos, gmst } = r;
    const sun = sunDirectionECI(date); // cached — free second call
    this._inEclipse = isInEclipse(eciPos, sun);
    const sl = ARROW_LEN_KM;
    const sunEci = { x: eciPos.x + sun.x*sl, y: eciPos.y + sun.y*sl, z: eciPos.z + sun.z*sl };
    const sunEcef = eciToCartesian3(sunEci, gmst);
    this._sunTip.x = sunEcef.x; this._sunTip.y = sunEcef.y; this._sunTip.z = sunEcef.z;
  }

  // Updates every star tracker cone this satellite's model has (see
  // MODEL_STAR_TRACKERS). Boresight per cone:
  //   'anti-sun' — cfg.dir is ignored; boresight = -sun directly (the far
  //     side from the sun-facing face), matching the original single-cone
  //     behavior exactly.
  //   'body' — cfg.dir is a fixed body-frame unit vector, rotated into ECEF
  //     via _scratchM3 (the same orientation matrix _computeArrowTips just
  //     built from `q`, still valid here — this method is only ever called
  //     from within _computeArrowTips, synchronously, before _scratchM3 is
  //     reused by anything else).
  //
  // Cesium's CylinderGeometry is built along local +Z, so each cone's
  // orientation is "rotate +Z onto the boresight direction". Its position is
  // the geometry's centroid (Cesium cylinders are centered, not apex-anchored),
  // with bottomRadius=0 landing the apex exactly at the satellite (+ offset)
  // and topRadius=<cone radius> landing the wide end out along the boresight.
  //
  // Also checks the Sun/Earth exclusion angles here (not drawn as their own
  // cones — see ST_COLOR_BAD): angle between the boresight and the sun, and
  // between the boresight and nadir (ECEF is Earth-centered, so "toward
  // Earth" from the satellite's own ECEF position is just -normalize(origin)).
  _updateStarTrackerCones(origin, sunDirEcef) {
    if (!this._starTrackers.length) return;
    const halfLen = (ST_LEN_KM * 1000) / 2;

    Cesium.Cartesian3.normalize(origin, _scratchNadir);
    Cesium.Cartesian3.negate(_scratchNadir, _scratchNadir);
    // Earth's keep-out zone is centered on nadir but its true radius is the
    // planet's own angular size as seen from orbit (~65-70° at LEO), not just
    // satEarthExclDeg alone — otherwise the check only trips when the
    // boresight points within satEarthExclDeg of Earth's *center*, which
    // barely ever happens (it's a ~22°-wide cone vs. Earth's ~66°-wide disc).
    const rMag = Cesium.Cartesian3.magnitude(origin);
    // Top-of-atmosphere radius, not the solid surface — see EARTH_LIMB_KM.
    const earthLimbRadiusDeg = Cesium.Math.toDegrees(Math.asin(Cesium.Math.clamp(((R_EARTH_KM + EARTH_LIMB_KM) * 1000) / rMag, -1, 1)));
    const sunExclDeg   = satSunExclDeg(this.sat.noradId);
    const earthExclDeg = satEarthExclDeg(this.sat.noradId);

    this._starTrackers.forEach((st, i) => {
      const { cfg } = st;
      if (cfg.mode === 'body') {
        // cfg.dir is given in the arrow-labeled body frame (X/Y/Z as drawn —
        // see _computeArrowTips), not the orientation matrix's raw columns:
        // X-arrow=-col2, Y-arrow=-col1, Z-arrow=-col0. So a labeled-frame
        // vector (vx,vy,vz) = vx·X + vy·Y + vz·Z = -vz·col0 - vy·col1 - vx·col2,
        // i.e. the input to multiplyByVector (which weights raw columns) is
        // (-vz,-vy,-vx) — swapped-and-negated, not a straight pass-through.
        _scratchBodyDir.x = -cfg.dir.z; _scratchBodyDir.y = -cfg.dir.y; _scratchBodyDir.z = -cfg.dir.x;
        Cesium.Matrix3.multiplyByVector(_scratchM3, _scratchBodyDir, _scratchDir);
        Cesium.Cartesian3.normalize(_scratchDir, _scratchDir);
      } else {
        Cesium.Cartesian3.negate(sunDirEcef, _scratchDir); // boresight = -sun, the other side
      }

      // cfg.offsetKmPerScaleUnit scaled by the current satScale (same reason
      // biasM below is), then the same labeled-frame → raw-column conversion
      // as `dir` above.
      const offX = cfg.offsetKmPerScaleUnit.x * store.satScale;
      const offY = cfg.offsetKmPerScaleUnit.y * store.satScale;
      const offZ = cfg.offsetKmPerScaleUnit.z * store.satScale;
      _scratchOffset.x = -offZ; _scratchOffset.y = -offY; _scratchOffset.z = -offX;
      Cesium.Matrix3.multiplyByVector(_scratchM3, _scratchOffset, _scratchOffset);

      // Shifts apex + centroid together along the boresight, proportional to
      // the current model scale, so the cone's start point (apex) tracks the
      // visible edge of the (scaled) model instead of sitting at its origin.
      const biasM = cfg.biasKmPerScaleUnit * store.satScale * 1000;
      const px = origin.x + _scratchOffset.x * 1000 + _scratchDir.x * (halfLen + biasM);
      const py = origin.y + _scratchOffset.y * 1000 + _scratchDir.y * (halfLen + biasM);
      const pz = origin.z + _scratchOffset.z * 1000 + _scratchDir.z * (halfLen + biasM);

      // This cylinder's position/orientation are read live by Cesium every
      // frame (CallbackProperty) — a NaN here (e.g. from _scratchDir ending
      // up a zero vector before normalize, or any upstream degenerate
      // orientation) doesn't error at the point of assignment, it crashes
      // much later and much harder to trace, deep inside Cesium's own
      // geometry-combining pipeline ("Cannot read properties of undefined
      // (reading 'longitude')" — a Cartographic conversion silently
      // returning undefined for a degenerate input). Skip committing a bad
      // frame entirely and let the cone keep showing its last good pose
      // instead of ever handing Cesium invalid geometry.
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)
          || !Number.isFinite(_scratchDir.x) || !Number.isFinite(_scratchDir.y) || !Number.isFinite(_scratchDir.z)) {
        return;
      }

      st.pos.x = px; st.pos.y = py; st.pos.z = pz;
      _quatFromZTo(_scratchDir, st.orient);

      const sunDot   = Cesium.Math.clamp(Cesium.Cartesian3.dot(_scratchDir, sunDirEcef), -1, 1);
      const earthDot = Cesium.Math.clamp(Cesium.Cartesian3.dot(_scratchDir, _scratchNadir), -1, 1);
      const sunAngleDeg   = Cesium.Math.toDegrees(Math.acos(sunDot));
      const earthAngleDeg = Cesium.Math.toDegrees(Math.acos(earthDot));

      st.violated = sunAngleDeg   < sunExclDeg
                 || earthAngleDeg < earthLimbRadiusDeg + earthExclDeg;
    });
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

  // Skips the star tracker entities — their .show is a CallbackProperty that
  // already reads this.sat.visible itself (see _build), so a plain e.show=v
  // here would permanently overwrite/disable that live reactivity instead.
  setVisible(v) {
    for (const e of this._entities) {
      if (this._starTrackers.some(st => st.entity === e)) continue;
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
    this._starTrackers = [];
  }
}
