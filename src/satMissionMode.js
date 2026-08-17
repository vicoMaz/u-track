import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

// Current Mission Mode status — same SCC endpoint family as satActionsMenu.js's
// enable/disable actions (POST /api/v1/events/mission/{enable,disable}), just
// the GET that reports which of those two states is active right now:
// { "enabled": bool }.

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatMissionMode(sat) {
  // 'scc', not 'sccRo' — unlike /api/v1/events (confirmed mirrored to SCC
  // RO, see satGroundEvents.js), this endpoint was only ever verified
  // against SCC itself (subnet .1, port 15000), same subsystem as
  // satActionsMenu.js's enable/disable actions. Querying sccRo (subnet .5,
  // port 15500 — a different box) silently 404s/fails there, which is why
  // this cell was stuck on "—" until switched to match.
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) return;

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${origin}/api/v1/events/mission`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal:  ctrl.signal,
    });
    if (!res.ok) return;
    const data = await res.json();
    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
    store.setSatMissionMode(sat.id, data);
  } catch { /* offline or aborted */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
