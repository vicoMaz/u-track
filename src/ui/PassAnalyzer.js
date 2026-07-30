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
import { TC_MAX_LIMIT, TC_114_NAME_RE, TC_UNACKED_EXCLUDE, fetchTcPackets, matchScheduledTargets, collectArguments, argUnitLabel, tcAckStatus as _tcAckStatus } from '../tcPackets.js';
import { fetchPassGsCoords, buildPolarSVG, computePolarPoints, computePolarMarkers } from './passPolar.js';
import { fetchProcedureReport, procedureReportHTML } from './procedureReport.js';
import { fetchEbn0Series, fetchTcEbn0Series, fetchTmPacketsCounterSeries, ebn0HTML, copyEbn0ChartPNG, PROC_BAR_STRIP_H, PAD_B, nearestByTime } from './ebn0.js';
import { wireLinkedCursor } from './passCursor.js';
import { openAzElModal } from './passAzElModal.js';
import { fmtDuration, fmtDateTimeShort, fmtTimeOnly, grafanaLokiUrl, grafanaModalTitle, LOKI_PROC_PAD_MS, passEclipseBarHTML, positionTooltip } from './passTooltip.js';
import { queryLoki } from './lokiQuery.js';
import { renderLogRows, createErrorNav } from './logView.js';
import './grafanaModal.js'; // side-effect import: registers the click-to-popup handler used by the co-tt-link anchors below

