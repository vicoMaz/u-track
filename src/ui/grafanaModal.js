// Clicking a per-procedure Grafana log link used to leave the app entirely
// (new tab). This opens an in-app modal instead, showing the raw Loki log
// lines for that procedure's execution window directly — NOT Grafana's own
// page in an <iframe>, which was tried first and doesn't work: Grafana sends
// `X-Frame-Options: deny`, so the browser refuses to render it framed
// (confirmed live). Instead this queries Loki through the same same-origin
// proxy procedureReport.js already uses (queryLoki, in lokiQuery.js) — a
// plain JSON API call, which isn't subject to X-Frame-Options at all since
// nothing is being framed. "Open in Grafana ↗" stays in the header for
// anyone who wants the full Explore UI (filtering, live tail, etc).
//
// Rendering/error-detection/navigation (renderLogRows, createErrorNav) live
// in logView.js, shared with PassAnalyzer.js's permanent full-pass-log panel
// — this module only owns the modal shell (overlay/open-close/fetch).
import { queryLoki } from './lokiQuery.js';
import { renderLogRows, createErrorNav } from './logView.js';

let _overlay = null, _bodyEl = null, _titleEl = null, _openLink = null, _errNav = null;
let _reqGen = 0; // guards against a slower, superseded fetch overwriting a newer click's result

function _ensure() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'grm-overlay';
  _overlay.innerHTML = `
    <div class="grm-backdrop"></div>
    <div class="grm-card">
      <div class="grm-header">
        <span class="grm-title"></span>
        <div class="grm-err-nav" hidden>
          <button type="button" class="grm-err-jump">Go to error</button>
          <button type="button" class="grm-err-prev" title="Previous error">▲</button>
          <span class="grm-err-count"></span>
          <button type="button" class="grm-err-next" title="Next error">▼</button>
        </div>
        <a class="grm-open" target="_blank" rel="noopener">Open in Grafana ↗</a>
        <button type="button" class="grm-close" title="Close">×</button>
      </div>
      <div class="grm-body"></div>
    </div>`;
  document.body.appendChild(_overlay);
  _bodyEl   = _overlay.querySelector('.grm-body');
  _titleEl  = _overlay.querySelector('.grm-title');
  _openLink = _overlay.querySelector('.grm-open');
  _errNav   = createErrorNav(_overlay.querySelector('.grm-err-nav'), _bodyEl);
  _overlay.querySelector('.grm-close').addEventListener('click', closeGrafanaModal);
  _overlay.querySelector('.grm-backdrop').addEventListener('click', closeGrafanaModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _overlay.classList.contains('grm-open-state')) closeGrafanaModal();
  });
}

export async function openGrafanaModal({ grafanaHost, startMs, endMs, nominalStart, nominalEnd, exploreUrl, title }) {
  _ensure();
  const myGen = ++_reqGen;
  _titleEl.textContent = title || 'Grafana logs';
  _openLink.href = exploreUrl;
  _bodyEl.innerHTML = `<div class="co-tt-note grm-loading">Loading logs…</div>`;
  _errNav.setErrorIndices([]);
  _overlay.classList.add('grm-open-state');

  const lines = await queryLoki(grafanaHost, '{service_name="/scc"}', startMs, endMs, 2000);
  if (myGen !== _reqGen) return; // superseded by a newer click

  if (lines == null) {
    _bodyEl.innerHTML = `<div class="co-tt-note">Could not reach Grafana/Loki — use "Open in Grafana ↗" above</div>`;
    return;
  }
  const { html, errorIndices, noneInWindow } = renderLogRows(lines, nominalStart, nominalEnd);
  _bodyEl.innerHTML = (!lines.length || noneInWindow)
    ? `<div class="co-tt-note">No log lines found for this procedure</div>`
    : html;
  _errNav.setErrorIndices(errorIndices);

  const coreLine = _bodyEl.querySelector('.grm-log-line:not(.grm-log-context)');
  if (coreLine) coreLine.scrollIntoView({ block: 'center' });
}

export function closeGrafanaModal() {
  if (!_overlay) return;
  _overlay.classList.remove('grm-open-state');
  _reqGen++; // invalidate any in-flight fetch for the pass we just closed
}

// Global delegated handler, registered once as a side effect of importing
// this module — any `<a data-grafana-modal data-loki-host=".." href="..">`
// anywhere in the app gets pop-up behavior automatically. Procedure links
// live in independently re-built HTML strings (passTooltip.js,
// PassAnalyzer.js), re-created on every hover/panel-open, so a single
// delegated listener here is much simpler than wiring (and re-wiring) a
// click handler at each call site.
document.addEventListener('click', e => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // real new-tab/window requests pass through untouched
  const link = e.target.closest('[data-grafana-modal]');
  if (!link) return;
  e.preventDefault();
  openGrafanaModal({
    grafanaHost:  link.dataset.lokiHost,
    startMs:      Number(link.dataset.lokiStart),
    endMs:        Number(link.dataset.lokiEnd),
    nominalStart: Number(link.dataset.lokiNominalStart),
    nominalEnd:   Number(link.dataset.lokiNominalEnd),
    exploreUrl:   link.href,
    title:        link.dataset.grafanaTitle || link.title || '',
  });
});
