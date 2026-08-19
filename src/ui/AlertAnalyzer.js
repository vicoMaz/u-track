// Alert Analyzer — browses the full GROUND + ON_BOARD alert history for one
// satellite at a time (satAlerts.js), filterable by source and severity, with
// a free-text search over the message. Same "pick a satellite, look at its
// data" shape as Scheduler.js's own satellite picker, just read-only.
//
// Repeat alerts (same source+parameter firing over and over, any severity or
// value — a stuck threshold, a flapping parameter) collapse into ONE row
// with an Occurrence count rather than flooding the list with near-identical
// lines — see _groupAlerts below. The Occurrence column is itself sortable
// (alongside Date) specifically so the noisiest parameter — the prime
// candidate for "this alarm is tuned too sensitive" — surfaces at a glance
// during a steady-state tuning pass, not just chronologically.
//
// The histogram above the table (_histogramSVG) is a from-scratch SVG chart,
// not a reuse of ebn0.js's own buildEbn0SVG — that module's scales/bars are
// wired specifically for a [time × dB] curve plus its own TC/TM rate-based
// histograms, none of which apply here. What IS carried over deliberately is
// its shape: an SVG viewBox stretched to 100% width (stays crisp/responsive
// at any panel size, unlike a fixed-resolution <canvas>), a shared center
// line with two directions of stacked bars growing away from it (same
// "away from center = the other category" reading ebn0.js's own TC-sent-up/
// TM-received-down split already established in this app), and per-segment
// <title> tooltips instead of a custom hover system.
import { store } from '../store.js';
import { satIsSimulated } from '../satSimu.js';
import { fetchSatAlerts } from '../satAlerts.js';
import { fetchBoardEventPacket } from '../satBoardEventTm.js';
import { fetchSatPasses } from '../satPasses.js';
import { schedulePlanFetch } from '../planData.js';
import { computeEclipseWindows } from '../satEclipse.js';
import { positionTooltip } from './passTooltip.js';
import { escapeHtml } from './logView.js';
import { SEV, SEV_COLOR } from './severity.js';

let _satId          = null;
let _alerts          = null; // null = not yet loaded/unreachable, undefined = loading, Array = loaded
// Same checked-= shown checklist shape as severity below.
let _sourceFilter    = new Set(['GROUND', 'ON_BOARD']);
// Checked = shown, values are the normalized 1-4 tier (satAlerts.js's own
// _severityTier — see there for why this is a number, not a source-specific
// word). Tier 1 (mildest) unchecked by default — it's also by far the
// noisiest in practice, so starting with it hidden means the table/histogram
// both open on the signal worth triaging first, not buried under it.
let _severityFilter  = new Set([2, 3, 4]);
let _groupByHk       = false; // "Merge by HK packet" toggle (Source popover) — see _groupAlerts' own comment
let _sortKey         = 'date'; // 'date' | 'count' — which column header was last clicked
let _sortDir         = 'desc'; // 'desc' = newest-first (date) / most-occurrences-first (count)
let _fetchGen        = 0; // guards a slower fetch from a previous satellite landing after a newer one's
let _lastGroups      = new Map(); // key → group, refreshed every _renderTable() — read by the occurrence hover tooltip
// { t0, t1 } in ms, bucket-aligned — the manually zoomed/panned histogram
// window (see _wireHistogramZoomPan below), or null for the default
// "auto-fit to whatever the current filters return" behavior. Once set,
// this ALSO drives the table below (see _filteredAlerts) — panning/zooming
// the chart is how an operator narrows the whole view to a time range, not
// just the chart's own x-axis.
let _histZoom = null;

// Eclipse/Passes/Plans vertical-band overlay on the histogram — mutually
// exclusive (one active at a time, like a radio group; clicking the active
// one turns it back off) since all three would just paint the same strip of
// chart in three overlapping colors at once, defeating the point of "see
// when X happens" for any single X. null = no overlay showing.
let _bandMode = null; // null | 'eclipse' | 'passes' | 'plans'
// Per-satellite data cache for each band type — null: not fetched/computed
// for the CURRENTLY selected satellite yet, undefined: fetch/compute in
// flight, Array: ready. Reset to null on every satellite switch (see
// _selectSatellite); only actually (re)populated lazily, on first toggle-on,
// not eagerly for every satellite passing through the selector — eclipse in
// particular is a real SGP4 propagation cost not worth paying for a mode the
// operator may never open.
let _eclipseWindows = null;
let _passBands       = null;
let _planBands        = null;
let _bandGen          = 0; // guards a slower fetch/compute from a previous satellite (or a stale toggle) landing after a newer one's — same shape as _fetchGen above
// Matches satAlerts.js's own LOOKBACK_MS — the same horizon the alert
// history itself spans, so a band toggle never runs dry on data before the
// alerts/histogram it's meant to explain do.
const BAND_LOOKBACK_MS = 7 * 24 * 3_600_000;
const _BAND_LABEL = { eclipse: 'Eclipse', passes: 'Passes', plans: 'Plans' };
const _BAND_COLOR = { eclipse: '#008cff', passes: '#00cc66', plans: '#ff8c00' }; // blue/green/orange — distinct from every severity color already on this chart (SEV_COLOR), so a band never reads as a 5th severity tier

const _SOURCE_LABEL = { GROUND: 'Ground', ON_BOARD: 'Board' };

