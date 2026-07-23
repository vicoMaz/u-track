// Pass Analyzer (POC) — a dedicated, full-page inspector for one completed
// pass at a time: satellite/pass details, a TM/TC count summary, the polar
// ground-track + Eb/N0 chart (reused as-is from PassDetailPanel.js's slide-in),
// the procedure history + routine report, and the actual list of TC packets
// sent.
//
// The TC list comes from SCC's own /api/v1/tc-packets endpoint — confirmed
// live to exist on sccRo (172.17.208.5:15500), same read-only mirror every
// other per-pass fetch in this app already uses. It's a real, structured
// ledger (id, generation/reception time, the decoded packet name+description)
// rather than something scraped from logs — but confirmed live it's also
// genuinely slow at volume: it echoes each packet's FULL field/container
// schema, not just its value, so one real 14-minute pass (392 packets) came
// back as a 10MB response in ~2.6s. Kept to a modest maxLimit here for that
// reason — see TC_MAX_LIMIT below.
import { store } from '../store.js';
import { satSubsystemHost, satSubsystemOrigin } from '../satSubsystems.js';
import { fetchPassGsCoords, buildPolarSVG, computePolarPoints, computePolarMarkers } from './passPolar.js';
import { fetchProcedureReport, procedureReportHTML } from './procedureReport.js';
import { fetchEbn0Series, fetchTcEbn0Series, ebn0HTML } from './ebn0.js';
import { wireLinkedCursor } from './passCursor.js';
import { openAzElModal } from './passAzElModal.js';
import { fmtDuration, fmtDateTimeShort, fmtTimeOnly, grafanaLokiUrl, grafanaModalTitle, LOKI_PROC_PAD_MS, passEclipseBarHTML, positionTooltip } from './passTooltip.js';
import { queryLoki } from './lokiQuery.js';
import { renderLogRows, createErrorNav } from './logView.js';
import './grafanaModal.js'; // side-effect import: registers the click-to-popup handler used by the co-tt-link anchors below

const TC_MAX_LIMIT = 1000; // a typical pass sends under 1000 TC packets — confirmed live a busy 14-min pass hit 392 (10MB, ~2.6s); the 20s abort timeout below is the backstop for whatever pass exceeds that

// fmtTimeOnly (passTooltip.js) only goes down to whole seconds — TC packets
// in the same subschedule burst routinely land within a few ms of each other
// (see module comment above), so this needs its own millisecond-precision
// formatter to actually distinguish them.
function _fmtTimeMs(ms) {
  return new Date(ms).toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// TC_11_4 schedules another TC packet for later execution — it carries that
// target TC's name, a date, and a sub-schedule id (SSID) as arguments (each
// TC_11_4 wraps exactly one target). This app has no live SCC access to
// confirm the decoded-parameter JSON shape while writing this — an earlier
// version guessed a handful of exact field PATHS and none of them matched
// real data (SSID always came back "?"), so extraction now does a full
// recursive walk of the raw packet instead (see _deepFindArg below), which
// only needs to guess plausible NAMES, not the exact nesting/container
// structure around them.
// Real names carry a descriptive suffix (e.g. "TC_11_4_OBSW_INSERT_TC"), not
// just the bare "TC_11_4" — and \b is no help distinguishing "TC_11_4_..."
// from "TC_11_129_..." since _ is a word character, not a boundary. Anchored
// at the start; the minor number "4" must be followed by "_" or end-of-string
// specifically, so it doesn't also match TC_11_40, TC_11_129, etc.
const TC_114_NAME_RE = /^TC_11_4(?:_|$)/;

// A handful of guessed field PATHS (rootContainer.entries, etc.) never
// matched anything against real data — rather than guess a 4th or 5th exact
// path, this walks the ENTIRE raw packet looking for any {name, value}-shaped
// object whose name matches, regardless of how deep it's nested or what its
// parent containers are called. Skips the packet's own top-level id/
// generationTime/receptionTime so the packet's own timestamp is never
// mistaken for the scheduled-execution-date argument.
const _TOP_LEVEL_SKIP = new Set(['id', 'generationTime', 'receptionTime']);

function _deepFindArg(obj, matchers, isRoot, seen) {
  if (obj == null || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = _deepFindArg(item, matchers, false, seen);
      if (found != null) return found;
    }
    return null;
  }
  const name = typeof obj.name === 'string' ? obj.name : (typeof obj.parameter?.name === 'string' ? obj.parameter.name : null);
  if (name && matchers.some(m => name.toLowerCase().includes(m))) {
    const v = obj.value?.value ?? obj.engValue?.value ?? obj.rawValue?.value ?? (typeof obj.value !== 'object' ? obj.value : null);
    if (v != null && typeof v !== 'object') return v;
  }
  for (const key of Object.keys(obj)) {
    if (isRoot && _TOP_LEVEL_SKIP.has(key)) continue;
    const found = _deepFindArg(obj[key], matchers, false, seen);
    if (found != null) return found;
  }
  return null;
}

