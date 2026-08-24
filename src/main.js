import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initSttPovWidget } from './ui/sttPovWidget.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';
import { initNavClocks }        from './ui/NavClocks.js';
import { initSatPing }          from './satPing.js';
import { initVpnGuard }         from './ui/vpnGuard.js';
import { initPassNotify }       from './satPassNotify.js';
import { initTopSummary }       from './ui/TopSummary.js';
import { initProfileMenu }      from './ui/ProfileMenu.js';
import { closeAddPointPanel }   from './ui/AddPointPanel.js';
import { store }                from './store.js';
import { mapStyle, setMapStyle } from './mapStyle.js';

// eslint-disable-next-line no-undef -- injected by vite.config.js's `define`
document.getElementById('app-version').textContent = __APP_VERSION__;

// ── Lazy tab modules ────────────────────────────────────────────────
// Each of these is the root of exactly one view and is imported nowhere else
// (verified), so it can be a separate chunk that only downloads when its tab is
// first opened. Together they were 314KB of the single 493KB bundle — the 2D
// planisphere alone is 159KB of it, almost all Leaflet, for a subtab that isn't
// even the default. TimePlayer, InputPanel, SatInfo, NavClocks, TopSummary,
// sttPovWidget and the globe stay static: they are the persistent shell (top
// bar, side panel, bottom player) or the default view, so they are needed for
// first paint regardless.
//
// `init` runs once, on first activation. `replayClick` matters: several of these
// modules register their OWN [data-tab] listeners inside init to gate their work
// on tab visibility (ChadOps.start/stop, Scheduler/AlertAnalyzer's _active), and
// those listeners cannot have seen the click that triggered this very load — so
// the click is re-dispatched afterwards for them to catch. Re-entering switchTab
// from that synthetic click is harmless: it is idempotent, and the guard below
// means the module is never loaded twice.
const LAZY_VIEWS = {
  fleet:     { path: () => import('./ui/ChadOps.js'),        init: 'initChadOps' },
  schedule:  { path: () => import('./ui/WeeklySchedule.js'), init: 'initWeeklySchedule' },
  analyzer:  { path: () => import('./ui/PassAnalyzer.js'),   init: 'initPassAnalyzer' },
  alerts:    { path: () => import('./ui/AlertAnalyzer.js'),  init: 'initAlertAnalyzer' },
  scheduler: { path: () => import('./ui/Scheduler.js'),      init: 'initScheduler' },
};
const _viewMods    = {}; // tab -> resolved module, once loaded
const _viewLoading = {}; // tab -> in-flight promise, so a double click loads once

