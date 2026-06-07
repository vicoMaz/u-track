// Shared application state
export const store = {
  currentTime: new Date(),
  satellites: [],      // { id, noradId, name, color, satrec }
  groundStations: [],  // { id, name, lat, lon, color, showFootprint }
  attitudes: {},       // { [noradId]: { source, entries:[{t(ms), q:{x,y,z,w}}] } }
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
    this.satellites.push(sat);
    this.notify('satellites');
  },

  removeSatellite(id) {
    const sat = this.satellites.find(s => s.id === id);
    this.satellites = this.satellites.filter(s => s.id !== id);
    if (sat && this.attitudes[sat.noradId]) {
      delete this.attitudes[sat.noradId];
      this.notify('attitudes');
    }
    this.notify('satellites');
  },

  addGroundStation(gs) {
    this.groundStations.push({ showFootprint: false, ...gs });
    this.notify('groundStations');
  },

  removeGroundStation(id) {
    this.groundStations = this.groundStations.filter(g => g.id !== id);
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