// passTooltip.js's own fmtDateTimeShort slices off seconds (built for a
// top-bar/tooltip glance, where a minute's resolution is enough) — an alert
// timeline needs finer resolution than that to tell apart, or even just
// order, a burst of near-simultaneous board/ground events.
function _fmtDateTimeSec(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Occurrence-count hover tooltip — same self-contained .co-tooltip + grace-
// period-on-leave shape SatInfo.js's own _attTooltip uses, created once here
// rather than per-row since rows get rebuilt wholesale on every _renderTable().
const _occTooltip = document.createElement('div');
_occTooltip.className = 'co-tooltip';
_occTooltip.style.display = 'none';
document.body.appendChild(_occTooltip);
let _occHideTimer = null;
const _cancelOccHide   = () => clearTimeout(_occHideTimer);
const _scheduleOccHide = () => { clearTimeout(_occHideTimer); _occHideTimer = setTimeout(() => { _occTooltip.style.display = 'none'; }, 300); };
_occTooltip.addEventListener('mouseenter', _cancelOccHide);
_occTooltip.addEventListener('mouseleave', _scheduleOccHide);

// Guards the async TM-packet lookup below against a slower fetch resolving
// after a newer hover already moved on (or the tooltip's since closed) —
// same "per-element generation counter" shape passTooltip.js's own
// hydratePassGeometry/hydrateScheduledProcedures use for the identical
// reason, just module-scoped since _occTooltip is a shared singleton here
// too, reused for both the occurrence list and this.
let _boardTtGen = 0;

// Shares _occTooltip with the occurrence-count hover above (mutually
// exclusive — a row hover only ever lands on one or the other cell) rather
// than a second tooltip element. Shows a "Looking up…" placeholder
// synchronously (satBoardEventTm.js's own fetch is a real network round
// trip, cached per alert.id after the first hover) so the tooltip never
// looks broken/empty while it resolves.
function _showBoardEventTooltip(e, group) {
  const sat = _sat();
  if (!sat) return;
  _cancelOccHide();
  _occTooltip.innerHTML = '<div class="co-tt-header">TM packet</div><div class="co-tt-note">Looking up…</div>';
  _occTooltip.style.display = 'block';
  positionTooltip(e, _occTooltip);
  const myGen = ++_boardTtGen;
  fetchBoardEventPacket(sat, group.latest).then(pkt => {
    if (myGen !== _boardTtGen || _occTooltip.style.display === 'none') return; // superseded by a newer hover, or closed already
    _occTooltip.innerHTML = pkt
      ? `<div class="co-tt-header">${escapeHtml(pkt.name)}</div>
         <div class="aa-occ-tt-row">${escapeHtml(pkt.description)}</div>
         <div class="aa-occ-tt-row">Onboard: ${pkt.onBoardTime ? _fmtDateTimeSec(pkt.onBoardTime) : '—'}</div>
         <div class="aa-occ-tt-row">Received: ${pkt.receptionTime ? _fmtDateTimeSec(pkt.receptionTime) : '—'}</div>`
      : '<div class="co-tt-header">TM packet</div><div class="co-tt-note">No matching TM_5_* packet found nearby</div>';
  });
}

function _sat() {
  return store.satellites.find(s => s.id === _satId) ?? null;
}

// Sticks with whichever satellite was already chosen across a
// store.satellites refresh, rather than resetting to the first one — same
// convention Scheduler.js's own _renderSelector uses.
function _renderSelector() {
  const select = document.getElementById('aa-sat-select');
  if (!select) return;
  const prev = _satId;
  if (!store.satellites.length) {
    select.innerHTML = '<option value="">— no satellites loaded —</option>';
    _selectSatellite(null);
    return;
  }
  select.innerHTML = store.satellites.map(s => {
    const label = satIsSimulated(s.noradId) ? `${s.name}  🧪 SIM` : s.name;
    return `<option value="${s.id}" style="color:${s.color}">${label}</option>`;
  }).join('');
  const stillThere = prev && store.satellites.some(s => s.id === prev);
  const nextId = stillThere ? prev : store.satellites[0].id;
  select.value = nextId;
  if (nextId !== prev) _selectSatellite(nextId);
}

async function _selectSatellite(satId) {
  _satId    = satId;
  _alerts   = undefined; // loading
  _histZoom = null; // a manually-picked absolute time window almost never still makes sense against a DIFFERENT satellite's own alert history
  // A different satellite's own eclipse/pass/plan history — re-fetched
  // lazily below only if a band mode is actually active right now, same
  // "don't pay for a mode that isn't open" reasoning _ensureBandData itself
  // documents.
  _eclipseWindows = null;
  _passBands       = null;
  _planBands        = null;
  _updateBandButtons();
  _render();
  const sat = _sat();
  if (!sat) { _alerts = null; _render(); return; }
  if (_bandMode) _ensureBandData(_bandMode);
  const myGen = ++_fetchGen;
  const result = await fetchSatAlerts(sat);
  if (myGen !== _fetchGen) return; // superseded by a newer selection
  _alerts = result;
  _render();
}

// Lazily loads whichever band's data isn't cached yet for the currently
// selected satellite — a no-op if it's already loaded (an Array) or already
// in flight (undefined); only genuinely fetches/computes from a fresh null.
function _ensureBandData(mode) {
  const sat = _sat();
  if (!sat) return;
  const t1 = Date.now(), t0 = t1 - BAND_LOOKBACK_MS;
  const myGen = ++_bandGen;
  if (mode === 'eclipse') {
    if (_eclipseWindows !== null) return;
    _eclipseWindows = undefined;
    computeEclipseWindows(sat, t0, t1, windows => {
      if (myGen !== _bandGen || _satId !== sat.id) return; // superseded by a newer satellite/toggle
      _eclipseWindows = windows;
      _updateBandButtons();
      if (_bandMode === 'eclipse') _renderHistogram();
    });
  } else if (mode === 'passes') {
    if (_passBands !== null) return;
    _passBands = undefined;
    fetchSatPasses(sat).then(() => {
      if (myGen !== _bandGen || _satId !== sat.id) return;
      _passBands = (store.satPasses[sat.id] ?? []).map(p => ({ start: p.start.getTime(), end: p.end.getTime() }));
      _updateBandButtons();
      if (_bandMode === 'passes') _renderHistogram();
    });
  } else if (mode === 'plans') {
    if (_planBands !== null) return;
    _planBands = undefined;
    schedulePlanFetch(sat, t0, t1, plans => {
      if (myGen !== _bandGen || _satId !== sat.id) return;
      _planBands = plans.map(p => ({ start: p.start, end: p.end }));
      _updateBandButtons();
      if (_bandMode === 'plans') _renderHistogram();
    });
  }
}

// Toolbar toggle handler — clicking the mode already active clears it back
// to null (off) instead of re-triggering it, same "click again to undo" idea
// _setSort below uses for direction instead of mode.
function _setBandMode(mode) {
  _bandMode = _bandMode === mode ? null : mode;
  _updateBandButtons();
  if (_bandMode) _ensureBandData(_bandMode);
  _renderHistogram();
}

function _updateBandButtons() {
  const btnId = { eclipse: 'aa-band-eclipse-btn', passes: 'aa-band-passes-btn', plans: 'aa-band-plans-btn' };
  const cache = { eclipse: _eclipseWindows, passes: _passBands, plans: _planBands };
  for (const mode of ['eclipse', 'passes', 'plans']) {
    const btn = document.getElementById(btnId[mode]);
    if (!btn) continue;
    const active  = _bandMode === mode;
    const loading = active && cache[mode] === undefined;
    btn.classList.toggle('aa-hist-band-btn-active', active);
    btn.textContent = loading ? `${_BAND_LABEL[mode]}…` : _BAND_LABEL[mode];
  }
}

// Collapses alerts into one group each, keeping every individual occurrence
// (full alert object, not just its date — see `latest` below) newest first,
// alongside count and start (= occurrences[0].start, the MOST RECENT
// occurrence — what the Date column and the default newest-first sort both
// show/use; matches "when did this last happen", the more operationally
// relevant question for a repeat alert than "when did it first start").
// Grouped AFTER filtering, not before — filtering narrows to what the
// operator cares about first, then duplicates within THAT set collapse
// together.
//
// Default grouping key is source+eventName ONLY — deliberately ignores
// severity and message/value, so every time this exact parameter fires, at
// ANY severity or with ANY actual value, collapses into the same row and its
// Occurrence count reads as "how often does THIS alarm go off, total". That
// total (sortable via the Occurrence column) is what actually answers "is
// this alarm tuned too sensitive" — splitting the same parameter across
// separate WARNING/DISTRESS rows, or across every slightly different value
// it happened to read, would hide exactly the frequency an operator is
// trying to see. eventName alone is still enough to tell apart two
// DIFFERENT monitoring rules/parameters that happen to share near-identical
// generic content text ("Valeur actuelle [WARNING] TRUE") — the concern the
// key used to also guard against with severity+message is unaffected, since
// eventName was already doing that job on its own. The per-occurrence
// severity/value spread that this key now folds together is still visible
// one hover away, in the Occurrence tooltip (_occurrenceTooltipHTML below).
//
// `groupByHk` (the "Merge by HK packet" toggle, in the Source popover)
// switches GROUND rows only to a coarser key instead: source+HK, with no
// time restriction — every alert off the SAME housekeeping packet collapses
// into one row regardless of when each one fired, a real burst and the same
// HK acting up again days later both read as "this packet is noisy",
// consistent with the default key's own already-unbounded-in-time grouping
// (see above).
function _groupAlerts(alerts, groupByHk) {
  const groups = new Map();
  for (const a of alerts) {
    const useHk = groupByHk && a.source === 'GROUND';
    const key = useHk
      ? `${a.source}|HK|${_parseAlertMessage(a.message).hk}`
      : `${a.source}|${a.eventName}`;
    const g = groups.get(key);
    if (g) g.occurrences.push(a);
    else groups.set(key, { key, source: a.source, hkGrouped: useHk, occurrences: [a] });
  }
  for (const g of groups.values()) {
    g.occurrences.sort((x, y) => y.start.getTime() - x.start.getTime());
    g.dates = g.occurrences.map(o => o.start);
    g.count = g.occurrences.length;
    g.start = g.occurrences[0].start;
    // The exact alert instance the Date column's own timestamp belongs to —
    // TM-packet matching (ON_BOARD rows, satBoardEventTm.js) keys off THIS
    // specific occurrence's own id, not an arbitrary one from the group.
    g.latest = g.occurrences[0];
    g.eventName = g.occurrences[0].eventName; // Param column shows the latest occurrence's own param even when several are collapsed together — full per-occurrence breakdown lives in the Occurrence hover tooltip
    g.message = g.occurrences[0].message;
    // Worst-case severity across every occurrence collapsed into this row —
    // now that the default key no longer pins severity, a parameter that
    // fired WARNING nine times and DISTRESS once shouldn't read as "just
    // WARNING" merely because that happened to be the most recent one.
    let worst = g.occurrences[0];
    for (const o of g.occurrences) if (o.severity > worst.severity) worst = o;
    g.severity = worst.severity;
    g.rawSeverity = worst.rawSeverity;
  }
  return groups;
}

// Shared by the table (grouped afterward) and the histogram (left raw —
// see _histogramSVG's own comment on why volume shouldn't be deduplicated
// away there) — one filter definition so the two views can't drift onto
// different result sets for the "same" current filters.
function _filteredAlerts() {
  let rows = _alerts ?? [];
  rows = rows.filter(a => _sourceFilter.has(a.source));     // checkbox set — an empty set correctly yields "show nothing", not "no filter"
  rows = rows.filter(a => _severityFilter.has(a.severity)); // same
  // Zoomed/panned histogram window (see _histZoom) doubles as a time filter
  // on the table too — an operator narrowing the chart to one afternoon
  // expects the list below to match, not keep showing every alert ever
  // fetched for this satellite.
  if (_histZoom) rows = rows.filter(a => {
    const t = a.start.getTime();
    return t >= _histZoom.t0 && t < _histZoom.t1;
  });
  return rows;
}

function _filteredGroupedSortedAlerts() {
  _lastGroups = _groupAlerts(_filteredAlerts(), _groupByHk);
  const grouped = [..._lastGroups.values()];
  grouped.sort((a, b) => {
    const av = _sortKey === 'count' ? a.count : a.start.getTime();
    const bv = _sortKey === 'count' ? b.count : b.start.getTime();
    return _sortDir === 'asc' ? av - bv : bv - av;
  });
  return grouped;
}

// Shows the normalized 1-4 TIER, not a word — "WARNING" would be wrong for
// a board alert whose real tag is "MEDIUM" (see satAlerts.js's own
// _severityTier). Colored straight off severity.js's existing 5-entry
// SEV_COLOR scale, index 1-4 (index 0/NOMINAL's green never appears here —
// an alert is by definition not nominal). The original SCC tag (rawSeverity)
// is still one hover away via the title, so nothing operationally real gets
// hidden behind the normalization.
function _severityPillHTML(severity, rawSeverity) {
  const tier = Number.isInteger(severity) && severity >= 1 && severity <= 4 ? severity : SEV.WATCH;
  const color = SEV_COLOR[tier];
  const title = rawSeverity ? ` title="${escapeHtml(rawSeverity)}"` : '';
  return `<span class="aa-severity-pill" style="color:${color};border-color:${color}"${title}>${tier}</span>`;
}

// ── Histogram ────────────────────────────────────────────────────────────
// viewBox units — but UNLIKE ebn0.js's own fixed CHART_W, this chart's own
// viewBox WIDTH is set at render time to the container's actual measured
// pixel width (see _renderHistogram/_histogramSVG's `width` param), not a
// constant. This spans the FULL width of the Alert Analyzer panel — a much
// more extreme aspect ratio than ebn0's own moderate-width column — so
// letting preserveAspectRatio="none" stretch a mismatched fixed viewBox to
// fit was visibly distorting the axis text. Matching viewBox width to the
// real box means the browser never needs to stretch X and Y by different
// factors, and (bonus) makes mouse-x → viewBox-x for the cursor below a
// direct 1:1 read, no scale correction needed.
const HIST_H = 170;
// PAD_L wide enough for a 2-3 digit grid value label ("20", "150"). PAD_T/
// PAD_B each carve out a dedicated margin OUTSIDE the plot area (bars only
// ever draw between PAD_T and HIST_H-PAD_B) for the Board/Ground direction
// labels — previously placed just off the center line, where a sufficiently
// tall bucket's own bar could grow right through them; out here nothing
// ever reaches them regardless of the data. PAD_B fits both that label AND
// the tick row below it.
const HIST_PAD_L = 22, HIST_PAD_R = 8, HIST_PAD_T = 20, HIST_PAD_B = 34;
const HIST_BUCKET_MS = 900_000; // 15 min, fixed width — NOT a fixed bucket count
// Stacked outward from the center line in this order (mildest closest to
// the axis, CRITICAL at the tip) — same "worst reaches furthest" reading a
// stacked severity bar should have regardless of direction.
const _SEV_STACK_ORDER = [1, 2, 3, 4];

// Last-rendered domain (t0/t1/width), read by the crosshair math below —
// both the histogram's own mousemove and the table's row-hover both need to
// convert between a time and an x position through the SAME scale that was
// actually drawn. null whenever there's nothing plotted (mirrors _bucketAlerts'
// own null-if-empty), so cursor code can no-op cleanly instead of dividing by it.
let _lastHistDomain = null;

function _histCenterY() { return HIST_PAD_T + (HIST_H - HIST_PAD_T - HIST_PAD_B) / 2; }

// Fixed bucket WIDTH (15 min), not a fixed bucket count — so the bar width
// means the same thing regardless of how much history is in view. t0 floored
// (and t1 ceiled) to a clean bucket boundary — "14:00–14:15" reads far more
// naturally on the axis than "14:07–14:22".
//
// `forcedDomain` (already bucket-aligned — see _histZoom) is what a manual
// zoom/pan overrides this with: the operator has picked a specific window,
// possibly one with NO alerts at all in it right now (panned into empty
// space, or zoomed past the last one), and the chart still needs to draw
// that empty window rather than falling back to auto-fit or "nothing to
// plot". Without it, the domain is the FILTERED set's own min/max — filtering
// down to e.g. just CRITICAL should re-frame the x-axis on when those
// actually happened, not still span whatever the unfiltered data did.
function _bucketAlerts(alerts, forcedDomain) {
  let t0, t1;
  if (forcedDomain) {
    ({ t0, t1 } = forcedDomain);
  } else {
    if (!alerts.length) return null;
    let rawT0 = Infinity, rawT1 = -Infinity;
    for (const a of alerts) {
      const t = a.start.getTime();
      if (t < rawT0) rawT0 = t;
      if (t > rawT1) rawT1 = t;
    }
    t0 = Math.floor(rawT0 / HIST_BUCKET_MS) * HIST_BUCKET_MS;
    t1 = Math.ceil(Math.max(rawT1, rawT0 + HIST_BUCKET_MS) / HIST_BUCKET_MS) * HIST_BUCKET_MS;
  }
  const numBuckets = Math.max(1, Math.round((t1 - t0) / HIST_BUCKET_MS));
  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    t: t0 + i * HIST_BUCKET_MS,
    tEnd: t0 + (i + 1) * HIST_BUCKET_MS,
    board:  { 1: 0, 2: 0, 3: 0, 4: 0 },
    ground: { 1: 0, 2: 0, 3: 0, 4: 0 },
  }));
  for (const a of alerts) {
    let idx = Math.floor((a.start.getTime() - t0) / HIST_BUCKET_MS);
    if (idx >= numBuckets) idx = numBuckets - 1;
    if (idx < 0) idx = 0;
    const side = buckets[idx][a.source === 'ON_BOARD' ? 'board' : 'ground'];
    if (side[a.severity] !== undefined) side[a.severity]++;
    else side[1]++; // an out-of-range tier still counts SOMEWHERE (mildest) rather than silently vanishing from the total — satAlerts.js's own _severityTier shouldn't ever actually produce one
  }
  return { buckets, t0, t1 };
}

