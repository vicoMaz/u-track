// Shared application state
export const store = {
  currentTime: new Date(),
  satellites: [],      // { id, noradId, name, color, satrec }
  groundStations: [],  // { id, name, lat, lon, color, showFootprint }
  attitudes: {},       // { [noradId]: { source, entries:[{t(ms), q:{x,y,z,w}}] } }
  positions: {},       // { [noradId]: last propagated result } — written by SatEntity, read by SatInfo
  _satById: new Map(), // id → sat, for O(1) lookups
  pingStatus: {},      // satId → 'ok' | 'pending' | 'timeout' | 'error' | 'unconfigured'
  satTelemetry: {},    // satId → { receptionTime, sysMode, gncMode, battVoltage, events }
  satScale: 500,
  orbitAlt: 550,       // km — shared by night shadow + GS footprint
  trackedSatId: null,
  _manualUntrack: false,  // true after user explicitly clicks away from tracking
  _listeners: [],

  subscribe(fn) { this._listeners.push(fn); },

  notify(key) {
    for (const fn of this._listeners) fn(key, this);
  },

  setTime(date) {
    this.currentTime = date;
    this.notify('currentTime');
  },

  addSatellite(sat) {
    this.satellites.push({ visible: true, ...sat });
    this._satById.set(sat.id, this.satellites[this.satellites.length - 1]);
    this.notify('satellites');
  },

  toggleSatVisibility(id) {
    const sat = this._satById.get(id);
    if (sat) { sat.visible = !sat.visible; this.notify('satellites'); }
  },

  removeSatellite(id) {
    const sat = this._satById.get(id);
    this.satellites = this.satellites.filter(s => s.id !== id);
    this._satById.delete(id);
    if (sat) {
      delete this.positions[sat.noradId];
      delete this.satTelemetry[sat.id];
      if (this.attitudes[sat.noradId]) {
        delete this.attitudes[sat.noradId];
        this.notify('attitudes');
      }
    }
    this.notify('satellites');
  },

  get trackedSat() {
    return this._satById.get(this.trackedSatId) ?? null;
  },

  addGroundStation(gs) {
    this.groundStations.push({ visible: true, showFootprint: false, ...gs });
    this.notify('groundStations');
  },

  toggleGSVisibility(id) {
    const gs = this.groundStations.find(g => g.id === id);
    if (gs) { gs.visible = !gs.visible; this.notify('groundStations'); }
  },

  removeGroundStation(id) {
    this.groundStations = this.groundStations.filter(g => g.id !== id);
    this.notify('groundStations');
  },

  updateGroundStation(id, updates) {
    const gs = this.groundStations.find(g => g.id === id);
    if (!gs) return;
    Object.assign(gs, updates);
    this.notify('groundStations');
  },

  toggleGSFootprint(id) {
    const gs = this.groundStations.find(g => g.id === id);
    if (gs) { gs.showFootprint = !gs.showFootprint; this.notify('groundStations'); }
  },

  setAttitude(noradId, entry) {
    if (entry === null) {
      delete this.attitudes[noradId];
    } else {
      this.attitudes[noradId] = entry;
    }
    this.notify('attitudes');
  },

  setPingStatus(satId, status) {
    this.pingStatus[satId] = status;
    this.notify('pingStatus');
  },

  setSatTelemetry(satId, data) {
    this.satTelemetry[satId] = data;
    this.notify('satTelemetry');
  },

  setOrbitAlt(v) {
    this.orbitAlt = v;
    this.notify('orbitAlt');
  },

  setScale(v) {
    this.satScale = v;
    this.notify('satScale');
  },

  setTrackedSat(id) {
    this._manualUntrack = (id === null);
    this.trackedSatId = id;
    this.notify('trackedSatId');
  },
};

export const PALETTE = [
  '#00d4ff', '#ff6b35', '#00ff9d', '#ff3860',
  '#c77dff', '#ffbe0b', '#fb5607', '#8338ec',
];

export const GS_PALETTE = [
  '#ff9f43', '#ee5a24', '#c4e538', '#009432',
  '#a29bfe', '#fd79a8', '#fdcb6e', '#00cec9',
];
