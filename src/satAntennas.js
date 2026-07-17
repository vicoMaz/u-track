import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

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

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatAntennas(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'gnm');
  if (!origin) return;
  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/api/v1/data/antennas`, { signal: ctrl.signal });
    if (!res.ok) return;
    const data = await res.json();
    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
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
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
