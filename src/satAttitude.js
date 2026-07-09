import { store }                           from './store.js';
import { satBaseUrl, satJwt, getPingIntervalSec } from './satPing.js';

const ATT_MIN_INTERVAL_MS = 90_000; // never fetch more often than 90s per satellite

const _lastAttMs  = {}; // noradId → timestamp of last successful fetch
const _attStatus  = {}; // noradId → 'ok' | 'error' | 'pending'

export function getAttStatus(noradId) { return _attStatus[noradId] ?? 'pending'; }

function _parseApm(text) {
  const get = key => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const epoch = get('EPOCH');
  const q1 = parseFloat(get('Q1'));
  const q2 = parseFloat(get('Q2'));
  const q3 = parseFloat(get('Q3'));
  const qc = parseFloat(get('QC'));
  if (!epoch || isNaN(q1) || isNaN(q2) || isNaN(q3) || isNaN(qc)) return null;
  return { t: new Date(epoch).getTime(), q: { x: q1, y: q2, z: q3, w: qc } };
}

export async function fetchSatAttitude(sat) {
  const now = Date.now();
  if (now - (_lastAttMs[sat.noradId] ?? 0) < ATT_MIN_INTERVAL_MS) return;

  const ip  = satBaseUrl(sat.noradId);
  const jwt = satJwt(sat.noradId);
  if (!ip || !jwt) return;

  const host  = ip.replace(/\.\d+$/, '.4');
  const epoch = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url   = `http://${host}:16060/api/platform/v1/attitudeParameterMessage?epoch=${encodeURIComponent(epoch)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: jwt, Accept: 'text/plain' },
    });
    if (!res.ok) {
      _attStatus[sat.noradId] = `HTTP ${res.status}`;
      return;
    }
    const text  = await res.text();
    const entry = _parseApm(text);
    if (!entry) {
      _attStatus[sat.noradId] = 'parse error';
      return;
    }

    _lastAttMs[sat.noradId] = now;
    _attStatus[sat.noradId] = 'ok';

    // Q_DOT ≈ 0 → attitude is constant; anchor window to fetch time (not APM epoch)
    // so it's always valid for "now" regardless of what epoch the server returned.
    const validMs = Math.max(ATT_MIN_INTERVAL_MS, getPingIntervalSec() * 1000) * 2;
    store.setAttitude(sat.noradId, {
      source:  'apm',
      entries: [
        { t: now,            q: entry.q },
        { t: now + validMs,  q: entry.q },
      ],
    });
  } catch (e) {
    _attStatus[sat.noradId] = e?.message?.includes('Failed to fetch') ? 'CORS / unreachable' : (e?.message ?? 'error');
  }
}
