import { initTimePlayer } from './ui/TimePlayer.js';
import { initInputPanel } from './ui/InputPanel.js';
import { initGlobe } from './globe/GlobeView.js';
import { initMap, invalidateMapSize } from './planisphere/MapView.js';
import { loadInitialState, startApiPoller } from './apiPoller.js';
import { initSatInfo } from './ui/SatInfo.js';

// Tab switching — only wire up elements that declare a data-tab target
const tabBtns = document.querySelectorAll('[data-tab]');
const views = document.querySelectorAll('.view');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    views.forEach(v => v.classList.toggle('active', v.id === `${target}-view`));
    if (target === 'map') invalidateMapSize();
  });
});

// Init all modules
initTimePlayer();
initInputPanel();
initGlobe();
initMap();
initSatInfo();
loadInitialState().then(() => startApiPoller());
