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
    // A malformed/partial response can have a truthy `coordinates` object
    // with a missing or non-numeric latitude/longitude — silently poisons
    // this site's running average to NaN forever (NaN + anything = NaN),
    // which later crashes deep inside Cesium's geometry pipeline when
    // GroundStation.js hands it to Cartesian3.fromDegrees.
    if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) continue;
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

// User-added lat/lon markers (Visualizer "Points" panel) — persisted locally,
// independent of any satellite/antenna discovery.
const CUSTOM_POINTS_KEY = 'chadops-custom-points';
const CUSTOM_POINT_COLOR = '#ffd60a';

// Real ground antennas don't track down to the true horizon — terrain/RF
// noise near 0° elevation makes that angle unusable in practice, so every
// GNM-collected antenna site gets this minimum-elevation mask by default
// (drives the footprint circle radius in both the 2D map and 3D globe, same
// as a custom point's own optional `mask`).
const GNM_DEFAULT_MASK_DEG = 5;

function _loadCustomPoints() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_POINTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function _saveCustomPoints(points) {
  try { localStorage.setItem(CUSTOM_POINTS_KEY, JSON.stringify(points)); } catch {}
}

// Shared application state
export const store = {
  currentTime: new Date(),
  satellites: [],      // { id, noradId, name, color, satrec }
  groundStations: [],  // DERIVED — rebuilt by _rebuildGroundStations(). { id, name, lat, lon, color, network, satId, showFootprint }
  customPoints: _loadCustomPoints(), // [{ id, name, lat, lon, mask, satId, visible }] — user-added markers, persisted to localStorage
  satAntennas: {},     // satId → raw array from GET /api/v1/data/antennas
  antennaToggles: {},  // `${satId}:${network}` → bool (visible), default true when absent
  showFootprints: false,
positions: {},       // { [noradId]: last propagated result } — written by SatEntity, read by SatInfo
  _satById: new Map(), // id → sat, for O(1) lookups
  pingStatus: {},      // satId → 'ok' | 'pending' | 'timeout' | 'error' | 'unconfigured'
  // Whether THIS client can currently reach the satellite at all — set by
  // satPing.js after a few consecutive ping failures (VPN routing varies per
  // user; not every colleague can reach every satellite). Defaults to true
  // (optimistic) until proven otherwise, so a satellite doesn't flash-hide
  // before its first ping even resolves. Never persisted — it describes this
  // browser session's network, not a fact about the satellite itself.
  satAccessible: {},   // satId → bool
  // Per-subsystem reachability (scc/fds/gnm/mic — sccRo is covered by
  // pingStatus itself), probed by satPing.js once the main ping succeeds.
  // Lets the UI tell "fully reachable" apart from "only SCC RO (read-only)
  // is reachable" for the same satellite. null = not yet probed.
  satSubsystemReachable: {}, // satId → { scc, fds, gnm, mic } → true | false | null
  satTelemetry: {},    // satId → { receptionTime, sysMode, gncMode, battVoltage, events }
  satPasses: {},       // satId → [{ id, start, end, aos5, los5, station, network, future }]
  satTmr: {},          // satId → { [source]: { rangeStart, rangeEnd, gapWindows: [{start,end}] } } — source: 'bus' | 'pay' (see tmrData.js's TMR_SOURCES)
  satGnss: {},              // satId → { lastBothGood: Date|null, hkIsValid: bool|null }
  satGnssMitigation: {},    // satId → { count30d, lastMs: number|null, windowStartMs, saturated } | undefined
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
  // noradId → { noradId, source:'mic', entries: [{ t: ms, q: {x,y,z,w} }] } |
  // undefined. Real attitude fetched live from MIC (see satAttitudeReal.js) —
  // client-local ONLY, never sent to or persisted by the server. Kept
  // deliberately separate from `attitude` above (the server-shared POST
  // /api/attitude slot, populated independently by apiPoller.js's feed poll)
  // so the two producers can never silently stomp each other for the same
  // noradId. Consumers check this first, then `attitude`, then fall back to
  // Default Sun Pointing.
  realAttitude: {},
  // satId → { entries: [{ t: bucketMs, sysMode, gncMode, battVoltage, battSoc }] }
  // | undefined. sysMode/gncMode/battery % queried AT A SPECIFIC SIM TIME
  // (see satTelemetryReal.js) — a 30s-bucket-grid cache so SatInfo.js's panel
  // stays coherent with whatever instant TimePlayer is showing, instead of
  // always reflecting "right now" like satTelemetry above. Client-local only,
  // kept separate from satTelemetry (which still drives ChadOps.js's Fleet
  // table — that view always wants live "now" regardless of the Visualizer's
  // scrub position).
  satTelemetryReal: {},
  playbackSpeed: 1, // TimePlayer.js's sim-time multiplier — satAttitudeReal.js reads this to know whether real attitude can plausibly be fetched fast enough to keep up with how quickly sim time is advancing
  // Whether TimePlayer.js is actively auto-advancing sim time right now
  // (startPlay/stopPlay) — separate from playbackSpeed, which is just the
  // currently-SELECTED multiplier and persists across pause/scrub. Read by
  // satAttitudeReal.js so its high-speed real-attitude cutoff (MAX_SPEED_FOR_REAL)
  // only applies while actually playing fast, not merely because a fast
  // speed happens to still be selected while paused/scrubbing.
  playing: false,
  satScale: 500,
  orbitAlt: 590,       // km — shared by night shadow + GS footprint
  trackedSatId: null,
  // { satId, start: ms } | null — whichever pass currently has PassDetailPanel's
  // slide-in open, regardless of which view (Fleet dots, Weekly Schedule, the
  // gantt) opened it. `start` (not the pass object itself, which gets replaced
  // wholesale on every satPasses refetch) identifies the pass so ChadOps.js can
  // still match it against a freshly-fetched passes array.
  selectedPass: null,
  // satId → [{ key, version, recipient, originator, description, comments,
  // start, end, status, statusInfo }] — MIC's Plan distribution service (see
  // planData.js), fills the gantt's "Plans" row. Per-satellite, same scoping
  // as satTmr/satPasses: each satellite's own MIC box hosts its own Plan
  // distribution instance (see satSubsystems.js's SUBSYSTEMS.planApi).
  satPlans: {},
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

  // Reorders the underlying array itself — every view (Fleet, Settings, the
  // Visualizer sidebar) just iterates `satellites`/`accessibleSatellites` in
  // whatever order they're already in, so this one move is what every list
  // reflects at once, not something each view has to separately sort by.
  // Persisting that order across a reload is the CALLER's job (see
  // apiPoller.js's saveSatOrder/loadInitialState) — this only touches the
  // in-memory array.
  moveSatellite(id, toIndex) {
    const fromIndex = this.satellites.findIndex(s => s.id === id);
    if (fromIndex === -1 || fromIndex === toIndex) return;
    const [sat] = this.satellites.splice(fromIndex, 1);
    this.satellites.splice(toIndex, 0, sat);
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
      delete this.satPlans[sat.id];
      delete this.satGnss[sat.id];
      delete this.satGnssMitigation[sat.id];
      delete this.satEventBaseline[sat.id];
      delete this.satAntennas[sat.id];
      delete this.attitude[sat.noradId];
      delete this.realAttitude[sat.noradId];
      delete this.satTelemetryReal[sat.id];
      delete this.satAccessible[sat.id];
      delete this.satSubsystemReachable[sat.id];
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

  // ── Per-client network reachability (VPN-dependent — see satPing.js) ───

  // The satellites THIS client can actually reach right now — every
  // operational/live view (sat-list, Fleet table, globe, map, weekly
  // schedule) should iterate this instead of the raw `satellites` array, so
  // a colleague whose VPN doesn't route to a given satellite simply never
  // sees it rather than seeing a permanently-broken row. Settings' own
  // satellite list is a deliberate exception — you still need to see/manage
  // a satellite you personally can't reach (e.g. to fix its IP).
  get accessibleSatellites() {
    return this.satellites.filter(s => this.satAccessible[s.id] !== false);
  },

  setSatAccessible(satId, accessible) {
    if (this.satAccessible[satId] === accessible) return;
    this.satAccessible[satId] = accessible;
    this.notify('satAccessible');
  },

  setSubsystemReachable(satId, key, reachable) {
    this.satSubsystemReachable[satId] = { ...this.satSubsystemReachable[satId], [key]: reachable };
    this.notify('satSubsystemReachable');
  },

  // True when every reachable satellite is SCC-RO-only — i.e. this client's
  // VPN carries the read-only monitoring subnet but none of the
  // write-capable ones (SCC/FDS/GNM/MIC), so procedure scheduling, ground
  // station discovery, TMR gap data etc. will all come up empty everywhere.
  // Needs at least one reachable satellite to say anything either way.
  get readOnlyVpn() {
    const sats = this.accessibleSatellites;
    if (!sats.length) return false;
    return sats.every(s => {
      const r = this.satSubsystemReachable[s.id];
      return r && r.scc === false && r.fds === false && r.gnm === false && r.mic === false;
    });
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
          mask:          GNM_DEFAULT_MASK_DEG,
          showFootprint: this.showFootprints,
          antennaCount:  site.count,
        });
      }
    }
    for (const p of this.customPoints) {
      if (p.visible === false) continue; // same exclude-from-`out` pattern as a hidden antenna network above
      out.push({
        id:            p.id,
        name:          p.name,
        lat:           p.lat,
        lon:           p.lon,
        color:         CUSTOM_POINT_COLOR,
        mask:          p.mask, // elevation mask, degrees — undefined/null → no footprint
        // Tied to the same "◎ All" button that drives ground-station
        // footprints (this.showFootprints) — a mask circle IS a visibility
        // region, so it follows the same global show/hide as every other one.
        showFootprint: p.mask != null && this.showFootprints,
      });
    }
    this.groundStations = out;
  },

  // ── Custom points (user-added lat/lon markers) ──────────────────────────

  // mask: optional elevation-mask angle in degrees. When set, a visibility
  // circle (ground coverage at that minimum elevation, given store.orbitAlt)
  // is drawn on the globe/map around this point; when null, no circle.
  // satId: which satellite's site list this point was added from (see
  // InputPanel.js's "+ Point" row) — points are a per-satellite thing, this
  // is how they're grouped/listed there and removed again.
  addCustomPoint(name, lat, lon, mask = null, satId = null) {
    const point = {
      id:  `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name, lat, lon, mask, satId, visible: true,
    };
    this.customPoints.push(point);
    _saveCustomPoints(this.customPoints);
    this._rebuildGroundStations();
    this.notify('customPoints');
    this.notify('groundStations');
    return point;
  },

  removeCustomPoint(id) {
    this.customPoints = this.customPoints.filter(p => p.id !== id);
    _saveCustomPoints(this.customPoints);
    this._rebuildGroundStations();
    this.notify('customPoints');
    this.notify('groundStations');
  },

  // Same show/hide toggle pattern as toggleSatVisibility — hides the point
  // (marker + footprint) entirely without deleting it.
  setCustomPointVisible(id, visible) {
    const p = this.customPoints.find(p => p.id === id);
    if (!p) return;
    p.visible = visible;
    _saveCustomPoints(this.customPoints);
    this._rebuildGroundStations();
    this.notify('customPoints');
    this.notify('groundStations');
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

  setTmrWindows(satId, source, windows) {
    this.satTmr[satId] = { ...this.satTmr[satId], [source]: windows };
    this.notify('tmrData');
  },

  setPlans(satId, list) {
    this.satPlans[satId] = list;
    this.notify('plans');
  },

  setSatGnss(satId, data) {
    this.satGnss[satId] = data;
    this.notify('satGnss');
  },

  setSatGnssMitigation(satId, data) {
    this.satGnssMitigation[satId] = data;
    this.notify('satGnssMitigation');
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

  // data = { noradId, source:'mic', entries } from satAttitudeReal.js, or
  // null to clear. Client-local only — see the `realAttitude` field comment.
  setRealAttitude(noradId, data) {
    if (data) this.realAttitude[noradId] = data;
    else delete this.realAttitude[noradId];
    this.notify('realAttitude');
  },

  // data = { entries } from satTelemetryReal.js's bucket-grid cache.
  setSatTelemetryReal(satId, data) {
    this.satTelemetryReal[satId] = data;
    this.notify('satTelemetryReal');
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

  setPlaybackSpeed(v) {
    this.playbackSpeed = v;
    this.notify('playbackSpeed');
  },

  setPlaying(v) {
    this.playing = v;
    this.notify('playing');
  },

  setTrackedSat(id) {
    this.trackedSatId = id;
    this.notify('trackedSatId');
  },

  setSelectedPass(satId, start) {
    this.selectedPass = satId ? { satId, start } : null;
    this.notify('selectedPass');
  },

  clearSelectedPass() {
    if (!this.selectedPass) return;
    this.selectedPass = null;
    this.notify('selectedPass');
  },
};

// Seed groundStations with any persisted custom points immediately — otherwise
// they'd stay invisible until some satellite/antenna event happened to call
// _rebuildGroundStations() first.
store._rebuildGroundStations();

export const PALETTE = [
  '#00d4ff', '#ff6b35', '#00ff9d', '#ff3860',
  '#c77dff', '#ffbe0b', '#fb5607', '#8338ec',
];
