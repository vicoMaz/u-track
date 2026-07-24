import { describe, it, expect } from 'vitest';
import { parseApm, stripBearerPrefix, applyRealAttitudeModelCorrection } from '../src/satAttitudeReal.js';

// Real response captured live from MIC during development (see the plan's
// appendix) — used verbatim so this test catches upstream shape drift, not
// just our own parsing bugs.
const SAMPLE_APM = `CCSDS_APM_VERS           = 1.0
CREATION_DATE            = 2026-07-23T19:16:23.198939837
ORIGINATOR               = MIC

OBJECT_NAME              = LEONAV
OBJECT_ID                = TBD
TIME_SYSTEM              = UTC
EPOCH                    = 2026-07-18T18:28:15.117
Q_FRAME_A                = EME2000
Q_FRAME_B                = SC_BODY
Q_DIR                    = A2B
Q1                       = 0.10505034011499183
Q2                       = 0.56352431098795
Q3                       = 0.5389650919333328
QC                       = 0.617188307281153
Q1_DOT                   = 0.00122927628274657
Q2_DOT                   = 3.45684719142666E-5
Q3_DOT                   = -4.5024788023256736E-5
QC_DOT                   = -2.01477045873998E-4
`;

describe('parseApm', () => {
  it('parses EPOCH as UTC', () => {
    const { t } = parseApm(SAMPLE_APM);
    expect(t).toBe(Date.UTC(2026, 6, 18, 18, 28, 15, 117));
  });

  it('applies no conjugate but does apply the live-calibrated body-frame correction (180°X, 90°Y, 0°Z — see parseApm comment)', () => {
    const { q } = parseApm(SAMPLE_APM);
    expect(q.x).toBeCloseTo(0.037946175684493655, 12);
    expect(q.y).toBeCloseTo(0.45538767919015455, 12);
    expect(q.z).toBeCloseTo(-0.8348898990106063, 12);
    expect(q.w).toBeCloseTo(0.3068240634676267, 12);
  });

  it('produces a unit quaternion', () => {
    const { q } = parseApm(SAMPLE_APM);
    const norm = Math.sqrt(q.x ** 2 + q.y ** 2 + q.z ** 2 + q.w ** 2);
    expect(norm).toBeCloseTo(1, 9);
  });

  it('handles scientific notation in the *_DOT fields without choking (even though unused)', () => {
    expect(() => parseApm(SAMPLE_APM)).not.toThrow();
  });

  it('throws on missing EPOCH', () => {
    expect(() => parseApm('Q1 = 0.1\nQ2 = 0.2\nQ3 = 0.3\nQC = 0.9')).toThrow();
  });

  it('throws on non-numeric quaternion fields', () => {
    const bad = SAMPLE_APM.replace('Q1                       = 0.10505034011499183', 'Q1 = not-a-number');
    expect(() => parseApm(bad)).toThrow();
  });

  it('warns (but does not throw) on an unexpected frame/direction', () => {
    const weird = SAMPLE_APM.replace('Q_DIR                    = A2B', 'Q_DIR                    = B2A');
    expect(() => parseApm(weird)).not.toThrow();
  });
});

describe('applyRealAttitudeModelCorrection', () => {
  it('applies the live-calibrated -90°X correction for FF', () => {
    const { q } = parseApm(SAMPLE_APM);
    const corrected = applyRealAttitudeModelCorrection(q, 'FF');
    expect(corrected.x).toBeCloseTo(-0.19012537776256894, 12);
    expect(corrected.y).toBeCloseTo(0.912364025158714, 12);
    expect(corrected.z).toBeCloseTo(-0.2683485931103893, 12);
    expect(corrected.w).toBeCloseTo(0.24378937405577206, 12);
  });

  it('produces a unit quaternion', () => {
    const { q } = parseApm(SAMPLE_APM);
    const { x, y, z, w } = applyRealAttitudeModelCorrection(q, 'FF');
    expect(Math.sqrt(x ** 2 + y ** 2 + z ** 2 + w ** 2)).toBeCloseTo(1, 9);
  });

  it('passes non-FF models through unchanged', () => {
    const { q } = parseApm(SAMPLE_APM);
    expect(applyRealAttitudeModelCorrection(q, '12U')).toEqual(q);
    expect(applyRealAttitudeModelCorrection(q, undefined)).toEqual(q);
  });
});

describe('stripBearerPrefix', () => {
  it('strips a "Bearer " prefix', () => {
    expect(stripBearerPrefix('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive', () => {
    expect(stripBearerPrefix('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('passes a bare token through unchanged', () => {
    expect(stripBearerPrefix('abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('handles empty/undefined input', () => {
    expect(stripBearerPrefix('')).toBe('');
    expect(stripBearerPrefix(undefined)).toBe('');
  });
});
