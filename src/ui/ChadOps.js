import { store }                              from '../store.js';
import { propagate }                          from '../tle.js';
import { sunDirectionECI, isInEclipse }       from '../sunVector.js';
import { fetchPassGsCoords, buildPolarSVG }    from './passPolar.js';
import { getPingIntervalSec, getPingElapsedSec, getLastPingMs, satBaseUrl, pingSatellite } from '../satPing.js';

// URL builders — subnet routing: .1=SCC, .3=GNM, .5=FDS
const _grafanaUrl   = ip => ip
  ? `http://${ip.replace(/\.\d+$/, '.5')}:3000/?orgId=1&from=now-6h&to=now&timezone=browser`
  : null;
const _dashboardUrl = ip => ip ? `http://${ip}/` : null;
const _gnmUrl       = ip => ip ? `http://${ip.replace(/\.\d+$/, '.3')}:15602/` : null;

// Read a URL override saved by the component links modal; fall back to computed value
function _satLink(noradId, key, fallback) {
  try { return JSON.parse(localStorage.getItem(`sat-links-${noradId}`) ?? '{}')[key] || fallback; }
  catch { return fallback; }
}

// ── Constants ─────────────────────────────────────────────────────

const MU  = 398600.4418;
const R_E = 6371;
const DEG = 180 / Math.PI;

// ── TLE helpers ───────────────────────────────────────────────────

function _epochToDate(yr, days) {
  const year = yr < 57 ? 2000 + yr : 1900 + yr;
  const d = new Date(Date.UTC(year, 0, 1));
  d.setTime(d.getTime() + (days - 1) * 86400000);
  return d;
}

function _tleAgeLabel(ageDays) {
  const cls  = ageDays > 7 ? 'co-tle-stale' : ageDays > 3 ? 'co-tle-old' : 'co-tle-fresh';
  const icon = ageDays > 7 ? '⚠' : ageDays > 3 ? '~' : '✓';
  const age  = ageDays < 1
    ? `${(ageDays * 24).toFixed(1)}h`
    : `${ageDays.toFixed(1)}d`;
  return { cls, icon, age };
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
  const rows = [
    { label: 'HIGH', v: events.high   },
    { label: 'MED',  v: events.med    },
    { label: 'LOW',  v: events.low    },
    { label: 'NOM',  v: events.normal },
  ];
  return `<div class="co-evt-stack">${rows.map(r => {
    const val = r.v?.value ?? null;
    const cls = r.v?.status ? _monPillCls(r.v.status) : '';
    const valHtml = val != null
      ? `<span class="co-pill ${cls}">${val}</span>`
      : '<span class="co-nil">—</span>';
    return `<div class="co-mode-row"><span class="co-mode-label">${r.label}</span>${valHtml}</div>`;
  }).join('')}</div>`;
}

// ── External links ────────────────────────────────────────────────

function _linkBadge(label, url) {
  if (url) {
    return `<a href="${url}" target="_blank" rel="noopener" class="co-link">${label} ↗</a>`;
  }
  return `<span class="co-link co-link-tbd" title="URL not yet configured">${label} ↗</span>`;
}

// ── Pass dots ─────────────────────────────────────────────────────

const _OUTCOME_CLS = { SUCCESS: 'co-dot-success', FAILURE: 'co-dot-fail', CANCELLED: 'co-dot-cancelled' };

function _passDots(passes) {
  if (!passes?.length) return '<span class="co-nil">—</span>';
  const html = passes.map((p, i) => {
    let cls, ch;
    if (p.future) {
      cls = 'co-dot-future'; ch = '○';
    } else {
      cls = _OUTCOME_CLS[p.outcome] ?? 'co-dot-success'; ch = '●';
    }
    return `<span class="co-dot ${cls}" data-idx="${i}">${ch}</span>`;
  }).join('');
  return `<div class="co-dots-grid">${html}</div>`;
}

