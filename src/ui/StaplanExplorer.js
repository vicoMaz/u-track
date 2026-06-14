import { store } from '../store.js';
import * as XLSX from 'xlsx';
import { propagate } from '../tle.js';
import { sunDirectionECI, isInEclipse } from '../sunVector.js';

// satId -> { satName, passes: [] }
// pass: { id, satName, station, aos0, aos5|undefined, los5|undefined, los0, selected }
let staplans = {};

const SPARKLINE_FORMULA = `=SPARKLINE({IF(H14>=0;H14;ABS(H14));1-ABS(H14)};{"charttype"\\"bar";"max"\\1;"color1"\\IF(H14>=0;"#0000FF";"#FFFF00");"color2"\\IF(H14>=0;"#FFFF00";"#0000FF")})`;

const ECLIPSE_TOOLTIP_HTML = `
  <div class="eclipse-tooltip-title">Eclipse field (−1 to +1)</div>
  <div class="eclipse-tooltip-row"><span class="etip-key"> 1</span> Full eclipse — entire pass in shadow</div>
  <div class="eclipse-tooltip-row"><span class="etip-key"> 0</span> Full sun — no eclipse</div>
  <div class="eclipse-tooltip-row"><span class="etip-key">+X</span> Starts in eclipse, exits to sun after X of the pass</div>
  <div class="eclipse-tooltip-row"><span class="etip-key">−X</span> Starts in sun, enters eclipse in the last X of the pass</div>
  <div class="eclipse-tooltip-row etip-note">Computed over the full AOS 0° → LOS 0° duration</div>
  <div class="eclipse-tooltip-divider"></div>
  <div class="eclipse-tooltip-label">Excel bar chart formula (replace H14 with your cell):</div>
  <div class="eclipse-tooltip-formula">${SPARKLINE_FORMULA.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  <div class="eclipse-tooltip-copy-hint">Click the column header to copy formula</div>
`;

export function initStaplanExplorer() {
  // Floating eclipse tooltip — appended to body so it's never clipped by overflow containers
  const floatTip = document.createElement('div');
  floatTip.id = 'eclipse-float-tip';
  floatTip.innerHTML = ECLIPSE_TOOLTIP_HTML;
  document.body.appendChild(floatTip);

  document.querySelectorAll('.eclipse-th').forEach(th => {
    th.addEventListener('mouseenter', () => {
      const r = th.getBoundingClientRect();
      const TIP_W = 340, TIP_H = 230;
      const left = Math.min(r.right - TIP_W, window.innerWidth - TIP_W - 8);
      const fitsBelow = r.bottom + TIP_H + 6 < window.innerHeight;
      floatTip.style.left = `${Math.max(8, left)}px`;
      floatTip.style.top  = fitsBelow
        ? `${r.bottom + 6}px`
        : `${r.top - TIP_H - 6}px`;
      floatTip.classList.add('visible');
    });
    th.addEventListener('mouseleave', () => floatTip.classList.remove('visible'));
    th.addEventListener('click', () => {
      navigator.clipboard.writeText(SPARKLINE_FORMULA).then(() => {
        th.classList.add('eclipse-th-copied');
        setTimeout(() => th.classList.remove('eclipse-th-copied'), 1500);
      });
    });
  });

  document.querySelectorAll('.tools-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.subtab;
      document.querySelectorAll('.tools-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.subtab === target));
      document.querySelectorAll('.tools-subtab-content').forEach(c =>
        c.classList.toggle('active', c.id === `tools-subtab-${target}`));
    });
  });

  document.getElementById('csc-copy-btn').addEventListener('click', copyTimetable);
  document.getElementById('csc-download-btn').addEventListener('click', downloadStaplan);
  document.getElementById('csc-deselect-btn').addEventListener('click', () => {
    for (const { passes } of Object.values(staplans)) passes.forEach(p => p.selected = false);
    renderPassTable();
    renderTimetable();
  });

  store.subscribe((key) => {
    if (key !== 'satellites') return;
    const ids = new Set(store.satellites.map(s => s.id));
    for (const id of Object.keys(staplans)) {
      if (!ids.has(id)) delete staplans[id];
    }
    renderAll();
  });

  renderAll();
}

