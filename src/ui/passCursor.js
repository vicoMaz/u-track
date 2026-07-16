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
import { CHART_W, PAD_L, PAD_R, ebn0Scales, syncEbn0DotSizes } from './ebn0.js';

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
  const dot = polarEl.querySelector('.polar-cursor-dot');
  const text = polarEl.querySelector('.polar-cursor-text');
  const bg = polarEl.querySelector('.polar-cursor-label-bg');
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

function _showEbn0Cursor(ebn0El, series, point, procedures) {
  if (!point) return;
  const line = ebn0El.querySelector('.ebn0-cursor-line');
  const dot  = ebn0El.querySelector('.ebn0-cursor-dot');
  const text = ebn0El.querySelector('.ebn0-cursor-text');
  const bg   = ebn0El.querySelector('.ebn0-cursor-label-bg');
  if (!line || !dot || !text || !bg) return;
  const { xScale, yScale } = ebn0Scales(series, procedures);
  const x = xScale(point.t), y = yScale(point.v);
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  dot.setAttribute('cx', x);  dot.setAttribute('cy', y);
  const label = `${_fmtTime(point.t)} ${point.v.toFixed(2)}dB`;
  const lx = Math.min(Math.max(x, PAD_L + 20), CHART_W - PAD_R - 20);
  text.setAttribute('x', lx);
  text.textContent = label;
  const labelW = label.length * 3.7;
  bg.setAttribute('x', lx - labelW / 2);
  bg.setAttribute('y', -2);
  bg.setAttribute('width', labelW);
  [line, dot, text, bg].forEach(el => el.setAttribute('visibility', 'visible'));
}

function _hideEbn0Cursor(ebn0El) {
  ['ebn0-cursor-line', 'ebn0-cursor-dot', 'ebn0-cursor-text', 'ebn0-cursor-label-bg'].forEach(cls => {
    ebn0El?.querySelector(`.${cls}`)?.setAttribute('visibility', 'hidden');
  });
}

// polarEl/ebn0El are the live <svg class="pass-polar">/<svg class="ebn0-chart">
// elements (already in the DOM); polarPoints/ebn0Series are their respective
// data arrays. Either side may be absent (no coords resolved, or no metrics
// for this pass/network) — wiring degrades gracefully to a single-chart cursor.
export function wireLinkedCursor(polarEl, polarPoints, ebn0El, ebn0Series, procedures) {
  const hasPolar = !!(polarEl && polarPoints?.length);
  const hasEbn0  = !!(ebn0El && ebn0Series?.length);
  if (hasEbn0) syncEbn0DotSizes(ebn0El); // match the polar plot's actual dot pixel size
  if (!hasPolar && !hasEbn0) return;

  function driveFromTime(t) {
    if (hasPolar) _showPolarCursor(polarEl, _nearestByTime(polarPoints, t));
    if (hasEbn0)  _showEbn0Cursor(ebn0El, ebn0Series, _nearestByTime(ebn0Series, t), procedures);
  }
  function clearAll() {
    if (hasPolar) _hidePolarCursor(polarEl);
    if (hasEbn0)  _hideEbn0Cursor(ebn0El);
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
      const { t0, t1 } = ebn0Scales(ebn0Series, procedures);
      const rect = ebn0El.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * CHART_W;
      const frac = Math.min(1, Math.max(0, (px - PAD_L) / (CHART_W - PAD_L - PAD_R)));
      driveFromTime(t0 + frac * (t1 - t0));
    });
    hit?.addEventListener('mouseleave', clearAll);
  }
}
