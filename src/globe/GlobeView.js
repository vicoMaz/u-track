import { store } from '../store.js';
import { SatEntity } from './SatEntity.js';
import { GroundStation } from './GroundStation.js';

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

  const darkGray = new Cesium.UrlTemplateImageryProvider({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    maximumLevel: 16,
  });

  try {
    viewer = new Cesium.Viewer('globe-view', {
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
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(
        Promise.resolve(darkGray), {}
      ),
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
  });
}

function syncEntities() {
  // Only satellites THIS client can reach — see store.accessibleSatellites.
  // A satellite that goes unreachable simply disappears from the globe
  // instead of sitting there frozen at its last known position.
  const sats = store.accessibleSatellites;
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
}

export function getViewer() { return viewer; }
