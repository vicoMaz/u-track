import { store } from '../store.js';
import { SatEntity } from './SatEntity.js';
import { GroundStation } from './GroundStation.js';

/* global Cesium */

let viewer = null;
const entities   = new Map(); // satId → SatEntity
const gsEntities = new Map(); // gsId  → GroundStation

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
    if (key === 'currentTime')    updatePositions();
    if (key === 'satellites')     syncEntities();
    if (key === 'trackedSatId')   applyTracking();
    if (key === 'groundStations') syncGSEntities();
  });
}

function syncEntities() {
  const currentIds = new Set(store.satellites.map(s => s.id));

  for (const sat of store.satellites) {
    if (!entities.has(sat.id)) {
      entities.set(sat.id, new SatEntity(viewer, sat));
    }
  }

  for (const [id, ent] of entities) {
    if (!currentIds.has(id)) {
      ent.destroy();
      entities.delete(id);
    }
  }

  // Auto-track: if the tracked sat was deleted, pick the first remaining one.
  // But respect an explicit user untrack (trackedSatId === null && _manualUntrack).
  const ids = store.satellites.map(s => s.id);
  let keepTracked = store.trackedSatId;
  if (keepTracked !== null && !ids.includes(keepTracked)) {
    // Tracked satellite was removed — auto-pick the first remaining
    keepTracked = ids[0] ?? null;
  } else if (keepTracked === null && !store._manualUntrack) {
    // First satellite ever added — auto-track it
    keepTracked = ids[0] ?? null;
  }
  if (keepTracked !== store.trackedSatId) {
    store.setTrackedSat(keepTracked); // triggers applyTracking via subscription
    store._manualUntrack = false;     // this was an automatic pick, not user-driven
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
  // Sync footprint visibility (Entity.show is a plain boolean, not a Property)
  for (const gs of store.groundStations) {
    gsEntities.get(gs.id)?.updateFootprint(gs.showFootprint);
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
  if (!viewer) return;
  const t = store.currentTime;
  for (const ent of entities.values()) ent.update(t);
}

export function getViewer() { return viewer; }
