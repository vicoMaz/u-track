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
// Cached per-pixel arrays — reallocated only on canvas resize
let _nightLats = null, _nightLons = null, _nightImg = null;
let _nightW = 0, _nightH = 0;
const markers    = new Map(); // satId → SatMarker
const gsMarkers  = new Map(); // gsId  → GroundStation2D

const R_EARTH = 6371;

export function initMap() {
  if (!document.getElementById('map-view')) {
    console.error('[MapView] #map-view element not found — skipping init');
    return;
  }
  map = L.map('map-view', {
    center: [0, 0],
    zoom: 2,
    zoomSnap: 0,
    worldCopyJump: false,
    zoomControl: false,
  });

  // Zoom control on the right so it doesn't overlap the satellite panel
  L.control.zoom({ position: 'topright' }).addTo(map);

  const TILE_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  const TILE_ATTR  = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/">CARTO</a>';
  const TILE_OPTS  = { attribution: TILE_ATTR, subdomains: 'abcd', noWrap: false };

  let _darkMode  = true;
  let _tileLayer = L.tileLayer(TILE_DARK, TILE_OPTS).addTo(map);

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
  _fitWorld = () => {
    map.invalidateSize({ animate: false });
    // Fit zoom so the full latitude range fills the viewport height.
    // Tiles repeat east-west so the full width is always covered.
    const z = Math.log2(map.getSize().y / 256);
    map.setMinZoom(z);
    map.setView([0, 0], z, { animate: false });
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
        'line-height:28px;background:#1a1a28;color:#aaa;border:none;display:block;text-align:center;';
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stopPropagation(e);
        _fitWorld();
      });
      return btn;
    },
  });
  new HomeControl().addTo(map);

  const ThemeControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'leaflet-bar map-theme-btn');
      const update = () => {
        btn.textContent = _darkMode ? 'Light' : 'Dark';
        btn.title = _darkMode ? 'Switch to light map' : 'Switch to dark map';
        _tileLayer.remove();
        _tileLayer = L.tileLayer(_darkMode ? TILE_DARK : TILE_LIGHT, TILE_OPTS).addTo(map);
        tilePaneEl.style.filter = _darkMode ? 'brightness(3)' : '';
      };
      update();
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stopPropagation(e);
        _darkMode = !_darkMode;
        update();
      });
      return btn;
    },
  });
  const tilePaneEl = map.getPane('tilePane');
  new ThemeControl().addTo(map);
  tilePaneEl.style.filter = 'brightness(3)'; // dark mode default

  // Redraw night canvas whenever the map view changes (pan or zoom)
  // Also invalidate lat/lon cache since pixel→coord mapping changed
  map.on('move zoom', () => { _nightW = 0; _drawNight(store.currentTime, true); });

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
    const v = Math.max(400, Math.min(700, Math.round(+raw) || 590));
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

  // Reallocate lat/lon arrays and ImageData only when canvas dimensions change
  if (w !== _nightW || h !== _nightH) {
    _nightLats = new Float64Array(h);
    _nightLons = new Float64Array(w);
    _nightImg  = nightCtx.createImageData(w, h);
    _nightW = w; _nightH = h;
    for (let py = 0; py < h; py++)
      _nightLats[py] = map.containerPointToLatLng([0, py * SCALE]).lat * Math.PI / 180;
    for (let px = 0; px < w; px++)
      _nightLons[px] = map.containerPointToLatLng([px * SCALE, 0]).lng * Math.PI / 180;
  }
  const lats = _nightLats;
  const lons = _nightLons;
  const img  = _nightImg;
  const data = img.data;

  const umbraThreshold = Math.PI - Math.asin(R_EARTH / (R_EARTH + store.orbitAlt));

  const NIGHT_A  = 110;
  const SHADOW_A = 165;
  const HALF_PI  = Math.PI / 2;
  const BLEND    = 0.04;
  const DAY_COS  = Math.sin(BLEND); // cosD > this → full daylight, skip acos

  // Clear only — reused ImageData retains previous frame's bytes otherwise
  data.fill(0);

  for (let py = 0; py < h; py++) {
    const sinLat = Math.sin(lats[py]);
    const cosLat = Math.cos(lats[py]);
    const rowOff = py * w * 4;

    for (let px = 0; px < w; px++) {
      const cosD = sinSunLat * sinLat + cosSunLat * cosLat * Math.cos(lons[px] - sunLon);
      if (cosD > DAY_COS) continue; // full daylight — skip acos entirely (~50% of pixels)

      const d = Math.acos(Math.max(-1, Math.min(1, cosD)));
      if (d <= HALF_PI - BLEND) continue;

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
    if (!m) continue;
    m.setVisible(gs.visible !== false);
    if (gs.visible !== false) m.updateFootprint(store.orbitAlt, gs.showFootprint);
  }
}

// ─── Satellite markers ────────────────────────────────────────────────────

function syncMarkers() {
  const currentIds = new Set(store.satellites.map(s => s.id));
  for (const sat of store.satellites) {
    if (!markers.has(sat.id)) markers.set(sat.id, new SatMarker(map, sat));
    markers.get(sat.id)?.setVisible(sat.visible !== false);
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
  else console.warn('[MapView] invalidateMapSize called before map was initialized');
}