function _extract114Args(raw) {
  const ssid = _deepFindArg(raw, ['ssid', 'subschedule', 'sub_schedule', 'sub-schedule'], true, new Set());
  const date = _deepFindArg(raw, ['scheduledate', 'scheduletime', 'schedule_date', 'schedule_time',
    'executiondate', 'executiontime', 'execution_date', 'execution_time', 'targetdate', 'targettime'], true, new Set())
    ?? _deepFindArg(raw, ['date', 'time'], true, new Set());
  return (ssid != null || date != null) ? { ssid, date } : null;
}

// v may be an ISO string, a raw ms number, or (if the field search above
// grabbed the wrong thing) something unparseable — falls back to showing it
// verbatim rather than hiding a value that might still be useful to see.
function _fmtArgDate(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? _fmtTimeMs(ms) : String(v);
}

async function _fetchTcPackets(sat, startMs, endMs) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin) return null;
  const params = new URLSearchParams({
    start: new Date(startMs).toISOString(),
    end:   new Date(endMs).toISOString(),
    maxLimit: String(TC_MAX_LIMIT),
  });
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${origin}/api/v1/tc-packets?${params}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    // Mapped down to the lightweight fields the LIST rendering needs — each
    // packet also echoes its full parameter/container schema (rootContainer),
    // tens of KB per packet, that a plain "what got sent" list has no use
    // for. `raw` keeps a REFERENCE to the untouched original (no extra copy —
    // it's already sitting in memory from this same res.json() call) so a
    // click on a row can walk its rootContainer for the full argument
    // breakdown on demand, without a second fetch.
    return data
      .map(p => {
        const name = p.spacePacket?.name ?? '—';
        return {
          id:             p.id,
          generationTime: p.generationTime ? new Date(p.generationTime).getTime() : null,
          receptionTime:  p.receptionTime  ? new Date(p.receptionTime).getTime()  : null,
          name,
          description:    p.spacePacket?.description ?? '',
          args114:        TC_114_NAME_RE.test(name) ? _extract114Args(p) : null,
          raw:            p,
        };
      })
      .sort((a, b) => (a.generationTime ?? 0) - (b.generationTime ?? 0));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// TC_11_4's target isn't parsed from an argument — it's found by matching
// timestamps: SCC generates the TC_11_4 "envelope" and the TC it schedules
// as sibling packets around the same moment. An exact-millisecond match
// turned out too strict against real data (no live SCC access while writing
// this, so that assumption was untested) — this instead takes the CLOSEST
// other packet within MATCH_TOLERANCE_MS, so a few ms (or more) of real
// processing/logging jitter between the two doesn't break the match. Each
// target is claimed by at most one TC_11_4.
const MATCH_TOLERANCE_MS = 3000;

function _matchScheduledTargets(packets) {
  const used = new Set();
  const targetFor = new Map(); // TC_11_4 packet id -> its target packet
  for (const p of packets) {
    if (!TC_114_NAME_RE.test(p.name) || p.generationTime == null) continue;
    let best = null, bestDelta = Infinity;
    for (const o of packets) {
      if (o === p || used.has(o.id) || TC_114_NAME_RE.test(o.name) || o.generationTime == null) continue;
      const delta = Math.abs(o.generationTime - p.generationTime);
      if (delta < bestDelta) { bestDelta = delta; best = o; }
    }
    if (best && bestDelta <= MATCH_TOLERANCE_MS) { used.add(best.id); targetFor.set(p.id, best); }
  }
  return { targetFor, consumedIds: used };
}

// Recursively walks a packet's decoded field tree (see _extract114Args'
// comment above for why this is a full walk rather than a few guessed
// paths) collecting every leaf the SCC itself flagged argument:true — i.e.
// an actual value the ground supplied, not a fixed CCSDS/PUS header field.
// Confirmed live against real packets: leaves look like { name, description,
// physicalValue:{value}, rawValue:{value}, unit }.
function _collectArguments(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.subContainers) && node.subContainers.length) {
    for (const child of node.subContainers) _collectArguments(child, out);
    return;
  }
  if (node.argument === true) {
    const value = node.physicalValue?.value ?? node.rawValue?.value ?? null;
    // Confirmed live: TC_11_4's own GENE_AR_TCPACKET field is a real
    // argument:true leaf that's genuinely always empty (value AND
    // description both null — an embedded-packet reference this endpoint
    // doesn't expand) — carries zero information, so skip it rather than
    // show a blank row. Anything with an actual value (including falsy
    // ones like 0 or an empty string) or at least a description still shows.
    if (value == null && !node.description) return;
    out.push({ name: node.name, description: node.description, value, unit: node.unit });
  }
}

