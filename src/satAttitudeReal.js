// Real satellite attitude restitution — fetches from MIC's own per-satellite
// attitudeParameterMessage endpoint (CCSDS APM, plain text, one epoch per
// request), client-local cache only (never shared/persisted via the server —
// see store.js's `realAttitude` field comment for why this is kept separate
// from the legacy `attitude`/POST-/api/attitude mechanism).
//
// Confirmed live against the real ground segment:
//  - CORS is open on MIC's own responses, so this fetches straight from the
//    browser — no server-side proxy needed (unlike Grafana elsewhere in this
//    app, which sends no CORS headers of its own).
//  - Auth is the RAW token, no "Bearer " prefix (a prefixed token gets a 401
//    "Credentials are required..." same as no token at all).
//  - Only PAST epochs where telemetry has actually been downlinked AND
//    processed return real data — this routinely lags "now" by HOURS (tied
//    to when a pass's telemetry gets processed, same pipeline TMR downloads
//    depend on). An unavailable epoch is a fast (~0.2-0.4s) HTTP 500 with a
//    body like `Not enough tm data to read for file"HK_MK2.csv"...` — not a
//    slow timeout, so it's safe to treat as a normal, expected outcome (with
//    a cooldown, see UNAVAILABLE_COOLDOWN_MS) rather than an error state.
//  - Within an available window, MIC already finely interpolates/propagates
//    server-side for whatever exact epoch is requested (confirmed at 1s and
//    10s offsets across a ~90s span, each returning a distinct result) — so
//    OUR OWN client-side SLERP between ~30s-apart samples (see GRID_MS below)
//    is purely a call-volume optimization, not something needed for
//    precision.
//  - Quaternion convention: MIC's Q_FRAME_A=EME2000, Q_FRAME_B=SC_BODY,
//    Q_DIR=A2B reads, per the standard aerospace convention, as "rotates FROM
//    EME2000 TO SC_BODY" — which would suggest needing a conjugate to match
//    store.attitude's existing body→ECI consumers (SatEntity.js,
//    TimePlayer.js). An earlier version of this file applied exactly that
//    conjugate on that reasoning alone — but live A/B testing against the
//    real ground segment (rendering with vs. without it, comparing the
//    reference arrows against the true Sun direction at several real
//    epochs) showed the OPPOSITE: MIC's raw (Q1,Q2,Q3,QC), fed through
//    UNMODIFIED, is what actually lines up. Quaternion active/passive and
//    frame-direction conventions are notoriously inconsistent across
//    libraries — trust this empirical result over the standard-convention
//    derivation. Also: this app treats EME2000 as equivalent to its own
//    "ECI" throughout (same simplification already implicit in
//    satellite.js's TEME-frame SGP4 output being called "ECI" everywhere
//    else in this codebase) — no precession/nutation correction is
//    attempted.
import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';
import { satJwt } from './satPing.js';
import { sampleAttitudeTable, DEFAULT_MAX_GAP_MS } from './attitudeSample.js';

const GRID_MS = 30_000;                 // target resolution — see file header
const DEBOUNCE_MS = 400;                // settle time before firing, same as tmrData.js's scheduleTmrFetch
const MAX_WAIT_MS = 2_000;              // ceiling so continuous playback (a notify every RAF) still fetches periodically even without crossing the lookahead margin below
const UNAVAILABLE_COOLDOWN_MS = 5 * 60_000; // don't re-hit a confirmed-empty bucket for 5 min
// A timeout/network failure is NOT MIC confirming "no data" — it's just our
// own request not completing, e.g. under the slowness noted in this file's
// header. Blacklisting a bucket for the full 5 minutes on that basis means a
// single slow/dropped request can make a time you scrub back to look
// permanently stuck on Default Sun Pointing even though a retry moments
// later would likely succeed. Short cooldown instead — long enough that
// continuous playback/scrubbing doesn't retry-storm the same bucket every
// frame, short enough to recover well within one viewing session.
const TRANSIENT_COOLDOWN_MS = 15_000;
const MAX_CACHED_SAMPLES = 500;         // ~4+ hours of 30s-grid coverage; oldest evicted first
const FETCH_TIMEOUT_MS = 8_000;

