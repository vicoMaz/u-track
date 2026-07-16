import { store } from '../store.js';
import { createPassTooltip } from './passTooltip.js';

// ── Constants ─────────────────────────────────────────────────────

const TZ        = 'Europe/Paris';
const BIZ_START = 8 * 60 + 30;   // minutes from midnight
const BIZ_END   = 18 * 60 + 30;
const _pct      = min => `${(min / 1440 * 100).toFixed(3)}%`;

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
      // Keep the raw pass + sat so the hover tooltip has everything it needs
      // (outcome, procedures, satrec for the eclipse bar/trajectory plot) —
      // not just the handful of fields the grid itself renders.
      passes.push({ sat, pass: p, satId: sat.id, satName: sat.name, color: sat.color, station: p.station ?? '—', start, end });
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

  // Time column labels — every 2 h to avoid crowding at compressed scale
  const timeLabels = Array.from({ length: 13 }, (_, i) => {
    const h   = i * 2;
    return `<div class="co-sched-time-label" style="top:${_pct(h * 60)}">${String(h).padStart(2,'0')}:00</div>`;
  }).join('') +
    `<div class="co-sched-time-label co-sched-biz-label" style="top:${_pct(BIZ_START)}">08:30</div>` +
    `<div class="co-sched-time-label co-sched-biz-label" style="top:${_pct(BIZ_END)}">18:30</div>`;

  // Hour lines
  const hourLinesFn = () => Array.from({ length: 25 }, (_, h) =>
    `<div class="co-sched-hour-line" style="top:${_pct(h * 60)}"></div>`
  ).join('');

  const dayCols = days.map(day => {
    const dayStr    = _parisDateStr(day);
    const isToday   = dayStr === todayStr;
    const dayPasses = passes.filter(p => _parisDateStr(p.start) === dayStr);

    const passBlocks = dayPasses.map(p => {
      const startMin   = _parisMinutes(p.start);
      const durationMin = Math.max((_parisMinutes(p.end) - startMin + 1440) % 1440, 1);
      const idx = passes.indexOf(p);
      return `<div class="co-sched-pass" data-pass-idx="${idx}" style="top:${_pct(startMin)};height:${_pct(durationMin)};border-left-color:${p.color};background:${p.color}1a">
        <span class="co-sched-pass-name" style="color:${p.color}">${p.satName}</span>
        <span class="co-sched-pass-sta">${p.station}</span>
      </div>`;
    }).join('');

    let nowLine = '';
    if (isToday) {
      const nowMin = _parisMinutes(new Date());
      nowLine = `<div class="co-sched-now-line" id="co-sched-now" style="top:${_pct(nowMin)}">
        <span class="co-sched-now-label">${new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12: false })}</span>
      </div>`;
    }

    const label    = day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const todayCls = isToday ? ' co-sched-today-col' : '';

    return `<div class="co-sched-day-col${todayCls}">
      <div class="co-sched-day-hdr">${label}</div>
      <div class="co-sched-day-body">
        ${hourLinesFn()}
        <div class="co-sched-offhours" style="top:0;height:${_pct(BIZ_START)}"></div>
        <div class="co-sched-offhours" style="top:${_pct(BIZ_END)};height:${_pct(1440 - BIZ_END)}"></div>
        <div class="co-sched-biz-border" style="top:${_pct(BIZ_START)}"></div>
        <div class="co-sched-biz-border" style="top:${_pct(BIZ_END)}"></div>
        ${passBlocks}
        ${nowLine}
      </div>
    </div>`;
  }).join('');

  return `<div class="co-sched-grid">
    <div class="co-sched-time-col">
      <div class="co-sched-day-hdr"></div>
      <div class="co-sched-time-body">${timeLabels}</div>
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

  let weekOffset  = 0;
  let _active     = false;
  let _timer      = null;
  let _weekPasses = []; // kept in sync with the array handed to _buildGrid, for hover lookups

  const tooltip = createPassTooltip();

  function render() {
    const weekStart = _getMondayParis(weekOffset);
    const weekEnd   = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    const passes    = _collectWeekPasses(weekStart);
    _weekPasses = passes;

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

    document.getElementById('co-sched-prev')?.addEventListener('click', () => { weekOffset--; render(); });
    document.getElementById('co-sched-next')?.addEventListener('click', () => { weekOffset++; render(); });
    document.getElementById('co-sched-today')?.addEventListener('click', () => { weekOffset = 0; render(); });
    document.getElementById('co-sched-gcal')?.addEventListener('click', () => _downloadIcs(passes, weekStart));

    container.querySelectorAll('.co-sched-pass[data-pass-idx]').forEach(el => {
      const entry = _weekPasses[parseInt(el.dataset.passIdx, 10)];
      if (!entry) return;
      el.addEventListener('mouseenter', e => tooltip.showForPass(e, entry.pass, entry.sat, store.groundStations));
      el.addEventListener('mouseleave', tooltip.scheduleHide);
    });
  }

  function _updateNow() {
    const el = document.getElementById('co-sched-now');
    if (!el) return;
    el.style.top = _pct(_parisMinutes(new Date()));
    const lbl = el.querySelector('.co-sched-now-label');
    if (lbl) lbl.textContent = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12:false });
  }

  function start() {
    _active = true;
    render();
    _timer  = setInterval(_updateNow, 60000);
  }
  function stop() {
    _active = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
    tooltip.element.style.display = 'none';
  }

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'schedule') start();
      else stop();
    });
  });

  store.subscribe(key => { if ((key === 'satellites' || key === 'satPasses') && _active) render(); });
}
