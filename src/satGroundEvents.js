import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

// Ground-side monitoring alarms — the SCC's own /api/v1/events endpoint returns
// ON_BOARD (spacecraft-raised), GROUND (SCC parameter-threshold alarms), and
// SATELLITE_PASS events all together; this counts just the GROUND ones by
// criticality over the last 24h, same window/shape as the board-event counters.
const LOOKBACK_MS = 24 * 3_600_000;
const MAX_EVENTS  = 200;

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatGroundEvents(sat) {
  // sccRo, not scc — this is a pure read with no follow-up write (unlike
  // e.g. procedureCatalog.js's matchSccPassId, which deliberately stays on
  // scc so its event id matches what a subsequent schedule/unschedule/
  // reorder writes to). satPasses.js already reads this exact same
  // /api/v1/events endpoint via sccRo, so it's confirmed to work there —
  // using scc here bought nothing but an unnecessary dependency on the
  // write-capable subnet, which breaks this under a read-only VPN for no
  // reason.
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return;

  const now   = new Date();
  const start = new Date(now.getTime() - LOOKBACK_MS);
  const url = `${origin}/api/v1/events`
    + `?start=${encodeURIComponent(start.toISOString())}`
    + `&end=${encodeURIComponent(now.toISOString())}`
    + `&maxLimit=${MAX_EVENTS}`
    + `&onBoardEventsTime=onBoardTime`
    + `&groundEventsTime=receptionTime`;

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return;
    const events = await res.json();
    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
    const counts = { watch: 0, warning: 0, distress: 0, critical: 0 };
    for (const e of events) {
      if (e.category !== 'GROUND') continue;
      const key = e.criticality?.toLowerCase();
      if (key in counts) counts[key]++;
    }
    store.setSatGroundEvents(sat.id, counts);
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
