import { describe, it, expect } from 'vitest';
import { parseTLE } from '../src/tle.js';

// Real ISS TLE (historic, always valid for parsing)
const ISS_3LINE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00001764  00000-0  33009-4 0  9992
2 25544  51.6401 337.6256 0003585 175.2814 350.0099 15.49558025431749`;

const ISS_2LINE = ISS_3LINE.split('\n').slice(1).join('\n');

describe('parseTLE', () => {
  it('parses a 3-line TLE and extracts name + noradId', () => {
    const r = parseTLE(ISS_3LINE);
    expect(r.name).toBe('ISS (ZARYA)');
    expect(r.noradId).toBe('25544');
    expect(r.line1).toMatch(/^1 /);
    expect(r.line2).toMatch(/^2 /);
  });

  it('initialises a valid satrec (no SGP4 error)', () => {
    const r = parseTLE(ISS_3LINE);
    expect(r.satrec).toBeDefined();
    expect(r.satrec.error).toBe(0);
  });

  it('parses a 2-line TLE with null name', () => {
    const r = parseTLE(ISS_2LINE);
    expect(r.noradId).toBe('25544');
    expect(r.name).toBeNull();
  });

  it('noradId matches the NORAD catalogue column in line 2', () => {
    const r = parseTLE(ISS_3LINE);
    expect(r.line2.substring(2, 7).trim()).toBe(r.noradId);
  });

  it('throws on completely invalid input', () => {
    expect(() => parseTLE('not a tle')).toThrow();
  });

  it('throws on a single valid-looking line', () => {
    expect(() => parseTLE('1 25544U 98067A   24001.50000000  .00001764  00000-0  33009-4 0  9992')).toThrow();
  });

  it('handles extra blank lines and whitespace', () => {
    const padded = `\n\n  ${ISS_3LINE}  \n\n`;
    const r = parseTLE(padded);
    expect(r.noradId).toBe('25544');
  });
});
