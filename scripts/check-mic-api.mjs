#!/usr/bin/env node
// Live smoke test against a real MIC (attitude restitution) host — confirms
// the endpoint's auth/response shape still matches what src/satAttitudeReal.js
// assumes, since the unit tests only catch regressions in OUR parsing code,
// not MIC changing what it actually returns.
//
// Requires network access to the ground-segment subnet, which GitHub-hosted
// runners don't have — so this SKIPS (exit 0) rather than fails when the
// configured host/token aren't set or the host is unreachable, same
// philosophy as scripts/check-gnm-api.mjs.
//
// Usage: MIC_CHECK_HOST=172.17.208.4:16060 MIC_CHECK_JWT=<raw token> node scripts/check-mic-api.mjs
// Optional: MIC_CHECK_EPOCH=<ISO8601> — an epoch known to have real attitude
//           data. Defaults to "2 hours ago", but MIC's real processing lag is
//           often much longer (confirmed live: hours, tied to when a pass's
//           telemetry gets processed) — override this if the default 200s.

import { parseApm, stripBearerPrefix } from '../src/satAttitudeReal.js';

const HOST  = process.env.MIC_CHECK_HOST;
const JWT   = process.env.MIC_CHECK_JWT;
const EPOCH = process.env.MIC_CHECK_EPOCH ?? new Date(Date.now() - 2 * 3600_000).toISOString();
const TIMEOUT_MS = 8000;

let failures = 0;
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }

async function main() {
  if (!HOST || !JWT) {
    console.log('MIC_CHECK_HOST/MIC_CHECK_JWT not set — skipping live MIC API check (expected on hosted CI runners, which have no route to the ground-segment network, and don\'t have a real JWT). Set both when running from a network with access.');
    return;
  }

  const base = HOST.startsWith('http') ? HOST : `http://${HOST}`;
  const token = stripBearerPrefix(JWT);
  const url = epoch => `${base}/api/platform/v1/attitudeParameterMessage?epoch=${encodeURIComponent(epoch)}`;

  try {
    await fetch(url(EPOCH), { headers: { Authorization: token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.log(`MIC host ${base} unreachable (${e.message}) — skipping. This is expected when run outside the ground-segment network.`);
    return;
  }

  console.log(`Checking MIC API shape at ${base} (epoch=${EPOCH}) ...\n`);

  // 1. Raw token succeeds with real data.
  console.log('[1/3] GET attitudeParameterMessage with raw token');
  try {
    const res = await fetch(url(EPOCH), { headers: { Authorization: token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      fail(`HTTP ${res.status} for a token/epoch expected to succeed — either the token is bad/expired, or MIC_CHECK_EPOCH (${EPOCH}) has no attitude data (try an older epoch, e.g. a day or more back). Body: ${(await res.text()).slice(0, 200)}`);
    } else {
      const text = await res.text();
      try {
        const sample = parseApm(text);
        if (!Number.isFinite(sample.t)) fail('parseApm returned a non-finite timestamp — EPOCH parsing broke');
        else ok(`response parsed OK (t=${new Date(sample.t).toISOString()}, q=${JSON.stringify(sample.q)})`);
      } catch (e) {
        fail(`src/satAttitudeReal.js's parseApm no longer parses a real response — shape changed. Error: ${e.message}. Raw response (first 500 chars): ${text.slice(0, 500)}`);
      }
    }
  } catch (e) {
    fail(`request failed: ${e.message}`);
  }

  // 2. "Bearer "-prefixed token must be REJECTED (401) — confirms our
  //    stripBearerPrefix defensive handling is still necessary/correct, and
  //    that MIC hasn't started accepting the prefix (which would be fine,
  //    but silently accepting BOTH forms one day and only one another day is
  //    exactly the kind of drift this check exists to catch).
  console.log('\n[2/3] GET with "Bearer "-prefixed token (expect 401)');
  try {
    const res = await fetch(url(EPOCH), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) ok('"Bearer "-prefixed token correctly rejected (401) — confirms the no-prefix requirement still holds');
    else fail(`expected 401 for a "Bearer "-prefixed token, got ${res.status} — MIC's auth requirement may have changed`);
  } catch (e) {
    fail(`request failed: ${e.message}`);
  }

  // 3. A deliberately-future epoch must NOT return 200 (validates the
  //    "unavailable" path our fetcher's cooldown logic depends on).
  console.log('\n[3/3] GET with a future epoch (expect non-200)');
  try {
    const future = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    const res = await fetch(url(future), { headers: { Authorization: token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) fail(`expected a future epoch to be unavailable, got HTTP ${res.status} with real data — MIC may now predict/extrapolate attitude, which would change how satAttitudeReal.js should treat "future"`);
    else ok(`future epoch correctly unavailable (HTTP ${res.status})`);
  } catch (e) {
    fail(`request failed: ${e.message}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed — MIC's API appears to have changed in a way that affects src/satAttitudeReal.js.`);
    process.exitCode = 1;
  } else {
    console.log('All MIC API shape checks passed.');
  }
}

main().catch(e => {
  console.error('Unexpected error running MIC API check:', e);
  process.exitCode = 1;
});
