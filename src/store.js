// Group raw /api/v1/data/antennas entries into one marker per (network, site_id),
// averaging coordinates across antennas sharing a site. Virtual/database endpoints
// (antenna_type !== 'rf') have no real location and are excluded.
function _groupSites(rawList) {
  const bySite = new Map(); // `${network}::${siteId}` → { network, siteId, latSum, lonSum, count }
  for (const a of rawList) {
    if (a.antenna_type !== 'rf') continue;
    const siteId = a.location?.site_id;
    const coords = a.location?.coordinates;
    if (!siteId || !coords) continue;
    const key = `${a.network}::${siteId}`;
    let e = bySite.get(key);
    if (!e) { e = { network: a.network, siteId, latSum: 0, lonSum: 0, count: 0 }; bySite.set(key, e); }
    e.latSum += coords.latitude;
    e.lonSum += coords.longitude;
    e.count  += 1;
  }
  return [...bySite.values()].map(e => ({
    network: e.network,
    siteId:  e.siteId,
    lat:     e.latSum / e.count,
    lon:     e.lonSum / e.count,
    count:   e.count,
  }));
}

// Shared application state
export const store = {
  currentTime: new Date(),
  satellites: [],      // { id, noradId, name, color, satrec }
  groundStations: [],  // DERIVED — rebuilt by _rebuildGroundStations(). { id, name, lat, lon, color, network, satId, showFootprint }
  satAntennas: {},     // satId → raw array from GET /api/v1/data/antennas
  antennaToggles: {},  // `${satId}:${network}` → bool (visible), default true when absent
  showFootprints: false,
positions: {},       // { [noradId]: last propagated result } — written by SatEntity, read by SatInfo
  _satById: new Map(), // id → sat, for O(1) lookups
  pingStatus: {},      // satId → 'ok' | 'pending' | 'timeout' | 'error' | 'unconfigured'
  satTelemetry: {},    // satId → { receptionTime, sysMode, gncMode, battVoltage, events }
  satPasses: {},       // satId → [{ id, start, end, aos5, los5, station, network, future }]
  satTmr: {},          // satId → { rangeStart, rangeEnd, gapWindows: [{start,end}] }
  satGnss: {},              // satId → { lastBothGood: Date|null, hkIsValid: bool|null }
  satEventBaseline: {},     // satId → { normal, low, med, high } — cumulative counts 24 h ago
  satGroundEvents: {},      // satId → { watch, warning, distress, critical } — GROUND event counts, last 24h
  satGlobals: {},           // satId → { bdsVersion, proceduresVersion, sccVersion, sccColor }
  satVersions: {},          // satId → { fds, scc, sccRo, gnm, mic } each { version, appUrl } | null
  // noradId → { noradId, source, entries: [{ t: ms, q: {x,y,z,w} }] } | undefined.
  // Real posted attitude (see POST /api/attitude), keyed by noradId (not satId)
  // to match apiPoller.js's feed items. SatEntity.js's _computeOrientation
  // SLERPs within this table when the current sim time falls inside its span,
  // falling back to Default Sun Pointing outside it or when absent entirely —
  // most satellites will simply never have an entry here.
  attitude: {},
  satScale: 500,
  orbitAlt: 590,       // km — shared by night shadow + GS footprint
  trackedSatId: null,
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
      delete this.satPasses[sat.id];
      delete this.satTmr[sat.id];
      delete this.satGnss[sat.id];
      delete this.satEventBaseline[sat.id];
      delete this.satAntennas[sat.id];
      delete this.attitude[sat.noradId];
      for (const key of Object.keys(this.antennaToggles)) {
        if (key.startsWith(`${sat.id}:`)) delete this.antennaToggles[key];
      }
    }
    this._rebuildGroundStations();
    this.notify('satellites');
    this.notify('groundStations');
  },

  get trackedSat() {
    return this._satById.get(this.trackedSatId) ?? null;
  },

  // ── Ground stations (derived from per-satellite antenna discovery) ─────

  _rebuildGroundStations() {
    const out = [];
    for (const sat of this.satellites) {
      const raw = this.satAntennas[sat.id];
      if (!raw || !raw.length) continue;
      for (const site of _groupSites(raw)) {
        const visible = this.antennaToggles[`${sat.id}:${site.network}`] ?? true;
        if (!visible) continue;
        out.push({
          id:            `${sat.id}:${site.network}:${site.siteId}`,
          name:          site.siteId,
          network:       site.network,
          satId:         sat.id,
          lat:           site.lat,
          lon:           site.lon,
          color:         sat.color,
          showFootprint: this.showFootprints,
          antennaCount:  site.count,
        });
      }
    }
    this.groundStations = out;
  },

  setSatAntennas(satId, list) {
    this.satAntennas[satId] = list;
    this._rebuildGroundStations();
    this.notify('satAntennas');
    this.notify('groundStations');
  },

  setAntennaToggle(satId, network, visible) {
    this.antennaToggles[`${satId}:${network}`] = visible;
    this._rebuildGroundStations();
    this.notify('antennaToggles');
    this.notify('groundStations');
  },

  setShowFootprints(v) {
    this.showFootprints = v;
    this._rebuildGroundStations();
    this.notify('groundStations');
  },

  // [{ network, siteCount }] for the given satellite — for panel rendering
  getSatNetworks(satId) {
    const raw = this.satAntennas[satId];
    if (!raw || !raw.length) return [];
    const perNetwork = new Map();
    for (const site of _groupSites(raw)) {
      perNetwork.set(site.network, (perNetwork.get(site.network) ?? 0) + 1);
    }
    return [...perNetwork.entries()]
      .map(([network, siteCount]) => ({ network, siteCount }))
      .sort((a, b) => a.network.localeCompare(b.network));
  },

