import { store }                              from '../store.js';
import { propagate }                          from '../tle.js';
import { sunDirectionECI, isInEclipse }       from '../sunVector.js';
import { getPingIntervalSec, getPingElapsedSec, getLastPingMs, satBaseUrl } from '../satPing.js';

const _grafanaUrl = ip => ip
  ? `http://${ip.replace(/\.\d+$/, '.5')}:3000/?orgId=1&from=now-6h&to=now&timezone=browser`
  : null;

// ── Constants ─────────────────────────────────────────────────────

const PROCEDURES = [
  'OPS_ROUTINE_NOMINAL', 'OPS_HEALTH_CHECK', 'OPS_STATUS_REPORT',
  'MIS_SOAP_MISSION', 'MIS_IMAGING_SESSION', 'MIS_DOWNLINK_PAYLOAD',
  'FSW_DOWNLOAD_DIAG_PS', 'FSW_PATCH_UPLOAD', 'FSW_PARAMETER_UPDATE',
  'TTC_BEACON_CHECK', 'TTC_RANGING_SESSION',
  'ADCS_MANEUVER_EXEC', 'ADCS_POINTING_VERIFY',
  'EPS_BATTERY_CONDITIONING',
];
const STATIONS = ['TRO', 'SVB', 'KIR', 'KST', 'AWS'];

const MU  = 398600.4418;
const R_E = 6371;
const DEG = 180 / Math.PI;

// ── Dummy data ────────────────────────────────────────────────────

const _dummyCache = new Map();

function _seededRng(seed) {
  let s = (seed | 0) ^ 0xdeadbeef;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function _hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h;
}

function _generateDummy(sat) {
  const rng = _seededRng(_hashStr(sat.id));
  const now = Date.now();

  const lastContactMs = now - Math.floor(rng() * 600000);          // 0–10 min ago
  const modeSafety    = rng() > 0.15 ? 'NOMINAL' : 'SAFE';
  const modeMission   = `MK${Math.floor(rng() * 5) + 1}`;

  // Past passes: oldest first, spaced 2–5 h (17 passes, start ~80h back)
  const passes = [];
  let t = now - 80 * 3600000;
  for (let i = 0; i < 17; i++) {
    t += Math.floor(rng() * 3 * 3600000 + 2 * 3600000);
    const success  = rng() > 0.25;
    const numProcs = Math.floor(rng() * 3) + 1;
    const procs    = [];
    for (let p = 0; p < numProcs; p++) {
      procs.push({
        name:    PROCEDURES[Math.floor(rng() * PROCEDURES.length)],
        success: rng() > (success ? 0.1 : 0.5),
      });
    }
    const dur = Math.floor(rng() * 600000 + 300000); // 5–15 min pass window
    passes.push({
      id: `${sat.id}-past-${i}`, time: new Date(t), aos0: new Date(t), los0: new Date(t + dur),
      station: STATIONS[Math.floor(rng() * STATIONS.length)],
      future: false, success, procedures: procs,
    });
  }
  // Future passes: nearest first, spaced 1–3 h
  const FUTURE_STATUSES = ['SCHEDULED', 'OPEN', 'PENDING_MISSION'];
  let futT = now + Math.floor(rng() * 3600000 + 3600000);
  for (let i = 0; i < 3; i++) {
    futT += Math.floor(rng() * 2 * 3600000 + 3600000);
    const futDur = Math.floor(rng() * 600000 + 300000); // 5–15 min pass window
    passes.push({
      id: `${sat.id}-future-${i}`, time: new Date(futT), aos0: new Date(futT), los0: new Date(futT + futDur),
      station: STATIONS[Math.floor(rng() * STATIONS.length)],
      future: true, success: null, procedures: [],
      status: FUTURE_STATUSES[Math.floor(rng() * 3)],
    });
  }

  return {
    lastContactMs,
    modeSafety,
    modeMission,
    passes,
    battery:      parseFloat((13.0 + rng() * 2.5).toFixed(1)),
    missionPlans: Math.floor(rng() * 8),
    groundAlerts: _genAlerts(rng),
    boardAlerts:  _genAlerts(rng),
    sccUrl:      null,   // to be provided per satellite
    grafanaUrl:  null,   // to be provided per satellite
  };
}

