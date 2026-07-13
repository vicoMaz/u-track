import { store }                from './store.js';
import { satSubsystemOrigin }  from './satSubsystems.js';

const PACKET = 'TM_3_25_OBSW_HK_PLT';
const PARAMS = {
  normal: 'OBSW_AM_NB_NORMAL_EVT',
  low:    'OBSW_AM_NB_LOW_SEV_EVT',
  med:    'OBSW_AM_NB_MED_SEV_EVT',
  high:   'OBSW_AM_NB_HIGH_SEV_EVT',
};

async function _queryAt(origin, param, endMs, signal) {
  const start = new Date(endMs - 3_600_000).toISOString(); // 1h window ending at 24h ago
  const end   = new Date(endMs).toISOString();
  const url = `${origin}/api/v1/parameters`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&filter=${encodeURIComponent(PACKET)}`
    + `&requestedParameters=${encodeURIComponent(param)}`
    + `&orderBy=onBoardTime`
    + `&maxLimit=1`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data[0]) ? data[0]
               : Array.isArray(data.parameters) ? data.parameters
               : Array.isArray(data) ? data : [];
    const row = rows[0];
    if (!row) return null;
    const pv  = row.parameter?.physicalValue ?? row.parameter?.engValue;
    const val = pv?.value ?? row.parameter?.value ?? row.value;
    return val != null ? Number(val) : null;
  } catch { return null; }
}

export async function fetchSatEventBaseline(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return;

  const ctrl    = new AbortController();
  const timer   = setTimeout(() => ctrl.abort(), 15_000);
  const endMs   = Date.now() - 24 * 3_600_000; // 24 h ago
  try {
    const [normal, low, med, high] = await Promise.all(
      Object.values(PARAMS).map(p => _queryAt(origin, p, endMs, ctrl.signal))
    );
    store.setSatEventBaseline(sat.id, { normal, low, med, high });
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
