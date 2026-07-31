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

// Closest the Eb/N0 chart's scroll-to-zoom can ever get on the time axis —
// TM/TC samples land a few seconds apart at best, so zooming in tighter than
// this reveals no further detail, just wasted empty space either side of a
// single point.
const EBN0_MIN_SPAN_MS = 5_000;

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

// Vertical crosshair line only — no on-curve TM/TC dots and no floating
// "TM 5.85 dB"/"TC 3.87 dB" text callout (both used to live here). Removed:
// PassAnalyzer.js's .pa-ebn0-readout already shows both curves' exact values
// (plus each histogram's own bucket rate) for the hovered moment in one
// fixed spot, so the on-curve dots were a second, redundant readout of the
// same numbers the line already marks the position of.
function _showEbn0Cursor(ebn0El, tmSeries, tmPoint, procedures, tcSeries, cursorT, fallbackRange, spanMode, viewRange) {
  const line = ebn0El.querySelector('.ebn0-cursor-line');
  if (!line) return;

  // The hovered time itself drives the line's position — not a nearby
  // sample's time — so it still tracks correctly (e.g. a TC packet's send
  // time, driven externally via driveFromTime) even when there's no
  // telemetry sample anywhere near it, rather than requiring one to exist
  // just to know where to draw the line.
  const t = cursorT ?? tmPoint?.t;
  if (t == null) return;

  const { width, height } = _chartDims(ebn0El);
  // viewRange: same scroll-to-zoom window the chart itself was just drawn
  // against (see ebn0Scales' own comment) — without it, the line would track
  // the FULL pass's time domain instead of whatever's currently zoomed in on.
  const { xScale } = ebn0Scales(tmSeries, procedures, fallbackRange, tcSeries, width, height, spanMode, viewRange);
  const x = xScale(t);
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  line.setAttribute('visibility', 'visible');
}

function _hideEbn0Cursor(ebn0El) {
  ebn0El?.querySelector('.ebn0-cursor-line')?.setAttribute('visibility', 'hidden');
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
// an arbitrary timestamp — a caller that ignores the return value is
// unaffected.
//
// onCursor(t), optional: called with the hovered timestamp on every move
// (polar OR Eb/N0, and externally via driveFromTime) and with null on
// clear/mouseleave — lets a caller react to the SAME moment this module
// already tracks (e.g. PassAnalyzer.js highlighting whichever TC packet was
// sent closest to it) without this module needing to know anything about
// what a "TC packet" is. Existing callers that don't pass it are unaffected.
//
// viewRange ({t0,t1} ms), optional: the Eb/N0 chart's CURRENT scroll-to-zoom
// window (see ebn0Scales' own comment) — must be the exact same value the
// caller just built this chart's SVG against, or hover math here would drift
// out of sync with what's actually drawn.
//
// onZoom(viewRange), optional: called with a new {t0,t1} window (or null,
// meaning "back to fully zoomed out") whenever the user scroll-wheels over
// the Eb/N0 chart. This module only computes the new window and reports
// it — it has no way to redraw the chart itself (that means rebuilding the
// whole SVG string, which lives in ebn0.js/PassAnalyzer.js's own
// _drawEbn0), so a caller that wants scroll-to-zoom to actually DO anything
// must react to this the same way onCursor's own callers already react to
// hover. A caller that omits it keeps the wheel inert (page scrolls as
// normal instead).
export function wireLinkedCursor(polarEl, polarPoints, ebn0El, ebn0Series, procedures, tcSeries, fallbackRange, onCursor, spanMode, viewRange, onZoom) {
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
      _showEbn0Cursor(ebn0El, ebn0Series, tmPoint, procedures, tcSeries, t, fallbackRange, spanMode, viewRange);
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
      const { t0, t1 } = ebn0Scales(ebn0Series, procedures, fallbackRange, tcSeries, width, height, spanMode, viewRange);
      const rect = ebn0El.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * width;
      const frac = Math.min(1, Math.max(0, (px - PAD_L) / (width - PAD_L - PAD_R)));
      driveFromTime(t0 + frac * (t1 - t0));
    });
    hit?.addEventListener('mouseleave', clearAll);

    // Scroll-to-zoom the X (time) axis only — keeps the time under the
    // cursor fixed while rescaling, same math as Scheduler.js's/
    // TimePlayer.js's own gantt wheel-zoom. The Y (dB) axis never moves:
    // ebn0Scales derives lo/hi from the full series regardless of viewRange
    // (see its own comment), so onZoom narrowing/widening viewRange only
    // ever touches xScale, never yScale.
    if (onZoom) {
      hit?.addEventListener('wheel', ev => {
        ev.preventDefault();
        const { width, height } = _chartDims(ebn0El);
        const { t0, t1, fullT0, fullT1 } = ebn0Scales(ebn0Series, procedures, fallbackRange, tcSeries, width, height, spanMode, viewRange);
        const rect  = ebn0El.getBoundingClientRect();
        const px    = (ev.clientX - rect.left) / rect.width * width;
        const frac  = Math.min(1, Math.max(0, (px - PAD_L) / (width - PAD_L - PAD_R)));
        const pivot = t0 + frac * (t1 - t0);
        const factor  = ev.deltaY < 0 ? 0.6 : 1 / 0.6;
        const fullSpan = fullT1 - fullT0;
        const minSpan  = Math.min(fullSpan, EBN0_MIN_SPAN_MS);
        let newSpan = Math.max(minSpan, Math.min(fullSpan, (t1 - t0) * factor));
        let newT0 = pivot - frac * newSpan;
        let newT1 = newT0 + newSpan;
        if (newT0 < fullT0) { newT0 = fullT0; newT1 = newT0 + newSpan; }
        else if (newT1 > fullT1) { newT1 = fullT1; newT0 = newT1 - newSpan; }
        // Snapping back to the full domain (rather than a viewRange that
        // just happens to equal it) is what lets the caller tell "still
        // zoomed, but zoomed all the way out" apart from "never zoomed" —
        // immaterial to rendering either way, but keeps onZoom's own null
        // meaning ("fully zoomed out") consistent for its caller.
        onZoom(newSpan >= fullSpan ? null : { t0: newT0, t1: newT1 });
      }, { passive: false });
    }
  }

  return { driveFromTime, clear: clearAll };
}
