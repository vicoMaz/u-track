// Shared rich pass-tooltip content: header, eclipse bar, clickable Grafana-linked
// procedures, and an async-injected polar trajectory plot. Originally lived only in
// ChadOps.js; extracted so other views (e.g. WeeklySchedule.js) can show the same
// tooltip instead of re-deriving a thinner copy.
import { propagate }                    from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';
import { fetchPassGsCoords, buildPolarSVG } from './passPolar.js';
import { satSubsystemHost } from '../satSubsystems.js';

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };

export function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function fmtDateTimeShort(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function grafanaLokiUrl(grafanaHost, fromMs, toMs) {
  return `http://${grafanaHost}:3000/a/grafana-lokiexplore-app/explore/service/-scc/logs`
    + `?patterns=%5B%5D&from=${fromMs}&to=${toMs}`
    + `&var-lineFormat=&var-ds=P8E80F9AEF21F6940`
    + `&var-filters=service_name%7C%3D%7C%2Fscc`
    + `&var-fields=&var-levels=&var-metadata=&var-jsonFields=`
    + `&var-patterns=&var-lineFilterV2=&var-lineFilters=`
    + `&timezone=browser&var-all-fields=&userDisplayedFields=false`
    + `&displayedFields=%5B%5D&urlColumns=%5B%5D`
    + `&visualizationType=%22logs%22&prettifyLogMessage=false`
    + `&sortOrder=%22Descending%22&wrapLogMessage=false`;
}

export function passEclipseBar(satrec, start, end) {
  if (!satrec || !start || !end) return '';
  const STEP = 30_000; // 30s samples
  let shadow = 0, sun = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += STEP) {
    const d = new Date(t);
    const r = propagate(satrec, d);
    if (!r?.eciPos) continue;
    if (isInEclipse(r.eciPos, sunDirectionECI(d))) shadow++; else sun++;
  }
  const total = shadow + sun;
  if (!total) return '';
  const eclPct = Math.round((shadow / total) * 100);
  const sunPct = 100 - eclPct;
  const fmtMin = m => `${m}m`;
  const durMin = Math.round((end - start) / 60_000);
  const eclMin = Math.round(shadow / total * durMin);
  const sunMin = durMin - eclMin;
  return `
    <div class="co-tt-ecl-bar">
      <div class="oi-eclipse-bar">
        <div class="oi-eclipse-seg oi-seg-shadow" style="width:${eclPct}%">${eclPct > 15 ? fmtMin(eclMin) : ''}</div>
        <div class="oi-eclipse-seg oi-seg-sun"    style="width:${sunPct}%">${sunPct > 15 ? fmtMin(sunMin) : ''}</div>
      </div>
      <div class="oi-eclipse-legend">
        <span class="oi-ecl-shadow">● ${eclPct}% shadow</span>
        <span class="oi-ecl-sun">☀ ${sunPct}% sun</span>
      </div>
    </div>`;
}

export function passTooltipContent(pass, grafanaHost, sat) {
  const dur = pass.end && pass.start ? ` · ${fmtDuration(pass.end - pass.start)}` : '';
  const hdr = `<div class="co-tt-header">${pass.station} · ${fmtDateTimeShort(pass.start)}${dur}</div>`;
  const eclBar = passEclipseBar(sat?.satrec, pass.start, pass.end);
  const slot = '<div class="polar-slot"></div>';
  if (pass.future) {
    return hdr + eclBar + `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>` + slot;
  }
  if (!pass.procedures?.length) {
    return hdr + eclBar + `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>` + slot;
  }
  const procs = pass.procedures.map((pr, i) => {
    const cls     = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const num     = `<span class="co-tt-num">${i + 1}</span>`;
    const name    = `<span class="co-tt-pname">${pr.name}</span>`;
    const procDur = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${fmtDuration(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost) {
      const url = grafanaLokiUrl(grafanaHost, pr.startMs - 1000, pr.endMs + 1000);
      return `<a href="${url}" target="_blank" rel="noopener" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${procDur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}${procDur}</div>`;
  }).join('');
  return hdr + eclBar + `<div class="co-tt-sep"></div><div class="co-tt-procs">${procs}</div>` + slot;
}

export function positionTooltip(e, el) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const w = el.offsetWidth  || 230;
  const h = el.offsetHeight || 120;
  if (x + w > window.innerWidth  - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

// Self-contained tooltip: creates its own DOM element, manages show/hide timing
// (stays open while hovered, 800ms grace on leave, dismiss on outside click), and
// injects the async polar plot once ground-station coordinates resolve.
export function createPassTooltip() {
  const el = document.createElement('div');
  el.className = 'co-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);

  let hideTimer = null;
  const cancelHide   = () => clearTimeout(hideTimer);
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { el.style.display = 'none'; }, 800); };
  el.addEventListener('mouseenter', cancelHide);
  el.addEventListener('mouseleave', scheduleHide);
  document.addEventListener('click', e => {
    if (el.style.display !== 'none' && !el.contains(e.target)) el.style.display = 'none';
  });

  async function showForPass(e, pass, sat, groundStations) {
    cancelHide();
    const grafanaHost = sat ? (satSubsystemHost(sat.noradId, 'fds') || null) : null;
    el.innerHTML = passTooltipContent(pass, grafanaHost, sat);
    el.style.display = 'block';
    positionTooltip(e, el);
    if (sat?.satrec) {
      const coords = await fetchPassGsCoords(sat, pass, groundStations);
      if (coords && el.style.display !== 'none') {
        const slot = el.querySelector('.polar-slot');
        if (slot) slot.outerHTML = buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask);
      }
    }
  }

  return { element: el, showForPass, cancelHide, scheduleHide };
}