function _fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function _battMonTooltip(mon) {
  const _SEV_ORDER = ['watchRange','warningRange','distressRange','severeRange','criticalRange'];
  const _COND_ORDER = ['criticalCondition','severeCondition','distressCondition','warningCondition','watchCondition','nominalCondition'];
  const _fmtBound = (v, inclusive, side) => {
    if (v == null) return '';
    return side === 'min' ? `${inclusive ? '≥' : '>'}${v}` : `${inclusive ? '≤' : '<'}${v}`;
  };
  let rows = '';
  const ranges = _SEV_ORDER.map(k => mon[k]).filter(Boolean);
  if (ranges.length) {
    rows = '<div class="co-tt-header">Ground Monitorings</div>';
    rows += '<div class="co-batt-mon-note">Outside band → alarm triggers</div>';
    rows += '<div class="co-batt-mon-note">SoC estimate valid between 20% and 90%</div>';
    for (const r of ranges) {
      const lo = _fmtBound(r.minInclusive ?? r.minExclusive, r.minInclusive != null, 'min');
      const hi = _fmtBound(r.maxInclusive ?? r.maxExclusive, r.maxInclusive != null, 'max');
      const band = [lo, hi].filter(Boolean).join(' – ');
      rows += `<div class="co-batt-mon-row"><span class="co-batt-mon-lvl co-mon-${r.criticality?.toLowerCase()}">${r.criticality}</span><span class="co-batt-mon-band">${band}</span></div>`;
    }
  } else {
    const conds = _COND_ORDER.map(k => mon[k]).filter(Boolean);
    if (conds.length) {
      rows = '<div class="co-tt-header">Enum conditions</div>';
      for (const c of conds) {
        rows += `<div class="co-batt-mon-row"><span class="co-batt-mon-lvl co-mon-${c.criticality?.toLowerCase()}">${c.criticality}</span><span class="co-batt-mon-band">${c.condition}</span></div>`;
      }
    }
  }
  return rows || '<div class="co-nil">No monitoring defined</div>';
}

const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };
const _PROC_CH  = { SUCCESS: '●', FAILURE: '✗', CANCELLED: '◌' };

function _grafanaLokiUrl(grafanaHost, fromMs, toMs) {
  return `http://${grafanaHost}:3000/a/grafana-lokiexplore-app/explore/service/-scc/logs`
    + `?patterns=%5B%5D&from=${fromMs}&to=${toMs}`
    + `&var-lineFormat=&var-ds=P8E80F9AEF21F6940`
    + `&var-filters=service_name%7C%3D%7C%2Fscc`
    + `&var-fields=&var-levels=&var-metadata=&var-jsonFields=`
    + `&var-patterns=&var-lineFilterV2=&var-lineFilters=`
    + `&timezone=browser&var-all-fields=&userDisplayedFields=false`
    + `&displayedFields=%5B%5D&urlColumns=%5B%5D`
    + `&visualizationType=%22logs%22&prettifyLogMessage=false`
    + `&sortOrder=%22Descending%22&wrapLogMessage=false`;
}

function _passEclipseBar(satrec, start, end) {
  if (!satrec || !start || !end) return '';
  const STEP = 30_000; // 30s samples
  let shadow = 0, sun = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += STEP) {
    const d = new Date(t);
    const r = propagate(satrec, d);
    if (!r?.eciPos) continue;
    if (isInEclipse(r.eciPos, sunDirectionECI(d))) shadow++; else sun++;
  }
  const total = shadow + sun;
  if (!total) return '';
  const eclPct = Math.round((shadow / total) * 100);
  const sunPct = 100 - eclPct;
  const fmtMin = m => `${m}m`;
  const durMin = Math.round((end - start) / 60_000);
  const eclMin = Math.round(shadow / total * durMin);
  const sunMin = durMin - eclMin;
  return `
    <div class="co-tt-ecl-bar">
      <div class="oi-eclipse-bar">
        <div class="oi-eclipse-seg oi-seg-shadow" style="width:${eclPct}%">${eclPct > 15 ? fmtMin(eclMin) : ''}</div>
        <div class="oi-eclipse-seg oi-seg-sun"    style="width:${sunPct}%">${sunPct > 15 ? fmtMin(sunMin) : ''}</div>
      </div>
      <div class="oi-eclipse-legend">
        <span class="oi-ecl-shadow">● ${eclPct}% shadow</span>
        <span class="oi-ecl-sun">☀ ${sunPct}% sun</span>
      </div>
    </div>`;
}

