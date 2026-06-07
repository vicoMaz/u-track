import { store } from '../store.js';

const EPOCH = new Date();
let playing = false;
let speed = 1;
let scrubOffsetSec = 0;
let lastRaf = null;
let lastTs = null;

const playBtn   = document.getElementById('play-btn');
const nowBtn    = document.getElementById('now-btn');
const speedSel  = document.getElementById('speed-select');
const scrub     = document.getElementById('time-scrub');
const dateInput = document.getElementById('date-input');
const scaleSlider = document.getElementById('scale-slider');
const scaleField  = document.getElementById('scale-field');

function formatDisplay(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getUTCDate())}-${p(date.getUTCMonth() + 1)}-${date.getUTCFullYear()} `
       + `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

function parseDisplay(str) {
  // Accepts "DD-MM-YYYY HH:MM:SS" or "DD-MM-YYYY HH:MM"
  const m = str.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, dd, mo, yyyy, hh, mm, ss = '0'] = m;
  const d = new Date(Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mm, +ss));
  return isNaN(d) ? null : d;
}

function applyTime() {
  const t = new Date(EPOCH.getTime() + scrubOffsetSec * 1000);
  store.setTime(t);
  scrub.value = scrubOffsetSec;
  nowBtn.classList.toggle('active', Math.abs(scrubOffsetSec) < 2);
  if (document.activeElement !== dateInput) {
    dateInput.value = formatDisplay(t);
  }
}

function tick(ts) {
  if (!playing) return;
  if (lastTs !== null) {
    const dt = (ts - lastTs) / 1000;
    scrubOffsetSec += dt * speed;
    scrubOffsetSec = Math.max(-604800, Math.min(604800, scrubOffsetSec));
    applyTime();
  }
  lastTs = ts;
  lastRaf = requestAnimationFrame(tick);
}

function startPlay() {
  playing = true;
  lastTs = null;
  playBtn.textContent = '⏸';
  playBtn.classList.add('playing');
  lastRaf = requestAnimationFrame(tick);
}

function stopPlay() {
  playing = false;
  playBtn.textContent = '▶';
  playBtn.classList.remove('playing');
  if (lastRaf) cancelAnimationFrame(lastRaf);
}

function step(deltaSec) {
  stopPlay();
  scrubOffsetSec = Math.max(-604800, Math.min(604800, scrubOffsetSec + deltaSec));
  applyTime();
}

export function initTimePlayer() {
  playBtn.addEventListener('click', () => playing ? stopPlay() : startPlay());

  nowBtn.addEventListener('click', () => {
    stopPlay();
    scrubOffsetSec = 0;
    applyTime();
  });

  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); });

  scrub.addEventListener('input', () => {
    stopPlay();
    scrubOffsetSec = Number(scrub.value);
    applyTime();
  });

  // Step buttons (−1d, −1h, +1h, +1d)
  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => step(Number(btn.dataset.step)));
  });

  // Manual date jump — parse DD-MM-YYYY HH:MM:SS on Enter or blur
  const commitDateInput = () => {
    const parsed = parseDisplay(dateInput.value);
    if (!parsed) { dateInput.value = formatDisplay(new Date(EPOCH.getTime() + scrubOffsetSec * 1000)); return; }
    stopPlay();
    scrubOffsetSec = (parsed.getTime() - EPOCH.getTime()) / 1000;
    scrubOffsetSec = Math.max(-604800, Math.min(604800, scrubOffsetSec));
    applyTime();
  };
  dateInput.addEventListener('blur',    commitDateInput);
  dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitDateInput(); dateInput.blur(); } });

  // Scale slider + field
  const applyScale = (raw) => {
    const v = Math.max(1, Math.min(1000, Math.round(+raw) || 500));
    scaleSlider.value = v;
    scaleField.value  = v;
    store.setScale(v);
  };
  scaleSlider.addEventListener('input',  () => applyScale(scaleSlider.value));
  scaleField.addEventListener('change',  () => applyScale(scaleField.value));
  scaleField.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyScale(scaleField.value); });

  speed = Number(speedSel.value);
  applyTime();
  startPlay();
}