// The expanded detail block a TC row's click reveals — packet.raw is the
// untouched original fetch result (see _fetchTcPackets), so this needs no
// network round trip.
function _tcArgsDetailHTML(packet) {
  if (!packet) return `<div class="co-tt-note">Packet no longer available</div>`;
  const args = [];
  _collectArguments(packet.raw?.spacePacket?.rootContainer, args);
  if (!args.length) return `<div class="co-tt-note">No decoded arguments for ${packet.name}</div>`;
  const rows = args.map(a => `<div class="pa-tc-arg-row"${a.description ? ` title="${a.description}"` : ''}>
    <span class="pa-tc-arg-name">${a.name}</span>
    <span class="pa-tc-arg-val">${a.value != null ? a.value : '—'}${a.unit ? ` ${a.unit}` : ''}</span>
  </div>`).join('');
  return `<div class="pa-tc-args-title">${packet.name}</div><div class="pa-tc-args-rows">${rows}</div>`;
}

// One detail block open at a time — closes any other before opening a new
// one, so the list doesn't grow unboundedly tall as rows get clicked.
function _toggleTcDetail(row) {
  const next = row.nextElementSibling;
  if (next?.classList.contains('pa-tc-detail')) {
    next.remove();
    row.classList.remove('pa-tc-row-open');
    return;
  }
  const rowsContainer = row.parentElement;
  rowsContainer.querySelectorAll('.pa-tc-detail').forEach(d => d.remove());
  rowsContainer.querySelectorAll('.pa-tc-row-open').forEach(r => r.classList.remove('pa-tc-row-open'));
  const packet = _lastTcPackets?.find(p => p.id === row.dataset.id);
  const detail = document.createElement('div');
  detail.className = 'pa-tc-detail';
  detail.innerHTML = _tcArgsDetailHTML(packet);
  row.after(detail);
  row.classList.add('pa-tc-row-open');
}

// 'asc' (oldest first, the original fetch order) or 'desc' (newest first) —
// module-level so it persists across re-renders (switching pass/satellite)
// like a normal sort preference, until the toggle button is clicked again.
let _tcSortDir = 'asc';

function _tcPacketsHTML(packets) {
  if (packets == null) return `<div class="co-tt-note">TC packet list unavailable (SCC unreachable)</div>`;
  if (!packets.length) return `<div class="co-tt-note">No TC packets found in this pass window</div>`;

  // Matching runs on the packets in their original (fetched) order — the
  // nearest-timestamp search doesn't care which end it starts from — only
  // the DISPLAY order respects the sort toggle, applied after merging so a
  // TC_11_4 row's own timestamp (not its now-absorbed target's) is what's
  // sorted on.
  const { targetFor, consumedIds } = _matchScheduledTargets(packets);

  const rows = packets
    .filter(p => !consumedIds.has(p.id)) // shown merged into its scheduling TC_11_4's own row instead, not listed twice
    .sort((a, b) => _tcSortDir === 'asc'
      ? (a.generationTime ?? 0) - (b.generationTime ?? 0)
      : (b.generationTime ?? 0) - (a.generationTime ?? 0))
    .map(p => {
      const timeHtml = `<span class="pa-tc-time">${p.generationTime != null ? _fmtTimeMs(p.generationTime) : '—'}</span>`;
      const target = targetFor.get(p.id);
      if (!target) {
        return `<div class="pa-tc-row"${p.generationTime != null ? ` data-t="${p.generationTime}"` : ''} data-id="${p.id}" title="${p.description}">
          ${timeHtml}
          <span class="pa-tc-label">${p.name}</span>
        </div>`;
      }
      const ssid = p.args114?.ssid;
      const date = p.args114?.date;
      const argsHtml = [
        `SSID ${ssid != null ? ssid : '?'}`,
        date != null ? _fmtArgDate(date) : null,
      ].filter(Boolean).join(' · ');
      // No "TC_11_4" label or "≫" arrow — this row's own accent color
      // (.pa-tc-row-114) already marks it as a scheduling envelope, so
      // neither added anything the color didn't already say; the target's
      // name is the part that actually varies and matters.
      // data-id points at the TARGET (not this envelope, p) — its arguments
      // are the ones actually worth expanding into; the envelope's own
      // (SSID/date) are already shown inline above.
      return `<div class="pa-tc-row pa-tc-row-114"${p.generationTime != null ? ` data-t="${p.generationTime}"` : ''} data-id="${target.id}" title="${p.description}">
        ${timeHtml}
        <span class="pa-tc-args">${argsHtml}</span>
        <span class="pa-tc-label pa-tc-label-target" title="${target.description}">${target.name}</span>
      </div>`;
    }).join('');

  const trunc = packets.length === TC_MAX_LIMIT
    ? `<div class="pa-tc-trunc">Showing first ${TC_MAX_LIMIT} — this pass may have sent more</div>`
    : '';
  return `<div class="pa-tc-rows">${rows}</div>${trunc}`;
}

// Procedure HISTORY (which named procedures ran, with status/duration) — a
// small standalone copy of PassDetailPanel.js's inline version (adds
// duration, unlike passTooltip.js's lighter hover copy) rather than exporting
// a shared helper, to keep this POC additive-only and not touch working code.
// The routine (STEP/STATUS/INFO/TIME) report used to sit permanently next to
// this list — that space is now the full-pass log panel instead (see
// _fetchFullPassLog below), so the report moved to a hover tooltip on each
// procedure pill here instead (data-report-* attributes, wired by
// _wireProcReportHovers), scoped to just that ONE procedure's own window.
const _PROC_CLS = { SUCCESS: 'co-tt-ok', FAILURE: 'co-tt-fail', CANCELLED: 'co-tt-cancelled' };

