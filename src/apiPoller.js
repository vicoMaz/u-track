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
    // The color SCC reported the ONE time it was ever fetched for this
    // satellite (satGlobals.js — captured at creation, persisted from then
    // on) — this is what makes it survive a reload without re-fetching.
    // Only a satellite SCC has never reported one for at all falls back to
    // the plain PALETTE-cycle default.
    const color      = localStorage.getItem(`sat-color-${noradId}`) || PALETTE[store.satellites.length % PALETTE.length];
    const model      = item.model === 'FF' ? 'FF' : '12U';
    const satelliteId = item.satelliteId || null;
    return { id, noradId, name, color, satrec, model, satelliteId };
  } catch { return null; }
}

// The satellite settings list's drag-to-reorder (InputPanel.js) persists
// here — noradIds in the user's own chosen order. Applied by sorting the
// server's own /api/satellites response BEFORE adding anything to the
// store, so every view just inherits store.satellites' insertion order
// (see store.js's moveSatellite) rather than needing its own sort step.
// A satellite not in this list yet (newly added since the last reorder)
// falls to the end, in whatever order the server returned it.
const SAT_ORDER_KEY = 'sat-order';

export function saveSatOrder() {
  localStorage.setItem(SAT_ORDER_KEY, JSON.stringify(store.satellites.map(s => s.noradId)));
}

function _applyStoredOrder(items) {
  const raw = localStorage.getItem(SAT_ORDER_KEY);
  if (!raw) return items;
  let order;
  try { order = JSON.parse(raw); } catch { return items; }
  const rank = new Map(order.map((noradId, i) => [noradId, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (rank.get(a.item.noradId) ?? (order.length + a.i)) - (rank.get(b.item.noradId) ?? (order.length + b.i)))
    .map(({ item }) => item);
}

// Load the full persistent state on page startup
export async function loadInitialState() {
  try {
    const [satRes, attRes] = await Promise.all([
      fetch('/api/satellites'),
      fetch('/api/attitude'),
    ]);
    if (satRes.ok) {
      const sats = _applyStoredOrder(await satRes.json());
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
