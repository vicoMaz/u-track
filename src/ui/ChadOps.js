import { store }                              from '../store.js';
import { propagate }                          from '../tle.js';
import { sunDirectionECI, isInEclipse }       from '../sunVector.js';
import { getPingIntervalSec, getPingElapsedSec, getLastPingMs, satBaseUrl, pingSatellite } from '../satPing.js';
import { satSubsystemOrigin, satSubsystemHost } from '../satSubsystems.js';
import { worstSev } from './severity.js';
import {
  passSimpleTooltipContent as _tooltipContent,
  positionTooltip          as _positionTooltip,
  hydratePassGeometry,
  hydrateScheduledProcedures,
} from './passTooltip.js';
import { openPassDetail } from './PassDetailPanel.js';

// URL builders — subnet routing: .1=SCC, .2=FDS, .3=GNM, .4=MIC, .5=SCC RO (see satSubsystems.js).
// FDS/GNM/SCC may be overridden as bare IPs OR full URLs (e.g. a hostname+HTTPS
// deployment), so these read the resolved origin rather than assuming an IP.
const _grafanaUrl   = noradId => {
  const host = satSubsystemHost(noradId, 'sccRo'); // Grafana is hosted on the SCC RO box, port 3000
  return host ? `http://${host}:3000/?orgId=1&from=now-6h&to=now&timezone=browser` : null;
};
const _dashboardUrl = ip => ip ? `http://${ip}/` : null;
const _gnmUrl       = noradId => satSubsystemOrigin(noradId, 'gnm') || null;

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

// Real on-board event counts from TM; baseline = counts 24 h ago for delta display
function _evtBadge(events, baseline) {
  if (!events) return '<span class="co-nil">—</span>';
  const rows = [
    { label: 'HIGH', v: events.high,   b: baseline?.high   },
    { label: 'MED',  v: events.med,    b: baseline?.med    },
    { label: 'LOW',  v: events.low,    b: baseline?.low    },
    { label: 'NOM',  v: events.normal, b: baseline?.normal },
  ];
  // Flat grid children — 3 cols: label | pill | delta — all rows align together
  return `<div class="co-evt-stack">${rows.map(r => {
    const val = r.v?.value ?? null;
    const cls = r.v?.status ? _monPillCls(r.v.status) : '';
    const valHtml = val != null
      ? `<span class="co-pill ${cls}">${val}</span>`
      : '<span class="co-nil">—</span>';
    const d = (val != null && r.b != null) ? Number(val) - r.b : 0;
    const deltaHtml = d > 0 ? `<span class="co-evt-delta">+${d}</span>` : '<span></span>';
    return `<span class="co-mode-label">${r.label}</span>${valHtml}${deltaHtml}`;
  }).join('')}</div>`;
}

// Ground alerts get their own 5-step severity palette (nominal→critical) instead of
// the shared 3-bucket _monPillCls used elsewhere — kept separate to avoid recoloring
// battery/orbit pills that already rely on _monPillCls's coarser grouping.
const _GROUND_SEV_COLOR = {
  NOMINAL:  'var(--sev-nominal)',
  WATCH:    'var(--sev-watch)',
  WARNING:  'var(--sev-warning)',
  DISTRESS: 'var(--sev-distress)',
  CRITICAL: 'var(--sev-critical)',
};
const _GROUND_SEV_CLS = {
  NOMINAL:  'co-pill-ga-nominal',
  WATCH:    'co-pill-ga-watch',
  WARNING:  'co-pill-ga-warning',
  DISTRESS: 'co-pill-ga-distress',
  CRITICAL: 'co-pill-ga-critical',
};

// Ground-side monitoring alarms (category GROUND from /api/v1/events), counted by
// criticality over the last 24h — same visual language as _evtBadge, but a direct
// count instead of a counter delta, since these are discrete events, not a cumulative
// on-board counter.
function _groundEvtBadge(counts) {
  if (!counts) return '<span class="co-nil">—</span>';
  const rows = [
    { label: 'CRIT',  v: counts.critical, sev: 'CRITICAL' },
    { label: 'DIST',  v: counts.distress, sev: 'DISTRESS' },
    { label: 'WARN',  v: counts.warning,  sev: 'WARNING'  },
    { label: 'WATCH', v: counts.watch,    sev: 'WATCH'    },
  ];
  return `<div class="co-evt-stack">${rows.map(r =>
    `<span class="co-mode-label">${r.label}</span><span class="co-pill ${_GROUND_SEV_CLS[r.sev]}">${r.v}</span><span></span>`
  ).join('')}</div>`;
}

// ── External links ────────────────────────────────────────────────