function _procHistoryHTML(pass, grafanaHost, sat) {
  if (!pass.procedures?.length) return `<div class="co-tt-proc co-tt-ok">● PASS OCCURRED</div>`;
  const rows = pass.procedures.map((pr, i) => {
    const cls  = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const num  = `<span class="co-tt-num">${i + 1}</span>`;
    const name = `<span class="co-tt-pname">${pr.name}</span>`;
    const dur  = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${fmtDuration(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost && pr.startMs && pr.endMs) {
      const fromMs = pr.startMs - LOKI_PROC_PAD_MS, toMs = pr.endMs + LOKI_PROC_PAD_MS;
      const url = grafanaLokiUrl(grafanaHost, fromMs, toMs);
      return `<a href="${url}" target="_blank" rel="noopener" data-grafana-modal data-loki-host="${grafanaHost}" data-loki-start="${fromMs}" data-loki-end="${toMs}" data-loki-nominal-start="${pr.startMs}" data-loki-nominal-end="${pr.endMs}" data-grafana-title="${grafanaModalTitle(sat, pass, pr)}" data-report-host="${grafanaHost}" data-report-start="${fromMs}" data-report-end="${toMs}" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${dur}</a>`;
    }
    return `<div class="co-tt-proc ${cls}" title="${pr.name}">${num}${name}${dur}</div>`;
  }).join('');
  return `<div class="co-tt-procs">${rows}</div>`;
}

// Shared single tooltip element (created once, reused for every pill —
// same "one element per view" pattern as passTooltip.js's factory) showing
// the routine report on hover. Click on the SAME pill still opens the full
// Grafana log pop-up (grafanaModal.js's own delegated listener) — the two
// don't conflict, different event types.
let _procTooltipEl = null;
let _procTooltipHideTimer = null;
let _procReportGen = 0;

function _ensureProcTooltip() {
  if (_procTooltipEl) return;
  _procTooltipEl = document.createElement('div');
  _procTooltipEl.className = 'co-tooltip';
  _procTooltipEl.style.display = 'none';
  document.body.appendChild(_procTooltipEl);
  _procTooltipEl.addEventListener('mouseenter', () => clearTimeout(_procTooltipHideTimer));
  _procTooltipEl.addEventListener('mouseleave', _scheduleHideProcTooltip);
}

function _scheduleHideProcTooltip() {
  clearTimeout(_procTooltipHideTimer);
  _procTooltipHideTimer = setTimeout(() => { _procTooltipEl.style.display = 'none'; }, 300);
}

function _wireProcReportHovers(container) {
  _ensureProcTooltip();
  container.querySelectorAll('.co-tt-proc[data-report-host]').forEach(el => {
    el.addEventListener('mouseenter', async e => {
      clearTimeout(_procTooltipHideTimer);
      const myGen = ++_procReportGen;
      _procTooltipEl.innerHTML = `<div class="co-tt-note">Loading routine report…</div>`;
      _procTooltipEl.style.display = 'block';
      positionTooltip(e, _procTooltipEl);
      const report = await fetchProcedureReport(el.dataset.reportHost, Number(el.dataset.reportStart), Number(el.dataset.reportEnd));
      if (myGen !== _procReportGen || _procTooltipEl.style.display === 'none') return; // superseded or already hidden
      _procTooltipEl.innerHTML = procedureReportHTML(report);
      positionTooltip(e, _procTooltipEl);
    });
    el.addEventListener('mouseleave', _scheduleHideProcTooltip);
  });
}

// Scrolls the permanent full-pass-log panel to whichever line landed at or
// just after targetMs and flashes it — same visual treatment createErrorNav
// (logView.js) already uses for jumping to an error line, just driven by a
// procedure's start time instead of an error index.
function _scrollLogToTime(targetMs) {
  const body = _body?.querySelector('.pa-full-log-body');
  if (!body || !_lastFullLogLines?.length) return;
  let idx = _lastFullLogLines.findIndex(l => l.ts / 1e6 >= targetMs);
  if (idx === -1) idx = _lastFullLogLines.length - 1; // procedure starts after the last fetched line — land on the closest thing there is
  const el = body.querySelector(`.grm-log-line[data-idx="${idx}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  body.querySelectorAll('.grm-log-flash').forEach(f => f.classList.remove('grm-log-flash'));
  void el.offsetWidth; // restart the animation if it's already mid-flash from a previous jump to the SAME line
  el.classList.add('grm-log-flash');
}

// Clicking a procedure jumps the full pass log to its start instead of
// opening grafanaModal.js's pop-up — data-loki-nominal-start (already set by
// _procHistoryHTML for the report-hover/dimming logic) is the procedure's
// own real start time, exactly what's needed here too.
function _wireProcLogJump(container) {
  container.querySelectorAll('.co-tt-proc[data-loki-nominal-start]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // let a real new-tab request through, same guard grafanaModal.js's own listener uses
      e.preventDefault();
      e.stopPropagation(); // keeps grafanaModal.js's document-level [data-grafana-modal] listener from also firing and opening the pop-up
      _scrollLogToTime(Number(el.dataset.lokiNominalStart));
    });
  });
}

// Full pass log — replaces the permanent routine-report panel (see above).
// Same padding convention PassDetailPanel.js's own "Raw logs ↗" link uses
// for a whole-pass window (narrower than a single procedure's, since this
// only needs to bracket AOS/LOS, not absorb per-procedure timing drift).
const FULL_LOG_PAD_MS = 30_000;

async function _fetchFullPassLog(grafanaHost, pass) {
  if (!grafanaHost) return null;
  return queryLoki(grafanaHost, '{service_name="/scc"}', pass.start.getTime() - FULL_LOG_PAD_MS, pass.end.getTime() + FULL_LOG_PAD_MS, 5000);
}

let _body;
// No selectors at all anymore (removed both the pass AND satellite
// dropdowns — the only real entry point is the microscope button in
// PassDetailPanel.js's slide-in, via setSelection() below, which already
// knows the exact satellite+pass to show). _currentSat/_selectedPass just
// track whatever that last call handed over.
let _currentSat = null;
let _selectedPass = null;
let _gen = 0; // guards a slower in-flight render from clobbering a newer selection
let _lastTcPackets = null; // stashed so the sort-direction toggle can re-render without re-fetching
let _tcCursor = null;      // stashed so the toggle can re-wire the hover-drives-chart listeners on the new rows
let _lastFullLogLines = null; // stashed so a later procedure click can jump the log panel without re-fetching

// Keeps the highlighted row/line in view as the cursor sweeps across the
// chart. Checks first so an already-visible match doesn't get rescrolled on
// every pixel of mouse movement — only when it's actually about to go off
// the edge. Instant, not smooth: this can fire many times a second while
// the mouse moves, and a queue of overlapping smooth-scroll animations reads
// as janky, unlike the deliberate one-off "Go to error" jump (which does use
// smooth, in createErrorNav/logView.js — a single discrete action, not a
// per-frame follow).
function _scrollIntoViewIfNeeded(el, container) {
  if (!el || !container) return;
  const elRect = el.getBoundingClientRect();
  const cRect  = container.getBoundingClientRect();
  if (elRect.top < cRect.top || elRect.bottom > cRect.bottom) {
    el.scrollIntoView({ block: 'nearest' });
  }
}

// The reverse direction of the TC-row-hover-drives-cursor wiring below:
// passed as wireLinkedCursor's onCursor hook, so moving the hair cursor on
// the polar plot or Eb/N0 chart highlights whichever TC packet was sent
// closest to that moment — queries the CURRENT rows each call (not a
// snapshot taken at wire time), so it stays correct across a sort-toggle
// re-render.
function _highlightTcRowAt(t) {
  const tcSlot = _body?.querySelector('.pa-tc-slot');
  const rows = [...tcSlot?.querySelectorAll('.pa-tc-row[data-t]') ?? []];
  if (!rows.length) return;
  let nearest = null, bestDiff = Infinity;
  for (const row of rows) {
    const diff = Math.abs(Number(row.dataset.t) - t);
    if (diff < bestDiff) { bestDiff = diff; nearest = row; }
  }
  rows.forEach(row => row.classList.toggle('pa-tc-row-cursor', row === nearest));
  _scrollIntoViewIfNeeded(nearest, tcSlot);
}

function _clearTcRowHighlight() {
  _body?.querySelectorAll('.pa-tc-row-cursor').forEach(row => row.classList.remove('pa-tc-row-cursor'));
}

// Same idea, aimed at the full-pass-log panel instead of the TC list —
// logView.js's renderLogRows() puts a data-t (ms) on every rendered line
// specifically so this and the reverse (log-line-hover-drives-cursor, wired
// where the log panel is drawn below) don't need the raw fetched lines kept
// around just for this lookup.
function _highlightLogLineAt(t) {
  const logBody = _body?.querySelector('.pa-full-log-body');
  const rows = [...logBody?.querySelectorAll('.grm-log-line[data-t]') ?? []];
  if (!rows.length) return;
  let nearest = null, bestDiff = Infinity;
  for (const row of rows) {
    const diff = Math.abs(Number(row.dataset.t) - t);
    if (diff < bestDiff) { bestDiff = diff; nearest = row; }
  }
  rows.forEach(row => row.classList.toggle('grm-log-cursor', row === nearest));
  _scrollIntoViewIfNeeded(nearest, logBody);
}

function _clearLogLineHighlight() {
  _body?.querySelectorAll('.grm-log-cursor').forEach(row => row.classList.remove('grm-log-cursor'));
}

// Re-renders just the TC list from the already-fetched packets (no network) —
// shared by the initial render and the sort-direction toggle button.
function _renderTcList() {
  const tcSlot = _body?.querySelector('.pa-tc-slot');
  if (!tcSlot) return;
  tcSlot.innerHTML = _tcPacketsHTML(_lastTcPackets);
  if (_tcCursor) {
    tcSlot.querySelectorAll('.pa-tc-row[data-t]').forEach(row => {
      const t = Number(row.dataset.t);
      row.addEventListener('mouseenter', () => _tcCursor.driveFromTime(t));
      row.addEventListener('mouseleave', _tcCursor.clear);
    });
  }
  tcSlot.querySelectorAll('.pa-tc-row[data-id]').forEach(row => {
    row.addEventListener('click', () => _toggleTcDetail(row));
  });
}

export function initPassAnalyzer() {
  _body = document.getElementById('pa-body');

  store.subscribe(key => {
    if (key === 'satellites') _resyncCurrentSat();
    if (key === 'satPasses')  _resyncSelectedPass();
  });

  _render();
}

// If the satellite currently open gets removed from the fleet entirely,
// drop back to the empty state rather than keep showing a now-nonexistent
// satellite's stale data.
function _resyncCurrentSat() {
  if (_currentSat && !store.satellites.some(s => s.id === _currentSat.id)) {
    _currentSat = null;
    _selectedPass = null;
    _render();
  }
}

// Keeps _selectedPass pointing at a live object after a satPasses refetch
// (the array is wholesale-replaced each time) — re-found by exact start
// time rather than held as a stale reference, same rationale store.js's
// selectedPass uses this for.
function _resyncSelectedPass() {
  if (!_currentSat || !_selectedPass) return;
  _selectedPass = (store.satPasses[_currentSat.id] ?? []).find(p => p.start.getTime() === _selectedPass.start.getTime()) ?? null;
}

// Entry point for "open this exact pass in the Analyzer" — called from
// PassDetailPanel.js's microscope button, via main.js (see there for why
// this isn't a direct import). The only way anything ever gets shown here.
export function setSelection(sat, pass) {
  if (!sat || !pass) return;
  _currentSat = sat;
  _selectedPass = pass;
  _render();
}

function _currentSelection() {
  if (!_currentSat || !store.satellites.some(s => s.id === _currentSat.id)) return { sat: null, pass: null };
  return { sat: _currentSat, pass: _selectedPass };
}

// Chronological, completed-only (matches setSelection/the microscope
// button's own gating — a future pass has no TC packets/procedures/log for
// this view to show, so stepping onto one would just be a dead end).
function _sortedCompletedPasses(satId) {
  return (store.satPasses[satId] ?? []).filter(p => !p.future).slice().sort((a, b) => a.start - b.start);
}

// The < / > buttons in .pa-details — steps to the adjacent completed pass
// for the SAME satellite, by exact start-time match rather than assuming
// the current pass is still at whatever index it was found at last render
// (satPasses can refetch/reorder between clicks).
function _stepPass(delta) {
  if (!_currentSat || !_selectedPass) return;
  const passes = _sortedCompletedPasses(_currentSat.id);
  const idx = passes.findIndex(p => p.start.getTime() === _selectedPass.start.getTime());
  if (idx === -1) return;
  const next = passes[idx + delta];
  if (!next) return;
  _selectedPass = next;
  _render();
}

async function _render() {
  const myGen = ++_gen;
  const { sat, pass } = _currentSelection();
  if (!sat || !pass) {
    _body.innerHTML = `<div class="pa-empty">Select a satellite and a completed pass to inspect.</div>`;
    return;
  }
  // Reset here, not just at module load — _render() only re-runs for an
  // actual new pass/satellite selection (setSelection, or the satellite-
  // removed fallback in _resyncCurrentSat; a background satPasses refresh of
  // the SAME pass doesn't call this), so without this a sort toggle left on
  // 'desc' from a PREVIOUS, unrelated pass would silently carry over and
  // show newest-at-top on every pass opened after it, not just the one
  // where the button was actually clicked.
  _tcSortDir = 'asc';
  const grafanaHost = satSubsystemHost(sat.noradId, 'sccRo') || null;
  // Same time window _fetchFullPassLog queries below — this link should
  // always point at exactly what the panel itself is showing.
  const grafanaLogLink = grafanaHost
    ? `<a class="pa-full-log-grafana" href="${grafanaLokiUrl(grafanaHost, pass.start.getTime() - FULL_LOG_PAD_MS, pass.end.getTime() + FULL_LOG_PAD_MS)}" target="_blank" rel="noopener">Open in Grafana ↗</a>`
    : '';

  _body.innerHTML = `
    <div class="pa-main-row">
      <div class="pa-left-top">
        <div class="pa-panel pa-details">
          <div class="pa-pass-nav">
            <button type="button" class="pa-pass-prev" title="Previous pass (same satellite)">‹</button>
            <button type="button" class="pa-pass-next" title="Next pass (same satellite)">›</button>
          </div>
          <div class="co-tt-header"><span class="co-tt-sat-name" style="color:${sat.color}">${sat.name}</span> ${pass.station ?? '—'}${pass.network ? `<span class="co-tt-network">${pass.network}</span>` : ''}</div>
          <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
          <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
          ${passEclipseBarHTML(sat.satrec, pass.start, pass.end)}
        </div>
        <div class="pa-panel pa-procs">
          <div class="pa-panel-title">Procedures</div>
          <div class="proc-history-slot"><div class="co-tt-note">Loading…</div></div>
        </div>
      </div>
      <div class="pa-panel pa-middle">
        <div class="pa-panel-title">Polar plot &amp; TM/TC Eb/N0</div>
        <div class="co-tt-details-row">
          <div class="polar-slot"></div>
          <div class="ebn0-slot"><div class="ebn0-loading">Collecting metrics…</div></div>
        </div>
      </div>
      <div class="pa-panel pa-tc-list">
        <div class="pa-panel-title">TC packets sent <span class="pa-tc-count"></span>
          <button type="button" class="pa-tc-sort" title="Toggle sort direction">Date <span class="pa-tc-sort-arrow">▼</span></button>
          <span class="pa-panel-sub">(SCC tc-packets store)</span>
        </div>
        <div class="pa-tc-slot"><div class="co-tt-note">Loading…</div></div>
      </div>
      <div class="pa-panel pa-full-log">
        <div class="pa-full-log-header">
          <span class="pa-full-log-title">Full pass log</span>
          <div class="pa-full-log-actions">
            ${grafanaLogLink}
            <div class="grm-err-nav" hidden>
              <button type="button" class="grm-err-jump">Go to error</button>
              <button type="button" class="grm-err-prev" title="Previous error">▲</button>
              <span class="grm-err-count"></span>
              <button type="button" class="grm-err-next" title="Next error">▼</button>
            </div>
          </div>
        </div>
        <div class="pa-full-log-body grm-body"><div class="co-tt-note grm-loading">Loading logs…</div></div>
      </div>
    </div>`;

  // < / > pass navigation — disabled past either end of the same
  // satellite's chronological completed-pass list.
  const sortedPasses = _sortedCompletedPasses(sat.id);
  const passIdx = sortedPasses.findIndex(p => p.start.getTime() === pass.start.getTime());
  const prevBtn = _body.querySelector('.pa-pass-prev');
  const nextBtn = _body.querySelector('.pa-pass-next');
  if (prevBtn) {
    prevBtn.disabled = passIdx <= 0;
    prevBtn.addEventListener('click', () => _stepPass(-1));
  }
  if (nextBtn) {
    nextBtn.disabled = passIdx === -1 || passIdx >= sortedPasses.length - 1;
    nextBtn.addEventListener('click', () => _stepPass(1));
  }

  // The button itself is rebuilt on every render (the whole skeleton above
  // is), so its listener needs rewiring each time too — reads/writes the
  // module-level _tcSortDir so the preference still persists across renders.
  const sortBtn = _body.querySelector('.pa-tc-sort');
  if (sortBtn) {
    sortBtn.querySelector('.pa-tc-sort-arrow').textContent = _tcSortDir === 'asc' ? '▲' : '▼';
    sortBtn.addEventListener('click', () => {
      _tcSortDir = _tcSortDir === 'asc' ? 'desc' : 'asc';
      sortBtn.querySelector('.pa-tc-sort-arrow').textContent = _tcSortDir === 'asc' ? '▲' : '▼';
      _renderTcList();
    });
  }

  // Procedure history is synchronous — pass.procedures is already resolved.
  const histSlot = _body.querySelector('.proc-history-slot');
  if (histSlot) {
    histSlot.innerHTML = _procHistoryHTML(pass, grafanaHost, sat);
    _wireProcReportHovers(histSlot);
    _wireProcLogJump(histSlot);
  }

  const coordsPromise = sat.satrec ? fetchPassGsCoords(sat, pass, store.groundStations) : Promise.resolve(null);
  const polarReadyPromise = coordsPromise.then(coords => {
    if (myGen !== _gen) return { polarPoints: null, markers: null };
    let polarPoints = null, markers = null;
    const polarSlot = _body.querySelector('.polar-slot');
    const svg = coords ? buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask) : '';
    if (svg && polarSlot) {
      polarSlot.outerHTML = `<div class="polar-wrap">${svg}
        <button type="button" class="pv-azel-btn" title="Show this pass as an azimuth/elevation (Cartesian) plot">⤢ Cartesian</button>
      </div>`;
      _body.querySelector('.pv-azel-btn')?.addEventListener('click', () =>
        openAzElModal(pass, sat, coords.lat, coords.lon, coords.rxMask));
      polarPoints = computePolarPoints(pass, sat, coords.lat, coords.lon);
      markers = computePolarMarkers(polarPoints, coords.rxMask);
    }
    return { polarPoints, markers };
  });

  const ebn0Promise      = sat.noradId ? fetchEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime(), pass.network) : Promise.resolve(null);
  const tcEbn0Promise    = sat.noradId ? fetchTcEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime()) : Promise.resolve(null);
  const tcPacketsPromise = _fetchTcPackets(sat, pass.start.getTime(), pass.end.getTime());
  const fullLogPromise   = _fetchFullPassLog(grafanaHost, pass);

  const [{ polarPoints, markers }, series, tcSeries, tcPackets, fullLogLines] =
    await Promise.all([polarReadyPromise, ebn0Promise, tcEbn0Promise, tcPacketsPromise, fullLogPromise]);
  if (myGen !== _gen) return;

  const polarEl  = _body.querySelector('.pass-polar');
  const ebn0Slot = _body.querySelector('.ebn0-slot');
  const ebn0Range = { t0: pass.start.getTime(), t1: pass.end.getTime() };
  // ebn0.js's chart defaults to a compact 300×190 viewBox designed for the
  // small hover tooltip / 480px slide-in — stretching THAT via CSS to fill
  // this panel's much wider, uncapped row (SVG width:100% but a fixed
  // height) is what flattened every circular marker into an ellipse.
  // Redrawing it at a width that matches this row's ACTUAL measured space
  // (rather than a guessed constant) makes width:100% render at a 1:1
  // match with its own viewBox, so there's no stretch to deform anything —
  // genuinely wide, not a small chart blown up. Falls back to 480 if the
  // row can't be measured yet (shouldn't happen; this runs after the
  // skeleton — including this same flex row — is already in the DOM).
  const detailsRow = _body.querySelector('.pa-middle .co-tt-details-row');
  const rowWidth   = detailsRow?.getBoundingClientRect().width || 480;
  const POLAR_W    = 200, ROW_GAP = 8; // matches passPolar.js's fixed 200px SVG + .co-tt-details-row's gap:8px
  const chartWidth  = Math.max(220, Math.round(rowWidth - POLAR_W - ROW_GAP));
  const chartHeight = 160; // shorter than the compact tooltip's 190 — a wide/short banner reads better at this width than a tall one
  if (ebn0Slot) ebn0Slot.outerHTML = ebn0HTML(series, markers, pass.procedures, ebn0Range, tcSeries, chartWidth, chartHeight);
  const ebn0El = _body.querySelector('.ebn0-chart');
  const cursor = wireLinkedCursor(polarEl, polarPoints, ebn0El, series, pass.procedures, tcSeries, ebn0Range,
    t => {
      if (t == null) { _clearTcRowHighlight(); _clearLogLineHighlight(); }
      else            { _highlightTcRowAt(t);  _highlightLogLineAt(t); }
    });
  _tcCursor = cursor;

  // Full pass log — same rendering/error-highlighting logView.js gives the
  // click-triggered pop-up (grafanaModal.js), just drawn into a permanent
  // div instead of an overlay, and with no procedure boundary to dim around
  // (this spans the whole pass, so every line is equally "in bounds").
  const fullLogBody = _body.querySelector('.pa-full-log-body');
  const fullLogNav  = _body.querySelector('.pa-full-log .grm-err-nav');
  if (fullLogBody) {
    if (fullLogLines == null) {
      fullLogBody.innerHTML = `<div class="co-tt-note">Could not reach Grafana/Loki</div>`;
    } else if (!fullLogLines.length) {
      fullLogBody.innerHTML = `<div class="co-tt-note">No log lines found in this pass window</div>`;
    } else {
      const { html, errorIndices } = renderLogRows(fullLogLines);
      fullLogBody.innerHTML = html;
      if (fullLogNav) createErrorNav(fullLogNav, fullLogBody).setErrorIndices(errorIndices);
      // Reverse direction: hovering a log line drives the same shared
      // cursor a TC row hover does — same third-entry-point idea, just
      // from the log side. data-t comes straight off the row (set by
      // renderLogRows), no separate lines array needed.
      fullLogBody.querySelectorAll('.grm-log-line[data-t]').forEach(row => {
        const t = Number(row.dataset.t);
        row.addEventListener('mouseenter', () => cursor.driveFromTime(t));
        row.addEventListener('mouseleave', cursor.clear);
      });
    }
  }
  _lastFullLogLines = fullLogLines; // read later by _scrollLogToTime when a procedure link is clicked

  const tcCount = tcPackets == null ? '—' : (tcPackets.length === TC_MAX_LIMIT ? `${TC_MAX_LIMIT}+` : String(tcPackets.length));

  const tcCountEl = _body.querySelector('.pa-tc-count');
  if (tcCountEl) tcCountEl.textContent = tcPackets == null ? '' : `(${tcCount})`;

  // Hovering a TC row drives the same hair cursor the polar plot / Eb/N0
  // chart already drive each other with (see passCursor.js) — lets you see
  // exactly where in the pass a given command landed, same mechanism, just a
  // third entry point into it. _renderTcList wires this each time it draws
  // the rows (initial render here, and again on every sort-toggle click).
  _lastTcPackets = tcPackets;
  _renderTcList();
}
