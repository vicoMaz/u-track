import { describe, it, expect } from 'vitest';
import { deriveGnssMitigationState } from '../src/satGnssMitigation.js';

// _queryLoki always returns hits ts-sorted ascending — deriveGnssMitigationState
// relies on that invariant rather than re-sorting itself.
function hit(isoTime, text = '[WARNING] GNSS seems to be in an abnormal configuration. Applying mitigation : OFF/ON/CONFIG GNSS.') {
  return { ts: Date.parse(isoTime) * 1e6, text };
}

describe('deriveGnssMitigationState', () => {
  it('reports zero/null when nothing matched in the window', () => {
    const start = Date.parse('2026-06-19T00:00:00Z');
    const state = deriveGnssMitigationState([], start);
    expect(state).toEqual({ count30d: 0, lastMs: null, windowStartMs: start, saturated: false });
  });

  it('takes the last (most recent, ts-sorted) hit as lastMs — real hits pulled live from SOAP over a 30d window', () => {
    const start = Date.parse('2026-06-19T00:00:00Z');
    const hits = [
      hit('2026-06-22T03:11:47.000Z'),
      hit('2026-07-01T09:40:12.500Z'),
      hit('2026-07-15T14:59:03.234Z'), // real timestamp observed live
    ];
    const state = deriveGnssMitigationState(hits, start);
    expect(state.count30d).toBe(3);
    expect(state.lastMs).toBeCloseTo(Date.parse('2026-07-15T14:59:03.234Z'), 0);
    expect(state.windowStartMs).toBe(start);
    expect(state.saturated).toBe(false);
  });

  it('flags saturated when hits hit the MAX_HITS cap (200) — count/lastMs would then be understated', () => {
    const start = Date.parse('2026-06-19T00:00:00Z');
    const hits = Array.from({ length: 200 }, (_, i) => hit(new Date(start + i * 3_600_000).toISOString()));
    const state = deriveGnssMitigationState(hits, start);
    expect(state.count30d).toBe(200);
    expect(state.saturated).toBe(true);
  });

  it('does not flag saturated just under the cap', () => {
    const start = Date.parse('2026-06-19T00:00:00Z');
    const hits = Array.from({ length: 199 }, (_, i) => hit(new Date(start + i * 3_600_000).toISOString()));
    const state = deriveGnssMitigationState(hits, start);
    expect(state.saturated).toBe(false);
  });
});
