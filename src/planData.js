// Fetches from MIC's "Plan distribution" service — GET /api/plan/v1/planSummaries
// — to fill the gantt's "Plans" row (see TimePlayer.js's _renderGanttPlans /
// index.html's #gantt-slots). Per-satellite, same scoping as TMR/attitude:
// each satellite's own MIC box hosts its own Plan distribution instance on
// port 16020 (see satSubsystems.js's SUBSYSTEMS.planApi — same subnet as
// `mic`, MIC just hosts multiple services on different ports), and is
// authenticated with that satellite's own MIC token (satJwt) — confirmed
// live that the same token already used for real attitude also works here,
// so there's no separate credential to configure.

import { satSubsystemOrigin } from './satSubsystems.js';
import { satJwt }             from './satPing.js';
import { stripBearerPrefix }  from './satAttitudeReal.js';

function _buildUrl(origin, startMs, endMs) {
  return `${origin}/api/plan/v1/planSummaries`
    + `?timeWindowStart=${encodeURIComponent(new Date(startMs).toISOString())}`
    + `&timeWindowEnd=${encodeURIComponent(new Date(endMs).toISOString())}`;
}

// Raw PlanSummaryStatus (plan.key/version, information.{recipient,
// originator, description, comments, planPeriodStart, planPeriodEnd},
// status, statusInfo) → the flat shape the gantt row/tooltip actually use.
function _normalize(raw) {
  return {
    key:         raw?.plan?.key ?? null,
    version:     raw?.plan?.version ?? null,
    recipient:   raw?.information?.recipient  ?? null,
    originator:  raw?.information?.originator ?? null,
    description: raw?.information?.description ?? '',
    comments:    raw?.information?.comments    ?? '',
    start:       new Date(raw?.information?.planPeriodStart).getTime(),
    end:         new Date(raw?.information?.planPeriodEnd).getTime(),
    status:      raw?.status ?? null,
    statusInfo:  raw?.statusInfo ?? null,
  };
}

const _ctrl     = new Map(); // noradId → AbortController
const _debounce = new Map(); // noradId → timer handle

// Debounced + abort-in-flight-superseded, so rapid callers (Now/Home clicked
// repeatedly, the periodic refresh landing mid-request, a satellite switch)
// never race each other. Always called with the gantt's own fixed max window
// (EPOCH ± VIEW_HALF_SEC), never the current pan/zoom view — the API is
// cheap enough that one request for the whole horizon is simpler and no more
// expensive than narrowing it.
export function schedulePlanFetch(sat, startMs, endMs, onDone) {
  const key = sat.noradId;
  clearTimeout(_debounce.get(key));
  _debounce.set(key, setTimeout(() => {
    _fetchPlans(sat, startMs, endMs).then(result => { if (result) onDone(result); });
  }, 200));
}

async function _fetchPlans(sat, startMs, endMs) {
  const origin = satSubsystemOrigin(sat.noradId, 'planApi');
  const token  = stripBearerPrefix(satJwt(sat.noradId));
  if (!origin || !token) return null; // not configured yet — leave whatever's already rendered alone

  const key = sat.noradId;
  _ctrl.get(key)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(key, ctrl);

  try {
    const res = await fetch(_buildUrl(origin, startMs, endMs), {
      headers: { accept: 'application/json', Authorization: token },
      signal:  ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(_normalize).filter(p => Number.isFinite(p.start) && Number.isFinite(p.end));
  } catch (e) {
    // Aborted (superseded by a newer call) or a real network failure — either
    // way, don't clobber whatever's currently shown with an empty result.
    return null;
  }
}
