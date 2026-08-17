import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initSttPovWidget } from './ui/sttPovWidget.js';
import { initGlobe, setGlobeVisible } from './globe/GlobeView.js';
import { initMap, invalidateMapSize, setMapVisible } from './planisphere/MapView.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';
import { initChadOps, focusSatRow } from './ui/ChadOps.js';
import { initWeeklySchedule }   from './ui/WeeklySchedule.js';
import { initPassAnalyzer, setSelection as setAnalyzerSelection } from './ui/PassAnalyzer.js';
import { initScheduler, setSchedulerSelection, restoreSchedulerSelection } from './ui/Scheduler.js';
import { initNavClocks }        from './ui/NavClocks.js';
import { initSatPing }          from './satPing.js';
import { initVpnGuard }         from './ui/vpnGuard.js';
import { initTopSummary }       from './ui/TopSummary.js';
import { initProfileMenu }      from './ui/ProfileMenu.js';
import { closeAddPointPanel }   from './ui/AddPointPanel.js';
import { store }                from './store.js';

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
// programmatically — pda:open-pass/sch:open-pass/fleet:focus-sat below and
// the startup hash-restore all need to land on a specific pass/satellite,
// not just flip the tab to its empty state the way a plain button click does.
function switchTab(target) {
  const hideSide    = target === 'fleet' || target === 'schedule' || target === 'settings' || target === 'analyzer' || target === 'scheduler';
  const isTracking  = target === 'tracking';
  closeAddPointPanel(); // slide-in shouldn't persist across a tab change — it's tied to the sat panel, which just hid
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

// Dispatched by passTooltip.js's own "Open with Pass Analyzer" button (not an
// import from there, to avoid a circular dependency — that module doesn't
// need to know about main.js or PassAnalyzer.js at all, it just announces
// the intent).
document.addEventListener('pda:open-pass', e => {
  switchTab('analyzer');
  setAnalyzerSelection(e.detail.sat, e.detail.pass);
});

// Dispatched by passTooltip.js's own "Schedule procedures" button (future
// passes only) — same announce-the-intent shape as pda:open-pass above.
document.addEventListener('sch:open-pass', e => {
  switchTab('scheduler');
  setSchedulerSelection(e.detail.sat, e.detail.pass);
});

// Dispatched by passTooltip.js's own "View in Fleet" button — same
// announce-the-intent shape as the two above. Uses the actual tab button's
// own .click() rather than switchTab() directly: ChadOps.js listens for a
// real click on that SAME button to know when to start rendering the Fleet
// table (see its own start()/stop(), gated on _active) — calling
// switchTab() here would flip the view visible without ChadOps.js ever
// having populated #co-tbody, so focusSatRow below would find nothing to
// scroll to.
document.addEventListener('fleet:focus-sat', e => {
  const fleetBtn = [...tabBtns].find(b => b.dataset.tab === 'fleet');
  fleetBtn?.click();
  focusSatRow(e.detail.satId);
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
initSttPovWidget();
initGlobe();
initMap();
initSatInfo();
initChadOps();
initWeeklySchedule();
initPassAnalyzer();
initScheduler();
initNavClocks();
initTopSummary();
initProfileMenu();

// Left-rail collapse toggle (icon-only mode) — persisted across reloads.
// Purely a body class + CSS var (see style.css's body.left-rail-collapsed);
// every rail-adjacent fixed element (side panel, time player, gantt) reads
// --left-rail-w itself, so no other JS needs to know this happened.
const RAIL_COLLAPSED_KEY = 'chadops.leftRailCollapsed';
const railCollapseBtn = document.getElementById('rail-collapse-btn');
if (localStorage.getItem(RAIL_COLLAPSED_KEY) === '1') {
  document.body.classList.add('left-rail-collapsed');
}
railCollapseBtn?.addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('left-rail-collapsed');
  localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
});

// Satellites and their passes each load asynchronously (loadInitialState()
// only guarantees the satellite LIST; satPasses arrives per-satellite,
// separately) — polls via the store's own subscribe rather than a fixed
// delay, so this fires the instant the needed data actually shows up
// instead of guessing how long to wait. Gives up after RESTORE_TIMEOUT_MS —
// a stale/bad link, or that pass has since aged out of satPasses' own
// window — and just leaves whatever tab was already active (Visualizer).
// `done` is the only guard (store.subscribe has no unsubscribe), so once
// resolved or timed out this listener goes permanently inert rather than
// re-triggering (and yanking the user back into the Analyzer) on some
// LATER unrelated satPasses refresh.
const RESTORE_TIMEOUT_MS = 20_000;
function _restorePassSelection(tab, satNameSlug, passStartMs) {
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  let done = false;
  const tryNow = () => {
    if (done) return true;
    const sat  = store.satellites.find(s => s.name.toLowerCase() === satNameSlug);
    const pass = sat ? (store.satPasses[sat.id] ?? []).find(p => p.start.getTime() === passStartMs) : null;
    if (sat && pass) {
      done = true;
      switchTab(tab);
      if (tab === 'analyzer') setAnalyzerSelection(sat, pass);
      else restoreSchedulerSelection(sat, pass);
      return true;
    }
    if (Date.now() > deadline) { done = true; return true; }
    return false;
  };
  if (tryNow()) return;
  store.subscribe(key => {
    if (key === 'satellites' || key === 'satPasses') tryNow();
  });
}

// Restore tab (+, for the Analyzer/Scheduler, the exact pass — see
// PassAnalyzer.js's setSelection/_stepPass and Scheduler.js's own
// _updateHash, which keep the hash in this "<sat name>/pass/<passStartMs>"
// (Analyzer) or "scheduler/<sat name>/pass/<passStartMs>" (Scheduler) shape
// while a pass is open) from the URL hash — must run after all initX() so
// their listeners are registered. Plain tabs restore synchronously below
// (their nav buttons already exist); both pass-selection shapes are handled
// by _restorePassSelection above instead, since they need satellites/
// satPasses to actually be loaded first. The "scheduler/" prefix is what
// tells the two shapes apart — Analyzer's own format is left bare (no tab
// name in it) for backward compatibility with links saved before Scheduler
// grew this same persistence, so a plain 3-segment hash always means
// Analyzer and a "scheduler/…" 4-segment one always means Scheduler. A
// satellite literally named "fleet"/"tracking"/etc. would collide with a
// real tab, but isn't a real case worth guarding against.
const _initHash = location.hash.slice(1);
const _schedulerHash = _initHash.match(/^scheduler\/([^/]+)\/pass\/(\d+)$/);
const _analyzerHash  = !_schedulerHash && _initHash.match(/^([^/]+)\/pass\/(\d+)$/);
if (_schedulerHash) {
  _restorePassSelection('scheduler', decodeURIComponent(_schedulerHash[1]), Number(_schedulerHash[2]));
} else if (_analyzerHash) {
  _restorePassSelection('analyzer', decodeURIComponent(_analyzerHash[1]), Number(_analyzerHash[2]));
} else {
  const _initBtn = [...tabBtns].find(b => b.dataset.tab === _initHash);
  if (_initBtn) _initBtn.click();
}

loadInitialState().then(() => { startApiPoller(); initSatPing(); initVpnGuard(); });
