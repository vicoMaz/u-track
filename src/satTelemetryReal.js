// Real satellite telemetry (sysMode/gncMode/battery %) queried AT A SPECIFIC
// SIM TIME — used by SatInfo.js so the Visualizer's satellite info panel
// stays coherent with whatever instant TimePlayer is currently showing
// (e.g. scrubbed hours into the past to inspect an old pass), instead of
// always showing "right now" like the ChadOps Fleet table does.
//
// Same bucket-grid-cache/debounce/lookahead shape as satAttitudeReal.js
// (same class of problem: don't refetch on every scrub tick, but don't fall
// behind during continuous playback either) — but simpler, because sysMode/
// gncMode/battery are step values, not something to interpolate between. A
// fetched sample is just "the latest known TM value as of (up to) this 30s
// bucket's end" and stays valid/displayed until scrub moves to an
// uncovered bucket.
//
// Deliberately separate from satTelemetry.js's fetchSatTelemetry(), which
// always queries the TRUE latest packet regardless of sim time — that one
// still drives ChadOps.js's Fleet table (live ops monitoring, always "now")
// and must keep doing so unaffected by wherever the Visualizer happens to be
// scrubbed to.
import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';
import { getTmConfig, fetchTmPacket, extractTmParam } from './satTelemetry.js';

const GRID_MS = 30_000;                 // target resolution — matches satAttitudeReal.js's GRID_MS
const DEBOUNCE_MS = 400;                // settle time before firing, same as satAttitudeReal.js
const MAX_WAIT_MS = 2_000;              // ceiling so continuous playback still fetches periodically even without crossing the lookahead margin below
const LOOKAHEAD_MARGIN_MS = 20_000;     // stay this far ahead of consumption, same reasoning as satAttitudeReal.js
const URGENT_OVERRUN_MS = 60_000;       // "just crossed a bucket boundary" vs "scrubbed to an unrelated time"
const MAX_CACHED_SAMPLES = 500;
const FETCH_TIMEOUT_MS = 8_000;
const LOOKBACK_WINDOW_MS = 24 * 3_600_000; // packets can be sparse — same window satTelemetry.js's "latest" query uses

// Above this sim-time multiplier, a single fetch (~0.2-0.4s) per 30s bucket
// can't plausibly keep up with how fast sim time consumes buckets — same
// exact threshold and reasoning as satAttitudeReal.js's MAX_SPEED_FOR_REAL,
// so the two "is this too fast to trust" answers in SatInfo.js always agree.
export const MAX_SPEED_FOR_TELEMETRY = 10;

const _bucketStart = ms => Math.floor(ms / GRID_MS) * GRID_MS;

// ── Client-local cache + bucket-grid prefetch ───────────────────────────

const _debounceTimer = new Map(); // satId -> setTimeout handle
const _lastAttemptMs = new Map(); // satId -> ms, for the MAX_WAIT_MS ceiling
const _inFlight       = new Set(); // `${satId}:${bucketMs}`

function _mergeSample(satId, sample) {
  const existing = (store.satTelemetryReal[satId]?.entries ?? []).filter(e => e.t !== sample.t);
  let merged = [...existing, sample].sort((a, b) => a.t - b.t);
  if (merged.length > MAX_CACHED_SAMPLES) merged = merged.slice(merged.length - MAX_CACHED_SAMPLES);
  store.setSatTelemetryReal(satId, { entries: merged });
}

async function _fetchBucket(sat, bucketMs) {
  const key = `${sat.id}:${bucketMs}`;
  const existing = store.satTelemetryReal[sat.id]?.entries;
  if (existing?.some(e => e.t === bucketMs)) return; // already covered
  if (_inFlight.has(key)) return;
  const ip = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!ip) return;

  _inFlight.add(key);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const cfg = getTmConfig(sat.noradId, sat.model);
    // Only the 3 fields SatInfo.js needs — minimizes API calls (usually one
    // packet, HK_PLT; two for 12U, whose battery comes from HK_EPS_1S).
    const fields = { sysMode: cfg.sysMode, gncMode: cfg.gncMode, battery: cfg.battery };
    const byPacket = new Map(); // packetName → [{field, param}]
    for (const [field, { packet, param }] of Object.entries(fields)) {
      if (!byPacket.has(packet)) byPacket.set(packet, []);
      byPacket.get(packet).push({ field, param });
    }

    const end   = new Date(Math.min(bucketMs + GRID_MS, Date.now())).toISOString();
    const start = new Date(bucketMs + GRID_MS - LOOKBACK_WINDOW_MS).toISOString();
    const extracted = {};

    await Promise.all([...byPacket.entries()].map(async ([packetName, entries]) => {
      const pkt = await fetchTmPacket(ip, packetName, { start, end }, ctrl.signal);
      if (!pkt) return;
      for (const { field, param } of entries) extracted[field] = extractTmParam(pkt, param);
    }));

    if (ctrl.signal.aborted) return; // superseded/timed out — don't cache a partial result

    const battV = extracted.battery?.value;
    const [socA, socB] = sat.model === 'FF' ? [-361.07, 18.55] : [-361.5, 27.86];
    const battSoc = battV != null
      ? Math.max(0, Math.min(100, Math.round(socA + socB * battV)))
      : null;

    _mergeSample(sat.id, {
      t:           bucketMs,
      sysMode:     extracted.sysMode ?? null,
      gncMode:     extracted.gncMode ?? null,
      battVoltage: extracted.battery ?? null,
      battSoc:     battSoc != null ? { value: battSoc } : null,
    });
  } finally {
    clearTimeout(timer);
    _inFlight.delete(key);
  }
}

