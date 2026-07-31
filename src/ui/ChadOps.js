import { store }                              from '../store.js';
import { propagate }                          from '../tle.js';
import { sunDirectionECI, isInEclipse }       from '../sunVector.js';
import { getPingIntervalSec, getPingElapsedSec, getLastPingMs, satBaseUrl, pingSatellite } from '../satPing.js';
import { satSubsystemOrigin, satSubsystemHost } from '../satSubsystems.js';
import { satIsSimulated, satEffectiveNow } from '../satSimu.js';
import { worstSev } from './severity.js';
import {
  passSimpleTooltipContent as _tooltipContent,
  positionTooltip          as _positionTooltip,
  hydratePassGeometry,
  hydrateScheduledProcedures,
  hydratePassStatusDots,
  fmtDateTimeShort,
} from './passTooltip.js';
import { MITIGATION_WINDOW_DAYS } from '../satGnssMitigation.js';
import { wireSatActionsIcon } from './satActionsMenu.js';

// URL builders — subnet routing: .1=SCC, .2=FDS, .3=GNM, .4=MIC, .5=SCC RO (see satSubsystems.js).
// FDS/GNM/SCC may be overridden as bare IPs OR full URLs (e.g. a hostname+HTTPS
// deployment), so these read the resolved origin rather than assuming an IP.
const _grafanaUrl   = noradId => {
  const host = satSubsystemHost(noradId, 'sccRo'); // Grafana is hosted on the SCC RO box, port 3000
  return host ? `http://${host}:3000/?orgId=1&from=now-6h&to=now&timezone=browser` : null;
};
const _dashboardUrl = ip => ip ? `http://${ip}/` : null;
const _gnmUrl       = noradId => satSubsystemOrigin(noradId, 'gnm') || null;
// The satellite name in the Fleet row links to its synoptic view — SCC's
// own (.1, full read/write) normally, SCC RO's (.5, read-only mirror —
// same subsystem/port SUBSYSTEMS.sccRo already resolves) instead whenever
// store.readOnlyVpn says this client's VPN can't reach SCC/FDS/GNM/MIC at
// all, so the link still resolves to something reachable rather than
// pointing at a subnet this client can't get to either way.
const _synopticUrl = noradId => {
  const origin = satSubsystemOrigin(noradId, store.readOnlyVpn ? 'sccRo' : 'scc');
  return origin ? `${origin}/synoptic` : null;
};

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
    // Each dot is now a plain CSS-drawn circle (background/border, no glyph
    // text) — see .co-dot in style.css for why: a ring can only align
    // reliably to an actual box, not to a ●/○ character's own ink, which
    // browsers don't center within their font box the way you'd expect.
    const cls = p.future ? 'co-dot-future' : (_OUTCOME_CLS[p.outcome] ?? 'co-dot-success');
    return `<span class="co-dot ${cls}" data-idx="${i}"></span>`;
  }).join('');
  return `<div class="co-dots-grid">${html}</div>`;
}

// The pass `now` currently falls inside (aos0 → los0), regardless of the
// stale `future` flag captured at fetch time — or null. Used both to glow the
// fleet row LIVE while a satellite is actually overhead a station, and to
// compute how far through that pass it currently is.
function _currentPass(passes, now) {
  return (passes ?? []).find(p => p.start <= now && now <= p.end) ?? null;
}

// 0-1 fraction through the pass — clamped since receive/propagation jitter
// could otherwise push `now` a hair outside [start,end] between the
// _currentPass check above and this being read a moment later.
function _passProgress(pass, now) {
  if (!pass) return 0;
  const span = pass.end - pass.start;
  return span > 0 ? Math.min(1, Math.max(0, (now - pass.start) / span)) : 1;
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
  return ms < 86_400_000 ? 'co-gnss-ok' : ms < 172_800_000 ? 'co-gnss-warn' : 'co-gnss-stale';
}

