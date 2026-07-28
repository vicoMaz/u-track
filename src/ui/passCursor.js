// Bidirectional hover cursor shared between a pass's polar trajectory plot and
// its Eb/N0 time-series chart — both represent the same pass timeline, so
// hovering either one highlights the corresponding moment on both.
//
// The polar plot has no time axis of its own (it's a spatial az/el trace), so
// hovering it finds the nearest sampled point by canvas (x,y) distance; that
// point's timestamp then drives the Eb/N0 side (nearest sample by time).
// Hovering the Eb/N0 chart works the other way: mouse x → time → nearest
// sample, and that timestamp drives the polar dot (nearest point by time).
import { POLAR_VIEWBOX } from './passPolar.js';
import { CHART_W, CHART_H, PAD_L, PAD_R, ebn0Scales, syncEbn0DotSizes } from './ebn0.js';

// A caller (e.g. PassAnalyzer.js) may build the Eb/N0 chart at a custom,
// wider width/height than the CHART_W/CHART_H default — read the ACTUAL
// dimensions off the live SVG's own viewBox rather than assuming the
// constant, so hover math and label clamping stay correct for it too.
function _chartDims(ebn0El) {
  const vb = ebn0El?.viewBox?.baseVal;
  return { width: vb?.width || CHART_W, height: vb?.height || CHART_H };
}

function _nearestByTime(points, t) {
  let best = points[0], bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.t - t);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return best;
}

function _fmtTime(t) {
  return new Date(t).toISOString().slice(11, 19);
}

function _showPolarCursor(polarEl, point) {
  if (!point) return;
  const dot  = polarEl.querySelector('.polar-cursor-dot');
  const text = polarEl.querySelector('.polar-cursor-text');
  const bg   = polarEl.querySelector('.polar-cursor-label-bg');
  if (!dot || !text || !bg) return;
  dot.setAttribute('cx', point.x);
  dot.setAttribute('cy', point.y);
  const label = `${_fmtTime(point.t)} ${point.el.toFixed(0)}°`;
  const ty = point.y > POLAR_VIEWBOX / 2 ? point.y - 6 : point.y + 10;
  text.setAttribute('x', point.x);
  text.setAttribute('y', ty);
  text.textContent = label;
  const labelW = label.length * 3.2;
  bg.setAttribute('x', point.x - labelW / 2);
  bg.setAttribute('y', ty - 7);
  bg.setAttribute('width', labelW);
  [dot, text, bg].forEach(el => el.setAttribute('visibility', 'visible'));
}

function _hidePolarCursor(polarEl) {
  ['polar-cursor-dot', 'polar-cursor-text', 'polar-cursor-label-bg'].forEach(cls => {
    polarEl?.querySelector(`.${cls}`)?.setAttribute('visibility', 'hidden');
  });
}

// Dots + the vertical crosshair line only — no floating "TM 5.85 dB"/
// "TC 3.87 dB" text callout anymore (that used to live here, drawn next to
// each dot). PassAnalyzer.js's .pa-ebn0-readout now shows those same two
// values, plus each histogram's own bucket rate, in one fixed spot instead
// of a label that had to dodge the chart edges and drifted around with the
// mouse — dots stay as the actual on-curve position marker.
function _showEbn0Cursor(ebn0El, tmSeries, tmPoint, procedures, tcSeries, cursorT, fallbackRange, spanMode) {
  const line  = ebn0El.querySelector('.ebn0-cursor-line');
  const dot   = ebn0El.querySelector('.ebn0-cursor-dot');
  const dot2  = ebn0El.querySelector('.ebn0-cursor-dot2');
  if (!line) return;

  // The hovered time itself drives the line's position — not a nearby
  // sample's time — so it still tracks correctly (e.g. a TC packet's send
  // time, driven externally via driveFromTime) even when there's no
  // telemetry sample anywhere near it, rather than requiring one to exist
  // just to know where to draw the line.
  const t = cursorT ?? tmPoint?.t;
  if (t == null) return;

  const { width, height } = _chartDims(ebn0El);
  const { xScale, yScale } = ebn0Scales(tmSeries, procedures, fallbackRange, tcSeries, width, height, spanMode);
  const x = xScale(t);
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  line.setAttribute('visibility', 'visible');

  if (dot) {
    if (tmPoint) {
      dot.setAttribute('cx', xScale(tmPoint.t)); dot.setAttribute('cy', yScale(tmPoint.v));
      dot.setAttribute('visibility', 'visible');
    } else {
      dot.setAttribute('visibility', 'hidden');
    }
  }

  const tcPoint = tcSeries?.length ? _nearestByTime(tcSeries, t) : null;
  if (dot2) {
    if (tcPoint) {
      dot2.setAttribute('cx', xScale(tcPoint.t)); dot2.setAttribute('cy', yScale(tcPoint.v));
      dot2.setAttribute('visibility', 'visible');
    } else {
      dot2.setAttribute('visibility', 'hidden');
    }
  }
}

