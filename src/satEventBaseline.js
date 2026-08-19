import { store }                from './store.js';
import { satSubsystemOrigin }  from './satSubsystems.js';
import { getAlertWindowDays }  from './alertWindow.js';

const PACKET = 'TM_3_25_OBSW_HK_PLT';
const PARAMS = {
  normal: 'OBSW_AM_NB_NORMAL_EVT',
  low:    'OBSW_AM_NB_LOW_SEV_EVT',
  med:    'OBSW_AM_NB_MED_SEV_EVT',
  high:   'OBSW_AM_NB_HIGH_SEV_EVT',
};

async function _queryAt(origin, param, endMs, signal) {
  const start = new Date(endMs - 3_600_000).toISOString(); // 1h search window ending at the reference instant (endMs) — wide enough to find the closest prior packet regardless of how far back endMs itself is
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

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatEventBaseline(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return;

  _ctrl.get(sat.id)?.abort();
  const ctrl    = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer   = setTimeout(() => ctrl.abort(), 15_000);
  const endMs   = Date.now() - getAlertWindowDays() * 24 * 3_600_000; // operator-chosen window ago (ChadOps.js's Alerts-column toggle)
  try {
    const [normal, low, med, high] = await Promise.all(
      Object.values(PARAMS).map(p => _queryAt(origin, p, endMs, ctrl.signal))
    );
    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
    store.setSatEventBaseline(sat.id, { normal, low, med, high });
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
