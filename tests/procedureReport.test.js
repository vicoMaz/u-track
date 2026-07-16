import { describe, it, expect } from 'vitest';
import { parseProcedureReport } from '../src/ui/procedureReport.js';

// Real lines pulled from live Grafana Loki (LEONAV-1, 2026-07-09T16:13:16Z pass) —
// this is the exact log shape the routine procedure emits. If Grafana/Loki or the
// procedure engine ever changes this format, this fixture should be the first
// thing to update, and this test the first signal that parsing broke.
function fixtureLines(overrides = {}) {
  const base = [
    '',
    '[INFO] Time correlation summary:',
    '  - UTC → OBT (SCC)        : -0.970 s',
    '  - UTC → Scenario offset  : +0.000 s',
    '  --------------------------------------------',
    '  => Scenario → OBT drift  : -0.970 s',
    '     (positive = OBT ahead, negative = OBT late)',
    '',
    '[INFO] ```',
    'Procedure execution report',
    '',
    'STEP                           STATUS       INFO                   TIME (s)',
    '----------------------------------------------------------------------',
    'Establish TMTC                 SUCCESS      -                        103.08',
    'TMR download                   SUCCESS      -                         21.41',
    'FSW checks                     SUCCESS      -                         15.02',
    'Orbit bulletin upload          SUCCESS      -                         17.99',
    'Pass plan                      SUCCESS      Point:Y BX:N              49.98',
    'OBT correction                 SUCCESS      0.00 s                     0.01',
    '----------------------------------------------------------------------',
    'TOTAL PROCEDURE                                                      104.42',
    '',
    '```',
    'Response Code: 202',
  ];
  return base.map((text, i) => ({ ts: 1783613593563914000 + i, text, ...overrides }));
}

describe('parseProcedureReport', () => {
  it('parses all 6 steps with correct step/status/info/time', () => {
    const report = parseProcedureReport(fixtureLines());
    expect(report).not.toBeNull();
    expect(report.steps).toHaveLength(6);
    expect(report.steps.map(s => s.step)).toEqual([
      'Establish TMTC', 'TMR download', 'FSW checks',
      'Orbit bulletin upload', 'Pass plan', 'OBT correction',
    ]);
    expect(report.steps.every(s => s.status === 'SUCCESS')).toBe(true);
  });

  it('parses the trailing TOTAL PROCEDURE line', () => {
    const report = parseProcedureReport(fixtureLines());
    expect(report.total).toBeCloseTo(104.42, 5);
  });

  it('extracts multi-word INFO fields without truncating', () => {
    const report = parseProcedureReport(fixtureLines());
    const passPlan = report.steps.find(s => s.step === 'Pass plan');
    expect(passPlan.info).toBe('Point:Y BX:N');
  });

  it('extracts INFO fields that contain a unit suffix', () => {
    const report = parseProcedureReport(fixtureLines());
    const obt = report.steps.find(s => s.step === 'OBT correction');
    expect(obt.info).toBe('0.00 s');
    expect(obt.time).toBeCloseTo(0.01, 5);
  });

  it('renders "-" INFO fields verbatim (caller decides how to display them)', () => {
    const report = parseProcedureReport(fixtureLines());
    const tmr = report.steps.find(s => s.step === 'TMR download');
    expect(tmr.info).toBe('-');
  });

  it('returns null when no "Procedure execution report" marker is present', () => {
    const lines = [{ ts: 1, text: 'some unrelated log line' }];
    expect(parseProcedureReport(lines)).toBeNull();
  });

  it('returns null on an empty line set', () => {
    expect(parseProcedureReport([])).toBeNull();
  });

  it('is tolerant of the lines arriving out of chronological order', () => {
    // _queryLoki always sorts by ts before parsing, but the parser itself
    // shouldn't silently mis-parse if that invariant were ever dropped —
    // it walks the array in given order starting from the marker, so a
    // shuffled array should simply fail to find a coherent block rather
    // than fabricate one.
    const shuffled = [...fixtureLines()].reverse();
    const report = parseProcedureReport(shuffled);
    // Reversed order: the marker line is now near the end, so nothing
    // coherent follows it — should not produce fabricated steps.
    expect(report).toBeNull();
  });
});
