import { describe, it, expect } from 'vitest';
import { slerpQuat, sampleAttitudeTable, DEFAULT_MAX_GAP_MS } from '../src/attitudeSample.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
// 90° rotation about Z: (x,y,z,w) = (0,0,sin45,cos45)
const ROT_90_Z = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };

describe('slerpQuat', () => {
  it('returns the start quaternion at t=0', () => {
    expect(slerpQuat(IDENTITY, ROT_90_Z, 0)).toEqual(IDENTITY);
  });

  it('returns the end quaternion at t=1', () => {
    const q = slerpQuat(IDENTITY, ROT_90_Z, 1);
    expect(q.z).toBeCloseTo(ROT_90_Z.z, 5);
    expect(q.w).toBeCloseTo(ROT_90_Z.w, 5);
  });

  it('halfway between identity and a 90° Z rotation is a 45° Z rotation', () => {
    const q = slerpQuat(IDENTITY, ROT_90_Z, 0.5);
    expect(q.z).toBeCloseTo(Math.sin(Math.PI / 8), 5);
    expect(q.w).toBeCloseTo(Math.cos(Math.PI / 8), 5);
  });
});

describe('sampleAttitudeTable', () => {
  const entries = [
    { t: 1000, q: IDENTITY },
    { t: 1030, q: ROT_90_Z },
  ];

  it('returns null for an empty/missing table', () => {
    expect(sampleAttitudeTable(null, 1000)).toBeNull();
    expect(sampleAttitudeTable([], 1000)).toBeNull();
  });

  it('returns null outside the table span', () => {
    expect(sampleAttitudeTable(entries, 999)).toBeNull();
    expect(sampleAttitudeTable(entries, 1031)).toBeNull();
  });

  it('returns the exact sample at an exact hit', () => {
    expect(sampleAttitudeTable(entries, 1000)).toEqual(IDENTITY);
  });

  it('interpolates at the midpoint', () => {
    const q = sampleAttitudeTable(entries, 1015);
    expect(q.z).toBeCloseTo(Math.sin(Math.PI / 8), 5);
    expect(q.w).toBeCloseTo(Math.cos(Math.PI / 8), 5);
  });

  it('rejects a bracketing pair further apart than maxGapMs', () => {
    const sparse = [{ t: 0, q: IDENTITY }, { t: DEFAULT_MAX_GAP_MS + 1, q: ROT_90_Z }];
    expect(sampleAttitudeTable(sparse, DEFAULT_MAX_GAP_MS / 2)).toBeNull();
  });

  it('accepts a bracketing pair within maxGapMs', () => {
    const dense = [{ t: 0, q: IDENTITY }, { t: DEFAULT_MAX_GAP_MS - 1, q: ROT_90_Z }];
    expect(sampleAttitudeTable(dense, (DEFAULT_MAX_GAP_MS - 1) / 2)).not.toBeNull();
  });

  it('honors a custom maxGapMs', () => {
    const entries2 = [{ t: 0, q: IDENTITY }, { t: 100, q: ROT_90_Z }];
    expect(sampleAttitudeTable(entries2, 50, 50)).toBeNull();
    expect(sampleAttitudeTable(entries2, 50, 200)).not.toBeNull();
  });
});
