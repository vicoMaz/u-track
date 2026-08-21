import { store } from '../store.js';
import { SatEntity } from './SatEntity.js';
import { GroundStation } from './GroundStation.js';
import { satIsSimulated } from '../satSimu.js';
import { mapStyle, onMapStyleChange } from '../mapStyle.js';

/* global Cesium */

let viewer = null;
const entities   = new Map(); // satId → SatEntity
const gsEntities = new Map(); // gsId  → GroundStation

// Gates the per-frame propagation loop below to when the 3D Globe subtab is
// actually visible — without this, every satellite gets SGP4-propagated and
// its orientation/star-tracker cones rebuilt every currentTime tick (up to
// 60fps during playback) even while the user is looking at the Fleet table
// or the 2D map. Set by main.js on tab/subtab switches.
let _visible = true; // matches index.html's default: tracking tab + 3D Globe subtab both start active

export function setGlobeVisible(v) {
  const wasHidden = !_visible;
  _visible = v;
  if (v && wasHidden) updatePositions(); // catch up immediately instead of waiting for the next tick
}

export function initGlobe() {
  // Suppress Ion token requirement — we use our own tile providers
  Cesium.Ion.defaultAccessToken = '';

  try {
    viewer = new Cesium.Viewer('globe-view', {
      // Draw on demand instead of every animation frame. Cesium's default loop
      // re-renders continuously whether or not anything moved; this globe only
      // changes when updatePositions() runs (store 'currentTime'/'realAttitude'/
      // 'playbackSpeed', or a camera interaction, which Cesium marks dirty
      // itself). Paired with TimePlayer's MIN_APPLY_MS throttle that turns
      // ~60 renders/second into ~5.
      //
      // maximumRenderTimeChange: Infinity — without it Cesium force-renders
      // whenever its OWN clock has advanced past the threshold, which would
      // defeat the whole thing here, since updatePositions drives
      // viewer.clock.currentTime directly (see the frozen-clock comment below).
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      creditContainer: document.createElement('div'),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      // Provide our own imagery at construction time so Cesium never creates
      // a default Ion layer (which would fire a 401 with an empty token).
      // `false`, then _applyMapStyle adds the layer for whichever basemap the
      // dropdown has selected. Passing one here instead would mean building the
      // layer twice on any startup where the stored choice isn't the default.
      baseLayer: false,
    });
  } catch (e) {
    console.error('[GlobeView] Cesium init failed:', e);
    return;
  }

  // Cesium's own clock drives its rendered sun/lighting and defaults to the
  // system clock, ticking forward on its own every frame. Left alone, it never
  // matches store.currentTime once the TimePlayer is scrubbed away from "now" —
  // our custom sun arrow (driven by store.currentTime) would then point at the
  // simulated-time sun while Cesium's own sun stayed at the real-time one.
  // Freeze it and drive it ourselves from updatePositions() instead.
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime   = Cesium.JulianDate.fromDate(store.currentTime);

  _applyMapStyle();
  onMapStyleChange(_applyMapStyle);

  // Click on a satellite model in the 3D scene → track it
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (!Cesium.defined(picked) || !Cesium.defined(picked.id)) return;
    const entity = picked.id;
    for (const [id, ent] of entities) {
      if (ent.ownsEntity(entity)) {
        store.setTrackedSat(id);
        return;
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  store.subscribe((key) => {
    if (key === 'currentTime' || key === 'realAttitude' || key === 'playbackSpeed') updatePositions();
    if (key === 'satellites' || key === 'satAccessible') syncEntities();
    if (key === 'trackedSatId')   applyTracking();
    if (key === 'groundStations') syncGSEntities();
    // requestRenderMode means nothing reaches the screen until something asks
    // for a frame. Asking here — once, after whichever handler above ran —
    // covers every store-driven mutation in one place rather than relying on
    // each of them to remember (adding/removing satellites, retracking,
    // ground-station and footprint changes). The viewer is private to this
    // module (getViewer has no callers), so there is no other mutation route.
    // Camera interaction is Cesium's own business and already marks the scene
    // dirty. requestRender is idempotent within a frame, so the extra call on
    // the updatePositions path costs nothing.
    viewer?.scene.requestRender();
  });
}

// The two basemaps the dropdown offers. Both are Esri/ArcGIS REST endpoints,
// which need no API key — unlike Cesium's own default (Cesium World Imagery via
// ion), which requires a token this app deliberately clears.
//
//   base      the muted grey cartography this globe has always used: labels and
//             coastlines without imagery detail, so orbit tracks and station pins
//             stay the brightest thing on screen.
//   satellite true aerial/satellite photography down to street level.
//
// 'offline' is disabled in the dropdown and never reaches here; mapStyle() folds
// anything unrecognized back to 'base'.
const MAP_STYLE_IMAGERY = {
  base: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    maximumLevel: 16,
  }),
  satellite: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, Maxar, Earthstar Geographics',
    maximumLevel: 19,
  }),
};

