import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTcPackets, fetchTcPacketsProbe, matchScheduledTargets, TC_PAGE_LIMIT, TC_PROBE_LIMIT } from '../src/tcPackets.js';

// satSubsystems.js (imported by tcPackets.js) reads localStorage directly —
// stub a minimal in-memory implementation so these tests run under plain
// Node without a browser. Same helper as ebn0.test.js.
function stubLocalStorage(entries = {}) {
  const store = { ...entries };
  vi.stubGlobal('localStorage', {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; },
  });
}

// A fake /api/v1/tc-packets: holds a fixed set of packets and answers each
// request the way the real endpoint was confirmed to (2026-08-24, PANDORE
// sccRo) — [start, end] INCLUSIVE on both ends, and when maxLimit bites it
// returns the NEWEST ones, not the oldest.
function stubTcEndpoint(packets) {
  const calls = [];
  const fn = vi.fn(async url => {
    const u = new URL(url);
    const start = Date.parse(u.searchParams.get('start'));
    const end   = Date.parse(u.searchParams.get('end'));
    const limit = Number(u.searchParams.get('maxLimit'));
    calls.push({ start, end, limit });
    const body = packets
      .filter(p => {
        const t = Date.parse(p.generationTime);
        return t >= start && t <= end;
      })
      .sort((a, b) => Date.parse(b.generationTime) - Date.parse(a.generationTime)) // newest-first
      .slice(0, limit);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

// Minimal shape of one real packet, with a rootContainer carrying one
// argument:true leaf so the args extraction has something to find.
function pkt(i, timeMs, name = 'TC_5_1_SOMETHING') {
  return {
    id: `pkt-${i}`,
    generationTime: new Date(timeMs).toISOString(),
    receptionTime: null,
    apid: 10,
    sourceSeqCount: i,
    acceptance: { ack: 'SUCCESS', time: new Date(timeMs).toISOString() },
    started: null, progress: null, completed: null,
    spacePacket: {
      name,
      description: 'a command',
      rootContainer: { subContainers: [{ name: 'ARG_ONE', argument: true, physicalValue: { value: i }, unit: null, description: 'first' }] },
    },
  };
}

const SAT = { noradId: '99999' };
const T0 = Date.parse('2026-08-24T14:00:00.000Z');

beforeEach(() => stubLocalStorage({ 'sat-baseurl-99999': '172.17.99.1' }));
afterEach(() => vi.unstubAllGlobals());

describe('fetchTcPackets — walking a pass that exceeds one page', () => {
  it('returns every packet of a multi-page pass, in one ascending list', async () => {
    // 2.5 pages' worth, one packet every 10ms.
    const n = TC_PAGE_LIMIT * 2 + 137;
    const all = Array.from({ length: n }, (_, i) => pkt(i, T0 + i * 10));
    const { calls } = stubTcEndpoint(all);

    const got = await fetchTcPackets(SAT, T0, T0 + n * 10);

    expect(got).toHaveLength(n);
    expect(got.partial).toBeUndefined();
    expect(new Set(got.map(p => p.id)).size).toBe(n); // no duplicates across page boundaries
    expect(got[0].generationTime).toBe(T0);
    expect(got[n - 1].generationTime).toBe(T0 + (n - 1) * 10);
    expect(calls).toHaveLength(3);
    // Each page asked for an older slice than the last (time IS the cursor —
    // the endpoint has no offset parameter).
    expect(calls[1].end).toBeLessThan(calls[0].end);
    expect(calls[2].end).toBeLessThan(calls[1].end);
  });

  it('reports each page as it lands via onPage, growing to the full list', async () => {
    const n = TC_PAGE_LIMIT * 2;
    const all = Array.from({ length: n }, (_, i) => pkt(i, T0 + i * 10));
    stubTcEndpoint(all);

    const sizes = [];
    const got = await fetchTcPackets(SAT, T0, T0 + n * 10, { onPage: p => sizes.push(p.length) });

    expect(sizes[0]).toBe(TC_PAGE_LIMIT);
    expect(sizes[sizes.length - 1]).toBe(n);
    expect(got).toHaveLength(n);
  });

  it('keeps packets that share the oldest millisecond of a page', async () => {
    // The page boundary lands mid-millisecond: the cursor re-queries AT that
    // timestamp (end is inclusive) and dedupes, rather than stepping past it
    // and dropping whichever packets fell off the far side of the page.
    const all = [
      ...Array.from({ length: TC_PAGE_LIMIT - 2 }, (_, i) => pkt(i, T0 + 1000 + i * 10)),
      pkt(9001, T0 + 500), pkt(9002, T0 + 500), pkt(9003, T0 + 500), pkt(9004, T0 + 500),
    ];
    const got = await (stubTcEndpoint(all), fetchTcPackets(SAT, T0, T0 + 100_000));

    expect(got).toHaveLength(all.length);
    expect(got.filter(p => p.generationTime === T0 + 500)).toHaveLength(4);
  });

  it('keeps what it already has, flagged partial, when a page mid-walk fails', async () => {
    const n = TC_PAGE_LIMIT + 50;
    const all = Array.from({ length: n }, (_, i) => pkt(i, T0 + i * 10));
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (++call > 1) return { ok: false, status: 500, json: async () => [] };
      const u = new URL(url);
      const end = Date.parse(u.searchParams.get('end'));
      return {
        ok: true, status: 200,
        json: async () => all.filter(p => Date.parse(p.generationTime) <= end)
          .sort((a, b) => Date.parse(b.generationTime) - Date.parse(a.generationTime))
          .slice(0, Number(u.searchParams.get('maxLimit'))),
      };
    }));

    const got = await fetchTcPackets(SAT, T0, T0 + n * 10);
    expect(got).toHaveLength(TC_PAGE_LIMIT);
    expect(got.partial).toBe(true);
  });

  it('returns null (not an empty list) when the very first page fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => [] })));
    expect(await fetchTcPackets(SAT, T0, T0 + 1000)).toBeNull();
  });

  // A transient SCC failure must not pin an incomplete answer for the life
  // of the tab — re-opening the pass is the obvious thing to try, and it has
  // to actually re-ask.
  it('does not cache a failed walk — a later call re-fetches and succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => [] })));
    expect(await fetchTcPackets(SAT, T0, T0 + 3000)).toBeNull();
    stubTcEndpoint([pkt(1, T0 + 5), pkt(2, T0 + 15)]);
    expect(await fetchTcPackets(SAT, T0, T0 + 3000)).toHaveLength(2);
  });

  it('decodes each packet’s arguments and drops the raw schema echo', async () => {
    stubTcEndpoint([pkt(7, T0 + 5)]);
    const [p] = await fetchTcPackets(SAT, T0, T0 + 2000);
    expect(p.args).toEqual([{ name: 'ARG_ONE', description: 'first', value: 7, unit: null }]);
    expect(p.apid).toBe(10);
    expect(p.sourceSeqCount).toBe(7);
    expect(p.raw).toBeUndefined();
  });
});