// ── Eclipse computation ───────────────────────────────────────────

function computeEclipse(satrec, aos0, los0) {
  if (!satrec || !aos0 || !los0) return null;
  const SAMPLES = 60;
  const step = (los0 - aos0) / SAMPLES;
  const states = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t   = new Date(aos0.getTime() + i * step);
    const pos = propagate(satrec, t);
    if (!pos?.eciPos) return null;
    states.push(isInEclipse(pos.eciPos, sunDirectionECI(t)));
  }
  const startsEclipse = states[0];
  // Fully sun or fully eclipse
  if (states.every(s => s === startsEclipse)) return startsEclipse ? 1 : 0;
  // Find first transition
  const transIdx = states.findIndex(s => s !== startsEclipse);
  const frac = transIdx / SAMPLES;
  // +frac → starts in eclipse for frac of pass, then sun
  // -frac → starts in sun for frac of pass, then eclipse
  return startsEclipse ? frac : -frac;
}

// ── Parsing ──────────────────────────────────────────────────────

function rowsToStaplan(rows, satName) {
  // rows: array of [timestamp, event, station, status] (strings)
  const passes = [];
  const open = {};

  for (const row of rows) {
    if (row.length < 4) continue;
    const [ts, event, station, status] = row.map(c => String(c ?? '').trim());
    const time = new Date(ts);
    if (isNaN(time.getTime())) continue;

    if (event === 'AOS_0') {
      open[station] = { satName, station, aos0: time, selected: status === 'BOOKED' };
    } else if (event === 'AOS_5' && open[station]) {
      open[station].aos5 = time;
    } else if (event === 'LOS_5' && open[station]) {
      open[station].los5 = time;
    } else if (event === 'LOS_0' && open[station]) {
      open[station].los0 = time;
      const p = { ...open[station] };
      p.id = `${satName}|${station}|${p.aos0.getTime()}`;
      p.eclipse = null;
      passes.push(p);
      delete open[station];
    }
  }
  return passes;
}

function parseText(text, satName) {
  const rows = text.trim().split('\n').map(raw => {
    const line = raw.trim();
    if (line.includes('\t')) return line.split('\t');
    return line.split(/\s{2,}/);
  });
  return rowsToStaplan(rows, satName);
}

function parseXlsx(buffer, satName) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return rowsToStaplan(rows, satName);
}

// ── Formatting helpers ────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  const SS = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
}