setPingStatus(satId, status) {
    this.pingStatus[satId] = status;
    this.notify('pingStatus');
  },

  setSatTelemetry(satId, data) {
    this.satTelemetry[satId] = data;
    this.notify('satTelemetry');
  },

  setSatPasses(satId, passes) {
    this.satPasses[satId] = passes;
    this.notify('satPasses');
  },

  setTmrWindows(satId, windows) {
    this.satTmr[satId] = windows;
    this.notify('tmrData');
  },

  setSatGnss(satId, data) {
    this.satGnss[satId] = data;
    this.notify('satGnss');
  },

  setSatEventBaseline(satId, data) {
    this.satEventBaseline[satId] = data;
    // no extra notify needed — read on next satTelemetry render
  },

  setSatGroundEvents(satId, data) {
    this.satGroundEvents[satId] = data;
    this.notify('satGroundEvents');
  },

  setSatGlobals(satId, data) {
    this.satGlobals[satId] = data;
    this.notify('satGlobals');
  },

  setSatVersions(satId, data) {
    this.satVersions[satId] = data;
    this.notify('satVersions');
  },

  // data = { noradId, source, entries } from GET/POST /api/attitude, or null
  // to clear (DELETE /api/attitude/:noradId — reverts to Default Sun Pointing).
  setAttitude(noradId, data) {
    if (data) this.attitude[noradId] = data;
    else delete this.attitude[noradId];
    this.notify('attitude');
  },

  updateSatTle(noradId, satrec) {
    const sat = this.satellites.find(s => s.noradId === noradId);
    if (sat) { sat.satrec = satrec; this.notify('satellites'); }
  },

  setSatModel(satId, model) {
    const sat = this._satById.get(satId);
    if (sat) { sat.model = model; this.notify('satellites'); }
  },

  setSatColor(satId, color) {
    const sat = this._satById.get(satId);
    if (sat) { sat.color = color; this.notify('satellites'); }
  },

  setSatName(satId, name) {
    const sat = this._satById.get(satId);
    if (sat && name) { sat.name = name; this.notify('satellites'); }
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
    this.trackedSatId = id;
    this.notify('trackedSatId');
  },
};

export const PALETTE = [
  '#00d4ff', '#ff6b35', '#00ff9d', '#ff3860',
  '#c77dff', '#ffbe0b', '#fb5607', '#8338ec',
];