function _genAlerts(rng) {
  const n = Math.floor(rng() * 5);
  const SEVS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return Array.from({ length: n }, () => ({ severity: SEVS[Math.floor(rng() * 4)] }));
}

function _seedDummy(sat) {
  if (!_dummyCache.has(sat.id)) _dummyCache.set(sat.id, _generateDummy(sat));
  return _dummyCache.get(sat.id);
}

// ── TLE helpers ───────────────────────────────────────────────────

function _epochToDate(yr, days) {
  const year = yr < 57 ? 2000 + yr : 1900 + yr;
  const d = new Date(Date.UTC(year, 0, 1));
  d.setTime(d.getTime() + (days - 1) * 86400000);
  return d;
}

function _classifyOrbit(incDeg, a) {
  const alt = a - R_E;
  let regime = alt < 2000 ? 'LEO' : alt < 35286 ? 'MEO' : alt < 36286 ? 'GEO' : 'HEO';
  let sub = '';
  if (incDeg < 5 || incDeg > 175)                          sub = 'Equatorial';
  else if (regime === 'LEO' && incDeg > 95 && incDeg < 105) sub = 'SSO';
  else if (incDeg > 85 && incDeg < 95)                     sub = 'Polar';
  else if (incDeg > 80)                                    sub = 'Near-polar';
  return sub ? `${regime} · ${sub}` : regime;
}

// ── Monitoring status helpers ─────────────────────────────────────

const _MON_CLS = {
  NOMINAL:  '',
  WATCH:    'co-sev-low',
  WARNING:  'co-sev-med',
  DISTRESS: 'co-sev-high',
  CRITICAL: 'co-sev-crit',
  SEVERE:   'co-sev-crit',
};

function _monCls(status)     { return _MON_CLS[status] ?? ''; }
function _monPillCls(status) {
  if (!status || status === 'NOMINAL') return 'co-pill-nominal';
  if (status === 'WATCH' || status === 'WARNING') return 'co-pill-warn';
  return 'co-pill-crit';
}

// Real on-board event counts from TM
function _evtBadge(events) {
  if (!events) return '<span class="co-nil">—</span>';
  const slots = [
    { label: 'H', v: events.high },
    { label: 'M', v: events.med  },
    { label: 'L', v: events.low  },
    { label: 'N', v: events.normal },
  ].filter(s => s.v?.value != null && s.v.value > 0);
  if (!slots.length) return '<span class="co-nil">—</span>';
  return slots.map(s => {
    const cls = _monCls(s.v.status);
    return `<span class="co-alert-badge ${cls}">${s.v.value}${s.label}</span>`;
  }).join('');
}

// Fallback dummy alert badge (ground alerts, no real data yet)
const _SEV_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const _SEV_ABBR  = { LOW: 'L', MEDIUM: 'M', HIGH: 'H', CRITICAL: 'C' };
const _SEV_CLS   = { LOW: 'co-sev-low', MEDIUM: 'co-sev-med', HIGH: 'co-sev-high', CRITICAL: 'co-sev-crit' };

function _alertBadge(alerts) {
  if (!alerts.length) return '<span class="co-nil">—</span>';
  const counts = {};
  let worst = -1;
  for (const a of alerts) {
    counts[a.severity] = (counts[a.severity] || 0) + 1;
    if (_SEV_ORDER[a.severity] > worst) worst = _SEV_ORDER[a.severity];
  }
  const worstSev = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][worst];
  const parts = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
    .filter(s => counts[s])
    .map(s => `${counts[s]}${_SEV_ABBR[s]}`);
  return `<span class="co-alert-badge ${_SEV_CLS[worstSev]}">${parts.join(' ')}</span>`;
}

// ── External links ────────────────────────────────────────────────

function _linkBadge(label, url) {
  if (url) {
    return `<a href="${url}" target="_blank" rel="noopener" class="co-link">${label} ↗</a>`;
  }
  return `<span class="co-link co-link-tbd" title="URL not yet configured">${label} ↗</span>`;
}

// ── Pass dots ─────────────────────────────────────────────────────

const _STATUS_CLS = { SCHEDULED: 'co-dot-scheduled', OPEN: 'co-dot-open', PENDING_MISSION: 'co-dot-pending' };

