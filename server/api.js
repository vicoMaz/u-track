import { createServer } from 'http';
import { randomUUID } from 'crypto';

// ── Persistent state (survives page reloads; reset when Vite restarts) ────────
const satellites = []; // { noradId, name, tle }
const stations   = []; // { id, name, shortName, lat, lon }
const attitudes  = {}; // { [noradId]: { source, entries:[{ t(ms), q:{x,y,z,w} }] } }

// Feed queues — items added while a page is already open
const pendingSatellites = [];
const pendingStations   = [];
const pendingAttitudes  = []; // { noradId, quaternion, source, timestamp }

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
  const body = JSON.stringify(data, null, 2);
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
    title: 'Satellite Tracker API',
    version: '1.0.0',
    description:
      'Inject satellites and ground stations into the live tracker. ' +
      'Data persists across page reloads (server-side memory). ' +
      'The UI polls /api/feed every 2 s to pick up externally added items.',
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
      delete: {
        summary: 'Remove a satellite by NORAD ID',
        parameters: [{ name: 'noradId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
      },
    },

    '/api/stations': {
      get: {
        summary: 'List all ground stations',
        responses: {
          200: {
            description: 'All stored stations',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Station' } } } },
          },
        },
      },
      post: {
        summary: 'Add one or more ground stations',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { oneOf: [{ $ref: '#/components/schemas/Station' }, { type: 'array', items: { $ref: '#/components/schemas/Station' } }] },
              examples: {
                single:   { summary: 'Single station',    value: { name: 'London', shortName: 'LON', lat: 51.5074, lon: -0.1278 } },
                multiple: { summary: 'Multiple stations', value: [{ name: 'London', shortName: 'LON', lat: 51.5074, lon: -0.1278 }, { name: 'Tokyo', shortName: 'TYO', lat: 35.6762, lon: 139.6503 }] },
              },
            },
          },
        },
        responses: {
          201: { description: 'Station(s) stored', content: { 'application/json': { schema: { type: 'object', properties: { queued: { type: 'number' }, stations: { type: 'array', items: { $ref: '#/components/schemas/Station' } } } } } } },
          400: { description: 'Missing or invalid lat/lon' },
        },
      },
    },
    '/api/stations/{id}': {
      delete: {
        summary: 'Remove a ground station by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
            content: { 'application/json': { schema: { type: 'object', properties: { satellites: { type: 'array' }, stations: { type: 'array' } } } } },
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
        },
      },
      Station: {
        type: 'object',
        required: ['lat', 'lon'],
        properties: {
          id:        { type: 'string', readOnly: true },
          name:      { type: 'string' },
          shortName: { type: 'string', maxLength: 3 },
          lat:       { type: 'number', minimum: -90,  maximum: 90  },
          lon:       { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  },
};

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
      if (!satellites.some(s => s.noradId === noradId)) {
        const entry = { noradId, name: body.name || null, tle };
        satellites.push(entry);
        pendingSatellites.push(entry);
      }
      return send(res, 201, { queued: 1, noradId });
    }

    // DELETE /api/satellites/:noradId
    const satDel = path.match(/^\/api\/satellites\/(.+)$/);
    if (satDel && method === 'DELETE') {
      const noradId = satDel[1];
      const idx = satellites.findIndex(s => s.noradId === noradId);
      if (idx === -1) return send(res, 404, { error: 'Not found' });
      satellites.splice(idx, 1);
      return send(res, 200, { deleted: 1 });
    }

    // GET /api/stations
    if (path === '/api/stations' && method === 'GET') {
      return send(res, 200, stations);
    }

    // POST /api/stations
    if (path === '/api/stations' && method === 'POST') {
      const body  = await readBody(req);
      const items = Array.isArray(body) ? body : [body];
      for (const s of items) {
        if (typeof s.lat !== 'number' || typeof s.lon !== 'number')
          return send(res, 400, { error: 'Each station requires numeric lat and lon' });
        if (s.lat < -90 || s.lat > 90 || s.lon < -180 || s.lon > 180)
          return send(res, 400, { error: 'lat must be -90..90, lon must be -180..180' });
      }
      const created = items.map(s => {
        const entry = { id: s.id || `gs-${randomUUID()}`, name: s.name || '', shortName: s.shortName || '', lat: s.lat, lon: s.lon };
        stations.push(entry);
        pendingStations.push(entry);
        return entry;
      });
      return send(res, 201, { queued: created.length, stations: created });
    }

    // DELETE /api/stations/:id
    const gsDel = path.match(/^\/api\/stations\/(.+)$/);
    if (gsDel && method === 'DELETE') {
      const id  = gsDel[1];
      const idx = stations.findIndex(s => s.id === id);
      if (idx === -1) return send(res, 404, { error: 'Not found' });
      stations.splice(idx, 1);
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
        .sort((a, b) => a.t - b.t);
      const record = { noradId: String(noradId), source, entries: parsed };
      attitudes[record.noradId] = record;
      pendingAttitudes.push(record);
      return send(res, 201, { ok: true, noradId: record.noradId, entries: parsed.length });
    }

    // DELETE /api/attitude/:noradId
    const attDel = path.match(/^\/api\/attitude\/(.+)$/);
    if (attDel && method === 'DELETE') {
      const noradId = attDel[1];
      const had = !!attitudes[noradId];
      delete attitudes[noradId];
      pendingAttitudes.push({ noradId, quaternion: null }); // null = cleared
      return send(res, 200, { deleted: had ? 1 : 0 });
    }

    // GET /api/attitude — current attitude for all satellites
    if (path === '/api/attitude' && method === 'GET') {
      return send(res, 200, Object.values(attitudes));
    }

    // GET /api/feed
    if (path === '/api/feed' && method === 'GET') {
      return send(res, 200, {
        satellites: pendingSatellites.splice(0),
        stations:   pendingStations.splice(0),
        attitudes:  pendingAttitudes.splice(0),
      });
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