function fmtDur(a, b) {
  if (!a || !b) return '—';
  const s = Math.round((b - a) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function fmtSec(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function eclipseBar(v, p) {
  if (v === null || v === undefined) return '<span class="eclipse-none">—</span>';
  const num = parseFloat(v);
  if (isNaN(num)) return '<span class="eclipse-none">—</span>';
  const abs  = Math.abs(num);
  const BLUE   = '#2255ee';
  const YELLOW = '#e6b800';
  const grad = num >= 0
    ? `linear-gradient(to right, ${BLUE} ${abs*100}%, ${YELLOW} ${abs*100}%)`
    : `linear-gradient(to right, ${YELLOW} ${abs*100}%, ${BLUE} ${abs*100}%)`;

  const totalSec  = (p?.aos0 && p?.los0) ? Math.round((p.los0 - p.aos0) / 1000) : null;
  const firstSec  = totalSec !== null ? Math.round(abs * totalSec) : null;
  const secondSec = totalSec !== null ? totalSec - firstSec : null;

  const leftLabel  = firstSec  !== null ? fmtSec(firstSec)  : '';
  const rightLabel = secondSec !== null ? fmtSec(secondSec) : '';

  return `<div class="eclipse-bar" style="background:${grad}" title="${num}">
    <span class="eclipse-seg-l" style="width:${abs*100}%">${leftLabel}</span>
    <span class="eclipse-seg-r" style="width:${(1-abs)*100}%">${rightLabel}</span>
  </div>`;
}

function abbrev(name) {
  return name.replace(/_/g, '').slice(0, 3).toUpperCase() + '.';
}

function allPasses() {
  const out = [];
  for (const { passes } of Object.values(staplans)) out.push(...passes);
  out.sort((a, b) => a.aos0 - b.aos0);
  return out;
}

function findPass(id) {
  for (const { passes } of Object.values(staplans)) {
    const p = passes.find(x => x.id === id);
    if (p) return p;
  }
  return null;
}

// ── File loading ──────────────────────────────────────────────────

function loadFile(file, satId) {
  const sat = store.satellites.find(s => s.id === satId);
  if (!sat) return;
  const satName = sat.name || sat.noradId;
  const isXlsx = /\.(xlsx|xls|ods)$/i.test(file.name);

  const finish = (passes) => {
    const sat = store.satellites.find(s => s.id === satId);
    if (sat?.satrec) {
      for (const p of passes) {
        p.eclipse = computeEclipse(sat.satrec, p.aos0, p.los0);
      }
    }
    staplans[satId] = { satName, passes };
    renderAll();
  };

  if (isXlsx) {
    const reader = new FileReader();
    reader.onload = ev => finish(parseXlsx(new Uint8Array(ev.target.result), satName));
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = ev => finish(parseText(ev.target.result, satName));
    reader.readAsText(file);
  }
}

// ── Render: satellite uploader chips ─────────────────────────────

function renderSatUploaders() {
  const el = document.getElementById('csc-uploaders');
  if (!el) return;
  el.innerHTML = '';

  if (store.satellites.length === 0) {
    el.innerHTML = '<span class="csc-hint">Add satellites in the side panel first.</span>';
    return;
  }

  for (const sat of store.satellites) {
    const satId = sat.id;
    const loaded = staplans[satId];
    const chip = document.createElement('div');
    chip.className = 'csc-uploader';

    if (loaded) {
      chip.innerHTML = `
        <span class="csc-sat-dot" style="color:${sat.color}">●</span>
        <span class="csc-sat-name">${sat.name || sat.noradId}</span>
        <span class="csc-uploaded">${loaded.passes.length} passes</span>
        <button class="csc-clear-btn" data-satid="${satId}" title="Remove staplan">✕</button>
      `;
    } else {
      // Use a visually-hidden input (not display:none) so the label click works in all browsers
      chip.innerHTML = `
        <span class="csc-sat-dot" style="color:${sat.color}">●</span>
        <span class="csc-sat-name">${sat.name || sat.noradId}</span>
        <label class="csc-upload-btn">
          Upload staplan
          <input type="file" class="csc-file-input" accept=".txt,.csv,.tsv,.log,.xlsx,.xls,.ods" data-satid="${satId}">
        </label>
      `;
    }
    el.appendChild(chip);
  }

  el.querySelectorAll('.csc-file-input').forEach(inp => {
    inp.addEventListener('change', e => {
      if (!e.target.files[0]) return;
      loadFile(e.target.files[0], e.target.dataset.satid);
    });
  });

  el.querySelectorAll('.csc-clear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      delete staplans[btn.dataset.satid];
      renderAll();
    });
  });
}

// ── Render: all passes table ──────────────────────────────────────

