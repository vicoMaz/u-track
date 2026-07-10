import { store } from '../store.js';

// ── Constants ─────────────────────────────────────────────────────

const TZ         = 'Europe/Paris';
const MIN_PX     = 1;               // 1 px per minute → 60 px/h, 1440 px/day
const TOTAL_PX   = 24 * 60 * MIN_PX;
const BIZ_START  = 8 * 60 + 30;    // 510 px
const BIZ_END    = 18 * 60 + 30;   // 1110 px
const MIN_PASS_H = 8;               // minimum pass block height in px

// ── Paris-time helpers ────────────────────────────────────────────

function _parisOf(date) {
  // Returns a Date whose getHours/getMinutes/getDate reflect Paris local time
  return new Date(date.toLocaleString('sv-SE', { timeZone: TZ }));
}

function _getMondayParis(offsetWeeks) {
  const d = _parisOf(new Date());
  d.setDate(d.getDate() + offsetWeeks * 7);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  d.setHours(0, 0, 0, 0);
  return d;
}

function _parisDateStr(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}

function _parisMinutes(date) {
  // Minutes from midnight in Paris time
  const t = date.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── Real pass data from store ─────────────────────────────────────

function _collectWeekPasses(weekStart) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
  const passes  = [];
  for (const sat of store.satellites) {
    for (const p of store.satPasses[sat.id] ?? []) {
      const start = p.start instanceof Date ? p.start : new Date(p.start);
      const end   = p.end   instanceof Date ? p.end   : new Date(p.end);
      if (end < weekStart || start >= weekEnd) continue;
      passes.push({ satId: sat.id, satName: sat.name, color: sat.color, station: p.station ?? '—', start, end });
    }
  }
  return passes.sort((a, b) => a.start - b.start);
}

// ── HTML builders ─────────────────────────────────────────────────

function _buildGrid(weekStart, passes) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const todayStr = _parisDateStr(new Date());

  // Time column labels
  const timeLabels = Array.from({ length: 25 }, (_, h) => {
    const isBiz = h === 8 || h === 9; // near 8:30
    const top   = h * 60;
    return `<div class="co-sched-time-label" style="top:${top}px">${String(h % 24).padStart(2,'0')}:00</div>`;
  }).join('') +
    `<div class="co-sched-time-label co-sched-biz-label" style="top:${BIZ_START}px">08:30</div>` +
    `<div class="co-sched-time-label co-sched-biz-label" style="top:${BIZ_END}px">18:30</div>`;

  // Hour lines (shared across all columns — rendered inside each column)
  const hourLinesFn = () => Array.from({ length: 25 }, (_, h) =>
    `<div class="co-sched-hour-line" style="top:${h * 60}px"></div>`
  ).join('');

  const dayCols = days.map(day => {
    const dayStr   = _parisDateStr(day);
    const isToday  = dayStr === todayStr;
    const dayPasses = passes.filter(p => _parisDateStr(p.start) === dayStr);

    const passBlocks = dayPasses.map(p => {
      const startMin = _parisMinutes(p.start);
      const endMin   = _parisMinutes(p.end);
      const height   = Math.max(endMin - startMin, MIN_PASS_H);
      return `<div class="co-sched-pass" style="top:${startMin}px;height:${height}px;border-left-color:${p.color};background:${p.color}1a" title="${p.satName} · ${p.station}">
        <span class="co-sched-pass-name" style="color:${p.color}">${p.satName}</span>
        <span class="co-sched-pass-sta">${p.station}</span>
      </div>`;
    }).join('');

    let nowLine = '';
    if (isToday) {
      const nowPx = _parisMinutes(new Date());
      nowLine = `<div class="co-sched-now-line" id="co-sched-now" style="top:${nowPx}px">
        <span class="co-sched-now-label">${new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12: false })}</span>
      </div>`;
    }

    const label   = day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const todayCls = isToday ? ' co-sched-today-col' : '';

    return `<div class="co-sched-day-col${todayCls}">
      <div class="co-sched-day-hdr">${label}</div>
      <div class="co-sched-day-body" style="height:${TOTAL_PX}px">
        ${hourLinesFn()}
        <div class="co-sched-offhours" style="top:0;height:${BIZ_START}px"></div>
        <div class="co-sched-offhours" style="top:${BIZ_END}px;height:${TOTAL_PX - BIZ_END}px"></div>
        <div class="co-sched-biz-border" style="top:${BIZ_START}px"></div>
        <div class="co-sched-biz-border" style="top:${BIZ_END}px"></div>
        ${passBlocks}
        ${nowLine}
      </div>
    </div>`;
  }).join('');

  return `<div class="co-sched-grid">
    <div class="co-sched-time-col">
      <div class="co-sched-day-hdr"></div>
      <div class="co-sched-time-body" style="height:${TOTAL_PX}px">${timeLabels}</div>
    </div>
    ${dayCols}
  </div>`;
}