function _bucketSideTotal(side) {
  return _SEV_STACK_ORDER.reduce((sum, k) => sum + side[k], 0);
}

// Compact tick/cursor label — just enough to place a moment in time without
// eating the whole label strip (fmtDateTimeShort's full "YYYY-MM-DD HH:MM
// UTC" is too wide to repeat 5-6 times across one axis, let alone follow the
// mouse).
function _fmtTick(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Picks a "round" gridline step (1/2/5 × a power of 10) landing roughly
// `targetLines` lines between the center line and maxValue — same rounding
// idea any chart library's own auto-gridline logic uses, so e.g. a max of 23
// gets gridlines at 5/10/15/20 rather than something like 23/3 = 7.67.
function _niceGridStep(maxValue, targetLines = 3) {
  const raw = maxValue / targetLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return Math.max(1, step * mag);
}

// Board grows UP from the shared center line, Ground grows DOWN — same
// "two directions of stacked bars off one shared origin" shape ebn0.js's own
// TC-sent-up/TM-received-down histogram uses, just severity-stacked instead
// of ok/failed-stacked. Deliberately built from the RAW filtered alert list
// (_filteredAlerts), not the table's deduplicated groups — collapsing a
// flapping alert down to one row is right for a list meant to be read line
// by line, but wrong for a histogram whose entire point is showing volume
// and frequency over time; deduplicating first would hide exactly that.
//
// `width` is the container's own measured pixel width (see _renderHistogram)
// — see the module-level comment above on why this isn't a fixed constant.
// Eclipse/Passes/Plans overlay (see _bandMode) — full-height translucent
// rects behind everything else (drawn first in _histogramSVG's own template,
// so the grid/bars sit visibly on top rather than under a solid fill).
// Clipped to [t0, t1]: a window can run off either edge of the current,
// possibly zoomed, view — drawing the untrimmed width would just bleed a
// negative/oversized <rect> harmlessly, but clipping keeps the numbers
// sane and matches how the bars themselves are already scoped to the domain.
function _bandRects(t0, t1, xScale) {
  const windows = _bandMode === 'eclipse' ? _eclipseWindows
    : _bandMode === 'passes' ? _passBands
    : _bandMode === 'plans' ? _planBands
    : null;
  if (!windows?.length) return '';
  const y = HIST_PAD_T, h = HIST_H - HIST_PAD_T - HIST_PAD_B;
  const color = _BAND_COLOR[_bandMode];
  return windows.map(w => {
    const s = Math.max(w.start, t0), e = Math.min(w.end, t1);
    if (e <= s) return '';
    const x = xScale(s), x2 = xScale(e);
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(x2 - x, 0.5).toFixed(1)}" height="${h}" fill="${color}" fill-opacity="0.16" class="aa-hist-band"/>`;
  }).join('');
}

