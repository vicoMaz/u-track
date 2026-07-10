import * as satjs from 'satellite.js';
import { store, PALETTE } from './store.js';
import { setSatBaseUrl } from './satPing.js';

let satIdCounter = 9000;

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
    const name       = item.name || tleName || `SAT-${noradId}`;
    const id         = `sat-api-${++satIdCounter}`;
    const color      = localStorage.getItem(`sat-color-${noradId}`) || PALETTE[store.satellites.length % PALETTE.length];
    const model      = item.model === 'FF' ? 'FF' : '12U';
    const satelliteId = item.satelliteId || null;
    return { id, noradId, name, color, satrec, model, satelliteId };
  } catch { return null; }
}

// Load the full persistent state on page startup
export async function loadInitialState() {
  try {
    const [satRes, attRes] = await Promise.all([
      fetch('/api/satellites'),
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
        const { satellites, attitudes = [] } = await res.json();
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
          if (item.tleUpdate) {
            try {
              const lines = item.tle.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              const line1 = lines.find(l => l.startsWith('1 ') && l.length >= 60);
              const line2 = lines.find(l => l.startsWith('2 ') && l.length >= 60);
              if (line1 && line2) {
                const satrec = satjs.twoline2satrec(line1, line2);
                if (satrec.error === 0) store.updateSatTle(item.noradId, satrec);
              }
            } catch { /* ignore bad TLE */ }
          } else {
            const sat = parseSatEntry(item);
            if (sat) store.addSatellite(sat);
          }
        }
      }
    } catch { /* offline — silent */ }
    setTimeout(poll, 2000);
  }
  poll();
}

// Called by InputPanel when the user adds via the UI form
export async function persistSatellite(name, line1, line2, model = '12U', satelliteId = null) {
  try {
    await fetch('/api/satellites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tle: `${line1}\n${line2}`, model, satelliteId }),
    });
  } catch { /* non-fatal */ }
}

export async function deleteServerSatellite(noradId) {
  try { await fetch(`/api/satellites/${noradId}`, { method: 'DELETE' }); } catch { }
}
