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
    // Color is captured from SCC exactly once — normally right at creation
    // (InputPanel.js's finaliseSatellite makes an immediate one-off call
    // here for that), with this periodic poll only as a backstop for a
    // satellite that didn't have a CONFIRMED one yet by the time this ran
    // (e.g. SCC was unreachable, off-VPN, at creation — it's carrying
    // store.js's nextPlaceholderColor placeholder until then). The VALUE
    // itself, not just a done flag, is what's persisted — every other view
    // (Fleet, Settings, the Visualizer sidebar, globe/map entities) reads
    // this same static sat.color, and apiPoller.js's initial load restores
    // it straight from here on a later page reload too, rather than needing
    // to re-fetch. Gated on the *confirmed* flag, not merely on the color
    // key existing — the key alone would already be set to a placeholder,
    // which must still lose to a real SCC value the first time one shows
    // up. Once confirmed, never touched again: no point re-fetching a color
    // that's already permanent.
    const colorKey          = `sat-color-${sat.noradId}`;
    const colorConfirmedKey = `sat-color-confirmed-${sat.noradId}`;
    if (sccColor && !localStorage.getItem(colorConfirmedKey)) {
      store.setSatColor(sat.id, sccColor);
      localStorage.setItem(colorKey, sccColor);
      localStorage.setItem(colorConfirmedKey, '1');
    }
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