// fmtTimeOnly (passTooltip.js) only goes down to whole seconds — TC packets
// in the same subschedule burst routinely land within a few ms of each other
// (see module comment above), so this needs its own millisecond-precision
// formatter to actually distinguish them.
function _fmtTimeMs(ms) {
  return new Date(ms).toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// v may be an ISO string, a raw ms number, or (if the field search above
// grabbed the wrong thing) something unparseable — falls back to showing it
// verbatim rather than hiding a value that might still be useful to see.
function _fmtArgDate(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? _fmtTimeMs(ms) : String(v);
}

// Same as _fmtArgDate, but for the TC_11_4 row's own inline SCHEDULE-date
// display — that's a future execution time the ground supplied, not a
// precisely-logged event, so millisecond precision would be false
// precision; whole seconds read better there.
function _fmtArgDateNoMs(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : String(v);
}

// "206ms" / "4.2s" — TC failures happen fast (sub-second to a few seconds),
// where fmtDuration's whole-seconds precision would just show "0m 00s" for
// most of them.
function _fmtShortDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

// The PUS TC verification reports actually worth displaying, in report
// order — shared by the hover tooltip and the click-expanded detail panel so
// both read off the same list rather than two hand-maintained copies.
// 'started'/'progress' are deliberately excluded: confirmed live these never
// come back populated (SCC only ever reports acceptance and completion for
// this app's TCs), so showing them was just two permanent "no report" rows.
// _tcAckStatus below still checks them (acks itself keeps all 4 fields, see
// _fetchTcPackets) in case that ever changes — only the DISPLAY is trimmed.
const _ACK_STAGES = [
  ['acceptance', 'Acceptance (reception by OBSW)'],
  ['completed',  'Completion of execution'],
];

// _tcAckStatus (imported above as tcAckStatus) collapses the 4-stage chain
// into ONE status a row can show at a glance — color says who last spoke
// (grey nobody yet, green good news, red bad news), fill says whether
// that's a FINAL outcome (execution done, one way or the other) or still
// open (hollow):
//   grey hollow  — 'pending'   — sent, no report back yet at all
//   green hollow — 'accepted'  — accepted; execution outcome not in yet
//   green filled — 'exec-ok'   — execution completed successfully
//   red   hollow — 'reject'    — REJECTED at acceptance — never got to execute
//   red   filled — 'exec-fail' — accepted, but execution failed
const _ACK_STATUS_META = {
  reject:    { glyph: '○', cls: 'pa-tc-ack-red' },
  'exec-fail': { glyph: '●', cls: 'pa-tc-ack-red' },
  'exec-ok':   { glyph: '●', cls: 'pa-tc-ack-green' },
  accepted:  { glyph: '○', cls: 'pa-tc-ack-green' },
  pending:   { glyph: '○', cls: 'pa-tc-ack-grey' },
};

// 5s bucket grid shared by both the TC-send and TM-received histograms
// overlaid on the Eb/N0 chart (ebn0.js's _tcHistogramBars/_tmHistogramBars) —
// boundaries are absolute epoch-aligned (not pass-start-aligned), a fixed
// grid being simpler than one that shifts with whichever pass happens to be
// open, and visually indistinguishable at this bucket size. Using the SAME
// constant for both keeps their bars aligned to the same x-positions.
const HIST_BUCKET_MS = 5_000;

// Counts exactly the same set of "one row per command" packets the TC list
// itself shows (_matchScheduledTargets' consumedIds — a TC_11_4's scheduled
// TARGET, absorbed into its own merged row there, is a separately-timed
// nested event and must not be double-counted here): a TC_11_4 envelope
// counts once, using its OWN acceptance/execution outcome, never the
// target's. 'failed' is 'reject' or 'exec-fail' from _tcAckStatus — anything
// else (pending/accepted/exec-ok) counts as a plain, non-failed send.
function _tcSendHistogram(packets) {
  if (!packets?.length) return [];
  const { consumedIds } = matchScheduledTargets(packets);
  const buckets = new Map(); // bucket start ms -> { t, tEnd, sent, failed }
  for (const p of packets) {
    if (consumedIds.has(p.id) || p.generationTime == null) continue;
    const t = Math.floor(p.generationTime / HIST_BUCKET_MS) * HIST_BUCKET_MS;
    let b = buckets.get(t);
    if (!b) { b = { t, tEnd: t + HIST_BUCKET_MS, sent: 0, failed: 0 }; buckets.set(t, b); }
    b.sent++;
    const status = _tcAckStatus(p.acks);
    if (status === 'reject' || status === 'exec-fail') b.failed++;
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// Matches the SCC's own CaduCodec framing-layer error, e.g.:
// "ERROR [...] fr.cnes.scc.packet.codec.internalclasses.caducodec.CaduCodec:
// A packet lost because fhp is not matching the appropriate value..." — one
// line per lost packet, confirmed live (LEONAV-1, CL01-04, 2026-07-28 pass:
// thousands of these during a procedure that went on to report FAILURE).
const CADUCODEC_LOST_RE = /caducodec\.CaduCodec:.*packet lost/i;

// TM-received histogram, paired with the TC-sent one above on the same
// bucket grid. "Received" comes from GNM's own tm_packets_counter — a
// cumulative counter, so each bucket's count is the sum of positive deltas
// between consecutive samples landing in it (a negative delta means the
// counter reset, e.g. a link drop/reconnect mid-pass — skipped rather than
// subtracted, since that's not a real "un-received" packet). "Lost" comes
// from a completely different source (the pass log's own CaduCodec errors,
// see CADUCODEC_LOST_RE above) — there's no packet record for a lost one to
// count from, only the framing layer's own complaint that it happened. Both
// land in the same bucket grid regardless, so the resulting bar totals both.
//
// The pass log feeding "lost" is capped at 5000 lines (_fetchFullPassLog) —
// the SAME cap the "Full pass log" panel itself already lives with. A pass
// lossy enough to blow through that cap (confirmed live on the pass this was
// built against: it did, by 02:25 of a pass whose procedures ran to 02:53)
// will under-report "lost" for whatever the log fetch didn't reach, while
// "received" stays accurate for the whole pass — a known asymmetry, not a
// bug, inherited from the same log fetch the panel already uses.
function _tmReceiveHistogram(counterSamples, logLines) {
  if (!counterSamples?.length && !logLines?.length) return [];
  const buckets = new Map(); // bucket start ms -> { t, tEnd, received, lost }
  const bucketFor = (ms) => {
    const t = Math.floor(ms / HIST_BUCKET_MS) * HIST_BUCKET_MS;
    let b = buckets.get(t);
    if (!b) { b = { t, tEnd: t + HIST_BUCKET_MS, received: 0, lost: 0 }; buckets.set(t, b); }
    return b;
  };
  if (counterSamples?.length) {
    const sorted = counterSamples.slice().sort((a, b) => a.t - b.t);
    for (let i = 1; i < sorted.length; i++) {
      const delta = sorted[i].v - sorted[i - 1].v;
      if (delta > 0) bucketFor(sorted[i].t).received += delta;
    }
  }
  if (logLines?.length) {
    for (const { ts, text } of logLines) {
      if (CADUCODEC_LOST_RE.test(text)) bucketFor(ts / 1e6).lost++; // ts is nanoseconds (see lokiQuery.js)
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// pktId is stashed in a data attribute (not a native `title`) so
// _wireAckTooltips can look the packet back up in _lastTcPackets on hover and
// draw the same stylized _tcVerificationHTML the click-expanded detail panel
// uses, instead of dumping plain text into the browser's own OS tooltip.
// label is passed through as the hover tooltip's own heading when a row
// shows more than one badge (see the TC_11_4 merged row below) so hovering
// either dot says WHICH command it's reporting on — with only one badge per
// row (the common case), the row itself already makes that obvious and
// label is omitted, falling back to _tcVerificationHTML's plain default.
// No positioning concerns here anymore (see _tcStatusClusterHTML, which
// wraps this together with its pill and owns the "push to the row's right
// edge" behavior) — this only ever draws the glyph itself.
function _ackBadgeHTML(acks, { label, pktId } = {}) {
  if (!acks) return '';
  const status = _tcAckStatus(acks);
  if (!status) return '';
  const { glyph, cls } = _ACK_STATUS_META[status];
  const labelAttr = label ? ` data-ack-label="${label}"` : '';
  // title="" (not just omitted) — without it, hovering the badge falls
  // through to the ROW's own title="${p.description}" (the row itself is an
  // ancestor of this span), stacking the browser's native OS tooltip on top
  // of _wireAckTooltips' stylized one. An explicit empty title overrides
  // that inherited lookup for just this element, so only the stylized one
  // shows.
  return `<span class="pa-tc-ack ${cls}" data-pkt-id="${pktId}"${labelAttr} title="">${glyph}</span>`;
}

// Groups a badge together with its own failure/warning pill (if any) into
// ONE flush unit, so the pill sits pinned immediately left of ITS dot
// instead of floating wherever the row's variable-width label/args happen to
// end — a plain CSS gap after the label would leave the pill's position
// drifting with every TC name's length, which is what this replaces.
// `end` (default true) pushes the WHOLE cluster to the row's right edge —
// a merged TC_11_4 row's first cluster (the envelope's own, next to its own
// SSID/date) wants that off, so only the second (target) cluster pushes;
// see _tcPacketsHTML below.
function _tcStatusClusterHTML(acks, { end = true, label, pktId } = {}) {
  const badge = _ackBadgeHTML(acks, { label, pktId });
  if (!badge) return '';
  const pill = _failurePillHTML(acks, pktId);
  return `<span class="pa-tc-status-cluster${end ? ' pa-tc-status-cluster-end' : ''}">${pill}${badge}</span>`;
}

// Same 4 stages, spelled out with their timestamps — the detail panel's
// answer to "why did this fail", a persistent/readable counterpart to the
// row's own hover tooltip (_wireAckTooltips below), which reuses this same
// markup so the two views can't drift out of sync. title defaults to the
// detail panel's plain "Verification" heading; the hover tooltip passes the
// packet's own name instead, since a merged TC_11_4 row's two tooltips need
// to say WHICH command each one is reporting on.
function _tcVerificationHTML(acks, title = 'Verification') {
  if (!acks) return '';
  const rows = _ACK_STAGES.map(([key, desc]) => {
    const a = acks[key];
    if (!a) return `<div class="pa-tc-ver-row pa-tc-ver-none">${desc}<span>no report</span></div>`;
    const cls = a.ack === 'SUCCESS' ? 'pa-tc-ver-ok' : 'pa-tc-ver-fail';
    return `<div class="pa-tc-ver-row ${cls}">${desc}<span>${a.ack} · ${_fmtArgDate(a.time)}</span></div>`;
  }).join('');
  return `<div class="pa-tc-args-title">${title}</div><div class="pa-tc-ver-rows">${rows}</div>`;
}

// Whichever specific ack stage actually carries FAILURE — 'completed' is by
// far the common case, and the only one with a matching TM lookup this SCC
// exposes (PUS TM(1,8) — see _fetchTm18Packet); started/progress failing
// instead is rarer and has no equivalent endpoint here, but "failed after
// X" is still computable from its own timestamp either way. null when the
// packet didn't fail execution at all (acceptance-only rejection isn't an
// EXECUTION failure — see _tcAckStatus's 'reject' vs 'exec-fail' split).
function _tcFailureStage(acks) {
  if (!acks) return null;
  return acks.completed?.ack === 'FAILURE' ? 'completed'
    : acks.progress?.ack === 'FAILURE' ? 'progress'
    : acks.started?.ack === 'FAILURE' ? 'started'
    : null;
}

// Elapsed time from acceptance (OBSW taking the command) to whichever stage
// actually failed — the operationally meaningful "how long did this run
// before it blew up", not wall-clock ground-to-satellite transit. Falls
// back to the packet's own send time only if acceptance itself is somehow
// missing (shouldn't happen once completed/progress/started carries a real
// ack, but this is real telemetry — not assumed clean).
function _tcFailedAfterMs(packet) {
  const stage = _tcFailureStage(packet.acks);
  if (!stage) return null;
  const failedMs = Date.parse(packet.acks[stage].time);
  const beganMs = packet.acks.acceptance?.time ? Date.parse(packet.acks.acceptance.time) : packet.generationTime;
  return (Number.isFinite(failedMs) && beganMs != null) ? Math.max(0, failedMs - beganMs) : null;
}

// The actual telemetry the SCC generated a completion-FAILURE verdict
// from — not part of /tc-packets itself, a separate per-TC lookup keyed by
// exactly the 3 fields the TC record already carries (apid, sourceSeqCount,
// and the completed stage's own onboard time). Confirmed live: gives a real
// failure reason code (see _findFailureCode) the TC record has no
// equivalent of.
async function _fetchTm18Packet(sat, apid, sourceSeqCount, onBoardTimeISO) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!origin || apid == null || sourceSeqCount == null) return null;
  const params = new URLSearchParams({
    sourceSequenceCount: String(sourceSeqCount),
    apid: String(apid),
    onBoardTime: onBoardTimeISO,
  });
  try {
    const res = await fetch(`${origin}/api/v1/tm-1-8-packet?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Confirmed live (LEONAV-1, CL01-01/leaf, 2026-07-25 pass): SCC can emit
// TWO distinct TM(1,8) records at the EXACT same onBoardTime for the same
// apid/TC — the exact-match endpoint above returns whichever one it
// considers canonical, which is not always the one that actually carries
// the failure code (the other, otherwise identical, had it; this one came
// back with the field simply absent). A ±0.5s window search over /tm-packets,
// filtered down to TM(1,8)-named packets that echo THIS TC's own sequence
// count (see _findEchoedSeqCount) is the fallback, and among any duplicates
// it finds, prefers whichever one actually has a code rather than the first
// match.
async function _fetchTm18PacketWindowed(sat, apid, sourceSeqCount, onBoardTimeISO) {
  const origin = satSubsystemOrigin(sat.noradId, 'sccRo');
  const tMs = Date.parse(onBoardTimeISO);
  if (!origin || apid == null || sourceSeqCount == null || !Number.isFinite(tMs)) return null;
  const params = new URLSearchParams({
    start: new Date(tMs - 500).toISOString(),
    end:   new Date(tMs + 500).toISOString(),
    maxLimit: '500',
  });
  try {
    const res = await fetch(`${origin}/api/v1/tm-packets?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const candidates = data.filter(tm =>
      tm.apid === apid &&
      /_1_8_/.test(tm.spacePacket?.name ?? '') &&
      _findEchoedSeqCount(tm.spacePacket?.rootContainer) === sourceSeqCount
    );
    return candidates.find(tm => _findFailureCode(tm.spacePacket?.rootContainer) != null) ?? candidates[0] ?? null;
  } catch { return null; }
}

// PUS(1,8) failure reports carry their own reason code in a field named
// like OBSW_AM_S1_8_CODE — confirmed live (e.g. "S12_UNKNOWN_MID") — but
// it's NOT flagged argument:true (it's metadata about the report itself,
// not something the ground supplied), so the plain _collectArguments walk
// used for TC arguments would miss it. Matched by name SUFFIX rather than
// the exact literal, in case a different subsystem build prefixes it
// differently.
function _findFailureCode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.subContainers) && node.subContainers.length) {
    for (const child of node.subContainers) {
      const found = _findFailureCode(child);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof node.name === 'string' && node.name.endsWith('_S1_8_CODE')) {
    return node.physicalValue?.value ?? node.rawValue?.value ?? null;
  }
  return null;
}

// PUS(1,8) reports echo the ORIGINATING TC's own CCSDS sequence count under
// this exact field name (distinct from GENE_AM_CCSDSCOUNT, which is the TM
// packet's OWN downlink counter) — the correlation key used to verify a
// candidate report is actually THIS command's, and the filter
// _fetchTm18PacketWindowed searches by.
function _findEchoedSeqCount(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.subContainers) && node.subContainers.length) {
    for (const child of node.subContainers) {
      const found = _findEchoedSeqCount(child);
      if (found != null) return found;
    }
    return null;
  }
  if (node.name === 'OBSW_AM_CCSDSCOUNT') {
    return node.physicalValue?.value ?? node.rawValue?.value ?? null;
  }
  return null;
}

// The single entry point both _loadFailureReason (detail panel) and
// _hydrateFailurePills (inline row pill) call — tries the fast exact-match
// lookup first, verifying it actually echoes this TC's own sequence count
// AND carries a code (see _fetchTm18PacketWindowed's comment for why both
// checks matter, not just whether a record came back at all); only falls
// back to the slower windowed search when that fast path comes up short.
async function _resolveFailureCode(sat, apid, sourceSeqCount, onBoardTimeISO) {
  const exact = await _fetchTm18Packet(sat, apid, sourceSeqCount, onBoardTimeISO);
  if (exact && _findEchoedSeqCount(exact.spacePacket?.rootContainer) === sourceSeqCount) {
    const code = _findFailureCode(exact.spacePacket?.rootContainer);
    if (code != null) return code;
  }
  const windowed = await _fetchTm18PacketWindowed(sat, apid, sourceSeqCount, onBoardTimeISO);
  return windowed ? _findFailureCode(windowed.spacePacket?.rootContainer) : null;
}

// One-line "why did this fail" pill shown directly in the FOLDED row, just
// left of its own status dot — unlike _failureAnalysisHTML below (which only
// ever renders once someone clicks a row open), this is meant to surface a
// failure while just scanning the list, so it has to be there before any
// click happens. Rendered for a RED status (reject/exec-fail) — green/grey/
// pending normally has nothing to explain — PLUS one yellow WARNING case
// that's technically 'exec-ok' (see below): a hole in the ack chain, not a
// failed outcome, so it gets its own color rather than reusing red.
// 'reject' and a non-'completed' exec-fail stage are fully synchronous (no
// reason-code lookup exists for either — see _tcFailureStage's own comment).
// A 'completed'-stage failure DOES have one, but it needs the same TM(1,8)
// round trip _loadFailureReason makes for the detail panel — rendered here
// as a "…" placeholder with data-fail-pkt-id, filled in by
// _hydrateFailurePills (wired by _renderTcList) once that resolves.
function _failurePillHTML(acks, pktId) {
  const status = _tcAckStatus(acks);
  // Confirmed live: sometimes a TC's completion report comes back SUCCESS
  // with NO acceptance report ever received at all — genuinely executed
  // fine (hence _tcAckStatus still calls it 'exec-ok', green dot), but the
  // acceptance stage of the verification chain never answered, which is
  // itself worth flagging. Distinct from 'pending' (nothing back yet at
  // all — no completion either) and from 'reject' (acceptance answered, and
  // said no) — this is "acceptance never answered, but it ran anyway".
  // Ops calls this an "Acceptance failure" despite the command itself
  // having succeeded — kept as its own yellow warning pill rather than
  // folded into the red failure ones below, since nothing here actually
  // failed to execute.
  if (status === 'exec-ok' && !acks.acceptance) {
    return `<span class="pa-tc-fail-pill pa-tc-fail-pill-warn" title="Executed successfully, but no acceptance report was ever received — a gap in the verification chain, not a failed command">ACCEPTANCE FAILURE</span>`;
  }
  if (status !== 'reject' && status !== 'exec-fail') return '';
  if (status === 'reject') {
    return `<span class="pa-tc-fail-pill" title="Rejected at acceptance — never executed">REJECTED</span>`;
  }
  const stage = _tcFailureStage(acks); // guaranteed non-null: status is only 'exec-fail' when one of started/progress/completed carries FAILURE
  if (stage !== 'completed') {
    return `<span class="pa-tc-fail-pill" title="Failed during ${stage} — no reason report exists for this stage">FAILED (${stage.toUpperCase()})</span>`;
  }
  return `<span class="pa-tc-fail-pill pa-tc-fail-pill-loading" data-fail-pkt-id="${pktId}" title="Fetching failure reason…">…</span>`;
}

// Rendered synchronously — the duration is already knowable from the
// packet's own timestamps — with a placeholder for the reason, which needs
// a network round trip (see _loadFailureReason, kicked off right after this
// markup lands in the DOM in _toggleTcDetail).
function _failureAnalysisHTML(packet) {
  const stage = _tcFailureStage(packet.acks);
  if (!stage) return '';
  const afterMs = _tcFailedAfterMs(packet);
  const reasonHtml = stage === 'completed'
    ? '…'
    : `unavailable (failed at ${stage}, no report for this stage)`;
  return `<div class="pa-tc-fail">
    <div class="pa-tc-args-title pa-tc-fail-title">Failure analysis</div>
    <div class="pa-tc-fail-row">Failed after <b>${afterMs != null ? _fmtShortDuration(afterMs) : '—'}</b></div>
    <div class="pa-tc-fail-row">Failure reason: <span class="pa-tc-fail-reason">${reasonHtml}</span></div>
  </div>`;
}

// The expanded detail block a TC row's click reveals — packet.raw is the
// untouched original fetch result (see _fetchTcPackets), so this needs no
// network round trip (the one exception, the failure-reason lookup, is
// deferred separately — see _loadFailureReason).
function _tcArgsDetailHTML(packet) {
  if (!packet) return `<div class="co-tt-note">Packet no longer available</div>`;
  const failHtml = _failureAnalysisHTML(packet);
  const verHtml = _tcVerificationHTML(packet.acks);
  const args = [];
  collectArguments(packet.raw?.spacePacket?.rootContainer, args);
  const argsHtml = args.length
    ? `<div class="pa-tc-args-rows">${args.map(a => { const unit = argUnitLabel(a.unit); return `<div class="pa-tc-arg-row"${a.description ? ` title="${a.description}"` : ''}>
    <span class="pa-tc-arg-name">${a.name}</span>
    <span class="pa-tc-arg-val">${a.value != null ? a.value : '—'}${unit ? ` ${unit}` : ''}</span>
  </div>`; }).join('')}</div>`
    : `<div class="co-tt-note">No decoded arguments for ${packet.name}</div>`;
  return `<div class="pa-tc-args-title">${packet.name}</div>${failHtml}${verHtml}${argsHtml}`;
}

// Fills in the "Failure reason" line once the actual TM(1,8) report is
// fetched — a separate per-packet request, only worth making for the one
// row someone actually expanded, not fired for every failed row up front.
// detail.isConnected guards against writing into a stale panel if the row
// got toggled closed (or another row opened, which removes this one) while
// the fetch was in flight.
async function _loadFailureReason(packet, detail) {
  if (!packet || !_currentSat || _tcFailureStage(packet.acks) !== 'completed') return;
  const reasonEl = detail.querySelector('.pa-tc-fail-reason');
  if (!reasonEl) return;
  const code = await _resolveFailureCode(_currentSat, packet.raw?.apid, packet.raw?.sourceSeqCount, packet.acks.completed.time);
  if (!detail.isConnected) return;
  reasonEl.textContent = code ?? 'unknown (no TM(1,8) report found)';
}

// Fills in every "…" placeholder pill _failurePillHTML left in the just-
// rendered list — one TM(1,8) lookup per completed-stage failure, fired in
// parallel right away rather than gated behind a click, unlike
// _loadFailureReason above: the whole point of the pill is surfacing the
// reason WITHOUT opening the row. el.isConnected re-checked after the await
// guards against writing into a pill that's no longer in the DOM (list
// re-rendered — pass switch — while the fetch was in flight).
function _hydrateFailurePills(container) {
  container.querySelectorAll('.pa-tc-fail-pill[data-fail-pkt-id]').forEach(async el => {
    const packet = _lastTcPackets?.find(p => p.id === el.dataset.failPktId);
    if (!packet || !_currentSat) return;
    const code = await _resolveFailureCode(_currentSat, packet.raw?.apid, packet.raw?.sourceSeqCount, packet.acks.completed.time);
    if (!el.isConnected) return;
    el.textContent = code ?? 'FAILED';
    el.title = code ? `PUS(1,8) failure reason: ${code}` : 'Failed — no TM(1,8) report found for the reason code';
    el.classList.remove('pa-tc-fail-pill-loading');
  });
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
  _loadFailureReason(packet, detail);
  row.classList.add('pa-tc-row-open');
}

// A labeled break in the TC list, one per real procedure — reuses _PROC_CLS
// so the name is colored by that procedure's own outcome, same as the
// Procedures panel, rather than repeating a fixed color the divider would
// own separately. Shown even for a procedure that sent zero TCs (see
// _tcPacketsHTML/_logDividerAnchors, which position it by the procedure's
// own startMs rather than by an adjacent row) — a silent procedure is still
// worth knowing ran, not just the ones that happened to command something.
function _procDividerHTML(pr) {
  const cls = _PROC_CLS[pr.status] ?? 'co-tt-ok';
  // ▲ on both sides of the name (not just the dashed rule on either side of
  // the whole label) — this list is newest-first, so a reader scanning down
  // needs a nudge that the procedure it's now inside of sits ABOVE this
  // point, not below. Arrows are their own spans (not folded into the name
  // text) so a long procedure name truncates on its own — via CSS
  // overflow:ellipsis on just .pa-tc-proc-divider-name — without also
  // clipping the closing arrow off the end.
  return `<div class="pa-tc-proc-divider" title="${pr.name}"><span class="pa-tc-proc-divider-arrow ${cls}">▲</span><span class="pa-tc-proc-divider-name ${cls}">${pr.name}</span><span class="pa-tc-proc-divider-arrow ${cls}">▲</span></div>`;
}

// Same idea, for the full-pass log — but reuses .grm-log-divider (logView.js
// already draws that exact style for "▾ procedure starts"/"▴ procedure ends"
// inside a single-procedure Grafana pop-up) rather than .pa-tc-proc-divider's
// louder boxed look: dashed rule, italic, muted grey — deliberately quieter
// than an actual log line (which is monospace, brighter, has its own
// timestamp) so it's unmistakably an annotation THIS APP added, not
// something Loki actually returned, while still being easy to spot while
// scanning. The name itself still gets a real status color so it isn't
// pure filler text.
function _logProcDividerHTML(pr) {
  const cls = _PROC_CLS[pr.status] ?? 'co-tt-ok';
  return `<div class="grm-log-divider" title="${pr.name}">▲ <span class="${cls}">${pr.name}</span> ▲</div>`;
}

// Where each real procedure's divider belongs among the rendered
// .grm-log-line elements (newest-first, same order as `lines`) — positioned
// purely by the procedure's own startMs merged against the lines' own
// timestamps, NOT by finding a line that happens to fall inside it, so a
// procedure that produced zero log output in the fetched window still gets
// marked (same idea as _tcPacketsHTML's row/divider merge, just walked
// against `lines` — an array, not something worth building a combined
// array for here since the only thing needed back out is an insertion
// index). `idx` is the index (into `lines`, i.e. a real line's data-idx) to
// insert BEFORE; null means the procedure's start predates every fetched
// line, so it belongs at the very end (bottom = oldest) instead.
function _logDividerAnchors(lines, procedures) {
  const realProcs = (procedures ?? [])
    .filter(pr => !pr.notStarted && pr.startMs != null)
    .slice().sort((a, b) => b.startMs - a.startMs); // newest-first, matches `lines`' own order
  const anchors = [];
  let li = 0;
  for (const pr of realProcs) {
    while (li < lines.length && lines[li].ts / 1e6 >= pr.startMs) li++; // l.ts is nanoseconds (Loki convention) — /1e6 to ms
    anchors.push({ idx: li < lines.length ? li : null, proc: pr });
  }
  return anchors;
}

function _tcPacketsHTML(packets) {
  if (packets == null) return `<div class="co-tt-note">TC packet list unavailable (SCC unreachable)</div>`;

  // Matching runs on the packets in their original (fetched) order — the
  // nearest-timestamp search doesn't care which end it starts from — only
  // the DISPLAY order is newest-first, applied after merging so a TC_11_4
  // row's own timestamp (not its now-absorbed target's) is what's sorted on.
  const { targetFor, consumedIds } = matchScheduledTargets(packets);
  const procedures = _selectedPass?.procedures;

  // Every TC row AND every real procedure — even one that sent zero TCs of
  // its own — merged into ONE newest-first sequence, keyed by generationTime
  // for a row and startMs for a procedure. Positioning a divider by the
  // procedure's OWN start time (rather than by finding an adjacent row
  // inside it, the previous approach) is what makes a silent procedure
  // still show up: there's no row to hang a lookahead comparison off of,
  // but there's always a startMs to sort by.
  const rowItems = packets
    .filter(p => !consumedIds.has(p.id)) // shown merged into its scheduling TC_11_4's own row instead, not listed twice
    .map(p => ({ kind: 'row', t: p.generationTime ?? 0, p }));
  const procItems = (procedures ?? [])
    .filter(pr => !pr.notStarted && pr.startMs != null)
    .map(pr => ({ kind: 'div', t: pr.startMs, pr }));
  const combined = [...rowItems, ...procItems].sort((a, b) => {
    const diff = b.t - a.t; // newest first — the command most likely being chased down right after a pass
    // Tie: a divider sorts ABOVE (newer than) a row landing at the exact
    // same instant, so "procedure starts" reads as announcing that row
    // rather than trailing it.
    return diff !== 0 ? diff : (a.kind === 'div' ? -1 : 0) - (b.kind === 'div' ? -1 : 0);
  });

  if (!combined.length) return `<div class="co-tt-note">No TC packets found in this pass window</div>`;

  const rows = combined.map(item => {
      if (item.kind === 'div') return _procDividerHTML(item.pr);
      const p = item.p;

      const timeHtml = `<span class="pa-tc-time">${p.generationTime != null ? _fmtTimeMs(p.generationTime) : '—'}</span>`;
      const target = targetFor.get(p.id);
      if (!target) {
        return `<div class="pa-tc-row"${p.generationTime != null ? ` data-t="${p.generationTime}"` : ''} data-id="${p.id}" title="${p.description}">
          ${timeHtml}
          <span class="pa-tc-label">${p.name}</span>
          ${_tcStatusClusterHTML(p.acks, { pktId: p.id })}
        </div>`;
      }
      const ssid = p.args114?.ssid;
      const date = p.args114?.date;
      const argsHtml = [
        `SSID ${ssid != null ? ssid : '?'}`,
        // No milliseconds here — this is the FUTURE date the ground asked
        // the schedule to fire at, not a precisely-logged event, so
        // sub-second precision would be false precision. The row's own
        // generationTime (timeHtml, left of this) keeps its ms.
        date != null ? _fmtArgDateNoMs(date) : null,
      ].filter(Boolean).join(' · ');
      // No "TC_11_4" text label or "≫" arrow — this row's own accent color
      // (.pa-tc-row-114) already marks it as a scheduling envelope, so
      // neither added anything the color didn't already say; the target's
      // name is the part that actually varies and matters.
      // TWO badges, not one: the envelope's own acceptance/execution (did
      // the "insert this into the schedule" command itself go through) is a
      // separate, independently-failable outcome from the target's (did the
      // scheduled command actually run clean once its time came) — shown
      // side by side, envelope first (flush next to its own SSID/date, via
      // end:false) then target (pushed to the row's right edge, same
      // spot a plain row's single badge sits at), split by a plain "|" since
      // position alone (adjacent to SSID/date vs. adjacent to the target
      // name) already says which is which.
      // data-id points at the TARGET (not this envelope, p) — its arguments
      // are the ones actually worth expanding into on click; the envelope's
      // own SSID/date are already shown inline above.
      return `<div class="pa-tc-row pa-tc-row-114"${p.generationTime != null ? ` data-t="${p.generationTime}"` : ''} data-id="${target.id}" title="${p.description}">
        ${timeHtml}
        <span class="pa-tc-args">${argsHtml}</span>
        ${_tcStatusClusterHTML(p.acks, { end: false, label: 'TC_11_4 (scheduling command)', pktId: p.id })}
        <span class="pa-tc-ack-sep">|</span>
        <span class="pa-tc-label pa-tc-label-target" title="${target.description}">${target.name}</span>
        ${_tcStatusClusterHTML(target.acks, { label: target.name, pktId: target.id })}
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
    const num  = `<span class="co-tt-num">${i + 1}</span>`;
    const name = `<span class="co-tt-pname">${pr.name}</span>`;
    if (pr.notStarted) {
      // Scheduled but the pass ended before it ever started (satPasses.js) —
      // no real dates to show, nothing to link to Grafana for, and already
      // sorted last. Reuses the muted "not a real outcome" treatment.
      return `<div class="co-tt-proc co-tt-scheduled" title="${pr.name}">${num}${name}<span class="co-tt-dur">not started</span></div>`;
    }
    const cls  = _PROC_CLS[pr.status] ?? 'co-tt-ok';
    const dur  = pr.endMs && pr.startMs ? `<span class="co-tt-dur">${fmtDuration(pr.endMs - pr.startMs)}</span>` : '';
    if (grafanaHost && pr.startMs && pr.endMs) {
      const fromMs = pr.startMs - LOKI_PROC_PAD_MS, toMs = pr.endMs + LOKI_PROC_PAD_MS;
      const url = grafanaLokiUrl(grafanaHost, fromMs, toMs);
      // data-proc-idx matches this procedure's position in pass.procedures —
      // the SAME order _procedureBars (ebn0.js) numbers its bars in, so a
      // click here can find the matching .ebn0-proc-bar[data-proc-idx] to
      // glow without either side needing to agree on anything else (name,
      // times) to identify the same procedure.
      return `<a href="${url}" target="_blank" rel="noopener" data-grafana-modal data-loki-host="${grafanaHost}" data-loki-start="${fromMs}" data-loki-end="${toMs}" data-loki-nominal-start="${pr.startMs}" data-loki-nominal-end="${pr.endMs}" data-grafana-title="${grafanaModalTitle(sat, pass, pr)}" data-report-host="${grafanaHost}" data-report-start="${fromMs}" data-report-end="${toMs}" data-proc-idx="${i}" class="co-tt-proc co-tt-link ${cls}" title="${pr.name}">${num}${name}${dur}</a>`;
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
  // _lastFullLogLines is newest-first (see _render), so the chronologically
  // closest line at-or-after targetMs is the LAST one (scanning from the
  // oldest/bottom end) that still qualifies — walk from the end instead of
  // using a forward findIndex, which would assume ascending order.
  let idx = -1;
  for (let i = _lastFullLogLines.length - 1; i >= 0; i--) {
    if (_lastFullLogLines[i].ts / 1e6 >= targetMs) { idx = i; break; }
  }
  if (idx === -1) idx = 0; // procedure starts after the newest fetched line — land on the closest thing there is, now at the top
  const el = body.querySelector(`.grm-log-line[data-idx="${idx}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  body.querySelectorAll('.grm-log-flash').forEach(f => f.classList.remove('grm-log-flash'));
  void el.offsetWidth; // restart the animation if it's already mid-flash from a previous jump to the SAME line
  el.classList.add('grm-log-flash');
}

// Same idea as _scrollLogToTime, aimed at the TC list instead — its own
// flash color (blue, .pa-tc-row-flash) rather than the log's red, since red
// there is already claimed by acceptance/execution FAILURE (.pa-tc-ack-red)
// and this isn't reporting a problem, just marking where a click landed.
function _scrollTcListToTime(targetMs) {
  const tcSlot = _body?.querySelector('.pa-tc-slot');
  const rows = [...tcSlot?.querySelectorAll('.pa-tc-row[data-t]') ?? []];
  if (!rows.length) return;
  // TC list is newest-first (see _tcPacketsHTML) — same "walk from the
  // oldest/bottom end" as _scrollLogToTime, so the row landed on is the
  // chronologically closest one at-or-after targetMs.
  let target = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Number(rows[i].dataset.t) >= targetMs) { target = rows[i]; break; }
  }
  if (!target) target = rows[0]; // procedure starts after the newest TC — land on the newest, at the top
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tcSlot.querySelectorAll('.pa-tc-row-flash').forEach(r => r.classList.remove('pa-tc-row-flash'));
  void target.offsetWidth; // restart the animation if it's already mid-flash from a previous jump to the SAME row
  target.classList.add('pa-tc-row-flash');
}

// One-shot glow on the Eb/N0 chart's own procedure bar (ebn0.js's
// _procedureBars) — idx is this procedure's position in pass.procedures,
// the same index _procedureBars numbered its bars by (data-proc-idx),
// stamped onto the pill by _procHistoryHTML.
function _glowEbn0Bar(idx) {
  if (idx == null) return;
  const bar = _body?.querySelector(`.ebn0-proc-bar[data-proc-idx="${idx}"]`);
  if (!bar) return;
  bar.classList.remove('ebn0-proc-bar-glow');
  void bar.getBoundingClientRect(); // restart the animation if already mid-glow — an SVG <g> has no offsetWidth to force reflow with, unlike the HTML elements elsewhere in this file
  bar.classList.add('ebn0-proc-bar-glow');
}

// Clicking a procedure jumps the full pass log AND the TC list to its start
// (instead of opening grafanaModal.js's pop-up) and glows its Eb/N0 bar —
// data-loki-nominal-start (already set by _procHistoryHTML for the
// report-hover/dimming logic) is the procedure's own real start time,
// exactly what all three need.
function _wireProcJump(container) {
  container.querySelectorAll('.co-tt-proc[data-loki-nominal-start]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // let a real new-tab request through, same guard grafanaModal.js's own listener uses
      e.preventDefault();
      e.stopPropagation(); // keeps grafanaModal.js's document-level [data-grafana-modal] listener from also firing and opening the pop-up
      const startMs = Number(el.dataset.lokiNominalStart);
      _scrollLogToTime(startMs);
      _scrollTcListToTime(startMs);
      _glowEbn0Bar(el.dataset.procIdx);
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
let _lastTcPackets = null; // stashed so a row click (detail expand) or a later redraw can find/re-render packets without re-fetching
let _tcCursor = null;      // stashed so a redraw can re-wire the hover-drives-chart listeners on the new rows
let _lastFullLogLines = null; // stashed so a later procedure click can jump the log panel without re-fetching
// True while the mouse is anywhere over the full-log panel — guards
// _highlightLogLineAt's own _scrollIntoViewIfNeeded call (see there). Without
// this, hovering a log line drives the shared cursor with THAT line's own
// timestamp, which re-searches all rows for the nearest match to it — when
// two or more lines share the same (or a very close) timestamp, that search
// can resolve to a DIFFERENT row than the one actually under the mouse,
// scrolling the panel out from under the user the instant they hover it.
let _hoveringFullLog = false;

// Width of the grid's first column (pass details/procedures + TC list),
// dragged via .pa-col-resizer (see _wireColResizer) — module-level so it
// survives the full innerHTML rebuild _render() does on every pass/satellite
// switch instead of snapping back to the default each time. Never reset in
// _render(): a column-width preference is about the analyzer's own layout,
// not something that should vary pass-to-pass.
let _paCol1Width = 612; // 460 * 1.33 — widened default, TC list needs the room

// Eb/N0 chart x-axis span, toggled by .pa-ebn0-span-btn — 'pass' (default)
// clamps the axis to exactly this pass's own AOS0→LOS0; 'procedures' widens
// it to also cover any procedure that started before AOS or is still running
// past LOS (see ebn0Scales' spanMode in ebn0.js). Module-level like
// _paCol1Width above — a viewing preference, not something that should reset
// every time a different pass is opened.
let _ebn0Span = 'pass';
const PA_COL1_MIN = 360; // roughly the narrowest the pass-details column can go before its own content wraps badly
const PA_COL1_MAX = 760; // leaves the full-log/chart column at least minmax(420px, 1fr)'s floor of room

// Wires the drag handle sitting between the TC-list and full-pass-log
// columns. Rebuilt (like every other listener here) on each _render() call
// since the whole skeleton — including this handle — is torn down and
// redrawn each time.
function _wireColResizer(mainRow) {
  const handle = mainRow?.querySelector('.pa-col-resizer');
  if (!handle) return;
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.classList.add('pa-col-resizer-active');
    const startX = e.clientX;
    const startW = _paCol1Width;
    const onMove = ev => {
      _paCol1Width = Math.min(PA_COL1_MAX, Math.max(PA_COL1_MIN, startW + (ev.clientX - startX)));
      mainRow.style.setProperty('--pa-col1-w', `${_paCol1Width}px`);
    };
    const onUp = () => {
      handle.classList.remove('pa-col-resizer-active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

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
// snapshot taken at wire time), so it stays correct across any re-render.
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
  // Skip the scroll (not the highlight — that's still useful feedback)
  // while the mouse is directly over the log itself — see _hoveringFullLog's
  // own comment for why this specifically is the problematic case.
  if (!_hoveringFullLog) _scrollIntoViewIfNeeded(nearest, logBody);
}

function _clearLogLineHighlight() {
  _body?.querySelectorAll('.grm-log-cursor').forEach(row => row.classList.remove('grm-log-cursor'));
}

// Stylized replacement for the ack badge's old native `title` tooltip — same
// lazily-created single-element pattern _procTooltipEl uses (below), just
// simpler: acks are already sitting in memory (_lastTcPackets), so there's no
// async fetch/loading state to manage, only show/position/hide.
let _ackTooltipEl = null;
let _ackTooltipHideTimer = null;

function _ensureAckTooltip() {
  if (_ackTooltipEl) return;
  _ackTooltipEl = document.createElement('div');
  _ackTooltipEl.className = 'co-tooltip pa-tc-ack-tooltip';
  _ackTooltipEl.style.display = 'none';
  document.body.appendChild(_ackTooltipEl);
}

// Wires every ack badge in `container` to show that stylized tooltip on
// hover — looks the packet back up by the id _ackBadgeHTML stashed in
// data-pkt-id rather than carrying the acks object through the DOM, the same
// by-id lookup _toggleTcDetail already does for the row-click detail panel.
function _wireAckTooltips(container) {
  _ensureAckTooltip();
  container.querySelectorAll('.pa-tc-ack[data-pkt-id]').forEach(el => {
    el.addEventListener('mouseenter', e => {
      clearTimeout(_ackTooltipHideTimer);
      const packet = _lastTcPackets?.find(p => p.id === el.dataset.pktId);
      if (!packet?.acks) return;
      // "Acknowledgment report" names what this tooltip actually is (the
      // PUS TC verification chain) — a merged TC_11_4 row's badge still
      // needs its own ackLabel appended too, since THAT tooltip has to say
      // which of the two commands on the row it's reporting on.
      const title = el.dataset.ackLabel ? `Acknowledgment report — ${el.dataset.ackLabel}` : 'Acknowledgment report';
      _ackTooltipEl.innerHTML = _tcVerificationHTML(packet.acks, title);
      _ackTooltipEl.style.display = 'block';
      positionTooltip(e, _ackTooltipEl);
    });
    el.addEventListener('mouseleave', () => {
      _ackTooltipHideTimer = setTimeout(() => { _ackTooltipEl.style.display = 'none'; }, 100);
    });
  });
}

// Date label that tracks the Eb/N0 crosshair line — see _updateEbn0DateTooltip
// (below, in _drawEbn0's scope) for the show/position/hide logic itself.
// pointer-events:none in CSS (.ebn0-date-tooltip), so unlike _procTooltipEl/
// _ackTooltipEl above it needs no hover-to-keep-open/hide-timer dance — it
// only ever reflects wherever the linked cursor already is.
let _ebn0DateTooltipEl = null;

function _ensureEbn0DateTooltip() {
  if (_ebn0DateTooltipEl) return;
  _ebn0DateTooltipEl = document.createElement('div');
  _ebn0DateTooltipEl.className = 'co-tooltip ebn0-date-tooltip';
  _ebn0DateTooltipEl.style.display = 'none';
  document.body.appendChild(_ebn0DateTooltipEl);
}

// Re-renders just the TC list from the already-fetched packets (no network) —
// its own function since the hover/click listeners need re-wiring every time
// _tcPacketsHTML rebuilds the DOM.
function _renderTcList() {
  const tcSlot = _body?.querySelector('.pa-tc-slot');
  if (!tcSlot) return;
  tcSlot.innerHTML = _tcPacketsHTML(_lastTcPackets);
  if (_tcCursor) {
    tcSlot.querySelectorAll('.pa-tc-row[data-t]').forEach(row => {
      const t = Number(row.dataset.t);
      row.addEventListener('mouseenter', () => _tcCursor.driveFromTime(t));
      // Wrapped (not `_tcCursor.clear` directly) — the Eb/N0 span-toggle
      // button can reassign _tcCursor to a fresh cursor object after this
      // listener is attached; binding the method directly would freeze it
      // to whichever cursor existed at attach time.
      row.addEventListener('mouseleave', () => _tcCursor.clear());
    });
  }
  tcSlot.querySelectorAll('.pa-tc-row[data-id]').forEach(row => {
    row.addEventListener('click', () => _toggleTcDetail(row));
  });
  _wireAckTooltips(tcSlot);
  _hydrateFailurePills(tcSlot);
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

// Keeps the URL hash pointing at whatever pass is actually open, so a
// reload or a copy-pasted link lands back on the SAME pass instead of just
// the Analyzer tab in its empty state — main.js's own startup hash-restore
// (the only place this format is read back) is what makes that work, not
// anything stored here. No localStorage/backend involved — the URL IS the
// only persistence, exactly as asked for. The satellite's own NAME (not its
// internal sat-api-xxxx id) is what goes in the link — readable, and stable
// across a refetch the id itself is stable across too, so either would have
// worked; name is just the one a pasted link is actually legible with.
function _updateHash(sat, pass) {
  location.hash = `${encodeURIComponent(sat.name.toLowerCase())}/pass/${pass.start.getTime()}`;
}

// Entry point for "open this exact pass in the Analyzer" — called from
// PassDetailPanel.js's microscope button, via main.js (see there for why
// this isn't a direct import), and from main.js's own startup hash-restore.
// The only way anything ever gets shown here.
export function setSelection(sat, pass) {
  if (!sat || !pass) return;
  _currentSat = sat;
  _selectedPass = pass;
  _updateHash(sat, pass);
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
  _updateHash(_currentSat, next);
  _render();
}

// Briefly swaps the button's own label for a ✓ (clipboard), "⬇ saved"
// (downloaded instead — see copyEbn0ChartPNG's own comment on why: the
// Clipboard API needs a secure context, which a plain-HTTP LAN/VPN address
// doesn't qualify as even though the exact same button works fine at
// localhost), or ✗ on a genuine failure — as the only copy feedback, no
// toast, since this sits in a small fixed corner slot in the panel title.
// The .catch() matters here: without it, a rejected promise (this used to
// only ever expect success/false, never a throw) left the button disabled
// forever with no feedback at all, since nothing downstream ever ran to
// reset it. Takes the whole .ebn0-block (chart + legend), not just the
// chart SVG, so the copied PNG includes the legend too. passInfo prints as
// a small header baked into the PNG itself (satellite / antenna / date) so
// a copy pasted elsewhere still says which pass it's from.
function _copyEbn0PNG(btn, ebn0BlockEl, passInfo) {
  if (!ebn0BlockEl) return;
  const prev = btn.textContent;
  btn.disabled = true;
  copyEbn0ChartPNG(ebn0BlockEl, undefined, passInfo)
    .then(result => {
      btn.textContent = result === 'clipboard' ? '✓' : result === 'download' ? '⬇ saved' : '✗ copy failed';
    })
    .catch(() => { btn.textContent = '✗ copy failed'; })
    .finally(() => {
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
    });
}

// Plain-text summary for the .pa-copy-details button — clipboard/paste
// target (chat, ticket, email), so plain "Label: value" lines rather than
// anything HTML/markdown.
function _copyPassDetailsText({ satellite, station, network, aos0, duration, apogee }) {
  return [
    `Satellite: ${satellite}`,
    `Ground station: ${station}`,
    `Network: ${network}`,
    `AOS0: ${aos0}`,
    `Duration: ${duration}`,
    `Apogee: ${apogee}`,
  ].join('\n');
}

// Briefly swaps the button's own icon for a checkmark as the only copy
// feedback — no toast, since this sits in a small fixed corner slot shared
// with the < / > pass-nav buttons.
function _copyPassDetails(btn, fields) {
  navigator.clipboard.writeText(_copyPassDetailsText(fields)).then(() => {
    const prev = btn.textContent;
    btn.textContent = '✓';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
  });
}

async function _render() {
  const myGen = ++_gen;
  const { sat, pass } = _currentSelection();
  if (!sat || !pass) {
    _body.innerHTML = `<div class="pa-empty">Select a satellite and a completed pass to inspect.</div>`;
    return;
  }
  const grafanaHost = satSubsystemHost(sat.noradId, 'sccRo') || null;
  // Same time window _fetchFullPassLog queries below — this link should
  // always point at exactly what the panel itself is showing.
  const grafanaLogLink = grafanaHost
    ? `<a class="pa-full-log-grafana" href="${grafanaLokiUrl(grafanaHost, pass.start.getTime() - FULL_LOG_PAD_MS, pass.end.getTime() + FULL_LOG_PAD_MS)}" target="_blank" rel="noopener">Open in Grafana ↗</a>`
    : '';
  // Filled in once the polar-plot promise below resolves the pass's apogee
  // elevation — unknown synchronously, so the Copy button reads whatever's
  // landed by click time.
  let copyApogee = '—';

  _body.innerHTML = `
    <div class="pa-main-row" style="--pa-col1-w:${_paCol1Width}px">
      <div class="pa-left-top">
        <div class="pa-panel pa-details">
          <div class="pa-analyzer-tag">🔬 Pass Analyzer</div>
          <div class="pa-pass-nav">
            <button type="button" class="pa-copy-details" title="Copy pass details">⧉</button>
            <button type="button" class="pa-pass-prev" title="Previous pass (same satellite)">‹</button>
            <button type="button" class="pa-pass-next" title="Next pass (same satellite)">›</button>
          </div>
          <div class="co-tt-header"><span class="co-tt-sat-name" style="color:${sat.color}">${sat.name}</span> ${pass.station ?? '—'}${pass.network ? `<span class="co-tt-network">${pass.network}</span>` : ''}</div>
          <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATE</span>${fmtDateTimeShort(pass.start)}</div>
          <div class="co-tt-time-row"><span class="co-tt-time-lbl">DUR</span>${fmtDuration(pass.end - pass.start)}</div>
          <div class="co-tt-time-row"><span class="co-tt-time-lbl">DATA</span><span class="pa-status-dot" data-status-dot="tm" title="Loading…">● TM</span><span class="pa-status-dot" data-status-dot="tc" title="Loading…">● TC</span></div>
          ${passEclipseBarHTML(sat.satrec, pass.start, pass.end)}
        </div>
        <div class="pa-panel pa-procs">
          <div class="pa-panel-title">Procedures</div>
          <div class="proc-history-slot"><div class="co-tt-note">Loading…</div></div>
        </div>
      </div>
      <div class="pa-col-resizer" title="Drag to resize"></div>
      <div class="pa-panel pa-middle">
        <div class="pa-panel-title">
          <span>Polar plot &amp; TM/TC Eb/N0</span>
          <div class="pa-ebn0-actions">
            <button type="button" class="pa-ebn0-span-btn" title="Eb/N0 chart x-axis span: click to toggle between the pass's own AOS0→LOS0 and the full procedure-execution window (which can run longer than the pass)"></button>
            <button type="button" class="pa-copy-ebn0" title="Copy Eb/N0 chart as PNG">⧉ PNG</button>
          </div>
        </div>
        <div class="pa-ebn0-readout">
          <span class="pa-ebn0-readout-item"><span class="pa-ebn0-readout-label ebn0-tag-tm">TM Eb/N0</span><span class="pa-ebn0-readout-val" data-readout="tmEbn0">—</span></span>
          <span class="pa-ebn0-readout-item"><span class="pa-ebn0-readout-label ebn0-tag-tc">TC Eb/N0</span><span class="pa-ebn0-readout-val" data-readout="tcEbn0">—</span></span>
          <span class="pa-ebn0-readout-item"><span class="pa-ebn0-readout-label pa-ebn0-readout-label-plain">TM rate</span><span class="pa-ebn0-readout-val" data-readout="tmRate">—</span></span>
          <span class="pa-ebn0-readout-item"><span class="pa-ebn0-readout-label pa-ebn0-readout-label-plain">TC rate</span><span class="pa-ebn0-readout-val" data-readout="tcRate">—</span></span>
        </div>
        <div class="co-tt-details-row">
          <div class="polar-slot"></div>
          <div class="ebn0-slot"><div class="ebn0-loading">Collecting metrics…</div></div>
        </div>
      </div>
      <div class="pa-panel pa-tc-list">
        <div class="pa-panel-title">TC packets sent <span class="pa-tc-count"></span>
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

  _wireColResizer(_body.querySelector('.pa-main-row'));

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

  const copyBtn = _body.querySelector('.pa-copy-details');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => _copyPassDetails(copyBtn, {
      satellite: sat.name,
      station: pass.station ?? '—',
      network: pass.network ?? '—',
      aos0: fmtDateTimeShort(pass.start),
      duration: fmtDuration(pass.end - pass.start),
      apogee: copyApogee,
    }));
  }

  // Procedure history is synchronous — pass.procedures is already resolved.
  const histSlot = _body.querySelector('.proc-history-slot');
  if (histSlot) {
    histSlot.innerHTML = _procHistoryHTML(pass, grafanaHost, sat);
    _wireProcReportHovers(histSlot);
    _wireProcJump(histSlot);
  }

  const coordsPromise = sat.satrec ? fetchPassGsCoords(sat, pass, store.groundStations) : Promise.resolve(null);
  const polarReadyPromise = coordsPromise.then(coords => {
    if (myGen !== _gen) return { polarPoints: null, markers: null };
    let polarPoints = null, markers = null;
    const polarSlot = _body.querySelector('.polar-slot');
    const svg = coords ? buildPolarSVG(pass, sat, coords.lat, coords.lon, coords.rxMask) : '';
    if (svg && polarSlot) {
      polarSlot.outerHTML = `<div class="polar-wrap">${svg}
        <button type="button" class="pv-azel-btn" title="Show this pass as an azimuth/elevation (Cartesian) plot">⤢</button>
      </div>`;
      _body.querySelector('.pv-azel-btn')?.addEventListener('click', () =>
        openAzElModal(pass, sat, coords.lat, coords.lon, coords.rxMask));
      polarPoints = computePolarPoints(pass, sat, coords.lat, coords.lon);
      markers = computePolarMarkers(polarPoints, coords.rxMask);
    }
    if (markers?.apogee) copyApogee = `${markers.apogee.el.toFixed(0)}°`;
    return { polarPoints, markers };
  });

  const ebn0Promise      = sat.noradId ? fetchEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime(), pass.network) : Promise.resolve(null);
  const tcEbn0Promise    = sat.noradId ? fetchTcEbn0Series(sat.noradId, pass.start.getTime(), pass.end.getTime()) : Promise.resolve(null);
  const tcPacketsPromise = fetchTcPackets(sat, pass.start.getTime(), pass.end.getTime());
  const tmCounterPromise = sat.noradId ? fetchTmPacketsCounterSeries(sat.noradId, pass.start.getTime(), pass.end.getTime()) : Promise.resolve(null);
  const fullLogPromise   = _fetchFullPassLog(grafanaHost, pass);

  const [{ polarPoints, markers }, series, tcSeries, tcPackets, tmCounter, fullLogLinesAsc] =
    await Promise.all([polarReadyPromise, ebn0Promise, tcEbn0Promise, tcPacketsPromise, tmCounterPromise, fullLogPromise]);
  if (myGen !== _gen) return;
  // queryLoki (lokiQuery.js) always returns oldest-first — flipped here,
  // not at the source, since grafanaModal.js's own click-triggered log
  // pop-up shares that same helper and still wants its usual chronological
  // order. Only this permanent panel reads top-down as newest-first.
  const fullLogLines = fullLogLinesAsc ? fullLogLinesAsc.slice().reverse() : fullLogLinesAsc;

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
  // Same 1:1-render idea as chartWidth above, applied to height: .pa-middle
  // .co-tt-details-row stretches to fill the rest of .pa-main-row's fixed
  // 270px row (see style.css — flex:1 + align-items:stretch, scoped to this
  // panel), so its OWN measured height is real leftover space, not just
  // whatever a fixed chartHeight constant used to leave empty below the
  // chart. LEGEND_H_ESTIMATE accounts for the one-line stats row ebn0HTML
  // draws below the SVG itself (not part of the SVG's own height).
  //
  // The procedure-bar strip is NOT a flat +PROC_BAR_STRIP_H on top of
  // `height` — buildEbn0SVG's own totalH is
  // `height - PAD_B + PROC_BAR_STRIP_H` when there are bars (the strip
  // partly reuses the bottom axis padding rather than sitting fully outside
  // it), so the real extra is PROC_BAR_STRIP_H - PAD_B. Subtracting the FULL
  // PROC_BAR_STRIP_H here (as an earlier version of this did) overshot by
  // PAD_B (14 units) and left that much dead space at the bottom of the
  // chart on every pass with procedures — i.e. nearly always.
  const rowHeight   = detailsRow?.getBoundingClientRect().height || 200;
  const LEGEND_H_ESTIMATE = 20; // one fused legend line (.ebn0-legend-row) + its margin-top:4px
  const hasProcBars = pass.procedures?.some(pr => pr.startMs != null && pr.endMs != null);
  const procBarExtra = hasProcBars ? PROC_BAR_STRIP_H - PAD_B : 0;
  const chartHeight = Math.max(120, Math.round(rowHeight - LEGEND_H_ESTIMATE - procBarExtra));
  const tcHistogram = _tcSendHistogram(tcPackets);
  const tmHistogram = _tmReceiveHistogram(tmCounter, fullLogLinesAsc);

  // Fixed-position value readout above the chart (.pa-ebn0-readout in the
  // skeleton above) — distinct from the floating per-point label the SVG
  // cursor itself already draws pinned to the hovered dot: that one only
  // ever shows TM/TC Eb/N0, and drifts around the chart with the mouse. This
  // reads BOTH Eb/N0 values AND each histogram's own bucket rate at the
  // hovered time, all four always in the same fixed spot at a glance.
  function _updateEbn0Readout(t) {
    const readout = _body.querySelector('.pa-ebn0-readout');
    if (!readout) return;
    const set = (key, text) => { const el = readout.querySelector(`[data-readout="${key}"]`); if (el) el.textContent = text; };
    if (t == null) {
      set('tmEbn0', '—'); set('tcEbn0', '—'); set('tmRate', '—'); set('tcRate', '—');
      return;
    }
    const tmPoint = series?.length   ? nearestByTime(series, t)   : null;
    const tcPoint = tcSeries?.length ? nearestByTime(tcSeries, t) : null;
    set('tmEbn0', tmPoint ? `${tmPoint.v.toFixed(2)} dB` : '—');
    set('tcEbn0', tcPoint ? `${tcPoint.v.toFixed(2)} dB` : '—');
    const tmBucket = tmHistogram?.find(b => t >= b.t && t < b.tEnd);
    const tcBucket = tcHistogram?.find(b => t >= b.t && t < b.tEnd);
    set('tmRate', tmBucket ? `${((tmBucket.received + tmBucket.lost) / ((tmBucket.tEnd - tmBucket.t) / 1000)).toFixed(1)} pkt/s` : '—');
    set('tcRate', tcBucket ? `${(tcBucket.sent / ((tcBucket.tEnd - tcBucket.t) / 1000)).toFixed(1)} pkt/s` : '—');
  }

  // Small floating label pinned to the Eb/N0 crosshair line's own x — shows
  // the hovered moment's full DATE, not just HH:MM:SS. The fixed
  // .pa-ebn0-readout above the chart has no room for it, and a 'procedures'
  // -span chart can run long enough to cross midnight where time-only would
  // be ambiguous. Positioned off the crosshair LINE's current screen x
  // (converted from its SVG viewBox coordinate) rather than the raw mouse
  // event, so it tracks correctly even when driven from the POLAR side of
  // the linked cursor (passCursor.js), which moves this same line without
  // ever firing a mousemove on the Eb/N0 chart itself.
  function _updateEbn0DateTooltip(t, ebn0El) {
    _ensureEbn0DateTooltip();
    const line = ebn0El?.querySelector('.ebn0-cursor-line');
    const vb   = ebn0El?.viewBox?.baseVal;
    if (t == null || !line || !vb?.width) { _ebn0DateTooltipEl.style.display = 'none'; return; }
    _ebn0DateTooltipEl.textContent   = fmtDateTimeShort(new Date(t));
    _ebn0DateTooltipEl.style.display = 'block';
    const rect   = ebn0El.getBoundingClientRect();
    const scaleX = rect.width / vb.width;
    const x1     = parseFloat(line.getAttribute('x1')) || 0;
    const w = _ebn0DateTooltipEl.offsetWidth  || 140;
    const h = _ebn0DateTooltipEl.offsetHeight || 22;
    let left = rect.left + x1 * scaleX - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = rect.top - h - 6 >= 8 ? rect.top - h - 6 : rect.top + 6;
    _ebn0DateTooltipEl.style.left = `${left}px`;
    _ebn0DateTooltipEl.style.top  = `${top}px`;
  }

  // Redraws just the Eb/N0 chart + its linked cursor from already-fetched
  // data (no network round trip) — shared by the initial draw below and the
  // span-toggle button, so toggling span doesn't re-fetch TM/TC series, TC
  // packets, or the full log all over again. Targets '.ebn0-slot,.ebn0-block'
  // since the first draw replaces the skeleton's .ebn0-slot with .ebn0-block
  // (ebn0HTML's own wrapper) via outerHTML — every redraw after that has to
  // find THAT instead, and self-replaces it the same way.
  function _drawEbn0() {
    const slot = _body.querySelector('.pa-middle .ebn0-slot, .pa-middle .ebn0-block');
    if (slot) slot.outerHTML = ebn0HTML(series, markers, pass.procedures, ebn0Range, tcSeries, chartWidth, chartHeight, tcHistogram, tmHistogram, _ebn0Span);
    const newEbn0El = _body.querySelector('.ebn0-chart');
    // Re-wiring (not reusing the old cursor object) is required, not just
    // convenient — a span toggle swaps in a brand-new <svg>, so the old
    // cursor's DOM references (line/dots/labels) point at elements no longer
    // in the document.
    _tcCursor = wireLinkedCursor(polarEl, polarPoints, newEbn0El, series, pass.procedures, tcSeries, ebn0Range,
      t => {
        _updateEbn0Readout(t);
        _updateEbn0DateTooltip(t, newEbn0El);
        if (t == null) { _clearTcRowHighlight(); _clearLogLineHighlight(); }
        else            { _highlightTcRowAt(t);  _highlightLogLineAt(t); }
      }, _ebn0Span);
  }
  _drawEbn0();

  const ebn0SpanBtn = _body.querySelector('.pa-ebn0-span-btn');
  if (ebn0SpanBtn) {
    const _labelEbn0SpanBtn = () => { ebn0SpanBtn.textContent = _ebn0Span === 'pass' ? 'Span: Pass' : 'Span: Procedures'; };
    _labelEbn0SpanBtn();
    ebn0SpanBtn.addEventListener('click', () => {
      _ebn0Span = _ebn0Span === 'pass' ? 'procedures' : 'pass';
      _labelEbn0SpanBtn();
      _drawEbn0();
    });
  }

  const copyEbn0Btn = _body.querySelector('.pa-copy-ebn0');
  if (copyEbn0Btn) {
    // Looks up the CURRENT .ebn0-block (chart + legend) at click time rather
    // than capturing one now — the span-toggle button's _drawEbn0() swaps in
    // a brand-new one via outerHTML on every toggle, and this listener is
    // only attached once per _render() call, so a captured reference would
    // go stale the moment someone toggled span before copying.
    copyEbn0Btn.addEventListener('click', () => _copyEbn0PNG(copyEbn0Btn, _body.querySelector('.pa-middle .ebn0-block'), {
      satellite: sat.name,
      antenna: pass.station ?? '—',
      date: fmtDateTimeShort(pass.start),
    }));
  }

  // Full pass log — same rendering/error-highlighting logView.js gives the
  // click-triggered pop-up (grafanaModal.js), just drawn into a permanent
  // div instead of an overlay, and with no procedure boundary to dim around
  // (this spans the whole pass, so every line is equally "in bounds").
  const fullLogBody = _body.querySelector('.pa-full-log-body');
  const fullLogNav  = _body.querySelector('.pa-full-log .grm-err-nav');
  if (fullLogBody) {
    // Container-level, not per-row — see _hoveringFullLog's own comment.
    // Reset false on every redraw of this panel too (a fresh innerHTML
    // wouldn't otherwise fire a mouseleave for whatever the mouse happened
    // to be sitting over just before the redraw).
    _hoveringFullLog = false;
    fullLogBody.addEventListener('mouseenter', () => { _hoveringFullLog = true; });
    fullLogBody.addEventListener('mouseleave', () => { _hoveringFullLog = false; });
    if (fullLogLines == null) {
      fullLogBody.innerHTML = `<div class="co-tt-note">Could not reach Grafana/Loki</div>`;
    } else if (!fullLogLines.length) {
      fullLogBody.innerHTML = `<div class="co-tt-note">No log lines found in this pass window</div>`;
    } else {
      const { html, errorIndices } = renderLogRows(fullLogLines);
      fullLogBody.innerHTML = html;
      if (fullLogNav) createErrorNav(fullLogNav, fullLogBody).setErrorIndices(errorIndices);
      // Procedure dividers, inserted as extra DOM siblings AFTER the html
      // string is already in place — data-idx on the real .grm-log-line
      // elements (set by renderLogRows) is what _scrollLogToTime keys off
      // of, so these need to slot in alongside them without renumbering
      // anything, which insertAdjacentHTML on the matched line does for
      // free (the divider itself carries no data-idx, so it's invisible to
      // every data-idx-based lookup). idx null means the procedure's own
      // start predates every fetched line — goes at the very bottom instead
      // of anchoring to a line that doesn't exist.
      for (const { idx, proc } of _logDividerAnchors(fullLogLines, pass.procedures)) {
        const html = _logProcDividerHTML(proc);
        if (idx != null) fullLogBody.querySelector(`.grm-log-line[data-idx="${idx}"]`)?.insertAdjacentHTML('beforebegin', html);
        else fullLogBody.insertAdjacentHTML('beforeend', html);
      }
      // Reverse direction: hovering a log line drives the same shared
      // cursor a TC row hover does — same third-entry-point idea, just
      // from the log side. data-t comes straight off the row (set by
      // renderLogRows), no separate lines array needed.
      fullLogBody.querySelectorAll('.grm-log-line[data-t]').forEach(row => {
        const t = Number(row.dataset.t);
        // _tcCursor (not a local var) — the span-toggle button rewires it to
        // a new cursor object with each redraw, and these listeners need to
        // always reach whichever one is current.
        row.addEventListener('mouseenter', () => _tcCursor.driveFromTime(t));
        row.addEventListener('mouseleave', () => _tcCursor.clear());
      });
    }
  }
  _lastFullLogLines = fullLogLines; // read later by _scrollLogToTime when a procedure link is clicked

  const tcCount = tcPackets == null ? '—' : (tcPackets.length === TC_MAX_LIMIT ? `${TC_MAX_LIMIT}+` : String(tcPackets.length));

  const tcCountEl = _body.querySelector('.pa-tc-count');
  if (tcCountEl) tcCountEl.textContent = tcPackets == null ? '' : `(${tcCount})`;

  // At-a-glance pass health, in .pa-details: TM received (the downlink TM
  // Eb/N0 series actually has samples — the same `series` the chart above
  // draws), and TC acknowledgment coverage — about ACKNOWLEDGMENT
  // specifically (an acceptance report, success or failure, arriving at
  // all), not execution outcome: catches both a plain 'pending' TC and the
  // 'exec-ok with no acceptance' "Acceptance failure" oddity
  // _failurePillHTML already flags per-row.
  // Same "one row per command" set the TC list itself shows (and the send
  // histogram counts) — a TC_11_4's scheduled TARGET is a separately-timed
  // nested event absorbed into its own envelope's row, so it's excluded here
  // too rather than double-counted as if it were its own independent send.
  // TC_UNACKED_EXCLUDE names are dropped from the ELIGIBLE set entirely
  // (not just skipped when checking for a missing report) — they're known
  // to never ack by design, so they shouldn't count toward "how many of
  // this pass's TCs got acknowledged" either.
  const { consumedIds: tcConsumedIds } = matchScheduledTargets(tcPackets ?? []);
  const tcTopLevel  = tcPackets?.filter(p => !tcConsumedIds.has(p.id)) ?? [];
  const tcEligible  = tcTopLevel.filter(p => !TC_UNACKED_EXCLUDE.has(p.name));
  const tcAcceptedCount = tcEligible.filter(p => p.acks?.acceptance).length;
  // Red: EVERY eligible TC in the pass is missing its acceptance report —
  // a total ack-chain failure, worse than the merely-partial orange case.
  const tcAllUnacked  = tcEligible.length > 0 && tcAcceptedCount === 0;
  const tcSomeUnacked = tcAcceptedCount < tcEligible.length; // true for the all-unacked case too
  const tcAcked = !!tcTopLevel.some(p => {
    const st = _tcAckStatus(p.acks);
    return st === 'accepted' || st === 'exec-ok';
  });
  const tmReceived = !!series?.length;
  const tmDotEl = _body.querySelector('.pa-status-dot[data-status-dot="tm"]');
  if (tmDotEl) {
    tmDotEl.classList.toggle('pa-status-dot-ok', tmReceived);
    tmDotEl.title = tmReceived ? 'TM Eb/N0 telemetry was received during this pass' : 'No TM Eb/N0 telemetry received during this pass';
  }
  const tcDotEl = _body.querySelector('.pa-status-dot[data-status-dot="tc"]');
  if (tcDotEl) {
    // Red (all unacked) beats orange (some unacked) beats green (acked/
    // executed) — each is strictly worse/more-actionable than the next, so
    // whichever applies highest in that order is what the single dot shows.
    tcDotEl.classList.remove('pa-status-dot-ok', 'pa-status-dot-warn', 'pa-status-dot-crit');
    if (tcAllUnacked) {
      tcDotEl.classList.add('pa-status-dot-crit');
      tcDotEl.title = 'No TC in this pass received an acceptance report at all';
    } else if (tcSomeUnacked) {
      tcDotEl.classList.add('pa-status-dot-warn');
      tcDotEl.title = 'Some TCs never received an acceptance report — no acknowledgment, regardless of execution outcome';
    } else if (tcAcked) {
      tcDotEl.classList.add('pa-status-dot-ok');
      tcDotEl.title = 'At least one TC was acknowledged or executed';
    } else {
      tcDotEl.title = 'No TC was acknowledged or executed';
    }
  }

  // Hovering a TC row drives the same hair cursor the polar plot / Eb/N0
  // chart already drive each other with (see passCursor.js) — lets you see
  // exactly where in the pass a given command landed, same mechanism, just a
  // third entry point into it. _renderTcList wires this each time it draws
  // the rows.
  _lastTcPackets = tcPackets;
  _renderTcList();
}