function _tooltipContent(pass, grafanaHost, sat) {
  const dur = pass.end && pass.start ? ` · ${_fmtDuration(pass.end - pass.start)}` : '';
  const hdr = `<div class="co-tt-header">${pass.station} · ${_fmtDateTimeShort(pass.start)}${dur}</div>`;
  const eclBar = _passEclipseBar(sat?.satrec, pass.start, pass.end);
  const slot = '<div class="polar-slot"></div>';
  if (pass.future) {
    return hdr + eclBar + `<div class="co-tt-future-status co-dot-future">○ SCHEDULED</div>` + slot;
  }
  if (!pass.procedures?.length) {
    return hdr + eclBar + `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>` + slot;
  }
  const procs = pass.procedures.map((pr, i) => {
    const cls     = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const num     = `<span class="co-tt-num">${i + 1}</span>`;
    const name    = `<span class="co-tt-pname">${pr.name}</span>`;
    const procDur = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${_fmtDuration(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost) {
      const url = _grafanaLokiUrl(grafanaHost, pr.startMs - 1000, pr.endMs + 1000);
      return `<a href="${url}" target="_blank" rel="noopener" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${procDur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}${procDur}</div>`;
  }).join('');
  return hdr + eclBar + `<div class="co-tt-sep"></div><div class="co-tt-procs">${procs}</div>` + slot;
}

// ── Ping cell ────────────────────────────────────────────────────

function _buildPingCell(satId) {
  const ps   = store.pingStatus[satId] ?? 'unconfigured';
  const per  = getPingIntervalSec();
  const ela  = getPingElapsedSec(satId).toFixed(1);
  const pcls = ps === 'ok' ? 'co-ping-ok' : ps === 'unconfigured' ? 'co-ping-none' : 'co-ping-err';
  const dot  = `<span class="co-ping-dot ${pcls}" style="--ping-period:${per}s;--ping-delay:-${ela}s" title="Click to force update"></span>`;

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

// ── Reaction wheel cell ───────────────────────────────────────────

function _rwOn(entry) {
  if (!entry || entry.value == null) return null; // unknown
  const v = entry.value;
  if (typeof v === 'string') return v.toUpperCase() === 'ON';
  return v === 1 || v === true;
}

function _rwCell(rw) {
  if (!rw) return '<span class="co-nil">—</span>';
  return `<div class="co-rw-grid">${[1,2,3,4].map((n, i) => {
    const on = _rwOn(rw[i]);
    const cls = on === null ? 'co-rw-unknown' : on ? 'co-rw-on' : 'co-rw-off';
    return `<span class="co-rw-num ${cls}">${n}</span>`;
  }).join('')}</div>`;
}

// ── Row HTML ──────────────────────────────────────────────────────

function _rowHTML(sat, now, eclipse) {
  const tm = store.satTelemetry[sat.id] ?? null;

  const lastContactMs = tm?.receptionTime ? new Date(tm.receptionTime).getTime() : null;
  const elapsed = lastContactMs !== null ? now - lastContactMs : null;
  const isLive  = elapsed !== null && elapsed < 20000;

  const lastLine = elapsed === null
    ? '<span class="co-nil">—</span>'
    : isLive
      ? '<span class="co-live-badge">● LIVE</span>'
      : `<span class="co-contact-time">${_fmtAgo(elapsed)}</span>`;
  const nextPass = (store.satPasses[sat.id] ?? []).find(p => p.future);
  const nextLine = nextPass
    ? `<span class="co-next-contact">Next ${_fmtIn(nextPass.start - now)}</span>`
    : '<span class="co-next-contact co-nil">—</span>';
  const contactCell = `<div class="co-contact-stack">${lastLine}${nextLine}</div>`;

  const sysVal  = tm?.sysMode?.value  ?? null;
  const sysSts  = tm?.sysMode?.status ?? 'NOMINAL';
  const gncVal  = tm?.gncMode?.value  ?? null;
  const gncSts  = tm?.gncMode?.status ?? 'NOMINAL';
  const safetyPill  = sysVal ? `<span class="co-pill ${_monPillCls(sysSts)}">${sysVal}</span>` : '<span class="co-nil">—</span>';
  const missionPill = gncVal ? `<span class="co-pill ${_monPillCls(gncSts)}">${gncVal}</span>` : '<span class="co-nil">—</span>';
  const uptimeRaw = tm?.uptime?.value ?? null;
  const uptimeHtml = uptimeRaw != null
    ? `<span class="co-uptime">${_fmtUptime(uptimeRaw)} <span class="co-uptime-raw">${uptimeRaw}</span></span>`
    : '<span class="co-nil">—</span>';
  const modeCell    = `<div class="co-mode-stack">
    <div class="co-mode-row"><span class="co-mode-label">SYS</span>${safetyPill}</div>
    <div class="co-mode-row"><span class="co-mode-label">GNC</span>${missionPill}</div>
    <div class="co-mode-row"><span class="co-mode-label">UP</span>${uptimeHtml}</div>
  </div>`;

  let eclHtml;
  if (eclipse === null)  eclHtml = '<span data-field="ecl" class="co-nil">—</span>';
  else if (eclipse)      eclHtml = '<span data-field="ecl" class="co-ecl-shadow">● SHADOW</span>';
  else                   eclHtml = '<span data-field="ecl" class="co-ecl-sun">☀ SUN</span>';

  const battVal  = tm?.battVoltage?.value      ?? null;
  const battSts  = tm?.battVoltage?.status     ?? 'NOMINAL';
  const battMon  = tm?.battVoltage?.monitoring ?? null;
  const battSoc  = tm?.battSoc?.value          ?? null;
  const _BATT_CLS = { NOMINAL: 'co-batt-ok', WATCH: 'co-batt-watch', WARNING: 'co-batt-warn', DISTRESS: 'co-batt-dist', SEVERE: 'co-batt-low', CRITICAL: 'co-batt-low' };
  const battCls  = _BATT_CLS[battSts] ?? 'co-batt-ok';
  const battMonAttr = battMon ? ` data-batt-mon='${JSON.stringify(battMon)}'` : '';
  const socHtml  = battSoc != null ? `<span class="co-soc" title="SoC estimate — valid between 20% and 90%">${battSoc}%</span>` : '';
  const battCell = battVal != null
    ? `<span class="${battCls} co-batt-hover"${battMonAttr}>${Number(battVal).toFixed(1)} V${socHtml}</span>`
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
    const { cls: ageCls, icon: ageIcon, age } = _tleAgeLabel(ageDays);
    tleHtml = `<span class="co-tle-age ${ageCls}">${age} ${ageIcon}</span>`;
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
    <td class="co-rw-cell">${_rwCell(tm?.rw)}</td>
    <td class="co-passes-cell" data-sat-id="${sat.id}">${_passDots(store.satPasses[sat.id])}</td>
    <td>${orbitCell}</td>
    <td class="co-alerts-cell"><span class="co-nil">—</span></td>
    <td class="co-alerts-cell">${_evtBadge(tm?.events)}</td>
    <td class="co-links-cell">${(() => {
      const ip = satBaseUrl(sat.noradId);
      return _linkBadge('SCC',      _satLink(sat.noradId, 'scc',     ip ? `http://${ip}:15000/` : null))
           + _linkBadge('Grafana',  _satLink(sat.noradId, 'grafana', _grafanaUrl(ip)))
           + _linkBadge('Dashboard',_dashboardUrl(ip))
           + _linkBadge('GNM',      _satLink(sat.noradId, 'gnm',     _gnmUrl(ip)));
    })()}</td>
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

  let _ttHideTimer = null;
  const _hideNow      = () => { clearTimeout(_ttHideTimer); tooltip.style.display = 'none'; };
  const _scheduleHide = () => { clearTimeout(_ttHideTimer); _ttHideTimer = setTimeout(_hideNow, 800); };
  const _cancelHide   = () => { clearTimeout(_ttHideTimer); };

  // Tooltip stays open while the mouse is inside it; hides 800ms after leaving
  tooltip.addEventListener('mouseenter', _cancelHide);
  tooltip.addEventListener('mouseleave', _scheduleHide);

  // Click anywhere outside the tooltip dismisses it immediately
  document.addEventListener('click', e => {
    if (tooltip.style.display !== 'none' && !tooltip.contains(e.target)) _hideNow();
  }, true);

  // Legend tooltip on passes column header
  const LEGEND_HTML = `
    <div class="co-legend-title">Pass horizon · ±7 days</div>
    <div class="co-legend-sub">Each dot is one pass. Grid reads left→right, oldest to newest. Refreshed every ping cycle.</div>
    <div class="co-legend-title co-legend-gap">Past</div>
    <div class="co-legend-row"><span class="co-dot co-dot-success">●</span> Success</div>
    <div class="co-legend-row"><span class="co-dot co-dot-fail">●</span> Failure</div>
    <div class="co-legend-row"><span class="co-dot co-dot-cancelled">●</span> Cancelled</div>
    <div class="co-legend-title co-legend-gap">Future</div>
    <div class="co-legend-row"><span class="co-dot co-dot-future">○</span> Upcoming (no outcome yet)</div>`;

  const passesHeader = document.getElementById('co-passes-th');
  if (passesHeader) {
    passesHeader.addEventListener('mouseenter', e => {
      _cancelHide();
      tooltip.innerHTML     = LEGEND_HTML;
      tooltip.style.display = 'block';
      _positionTooltip(e, tooltip);
    });
    passesHeader.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
    passesHeader.addEventListener('mouseleave', _scheduleHide);
  }

  function _wireDots() {
    tbody.querySelectorAll('.co-dot[data-idx]').forEach(dot => {
      const satId = dot.closest('[data-sat-id]')?.dataset.satId;
      const idx   = parseInt(dot.dataset.idx, 10);
      dot.addEventListener('mouseenter', async e => {
        _cancelHide();
        const sat  = store.satellites.find(s => s.id === satId);
        const pass = sat ? (store.satPasses[sat.id] ?? [])[idx] : null;
        if (!pass) return;
        const ip          = satBaseUrl(sat.noradId);
        const grafanaHost = ip ? ip.replace(/\.\d+$/, '.5') : null;
        tooltip.innerHTML     = _tooltipContent(pass, grafanaHost, sat);
        tooltip.style.display = 'block';
        _positionTooltip(e, tooltip);
        // Async polar injection
        if (sat?.satrec) {
          const coords = await fetchPassGsCoords(sat, pass, store.groundStations);
          if (coords && tooltip.style.display !== 'none') {
            const slot = tooltip.querySelector('.polar-slot');
            if (slot) slot.outerHTML = buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask);
          }
        }
      });
      dot.addEventListener('mouseleave', _scheduleHide);
    });

    // Battery monitoring tooltip
    tbody.querySelectorAll('.co-batt-hover[data-batt-mon]').forEach(el => {
      el.addEventListener('mouseenter', e => {
        try {
          const mon = JSON.parse(el.dataset.battMon);
          _cancelHide();
          tooltip.innerHTML     = _battMonTooltip(mon);
          tooltip.style.display = 'block';
          _positionTooltip(e, tooltip);
        } catch { /* bad JSON, ignore */ }
      });
      el.addEventListener('mouseleave', _scheduleHide);
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
      let eclipse = null;
      if (sat.satrec) {
        const r = propagate(sat.satrec, nowDate);
        if (r?.eciPos) eclipse = isInEclipse(r.eciPos, sunDir);
      }
      return _rowHTML(sat, now, eclipse);
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

      const tm = store.satTelemetry[sat.id] ?? null;

      // Contact time (changes every tick)
      const contactEl = row.querySelector('.co-contact-stack');
      if (contactEl) {
        const lastMs  = tm?.receptionTime ? new Date(tm.receptionTime).getTime() : null;
        const elapsed = lastMs !== null ? now - lastMs : null;
        const isLive  = elapsed !== null && elapsed < 20000;
        const lastLine = elapsed === null
          ? '<span class="co-nil">—</span>'
          : isLive
            ? '<span class="co-live-badge">● LIVE</span>'
            : `<span class="co-contact-time">${_fmtAgo(elapsed)}</span>`;
        const nextPass = (store.satPasses[sat.id] ?? []).find(p => p.future);
        const nextLine = nextPass
          ? `<span class="co-next-contact">Next ${_fmtIn(nextPass.start - now)}</span>`
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

      // TLE freshness (recomputed from epoch on every tick so the age counter advances)
      const tleEl = row.querySelector('.co-tle-age');
      if (tleEl && sat.satrec) {
        const epochDate = _epochToDate(sat.satrec.epochyr, sat.satrec.epochdays);
        const ageDays   = (now - epochDate.getTime()) / 86400000;
        const { cls, icon, age } = _tleAgeLabel(ageDays);
        tleEl.className   = `co-tle-age ${cls}`;
        tleEl.textContent = `${age} ${icon}`;
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

  tbody.addEventListener('click', e => {
    const dot = e.target.closest('.co-ping-dot');
    if (!dot) return;
    const satId = dot.closest('tr')?.dataset.satId;
    if (satId) pingSatellite(satId);
  });

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
    if ((key === 'satellites' || key === 'satTelemetry' || key === 'satPasses') && _active) render();
    if (key === 'pingStatus' && _active) _updatePingDots();
  });
}

// ── Formatting helpers ────────────────────────────────────────────

function _fmtUptime(seconds) {
  const s = Math.floor(Number(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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
