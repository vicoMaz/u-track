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
import { queryLoki } from './lokiQuery.js';

let _overlay = null, _bodyEl = null, _titleEl = null, _openLink = null, _errNavEl = null, _errCountEl = null;
let _reqGen = 0; // guards against a slower, superseded fetch overwriting a newer click's result
let _errorLineIndices = []; // indices into the currently-rendered lines that look like errors
let _errorCursor = -1;      // position within _errorLineIndices the ▲/▼ buttons are currently at

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
  _bodyEl     = _overlay.querySelector('.grm-body');
  _titleEl    = _overlay.querySelector('.grm-title');
  _openLink   = _overlay.querySelector('.grm-open');
  _errNavEl   = _overlay.querySelector('.grm-err-nav');
  _errCountEl = _overlay.querySelector('.grm-err-count');
  _overlay.querySelector('.grm-close').addEventListener('click', closeGrafanaModal);
  _overlay.querySelector('.grm-backdrop').addEventListener('click', closeGrafanaModal);
  _overlay.querySelector('.grm-err-jump').addEventListener('click', () => _gotoError(0));
  _overlay.querySelector('.grm-err-prev').addEventListener('click', () => _gotoError(_errorCursor - 1));
  _overlay.querySelector('.grm-err-next').addEventListener('click', () => _gotoError(_errorCursor + 1));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _overlay.classList.contains('grm-open-state')) closeGrafanaModal();
  });
}

// Heuristic — SCC log lines don't carry a structured severity field visible
// to this app, so error lines are found by matching common log-level/failure
// wording. Untested against real production log content; if real error lines
// use different wording than this, they'll silently not be picked up (no
// false "no errors" alarm bell — the log text itself is still there and
// readable, just not highlighted/jumpable).
const ERROR_RE = /\b(error|fail(?:ure|ed)?|exception|critical)\b/i;

function _gotoError(idx) {
  if (!_errorLineIndices.length) return;
  _errorCursor = ((idx % _errorLineIndices.length) + _errorLineIndices.length) % _errorLineIndices.length;
  const lineIdx = _errorLineIndices[_errorCursor];
  const el = _bodyEl.querySelector(`.grm-log-line[data-idx="${lineIdx}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Clear any earlier jump's flash first — the animation is one-shot and
  // doesn't remove its own class on end, so without this every previously
  // visited error line would stay marked .grm-log-flash forever.
  _bodyEl.querySelectorAll('.grm-log-flash').forEach(f => f.classList.remove('grm-log-flash'));
  void el.offsetWidth; // restart the animation if it's already mid-flash from a previous jump to the SAME line
  el.classList.add('grm-log-flash');
  if (_errorLineIndices.length > 1) _errCountEl.textContent = `${_errorCursor + 1}/${_errorLineIndices.length}`;
}

const _escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function _fmtLogTime(nsStr) {
  const ms = Number(nsStr) / 1e6;
  const d  = new Date(ms);
  const p  = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

function _renderLines(lines) {
  _errorLineIndices = [];
  if (!lines.length) return `<div class="co-tt-note">No log lines found in this window</div>`;
  const rows = lines.map((l, i) => {
    const isErr = ERROR_RE.test(l.text);
    if (isErr) _errorLineIndices.push(i);
    return `<div class="grm-log-line${isErr ? ' grm-log-err' : ''}" data-idx="${i}"><span class="grm-log-ts">${_fmtLogTime(l.ts)}</span><span class="grm-log-text">${_escapeHtml(l.text)}</span></div>`;
  }).join('');
  return `<div class="grm-log">${rows}</div>`;
}

export async function openGrafanaModal({ grafanaHost, startMs, endMs, exploreUrl, title }) {
  _ensure();
  const myGen = ++_reqGen;
  _titleEl.textContent = title || 'Grafana logs';
  _openLink.href = exploreUrl;
  _bodyEl.innerHTML = `<div class="co-tt-note grm-loading">Loading logs…</div>`;
  _errNavEl.hidden = true;
  _errorLineIndices = [];
  _errorCursor = -1;
  _overlay.classList.add('grm-open-state');

  const lines = await queryLoki(grafanaHost, '{service_name="/scc"}', startMs, endMs, 2000);
  if (myGen !== _reqGen) return; // superseded by a newer click
  _bodyEl.innerHTML = lines == null
    ? `<div class="co-tt-note">Could not reach Grafana/Loki — use "Open in Grafana ↗" above</div>`
    : _renderLines(lines);

  _overlay.querySelector('.grm-err-prev').hidden = _errorLineIndices.length <= 1;
  _overlay.querySelector('.grm-err-next').hidden = _errorLineIndices.length <= 1;
  _errCountEl.hidden = _errorLineIndices.length <= 1;
  _errNavEl.hidden = _errorLineIndices.length === 0;
}

export function closeGrafanaModal() {
  if (!_overlay) return;
  _overlay.classList.remove('grm-open-state');
  _reqGen++; // invalidate any in-flight fetch for the pass we just closed
}

// Global delegated handler, registered once as a side effect of importing
// this module — any `<a data-grafana-modal data-loki-host=".." href="..">`
// anywhere in the app gets pop-up behavior automatically. Procedure links
// live in 2 independently re-built HTML strings (passTooltip.js,
// PassDetailPanel.js), re-created on every hover/panel-open, so a single
// delegated listener here is much simpler than wiring (and re-wiring) a
// click handler at each call site.
document.addEventListener('click', e => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // real new-tab/window requests pass through untouched
  const link = e.target.closest('[data-grafana-modal]');
  if (!link) return;
  e.preventDefault();
  openGrafanaModal({
    grafanaHost: link.dataset.lokiHost,
    startMs:     Number(link.dataset.lokiStart),
    endMs:       Number(link.dataset.lokiEnd),
    exploreUrl:  link.href,
    title:       link.title || '',
  });
});
