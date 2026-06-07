import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import * as satjs from 'satellite.js';
import { store } from '../store.js';
import { SatMarker } from './SatMarker.js';
import { GroundStation2D } from './GroundStation2D.js';
import { sunDirectionECI } from '../sunVector.js';

let map        = null;
let nightCanvas = null;
let nightCtx   = null;
let _lastDrawMs = 0;
let _fitWorld  = null;
const markers    = new Map(); // satId → SatMarker
const gsMarkers  = new Map(); // gsId  → GroundStation2D

const R_EARTH = 6371;

export function initMap() {
  map = L.map('map-view', {
    center: [0, 0],
    zoom: 2,
    zoomSnap: 0,          // fractional zoom so home view fills width exactly
    worldCopyJump: false,
    zoomControl: false,   // add manually on the right side
    maxBounds: [[-90, -180], [90, 180]],
    maxBoundsViscosity: 1.0,
  });

  // Zoom control on the right so it doesn't overlap the satellite panel
  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    noWrap: true,
    bounds: [[-90, -180], [90, 180]], // suppress out-of-bounds tile requests
  }).addTo(map);

  // Night shadow sits between tile layer (z 200) and overlay layer (z 400)
  map.createPane('nightPane');
  const nightPane = map.getPane('nightPane');
  nightPane.style.zIndex    = '250';
  nightPane.style.pointerEvents = 'none';
  nightCanvas = document.createElement('canvas');
  nightCanvas.style.position = 'absolute';
  nightPane.appendChild(nightCanvas);
  nightCtx = nightCanvas.getContext('2d');

  // ── Home / fit-world function ───────────────────────────────────────────────
  // Calculate zoom so the full 360° longitude fills the visible width
  // (container minus the 240 px sidebar). This always gives a seamless
  // edge-to-edge planisphere regardless of screen aspect ratio.
  const SIDEBAR_W = 240;
  _fitWorld = () => {
    map.invalidateSize({ animate: false });
    const availW = Math.max(200, map.getSize().x - SIDEBAR_W);
    const z = Math.log2(availW / 256);
    map.setView([20, 0], z, { animate: false });
    _drawNight(store.currentTime, true);
  };

  // ── Home button control ─────────────────────────────────────────────────────
  const HomeControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'leaflet-bar leaflet-control-home');
      btn.innerHTML = '⌂';
      btn.title     = 'Full world view';
      btn.style.cssText =
        'width:30px;height:30px;cursor:pointer;font-size:18px;' +
        'line-height:28px;background:#fff;border:none;display:block;text-align:center;';
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stopPropagation(e);
        _fitWorld();
      });
      return btn;
    },
  });
  new HomeControl().addTo(map);

  // Redraw night canvas whenever the map view changes (pan or zoom)
  map.on('move zoom', () => _drawNight(store.currentTime, true));

  const container = document.getElementById('map-view');
  map.whenReady(() => {
    _fitWorld(); // initial fit
    new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      _drawNight(store.currentTime, true);
    }).observe(container);
  });

  // Shadow altitude control — writes to store so GS footprints share the same value
  const altSlider = document.getElementById('orbit-alt-slider');
  const altField  = document.getElementById('orbit-alt-field');
  const updateAlt = (raw) => {
    const v = Math.max(400, Math.min(700, Math.round(+raw) || 550));
    altSlider.value = v;
    altField.value  = v;
    store.setOrbitAlt(v);
  };
  altSlider.addEventListener('input',  () => updateAlt(altSlider.value));
  altField.addEventListener('change',  () => updateAlt(altField.value));
  altField.addEventListener('keydown', (e) => { if (e.key === 'Enter') updateAlt(altField.value); });

  store.subscribe((key) => {
    if (key === 'currentTime')    updateMarkers();
    if (key === 'satellites')     syncMarkers();
    if (key === 'groundStations') syncGSMarkers();
    if (key === 'orbitAlt') {
      _drawNight(store.currentTime, true);
      _updateGSFootprints();
    }
  });
}

// ─── Night / umbra overlay ─────────────────────────────────────────────────