function _passDots(passes) {
  const html = passes.map((p, i) => {
    if (p.future) {
      const cls = _STATUS_CLS[p.status] ?? 'co-dot-scheduled';
      return `<span class="co-dot co-dot-future ${cls}" data-idx="${i}">○</span>`;
    }
    const cls = p.success ? 'co-dot-success' : 'co-dot-fail';
    return `<span class="co-dot ${cls}" data-idx="${i}">●</span>`;
  }).join('');
  return `<div class="co-dots-grid">${html}</div>`;
}

function _fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function _tooltipContent(pass) {
  const durStr = pass.aos0 && pass.los0 ? ` · ${_fmtDuration(pass.los0 - pass.aos0)}` : '';
  const hdr = `<div class="co-tt-header">${pass.station} · ${_fmtDateTimeShort(pass.time)}${durStr}</div>`;
  if (pass.future) {
    const label = (pass.status ?? 'SCHEDULED').replace('_', ' ');
    const cls   = _STATUS_CLS[pass.status] ?? 'co-dot-scheduled';
    return hdr + `<div class="co-tt-future-status ${cls}">○ ${label}</div>`;
  }
  const res = pass.success
    ? '<div class="co-tt-result co-tt-ok">● Pass succeeded</div>'
    : '<div class="co-tt-result co-tt-fail">✗ Pass failed</div>';
  const procs = pass.procedures.map(pr =>
    `<div class="co-tt-proc ${pr.success ? 'co-tt-ok' : 'co-tt-fail'}">${pr.success ? '●' : '✗'} ${pr.name}</div>`
  ).join('');
  return hdr + res + (procs ? `<div class="co-tt-procs">${procs}</div>` : '');
}

// ── Ping cell ────────────────────────────────────────────────────