// version is embedded right in the badge (e.g. "SCC 5.8.6 ↗") so a subsystem's
// link and its version share one compact element instead of two separate columns.
function _linkBadge(label, url, version) {
  const text = version ? `${label} <span class="co-link-ver">${version}</span>` : label;
  if (url) {
    return `<a href="${url}" target="_blank" rel="noopener" class="co-link">${text} ↗</a>`;
  }
  return `<span class="co-link co-link-tbd" title="URL not yet configured">${text} ↗</span>`;
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

// True while `now` falls inside a pass window (aos0 → los0), regardless of the
// stale `future` flag captured at fetch time — used to glow the fleet row LIVE
// while a satellite is actually overhead a station.
function _inPassNow(passes, now) {
  return !!(passes ?? []).find(p => p.start <= now && now <= p.end);
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

// ── GNSS cell ─────────────────────────────────────────────────────

function _gnssAgeCls(ms) {
  return ms < 43_200_000 ? 'co-gnss-ok' : ms < 86_400_000 ? 'co-gnss-warn' : 'co-gnss-stale';
}

function _gnssCell(gnss) {
  if (!gnss) return '<span class="co-nil">—</span>';
  const now = Date.now();
  let bothCls, bothVal;
  if (!gnss.lastBothGood) {
    bothCls = 'co-gnss-nil'; bothVal = '—';
  } else {
    bothCls = _gnssAgeCls(now - gnss.lastBothGood.getTime());
    bothVal = _fmtAgo(now - gnss.lastBothGood.getTime());
  }
  const hkCls = gnss.hkIsValid == null ? 'co-gnss-nil' : gnss.hkIsValid ? 'co-gnss-ok' : 'co-gnss-stale';
  const hkVal = gnss.hkIsValid == null ? '—' : gnss.hkIsValid ? 'HK VALID' : 'HK INVALID';
  return `<div class="co-gnss-stack">
    <span class="co-gnss-sub">FINESTEERING</span>
    <div class="co-gnss-row ${bothCls}" title="Time since last FINESTEERING and HK VALID together"><span class="co-gnss-led">●</span><span class="co-gnss-val">${bothVal}</span></div>
    <div class="co-gnss-row ${hkCls}" title="HK validity — last received packet"><span class="co-gnss-led">●</span><span class="co-gnss-val">${hkVal}</span></div>
  </div>`;
}

// Satellite-specific fields with no subsystem link of their own (BDS/procedures,
// from /api/v1/globals) — each gets its own full-width line under the link badges
// so a long BDS build string doesn't crowd out the procedures version.
function _globalsLine(globals) {
  if (!globals?.bdsVersion && !globals?.proceduresVersion) return '';
  const line = (label, val) => val ? `<div class="co-globals-line"><span class="co-globals-label">${label}</span>${val}</div>` : '';
  return line('BDS', globals.bdsVersion) + line('PROC', globals.proceduresVersion);
}

// Full subsystem link + version breakdown — shown in a hover tooltip off the Links
// cell's (i) icon instead of inline, so the cell itself stays down to just the
// Dashboard badge for compactness.
function _linksDetailHTML(sat) {
  const v = store.satVersions[sat.id] ?? {};
  const badges = [
    _linkBadge('SCC',     _satLink(sat.noradId, 'scc',     v.scc?.appUrl   || satSubsystemOrigin(sat.noradId, 'scc')   || null), v.scc?.version),
    _linkBadge('FDS',     v.fds?.appUrl   || satSubsystemOrigin(sat.noradId, 'fds')   || null, v.fds?.version),
    _linkBadge('SCC RO',  v.sccRo?.appUrl || satSubsystemOrigin(sat.noradId, 'sccRo') || null, v.sccRo?.version),
    _linkBadge('GNM',     _satLink(sat.noradId, 'gnm',     v.gnm?.appUrl   || _gnmUrl(sat.noradId)), v.gnm?.version),
    _linkBadge('MIC',     v.mic?.appUrl   || satSubsystemOrigin(sat.noradId, 'mic')   || null, v.mic?.version),
    _linkBadge('Grafana', _satLink(sat.noradId, 'grafana', _grafanaUrl(sat.noradId))),
  ].join('');
  const globals = _globalsLine(store.satGlobals[sat.id]);
  return `<div class="co-tt-header">${sat.name} <span class="co-links-detail-sub">Links &amp; Versions</span></div>
    <div class="co-links-detail-grid">${badges}</div>
    ${globals ? `<div class="co-tt-sep"></div>${globals}` : ''}`;
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
  const inPass = _inPassNow(store.satPasses[sat.id], now);

  const lastContactMs = tm?.receptionTime ? new Date(tm.receptionTime).getTime() : null;
  const elapsed = lastContactMs !== null ? now - lastContactMs : null;

  const lastLine = elapsed === null
    ? '<span class="co-nil">—</span>'
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

  const sccColor = store.satGlobals[sat.id]?.sccColor;
  const rowStyle = sccColor ? ` style="--scc-color:${sccColor}"` : '';

  return `<tr class="co-row${inPass ? ' co-row-live' : ''}" data-sat-id="${sat.id}"${rowStyle}>
    <td class="co-name-cell">${sat.name}${inPass ? '<span class="co-pass-live-badge">● LIVE</span>' : ''}</td>
    <td class="co-ping-cell" data-field="ping-cell">${_buildPingCell(sat.id)}</td>
    <td class="co-contact-cell">${contactCell}</td>
    <td class="co-mode-cell">${modeCell}</td>
    <td class="co-batt-cell">${battCell}</td>
    <td class="co-rw-cell">${_rwCell(tm?.rw)}</td>
    <td class="co-gnss-cell">${_gnssCell(store.satGnss[sat.id])}</td>
    <td class="co-passes-cell" data-sat-id="${sat.id}">${_passDots(store.satPasses[sat.id])}</td>
    <td>${orbitCell}</td>
    <td class="co-alerts-cell">${_groundEvtBadge(store.satGroundEvents[sat.id])}</td>
    <td class="co-alerts-cell">${_evtBadge(tm?.events, store.satEventBaseline[sat.id])}</td>
    <td class="co-links-cell">${_linkBadge('Dashboard', _dashboardUrl(satBaseUrl(sat.noradId)))}<span class="co-links-info" data-sat-id="${sat.id}">ⓘ</span></td>
  </tr>`;
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
  let _renderTimer = null;

  // One satellite's ~20s poll cycle resolves telemetry/passes/gnss/groundEvents
  // (and occasionally globals/versions) as separate promises, each firing its
  // own store notification — without this, render() (a full tbody.innerHTML
  // rebuild + tooltip re-wiring) would run once per notification, several
  // times per second across a fleet, dropping any open tooltip and scroll
  // position each time. Coalesces a burst into a single rebuild ~150ms after
  // the last notification in it.
  function _scheduleRender() {
    if (_renderTimer) clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 150);
  }

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

  const GNSS_LEGEND_HTML = `
    <div class="co-legend-title">TM_3_25_OBSW_HK_GNSS_RTE</div>
    <div class="co-legend-title co-legend-gap">FINESTEERING + HK VALID together</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#00cc88">●</span> &lt; 12 h</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#ffcc00">●</span> &lt; 24 h</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#ff4466">●</span> ≥ 24 h</div>
    <div class="co-legend-title co-legend-gap">HK VALID — GNSS_AM_HW_HK_VALID</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#00cc88">●</span> Last packet = VALID</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#ff4466">●</span> Last packet = INVALID</div>`;

  const gnssHeader = document.getElementById('co-gnss-th');
  if (gnssHeader) {
    gnssHeader.addEventListener('mouseenter', e => {
      _cancelHide();
      tooltip.innerHTML     = GNSS_LEGEND_HTML;
      tooltip.style.display = 'block';
      _positionTooltip(e, tooltip);
    });
    gnssHeader.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
    gnssHeader.addEventListener('mouseleave', _scheduleHide);
  }

  const BOARD_ALERTS_HTML = `
    <div class="co-legend-title">Packet: TM_3_25_OBSW_HK_PLT</div>
    <div class="co-legend-sub">Cumulative on-board event counters since last OBC boot. The <span style="color:#ffcc00;font-weight:600">+N</span> delta shows how many new events occurred in the last 24 h.</div>
    <div class="co-legend-title co-legend-gap">Severity levels</div>
    <div class="co-legend-row"><span class="co-mode-label">HIGH</span> OBSW_AM_NB_HIGH_SEV_EVT</div>
    <div class="co-legend-row"><span class="co-mode-label">MED</span> OBSW_AM_NB_MED_SEV_EVT</div>
    <div class="co-legend-row"><span class="co-mode-label">LOW</span> OBSW_AM_NB_LOW_SEV_EVT</div>
    <div class="co-legend-row"><span class="co-mode-label">NOM</span> OBSW_AM_NB_NORMAL_EVT</div>`;

  const boardAlertsHeader = document.getElementById('co-board-alerts-th');
  if (boardAlertsHeader) {
    boardAlertsHeader.addEventListener('mouseenter', e => {
      _cancelHide();
      tooltip.innerHTML     = BOARD_ALERTS_HTML;
      tooltip.style.display = 'block';
      _positionTooltip(e, tooltip);
    });
    boardAlertsHeader.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
    boardAlertsHeader.addEventListener('mouseleave', _scheduleHide);
  }

  const GROUND_ALERTS_HTML = `
    <div class="co-legend-title">/api/v1/events · category = GROUND</div>
    <div class="co-legend-sub">Ground-side monitoring alarms — SCC watches telemetry parameters against configured thresholds and raises one of these when a value deviates from nominal. Counts are over the last 24 h.</div>
    <div class="co-legend-title co-legend-gap">Severity levels</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:${_GROUND_SEV_COLOR.NOMINAL}">●</span> Nominal</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:${_GROUND_SEV_COLOR.WATCH}">●</span> Watch</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:${_GROUND_SEV_COLOR.WARNING}">●</span> Warning</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:${_GROUND_SEV_COLOR.DISTRESS}">●</span> Distress</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:${_GROUND_SEV_COLOR.CRITICAL}">●</span> Critical</div>`;

  const groundAlertsHeader = document.getElementById('co-ground-alerts-th');
  if (groundAlertsHeader) {
    groundAlertsHeader.addEventListener('mouseenter', e => {
      _cancelHide();
      tooltip.innerHTML     = GROUND_ALERTS_HTML;
      tooltip.style.display = 'block';
      _positionTooltip(e, tooltip);
    });
    groundAlertsHeader.addEventListener('mousemove',  e => _positionTooltip(e, tooltip));
    groundAlertsHeader.addEventListener('mouseleave', _scheduleHide);
  }

  function _wireDots() {
    tbody.querySelectorAll('.co-dot[data-idx]').forEach(dot => {
      const satId = dot.closest('[data-sat-id]')?.dataset.satId;
      const idx   = parseInt(dot.dataset.idx, 10);
      const _passFor = () => {
        const sat  = store.satellites.find(s => s.id === satId);
        const pass = sat ? (store.satPasses[sat.id] ?? [])[idx] : null;
        return { sat, pass };
      };
      dot.addEventListener('mouseenter', e => {
        _cancelHide();
        const { sat, pass } = _passFor();
        if (!pass) return;
        tooltip.innerHTML     = _tooltipContent(pass, sat);
        tooltip.style.display = 'block';
        _positionTooltip(e, tooltip);
        hydratePassGeometry(tooltip, e, pass, sat);
        hydrateScheduledProcedures(tooltip, pass, sat);
      });
      dot.addEventListener('mouseleave', _scheduleHide);
      dot.addEventListener('click', () => {
        const { sat, pass } = _passFor();
        if (!pass) return;
        _hideNow();
        openPassDetail(pass, sat, store.groundStations);
      });
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

    // Links detail tooltip — full subsystem link + version breakdown
    tbody.querySelectorAll('.co-links-info[data-sat-id]').forEach(el => {
      el.addEventListener('mouseenter', e => {
        const sat = store.satellites.find(s => s.id === el.dataset.satId);
        if (!sat) return;
        _cancelHide();
        tooltip.innerHTML     = _linksDetailHTML(sat);
        tooltip.style.display = 'block';
        _positionTooltip(e, tooltip);
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

    // Worst-first: a satellite with a problem sorts to the top regardless of
    // add order, so it's found without reading every row on a large fleet.
    const sorted = [...store.satellites].sort((a, b) => worstSev(b) - worstSev(a));

    tbody.innerHTML = sorted.map(sat => {
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
        const lastLine = elapsed === null
          ? '<span class="co-nil">—</span>'
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

      // In-pass LIVE glow (changes on aos0/los0 boundaries)
      const nameEl = row.querySelector('.co-name-cell');
      if (nameEl) {
        const inPass = _inPassNow(store.satPasses[sat.id], now);
        row.classList.toggle('co-row-live', inPass);
        let badge = nameEl.querySelector('.co-pass-live-badge');
        if (inPass && !badge) {
          badge = document.createElement('span');
          badge.className   = 'co-pass-live-badge';
          badge.textContent = '● LIVE';
          nameEl.appendChild(badge);
        } else if (!inPass && badge) {
          badge.remove();
        }
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

      // GNSS timers advance every tick
      const gnssEl = row.querySelector('.co-gnss-cell');
      if (gnssEl) gnssEl.innerHTML = _gnssCell(store.satGnss[sat.id]);

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
    if (_timer)       { clearInterval(_timer);    _timer    = null; }
    if (_agoTimer)    { clearInterval(_agoTimer); _agoTimer = null; }
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
    tooltip.style.display = 'none';
  }

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'fleet') start();
      else stop();
    });
  });

  store.subscribe(key => {
    if ((key === 'satellites' || key === 'satTelemetry' || key === 'satPasses' || key === 'satGnss' || key === 'satGlobals' || key === 'satVersions' || key === 'satGroundEvents') && _active) _scheduleRender();
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

function _fmtIn(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `in ${m}m`;
  return `in ${h}h ${m < 10 ? '0' : ''}${m}m`;
}