async function _runFetchCycle(sat, atMs) {
  // Re-validate at fire time, not just schedule time — time/speed can have
  // moved on during the debounce/wait.
  if (atMs > Date.now()) return;
  if (Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_TELEMETRY) return;

  const entries = store.satTelemetryReal[sat.id]?.entries;
  const haveThroughMs = entries?.length ? entries[entries.length - 1].t : null;

  // Extend forward from whichever is further along: atMs's own bucket, or
  // the edge of what we already have — same anti-flicker fix as
  // satAttitudeReal.js's _runFetchCycle (see its comment for the full story).
  const startBucket   = _bucketStart(atMs);
  const fromBucket    = haveThroughMs != null ? Math.max(startBucket, _bucketStart(haveThroughMs)) : startBucket;
  const throughBucket = _bucketStart(atMs + LOOKAHEAD_MARGIN_MS);

  const buckets = [];
  for (let b = fromBucket; b <= throughBucket; b += GRID_MS) {
    if (b <= Date.now()) buckets.push(b);
  }
  if (!buckets.length && startBucket <= Date.now()) buckets.push(startBucket); // always at least the current instant

  await Promise.all(buckets.map(b => _fetchBucket(sat, b)));
}

// Called from SatInfo.js on every relevant store change (currentTime tick,
// trackedSatId change) — see satAttitudeReal.js's scheduleAttitudeFetch for
// the full debounce/ceiling/lookahead reasoning, mirrored here identically.
export function scheduleTelemetryFetch(sat, atMs) {
  if (atMs > Date.now()) return;
  if (Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_TELEMETRY) return;

  const entries = store.satTelemetryReal[sat.id]?.entries;
  const lastCoveredMs = entries?.length ? entries[entries.length - 1].t : -Infinity;
  const gapAhead = lastCoveredMs - atMs; // positive: still have buffer ahead; negative: already ran past it
  if (gapAhead < LOOKAHEAD_MARGIN_MS && gapAhead > -URGENT_OVERRUN_MS) {
    clearTimeout(_debounceTimer.get(sat.id));
    _lastAttemptMs.set(sat.id, Date.now());
    _runFetchCycle(sat, atMs);
    return;
  }

  clearTimeout(_debounceTimer.get(sat.id));
  const last = _lastAttemptMs.get(sat.id) ?? 0;
  if (Date.now() - last >= MAX_WAIT_MS) {
    _lastAttemptMs.set(sat.id, Date.now());
    _runFetchCycle(sat, atMs);
    return;
  }
  _debounceTimer.set(sat.id, setTimeout(() => {
    _lastAttemptMs.set(sat.id, Date.now());
    _runFetchCycle(sat, atMs);
  }, DEBOUNCE_MS));
}

// ── Consumption ──────────────────────────────────────────────────────────

// The cached sample for atMs's own 30s bucket, or (if that bucket hasn't
// landed yet — e.g. right after a scrub, before the fetch resolves) the
// latest earlier bucket we do have, same "carry forward last known value"
// behavior real telemetry naturally has between downlinked packets. Never
// picks a bucket AHEAD of atMs's own — that would show a value that, from
// atMs's point of view, hasn't happened yet.
function _resolveAt(sat, atMs) {
  const entries = store.satTelemetryReal[sat.id]?.entries;
  if (!entries?.length) return null;
  const wantBucket = _bucketStart(atMs);
  let best = null;
  for (const e of entries) {
    if (e.t <= wantBucket) best = e;
    else break;
  }
  return best;
}

// For SatInfo.js only — what to actually SHOW, and why, at this instant.
export function telemetryDisplayState(sat, atMs) {
  if (atMs > Date.now()) return { active: false, reason: 'future' };
  if (Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_TELEMETRY) return { active: false, reason: 'fast-forward' };
  const sample = _resolveAt(sat, atMs);
  return sample ? { active: true, sample } : { active: false, reason: 'no-data' };
}