// mit is not part of GNSS health per se (a recent mitigation means the
// self-healing procedure worked, not that anything is currently wrong) — so
// it gets its own neutral-but-visible co-gnss-mit color, distinct from both
// the ok/warn/stale traffic-light rows above it AND from co-gnss-nil (which
// stays reserved for the true "no data" placeholder, so a populated row never
// looks like an empty one). The ♻ icon marks it as the recycled/reset
// (OFF/ON/CONFIG) row at a glance; the 30-day count is shown inline, not just
// in the hover tooltip. Rendered as a tinted chip (co-gnss-chip), matching
// the pill language Mode/RWH/Alerts already use elsewhere in this table.
function _mitigationRow(mit) {
  if (!mit) return `<div class="co-gnss-row"><span class="co-gnss-chip co-gnss-nil" title="No mitigation data yet">♻ —</span></div>`;
  const val   = mit.lastMs != null ? _fmtAgo(Date.now() - mit.lastMs) : `none in ${MITIGATION_WINDOW_DAYS}d`;
  const count = mit.saturated ? `≥${mit.count30d}` : mit.count30d;
  return `<div class="co-gnss-row" title="GNSS_MITIGATION applies an OFF/ON/CONFIG GNSS fix when it detects an abnormal configuration">` +
    `<span class="co-gnss-chip co-gnss-mit">♻ ${val}</span><span class="co-gnss-count">${count}×/${MITIGATION_WINDOW_DAYS}d</span></div>`;
}