function _buildPingCell(satId) {
  const ps   = store.pingStatus[satId] ?? 'unconfigured';
  const per  = getPingIntervalSec();
  const ela  = getPingElapsedSec(satId).toFixed(1);
  const pcls = ps === 'ok' ? 'co-ping-ok' : ps === 'unconfigured' ? 'co-ping-none' : 'co-ping-err';
  const dot  = `<span class="co-ping-dot ${pcls}" style="--ping-period:${per}s;--ping-delay:-${ela}s"></span>`;

  const isErr = ps === 'error' || ps === 'timeout';
  if (!isErr) return dot;

  const lastMs  = getLastPingMs(satId);
  const agoStr  = lastMs ? _fmtAgo(Date.now() - lastMs) : '—';
  const timeStr = lastMs
    ? new Date(lastMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  return `${dot}
    <div class="co-ping-detail">
      <span class="co-ping-detail-ago">${agoStr}</span>
      <span class="co-ping-detail-time">${timeStr}</span>
    </div>`;
}

// ── Row HTML ──────────────────────────────────────────────────────

function _rowHTML(sat, d, now, eclipse) {
  // Prefer real telemetry; fall back to seeded dummy data
  const tm = store.satTelemetry[sat.id] ?? null;

  const lastContactMs = tm?.receptionTime ? new Date(tm.receptionTime).getTime() : d.lastContactMs;
  const elapsed = now - lastContactMs;
  const isLive  = elapsed < 20000;

  const nextPass  = d.passes.find(p => p.future);
  const nextMs    = nextPass ? nextPass.time.getTime() - now : null;

  const lastLine = isLive
    ? '<span class="co-live-badge">● LIVE</span>'
    : `<span class="co-contact-time">${_fmtAgo(elapsed)}</span>`;
  const nextLine = nextMs !== null
    ? `<span class="co-next-contact">Next ${_fmtIn(nextMs)}</span>`
    : '<span class="co-next-contact co-nil">—</span>';
  const contactCell = `<div class="co-contact-stack">${lastLine}${nextLine}</div>`;

  const sysVal  = tm?.sysMode?.value  ?? d.modeSafety;
  const sysSts  = tm?.sysMode?.status ?? 'NOMINAL';
  const gncVal  = tm?.gncMode?.value  ?? d.modeMission;
  const gncSts  = tm?.gncMode?.status ?? 'NOMINAL';
  const safetyPill  = `<span class="co-pill ${_monPillCls(sysSts)}">${sysVal}</span>`;
  const missionPill = `<span class="co-pill ${_monPillCls(gncSts)}">${gncVal}</span>`;
  const modeCell    = `<div class="co-mode-stack">
    <div class="co-mode-row"><span class="co-mode-label">SYS</span>${safetyPill}</div>
    <div class="co-mode-row"><span class="co-mode-label">GNC</span>${missionPill}</div>
  </div>`;

  let eclHtml;
  if (eclipse === null)  eclHtml = '<span data-field="ecl" class="co-nil">—</span>';
  else if (eclipse)      eclHtml = '<span data-field="ecl" class="co-ecl-shadow">● SHADOW</span>';
  else                   eclHtml = '<span data-field="ecl" class="co-ecl-sun">☀ SUN</span>';

  const battVal = tm?.battVoltage?.value ?? d.battery;
  const battSts = tm?.battVoltage?.status ?? 'NOMINAL';
  const _BATT_CLS = { NOMINAL: 'co-batt-ok', WATCH: 'co-batt-warn', WARNING: 'co-batt-warn', DISTRESS: 'co-batt-low', CRITICAL: 'co-batt-low', SEVERE: 'co-batt-low' };
  const battCls  = _BATT_CLS[battSts] ?? 'co-batt-ok';
  const battCell = `<span class="${battCls}" title="${battSts}">${Number(battVal).toFixed(1)} V</span>`;

  const missionCell = d.missionPlans > 0
    ? `<span class="co-mission-count">${d.missionPlans}</span>`
    : '<span class="co-nil">—</span>';

  // Eclipse + Altitude + TLE freshness cell
  let altHtml  = '<span class="co-nil">—</span>';
  let tleHtml  = '<span class="co-nil">—</span>';
  if (sat.satrec) {
    const sr        = sat.satrec;
    const n         = sr.no;
    const periodMin = (2 * Math.PI / n);
    const a         = Math.cbrt(MU * ((periodMin * 60) / (2 * Math.PI)) ** 2);
    const altKm     = (a - R_E).toFixed(0);
    altHtml = `<span class="co-alt-val">${altKm} km</span>`;

    const epochDate = _epochToDate(sr.epochyr, sr.epochdays);
    const ageDays   = (now - epochDate.getTime()) / 86400000;
    const ageCls    = ageDays > 7 ? 'co-tle-stale' : ageDays > 3 ? 'co-tle-old' : 'co-tle-fresh';
    const ageIcon   = ageDays > 7 ? '⚠' : ageDays > 3 ? '~' : '✓';
    tleHtml = `<span class="co-tle-age ${ageCls}">${ageDays.toFixed(1)}d ${ageIcon}</span>`;
  }
  const orbitCell = `<div class="co-orbit-stack co-eclipse-nav" data-sat-id="${sat.id}">
    <div class="co-orbit-row"><span class="co-orbit-label">ECL</span>${eclHtml}</div>
    <div class="co-orbit-row"><span class="co-orbit-label">ALT</span>${altHtml}</div>
    <div class="co-orbit-row"><span class="co-orbit-label">TLE</span>${tleHtml}</div>
  </div>`;

  return `<tr class="co-row" data-sat-id="${sat.id}">
    <td class="co-name-cell">${sat.name}</td>
    <td class="co-ping-cell" data-field="ping-cell">${_buildPingCell(sat.id)}</td>
    <td class="co-contact-cell">${contactCell}</td>
    <td class="co-mode-cell">${modeCell}</td>
    <td class="co-batt-cell">${battCell}</td>
    <td class="co-passes-cell" data-sat-id="${sat.id}">${_passDots(d.passes)}</td>
    <td>${orbitCell}</td>
    <td class="co-alerts-cell">${_alertBadge(d.groundAlerts)}</td>
    <td class="co-alerts-cell">${_evtBadge(tm?.events)}</td>
    <td class="co-links-cell">${_linkBadge('SCC', satBaseUrl(sat.noradId) ? `http://${satBaseUrl(sat.noradId)}:15000/` : null)}${_linkBadge('Grafana', _grafanaUrl(satBaseUrl(sat.noradId)))}</td>
  </tr>`;
}

// ── Tooltip positioning ───────────────────────────────────────────

function _positionTooltip(e, el) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const w = el.offsetWidth  || 230;
  const h = el.offsetHeight || 120;
  if (x + w > window.innerWidth  - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

// ── Init ──────────────────────────────────────────────────────────

export function initChadOps() {
  const tbody = document.getElementById('co-tbody');
  if (!tbody) return;

  const tooltip = document.createElement('div');
  tooltip.className   = 'co-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  let _active = false;
  let _timer  = null;

  // Legend tooltip on passes column header
  const LEGEND_HTML = `
    <div class="co-legend-title">Past passes (7)</div>
    <div class="co-legend-row"><span class="co-dot co-dot-success">●</span> Pass succeeded</div>
    <div class="co-legend-row"><span class="co-dot co-dot-fail">●</span> Pass failed</div>
    <div class="co-legend-title co-legend-gap">Upcoming passes</div>
    <div class="co-legend-row"><span class="co-dot co-dot-future co-dot-scheduled">○</span> Scheduled</div>
    <div class="co-legend-row"><span class="co-dot co-dot-future co-dot-open">○</span> Open</div>
    <div class="co-legend-row"><span class="co-dot co-dot-future co-dot-pending">○</span> Pending Mission</div>`;

  const passesHeader = document.getElementById('co-passes-th');
  if (passesHeader) {
    passesHeader.addEventListener('mouseenter', e => {
      tooltip.innerHTML     = LEGEND_HTML;
      tooltip.style.display = 'block';
      _positionTooltip(e, tooltip);
    });
    passesHeader.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
    passesHeader.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  }

  function _wireDots() {
    tbody.querySelectorAll('.co-dot[data-idx]').forEach(dot => {
      const satId = dot.closest('[data-sat-id]')?.dataset.satId;
      const idx   = parseInt(dot.dataset.idx, 10);
      dot.addEventListener('mouseenter', e => {
        const sat  = store.satellites.find(s => s.id === satId);
        if (!sat) return;
        const pass = _seedDummy(sat).passes[idx];
        if (!pass) return;
        tooltip.innerHTML     = _tooltipContent(pass);
        tooltip.style.display = 'block';
        _positionTooltip(e, tooltip);
      });
      dot.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
      dot.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
      dot.addEventListener('click', () => {
        const sat  = store.satellites.find(s => s.id === satId);
        if (!sat) return;
        const pass = _seedDummy(sat).passes[idx];
        if (!pass?.aos0 || !pass?.los0) return;
        const ip = satBaseUrl(sat.noradId);
        if (!ip) return;
        const host = ip.replace(/\.\d+$/, '.5');
        const from = pass.aos0.toISOString();
        const to   = pass.los0.toISOString();
        window.open(
          `http://${host}:3000/a/grafana-lokiexplore-app/explore/service/-scc/logs` +
          `?patterns=%5B%5D&from=${from}&to=${to}` +
          `&var-lineFormat=&var-ds=P8E80F9AEF21F6940` +
          `&var-filters=service_name%7C%3D%7C%2Fscc` +
          `&var-fields=&var-levels=&var-metadata=&var-jsonFields=` +
          `&var-patterns=&var-lineFilterV2=&var-lineFilters=` +
          `&timezone=browser&var-all-fields=&userDisplayedFields=false` +
          `&displayedFields=%5B%5D&urlColumns=%5B%5D` +
          `&visualizationType=%22logs%22&prettifyLogMessage=false` +
          `&sortOrder=%22Descending%22&wrapLogMessage=false`,
          '_blank', 'noopener',
        );
      });
    });

    // Eclipse cell → Orbit Inspector navigation
    tbody.querySelectorAll('.co-eclipse-nav').forEach(cell => {
      cell.addEventListener('click', () => {
        const satId = cell.dataset.satId;
        document.querySelector('[data-tab="tools"]')?.click();
        document.querySelector('[data-subtab="orbit"]')?.click();
        const sel = document.getElementById('oi-sat-select');
        if (sel) { sel.value = satId; sel.dispatchEvent(new Event('change')); }
      });
    });
  }

  function render() {
    const now     = Date.now();
    const nowDate = new Date(now);
    const sunDir  = sunDirectionECI(nowDate);

    if (!store.satellites.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="co-empty">No satellites loaded — add one to begin.</td></tr>`;
      return;
    }

    tbody.innerHTML = store.satellites.map(sat => {
      const d = _seedDummy(sat);
      let eclipse = null;
      if (sat.satrec) {
        const r = propagate(sat.satrec, nowDate);
        if (r?.eciPos) eclipse = isInEclipse(r.eciPos, sunDir);
      }
      return _rowHTML(sat, d, now, eclipse);
    }).join('');

    _wireDots();
  }

  // Lightweight tick: only patches contact-time and eclipse in-place — no DOM rebuild
  function _tick() {
    const now     = Date.now();
    const nowDate = new Date(now);
    const sunDir  = sunDirectionECI(nowDate);

    for (const sat of store.satellites) {
      const row = tbody.querySelector(`tr[data-sat-id="${sat.id}"]`);
      if (!row) { render(); return; } // satellite added since last full render

      const d  = _seedDummy(sat);
      const tm = store.satTelemetry[sat.id] ?? null;

      // Contact time (changes every tick)
      const contactEl = row.querySelector('.co-contact-stack');
      if (contactEl) {
        const lastMs   = tm?.receptionTime ? new Date(tm.receptionTime).getTime() : d.lastContactMs;
        const elapsed  = now - lastMs;
        const isLive   = elapsed < 20000;
        const nextPass = d.passes.find(p => p.future);
        const nextMs   = nextPass ? nextPass.time.getTime() - now : null;
        const lastLine = isLive
          ? '<span class="co-live-badge">● LIVE</span>'
          : `<span class="co-contact-time">${_fmtAgo(elapsed)}</span>`;
        const nextLine = nextMs !== null
          ? `<span class="co-next-contact">Next ${_fmtIn(nextMs)}</span>`
          : '<span class="co-next-contact co-nil">—</span>';
        contactEl.innerHTML = lastLine + nextLine;
      }

      // Eclipse status (changes ~every 45 min but cheap to re-check)
      const eclEl = row.querySelector('[data-field="ecl"]');
      if (eclEl && sat.satrec) {
        const r       = propagate(sat.satrec, nowDate);
        const eclipse = r?.eciPos ? isInEclipse(r.eciPos, sunDir) : null;
        if (eclipse === null) { eclEl.className = 'co-nil';        eclEl.textContent = '—'; }
        else if (eclipse)     { eclEl.className = 'co-ecl-shadow'; eclEl.textContent = '● SHADOW'; }
        else                  { eclEl.className = 'co-ecl-sun';    eclEl.textContent = '☀ SUN'; }
      }

    }
  }

  function _updatePingDots() {
    for (const sat of store.satellites) {
      const row  = tbody.querySelector(`tr[data-sat-id="${sat.id}"]`);
      const cell = row?.querySelector('[data-field="ping-cell"]');
      if (cell) cell.innerHTML = _buildPingCell(sat.id);
    }
  }

  let _agoTimer = null;

  function _tickAgo() {
    tbody.querySelectorAll('.co-ping-detail').forEach(detail => {
      const row    = detail.closest('tr');
      const satId  = row?.dataset.satId;
      const lastMs = satId ? getLastPingMs(satId) : null;
      if (!lastMs) return;
      const agoEl = detail.querySelector('.co-ping-detail-ago');
      if (agoEl) agoEl.textContent = _fmtAgo(Date.now() - lastMs);
    });
  }

  function start() {
    _active   = true;
    render();
    _timer    = setInterval(_tick,    10000);
    _agoTimer = setInterval(_tickAgo, 1000);
  }
  function stop() {
    _active = false;
    if (_timer)    { clearInterval(_timer);    _timer    = null; }
    if (_agoTimer) { clearInterval(_agoTimer); _agoTimer = null; }
    tooltip.style.display = 'none';
  }

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'chadops') start();
      else stop();
    });
  });
  document.querySelectorAll('[data-cosubtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.cosubtab === 'fleet') start();
      else stop();
    });
  });

  store.subscribe(key => {
    if ((key === 'satellites' || key === 'satTelemetry') && _active) render();
    if (key === 'pingStatus'  && _active) _updatePingDots();
  });
}

// ── Formatting helpers ────────────────────────────────────────────

function _fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function _fmtDateTimeShort(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function _fmtIn(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `in ${m}m`;
  return `in ${h}h ${m < 10 ? '0' : ''}${m}m`;
}
