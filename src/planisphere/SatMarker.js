import L from 'leaflet';
import { propagate } from '../tle.js';

const TRACK_POINTS = 200;

export class SatMarker {
  constructor(map, sat) {
    this.map = map;
    this.sat = sat;
    this.color = sat.color;
    this._visible = false;
    this._lastTrackMs   = -Infinity;
    this._lastTrackWall = -Infinity;

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

    // Recompute track when sim-time jumps, but cap at once per 500 ms wall-clock
    // to avoid a GPU/GC storm at high playback speeds
    const nowMs  = date.getTime();
    const wallMs = Date.now();
    if (Math.abs(nowMs - this._lastTrackMs) > 5000 && wallMs - this._lastTrackWall > 500) {
      this._updateTrack(date);
      this._lastTrackMs   = nowMs;
      this._lastTrackWall = wallMs;
    }
  }

  _updateTrack(date) {
    const { no: meanMotion } = this.sat.satrec;
    if (!meanMotion || meanMotion <= 0) return;
    const periodMin = (2 * Math.PI) / meanMotion;
    const stepMin   = periodMin / TRACK_POINTS;
    const t0        = date.getTime() - (TRACK_POINTS / 2) * stepMin * 60000;

    const points = [];
    const d = new Date(); // reused — avoids 200 Date allocations per recompute
    for (let i = 0; i <= TRACK_POINTS; i++) {
      d.setTime(t0 + i * stepMin * 60000);
      const r = propagate(this.sat.satrec, d);
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

    // Reuse existing polyline objects — update latlngs in place, avoiding DOM mutations
    const needed = segments.filter(s => s.length >= 2);
    while (this.trackLines.length < needed.length)
      this.trackLines.push(L.polyline([], { color: this.color, weight: 1.5, opacity: 0.6 }).addTo(this.map));
    while (this.trackLines.length > needed.length)
      this.trackLines.pop().remove();
    needed.forEach((s, i) => this.trackLines[i].setLatLngs(s));
  }

  destroy() {
    this.marker.remove();
    for (const line of this.trackLines) line.remove();
  }
}
