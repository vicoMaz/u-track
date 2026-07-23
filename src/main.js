import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initPointsPanel } from './ui/PointsPanel.js';
import { initSttPovWidget } from './ui/sttPovWidget.js';
import { initGlobe, setGlobeVisible } from './globe/GlobeView.js';
import { initMap, invalidateMapSize, setMapVisible } from './planisphere/MapView.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';
import { initChadOps }          from './ui/ChadOps.js';
import { initWeeklySchedule }   from './ui/WeeklySchedule.js';
import { initPassAnalyzer, setSelection as setAnalyzerSelection } from './ui/PassAnalyzer.js';
import { initNavClocks }        from './ui/NavClocks.js';
import { initSatPing }          from './satPing.js';
import { initVpnGuard }         from './ui/vpnGuard.js';
import { initReadOnlyBadge }    from './ui/readOnlyBadge.js';
import { closePassDetail }      from './ui/PassDetailPanel.js';

// eslint-disable-next-line no-undef -- injected by vite.config.js's `define`
document.getElementById('app-version').textContent = __APP_VERSION__;

// Tab switching
const tabBtns   = document.querySelectorAll('[data-tab]');
const views      = document.querySelectorAll('.view');
const sidePanel  = document.getElementById('side-panel');

// Tracking starts active
document.body.classList.add('tracking-active');

// Gates the globe/map per-frame work (SGP4 propagation, night-shadow canvas)
// to whichever of the two is actually visible — see GlobeView.js/MapView.js's
// setGlobeVisible/setMapVisible. Tracks the last-active subtab so switching
// away from and back to the Visualizer tab restores the right one.
let activeSubtab = 'globe'; // matches index.html's default active subtab
function _applyTrackingVisibility(isTracking) {
  setGlobeVisible(isTracking && activeSubtab === 'globe');
  setMapVisible(isTracking && activeSubtab === 'map');
}

// Extracted out of the tab-button click handler so it can also be triggered
// programmatically — the Pass Analyzer tab was removed from the nav bar (see
// index.html; #analyzer-view is still there), reachable now only via the
// microscope button in PassDetailPanel.js's slide-in, which has no
// data-tab button of its own to click.
function switchTab(target) {
  const hideSide    = target === 'fleet' || target === 'schedule' || target === 'settings' || target === 'analyzer';
  const isTracking  = target === 'tracking';
  closePassDetail(); // slide-in shouldn't persist across a tab change — it's tied to whatever view opened it
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
  views.forEach(v   => v.classList.toggle('active', v.id === `${target}-view`));
  sidePanel.style.display = hideSide ? 'none' : '';
  document.body.classList.toggle('tools-active',    hideSide);
  document.body.classList.toggle('tracking-active', isTracking);
  location.hash = target;
  _applyTrackingVisibility(isTracking);
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Dispatched by PassDetailPanel.js's microscope button (not an import from
// there, to avoid a circular dependency — that module doesn't need to know
// about main.js or PassAnalyzer.js at all, it just announces the intent).
document.addEventListener('pda:open-pass', e => {
  switchTab('analyzer');
  setAnalyzerSelection(e.detail.sat, e.detail.pass);
});

// Tracking internal subtabs (3D / 2D)
const trackSubtabBtns = document.querySelectorAll('[data-tracksubtab]');
const trackContents    = document.querySelectorAll('.track-subtab-content');
trackSubtabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.dataset.tracksubtab;
    trackSubtabBtns.forEach(b => b.classList.toggle('active', b.dataset.tracksubtab === sub));
    trackContents.forEach(c  => c.classList.toggle('active', c.id === `${sub}-view`));
    activeSubtab = sub;
    if (sub === 'map') invalidateMapSize();
    _applyTrackingVisibility(document.body.classList.contains('tracking-active'));
  });
});

// Init all modules
initTimePlayer();
initInputPanel();
initPointsPanel();
initSttPovWidget();
initGlobe();
initMap();
initSatInfo();
initChadOps();
initWeeklySchedule();
initPassAnalyzer();
initNavClocks();

// Restore tab from URL hash — must run after all initX() so their listeners are registered
const _initHash = location.hash.slice(1);
const _initBtn  = [...tabBtns].find(b => b.dataset.tab === _initHash);
if (_initBtn) _initBtn.click();

loadInitialState().then(() => { startApiPoller(); initSatPing(); initVpnGuard(); initReadOnlyBadge(); });
