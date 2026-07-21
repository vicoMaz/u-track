// Same-origin proxy for Grafana Loki queries. Grafana sends no
// Access-Control-Allow-Origin header, so a same-origin browser fetch()
// straight to it is blocked by CORS even though curl/Node (which don't
// enforce CORS) reach it fine — this goes through our own server's
// /api/grafana-loki instead. Extracted from procedureReport.js (its first
// user) so grafanaModal.js's raw-log viewer can reuse the exact same
// CORS-workaround instead of duplicating it.
export async function queryLoki(grafanaHost, logql, startMs, endMs, limit) {
  const params = new URLSearchParams({
    host:  grafanaHost,
    query: logql,
    start: String(Math.round(startMs * 1e6)),
    end:   String(Math.round(endMs * 1e6)),
    limit: String(limit),
  });
  try {
    const res = await fetch(`/api/grafana-loki?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const lines = [];
    for (const stream of data?.data?.result ?? []) {
      for (const [ts, text] of stream.values) lines.push({ ts: Number(ts), text });
    }
    lines.sort((a, b) => a.ts - b.ts);
    return lines;
  } catch { return null; }
}
