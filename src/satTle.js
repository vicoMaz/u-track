import { store }      from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';
import { parseTLE }   from './tle.js';

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — see satTelemetry.js's _ctrl for the same rationale.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatTle(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'gnm');
  if (!origin) return;
  const id = sat.satelliteId || sat.name;
  if (!id) return;
  const url  = `${origin}/api/v1/data/orbit/best-tle?satellite_id=${encodeURIComponent(id)}`;

  _ctrl.get(sat.id)?.abort();
  const ctrl  = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.first_line || !data.second_line) return;
    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result
    const { satrec } = parseTLE(`${data.first_line}\n${data.second_line}`);
    store.updateSatTle(sat.noradId, satrec);
  } catch { /* non-fatal */ }
  finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