function ensureView(tab) {
  const spec = LAZY_VIEWS[tab];
  if (!spec) return Promise.resolve(null);
  if (_viewMods[tab]) return Promise.resolve(_viewMods[tab]);
  if (!_viewLoading[tab]) {
    _viewLoading[tab] = spec.path().then(mod => {
      _viewMods[tab] = mod;
      mod[spec.init]();
      document.querySelector(`[data-tab="${tab}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return mod;
    }).catch(err => {
      // A failed chunk load must not poison the tab forever — clear the
      // in-flight marker so the next click retries rather than hanging.
      delete _viewLoading[tab];
      console.error(`[main] failed to load the "${tab}" view:`, err);
      return null;
    });
  }
  return _viewLoading[tab];
}

// The 2D planisphere is its own chunk for the same reason, but hangs off the
// Visualizer's 3D/2D subtab rather than a [data-tab] button. Loading it on
// demand also fixes a second problem: initMap() used to run at boot against a
// display:none container, where Leaflet measures 0x0 and _fitWorld computes
// Math.log2(0/256) = -Infinity for its zoom — a whole map construction that
// rendered nothing.
let _mapMod = null, _mapLoading = null;
function ensureMap() {
  if (_mapMod) return Promise.resolve(_mapMod);
  if (!_mapLoading) {
    _mapLoading = import('./planisphere/MapView.js').then(mod => {
      mod.initMap();
      _mapMod = mod;
      return mod;
    }).catch(err => {
      _mapLoading = null;
      console.error('[main] failed to load the planisphere:', err);
      return null;
    });
  }
  return _mapLoading;
}

// The 3D globe, and Cesium itself. index.html no longer carries the Cesium
// <script>: it is ~4.97MB of parsed JS that only this view needs, and in <head>
// it sat in front of the app shell on every load — including for the six views
// that never draw a globe. Injecting it here means the shell (top bar, clocks,
// side panel, rail) paints first and the globe fills in behind it.
//
// Two things have to happen in order, which is why this is not just a dynamic
// import: globe/SatEntity.js evaluates Cesium.* at MODULE SCOPE, so the global
// has to exist before that module is even imported — hence await the script tag
// first, then import the subtree. Getting this backwards throws a ReferenceError
// during import and leaves the globe permanently blank.
let _globeMod = null, _globeLoading = null;

function _loadCesiumScript() {
  if (window.Cesium) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel  = 'stylesheet';
    css.href = '/cesium/Widgets/widgets.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src     = '/cesium/Cesium.js';
    js.async   = false; // preserve execution order if this ever gains siblings
    js.onload  = () => resolve();
    js.onerror = () => reject(new Error('/cesium/Cesium.js failed to load'));
    document.head.appendChild(js);
  });
}

function ensureGlobe() {
  if (_globeMod) return Promise.resolve(_globeMod);
  if (!_globeLoading) {
    _globeLoading = _loadCesiumScript()
      .then(() => import('./globe/GlobeView.js'))
      .then(mod => {
        mod.initGlobe();
        _globeMod = mod;
        // initGlobe reads store.currentTime/satellites itself, but the visibility
        // flag is main.js's state, so hand it over now that there is something
        // to tell.
        mod.setGlobeVisible(document.body.classList.contains('tracking-active') && activeSubtab === 'globe');
        return mod;
      })
      .catch(err => {
        _globeLoading = null;
        console.error('[main] failed to load the globe:', err);
        return null;
      });
  }
  return _globeLoading;
}

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
  // Both views are loaded on demand, so "not loaded" is itself the correct
  // gated state — there is no per-frame work to switch off yet.
  if (isTracking && activeSubtab === 'globe') ensureGlobe();
  _globeMod?.setGlobeVisible(isTracking && activeSubtab === 'globe');
  // Optional-call: until someone opens the 2D subtab there is no map to gate,
  // and "not loaded" already means "doing no per-frame work".
  _mapMod?.setMapVisible(isTracking && activeSubtab === 'map');
}

// Extracted out of the tab-button click handler so it can also be triggered
// programmatically — pda:open-pass/sch:open-pass/fleet:focus-sat below and
// the startup hash-restore all need to land on a specific pass/satellite,
// not just flip the tab to its empty state the way a plain button click does.
function switchTab(target) {
  // Ahead of ensureView so a read-only client never even fetches the lazy
  // Settings bundle. Covers every entry point at once — the rail click
  // below, the startup hash restore, and any programmatic switchTab.
  if (target === 'settings' && store.readOnlyVpn) return; // see _applySettingsAccess
  ensureView(target); // no-op for eager views; loads + inits a lazy one on first visit
  const hideSide    = target === 'fleet' || target === 'schedule' || target === 'settings' || target === 'analyzer' || target === 'scheduler' || target === 'alerts';
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
  btn.addEventListener('click', e => {
    // The rail entries are real <a href="#settings"> anchors, so letting the
    // default through would leave the URL on #settings while switchTab
    // declined to actually go there — and the next reload would then try to
    // restore a tab this user can't open.
    if (btn.dataset.tab === 'settings' && store.readOnlyVpn) { e.preventDefault(); return; }
    switchTab(btn.dataset.tab);
  });
});

// ── Settings access (operator VPN only) ──────────────────────────────────
// Settings is the one tab that edits SHARED state — it adds and removes
// satellites from the fleet every other user sees, and rewrites their base
// IPs. A colleague whose VPN carries only the SCC RO (.5) monitoring subnet
// is there to watch, not to re-shape the fleet, so the tab is gated on the
// same store.readOnlyVpn signal ProfileMenu.js already shows them as
// "Read-only access" — one source of truth, so the rail and the popover can
// never disagree about what kind of access this is.
//
// NOTE this is a UI guard, not enforcement: the server API is still open
// (see server/api.js's route table). It stops the accident — the misclicked
// × with no confirmation dialog — not a determined curl.
//
// Deliberately fails OPEN. store.readOnlyVpn is false both before the
// subsystem probes have landed and while the VPN is fully down (see its
// getter in store.js), and that's the behaviour we want: Settings is also
// the RECOVERY surface — it's where a wrong base IP gets corrected — so a
// reachability failure must never be the thing that locks someone out of
// repairing it. Only a POSITIVE read-only determination closes the tab.
const _settingsLink = [...tabBtns].find(b => b.dataset.tab === 'settings');
function _applySettingsAccess() {
  const locked = store.readOnlyVpn;
  if (!_settingsLink) return;
  _settingsLink.classList.toggle('rail-link-locked', locked);
  _settingsLink.setAttribute('aria-disabled', String(locked));
  _settingsLink.title = locked
    ? 'Settings — operator access required. Your VPN reaches only the SCC RO subnet.'
    : 'Settings';
  // Already on the tab when access dropped away (the probes resolve a few
  // seconds after load, so this is the normal path for a read-only user who
  // opened straight onto #settings) — don't strand them on a view the rail
  // now says they can't reach.
  if (locked && document.getElementById('settings-view')?.classList.contains('active')) {
    switchTab('tracking');
  }
}
store.subscribe(key => {
  if (key === 'satSubsystemReachable' || key === 'satAccessible' || key === 'satellites') _applySettingsAccess();
});
_applySettingsAccess();

// Dispatched by passTooltip.js's own "Open with Pass Analyzer" button (not an
// import from there, to avoid a circular dependency — that module doesn't
// need to know about main.js or PassAnalyzer.js at all, it just announces
// the intent).
document.addEventListener('pda:open-pass', e => {
  switchTab('analyzer');
  // The Analyzer may be loading for the first time, so the selection has to wait
  // for its module rather than being applied against nothing.
  ensureView('analyzer').then(m => m?.setSelection(e.detail.sat, e.detail.pass));
});

// Dispatched by passTooltip.js's own "Schedule procedures" (future pass) and
// "See scheduled procedures" (past pass) buttons, and by a click on any pass
// dot in Fleet — same announce-the-intent shape as pda:open-pass above.
document.addEventListener('sch:open-pass', e => {
  switchTab('scheduler');
  ensureView('scheduler').then(m => m?.setSchedulerSelection(e.detail.sat, e.detail.pass));
});

// Jump straight to a satellite's row in Fleet — same announce-the-intent
// shape as the two above (no in-app dispatcher right now: the pass tooltip's
// "View in Fleet" button that used to fire this was removed). Uses the tab
// button's own .click() rather than switchTab() directly: ChadOps.js listens for a
// real click on that SAME button to know when to start rendering the Fleet
// table (see its own start()/stop(), gated on _active) — calling
// switchTab() here would flip the view visible without ChadOps.js ever
// having populated #co-tbody, so focusSatRow below would find nothing to
// scroll to.
document.addEventListener('fleet:focus-sat', e => {
  const fleetBtn = [...tabBtns].find(b => b.dataset.tab === 'fleet');
  fleetBtn?.click();
  // Fleet's rows only exist once its module has loaded AND rendered, so the
  // scroll-to has to follow the module rather than race it.
  ensureView('fleet').then(m => m?.focusSatRow(e.detail.satId));
});

// Basemap dropdown in the Visualizer's subtab bar. Lives here rather than in
// either view because it drives BOTH — mapStyle.js holds the choice and notifies
// whichever of the globe/planisphere is currently loaded (see its own comment for
// why it isn't a GlobeView export). Selecting it before either view has loaded is
// fine: the value is persisted, and each view reads it when it initialises.
const mapPicker = document.getElementById('map-picker');
if (mapPicker) {
  const trigger = document.getElementById('map-picker-current');
  const caption = document.getElementById('map-picker-caption');
  const opts    = [...mapPicker.querySelectorAll('.map-picker-opt')];
  const LABELS  = { base: 'Base', satellite: 'Satellite', offline: 'Offline' };

  // Collapsed, the trigger is just the active basemap's NAME — the subtab bar has
  // no room for a thumbnail beside the Scale/Alt controls. The thumbnails live in
  // the open menu, where there is room to see what each choice looks like.
  const paint = () => {
    const cur = mapStyle();
    caption.textContent = LABELS[cur] ?? cur;
    for (const o of opts) o.classList.toggle('is-active', o.dataset.style === cur);
  };
  const close = () => { mapPicker.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); };
  const open  = () => { mapPicker.classList.add('is-open');    trigger.setAttribute('aria-expanded', 'true');  };

  trigger.addEventListener('click', () => {
    mapPicker.classList.contains('is-open') ? close() : open();
  });
  for (const o of opts) {
    o.addEventListener('click', () => {
      // setMapStyle returns false for a style that isn't implemented (Offline),
      // in which case nothing changes and the menu stays put — matching the
      // disabled attribute rather than contradicting it.
      if (setMapStyle(o.dataset.style)) { paint(); close(); }
    });
  }
  // Click-away and Escape, same convention as the app's other popovers.
  //
  // CAPTURE phase, and skipping clicks inside the picker rather than relying on
  // stopPropagation in the handlers above: Leaflet stops propagation of clicks
  // landing on the 2D map, so a bubble-phase listener here never sees them and
  // the menu would stay open when you clicked the planisphere to dismiss it.
  document.addEventListener('click', e => { if (!mapPicker.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  paint();
}

// Tracking internal subtabs (3D / 2D)
const trackSubtabBtns = document.querySelectorAll('[data-tracksubtab]');
const trackContents    = document.querySelectorAll('.track-subtab-content');
trackSubtabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.dataset.tracksubtab;
    trackSubtabBtns.forEach(b => b.classList.toggle('active', b.dataset.tracksubtab === sub));
    trackContents.forEach(c  => c.classList.toggle('active', c.id === `${sub}-view`));
    activeSubtab = sub;
    if (sub === 'map') {
      // Built on first open. invalidateMapSize still runs on every later switch:
      // the container was display:none until now, so Leaflet has to re-measure.
      ensureMap().then(m => {
        m?.invalidateMapSize();
        _applyTrackingVisibility(document.body.classList.contains('tracking-active'));
      });
    }
    _applyTrackingVisibility(document.body.classList.contains('tracking-active'));
  });
});

// Init the persistent shell only. The seven view modules in LAZY_VIEWS/ensureMap
// above initialise themselves on first activation instead — see their comment
// for why, and for what stays eager.
initTimePlayer();
initInputPanel();
initSttPovWidget();
initSatInfo();
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
      if (tab === 'analyzer') ensureView('analyzer').then(m => m?.setSelection(sat, pass));
      else                     ensureView('scheduler').then(m => m?.restoreSchedulerSelection(sat, pass));
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
  // No hash (or one that names no tab) means the markup's own default stays:
  // the Visualizer, 3D subtab. Nothing clicked, so nothing has asked for the
  // globe yet — and since both views load on demand now, "nobody asked" would
  // otherwise mean an empty Visualizer on a plain load of "/".
  else _applyTrackingVisibility(document.body.classList.contains('tracking-active'));
}

loadInitialState().then(() => { startApiPoller(); initSatPing(); initVpnGuard(); initPassNotify(); });
