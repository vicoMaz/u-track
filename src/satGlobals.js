import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

// Software versions running on the flight/ground segment for this satellite —
// BDS (database), procedures, and SCC itself. GET /api/v1/globals lives on SCC RO.
export async function fetchSatGlobals(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/api/v1/globals`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    store.setSatGlobals(sat.id, {
      bdsVersion:        data.bdsVersion ?? null,
      proceduresVersion: data.proceduresVersion ?? null,
      sccVersion:         data.sccVersion ?? null,
      sccColor:           data.sccColor ? `#${data.sccColor.replace(/^#/, '')}` : null,
    });
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
