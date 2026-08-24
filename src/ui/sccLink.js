// The one "leave the app, open this satellite in SCC" link, shared by every
// view that shows a satellite's name in the satellite's own accent colour —
// the Fleet table's row name (ChadOps.js), the Visualizer gantt's
// tracked-satellite strip (SatInfo.js) and the Pass Analyzer's pass header
// (PassAnalyzer.js) — plus the Scheduler's "Scheduled procedures" panel title
// (Scheduler.js's _updateSccLink), which points at the same place from a
// title rather than from a name.
//
// Kept in one module because the read-only-VPN fallback below is a fact about
// the deployment, not about any one panel: it had already been written out
// twice (ChadOps.js and Scheduler.js) and every further view that wanted the
// link was about to add another copy.
//
// Not in satSubsystems.js, where the rest of the URL building lives: that
// module is deliberately import-free (see its own header) so satPing.js and
// the fetch modules satPing.js itself imports can all share it without a
// cycle, and this needs store.readOnlyVpn.
import { store } from '../store.js';
import { satSubsystemOrigin } from '../satSubsystems.js';
import { escapeHtml } from './logView.js';

// SCC's own synoptic (.1, full read/write) normally; SCC RO's (.5, the
// read-only mirror — same subsystem/port SUBSYSTEMS.sccRo already resolves)
// whenever store.readOnlyVpn says this client's VPN can't reach
// SCC/FDS/GNM/MIC at all, so the link still resolves to something reachable
// rather than pointing at a subnet this client can't get to either way.
// null — never a dead href — when neither subsystem's IP is configured for
// this satellite.
export function satSynopticUrl(noradId) {
  const origin = satSubsystemOrigin(noradId, store.readOnlyVpn ? 'sccRo' : 'scc');
  return origin ? `${origin}/synoptic` : null;
}

// A satellite name rendered as that link, with the ↗ "this leaves the app"
// glyph inline after it — for the views that paint the name in the
// satellite's own colour.
//
// The colour itself stays the caller's business (an inline style, or a CSS
// var on an ancestor): .sat-scc-link inherits it and .sat-scc-ext tints the
// arrow with the same colour at reduced opacity, so the pair still reads as
// one coloured satellite name rather than a name plus a foreign blue link.
// The name gets its own element so it can ellipsise inside a narrow strip
// without taking the arrow with it (see #gsi-name in style.css).
//
// Falls back to the bare name — no anchor at all — when there is nowhere to
// go, same as the Fleet row's own name cell: a link that goes nowhere is
// worse than no link.
export function satNameSccLinkHTML(sat) {
  const name = escapeHtml(sat.name);
  const url  = satSynopticUrl(sat.noradId);
  if (!url) return `<span class="sat-scc-name">${name}</span>`;
  return `<a class="sat-scc-link" href="${url}" target="_blank" rel="noopener" title="Open ${name}'s SCC synoptic view"><span class="sat-scc-name">${name}</span><span class="sat-scc-ext">↗</span></a>`;
}
