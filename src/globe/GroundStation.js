import { store } from '../store.js';

/* global Cesium */

const R_EARTH_M = 6_371_000; // metres

export class GroundStation {
  constructor(viewer, gs) {
    this._viewer   = viewer;
    this._gs       = gs;       // live reference — same object as store.groundStations[i]
    this._entities = [];
    this._build();
  }

  _build() {
    const { lat, lon, name, color } = this._gs;
    const col = Cesium.Color.fromCssColorString(color);
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

    // Ground marker + label
    this._entities.push(
      this._viewer.entities.add({
        position: pos,
        point: {
          pixelSize: 9,
          color: col,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: name,
          font: '11px sans-serif',
          fillColor: col,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(12, -8),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      })
    );

    // Visibility footprint — ellipse whose radius tracks store.orbitAlt via CallbackProperty.
    // Entity.show is a plain boolean; it must be set imperatively via updateFootprint().
    const radiusCb = new Cesium.CallbackProperty(() => {
      const rho = Math.acos(Math.min(1, R_EARTH_M / (R_EARTH_M + store.orbitAlt * 1000)));
      return rho * R_EARTH_M;
    }, false);

    this._footprintEntity = this._viewer.entities.add({
      show: false,
      position: pos,
      ellipse: {
        semiMajorAxis: radiusCb,
        semiMinorAxis: radiusCb,
        material: col.withAlpha(0.12),
        outline: true,
        outlineColor: col,
        outlineWidth: 2,
        height: 0, // place on ellipsoid surface; avoids terrain-clamping warnings
      },
    });
    this._entities.push(this._footprintEntity);
  }

  setVisible(v) {
    if (this._entities[0]) this._entities[0].show = v;
    if (!v && this._footprintEntity) this._footprintEntity.show = false;
  }

  updateFootprint(show) {
    if (this._footprintEntity) this._footprintEntity.show = show;
  }

  destroy() {
    for (const e of this._entities) this._viewer.entities.remove(e);
    this._entities = [];
    this._footprintEntity = null;
  }
}