function _histogramSVG(alerts, width) {
  const data = _bucketAlerts(alerts, _histZoom);
  if (!data) {
    _lastHistDomain = null;
    return `<svg width="100%" height="${HIST_H}" viewBox="0 0 ${width} ${HIST_H}" xmlns="http://www.w3.org/2000/svg" class="aa-hist-chart">
      <text x="${width / 2}" y="${HIST_H / 2}" text-anchor="middle" dominant-baseline="middle" fill="#4a4a6a" font-size="11" font-family="monospace" font-style="italic">(No alerts to plot)</text>
    </svg>`;
  }
  const { buckets, t0, t1 } = data;
  const xScale  = t => HIST_PAD_L + (t - t0) / (t1 - t0 || 1) * (width - HIST_PAD_L - HIST_PAD_R);
  const centerY = _histCenterY();
  const halfH   = centerY - HIST_PAD_T;
  const barW    = Math.max((width - HIST_PAD_L - HIST_PAD_R) / buckets.length - 1, 1);

  let maxTotal = 1; // shared scale across BOTH directions, so a tall board bar and a tall ground bar stay directly comparable by height alone
  for (const b of buckets) maxTotal = Math.max(maxTotal, _bucketSideTotal(b.board), _bucketSideTotal(b.ground));
  // Stashed for the hover tooltip (_showBucketTooltip) to reverse-lookup a
  // bucket by mouse position without redoing this whole computation.
  _lastHistDomain = { t0, t1, width, buckets };

  const bars = buckets.map(b => {
    const x = xScale(b.t);
    let yUp = centerY;
    const boardRects = _SEV_STACK_ORDER.map(tier => {
      const n = b.board[tier];
      if (!n) return '';
      const h = (n / maxTotal) * halfH;
      yUp -= h;
      const color = SEV_COLOR[tier];
      // No <title> here any more — the richer per-bucket hover tooltip
      // (_showBucketTooltip, wired on the whole chart's mousemove) covers
      // every severity/source in the bucket at once instead of one native,
      // 1s-delayed tooltip per colored segment.
      return `<rect x="${x.toFixed(1)}" y="${yUp.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" fill-opacity="0.85"/>`;
    }).join('');
    let yDown = centerY;
    const groundRects = _SEV_STACK_ORDER.map(tier => {
      const n = b.ground[tier];
      if (!n) return '';
      const h = (n / maxTotal) * halfH;
      const y0 = yDown;
      yDown += h;
      const color = SEV_COLOR[tier];
      return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" fill-opacity="0.85"/>`;
    }).join('');
    return boardRects + groundRects;
  }).join('');

  // Horizontal grid: a "nice" step (1/2/5×10^n) mirrored above/below center,
  // each with its own count label at the left edge — the only way to read an
  // actual NUMBER off a bar's height before this (previously: relative
  // comparison only, real count locked inside a hover). Vertical grid:
  // aligned to the SAME x positions the time ticks use below, so a bar can
  // be read against both axes without hunting for its own tick.
  const gridStep = _niceGridStep(maxTotal);
  const hGridLines = [];
  for (let v = gridStep; v <= maxTotal + 0.001; v += gridStep) {
    const yUp   = centerY - (v / maxTotal) * halfH;
    const yDown = centerY + (v / maxTotal) * halfH;
    hGridLines.push(
      `<line x1="${HIST_PAD_L}" y1="${yUp.toFixed(1)}" x2="${(width - HIST_PAD_R).toFixed(1)}" y2="${yUp.toFixed(1)}" class="aa-hist-grid-h"/>`,
      `<text class="aa-hist-grid-label" x="${(HIST_PAD_L - 4).toFixed(1)}" y="${(yUp + 3).toFixed(1)}" text-anchor="end">${v}</text>`,
      `<line x1="${HIST_PAD_L}" y1="${yDown.toFixed(1)}" x2="${(width - HIST_PAD_R).toFixed(1)}" y2="${yDown.toFixed(1)}" class="aa-hist-grid-h"/>`,
      `<text class="aa-hist-grid-label" x="${(HIST_PAD_L - 4).toFixed(1)}" y="${(yDown + 3).toFixed(1)}" text-anchor="end">${v}</text>`,
    );
  }

  // First/last tick anchored to the edge, rest centered — matches ebn0's own
  // dB-axis convention. Board/Ground direction labels deliberately sit at
  // the RIGHT edge, straddling the center line (not the bottom-left corner,
  // where they used to collide with this very tick row) — same "move to the
  // side the other axis isn't using" fix ebn0's own _quantityAxisSVG applies
  // for its TC/TM labels vs. the left dB-axis ones.
  const TICKS = 6;
  const tickXs = Array.from({ length: TICKS }, (_, i) => xScale(t0 + (t1 - t0) * (i / (TICKS - 1))));
  const vGridLines = tickXs.map(x =>
    `<line x1="${x.toFixed(1)}" y1="${HIST_PAD_T}" x2="${x.toFixed(1)}" y2="${(HIST_H - HIST_PAD_B).toFixed(1)}" class="aa-hist-grid-v"/>`).join('');
  const ticks = tickXs.map((x, i) => {
    const t = t0 + (t1 - t0) * (i / (TICKS - 1));
    const anchor = i === 0 ? 'start' : i === TICKS - 1 ? 'end' : 'middle';
    return `<text class="aa-hist-tick" x="${x.toFixed(1)}" y="${HIST_H - 5}" text-anchor="${anchor}">${_fmtTick(new Date(t))}</text>`;
  }).join('');

  return `<svg width="100%" height="${HIST_H}" viewBox="0 0 ${width} ${HIST_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="aa-hist-chart">
    ${_bandRects(t0, t1, xScale)}
    ${vGridLines}
    ${hGridLines.join('')}
    <text class="aa-hist-axis-label" x="${(width / 2).toFixed(1)}" y="${(HIST_PAD_T - 7).toFixed(1)}" text-anchor="middle">▲ Board</text>
    <text class="aa-hist-axis-label" x="${(width / 2).toFixed(1)}" y="${(HIST_H - HIST_PAD_B + 11).toFixed(1)}" text-anchor="middle">▼ Ground</text>
    <line x1="${HIST_PAD_L}" y1="${centerY.toFixed(1)}" x2="${width - HIST_PAD_R}" y2="${centerY.toFixed(1)}" stroke="#2a2a44" stroke-width="0.8"/>
    ${bars}
    ${ticks}
    <line class="aa-hist-cursor" x1="0" y1="${HIST_PAD_T}" x2="0" y2="${HIST_H - HIST_PAD_B}" visibility="hidden"/>
    <text class="aa-hist-cursor-label" x="0" y="${HIST_PAD_T - 2}" text-anchor="middle" visibility="hidden"></text>
  </svg>`;
}

