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
    // SCC is the source of truth for the color; localStorage is only a cache so
    // a reload paints the right color immediately (apiPoller.js's initial load
    // reads it back via store.js's nextPlaceholderColor) instead of flashing a
    // placeholder until this poll lands. Every other view — Fleet rows, Settings,
    // the Visualizer sidebar, globe/map entities — reads that same sat.color.
    //
    // Written whenever it DIFFERS, which is the fix for a real bug: this used to
    // be gated on a one-shot `sat-color-confirmed-<norad>` flag, on the stated
    // assumption that "no point re-fetching a color that's already permanent".
    // It isn't permanent — an operator can change it in SCC — and once that flag
    // was set the app cached the old value forever. Confirmed live: SCC reported
    // dfaf4b / ff6b5b / f08ddc for LEONAV-1 / PANDORE / SOAP while browsers that
    // had confirmed an earlier palette were still drawing the stale one, with no
    // way to pick up the change short of clearing localStorage.
    //
    // Costs nothing: this response is already being fetched on its own cadence
    // for bdsVersion/proceduresVersion/sccVersion, so using the color that came
    // with it is free. The confirmed flag is no longer written or read; an
    // existing one in a browser is simply ignored.
    const colorKey = `sat-color-${sat.noradId}`;
    if (sccColor && localStorage.getItem(colorKey) !== sccColor) {
      store.setSatColor(sat.id, sccColor);
      localStorage.setItem(colorKey, sccColor);
    }
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
