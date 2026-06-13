import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initGlobe } from './globe/GlobeView.js';
import { initMap, invalidateMapSize } from './planisphere/MapView.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';
import { initStaplanExplorer } from './ui/StaplanExplorer.js';

// Tab switching — only wire up elements that declare a data-tab target
const tabBtns = document.querySelectorAll('[data-tab]');
const views = document.querySelectorAll('.view');

const sidePanel = document.getElementById('side-panel');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    const isTools = target === 'tools';
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    views.forEach(v => v.classList.toggle('active', v.id === `${target}-view`));
    sidePanel.style.display = isTools ? 'none' : '';
    document.body.classList.toggle('tools-active', isTools);
    if (target === 'map') invalidateMapSize();
  });
});

// Init all modules
initTimePlayer();
initInputPanel();
initGlobe();
initMap();
initSatInfo();
initStaplanExplorer();
loadInitialState().then(() => startApiPoller());
