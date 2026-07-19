// Lightweight hover preview for a pass — station, timing, and a one-line
// status. Used to show a polar ground-track plot, an Eb/N0 chart, the full
// procedure history, and an async procedure-execution report all at once,
// which made a routine hover heavy and slow to read. That full detail now
// lives in PassDetailPanel.js's slide-in panel, opened on click — this stays
// a fast, synchronous, glanceable preview.
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

// One-line status: scheduled, or a same-color-language summary of what
// happened, without listing every procedure — that's the click-through detail.
function _statusLine(pass) {
  if (pass.future) return `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>`;
  const procs = pass.procedures;
  if (!procs?.length) return `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>`;
  const failed = procs.filter(p => p.status === 'FAILURE').length;
  const cancelled = procs.filter(p => p.status === 'CANCELLED').length;
  const cls = failed ? _PROC_CLS.FAILURE : cancelled ? _PROC_CLS.CANCELLED : _PROC_CLS.SUCCESS;
  const detail = failed ? ` · ${failed} failed` : cancelled ? ` · ${cancelled} cancelled` : '';
  return `<div class="co-tt-proc ${cls}">● ${procs.length} procedure${procs.length === 1 ? '' : 's'}${detail}</div>`;
}

export function passSimpleTooltipContent(pass, sat) {
  const netTag = pass.network ? `<span class="co-tt-network">${pass.network}</span>` : '';
  const hdr = `<div class="co-tt-header">${pass.station ?? '—'}${netTag}</div>`;
  const details = `<div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
    <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>`;
  return hdr + details + _statusLine(pass) + `<div class="co-tt-more-hint">Click for details ›</div>`;
}

export function positionTooltip(e, el) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const w = el.offsetWidth  || 200;
  const h = el.offsetHeight || 90;
  if (x + w > window.innerWidth  - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  x = Math.max(8, Math.min(x, window.innerWidth  - w - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

// Self-contained tooltip: creates its own DOM element, manages show/hide timing
// (stays open while hovered, 800ms grace on leave, dismiss on outside click).
// `element` is exposed so a caller with an unrelated but similarly-shaped
// hover (e.g. TimePlayer.js's TMR gap tooltip) can share the same instance
// instead of standing up its own show/hide/position machinery.
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

  function showForPass(e, pass, sat) {
    cancelHide();
    el.innerHTML = passSimpleTooltipContent(pass, sat);
    el.style.display = 'block';
    positionTooltip(e, el);
  }

  return { element: el, showForPass, cancelHide, scheduleHide };
}
