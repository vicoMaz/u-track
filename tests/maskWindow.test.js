import { describe, it, expect } from 'vitest';
import { parseTLE } from '../src/tle.js';
import { computeMaskWindow, computePolarMarkers, computePolarPoints, MASK_FLOOR_DEG } from '../src/ui/passPolar.js';

const ISS = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00001764  00000-0  33009-4 0  9992
2 25544  51.6401 337.6256 0003585 175.2814 350.0099 15.49558025431749`;

const sat = { satrec: parseTLE(ISS).satrec };

// Toulouse — a real 84°-max ISS pass for this TLE, comfortably clearing the
// floor so entry/exit are genuine mid-pass crossings rather than the pass's
// own endpoints.
const GS   = { lat: 43.604, lon: 1.444 };
const PASS = {
  start: new Date('2024-01-02T00:05:20Z'),
  end:   new Date('2024-01-02T00:16:00Z'),
};

// Kiruna — far north of the ISS's 51.6° inclination, so every pass here is a
// graze that never gets above ~4°.
const GRAZE_GS   = { lat: 67.857, lon: 20.964 };
const GRAZE_PASS = {
  start: new Date('2024-01-01T20:56:00Z'),
  end:   new Date('2024-01-01T21:01:50Z'),
};

const flatMask = deg => Array.from({ length: 360 }, () => deg);

describe('computeMaskWindow', () => {
  it('falls back to a flat 5° threshold when the station has no rx_mask', () => {
    const w = computeMaskWindow(PASS, sat, GS.lat, GS.lon, null);
    expect(w).not.toBeNull();
    expect(w.entry.el).toBeCloseTo(MASK_FLOOR_DEG, 1);
    expect(w.exit.el).toBeCloseTo(MASK_FLOOR_DEG, 1);
  });

  it('opens after AOS and closes before LOS', () => {
    const w = computeMaskWindow(PASS, sat, GS.lat, GS.lon, null);
    expect(w.entry.t).toBeGreaterThan(PASS.start.getTime());
    expect(w.exit.t).toBeLessThan(PASS.end.getTime());
    expect(w.exit.t).toBeGreaterThan(w.entry.t);
  });

  it('treats a mask below the floor as the floor', () => {
    const floored = computeMaskWindow(PASS, sat, GS.lat, GS.lon, flatMask(0));
    const noMask  = computeMaskWindow(PASS, sat, GS.lat, GS.lon, null);
    expect(floored.entry.t).toBe(noMask.entry.t);
    expect(floored.exit.t).toBe(noMask.exit.t);
  });

  it('keeps a mask that sits above the floor', () => {
    const w = computeMaskWindow(PASS, sat, GS.lat, GS.lon, flatMask(30));
    expect(w.entry.el).toBeCloseTo(30, 1);
    expect(w.exit.el).toBeCloseTo(30, 1);
    // A stricter mask can only ever narrow the window, never widen it.
    const floor = computeMaskWindow(PASS, sat, GS.lat, GS.lon, null);
    expect(w.entry.t).toBeGreaterThan(floor.entry.t);
    expect(w.exit.t).toBeLessThan(floor.exit.t);
  });

  it('returns null for a pass that never clears the floor', () => {
    const w = computeMaskWindow(GRAZE_PASS, sat, GRAZE_GS.lat, GRAZE_GS.lon, null);
    expect(w).toBeNull();
  });

  it('returns null without a satrec or coordinates', () => {
    expect(computeMaskWindow(PASS, {}, GS.lat, GS.lon, null)).toBeNull();
    expect(computeMaskWindow(PASS, sat, null, null, null)).toBeNull();
  });

  it('refines the crossing well inside the 30s sampling step', () => {
    // The raw sample grid can only land within 30s of the true crossing; the
    // bisection has to do better than that or the tick is visibly misplaced.
    const w    = computeMaskWindow(PASS, sat, GS.lat, GS.lon, null);
    const pts  = computePolarPoints(PASS, sat, GS.lat, GS.lon);
    const firstSampleInside = pts.find(p => p.el >= MASK_FLOOR_DEG);
    expect(firstSampleInside.t - w.entry.t).toBeGreaterThan(0);
    expect(firstSampleInside.t - w.entry.t).toBeLessThan(30_000);
    expect(w.entry.el - MASK_FLOOR_DEG).toBeLessThan(0.1);
  });
});

describe('computePolarMarkers (unchanged by the floor)', () => {
  it('still uses a 0° floor, so it reports no mask crossings without an rx_mask', () => {
    const pts = computePolarPoints(PASS, sat, GS.lat, GS.lon);
    const m   = computePolarMarkers(pts, null);
    expect(m.maskEntry).toBeNull();
    expect(m.maskExit).toBeNull();
  });

  it('still admits a 0° mask that computeMaskWindow would floor to 5°', () => {
    const pts = computePolarPoints(PASS, sat, GS.lat, GS.lon);
    const m   = computePolarMarkers(pts, flatMask(0));
    expect(m.maskEntry.el).toBeLessThan(MASK_FLOOR_DEG);
  });
});
