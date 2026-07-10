import { store } from './store.js';
import { satBaseUrl } from './satPing.js';

// ── Toggle persistence (localStorage, keyed by noradId so it survives reload) ──

export function isNetworkVisible(noradId, network) {
  const raw = localStorage.getItem(`ant-toggle-${noradId}-${network}`);
  return raw === null ? true : raw === '1'; // default ON
}

export function setNetworkVisible(sat, network, visible) {
  localStorage.setItem(`ant-toggle-${sat.noradId}-${network}`, visible ? '1' : '0');
  store.setAntennaToggle(sat.id, network, visible);
}

// ── Fetch ─────────────────────────────────────────────────────────────────

export async function fetchSatAntennas(sat) {
  const ip = satBaseUrl(sat.noradId);
  if (!ip) return;
  const host = ip.replace(/\.\d+$/, '.3');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`http://${host}:15602/api/v1/data/antennas`, { signal: ctrl.signal });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    store.setSatAntennas(sat.id, list);

    // Seed toggle default (persisted preference) for any network not yet set this session
    for (const network of new Set(list.map(a => a.network))) {
      const key = `${sat.id}:${network}`;
      if (store.antennaToggles[key] === undefined) {
        store.setAntennaToggle(sat.id, network, isNetworkVisible(sat.noradId, network));
      }
    }
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
