import { store } from './store.js';
import { satBaseIp } from './satSubsystems.js';

// Per-subsystem versions from the ground-segment dashboard's own backend
// (baseIp:5000/*Info) — distinct from satGlobals.js's satellite-specific
// /api/v1/globals (BDS/procedures/SCC). Scraped from the dashboard's Angular
// bundle: subsystemInfoService.getInfos() hits http://{baseIp}:5000/{path}.
const ENDPOINTS = [
  ['fds',   'fdsInfo'],
  ['scc',   'sccInfo'],
  ['sccRo', 'sccRoInfo'],
  ['gnm',   'gnmInfo'],
  ['mic',   'micInfo'],
];

export async function fetchSatVersions(sat) {
  const baseIp = satBaseIp(sat.noradId);
  if (!baseIp) return;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const results = await Promise.all(ENDPOINTS.map(async ([key, path]) => {
      try {
        const res = await fetch(`http://${baseIp}:5000/${path}`, { signal: ctrl.signal });
        if (!res.ok) return [key, null];
        const data = await res.json();
        return [key, { version: data.version ?? null, appUrl: data.appUrl ?? null }];
      } catch { return [key, null]; }
    }));
    store.setSatVersions(sat.id, Object.fromEntries(results));
  } finally {
    clearTimeout(timer);
  }
}