function renderPassTable() {
  const tbody = document.getElementById('csc-pass-table');
  if (!tbody) return;
  const passes = allPasses();

  if (passes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="csc-empty">No passes loaded — upload a staplan above.</td></tr>';
    return;
  }

  tbody.innerHTML = passes.map(p => `
    <tr class="csc-pass-row${p.selected ? ' selected' : ''}">
      <td>${p.satName}</td>
      <td>${abbrev(p.station)}</td>
      <td class="mono">${fmtDate(p.aos0)}</td>
      <td class="mono">${fmtDate(p.aos5)}</td>
      <td class="mono">${fmtDate(p.los5)}</td>
      <td class="mono">${fmtDate(p.los0)}</td>
      <td class="mono">${fmtDur(p.aos5, p.los5)}</td>
      <td>
        <div class="eclipse-actions-cell">
          ${eclipseBar(p.eclipse, p)}
          <span class="eclipse-val">${p.eclipse !== null ? p.eclipse.toFixed(2) : '—'}</span>
        </div>
      </td>
      <td>
        <label class="csc-toggle" title="${p.selected ? 'Selected — click to deselect' : 'Not selected — click to select'}">
          <input type="checkbox" class="csc-toggle-input" data-id="${p.id}"${p.selected ? ' checked' : ''}>
          <span class="csc-toggle-track"><span class="csc-toggle-thumb"></span></span>
        </label>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.csc-toggle-input').forEach(cb => {
    cb.addEventListener('change', () => setSelected(cb.dataset.id, cb.checked));
  });
}

function setSelected(id, value) {
  const p = findPass(id);
  if (p) p.selected = value;
  renderPassTable();
  renderTimetable();
}

// ── Render: desired timetable ─────────────────────────────────────

function renderTimetable() {
  const tbody = document.getElementById('csc-timetable');
  if (!tbody) return;
  const selected = allPasses().filter(p => p.selected);

  if (selected.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="csc-empty">No passes selected — click Yes on the passes above.</td></tr>';
    return;
  }

  const passCountBySat = {};
  tbody.innerHTML = selected.map(p => {
    passCountBySat[p.satName] = (passCountBySat[p.satName] || 0) + 1;
    const passNum = passCountBySat[p.satName];
    return `
    <tr>
      <td class="pass-num">#${passNum}</td>
      <td>${p.satName}</td>
      <td>${abbrev(p.station)}</td>
      <td class="mono">${fmtDate(p.aos0)}</td>
      <td class="mono">${fmtDate(p.aos5)}</td>
      <td class="mono">${fmtDate(p.los5)}</td>
      <td class="mono">${fmtDate(p.los0)}</td>
      <td class="mono">${fmtDur(p.aos5, p.los5)}</td>
      <td class="eclipse-cell">${eclipseBar(p.eclipse, p)}</td>
    </tr>`;
  }).join('');
}

// ── Copy timetable to clipboard (TSV for Excel) ───────────────────

function copyTimetable() {
  const selected = allPasses().filter(p => p.selected);
  if (selected.length === 0) return;

  const headers = ['Pass #', 'Sat.', 'Station', 'AOS (0°)', 'AOS (5°)', 'LOS (5°)', 'LOS (0°)', '5-5 Duration', 'Eclipse'];
  const passCountBySat = {};
  const rows = selected.map(p => {
    passCountBySat[p.satName] = (passCountBySat[p.satName] || 0) + 1;
    return [
      `#${passCountBySat[p.satName]}`,
      p.satName,
      abbrev(p.station),
      fmtDate(p.aos0),
      fmtDate(p.aos5),
      fmtDate(p.los5),
      fmtDate(p.los0),
      fmtDur(p.aos5, p.los5),
      p.eclipse ?? '',
    ];
  });

  const tsv = [headers, ...rows].map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    const btn = document.getElementById('csc-copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
  });
}

// ── Download staplan ──────────────────────────────────────────────

function downloadStaplan() {
  const entries = Object.values(staplans);
  if (entries.length === 0) return;

  for (const { satName, passes } of entries) {
    const events = [];
    for (const p of passes) {
      const status = p.selected ? 'BOOKED' : 'UNUSED';
      if (p.aos0) events.push({ t: p.aos0, ev: 'AOS_0', st: p.station, status });
      if (p.aos5) events.push({ t: p.aos5, ev: 'AOS_5', st: p.station, status });
      if (p.los5) events.push({ t: p.los5, ev: 'LOS_5', st: p.station, status });
      if (p.los0) events.push({ t: p.los0, ev: 'LOS_0', st: p.station, status });
    }
    if (events.length === 0) continue;
    events.sort((a, b) => a.t - b.t);
    const tsv = events.map(e => {
      const ts = e.t.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
      return `${ts}\t${e.ev}\t${e.st}\t${e.status}`;
    }).join('\n');
    const safeName = satName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const blob = new Blob([tsv], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `staplan_${safeName}.txt`; a.click();
    URL.revokeObjectURL(url);
  }
}

// ── Full re-render ────────────────────────────────────────────────

function renderAll() {
  renderSatUploaders();
  renderPassTable();
  renderTimetable();
}