// How far (in SIM time) ahead of the current instant we try to stay covered —
// fetched proactively, before actually running out, so ordinary continuous
// playback never visibly falls back to Default Sun Pointing waiting on a
// fetch. 20s at 1x/10x gives 2-20s of real wall-clock lead time for a fetch
// that only takes ~0.2-0.4s — comfortable. This is intentionally NOT scaled
// by playback speed (see MAX_SPEED_FOR_REAL below for why).
const LOOKAHEAD_MARGIN_MS = 20_000;
// If we've already run PAST the last cached sample by up to this much, still
// treat it as "just crossed a bucket boundary during continuous playback"
// (fetch urgently) rather than "jumped/scrubbed to an unrelated time" (which
// should respect the debounce instead, so a fast scrub doesn't spam MIC).
const URGENT_OVERRUN_MS = 60_000;
// Above this sim-time multiplier, MIC (one point at a time, ~0.2-0.4s/call)
// cannot plausibly be fetched fast enough to keep a 20s lookahead margin
// ahead of consumption — e.g. at 60x, 20s of sim-time lookahead is only
// ~0.33s of real wall-clock lead, too tight to reliably beat network jitter,
// which is exactly what caused the reported flicker (real → constant →
// real, right at every 30s bucket boundary). Rather than degrade into
// occasional flicker, don't attempt real attitude at all above this speed —
// clean, predictable Default Sun Pointing the whole time instead (see
// attitudeDisplayState's 'fast-forward' reason).
//
// Only actually applies while store.playing is true (see every call site
// below) — playbackSpeed is just the currently-SELECTED multiplier and
// stays whatever it was last set to even after the user pauses/scrubs, so
// gating on speed alone used to permanently block real attitude at ANY
// scrub position for the rest of the session the moment someone picked
// 60x/600x/1h-per-s to skim across the ±5-day gantt — even a single slow,
// deliberate scrub afterward stayed stuck on Default Sun Pointing, since
// there's no ongoing consumption to outrun once playback is stopped.
const MAX_SPEED_FOR_REAL = 10;

// ── Per-satellite mode preference ───────────────────────────────────────
// 'real' (default, key absent) or 'constant' — same sat-<thing>-${noradId}
// localStorage convention as satStarTracker.js's exclusion-angle settings.
export function satAttitudeMode(noradId) {
  return localStorage.getItem(`sat-attitude-mode-${noradId}`) === 'constant' ? 'constant' : 'real';
}

export function setSatAttitudeMode(noradId, mode) {
  if (mode === 'constant') localStorage.setItem(`sat-attitude-mode-${noradId}`, 'constant');
  else                     localStorage.removeItem(`sat-attitude-mode-${noradId}`); // 'real' is the default, nothing to store
}

// ── Parsing (pure — no localStorage access at module scope or in these
// functions — so the live verification script can import them standalone) ──

export function stripBearerPrefix(token) {
  return (token ?? '').replace(/^Bearer\s+/i, '').trim();
}

// Empirically-found body-frame correction — live-calibrated against the
// real ground segment (rendering the 3D model/reference arrows with a
// live-adjustable debug rotation tool, comparing against the true Sun
// direction at several real epochs, since removed once calibration was
// confirmed). Even with the conjugate question settled (see parseApm
// below), MIC's SC_BODY axes are still rotated relative to what this app
// treats as "the" body frame: 180° about X, then 90° about Y, 0° about Z (Z
// included for completeness even though it's currently a no-op). Unrelated
// to — and doesn't change — the constant Sun-Pointing model-mesh bias
// (_modelBiasZ180/_ffBias in SatEntity.js), confirmed separately to already
// be correct.
const _REAL_FRAME_QX_180 = { x: 1, y: 0, z: 0, w: 0 };
const _REAL_FRAME_QY_90  = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

