// Clicking a per-procedure Grafana log link used to leave the app entirely
// (new tab) — this opens the same Grafana Loki Explore URL in an in-app
// modal instead, so checking a procedure's logs doesn't lose your place in
// whatever tooltip/panel you were looking at. Ctrl/Cmd/Shift-click (or any
// non-primary-button click) still opens a real new tab — we only intercept
// a plain left click.
//
// Caveat: this embeds Grafana in an <iframe>, which only renders if Grafana's
// own server config allows it (grafana.ini's [security] allow_embedding =
// true, or an equivalent X-Frame-Options/CSP allowance) — untested against
// live infra. If it's blocked, the iframe will just come up blank; the "Open
// in new tab ↗" link in the header is the fallback for that case.
let _overlay = null, _iframe = null, _titleEl = null, _openLink = null;

function _ensure() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'grm-overlay';
  _overlay.innerHTML = `
    <div class="grm-backdrop"></div>
    <div class="grm-card">
      <div class="grm-header">
        <span class="grm-title"></span>
        <a class="grm-open" target="_blank" rel="noopener">Open in new tab ↗</a>
        <button type="button" class="grm-close" title="Close">×</button>
      </div>
      <iframe class="grm-iframe"></iframe>
    </div>`;
  document.body.appendChild(_overlay);
  _iframe   = _overlay.querySelector('.grm-iframe');
  _titleEl  = _overlay.querySelector('.grm-title');
  _openLink = _overlay.querySelector('.grm-open');
  _overlay.querySelector('.grm-close').addEventListener('click', closeGrafanaModal);
  _overlay.querySelector('.grm-backdrop').addEventListener('click', closeGrafanaModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _overlay.classList.contains('grm-open-state')) closeGrafanaModal();
  });
}

export function openGrafanaModal(url, title) {
  _ensure();
  _titleEl.textContent = title || 'Grafana logs';
  _openLink.href = url;
  _iframe.src = url;
  _overlay.classList.add('grm-open-state');
}

export function closeGrafanaModal() {
  if (!_overlay) return;
  _overlay.classList.remove('grm-open-state');
  _iframe.src = 'about:blank'; // stop the embedded page's background activity once hidden
}

// Global delegated handler, registered once as a side effect of importing
// this module — any `<a data-grafana-modal href="...">` anywhere in the app
// gets pop-up behavior automatically. Procedure links live in 2 independently
// re-built HTML strings (passTooltip.js, PassDetailPanel.js), re-created on
// every hover/panel-open, so a single delegated listener here is much
// simpler than wiring (and re-wiring) a click handler at each call site.
document.addEventListener('click', e => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // real new-tab/window requests pass through untouched
  const link = e.target.closest('[data-grafana-modal]');
  if (!link) return;
  e.preventDefault();
  openGrafanaModal(link.href, link.title || '');
});
