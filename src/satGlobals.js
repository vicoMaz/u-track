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
    const sccColor = data.sccColor ? `#${data.sccColor.replace(/^#/, '')}` : null;
    store.setSatGlobals(sat.id, {
      bdsVersion:        data.bdsVersion ?? null,
      proceduresVersion: data.proceduresVersion ?? null,
      sccVersion:         data.sccVersion ?? null,
      sccColor,
    });
    // Satellites default to whatever color SCC itself reports, rather than
    // requiring the manual "Use SCC Color" button (InputPanel.js) — but only
    // when there's no localStorage entry yet, since that's how a manual pick
    // (a swatch, or that same button) is recorded. Once one exists, it's a
    // deliberate choice and this leaves it alone from then on. Also runs on
    // every satellite already added, not just newly-added ones, since this
    // fetch is on the same periodic cadence as the rest of satGlobals.
    if (sccColor && !localStorage.getItem(`sat-color-${sat.noradId}`)) {
      store.setSatColor(sat.id, sccColor);
      localStorage.setItem(`sat-color-${sat.noradId}`, sccColor);
    }
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