// Swaps the base imagery layer in place. Satellite photography is much brighter
// and more colourful than the grey base map, enough to compete with the overlays
// drawn on top, so it gets dimmed and desaturated to keep the tracks and pins
// readable.
function _applyMapStyle() {
  if (!viewer) return;
  const style = mapStyle();
  const make  = MAP_STYLE_IMAGERY[style] ?? MAP_STYLE_IMAGERY.base;
  const layers = viewer.imageryLayers;
  layers.removeAll();
  layers.addImageryProvider(make());
  const base = layers.get(0);
  if (base && style === 'satellite') { base.brightness = 0.8; base.saturation = 0.85; }
  viewer.scene.requestRender();
}

function syncEntities() {
  // Only satellites THIS client can reach — see store.accessibleSatellites.
  // A satellite that goes unreachable simply disappears from the globe
  // instead of sitting there frozen at its last known position. Simulated
  // satellites (satSimu.js) are filtered out here too — "where is it right
  // now" only means something for a satellite actually tracking real time;
  // it still gets a normal Fleet row, just not a globe entity.
  const sats = store.accessibleSatellites.filter(s => !satIsSimulated(s.noradId));
  const currentIds = new Set(sats.map(s => s.id));

  for (const sat of sats) {
    if (!entities.has(sat.id)) {
      entities.set(sat.id, new SatEntity(viewer, sat));
    } else {
      const ent = entities.get(sat.id);
      if (ent._renderedColor !== sat.color) {
        ent.destroy();
        entities.set(sat.id, new SatEntity(viewer, sat));
      }
    }
  }

  for (const [id, ent] of entities) {
    if (!currentIds.has(id)) {
      ent.destroy();
      entities.delete(id);
    }
  }

  // Apply user visibility
  for (const sat of sats) {
    entities.get(sat.id)?.setVisible(sat.visible !== false);
  }

  // Auto-track: if the tracked sat was deleted (or became unreachable), pick
  // the first remaining one. Deliberately does NOT auto-track on initial
  // load — no satellite should be tracked by default, since tracking drives
  // extra background requests (TMR gap scan) that shouldn't fire until the
  // user actually picks a satellite.
  const ids = sats.map(s => s.id);
  let keepTracked = store.trackedSatId;
  if (keepTracked !== null && !ids.includes(keepTracked)) {
    // Tracked satellite was removed — auto-pick the first remaining
    keepTracked = ids[0] ?? null;
  }
  if (keepTracked !== store.trackedSatId) {
    store.setTrackedSat(keepTracked); // triggers applyTracking via subscription
  } else {
    applyTracking();
  }

  updatePositions();
}

function syncGSEntities() {
  const currentIds = new Set(store.groundStations.map(g => g.id));
  for (const gs of store.groundStations) {
    if (!gsEntities.has(gs.id)) gsEntities.set(gs.id, new GroundStation(viewer, gs));
  }
  for (const [id, ent] of gsEntities) {
    if (!currentIds.has(id)) { ent.destroy(); gsEntities.delete(id); }
  }
  for (const gs of store.groundStations) {
    const ent = gsEntities.get(gs.id);
    if (!ent) continue;
    ent.setVisible(gs.visible !== false);
    if (gs.visible !== false) ent.updateFootprint(gs.showFootprint);
  }
}

function applyTracking() {
  if (!viewer) return;
  const id = store.trackedSatId;
  for (const [sid, ent] of entities) ent.setSelected(sid === id);
  if (!id) { viewer.trackedEntity = undefined; return; }
  const ent = entities.get(id);
  if (ent) viewer.trackedEntity = ent.getTrackEntity();
}

function updatePositions() {
  if (!viewer || !_visible) return;
  const t = store.currentTime;
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(t);
  for (const ent of entities.values()) ent.update(t);
  // Required by requestRenderMode (see the Viewer options above): entity
  // mutations done this way don't reliably mark the scene dirty on their own,
  // and without this the globe would simply stop updating. One explicit request
  // per batch of updates is exactly the point — it's what replaces 60fps.
  viewer.scene.requestRender();
}

export function getViewer() { return viewer; }
