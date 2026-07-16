import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchEbn0Series } from '../src/ui/ebn0.js';

// satSubsystems.js (imported transitively by ebn0.js) reads localStorage
// directly — stub a minimal in-memory implementation so these tests run
// under plain Node without a browser.
function stubLocalStorage(entries = {}) {
  const store = { ...entries };
  vi.stubGlobal('localStorage', {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; },
  });
}

function mockFetchOnce(status, body) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  stubLocalStorage({ 'sat-baseurl-99999': '172.17.99.1' });
});
afterEach(() => vi.unstubAllGlobals());

describe('fetchEbn0Series — network → metric name mapping', () => {
  it('queries "ebn0" for a leaf-network pass', async () => {
    const fetchMock = mockFetchOnce(200, []);
    await fetchEbn0Series('99999', 1000, 2000, 'leaf');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('name')).toBe('ebn0');
  });

  it('queries "eb_n0_ratio" for a minimum-network pass', async () => {
    const fetchMock = mockFetchOnce(200, []);
    await fetchEbn0Series('99999', 3000, 4000, 'minimum');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('name')).toBe('eb_n0_ratio');
  });

  it('does not call fetch at all for a network with no known metric name', async () => {
    const fetchMock = mockFetchOnce(200, []);
    const result = await fetchEbn0Series('99999', 5000, 6000, 'skynopy');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call fetch when the network is missing/undefined', async () => {
    const fetchMock = mockFetchOnce(200, []);
    const result = await fetchEbn0Series('99999', 7000, 8000, undefined);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchEbn0Series — request shape', () => {
  it('sends start/end as ISO 8601 and a real limit (this endpoint honors limit, unlike pass-metrics)', async () => {
    const fetchMock = mockFetchOnce(200, []);
    await fetchEbn0Series('99999', Date.parse('2026-07-16T09:36:50.894Z'), Date.parse('2026-07-16T09:48:49.159Z'), 'leaf');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/data/metrics');
    expect(url.searchParams.get('start')).toBe('2026-07-16T09:36:50.894Z');
    expect(url.searchParams.get('end')).toBe('2026-07-16T09:48:49.159Z');
    expect(url.searchParams.get('limit')).toBe('8000');
  });

  it('targets the satellite\'s own GNM host (subnet .3, port 15602), not a shared endpoint', async () => {
    const fetchMock = mockFetchOnce(200, []);
    await fetchEbn0Series('99999', 1100, 2100, 'leaf'); // distinct window — avoid the module-level cache
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe('172.17.99.3:15602'); // base .1 → GNM subnet .3, per satSubsystems.js
  });
});

describe('fetchEbn0Series — response parsing', () => {
  it('maps {timestamp,value} rows into {t,v} and sorts by time', async () => {
    mockFetchOnce(200, [
      { name: 'ebn0', value: 9.5, timestamp: '2026-07-16T09:40:00.000Z' },
      { name: 'ebn0', value: 10.1, timestamp: '2026-07-16T09:38:00.000Z' },
      { name: 'ebn0', value: 8.9, timestamp: '2026-07-16T09:42:00.000Z' },
    ]);
    const series = await fetchEbn0Series('99999', 9000, 10000, 'leaf');
    expect(series).toHaveLength(3);
    expect(series.map(p => p.v)).toEqual([10.1, 9.5, 8.9]); // sorted by t ascending
    expect(series[0].t).toBeLessThan(series[1].t);
  });

  it('returns null (not an empty array) when the API returns no rows', async () => {
    mockFetchOnce(200, []);
    const series = await fetchEbn0Series('99999', 11000, 12000, 'leaf');
    expect(series).toBeNull();
  });

  it('returns null when the request fails (non-2xx)', async () => {
    mockFetchOnce(500, { error: 'boom' });
    const series = await fetchEbn0Series('99999', 13000, 14000, 'leaf');
    expect(series).toBeNull();
  });

  it('returns null when fetch itself throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const series = await fetchEbn0Series('99999', 15000, 16000, 'leaf');
    expect(series).toBeNull();
  });

  it('returns null when no GNM host is configured for this satellite', async () => {
    stubLocalStorage({}); // no sat-baseurl entry at all
    const fetchMock = mockFetchOnce(200, []);
    const series = await fetchEbn0Series('unknown-sat', 17000, 18000, 'leaf');
    expect(series).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchEbn0Series — caching', () => {
  it('does not re-fetch for an identical (noradId, window, network)', async () => {
    const fetchMock = mockFetchOnce(200, [
      { name: 'ebn0', value: 9.0, timestamp: '2026-07-16T09:40:00.000Z' },
    ]);
    const key = ['99999', 19000, 20000, 'leaf'];
    const first  = await fetchEbn0Series(...key);
    const second = await fetchEbn0Series(...key);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