// FF-specific correction, found the same way as the universal one above —
// live X/Y/Z sliders + a conjugate toggle, comparing the rendered model and
// reference arrows against the true Sun direction in real mode. No
// conjugate needed; just -90° about X, 0° about Y/Z. Applied ON TOP of the
// universal frame correction above (see applyRealAttitudeModelCorrection),
// only for FF, only in the real (MIC) branch — never Sun Pointing, never
// the legacy-posted path, and never baked into parseApm itself (which stays
// model-agnostic, since it's also used standalone by
// scripts/check-mic-api.mjs).
const _FF_REAL_BIAS_X_M90 = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

function _qMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// Parses MIC's CCSDS APM (plain-text key=value) response into
// { t: epochMs, q: {x,y,z,w} } — throws a descriptive Error on anything
// missing/malformed, for the caller to catch.
export function parseApm(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const epoch = fields.get('EPOCH');
  if (!epoch) throw new Error('APM response missing EPOCH');
  // Must force UTC — a bare "2026-07-18T18:28:15.117" (no Z/offset) parses as
  // LOCAL time per spec, which would silently corrupt every timestamp on any
  // machine not itself running in UTC.
  const t = Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(epoch) ? epoch : `${epoch}Z`);
  if (!Number.isFinite(t)) throw new Error(`APM response has an unparseable EPOCH: ${epoch}`);

  const frameA = fields.get('Q_FRAME_A'), frameB = fields.get('Q_FRAME_B'), dir = fields.get('Q_DIR');
  if (frameA !== 'EME2000' || frameB !== 'SC_BODY' || dir !== 'A2B') {
    console.warn(`satAttitudeReal: unexpected APM frame/direction (Q_FRAME_A=${frameA}, Q_FRAME_B=${frameB}, Q_DIR=${dir}) — the live-confirmed no-conjugate handling below assumes this exact frame/direction and may no longer be correct`);
  }

  const q1 = parseFloat(fields.get('Q1')), q2 = parseFloat(fields.get('Q2')), q3 = parseFloat(fields.get('Q3')), qc = parseFloat(fields.get('QC'));
  if (![q1, q2, q3, qc].every(Number.isFinite)) throw new Error('APM response has non-numeric/missing Q1/Q2/Q3/QC');

  // NO conjugate — confirmed live (see file header): despite MIC's Q_DIR=A2B
  // label reading as "EME2000→SC_BODY" (which by the standard aerospace
  // convention would need inverting to match this app's body→ECI tables),
  // feeding Q1/Q2/Q3/QC through unmodified is what actually lines the
  // rendered model/reference arrows up with the true Sun direction in
  // practice. Quaternion active/passive and frame-direction conventions are
  // notoriously inconsistent across libraries/standards — this was corrected
  // by live A/B comparison against the real ground segment, not derivation.
  const rawQ = { x: q1, y: q2, z: q3, w: qc };
  // Plus the separate, also live-calibrated body-frame correction — see
  // _REAL_FRAME_QX_180/_REAL_FRAME_QY_90's own comment above.
  const q = _qMultiply(_qMultiply(rawQ, _REAL_FRAME_QY_90), _REAL_FRAME_QX_180);
  return { t, q };
}

// Applied by SatEntity.js's _attitudeFromTable and TimePlayer.js's
// _attitudeBasisEci, in their real (MIC) branch only, after sampling the
// table (see _FF_REAL_BIAS_X_M90's own comment above for what/why).
export function applyRealAttitudeModelCorrection(q, model) {
  if (model !== 'FF') return q;
  return _qMultiply(q, _FF_REAL_BIAS_X_M90);
}

// ── Single-point fetch ──────────────────────────────────────────────────

