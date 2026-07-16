import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

// Ground-side monitoring alarms — the SCC's own /api/v1/events endpoint returns
// ON_BOARD (spacecraft-raised), GROUND (SCC parameter-threshold alarms), and
// SATELLITE_PASS events all together; this counts just the GROUND ones by
// criticality over the last 24h, same window/shape as the board-event counters.
const LOOKBACK_MS = 24 * 3_600_000;
const MAX_EVENTS  = 200;

export async function fetchSatGroundEvents(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return;

  const now   = new Date();
  const start = new Date(now.getTime() - LOOKBACK_MS);
  const url = `${origin}/api/v1/events`
    + `?start=${encodeURIComponent(start.toISOString())}`
    + `&end=${encodeURIComponent(now.toISOString())}`
    + `&maxLimit=${MAX_EVENTS}`
    + `&onBoardEventsTime=onBoardTime`
    + `&groundEventsTime=receptionTime`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return;
    const events = await res.json();
    const counts = { watch: 0, warning: 0, distress: 0, critical: 0 };
    for (const e of events) {
      if (e.category !== 'GROUND') continue;
      const key = e.criticality?.toLowerCase();
      if (key in counts) counts[key]++;
    }
    store.setSatGroundEvents(sat.id, counts);
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