describe('fetchTcPacketsProbe — the hover dots’ cheap answer', () => {
  it('makes exactly one request, capped at TC_PROBE_LIMIT, and says it may be partial', async () => {
    const n = TC_PROBE_LIMIT * 3;
    const all = Array.from({ length: n }, (_, i) => pkt(i, T0 + i * 10));
    const { calls } = stubTcEndpoint(all);

    const got = await fetchTcPacketsProbe(SAT, T0, T0 + n * 10);

    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(TC_PROBE_LIMIT);
    expect(got).toHaveLength(TC_PROBE_LIMIT);
    expect(got.partial).toBe(true);
    // Newest-first truncation: the probe holds the END of the pass.
    expect(got[got.length - 1].generationTime).toBe(T0 + (n - 1) * 10);
  });
});

describe('the walk cache', () => {
  // One entry is tens of megabytes of decoded arguments — keeping every pass
  // anyone ever clicked would be a slow leak, so the map is bounded.
  it('evicts the oldest pass once more than a few have been walked', async () => {
    const { fn } = stubTcEndpoint([pkt(1, T0 + 5)]);
    const windows = [10_000, 20_000, 30_000, 40_000, 50_000];
    for (const w of windows) await fetchTcPackets(SAT, T0, T0 + w);
    expect(fn).toHaveBeenCalledTimes(windows.length);

    // The most recent walks are still cached (no new request)…
    await fetchTcPackets(SAT, T0, T0 + 50_000);
    expect(fn).toHaveBeenCalledTimes(windows.length);
    // …the first one was evicted, so it has to be walked again.
    await fetchTcPackets(SAT, T0, T0 + 10_000);
    expect(fn).toHaveBeenCalledTimes(windows.length + 1);
  });
});

describe('matchScheduledTargets — pairing each TC_11_4 with what it scheduled', () => {
  const at = (id, ms, name) => ({ id, generationTime: ms, name });

  it('claims the nearest non-envelope packet within tolerance, one target each', () => {
    const packets = [
      at('e1', 1000, 'TC_11_4_OBSW_INSERT_TC'),
      at('t1', 1002, 'TC_6_2_OBSW_LOAD_MEMORY_ABS_ADDR'),
      at('e2', 5000, 'TC_11_4_OBSW_INSERT_TC'),
      at('t2', 5001, 'TC_6_2_OBSW_LOAD_MEMORY_ABS_ADDR'),
    ];
    const { targetFor, consumedIds } = matchScheduledTargets(packets);
    expect(targetFor.get('e1').id).toBe('t1');
    expect(targetFor.get('e2').id).toBe('t2');
    expect([...consumedIds]).toEqual(['t1', 't2']);
  });

  it('leaves an envelope unmatched when nothing is close enough in time', () => {
    const packets = [
      at('e1', 1000, 'TC_11_4_OBSW_INSERT_TC'),
      at('far', 60_000, 'TC_6_2_OBSW_LOAD_MEMORY_ABS_ADDR'),
    ];
    const { targetFor, consumedIds } = matchScheduledTargets(packets);
    expect(targetFor.size).toBe(0);
    expect(consumedIds.size).toBe(0);
  });

  it('never pairs one TC_11_4 with another, or a target with two envelopes', () => {
    const packets = [
      at('e1', 1000, 'TC_11_4_OBSW_INSERT_TC'),
      at('e2', 1001, 'TC_11_4_OBSW_INSERT_TC'),
      at('t1', 1002, 'TC_6_2_OBSW_LOAD_MEMORY_ABS_ADDR'),
    ];
    const { targetFor } = matchScheduledTargets(packets);
    expect(targetFor.get('e1')?.id).toBe('t1'); // nearest-first: e1 is checked first and claims t1
    expect(targetFor.has('e2')).toBe(false);    // t1 already claimed, and e2 can't take an envelope
  });
});
