// Compact fleet-wide triage view above the detailed Fleet table (ChadOps.js) —
// one row per satellite, one solid-colored cell per subsystem (whole cell, not
// a small pill), sorted worst-first. Needs no new data fetching: satPing.js
// already polls telemetry/GNSS/ground-events/ping for every satellite in the
// fleet regardless of tracking state — this is a pure derived view over data
// ChadOps.js already renders in more granular form. Detail-on-demand: clicking
// a row scrolls the existing detailed table to that satellite.
import { store }                                          from '../store.js';
import { satSeverities, worstSev, SEV_COLOR, SEV_LABEL }  from './severity.js';

const COLS = [
  ['ping',   'PING'],
  ['mode',   'MODE'],
  ['batt',   'BATT'],
  ['gnss',   'GNSS'],
  ['ground', 'GND'],
];

function _rowHTML(sat) {
  const sev   = satSeverities(sat);
  const worst = worstSev(sat);
  const cells = COLS.map(([key, label]) =>
    `<td class="fhm-cell" style="background:${SEV_COLOR[sev[key]]}" title="${label}: ${SEV_LABEL[sev[key]]}"></td>`
  ).join('');
  return `<tr class="fhm-row" data-sat-id="${sat.id}">
    <td class="fhm-health" style="background:${SEV_COLOR[worst]}">${SEV_LABEL[worst]}</td>
    <td class="fhm-name" style="--sat-color:${sat.color}">${sat.name}</td>
    ${cells}
  </tr>`;
}

let _renderTimer = null;
function _scheduleRender() {
  if (_renderTimer) clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 150);
}

function render() {
  const tbody = document.getElementById('fhm-tbody');
  if (!tbody) return;
  const sorted = [...store.satellites].sort((a, b) => worstSev(b) - worstSev(a));
  tbody.innerHTML = sorted.length
    ? sorted.map(_rowHTML).join('')
    : '<tr><td colspan="7" class="fhm-empty">No satellites loaded</td></tr>';
  tbody.querySelectorAll('.fhm-row').forEach(row => {
    row.addEventListener('click', () => {
      const target = document.querySelector(`.co-row[data-sat-id="${row.dataset.satId}"]`);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('co-row-flash');
      setTimeout(() => target.classList.remove('co-row-flash'), 1200);
    });
  });
}

export function initFleetHeatmap() {
  const tbody = document.getElementById('fhm-tbody');
  if (!tbody) return;
  store.subscribe(key => {
    if (['satellites', 'satTelemetry', 'satGnss', 'satGroundEvents', 'pingStatus'].includes(key)) {
      _scheduleRender();
    }
  });
  render();
}
