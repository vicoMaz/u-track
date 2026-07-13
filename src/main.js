import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initGlobe } from './globe/GlobeView.js';
import { initMap, invalidateMapSize } from './planisphere/MapView.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';
import { initScheduler }         from './ui/Scheduler.js';
import { initChadOps }          from './ui/ChadOps.js';
import { initWeeklySchedule }   from './ui/WeeklySchedule.js';
import { initNavClocks }        from './ui/NavClocks.js';
import { initSatPing }          from './satPing.js';

// Tab switching
const tabBtns   = document.querySelectorAll('[data-tab]');
const views      = document.querySelectorAll('.view');
const sidePanel  = document.getElementById('side-panel');

// Tracking starts active
document.body.classList.add('tracking-active');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target      = btn.dataset.tab;
    const hideSide    = target === 'tools' || target === 'chadops' || target === 'settings';
    const isTracking  = target === 'tracking';
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    views.forEach(v   => v.classList.toggle('active', v.id === `${target}-view`));
    sidePanel.style.display = hideSide ? 'none' : '';
    document.body.classList.toggle('tools-active',    hideSide);
    document.body.classList.toggle('tracking-active', isTracking);
    location.hash = target;
  });
});

// Tracking internal subtabs (3D / 2D)
const trackSubtabBtns = document.querySelectorAll('[data-tracksubtab]');
const trackContents    = document.querySelectorAll('.track-subtab-content');
trackSubtabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.dataset.tracksubtab;
    trackSubtabBtns.forEach(b => b.classList.toggle('active', b.dataset.tracksubtab === sub));
    trackContents.forEach(c  => c.classList.toggle('active', c.id === `${sub}-view`));
    if (sub === 'map') invalidateMapSize();
  });
});

// Init all modules
initTimePlayer();
initInputPanel();
initGlobe();
initMap();
initSatInfo();
initScheduler();
initChadOps();
initWeeklySchedule();
initNavClocks();

// chadOps internal subtab switching
const coSubtabBtns     = document.querySelectorAll('[data-cosubtab]');
const coSubtabContents = document.querySelectorAll('.co-subtab-content');
coSubtabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.cosubtab;
    coSubtabBtns.forEach(b => b.classList.toggle('active', b.dataset.cosubtab === target));
    coSubtabContents.forEach(c => c.classList.toggle('active', c.id === `co-subtab-${target}`));
  });
});

// Restore tab from URL hash — must run after all initX() so their listeners are registered
const _initHash = location.hash.slice(1);
const _initBtn  = [...tabBtns].find(b => b.dataset.tab === _initHash);
if (_initBtn) _initBtn.click();

loadInitialState().then(() => { startApiPoller(); initSatPing(); });
