import L from 'leaflet';
import { propagate } from '../tle.js';

const TRACK_POINTS = 200;

export class SatMarker {
  constructor(map, sat) {
    this.map = map;
    this.sat = sat;
    this.color = sat.color;
    this._visible = false;
    this._lastTrackMs = -Infinity;

    this.marker = L.circleMarker([0, 0], {
      radius: 6,
      color: this.color,
      fillColor: this.color,
      fillOpacity: 0.9,
      weight: 2,
    });
    // Don't add to map until we have a valid position
    this.marker.bindTooltip(sat.name, { permanent: false, direction: 'top' });
    this.trackLines = [];
  }

  update(date) {
    const result = propagate(this.sat.satrec, date);
    if (!result) return;

    if (!this._visible) {
      this.marker.addTo(this.map);
      this._visible = true;
    }

    this.marker.setLatLng([result.lat, result.lon]);

    // Recompute track when time jumps in either direction
    const nowMs = date.getTime();
    if (Math.abs(nowMs - this._lastTrackMs) > 5000) {
      this._updateTrack(date);
      this._lastTrackMs = nowMs;
    }
  }

  _updateTrack(date) {
    for (const line of this.trackLines) line.remove();
    this.trackLines = [];

    const { no: meanMotion } = this.sat.satrec;
    if (!meanMotion || meanMotion <= 0) return;
    const periodMin = (2 * Math.PI) / meanMotion;
    const stepMin = periodMin / TRACK_POINTS;

    const points = [];
    for (let i = 0; i <= TRACK_POINTS; i++) {
      const t = new Date(date.getTime() + (i - TRACK_POINTS / 2) * stepMin * 60000);
      const r = propagate(this.sat.satrec, t);
      if (r) points.push([r.lat, r.lon]);
    }

    // Split at antimeridian
    const segments = [];
    let seg = [];
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && Math.abs(points[i][1] - points[i - 1][1]) > 180) {
        segments.push(seg);
        seg = [];
      }
      seg.push(points[i]);
    }
    if (seg.length) segments.push(seg);

    for (const s of segments) {
      if (s.length < 2) continue;
      const line = L.polyline(s, {
        color: this.color,
        weight: 1.5,
        opacity: 0.6,
      }).addTo(this.map);
      this.trackLines.push(line);
    }
  }

  destroy() {
    this.marker.remove();
    for (const line of this.trackLines) line.remove();
  }
}
