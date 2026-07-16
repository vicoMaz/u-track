import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── File persistence ──────────────────────────────────────────────────────────
const _dir  = join(dirname(fileURLToPath(import.meta.url)), '../persistent');
const _file = join(_dir, 'persistent.json');

function _load() {
  try {
    mkdirSync(_dir, { recursive: true });
    return JSON.parse(readFileSync(_file, 'utf8'));
  } catch { return {}; }
}

function _save() {
  try {
    mkdirSync(_dir, { recursive: true });
    writeFileSync(_file, JSON.stringify({ satellites }, null, 2));
  } catch (e) { console.warn('state save failed:', e.message); }
}

const _saved = _load();

// ── State ─────────────────────────────────────────────────────────────────────
const satellites = _saved.satellites ?? []; // { noradId, name, tle, model }
const attitudes  = {};                       // { [noradId]: { ... } } — not persisted (large)

// Feed queues — items added while a page is already open
const pendingSatellites = [];
const pendingAttitudes  = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(body);
}

// ── OpenAPI 3.0 spec ──────────────────────────────────────────────────────────

const SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'chadOps API',
    version: '1.0.0',
    description:
      'Inject satellites into the live tracker. Ground stations are discovered automatically ' +
      'per satellite via its own FDS server (/api/v1/data/antennas), not managed here. ' +
      'Data persists across page reloads (server-side memory). ' +
      'The UI polls /api/feed every 2 s to pick up externally added satellites.',
  },
  paths: {
    '/api/satellites': {
      get: {
        summary: 'List all satellites',
        responses: {
          200: {
            description: 'All stored satellites',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Satellite' } } } },
          },
        },
      },
      post: {
        summary: 'Add a satellite via TLE',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Satellite' },
              example: {
                name: 'ISS',
                tle: '1 25544U 98067A   24001.50000000  .00002182  00000-0  44000-4 0  9990\n2 25544  51.6434  29.5680 0001234  45.6789 314.3210 15.49897890000000',
              },
            },
          },
        },
        responses: {
          201: { description: 'Satellite stored' },
          400: { description: 'Missing or invalid TLE' },
        },
      },
    },
    '/api/satellites/{noradId}': {
      patch: {
        summary: 'Update mutable satellite fields (baseUrl, name)',
        parameters: [{ name: 'noradId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: {
            baseUrl: { type: 'string', description: 'API server IP/host for this satellite, e.g. 172.17.206.1' },
            name:    { type: 'string' },
          } } } },
        },
        responses: { 200: { description: 'Updated satellite' }, 404: { description: 'Not found' } },
      },
      delete: {
        summary: 'Remove a satellite by NORAD ID',
        parameters: [{ name: 'noradId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
      },
    },

    '/api/attitude': {
      get: {
        summary: 'Get current attitude for all satellites',
        responses: { 200: { description: 'Array of attitude entries' } },
      },
      post: {
        summary: 'Post attitude quaternion for a satellite',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['noradId', 'quaternion'],
                properties: {
                  noradId:    { type: 'string' },
                  quaternion: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } } },
                  source:     { type: 'string', description: 'e.g. live-tm, replay, ground-est' },
                  timestamp:  { type: 'string', format: 'date-time' },
                },
              },
              example: { noradId: '25544', source: 'live-tm', entries: [{ timestamp: '2026-06-07T10:00:00Z', quaternion: { x: 0, y: 0, z: 0, w: 1 } }, { timestamp: '2026-06-07T10:01:00Z', quaternion: { x: 0.1, y: 0, z: 0, w: 0.995 } }] },
            },
          },
        },
        responses: { 201: { description: 'Attitude stored and pushed to feed' }, 400: { description: 'Invalid input' } },
      },
    },
    '/api/attitude/{noradId}': {
      delete: {
        summary: 'Clear attitude for a satellite (reverts to default sun-pointing)',
        parameters: [{ name: 'noradId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Cleared' } },
      },
    },

    '/api/feed': {
      get: {
        summary: 'Consume items added since the last poll (called by the tracker UI every 2 s)',
        responses: {
          200: {
            description: 'Newly added items since last poll (cleared after response)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    satellites: { type: 'array', items: { $ref: '#/components/schemas/Satellite' } },
                    attitudes: {
                      type: 'array',
                      description: 'Lightweight attitude notifications — on receipt the client re-fetches GET /api/attitude for the full dataset',
                      items: {
                        type: 'object',
                        properties: {
                          noradId: { type: 'string' },
                          source:  { type: 'string' },
                          cleared: { type: 'boolean', description: 'true = attitude was deleted, client should remove it' },
                          count:   { type: 'integer', description: 'Number of entries in the updated attitude record' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  components: {
    schemas: {
      Satellite: {
        type: 'object',
        required: ['tle'],
        properties: {
          noradId:  { type: 'string', readOnly: true },
          name:     { type: 'string' },
          tle:      { type: 'string', description: 'Two- or three-line TLE, lines separated by \\n' },
          model:    { type: 'string', enum: ['12U', 'FF'], default: '12U', description: '3-D model to display' },
        },
      },
    },
  },
};

// ── TLE auto-refresh via internal FDS endpoint ────────────────────────────────

async function _fetchFreshTle(sat) {
  const id   = sat.satelliteId || sat.name;
  const base = sat.baseUrl;
  if (!id || !base) return null;
  const host = base.replace(/\.\d+$/, '.3');
  const url  = `http://${host}:15602/api/v1/data/orbit/best-tle?satellite_id=${encodeURIComponent(id)}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.first_line || !data.second_line) return null;
    return `${data.first_line}\n${data.second_line}`;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function refreshAllTles() {
  let updated = 0;
  for (const sat of satellites) {
    const tle = await _fetchFreshTle(sat);
    if (tle && tle !== sat.tle) {
      sat.tle = tle;
      sat.tleUpdatedAt = new Date().toISOString();
      pendingSatellites.push({ ...sat, tleUpdate: true });
      updated++;
    }
  }
  if (updated > 0) _save();
  console.log(`[TLE] refreshed ${updated}/${satellites.length} at ${new Date().toUTCString()}`);
}

export function startTleRefresher() {
  refreshAllTles();
  setInterval(refreshAllTles, 24 * 60 * 60 * 1000);
}

// ── Request handler ───────────────────────────────────────────────────────────

export function createApiMiddleware() {
  return async function apiMiddleware(req, res, next) {
    const path   = (req.url || '/').split('?')[0];
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // GET /api/satellites
    if (path === '/api/satellites' && method === 'GET') {
      return send(res, 200, satellites);
    }

    // POST /api/satellites
    if (path === '/api/satellites' && method === 'POST') {
      const body = await readBody(req);
      const tle  = (body.tle || '').trim();
      if (!tle) return send(res, 400, { error: 'tle is required' });
      const lines = tle.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const line1 = lines.find(l => l.startsWith('1 ') && l.length >= 60);
      const line2 = lines.find(l => l.startsWith('2 ') && l.length >= 60);
      if (!line1 || !line2)
        return send(res, 400, { error: 'TLE must contain a valid line 1 and line 2' });
      const noradId = line1.substring(2, 7).trim();
      const model   = body.model === 'FF' ? 'FF' : '12U'; // default 12U
      if (!satellites.some(s => s.noradId === noradId)) {
        const entry = { noradId, name: body.name || null, satelliteId: body.satelliteId || null, tle, model };
        satellites.push(entry);
        pendingSatellites.push(entry);
        _save();
      }
      return send(res, 201, { queued: 1, noradId });
    }

    // PATCH /api/satellites/:noradId  — update mutable fields (baseUrl, name)
    const satMatch = path.match(/^\/api\/satellites\/(.+)$/);
    if (satMatch && method === 'PATCH') {
      const noradId = satMatch[1];
      const sat = satellites.find(s => s.noradId === noradId);
      if (!sat) return send(res, 404, { error: 'Not found' });
      const body = await readBody(req);
      if ('baseUrl' in body) sat.baseUrl = body.baseUrl || null;
      if ('name'    in body) sat.name    = body.name    || sat.name;
      if ('model'   in body) sat.model   = body.model === 'FF' ? 'FF' : '12U';
      _save();
      return send(res, 200, sat);
    }

    // DELETE /api/satellites/:noradId
    if (satMatch && method === 'DELETE') {
      const noradId = satMatch[1];
      const idx = satellites.findIndex(s => s.noradId === noradId);
      if (idx === -1) return send(res, 404, { error: 'Not found' });
      satellites.splice(idx, 1);
      _save();
      return send(res, 200, { deleted: 1 });
    }

    // POST /api/attitude
    // Body: { noradId, source, entries: [{ timestamp, quaternion:{x,y,z,w} }, ...] }
    if (path === '/api/attitude' && method === 'POST') {
      const body = await readBody(req);
      const { noradId, source = 'unknown', entries } = body;
      if (!noradId) return send(res, 400, { error: 'noradId is required' });
      if (!Array.isArray(entries) || entries.length === 0)
        return send(res, 400, { error: 'entries must be a non-empty array of { timestamp, quaternion }' });
      for (const e of entries) {
        const q = e.quaternion || {};
        if (!e.timestamp || [q.x, q.y, q.z, q.w].some(v => typeof v !== 'number'))
          return send(res, 400, { error: 'each entry needs timestamp and quaternion {x,y,z,w}' });
      }
      const parsed = entries
        .map(e => ({ t: new Date(e.timestamp).getTime(), q: e.quaternion }))
        .filter(e => isFinite(e.t))
        .sort((a, b) => a.t - b.t)
        .filter((e, i, a) => i === 0 || e.t !== a[i - 1].t); // drop duplicate timestamps
      const record = { noradId: String(noradId), source, entries: parsed };
      attitudes[record.noradId] = record;
      // Upsert into feed queue — keep only latest per noradId to prevent unbounded growth
      const qi = pendingAttitudes.findIndex(a => a.noradId === record.noradId);
      if (qi !== -1) pendingAttitudes[qi] = record; else pendingAttitudes.push(record);
      return send(res, 201, { ok: true, noradId: record.noradId, entries: parsed.length });
    }

    // DELETE /api/attitude/:noradId
    const attDel = path.match(/^\/api\/attitude\/(.+)$/);
    if (attDel && method === 'DELETE') {
      const noradId = attDel[1];
      const had = !!attitudes[noradId];
      delete attitudes[noradId];
      const sentinel = { noradId, quaternion: null };
      const qi = pendingAttitudes.findIndex(a => a.noradId === noradId);
      if (qi !== -1) pendingAttitudes[qi] = sentinel; else pendingAttitudes.push(sentinel);
      return send(res, 200, { deleted: had ? 1 : 0 });
    }

    // GET /api/attitude — current attitude for all satellites
    if (path === '/api/attitude' && method === 'GET') {
      return send(res, 200, Object.values(attitudes));
    }

    // GET /api/feed
    if (path === '/api/feed' && method === 'GET') {
      // Attitudes sent as lightweight notifications — client fetches full table via GET /api/attitude
      const attNotifs = pendingAttitudes.splice(0).map(a => ({
        noradId: a.noradId,
        source:  a.source,
        cleared: !a.entries,          // true = client should delete this attitude
        count:   a.entries?.length ?? 0,
      }));
      return send(res, 200, {
        satellites: pendingSatellites.splice(0),
        attitudes:  attNotifs,
      });
    }

    // GET /api/grafana-loki?host=&query=&start=&end=&limit=
    // Server-side proxy to a satellite's Grafana Loki datasource. Grafana here
    // sends no Access-Control-Allow-Origin header, so the browser can't call it
    // directly (CORS) — this route forwards the request from Node instead,
    // where CORS doesn't apply.
    if (path === '/api/grafana-loki' && method === 'GET') {
      const params = new URLSearchParams((req.url.split('?')[1]) || '');
      const host  = params.get('host');
      const query = params.get('query');
      const start = params.get('start');
      const end   = params.get('end');
      const limit = params.get('limit') || '200';
      if (!host || !query || !start || !end)
        return send(res, 400, { error: 'host, query, start and end are required' });
      const upstream = `http://${host}:3000/api/datasources/proxy/uid/P8E80F9AEF21F6940/loki/api/v1/query_range`
        + `?query=${encodeURIComponent(query)}&start=${encodeURIComponent(start)}`
        + `&end=${encodeURIComponent(end)}&limit=${encodeURIComponent(limit)}&direction=forward`;
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const r    = await fetch(upstream, { signal: ctrl.signal });
        const data = await r.json().catch(() => null);
        return send(res, r.status, data ?? { error: 'bad upstream response' });
      } catch {
        return send(res, 502, { error: 'Grafana unreachable' });
      } finally {
        clearTimeout(timer);
      }
    }

    // GET /api/spec.json
    if (path === '/api/spec.json') {
      return send(res, 200, SPEC);
    }

    if (typeof next === 'function') next();
  };
}

// ── Standalone HTTP server (kept for external use) ────────────────────────────

export function startStandaloneServer(port = 3001) {
  const handle = createApiMiddleware();
  const server = createServer((req, res) => {
    handle(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`\n  API  →  http://localhost:${port}\n`);
      resolve(server);
    });
  });
}