function _drawNight(date, force = false) {
  if (!nightCtx || !map) return;
  const now = Date.now();
  if (!force && now - _lastDrawMs < 33) return; // ~30 fps cap
  _lastDrawMs = now;

  const sz = map.getSize();
  const W = sz.x | 0;
  const H = sz.y | 0;
  if (W === 0 || H === 0) return;

  // Render at half resolution then CSS-scale up — 4× cheaper for smooth panning
  const SCALE = 2;
  const w = Math.max(1, (W / SCALE) | 0);
  const h = Math.max(1, (H / SCALE) | 0);

  nightCanvas.width        = w;
  nightCanvas.height       = h;
  nightCanvas.style.width  = W + 'px';
  nightCanvas.style.height = H + 'px';

  // Keep canvas aligned with the container origin in layer-space
  const off = map.containerPointToLayerPoint([0, 0]);
  nightCanvas.style.left = off.x + 'px';
  nightCanvas.style.top  = off.y + 'px';

  // Subsolar point: ECI → ECEF via GMST
  const sunECI = sunDirectionECI(date);
  const gmst   = satjs.gstime(date);
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const ex = sunECI.x * cg + sunECI.y * sg;
  const ey = -sunECI.x * sg + sunECI.y * cg;
  const ez = sunECI.z;

  const sunLat    = Math.asin(Math.max(-1, Math.min(1, ez)));
  const sunLon    = Math.atan2(ey, ex);
  const sinSunLat = Math.sin(sunLat);
  const cosSunLat = Math.cos(sunLat);

  // Precompute lat for each canvas row, lon for each column (Mercator is separable)
  const lats = new Float64Array(h);
  const lons = new Float64Array(w);
  for (let py = 0; py < h; py++) {
    lats[py] = map.containerPointToLatLng([0, py * SCALE]).lat * Math.PI / 180;
  }
  for (let px = 0; px < w; px++) {
    lons[px] = map.containerPointToLatLng([px * SCALE, 0]).lng * Math.PI / 180;
  }

  const img  = nightCtx.createImageData(w, h);
  const data = img.data;

  const umbraThreshold = Math.PI - Math.asin(R_EARTH / (R_EARTH + store.orbitAlt));

  const NIGHT_A  = 110;
  const SHADOW_A = 165;
  const HALF_PI  = Math.PI / 2;
  const BLEND    = 0.04;

  for (let py = 0; py < h; py++) {
    const sinLat = Math.sin(lats[py]);
    const cosLat = Math.cos(lats[py]);
    const rowOff = py * w * 4;

    for (let px = 0; px < w; px++) {
      const cosD = sinSunLat * sinLat + cosSunLat * cosLat * Math.cos(lons[px] - sunLon);
      const d    = Math.acos(Math.max(-1, Math.min(1, cosD)));

      if (d <= HALF_PI - BLEND) continue; // full daylight — skip

      const nightT  = Math.min(1, (d - (HALF_PI - BLEND)) / (2 * BLEND));
      const shadowT = d > umbraThreshold - BLEND
        ? Math.min(1, (d - (umbraThreshold - BLEND)) / (2 * BLEND))
        : 0;

      const alpha = nightT * (NIGHT_A + (SHADOW_A - NIGHT_A) * shadowT);

      const idx = rowOff + px * 4;
      data[idx]     = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 20;
      data[idx + 3] = Math.round(alpha);
    }
  }

  nightCtx.putImageData(img, 0, 0);
}

// ─── Ground station markers ───────────────────────────────────────────────

function syncGSMarkers() {
  const currentIds = new Set(store.groundStations.map(g => g.id));
  for (const gs of store.groundStations) {
    if (!gsMarkers.has(gs.id)) gsMarkers.set(gs.id, new GroundStation2D(map, gs));
  }
  for (const [id, m] of gsMarkers) {
    if (!currentIds.has(id)) { m.destroy(); gsMarkers.delete(id); }
  }
  _updateGSFootprints();
}

function _updateGSFootprints() {
  for (const gs of store.groundStations) {
    const m = gsMarkers.get(gs.id);
    if (m) m.updateFootprint(store.orbitAlt, gs.showFootprint);
  }
}

// ─── Satellite markers ────────────────────────────────────────────────────

function syncMarkers() {
  const currentIds = new Set(store.satellites.map(s => s.id));
  for (const sat of store.satellites) {
    if (!markers.has(sat.id)) markers.set(sat.id, new SatMarker(map, sat));
  }
  for (const [id, m] of markers) {
    if (!currentIds.has(id)) { m.destroy(); markers.delete(id); }
  }
  updateMarkers();
}

function updateMarkers() {
  const t = store.currentTime;
  for (const m of markers.values()) m.update(t);
  _drawNight(t);
}

export function invalidateMapSize() {
  if (map && _fitWorld) _fitWorld();
}