// Forward: time → x (viewBox units). Used to move the crosshair to a list
// row's own occurrence time on hover. Returns null when there's nothing
// plotted to place a cursor against.
function _histX(t) {
  if (!_lastHistDomain) return null;
  const { t0, t1, width } = _lastHistDomain;
  return HIST_PAD_L + (t - t0) / (t1 - t0 || 1) * (width - HIST_PAD_L - HIST_PAD_R);
}

// Inverse: x (viewBox units, ≈ CSS px within the SVG — see the module-level
// comment on why those match) → time. Used by the histogram's own mousemove.
function _histTimeAt(x) {
  if (!_lastHistDomain) return null;
  const { t0, t1, width } = _lastHistDomain;
  return t0 + (x - HIST_PAD_L) / (width - HIST_PAD_L - HIST_PAD_R || 1) * (t1 - t0);
}

function _showHistCursor(x) {
  const el = document.getElementById('aa-histogram');
  const line  = el?.querySelector('.aa-hist-cursor');
  const label = el?.querySelector('.aa-hist-cursor-label');
  if (!line || !_lastHistDomain) return;
  const { width } = _lastHistDomain;
  const clampedX = Math.max(HIST_PAD_L, Math.min(width - HIST_PAD_R, x));
  line.setAttribute('x1', clampedX.toFixed(1));
  line.setAttribute('x2', clampedX.toFixed(1));
  line.setAttribute('visibility', 'visible');
  if (label) {
    label.setAttribute('x', clampedX.toFixed(1));
    label.textContent = _fmtTick(new Date(_histTimeAt(clampedX)));
    label.setAttribute('visibility', 'visible');
  }
}

function _hideHistCursor() {
  const el = document.getElementById('aa-histogram');
  el?.querySelector('.aa-hist-cursor')?.setAttribute('visibility', 'hidden');
  el?.querySelector('.aa-hist-cursor-label')?.setAttribute('visibility', 'hidden');
}

// Per-bucket breakdown, one line per severity actually present in it — "3
// Ground, 10 Board" per tier, not just a bare total — reuses _occTooltip
// (the row-hover/board-event tooltips never show at the same time as this
// one, so one shared element is enough). Bucket looked up by inverting the
// SAME xScale _histogramSVG just drew with, stashed on _lastHistDomain.
function _bucketTooltipHTML(bucket) {
  const rows = _SEV_STACK_ORDER
    .filter(tier => bucket.ground[tier] > 0 || bucket.board[tier] > 0)
    .map(tier => `<div class="aa-occ-tt-row"><span style="color:${SEV_COLOR[tier]}">Severity ${tier}</span>: ${bucket.ground[tier]} Ground, ${bucket.board[tier]} Board</div>`)
    .join('');
  return `<div class="co-tt-header">${_fmtTick(new Date(bucket.t))}–${_fmtTick(new Date(bucket.tEnd))} UTC</div>`
    + (rows || '<div class="co-tt-note">No alerts in this bucket</div>');
}

// x (viewBox units) → bucket index, or null when out of range / nothing
// plotted. Shared by the tooltip and the table-row highlight below so both
// agree on exactly which bucket the mouse is over.
function _bucketIndexAt(x) {
  if (!_lastHistDomain?.buckets) return null;
  const { t0, buckets } = _lastHistDomain;
  const t = _histTimeAt(x);
  if (t == null) return null;
  const idx = Math.floor((t - t0) / HIST_BUCKET_MS);
  return (idx >= 0 && idx < buckets.length) ? idx : null;
}

