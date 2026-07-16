#!/usr/bin/env node
// Live smoke test against a real GNM (Ground Network Manager) host — GNM's API
// has changed shape on us before (e.g. pass-metrics silently ignoring
// start/end), and the unit tests only catch regressions in OUR parsing code,
// not GNM changing what it actually returns. This hits the real thing.
//
// Requires network access to the ground-segment subnet, which GitHub-hosted
// runners don't have — so this SKIPS (exit 0) rather than fails when the
// configured host isn't reachable, instead of being permanently red and
// getting ignored. Point GNM_CHECK_HOST at a real host (env var, or a
// self-hosted runner with route to the ground segment) to actually run it.
//
// Usage: GNM_CHECK_HOST=172.17.208.3:15602 node scripts/check-gnm-api.mjs
// Optional: GNM_CHECK_NETWORKS=leaf,minimum (default: leaf,minimum)
// Optional: GNM_CHECK_NAME_LEAF=ebn0, GNM_CHECK_NAME_MINIMUM=eb_n0_ratio
//           (override if the mapping in src/ui/ebn0.js ever changes)

const HOST = process.env.GNM_CHECK_HOST;
const NETWORKS = (process.env.GNM_CHECK_NETWORKS ?? 'leaf,minimum').split(',').map(s => s.trim());
const EXPECTED_NAME = {
  leaf: process.env.GNM_CHECK_NAME_LEAF ?? 'ebn0',
  minimum: process.env.GNM_CHECK_NAME_MINIMUM ?? 'eb_n0_ratio',
};
const TIMEOUT_MS = 5000;

let failures = 0;
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  if (!HOST) {
    console.log('GNM_CHECK_HOST not set — skipping live GNM API check (this is expected on hosted CI runners, which have no route to the ground-segment network). Set it when running from a network with access.');
    return;
  }

  const base = HOST.startsWith('http') ? HOST : `http://${HOST}`;

  // Reachability probe — skip cleanly rather than fail if the network just isn't there.
  try {
    await fetch(`${base}/api/v1/data/metrics/filters`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.log(`GNM host ${base} unreachable (${e.message}) — skipping. This is expected when run outside the ground-segment network.`);
    return;
  }

  console.log(`Checking GNM API shape at ${base} ...\n`);

  // 1. /api/v1/data/metrics/filters — shape and expected per-network metric names.
  console.log('[1/2] GET /api/v1/data/metrics/filters');
  try {
    const filters = await fetchJson(`${base}/api/v1/data/metrics/filters`);
    if (!Array.isArray(filters?.names)) {
      fail('response missing "names" array — endpoint shape changed');
    } else {
      ok('response has a "names" array');
      for (const network of NETWORKS) {
        const entry = filters.names.find(n => n.origin === network);
        if (!entry) {
          fail(`no "${network}" origin listed in /filters at all — was it renamed?`);
          continue;
        }
        const expected = EXPECTED_NAME[network];
        if (expected && !entry.names?.includes(expected)) {
          fail(`origin "${network}" no longer lists metric "${expected}" — src/ui/ebn0.js's EBN0_METRIC_BY_NETWORK mapping is now wrong. Currently lists: [${(entry.names ?? []).join(', ')}]`);
        } else if (expected) {
          ok(`origin "${network}" still reports metric "${expected}"`);
        }
      }
    }
  } catch (e) {
    fail(`request failed: ${e.message}`);
  }

  // 2. /api/v1/data/metrics — confirm it still accepts start/end/name/limit and
  //    returns the row shape our code depends on (id, name, value, timestamp, origin).
  console.log('\n[2/2] GET /api/v1/data/metrics (shape + start/end/limit still respected)');
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600_000);
    const url = `${base}/api/v1/data/metrics?start=${start.toISOString()}&end=${end.toISOString()}&name=${EXPECTED_NAME.leaf}&limit=5`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) {
      fail('response is not an array — endpoint shape changed');
    } else {
      ok(`response is an array (${rows.length} rows in the last 24h, limit=5)`);
      if (rows.length > 5) fail(`limit=5 was not honored — got ${rows.length} rows back (this is the exact regression pass-metrics had)`);
      else if (rows.length > 0) ok('limit was honored');
      const row = rows[0];
      if (row) {
        for (const field of ['name', 'value', 'timestamp', 'origin']) {
          if (!(field in row)) fail(`row missing expected field "${field}" — shape changed. Row: ${JSON.stringify(row)}`);
        }
        if (row && ['name', 'value', 'timestamp', 'origin'].every(f => f in row)) ok('row has all expected fields (name, value, timestamp, origin)');
      }
    }
  } catch (e) {
    fail(`request failed: ${e.message}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed — GNM's API appears to have changed in a way that affects src/ui/ebn0.js.`);
    process.exitCode = 1;
  } else {
    console.log('All GNM API shape checks passed.');
  }
}

main().catch(e => {
  console.error('Unexpected error running GNM API check:', e);
  process.exitCode = 1;
});
