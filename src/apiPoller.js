import * as satjs from 'satellite.js';
import { store, PALETTE, GS_PALETTE } from './store.js';
import { setSatBaseUrl } from './satPing.js';

let satIdCounter = 9000;
let gsIdCounter  = 9000;

function parseSatEntry(item) {
  try {
    const lines = item.tle.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const line1 = lines.find(l => l.startsWith('1 ') && l.length >= 60);
    const line2 = lines.find(l => l.startsWith('2 ') && l.length >= 60);
    if (!line1 || !line2) return null;
    const noradId = item.noradId || line1.substring(2, 7).trim();
    if (store.satellites.some(s => s.noradId === noradId)) return null; // already loaded
    const satrec = satjs.twoline2satrec(line1, line2);
    if (satrec.error !== 0) return null;
    const nameLineIdx = lines.indexOf(line1) - 1;
    const tleName = nameLineIdx >= 0 ? lines[nameLineIdx] : '';
    const name  = item.name || tleName || `SAT-${noradId}`;
    const id    = `sat-api-${++satIdCounter}`;
    const color = PALETTE[store.satellites.length % PALETTE.length];
    const model = item.model === 'FF' ? 'FF' : '12U';
    return { id, noradId, name, color, satrec, model };
  } catch { return null; }
}

function parseGsEntry(item) {
  if (store.groundStations.some(g => g.id === item.id)) return null; // already loaded
  const id    = item.id || `gs-api-${++gsIdCounter}`;
  const color = GS_PALETTE[store.groundStations.length % GS_PALETTE.length];
  const name  = item.name || item.shortName || `GS-${id}`;
  return { id, name, lat: item.lat, lon: item.lon, color };
}

// Load the full persistent state on page startup
export async function loadInitialState() {
  try {
    const [satRes, gsRes, attRes] = await Promise.all([
      fetch('/api/satellites'),
      fetch('/api/stations'),
      fetch('/api/attitude'),
    ]);
    if (satRes.ok) {
      const sats = await satRes.json();
      for (const item of sats) {
        // Seed localStorage from server-persisted baseUrl (wins over stale local value)
        if (item.baseUrl) setSatBaseUrl(item.noradId, item.baseUrl);
        const sat = parseSatEntry(item);
        if (sat) store.addSatellite(sat);
      }
    }
    if (gsRes.ok) {
      const gss = await gsRes.json();
      for (const item of gss) {
        const gs = parseGsEntry(item);
        if (gs) store.addGroundStation(gs);
      }
    }
    if (attRes.ok) {
      const atts = await attRes.json();
      for (const item of atts) store.setAttitude(item.noradId, item);
    }
  } catch { /* server not ready yet */ }
}

// Poll for items added externally while the page is open
export function startApiPoller() {
  async function poll() {
    try {
      const res = await fetch('/api/feed');
      if (res.ok) {
        const { satellites, stations, attitudes = [] } = await res.json();
        for (const notif of attitudes) {
          if (notif.cleared) {
            store.setAttitude(notif.noradId, null);
          } else {
            // Fetch the full table — the feed only carries a lightweight notification
            fetch(`/api/attitude`)
              .then(r => r.ok ? r.json() : [])
              .then(atts => {
                const full = atts.find(a => a.noradId === notif.noradId);
                store.setAttitude(notif.noradId, full ?? null);
              })
              .catch(() => {});
          }
        }
        for (const item of satellites) {
          const sat = parseSatEntry(item);
          if (sat) store.addSatellite(sat);
        }
        for (const item of stations) {
          const gs = parseGsEntry(item);
          if (gs) store.addGroundStation(gs);
        }
      }
    } catch { /* offline — silent */ }
    setTimeout(poll, 2000);
  }
  poll();
}

// Called by InputPanel when the user adds via the UI form
export async function persistSatellite(name, line1, line2, model = '12U') {
  try {
    await fetch('/api/satellites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tle: `${line1}\n${line2}`, model }),
    });
  } catch { /* non-fatal */ }
}

// Returns the server-assigned id for the new station
export async function persistStation(name, shortName, lat, lon, localId) {
  try {
    const res = await fetch('/api/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: localId, name, shortName, lat, lon }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.stations?.[0]?.id ?? localId;
    }
  } catch { /* non-fatal */ }
  return localId;
}

export async function deleteServerSatellite(noradId) {
  try { await fetch(`/api/satellites/${noradId}`, { method: 'DELETE' }); } catch { }
}

export async function deleteServerStation(id) {
  try { await fetch(`/api/stations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { }
}

export async function updateServerStation(id, name, lat, lon) {
  try {
    await fetch(`/api/stations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await fetch('/api/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, shortName: '', lat, lon }),
    });
  } catch { }
}