function _showBucketTooltip(e, idx) {
  if (idx == null) { _occTooltip.style.display = 'none'; return; }
  _cancelOccHide(); // drop any grace-period hide left pending from a row/board-badge hover elsewhere in the table
  _occTooltip.className = 'co-tooltip'; // in case a wide HK-grouped occurrence tooltip (see above) is what was showing right before the cursor moved here
  _occTooltip.innerHTML = _bucketTooltipHTML(_lastHistDomain.buckets[idx]);
  _occTooltip.style.display = 'block';
  positionTooltip(e, _occTooltip);
}

// Table rows (groups) with at least one occurrence inside the currently
// hovered histogram bucket — lets the crosshair answer "which of the rows
// below is this bucket's count actually about", not just a number in a
// tooltip. A row can straddle many buckets at once (the default grouping
// key folds a parameter's occurrences together with no time limit — see
// _groupAlerts), so this is "any occurrence lands in this hour", not a
// strict one-row-one-bucket mapping.
function _highlightBucketRows(idx) {
  const tbody = document.getElementById('aa-tbody');
  if (!tbody) return;
  tbody.querySelectorAll('.aa-row-bucket-hl').forEach(row => row.classList.remove('aa-row-bucket-hl'));
  if (idx == null) return;
  const bucket = _lastHistDomain.buckets[idx];
  tbody.querySelectorAll('.aa-row').forEach(row => {
    const group = _lastGroups.get(row.dataset.key);
    const inBucket = group?.dates.some(d => d.getTime() >= bucket.t && d.getTime() < bucket.tEnd);
    if (inBucket) row.classList.add('aa-row-bucket-hl');
  });
}

// ── Histogram zoom & pan ─────────────────────────────────────────
// Wheel to zoom (centered on whatever time is under the cursor), click-drag
// to pan — layered on top of the existing hover crosshair/tooltip/row-
// highlight above (still wired on every plain mousemove — see
// _wireHistogramZoomPan) rather than replacing it.

const MIN_ZOOM_MS = HIST_BUCKET_MS * 2; // below this a "zoomed in" bar chart is just one bar with no neighbors to compare it against
// ~20 days, as an ABSOLUTE span rather than a bucket-count multiple — kept
// independent of HIST_BUCKET_MS so a narrower bucket width (15 min, was 1h)
// doesn't also shrink how far out zooming can go; repeatedly zooming out
// otherwise has no ceiling at all.
const MAX_ZOOM_MS = 20 * 24 * 3_600_000;

// Whatever domain is actually on screen right now, zoomed or not — the
// starting point for a fresh wheel/drag gesture, before that gesture has
// produced its own _histZoom yet.
function _currentHistDomain() {
  if (_histZoom) return _histZoom;
  if (_lastHistDomain) return { t0: _lastHistDomain.t0, t1: _lastHistDomain.t1 };
  return null;
}

// Centers+aligns to the hour grid and re-renders — the one place that
// actually assigns _histZoom, so every caller (wheel, drag, and eventually
// anything else) goes through the same clamping.
function _setHistZoom(t0, t1) {
  const span = Math.min(Math.max(t1 - t0, MIN_ZOOM_MS), MAX_ZOOM_MS);
  const mid  = (t0 + t1) / 2;
  t0 = mid - span / 2;
  t1 = t0 + span;
  _histZoom = {
    t0: Math.floor(t0 / HIST_BUCKET_MS) * HIST_BUCKET_MS,
    t1: Math.ceil(t1 / HIST_BUCKET_MS) * HIST_BUCKET_MS,
  };
  _render();
}

function _resetHistZoom() {
  if (!_histZoom) return;
  _histZoom = null;
  _render();
}

// factor < 1 zooms in (shrinks the window), > 1 zooms out — `t` (the time
// under the cursor at the moment of the wheel event) stays at the same
// relative x position after the resize, same "zoom toward the cursor, not
// the middle of the chart" convention every map/chart control uses.
function _zoomAtX(x, factor) {
  const domain = _currentHistDomain();
  const t = _histTimeAt(x);
  if (!domain || t == null) return;
  const span    = domain.t1 - domain.t0;
  const newSpan = span * factor;
  const ratio   = (t - domain.t0) / span;
  _setHistZoom(t - ratio * newSpan, t - ratio * newSpan + newSpan);
}

// { startClientX, domain, rectWidth } while a pan gesture is in progress
// (see _wireHistogramZoomPan's mousedown), else null.
let _histDrag = null;

function _wireHistogramZoomPan(histEl) {
  histEl.addEventListener('wheel', e => {
    if (!_currentHistDomain()) return;
    e.preventDefault(); // this scrolls the chart's own timeline, not the page
    const svg = histEl.querySelector('.aa-hist-chart');
    if (!svg) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    _zoomAtX(x, e.deltaY < 0 ? 0.8 : 1.25); // scroll up = zoom in, scroll down = zoom out
  }, { passive: false });

  function onDragMove(e) {
    if (!_histDrag) return;
    const { startClientX, domain, rectWidth } = _histDrag;
    const pxPerMs = (rectWidth - HIST_PAD_L - HIST_PAD_R) / (domain.t1 - domain.t0 || 1);
    // Dragging right moves the visible window EARLIER (grab-the-content-and-
    // drag-it convention, same direction a trackpad/map pan works), so the
    // delta is subtracted, not added.
    const dtMs = (e.clientX - startClientX) / pxPerMs;
    _setHistZoom(domain.t0 - dtMs, domain.t1 - dtMs);
  }
  function onDragEnd() {
    if (!_histDrag) return;
    _histDrag = null;
    histEl.classList.remove('aa-hist-dragging');
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
  }
  histEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return; // left button only
    const domain = _currentHistDomain();
    const svg = histEl.querySelector('.aa-hist-chart');
    if (!domain || !svg) return;
    _histDrag = { startClientX: e.clientX, domain, rectWidth: svg.getBoundingClientRect().width };
    histEl.classList.add('aa-hist-dragging');
    _occTooltip.style.display = 'none'; // don't leave a stale bucket-hover tooltip floating while panning
    // Window-level (not just histEl) so a fast drag that carries the cursor
    // past the chart's own edge keeps panning instead of silently stalling
    // the moment the pointer leaves the element the listener's attached to.
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    e.preventDefault(); // avoid the browser's own native drag/text-selection starting alongside this
  });

  // Double-click is free real estate here — a plain click has no other
  // meaning on this chart — so it doubles as the obvious "get me back out"
  // for a zoom/pan gesture with no other undo. Same "Reset zoom" the
  // toolbar button (aa-hist-zoom-reset) triggers.
  histEl.addEventListener('dblclick', _resetHistZoom);
}

function _renderHistogram() {
  const el = document.getElementById('aa-hist-svg');
  if (!el) return;
  // 0 while this tab is hidden (display:none has no layout box at all) —
  // falls back to a fixed guess so the very first (invisible) render still
  // produces a valid, if not pixel-perfect, SVG; re-rendered for real via
  // the [data-tab] click listener below the moment the tab actually becomes
  // visible and clientWidth reads its real value.
  const width = el.clientWidth || 900;
  el.innerHTML = (_satId && Array.isArray(_alerts)) ? _histogramSVG(_filteredAlerts(), width) : _histogramSVG([], width);
  const resetBtn = document.getElementById('aa-hist-zoom-reset');
  if (resetBtn) resetBtn.hidden = !_histZoom;
}

function _render() {
  _renderTable();
  _renderHistogram();
}

