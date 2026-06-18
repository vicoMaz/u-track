import { describe, it, expect } from 'vitest';
import { isInEclipse, sunDirectionECI } from '../src/sunVector.js';

describe('isInEclipse', () => {
  const sun = { x: 1, y: 0, z: 0 };

  it('returns false when satellite faces the sun', () => {
    expect(isInEclipse({ x: 7000, y: 0, z: 0 }, sun)).toBe(false);
  });

  it('returns true when satellite is directly behind Earth', () => {
    // sat at -7000 km on x-axis, sun pointing +x — classic umbra
    expect(isInEclipse({ x: -7000, y: 0, z: 0 }, sun)).toBe(true);
  });

  it('returns false when satellite is behind Earth but off-axis', () => {
    // perpendicular distance from Earth-Sun axis > R_Earth
    expect(isInEclipse({ x: -1000, y: 10000, z: 0 }, sun)).toBe(false);
  });

  it('returns false when satellite is inside Earth radius (degenerate)', () => {
    expect(isInEclipse({ x: 0, y: 0, z: 0 }, sun)).toBe(false);
  });
});

describe('sunDirectionECI', () => {
  it('returns a unit vector', () => {
    const d = sunDirectionECI(new Date('2024-06-01T12:00:00Z'));
    const mag = Math.sqrt(d.x ** 2 + d.y ** 2 + d.z ** 2);
    expect(mag).toBeCloseTo(1, 5);
  });

  it('has near-zero z at vernal equinox (sun on ecliptic)', () => {
    // At vernal equinox the sun crosses the celestial equator — z should be small
    const d = sunDirectionECI(new Date('2024-03-20T03:00:00Z'));
    expect(Math.abs(d.z)).toBeLessThan(0.1);
  });

  it('has maximum z around summer solstice (sun highest in ecliptic)', () => {
    const d = sunDirectionECI(new Date('2024-06-21T00:00:00Z'));
    expect(d.z).toBeGreaterThan(0.3); // sin(23.4°) ≈ 0.397
  });

  it('returns the same object within 1-second cache window', () => {
    const t1 = new Date('2025-01-15T08:00:00.000Z');
    const t2 = new Date('2025-01-15T08:00:00.800Z');
    const d1 = sunDirectionECI(t1);
    const d2 = sunDirectionECI(t2);
    expect(d1).toEqual(d2);
  });

  it('returns a different vector after cache expiry', () => {
    const t1 = new Date('2025-04-01T06:00:00Z');
    const t2 = new Date('2025-04-01T06:00:02Z'); // 2 s later
    const d1 = sunDirectionECI(t1);
    const d2 = sunDirectionECI(t2);
    // Not identical — sun moved slightly
    expect(d1.x === d2.x && d1.y === d2.y && d1.z === d2.z).toBe(false);
  });
});