// FINESTEERING age + HK validity fused onto one row (was 3 lines: a sub-label
// plus one row each) — HK validity collapses to a "HK ✓"/"HK ✗" chip here, with the
// full "HK VALID"/"HK INVALID" wording moved into its title tooltip, since
// the two together were making this column noticeably taller than its
// neighbors (Mode/Battery/RWH) for no informational gain. Both rendered as
// tinted co-gnss-chip pills, same visual language as Mode's SYS/GNC badges,
// RWH's numbered chips, and the Alerts columns' severity pills.
function _gnssCell(gnss, mit) {
  if (!gnss && !mit) return '<span class="co-nil">—</span>';
  const now = Date.now();
  let bothCls, bothVal;
  if (!gnss?.lastBothGood) {
    bothCls = 'co-gnss-nil'; bothVal = '—';
  } else {
    bothCls = _gnssAgeCls(now - gnss.lastBothGood.getTime());
    bothVal = _fmtAgo(now - gnss.lastBothGood.getTime());
  }
  const hkOk    = gnss?.hkIsValid;
  const hkCls   = hkOk == null ? 'co-gnss-nil' : hkOk ? 'co-gnss-ok' : 'co-gnss-stale';
  const hkSym   = hkOk == null ? '—' : hkOk ? 'HK ✓' : 'HK ✗';
  const hkTitle = hkOk == null ? 'HK validity unknown' : hkOk ? 'HK VALID — last received packet' : 'HK INVALID — last received packet';
  return `<div class="co-gnss-stack">
    <div class="co-gnss-row" title="Time since last FINESTEERING and HK VALID together">
      <span class="co-gnss-chip ${bothCls}">${bothVal}</span><span class="co-gnss-chip co-gnss-hk-chip ${hkCls}" title="${hkTitle}">${hkSym}</span>
    </div>
    ${_mitigationRow(mit)}
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
  const currentPass = _currentPass(store.satPasses[sat.id], now);
  const inPass = !!currentPass;

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
  const battSoc  = tm?.battSoc?.value          ?? null;
  const _BATT_CLS = { NOMINAL: 'co-batt-ok', WATCH: 'co-batt-watch', WARNING: 'co-batt-warn', DISTRESS: 'co-batt-dist', SEVERE: 'co-batt-low', CRITICAL: 'co-batt-low' };
  const battCls  = _BATT_CLS[battSts] ?? 'co-batt-ok';
  const socHtml  = battSoc != null ? `<span class="co-soc" title="SoC estimate — valid between 20% and 90%">${battSoc}%</span>` : '';
  const battCell = battVal != null
    ? `<span class="${battCls}">${Number(battVal).toFixed(1)} V${socHtml}</span>`
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
  const orbitCell = `<div class="co-orbit-stack">
    <div class="co-orbit-row"><span class="co-orbit-label">ECL</span>${eclHtml}</div>
    <div class="co-orbit-row"><span class="co-orbit-label">ALT</span>${altHtml}</div>
    <div class="co-orbit-row"><span class="co-orbit-label">TLE</span>${tleHtml}</div>
  </div>`;

  // sat.color, not store.satGlobals[sat.id]?.sccColor directly — the latter
  // is whatever SCC's globals endpoint reports on its OWN periodic poll (see
  // satGlobals.js's bdsVersion/proceduresVersion/sccVersion, still live),
  // but color itself is captured from SCC exactly once, at creation, and
  // frozen into sat.color from then on — same static value every other view
  // (Settings, the Visualizer sidebar, globe/map entities) already reads,
  // so this row's own accent stays consistent with all of them.
  // --pass-progress lives here too (not on the badge) — the WHOLE ROW is
  // the progress bar now (see .co-row-live in style.css), a brighter-green
  // sweep behind every cell/badge advancing left-to-right as the pass runs
  // AOS→LOS, rather than a fill confined inside the small badge itself.
  const rowStyleProps = [];
  if (sat.color)    rowStyleProps.push(`--scc-color:${sat.color}`);
  if (currentPass)  rowStyleProps.push(`--pass-progress:${_passProgress(currentPass, now).toFixed(3)}`);
  const rowStyle = rowStyleProps.length ? ` style="${rowStyleProps.join(';')}"` : '';

  // Just a static glowing tag now — no more internal progress fill (that
  // moved to the row itself, above); the text sits in its own inner span
  // (co-pass-live-text) purely so the glow's ::after can bleed past the
  // badge's own edges without also covering the text.
  const liveBadge = currentPass
    ? `<span class="co-pass-live-badge"><span class="co-pass-live-text">● LIVE</span></span>`
    : '';

  // Set once at add-time (InputPanel.js's addSatellite), not auto-detected —
  // see satSimu.js. Not real-time, so kept out of the Visualizer (GlobeView.js/
  // MapView.js), but ops still cares about its telemetry/procedures, so it
  // still gets a normal Fleet row, just clearly labeled.
  const isSimu = satIsSimulated(sat.noradId);
  const simuBadge = isSimu
    ? `<span class="co-simu-badge" title="Simulated satellite — not real-time, kept out of the Visualizer">🧪 SIM</span>`
    : '';
  // `now` here is already satEffectiveNow(sat.noradId) (see render()'s own
  // call site) — every "ago"/"next"/TLE-age label in this row is already
  // silently anchored to it; this just makes that anchor itself visible,
  // since without it those labels read as if they were real-time.
  const simuTimeLine = isSimu
    ? `<div class="co-simu-time" title="This satellite's own current time — from its SCC's own clock (satSimu.js), not real time. Contact/next-pass/TLE-age above are all anchored to it.">🕐 ${fmtDateTimeShort(new Date(now))}</div>`
    : '';

  // One click to the Visualizer, already tracking this satellite — instead
  // of switching tabs yourself and then hunting it in the satellite list.
  // Omitted for a simulated satellite: GlobeView.js/MapView.js already keep
  // those out of the Visualizer entirely (see simuBadge's own comment
  // above), so tracking one here would just be a dead end.
  const trackBtn = !isSimu
    ? `<button type="button" class="co-track-btn" data-sat-id="${sat.id}" title="Track ${sat.name} in the Visualizer"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></button>`
    : '';

  // Links to SCC's synoptic view (SCC RO's instead under a read-only VPN —
  // see _synopticUrl) — plain text, no dead link, when neither subsystem's
  // IP is configured for this satellite at all.
  const synopticUrl = _synopticUrl(sat.noradId);
  const nameHTML = synopticUrl
    ? `<a class="co-sat-name-link" href="${synopticUrl}" target="_blank" rel="noopener" title="Open ${sat.name}'s synoptic view">${sat.name}</a>`
    : sat.name;

  return `<tr class="co-row${inPass ? ' co-row-live' : ''}" data-sat-id="${sat.id}"${rowStyle}>
    <td class="co-name-cell">
      <div class="co-name-row">${trackBtn}<button type="button" class="co-actions-btn" data-sat-id="${sat.id}" title="More actions">⋮</button>${nameHTML}${simuBadge}${liveBadge}</div>
      ${simuTimeLine}
    </td>
    <td class="co-ping-cell" data-field="ping-cell">${_buildPingCell(sat.id)}</td>
    <td class="co-contact-cell">${contactCell}</td>
    <td class="co-mode-cell">${modeCell}</td>
    <td class="co-batt-cell">${battCell}</td>
    <td class="co-rw-cell">${_rwCell(tm?.rw)}</td>
    <td class="co-gnss-cell">${_gnssCell(store.satGnss[sat.id], store.satGnssMitigation[sat.id])}</td>
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
    <div class="co-legend-row"><span class="co-dot co-dot-success"></span> Success</div>
    <div class="co-legend-row"><span class="co-dot co-dot-fail"></span> Failure</div>
    <div class="co-legend-row"><span class="co-dot co-dot-cancelled"></span> Cancelled</div>
    <div class="co-legend-title co-legend-gap">Future</div>
    <div class="co-legend-row"><span class="co-dot co-dot-future"></span> Upcoming (no outcome yet)</div>`;

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
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#00cc88">●</span> &lt; 24 h</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#ffcc00">●</span> &lt; 48 h</div>
    <div class="co-legend-row"><span class="co-gnss-led" style="color:#ff4466">●</span> ≥ 48 h</div>
    <div class="co-legend-title co-legend-gap">HK VALID — GNSS_AM_HW_HK_VALID</div>
    <div class="co-legend-row"><span class="co-gnss-hk" style="color:#00cc88">HK ✓</span> Last packet = VALID</div>
    <div class="co-legend-row"><span class="co-gnss-hk" style="color:#ff4466">HK ✗</span> Last packet = INVALID</div>
    <div class="co-legend-title co-legend-gap">GNSS_MITIGATION procedure (♻)</div>
    <div class="co-legend-row">Time since last applied "OFF/ON/CONFIG GNSS" fix, and how many times in the last ${MITIGATION_WINDOW_DAYS} days</div>`;

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
        hydratePassStatusDots(tooltip, pass, sat);
      });
      dot.addEventListener('mouseleave', _scheduleHide);
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

    // Planet icon → Visualizer, tracking this satellite — clicks the real
    // tab button rather than importing switchTab from main.js (which itself
    // imports this module — a real cycle, not just an avoidable one).
    tbody.querySelectorAll('.co-track-btn[data-sat-id]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation(); // this row has no other click behavior today, but keeps a future one from also firing
        store.setTrackedSat(btn.dataset.satId);
        document.querySelector('[data-tab="tracking"]')?.click();
      });
    });

    // "⋮" more-actions icon → floating menu (satActionsMenu.js) — real
    // actions against the real satellite (mission mode enable/disable so
    // far), acknowledged via a toast on completion, not just informational.
    tbody.querySelectorAll('.co-actions-btn[data-sat-id]').forEach(btn => {
      const sat = store._satById.get(btn.dataset.satId);
      if (sat) wireSatActionsIcon(btn, sat);
    });
  }

  function render() {
    const nowDate = new Date();
    const sunDir  = sunDirectionECI(nowDate);

    // Only satellites THIS client can reach — see store.accessibleSatellites.
    const fleet = store.accessibleSatellites;
    if (!fleet.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="co-empty">${
        store.satellites.length ? 'No satellites reachable on your current VPN.' : 'No satellites loaded — add one to begin.'
      }</td></tr>`;
      return;
    }

    // Worst-first: a satellite with a problem sorts to the top regardless of
    // add order, so it's found without reading every row on a large fleet.
    const sorted = [...fleet].sort((a, b) => worstSev(b) - worstSev(a));

    // Snapshot each currently-live row's OWN --pass-progress (whatever _tick's
    // last update, or this same function's own previous call, set it to)
    // BEFORE the innerHTML rebuild below throws that <tr> away — see the
    // restore loop after the rebuild for why.
    const prevProgress = new Map(); // satId -> its --pass-progress value, as a string
    tbody.querySelectorAll('tr.co-row-live[data-sat-id]').forEach(row => {
      const v = row.style.getPropertyValue('--pass-progress');
      if (v) prevProgress.set(row.dataset.satId, v);
    });

    tbody.innerHTML = sorted.map(sat => {
      let eclipse = null;
      if (sat.satrec) {
        // Eclipse/sun geometry stays on real wall-clock time even for a
        // simulated satellite — that's this app's own orbital-mechanics
        // computation, not fetched data with a window to get wrong, and
        // simulated satellites are already excluded from the Visualizer,
        // where that geometry actually gets used for anything.
        const r = propagate(sat.satrec, nowDate);
        if (r?.eciPos) eclipse = isInEclipse(r.eciPos, sunDir);
      }
      // satEffectiveNow: plain Date.now() for a real satellite (see
      // satSimu.js); for a simulated one, corrected by its own SCC-reported
      // clock offset — contact time, next-pass, TLE age, and live-pass
      // detection inside _rowHTML all key off this one value.
      return _rowHTML(sat, satEffectiveNow(sat.noradId), eclipse);
    }).join('');

    // Resume each live row's progress-sweep transition (style.css's
    // .co-row-live) from where it left off, instead of letting it just snap
    // straight to the fresh target _rowHTML above already painted it at. A
    // brand-new <tr> has no previous value of its own for that CSS
    // transition to animate FROM — and since satTelemetry/satGnss updates
    // alone trigger this whole render() (via _scheduleRender's 150ms-
    // debounced burst) roughly every ~20s PER satellite, several times a
    // minute across a real fleet, that made the sweep visibly sit still and
    // then jump on every rebuild rather than glide continuously. Fix: force
    // the OLD value back on with transitions suppressed, flush layout so the
    // browser commits that as a genuine "previous" state, then hand back to
    // the fresh target with transitions restored — read as a real value
    // change on an already-painted property, so it animates between them
    // exactly as if the row had never been recreated.
    for (const [satId, fromValue] of prevProgress) {
      const row = tbody.querySelector(`tr.co-row-live[data-sat-id="${satId}"]`);
      if (!row) continue;
      const target = row.style.getPropertyValue('--pass-progress');
      if (!target) continue;
      row.style.transition = 'none';
      row.style.setProperty('--pass-progress', fromValue);
      void row.offsetHeight; // forces the browser to commit the line above before transitions come back below
      row.style.transition = '';
      row.style.setProperty('--pass-progress', target);
    }

    _wireDots();
  }

  // Lightweight tick: only patches contact-time and eclipse in-place — no DOM rebuild
  function _tick() {
    const nowDate = new Date(); // eclipse/sun geometry only — see render()'s own note on why this one stays real-time
    const sunDir  = sunDirectionECI(nowDate);

    for (const sat of store.accessibleSatellites) {
      const row = tbody.querySelector(`tr[data-sat-id="${sat.id}"]`);
      if (!row) { render(); return; } // satellite added (or became reachable) since last full render

      // satEffectiveNow: plain Date.now() for a real satellite (see
      // satSimu.js); for a simulated one, corrected by its own SCC-reported
      // clock offset.
      const now = satEffectiveNow(sat.noradId);
      const tm  = store.satTelemetry[sat.id] ?? null;

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

      // Simulated satellite's own clock (changes every tick, same as
      // contact time above — see _rowHTML's own simuTimeLine for why this
      // needs to be visible at all, not just used internally)
      const simuTimeEl = row.querySelector('.co-simu-time');
      if (simuTimeEl) simuTimeEl.textContent = `🕐 ${fmtDateTimeShort(new Date(now))}`;

      // Eclipse status (changes ~every 45 min but cheap to re-check)
      const eclEl = row.querySelector('[data-field="ecl"]');
      if (eclEl && sat.satrec) {
        const r       = propagate(sat.satrec, nowDate);
        const eclipse = r?.eciPos ? isInEclipse(r.eciPos, sunDir) : null;
        if (eclipse === null) { eclEl.className = 'co-nil';        eclEl.textContent = '—'; }
        else if (eclipse)     { eclEl.className = 'co-ecl-shadow'; eclEl.textContent = '● SHADOW'; }
        else                  { eclEl.className = 'co-ecl-sun';    eclEl.textContent = '☀ SUN'; }
      }

      // In-pass LIVE glow + progress fill (progress advances every tick, not
      // just at aos0/los0 boundaries — the badge itself is only created/removed
      // at those boundaries). --pass-progress lives on the ROW, not the badge
      // (see _rowHTML's own comment) — the whole row is the progress bar.
      const nameEl = row.querySelector('.co-name-cell');
      if (nameEl) {
        const currentPass = _currentPass(store.satPasses[sat.id], now);
        row.classList.toggle('co-row-live', !!currentPass);
        let badge = nameEl.querySelector('.co-pass-live-badge');
        if (currentPass && !badge) {
          badge = document.createElement('span');
          badge.className = 'co-pass-live-badge';
          const text = document.createElement('span');
          text.className   = 'co-pass-live-text';
          text.textContent = '● LIVE';
          badge.appendChild(text);
          nameEl.appendChild(badge);
        } else if (!currentPass && badge) {
          badge.remove();
        }
        if (currentPass) row.style.setProperty('--pass-progress', _passProgress(currentPass, now).toFixed(3));
        else              row.style.removeProperty('--pass-progress');
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
      if (gnssEl) gnssEl.innerHTML = _gnssCell(store.satGnss[sat.id], store.satGnssMitigation[sat.id]);

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
    if ((key === 'satellites' || key === 'satAccessible' || key === 'satTelemetry' || key === 'satPasses' || key === 'satGnss' || key === 'satGnssMitigation' || key === 'satGlobals' || key === 'satVersions' || key === 'satGroundEvents') && _active) _scheduleRender();
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