// Both Date and Occurrence headers share one sort state — clicking the
// column already driving the sort just reverses direction (matches the old
// Date-only behavior), clicking the OTHER one switches the active key and
// resets to 'desc' (newest-first / most-occurrences-first), since flipping
// key AND direction in one click would be surprising.
function _setSort(key) {
  if (_sortKey === key) _sortDir = _sortDir === 'desc' ? 'asc' : 'desc';
  else { _sortKey = key; _sortDir = 'desc'; }
  _renderTable();
}

function _updateSortArrows() {
  const dateArrow = document.getElementById('aa-sort-arrow');
  const occArrow  = document.getElementById('aa-occ-sort-arrow');
  const arrow = _sortDir === 'desc' ? '▼' : '▲';
  if (dateArrow) dateArrow.textContent = _sortKey === 'date' ? arrow : '';
  if (occArrow)  occArrow.textContent  = _sortKey === 'count' ? arrow : '';
}

function _renderTable() {
  const tbody   = document.getElementById('aa-tbody');
  const countEl = document.getElementById('aa-count');
  if (!tbody) return;

  _updateSortArrows();

  if (!_satId) {
    tbody.innerHTML = '<tr><td class="aa-empty" colspan="8">No satellite selected.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (_alerts === undefined) {
    tbody.innerHTML = '<tr><td class="aa-empty" colspan="8">Loading…</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (_alerts === null) {
    tbody.innerHTML = '<tr><td class="aa-empty" colspan="8">Could not reach SCC for this satellite.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const rows = _filteredGroupedSortedAlerts();
  if (countEl) countEl.textContent = `${rows.length} of ${_alerts.length}`;

  // HK repeats across consecutive rows fired by the same packet far more
  // often than it changes — blanked (not re-printed) when it's identical to
  // the row directly above, same "don't repeat what the eye already just
  // read" convention a spreadsheet's own grouped-row display uses. Only
  // ever compares to the IMMEDIATELY preceding row in current sort order,
  // not "have I seen this anywhere above" — re-sorting/filtering changes
  // which rows end up adjacent, and the blanking should track that. Shows a
  // dim ditto mark rather than leaving the cell fully empty — a fully blank
  // cell reads as "no HK packet for this alert" (a real ground alert always
  // has one), not "same as the row above"; the ditto mark plus the title=""
  // tooltip (still the full HK name) makes the dedup visually legible
  // instead of looking like missing data.
  let lastHk = null;
  tbody.innerHTML = rows.length
    ? rows.map(a => {
        const { hk, actual, expected } = _parseAlertMessage(a.message);
        const repeatHk = hk && hk === lastHk;
        lastHk = hk;
        return `
        <tr class="aa-row" data-key="${escapeHtml(a.key)}">
          <td class="aa-td aa-td-date">${_fmtDateTimeSec(a.start)}</td>
          <td class="aa-td"><span class="aa-source-badge aa-source-${a.source.toLowerCase()}${a.source === 'ON_BOARD' ? ' aa-source-board-hoverable' : ''}">${_SOURCE_LABEL[a.source] ?? a.source}</span></td>
          <td class="aa-td">${a.count > 1 ? '—' : _severityPillHTML(a.severity, a.rawSeverity)}</td>
          <td class="aa-td aa-td-occ${a.count > 1 ? ' aa-td-occ-hoverable' : ''}">${a.count > 1 ? `×${a.count}` : '—'}</td>
          <td class="aa-td aa-td-hk${repeatHk ? ' aa-td-hk-repeat' : ''}" title="${escapeHtml(hk)}">${repeatHk ? '〃' : (escapeHtml(hk) || '—')}</td>
          <td class="aa-td aa-td-param">${a.eventName ? `<span class="aa-msg-param">${escapeHtml(a.eventName)}</span>` : '—'}</td>
          <td class="aa-td aa-td-value">${escapeHtml(actual) || '—'}</td>
          <td class="aa-td aa-td-value">${escapeHtml(expected) || '—'}</td>
        </tr>`;
      }).join('')
    : '<tr><td class="aa-empty" colspan="8">No alerts match the current filters.</td></tr>';
}

// Ground's own `content` comes back from SCC as a fixed shape — packet
// name, packet description, then "Valeur actuelle [SEV] "X"" / "Valeur
// nominale "Y"" — split into HK (packet name+description) and the actual/
// expected VALUES alone (French wording stripped entirely — English column
// headers replace it, not a translated label buried in the string) so each
// lands in its own column instead of one long repeated sentence. Board
// alerts don't have this shape (already just one short line, e.g. "Life
// event for STT partition") — that goes entirely into `hk`, actual/expected
// stay empty.
function _parseAlertMessage(message) {
  const lines = (message || '').split('\n').map(l => l.trim()).filter(Boolean);
  const actualLine  = lines.find(l => /^valeur actuelle/i.test(l));
  const nominalLine = lines.find(l => /^valeur nominale/i.test(l));
  const stripValue = (line, prefix) => line ? line.replace(prefix, '').trim().replace(/^"(.*)"$/, '$1') : '';
  const actual   = stripValue(actualLine,  /^valeur actuelle\s*(\[[a-z]+\])?\s*/i);
  const expected = stripValue(nominalLine, /^valeur nominale\s*/i);
  // Just the packet NAME (first remaining line) — its own description line
  // ("Housekeeping of GNC MARK 2 routines") repeats the same handful of
  // words for every packet of that type and added nothing the name itself
  // doesn't already identify; dropped rather than joined in.
  const hk = lines.find(l => l !== actualLine && l !== nominalLine) ?? '';
  return { hk, actual, expected };
}

// Date (+ Param chip once hkGrouped has folded SEVERAL different params into
// one row — the date alone no longer says which of them fired at that
// moment) + the actual value read at that specific occurrence, when there
// is one (Ground only — Board's message never carries a value, see
// _parseAlertMessage). The default (non-HK) key now folds every severity/
// value of the SAME parameter into one row (see _groupAlerts above), so
// this per-occurrence value list is what lets an operator still see exactly
// how a flapping parameter's readings moved across all those firings,
// without needing a separate row per value the way the old key produced.
function _occurrenceTooltipHTML(group) {
  const header = `<div class="co-tt-header">${group.occurrences.length} occurrence${group.occurrences.length === 1 ? '' : 's'}</div>`;
  const rows = group.occurrences.map(o => {
    // Per-occurrence severity — the table row itself no longer shows one for
    // a grouped alert (see _renderTable), since a single pill there can only
    // ever show the group's worst case, silently hiding the spread across
    // however many times it actually fired at other tiers.
    const sev = `<span class="aa-occ-tt-sev">${_severityPillHTML(o.severity, o.rawSeverity)}</span>`;
    const param = group.hkGrouped ? `<span class="aa-msg-param aa-occ-tt-param">${escapeHtml(o.eventName || '—')}</span>` : '';
    const { actual } = _parseAlertMessage(o.message);
    const value = actual ? `<span class="aa-occ-tt-value">${escapeHtml(actual)}</span>` : '';
    return `<div class="aa-occ-tt-row"><span class="aa-occ-tt-date">${_fmtDateTimeSec(o.start)}</span>${sev}${param}${value}</div>`;
  }).join('');
  return header + rows;
}

function _updateFilterBtnBadge(badgeId, checkedCount, total) {
  const badge = document.getElementById(badgeId);
  if (badge) badge.textContent = checkedCount < total ? `(${checkedCount}/${total})` : '';
}

// Both Source and Severity are click-to-open checklist popovers, not
// single-selects — click the header to open, toggle any combination, click
// outside to close. Stays open across multiple checkbox toggles (a native
// <select multiple> closes on every click, which would need a re-open per
// pick), same click-to-open/outside-to-close shape Scheduler.js's own
// procedure-catalog dropdown uses. `parse` converts a checkbox's string
// .value into whatever the filter Set is actually keyed on (Severity's are
// numbers — see satAlerts.js's own _severityTier — Source's stay strings).
function _wireChecklistFilter(btnId, popoverId, badgeId, total, parse, onChange) {
  const btn = document.getElementById(btnId);
  const popover = document.getElementById(popoverId);
  btn?.addEventListener('click', e => {
    e.stopPropagation();
    popover?.classList.toggle('aa-checklist-open');
  });
  popover?.addEventListener('click', e => e.stopPropagation()); // clicking a checkbox/label inside shouldn't bubble to the document listener below and immediately close the popover
  // input[value] — the Source popover also hosts the unrelated "Merge by HK
  // packet" checkbox (see index.html), which deliberately has no value= of
  // its own precisely so it's excluded here rather than being mistaken for
  // a third source option.
  popover?.addEventListener('change', () => {
    const checked = new Set([...popover.querySelectorAll('input[value]:checked')].map(cb => parse(cb.value)));
    onChange(checked);
    _updateFilterBtnBadge(badgeId, checked.size, total);
    _render();
  });
  document.addEventListener('click', () => popover?.classList.remove('aa-checklist-open'));
  _updateFilterBtnBadge(badgeId, popover?.querySelectorAll('input[value]:checked').length ?? total, total);
}

export function initAlertAnalyzer() {
  const select = document.getElementById('aa-sat-select');
  if (!select) return;

  select.addEventListener('change', () => _selectSatellite(select.value || null));

  _wireChecklistFilter('aa-source-btn', 'aa-source-checklist', 'aa-source-btn-badge', 2,
    v => v, set => { _sourceFilter = set; });

  // Severity checkbox .value is always a string — a.severity is a number
  // (satAlerts.js) — so this MUST convert via Number(), or the Set.has()
  // check in _filteredAlerts would never match.
  _wireChecklistFilter('aa-severity-btn', 'aa-severity-checklist', 'aa-severity-btn-badge', 4,
    Number, set => { _severityFilter = set; });

  const hkGroupCheckbox = document.getElementById('aa-hk-group-checkbox');
  hkGroupCheckbox?.addEventListener('change', e => {
    e.stopPropagation(); // own listener already handles this — don't also let it bubble into the Source popover's change handler above
    _groupByHk = hkGroupCheckbox.checked;
    _renderTable(); // grouping only changes the table's own rows — the histogram is always built from the raw, ungrouped alert list regardless
  });

  document.getElementById('aa-th-date')?.addEventListener('click', () => _setSort('date')); // sort only affects the table's own row order — the histogram doesn't have a sort direction, no need to rebuild it too
  document.getElementById('aa-th-occ')?.addEventListener('click', () => _setSort('count'));

  // Delegated (not per-cell) since #aa-tbody's rows are rebuilt wholesale on
  // every _renderTable() — one listener here survives that, no re-wiring
  // needed after each render. Looked back up by the row's own data-key
  // rather than reading the count out of the DOM, since _lastGroups already
  // has the full date list (and each group's own most-recent `start`) right
  // there. Hovering ANY row (not just the occurrence cell) moves the
  // histogram's crosshair to that row's own occurrence time — the occurrence
  // tooltip stays scoped to just its own cell.
  const tbody = document.getElementById('aa-tbody');
  tbody?.addEventListener('mouseover', e => {
    const row = e.target.closest('.aa-row');
    const group = row ? _lastGroups.get(row.dataset.key) : null;
    if (group) {
      const x = _histX(group.start.getTime());
      if (x != null) _showHistCursor(x);
    }
    if (!group) return;
    const occCell = e.target.closest('.aa-td-occ-hoverable');
    if (occCell) {
      _cancelOccHide();
      // .aa-occ-tooltip-wide: HK-grouped rows pack a full param name onto
      // each line (occurrence-tooltip.css comment) — .co-tooltip's default
      // 300px/nowrap combination hard-crops that mid-word (no ellipsis),
      // same widened-variant pattern as .sch-timetag-tooltip. Reset on every
      // other use of this shared element (board/bucket tooltips) below so it
      // doesn't linger from a previous hover.
      _occTooltip.className = group.hkGrouped ? 'co-tooltip aa-occ-tooltip-wide' : 'co-tooltip';
      _occTooltip.innerHTML = _occurrenceTooltipHTML(group);
      _occTooltip.style.display = 'block';
      positionTooltip(e, _occTooltip);
      return;
    }
    const boardBadge = e.target.closest('.aa-source-board-hoverable');
    if (boardBadge) { _occTooltip.className = 'co-tooltip'; _showBoardEventTooltip(e, group); }
  });
  tbody?.addEventListener('mouseout', e => {
    const row = e.target.closest('.aa-row');
    if (row && !row.contains(e.relatedTarget)) _hideHistCursor(); // really leaving the row, not just hopping between its own cells
    if (e.target.closest('.aa-td-occ-hoverable') || e.target.closest('.aa-source-board-hoverable')) _scheduleOccHide();
  });

  // Self-hover on the histogram itself — crosshair line + per-bucket
  // breakdown tooltip both track the mouse together, no grace-period-on-
  // leave needed the way the occurrence tooltip has (nothing stays open to
  // move the mouse into), so hide is immediate. Scoped to #aa-hist-svg (the
  // chart's own drawing surface), NOT the outer #aa-histogram wrap — that
  // wrap also contains the Reset-zoom button now (a sibling), and a
  // mousedown starting there would otherwise bubble into the pan-start
  // handler below and begin dragging the chart out from under the click.
  const histEl = document.getElementById('aa-hist-svg');
  histEl?.addEventListener('mousemove', e => {
    const svg = histEl.querySelector('.aa-hist-chart');
    if (!svg) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    const idx = _bucketIndexAt(x);
    _showHistCursor(x);
    _showBucketTooltip(e, idx);
    _highlightBucketRows(idx);
  });
  histEl?.addEventListener('mouseleave', () => {
    _hideHistCursor();
    _occTooltip.style.display = 'none';
    _highlightBucketRows(null);
  });
  if (histEl) _wireHistogramZoomPan(histEl);
  document.getElementById('aa-hist-zoom-reset')?.addEventListener('click', _resetHistZoom);

  document.getElementById('aa-band-eclipse-btn')?.addEventListener('click', () => _setBandMode('eclipse'));
  document.getElementById('aa-band-passes-btn')?.addEventListener('click', () => _setBandMode('passes'));
  document.getElementById('aa-band-plans-btn')?.addEventListener('click', () => _setBandMode('plans'));

  // The histogram's own viewBox width is measured from the container at
  // render time (see _renderHistogram) — while this tab is hidden that
  // measures 0, so re-render for real once it's actually clicked into view.
  // Same start/stop-on-tab-click convention ChadOps.js/WeeklySchedule.js use
  // for their own tab-visibility-dependent work, just a one-shot re-render
  // here rather than a start/stop ticker (nothing here needs to keep
  // running while hidden in the first place).
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.tab === 'alerts') _renderHistogram(); });
  });

  store.subscribe(key => { if (key === 'satellites') _renderSelector(); });

  _renderSelector();
  _render();
}