async function _fetchAttitudeAt(noradId, epochDate) {
  const origin = satSubsystemOrigin(noradId, 'mic');
  const token  = stripBearerPrefix(satJwt(noradId));
  if (!origin || !token) return { ok: false, reason: 'unconfigured' };
  try {
    const res = await fetch(
      `${origin}/api/platform/v1/attitudeParameterMessage?epoch=${encodeURIComponent(epochDate.toISOString())}`,
      { headers: { Authorization: token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    // A non-ok response is MIC actively confirming there's no data for this
    // epoch (yet) — e.g. the "not enough tm data" 500 from the file header —
    // a real answer, worth the full cooldown.
    if (!res.ok) return { ok: false, reason: 'no-data' };
    return { ok: true, sample: parseApm(await res.text()) };
  } catch {
    // Thrown before/without a response landing — request timeout
    // (FETCH_TIMEOUT_MS) or a network-level failure. Not a confirmed answer
    // about data availability, just our own request failing to complete.
    return { ok: false, reason: 'transient' };
  }
}

// ── Client-local cache + bucket-grid prefetch ───────────────────────────

const _debounceTimer   = new Map(); // noradId -> setTimeout handle
const _lastAttemptMs   = new Map(); // noradId -> ms, for the MAX_WAIT_MS ceiling
const _inFlight        = new Set(); // `${noradId}:${bucketMs}`
const _unavailableUntil = new Map(); // `${noradId}:${bucketMs}` -> ms cooldown expiry

const _bucketStart = ms => Math.floor(ms / GRID_MS) * GRID_MS;

function _mergeSample(noradId, sample) {
  const existing = (store.realAttitude[noradId]?.entries ?? []).filter(e => Math.abs(e.t - sample.t) > 1000);
  let merged = [...existing, sample].sort((a, b) => a.t - b.t);
  if (merged.length > MAX_CACHED_SAMPLES) merged = merged.slice(merged.length - MAX_CACHED_SAMPLES);
  store.setRealAttitude(noradId, { noradId, source: 'mic', entries: merged });
}

async function _fetchAndCacheBucket(noradId, bucketMs) {
  const key = `${noradId}:${bucketMs}`;
  const existing = store.realAttitude[noradId]?.entries;
  if (existing?.some(e => Math.abs(e.t - bucketMs) < GRID_MS)) return; // already have something close enough
  if (_inFlight.has(key)) return;
  if ((_unavailableUntil.get(key) ?? 0) > Date.now()) return;

  _inFlight.add(key);
  try {
    const r = await _fetchAttitudeAt(noradId, new Date(bucketMs));
    if (r.ok) { _mergeSample(noradId, r.sample); _unavailableUntil.delete(key); }
    else if (r.reason === 'no-data')   _unavailableUntil.set(key, Date.now() + UNAVAILABLE_COOLDOWN_MS);
    else if (r.reason === 'transient') _unavailableUntil.set(key, Date.now() + TRANSIENT_COOLDOWN_MS);
    // 'unconfigured' (no origin/token) — nothing to remember, not a per-bucket condition
  } finally {
    _inFlight.delete(key);
  }
}

async function _runFetchCycle(noradId, atMs) {
  // Re-validate at fire time, not just schedule time — mode/time/speed can
  // have moved on during the debounce/wait.
  if (satAttitudeMode(noradId) !== 'real' || atMs > Date.now()) return;
  if (store.playing && Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_REAL) return;

  const entries = store.realAttitude[noradId]?.entries;
  const haveThroughMs = entries?.length ? entries[entries.length - 1].t : null;

  // Extend forward from whichever is further along: atMs's own bucket, or
  // the edge of what we already have. This is the actual fix for the
  // reported flicker — fetching from _bucketStart(atMs) alone (the old
  // version of this function) can never reach more than one bucket ahead
  // while atMs is still inside the CURRENT bucket, so scheduleAttitudeFetch's
  // proactive lookahead trigger fired at the right time but only ever
  // re-confirmed already-cached coverage (a no-op) instead of actually
  // extending it — the real fetch for the far edge only ever happened
  // reactively, right as playback crossed into a bucket that had never been
  // pre-fetched. Anchoring to haveThroughMs instead means an early urgent
  // trigger (while still comfortably inside the current bucket) genuinely
  // reaches the next bucket's far edge before it's needed.
  const startBucket   = _bucketStart(atMs);
  const fromBucket    = haveThroughMs != null ? Math.max(startBucket, _bucketStart(haveThroughMs)) : startBucket;
  const throughBucket = _bucketStart(atMs + LOOKAHEAD_MARGIN_MS) + GRID_MS;

  const buckets = [];
  for (let b = fromBucket; b <= throughBucket; b += GRID_MS) {
    if (b <= Date.now()) buckets.push(b);
  }
  if (!buckets.length && startBucket <= Date.now()) buckets.push(startBucket); // always at least the current instant

  // sampleAttitudeTable (attitudeSample.js) only ever shows real attitude at
  // atMs if it finds a BRACKETING PAIR within DEFAULT_MAX_GAP_MS (90s) of
  // each other — a single isolated bucket can never satisfy that alone. That
  // single-bucket case is exactly what the fallback line above produces when
  // haveThroughMs sits chronologically well AFTER atMs — e.g. right after
  // scrubbing BACKWARD past coverage cached near "now" from earlier
  // playback: fromBucket (anchored past haveThroughMs's bucket, ahead of
  // throughBucket) collapses the loop above to zero iterations, so only
  // atMs's own bucket gets fetched, with no close neighbor to bracket
  // against. Worse, it doesn't self-heal: _fetchAndCacheBucket's own guard
  // ("already have something close enough") silently no-ops on every later
  // call once that lone bucket is cached, even though it's still unusable in
  // isolation — a genuine permanently-stuck-on-Default-Sun-Pointing state at
  // that scrubbed position.
  //
  // ONLY step in for that exact degenerate (<2 buckets) case — the normal
  // loop above already yields >=2 buckets on every ordinary cycle (first-
  // ever fetch: LOOKAHEAD_MARGIN_MS's 20s span always straddles at least the
  // current + next bucket; steady playback: fromBucket sits at or behind the
  // existing coverage edge, and throughBucket is always >= startBucket +
  // GRID_MS — see this comment block's own math if re-deriving), so this
  // never fires there. An EARLIER version added the extra bucket
  // unconditionally on every call — reasoned to be a no-op in the steady
  // case (already-cached, so _fetchAndCacheBucket's own guard returns before
  // any network call), but the reported 30s-boundary flicker returned right
  // after that change, and MIC serving one request at a time (see file
  // header) means even a normally-redundant concurrent request is real risk
  // on whatever cycle it ISN'T already cached — not worth it when the
  // natural range already covers this fine on its own.
  if (buckets.length < 2) {
    const nextBucket = startBucket + GRID_MS;
    if (nextBucket <= Date.now() && !buckets.includes(nextBucket)) buckets.push(nextBucket);
  }

  await Promise.all(buckets.map(b => _fetchAndCacheBucket(noradId, b)));
}

// Called on every relevant store change (currentTime tick, trackedSatId
// change) — the answer to "what about the mouse": scrubbing fires this many
// times per second (native `input` events, unthrottled at the store layer),
// each call resets the trailing DEBOUNCE_MS timer, so a fast drag only
// actually fetches once it settles.
//
// Continuous playback fires this every RAF (~60Hz) forever, which would
// never let the trailing timer survive on its own. Two mechanisms handle
// that: MAX_WAIT_MS is a ceiling that forces a fetch roughly every 2s of
// WALL-CLOCK time regardless — but that has no fixed relationship to WHERE
// in a 30s sim-time bucket playback currently is, so relying on it alone can
// mean running out of buffered coverage right as a bucket boundary is
// crossed, then waiting up to ~2.4s (ceiling + fetch latency) before the
// next real sample lands — a visible, repeating flicker back to Default Sun
// Pointing every 30s. The LOOKAHEAD_MARGIN_MS check below fixes this
// properly: it looks at the actual cached coverage and fetches proactively,
// well before running out, so the fetch has time to land before it's
// actually needed — bypassing the debounce/ceiling entirely when urgent.
export function scheduleAttitudeFetch(noradId, atMs) {
  if (satAttitudeMode(noradId) !== 'real' || atMs > Date.now()) return;
  // Above MAX_SPEED_FOR_REAL, no lookahead margin can reliably beat network
  // jitter — don't even try (see the constant's own comment). Only while
  // actually playing, though — a fast speed left selected after pausing/
  // scrubbing has no bearing on this.
  if (store.playing && Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_REAL) return;

  const entries = store.realAttitude[noradId]?.entries;
  const lastCoveredMs = entries?.length ? entries[entries.length - 1].t : -Infinity;
  const gapAhead = lastCoveredMs - atMs; // positive: still have buffer ahead; negative: already ran past it
  if (gapAhead < LOOKAHEAD_MARGIN_MS && gapAhead > -URGENT_OVERRUN_MS) {
    clearTimeout(_debounceTimer.get(noradId));
    _lastAttemptMs.set(noradId, Date.now());
    _runFetchCycle(noradId, atMs);
    return;
  }

  clearTimeout(_debounceTimer.get(noradId));
  const last = _lastAttemptMs.get(noradId) ?? 0;
  if (Date.now() - last >= MAX_WAIT_MS) {
    _lastAttemptMs.set(noradId, Date.now());
    _runFetchCycle(noradId, atMs);
    return;
  }
  _debounceTimer.set(noradId, setTimeout(() => {
    _lastAttemptMs.set(noradId, Date.now());
    _runFetchCycle(noradId, atMs);
  }, DEBOUNCE_MS));
}

// ── Consumption ──────────────────────────────────────────────────────────

// Used by SatEntity.js/TimePlayer.js — null means "fall through to the
// legacy store.attitude table, then Default Sun Pointing", same as if this
// feature didn't exist. Also forces null above MAX_SPEED_FOR_REAL while
// actively playing that fast, even if some now-stale cached sample would
// otherwise still technically be within range — so the 3D model/STT
// geometry and the SatInfo label (below) always agree, rather than the
// model showing a lingering real orientation while the label already reads
// "Sun Pointing".
export function resolveRealAttitudeEntries(noradId, tMs) {
  if (satAttitudeMode(noradId) !== 'real' || tMs > Date.now()) return null;
  if (store.playing && Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_REAL) return null;
  const entries = store.realAttitude[noradId]?.entries;
  return entries?.length ? entries : null;
}

// For SatInfo.js only — what to actually SHOW, and why, at this instant.
export function attitudeDisplayState(sat, atMs) {
  if (atMs > Date.now()) return { active: 'constant', reason: 'future' };
  if (satAttitudeMode(sat.noradId) !== 'real') return { active: 'constant', reason: 'toggle-off' };
  if (!satJwt(sat.noradId)) return { active: 'constant', reason: 'no-token' };
  if (store.satSubsystemReachable[sat.id]?.mic === false) return { active: 'constant', reason: 'mic-unreachable' };
  if (store.playing && Math.abs(store.playbackSpeed) > MAX_SPEED_FOR_REAL) return { active: 'constant', reason: 'fast-forward' };
  const entries = resolveRealAttitudeEntries(sat.noradId, atMs);
  const q = entries && sampleAttitudeTable(entries, atMs, DEFAULT_MAX_GAP_MS);
  return q ? { active: 'real' } : { active: 'constant', reason: 'no-data' };
}