function _hideEbn0Cursor(ebn0El) {
  ['ebn0-cursor-line', 'ebn0-cursor-dot', 'ebn0-cursor-dot2'].forEach(cls => {
    ebn0El?.querySelector(`.${cls}`)?.setAttribute('visibility', 'hidden');
  });
}

// polarEl/ebn0El are the live <svg class="pass-polar">/<svg class="ebn0-chart">
// elements (already in the DOM); polarPoints/ebn0Series/tcSeries are their
// respective data arrays. Any side may be absent — wiring degrades gracefully.
// `fallbackRange` ({t0,t1} ms) should be the SAME object the caller already
// passed to buildEbn0SVG/ebn0HTML — without it, a pass with no Eb/N0 data at
// all (common; a TC's send time rarely lines up with a telemetry sample)
// makes ebn0Scales fall back to a degenerate [0, someRealTimestamp] domain,
// squashing every cursor position to nearly the same spot near the right
// edge instead of tracking the actual hovered time.
// Returns { driveFromTime, clear } so a caller outside this pair (e.g.
// PassAnalyzer.js hovering a TC packet row) can drive the same cursor from
// an arbitrary timestamp — existing callers that ignore the return value
// (PassDetailPanel.js) are unaffected.
//
// onCursor(t), optional: called with the hovered timestamp on every move
// (polar OR Eb/N0, and externally via driveFromTime) and with null on
// clear/mouseleave — lets a caller react to the SAME moment this module
// already tracks (e.g. PassAnalyzer.js highlighting whichever TC packet was
// sent closest to it) without this module needing to know anything about
// what a "TC packet" is. Existing callers that don't pass it are unaffected.
export function wireLinkedCursor(polarEl, polarPoints, ebn0El, ebn0Series, procedures, tcSeries, fallbackRange, onCursor, spanMode) {
  const hasPolar = !!(polarEl && polarPoints?.length);
  // Chart existing (not "has data") is the bar — buildEbn0SVG already draws
  // empty axes from fallbackRange alone, and the cursor line should track
  // hover across that empty chart too, not just when a series happens to
  // have data in it.
  const hasEbn0  = !!ebn0El;
  if (hasEbn0) syncEbn0DotSizes(ebn0El);
  if (!hasPolar && !hasEbn0) return { driveFromTime() {}, clear() {} };

  function driveFromTime(t) {
    if (hasPolar) _showPolarCursor(polarEl, _nearestByTime(polarPoints, t));
    if (hasEbn0) {
      const tmPoint = ebn0Series?.length ? _nearestByTime(ebn0Series, t) : null;
      _showEbn0Cursor(ebn0El, ebn0Series, tmPoint, procedures, tcSeries, t, fallbackRange, spanMode);
    }
    onCursor?.(t);
  }
  function clearAll() {
    if (hasPolar) _hidePolarCursor(polarEl);
    if (hasEbn0)  _hideEbn0Cursor(ebn0El);
    onCursor?.(null);
  }

  if (hasPolar) {
    const hit = polarEl.querySelector('.polar-hit');
    hit?.addEventListener('mousemove', ev => {
      const rect = polarEl.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width  * POLAR_VIEWBOX;
      const py = (ev.clientY - rect.top)  / rect.height * POLAR_VIEWBOX;
      let nearest = polarPoints[0], bestD = Infinity;
      for (const p of polarPoints) {
        const d = (p.x - px) ** 2 + (p.y - py) ** 2;
        if (d < bestD) { bestD = d; nearest = p; }
      }
      driveFromTime(nearest.t);
    });
    hit?.addEventListener('mouseleave', clearAll);
  }

  if (hasEbn0) {
    const hit = ebn0El.querySelector('.ebn0-hit');
    hit?.addEventListener('mousemove', ev => {
      const { width, height } = _chartDims(ebn0El);
      const { t0, t1 } = ebn0Scales(ebn0Series, procedures, fallbackRange, tcSeries, width, height, spanMode);
      const rect = ebn0El.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * width;
      const frac = Math.min(1, Math.max(0, (px - PAD_L) / (width - PAD_L - PAD_R)));
      driveFromTime(t0 + frac * (t1 - t0));
    });
    hit?.addEventListener('mouseleave', clearAll);
  }

  return { driveFromTime, clear: clearAll };
}