function _buildLegend() {
  const sats = store.satellites.map(sat =>
    `<span class="co-sched-legend-item"><span class="co-sched-legend-dot" style="background:${sat.color}"></span>${sat.name}</span>`
  ).join('');
  return `<div class="co-sched-legend">
    <span class="co-sched-legend-item co-sched-legend-biz">
      <span class="co-sched-legend-biz-block"></span>Business hours (08:30–18:30 LT)
    </span>
    ${sats}
    <span class="co-sched-legend-tz">All times: Toulouse local (${TZ})</span>
  </div>`;
}

// ── iCal export ───────────────────────────────────────────────────

function _toIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function _generateIcs(passes) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//u-track//WeeklySchedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  passes.forEach((p, i) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:utrack-pass-${i}-${p.start.getTime()}@u-track`,
      `DTSTART:${_toIcsDate(p.start)}`,
      `DTEND:${_toIcsDate(p.end)}`,
      `SUMMARY:${p.satName} @ ${p.station}`,
      `DESCRIPTION:Satellite pass — ${p.satName} over ${p.station}`,
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function _downloadIcs(passes, weekStart) {
  const ics  = _generateIcs(passes);
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `schedule-${_parisDateStr(weekStart)}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Init ──────────────────────────────────────────────────────────

export function initWeeklySchedule() {
  const container = document.getElementById('co-sched-content');
  if (!container) return;

  let weekOffset = 0;
  let _active    = false;
  let _timer     = null;

  function render() {
    const weekStart = _getMondayParis(weekOffset);
    const weekEnd   = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    const passes    = _collectWeekPasses(weekStart);

    const fmtD = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const nav = `<div class="co-sched-nav">
      <button class="co-sched-nav-btn" id="co-sched-prev">← Prev</button>
      <span class="co-sched-nav-range">${fmtD(weekStart)} – ${fmtD(weekEnd)} ${weekEnd.getFullYear()}</span>
      <button class="co-sched-nav-btn" id="co-sched-next">Next →</button>
      ${weekOffset !== 0 ? '<button class="co-sched-nav-btn co-sched-today-btn" id="co-sched-today">This week</button>' : ''}
      <button class="co-sched-gcal-btn" id="co-sched-gcal" title="Download .ics and import into Google Calendar">↓ Export to GCal</button>
    </div>`;

    container.innerHTML = nav + _buildLegend() +
      `<div class="co-sched-outer" id="co-sched-outer">${_buildGrid(weekStart, passes)}</div>`;

    document.getElementById('co-sched-prev')?.addEventListener('click', () => { weekOffset--; render(); _scrollToBiz(); });
    document.getElementById('co-sched-next')?.addEventListener('click', () => { weekOffset++; render(); _scrollToBiz(); });
    document.getElementById('co-sched-today')?.addEventListener('click', () => { weekOffset = 0; render(); _scrollToBiz(); });
    document.getElementById('co-sched-gcal')?.addEventListener('click', () => _downloadIcs(passes, weekStart));
  }

  function _scrollToBiz() {
    requestAnimationFrame(() => {
      const el = document.getElementById('co-sched-outer');
      if (el) el.scrollTop = BIZ_START - 60; // reveal ~1h before business hours
    });
  }

  function _updateNow() {
    const el = document.getElementById('co-sched-now');
    if (!el) return;
    const px = _parisMinutes(new Date());
    el.style.top = px + 'px';
    const lbl = el.querySelector('.co-sched-now-label');
    if (lbl) lbl.textContent = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12:false });
  }

  function start() {
    _active = true;
    render();
    _scrollToBiz();
    _timer  = setInterval(_updateNow, 60000);
  }
  function stop() {
    _active = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // Listen to chadops subtab switches
  document.querySelectorAll('[data-cosubtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.cosubtab === 'schedule') start();
      else stop();
    });
  });
  // Stop when leaving chadops main tab
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.tab !== 'chadops') stop(); });
  });

  store.subscribe(key => { if ((key === 'satellites' || key === 'satPasses') && _active) render(); });
}
