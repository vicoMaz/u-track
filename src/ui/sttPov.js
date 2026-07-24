// Renders one star tracker's "point of view" as a small circular sky-map:
// boresight at the center, Sun/Earth plotted at their real angular offset
// (see TimePlayer.js's computeSttGeometry — this module only draws what that
// one computes, no geometry of its own). Same simple-SVG approach as
// passPolar.js's ground-station polar plot, just pointed at the satellite's
// own sensor instead of a ground station's sky.
//
// The projection is a linear degrees-from-boresight → pixel-radius mapping
// (azimuthal-equidistant-ish), locally uniform around the boresight. That's
// fine for a small diagnostic widget; it's not meant as a precision plot.
//
// Cropped at a 45° half-angle (MAX_DEG below) — anything farther from
// boresight than that sits clamped at the rim rather than being scaled to
// fit, so the window stays a tight, zoomed-in view of the boresight's
// immediate surroundings instead of the whole sky. The circle itself is
// clipped to a true circle via CSS (border-radius:50% on .stt-pov-svg), not
// just drawn inside a square canvas.
//
// Three dashed reference rings, all centered on the boresight (dist=0):
//   FOV (ST_FOV_HALF_ANGLE_DEG) — the sensor's actual field of view, the
//     same fixed constant the 3D globe's cone rendering uses.
//   Earth exclusion (earthExclDeg) — this satellite's configured keep-out
//     angle, exact per-satellite Settings value, not the default.
//   Sun exclusion (sunExclDeg) — same, for the Sun.
// These are plain reference circles at the raw configured angle, not the
// position-dependent "how close to Earth's actual edge" boundary
// (earthLimbRadiusDeg + earthExclDeg) _isConeBlinded actually checks — Earth's
// own disk (drawn separately, at its real position) already shows that.
//
// Earth's disk itself is ringed by one more, faint, undashed circle: the
// "Earth Limb", concentric with the disk rather than the boresight — the
// top-of-atmosphere altitude (TimePlayer.js's EARTH_LIMB_KM), the real
// optical edge that blinds the sensor via atmospheric glow/scatter, not the
// solid surface. It's what earthLimbRadiusDeg (not earthRadiusDeg) actually
// measures against for blinding.

import { ST_FOV_HALF_ANGLE_DEG } from '../satStarTracker.js';

const CX = 60, CY = 60, R = 52;
const MAX_DEG = 45; // radius scale — angular separations beyond this are cropped to the rim
const RENDER_PX = 196; // rendered size — viewBox stays 120×120, this just scales the whole thing up (was 140, +40%)

// Sun/Earth icon position — clamped to exactly R, sitting right on the rim.
// Icons are drawn in a SEPARATE, unclipped overlay <svg> stacked on top of
// the clipped one (see buildSttPovSVG) specifically so they can sit here,
// at the true edge, without .stt-pov-svg's clip-path cutting them in half.
function _toXY(az, dist) {
  const r = R * Math.min(1, dist / MAX_DEG);
  const a = az * Math.PI / 180;
  return [+(CX + r * Math.sin(a)).toFixed(1), +(CY - r * Math.cos(a)).toFixed(1)];
}

// Unclamped position — for Earth's disk (see buildSttPovSVG). Earth has real
// angular SIZE (~60-70° radius at typical LEO altitude — bigger than our
// whole 45° crop), so clamping its center to the rim like a point marker
// would draw it right at the rim even when its true position is nowhere
// near the visible window, and (worse, paired with _degToPx's clamp on its
// radius) always at the widget's own maximum size regardless of geometry.
// Can land — and the disk can extend — well outside the 0–120 viewBox; the
// SVG's own default viewport clipping plus .stt-pov-svg's circular CSS clip
// crop it correctly either way, same as any other out-of-frame shape.
function _toXYUnclamped(az, dist) {
  const r = R * dist / MAX_DEG;
  const a = az * Math.PI / 180;
  return [+(CX + r * Math.sin(a)).toFixed(1), +(CY - r * Math.cos(a)).toFixed(1)];
}

function _degToPx(deg) {
  return R * Math.min(deg, MAX_DEG) / MAX_DEG;
}

// Unclamped — see _toXYUnclamped above. Used for Earth's own disk radius so
// it's drawn at its true proportional size (can exceed the visible circle
// entirely, correctly cropped by it) instead of always maxing out at R.
function _degToPxUnclamped(deg) {
  return R * deg / MAX_DEG;
}

// Sun icon — a filled 8-point spiky disc (rays alternating outer/inner
// radius around the center) plus a lighter inset core, rather than a plain
// dot, so it actually reads as "the sun" at a glance.
function _sunIconSVG(cx, cy) {
  const outerR = 5, innerR = 2.6, spikes = 8;
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = (cx + r * Math.sin(a)).toFixed(1);
    const y = (cy - r * Math.cos(a)).toFixed(1);
    d += (i === 0 ? 'M' : 'L') + x + ',' + y;
  }
  d += 'Z';
  return `<path d="${d}" fill="#ffb700" stroke="#7a4a00" stroke-width="0.3"/>
    <circle cx="${cx}" cy="${cy}" r="${(innerR * 0.7).toFixed(1)}" fill="#ffe066"/>`;
}

// Earth dial icon — a small globe (ocean disc + two continent blobs + an
// equator curve), sitting on the rim at Earth's true bearing from boresight,
// for when Earth's actual disk isn't in view (see buildSttPovSVG's
// earthVisible check) — same idea as the Sun's rim marker, just a small
// globe likeness instead of a bare directional arrow.
function _earthIconSVG(cx, cy) {
  const r = 4.6;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#3a7bbf" stroke="#173a5e" stroke-width="0.4"/>
    <path d="M ${(cx - 2.6).toFixed(1)} ${(cy - 1.8).toFixed(1)} q 2 -1.6 3.4 0.3 q 0.6 1.4 -1 1.9 q -2 0.5 -2.8 -0.8 Z" fill="#4fae66"/>
    <path d="M ${(cx + 0.6).toFixed(1)} ${(cy + 1).toFixed(1)} q 2.2 -0.4 2.6 1.3 q -0.3 1.3 -2 1 q -1.4 -0.4 -0.9 -1.9 Z" fill="#4fae66"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * 0.32).toFixed(1)}" fill="none" stroke="#173a5e" stroke-width="0.3" opacity="0.6"/>`;
}

/**
 * geom: the object returned by TimePlayer.js's computeSttGeometry(), or null
 * (satellite couldn't be propagated — e.g. decayed). label: e.g. "STT1".
 */
export function buildSttPovSVG(geom, label) {
  if (!geom) {
    return `<div class="stt-pov-cone"><div class="stt-pov-empty">No data</div><div class="stt-pov-caption">${label}</div></div>`;
  }
  const { blinded, sunBlinded, earthBlinded, sun, earth, earthRadiusDeg, earthLimbRadiusDeg, sunExclDeg, earthExclDeg, sunAngleDeg } = geom;

  const [sx, sy] = _toXY(sun.az, sun.dist);
  const [ex, ey] = _toXYUnclamped(earth.az, earth.dist);
  const earthPxR = Math.max(1.5, _degToPxUnclamped(earthRadiusDeg));
  // Top-of-atmosphere ring, concentric with Earth's own disk (not the
  // boresight-centered reference rings below) — the real optical edge that
  // blinds the sensor (see TimePlayer.js's EARTH_LIMB_KM), drawn faint since
  // it's a thin sliver just outside the solid disk, not a hard boundary.
  const earthLimbPxR = Math.max(earthPxR, _degToPxUnclamped(earthLimbRadiusDeg));

  // Dashed reference ring + degree label, both centered on the boresight —
  // see this file's header comment for what the three calls below mean.
  // `violated`: highlights THIS specific ring (solid, thicker, red, with a
  // soft glow) instead of a generic "something is blinded" indicator — the
  // outer circle deliberately does NOT tint red anymore, since "blinded"
  // alone doesn't say which threshold caused it, and a satellite can be
  // blinded by Earth, Sun, or both at once (see computeSttGeometry's
  // sunBlinded/earthBlinded).
  const VIOLATED_COLOR = '#ff3030';
  // Labels sit at a fixed lower-left azimuth, not straight up — the Sun
  // marker (and its own degree label) is routinely AT the top (always
  // exactly there for 12U's frozen az=0 — see computeSttGeometry), so a
  // top-anchored ring label collided with it constantly, not just
  // occasionally. Spread out naturally along this line by each ring's own
  // radius, so the three don't collide with each other either.
  const RING_LABEL_AZ = 250 * Math.PI / 180;
  const ring = (deg, color, violated) => {
    const r = _degToPx(deg);
    const strokeColor = violated ? VIOLATED_COLOR : color;
    const glow = violated
      ? `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${VIOLATED_COLOR}66" stroke-width="4"/>`
      : '';
    const dash = violated ? '' : ' stroke-dasharray="2,2"';
    const lx = (CX + r * Math.sin(RING_LABEL_AZ)).toFixed(1);
    const ly = (CY - r * Math.cos(RING_LABEL_AZ)).toFixed(1);
    return `${glow}<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="${violated ? 1.6 : 0.8}"${dash}/>
      <text x="${lx}" y="${ly}" text-anchor="middle" fill="${strokeColor}" font-size="6" font-family="monospace"${violated ? ' font-weight="bold"' : ''}>${deg}°</text>`;
  };

  // Sun's angle-to-boresight, as a label that travels with the icon — its
  // radial position alone can't convey the true angle once clamped to the
  // rim (any dist ≥ 45° renders at the same radius), so the number is
  // spelled out in text above it instead. Sits directly above the icon when
  // there's room; flips to below it otherwise — the icon is very often
  // clamped right at (or near) the top of the rim (e.g. always exactly there
  // for 12U's frozen az=0 — see computeSttGeometry), where "above" would
  // land outside the circle and get clipped off by .stt-pov-svg's circular
  // CSS crop.
  const LABEL_GAP = 9;
  const labelAbove = (sy - LABEL_GAP) > (CY - R + 5);
  const sly = labelAbove ? sy - LABEL_GAP : sy + LABEL_GAP;

  // Earth dial (_earthIconSVG) — a small globe icon on the rim toward
  // Earth's nearest horizon point, shown ONLY while Earth's disk doesn't
  // reach into the 45° crop at all (its near edge is farther than MAX_DEG
  // from boresight). Sits along the same azimuth as Earth's own center
  // (earth.az) — the nearest point of a sphere's limb, as seen from outside
  // it, always lies on that same great-circle line, just closer in. Once
  // the near edge comes within MAX_DEG, the disk above is already visible
  // there instead, so the icon would be redundant and disappears.
  const earthNearEdgeDeg = geom.earthAngleDeg - earthRadiusDeg;
  const earthVisible = earthNearEdgeDeg <= MAX_DEG;
  let earthDial = '';
  if (!earthVisible) {
    const dA = earth.az * Math.PI / 180;
    const [dix, diy] = _toXY(earth.az, MAX_DEG); // sits right on the rim — see the overlay <svg> below
    // Icon sits at r=R=52; label center pulled in just enough to clear it
    // (r=30 was overcorrected — too far). ~11-unit gap from the icon's own
    // edge (~47.4), enough to clear it without stranding the label off on
    // its own.
    const dR = 36;
    const dlx = +(CX + dR * Math.sin(dA)).toFixed(1);
    const dly = +(CY - dR * Math.cos(dA)).toFixed(1);
    const dAnchor = Math.sin(dA) > 0.15 ? 'start' : Math.sin(dA) < -0.15 ? 'end' : 'middle';
    earthDial = `${_earthIconSVG(dix, diy)}
      <text x="${dlx}" y="${dly.toFixed(1)}" text-anchor="${dAnchor}" fill="#7aa8d8" font-size="6" font-family="monospace">${earthNearEdgeDeg.toFixed(0)}°</text>`;
  }

  const baseSvg = `<svg width="${RENDER_PX}" height="${RENDER_PX}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="stt-pov-svg">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="#0c0c1c" stroke="#2a2a44" stroke-width="0.8"/>
    ${ring(ST_FOV_HALF_ANGLE_DEG, '#6a6a9e', false)}
    ${ring(earthExclDeg, '#8fb4ff', earthBlinded)}
    ${ring(sunExclDeg, '#e8c860', sunBlinded)}
    <line x1="${CX - 4}" y1="${CY}" x2="${CX + 4}" y2="${CY}" stroke="#556" stroke-width="0.8"/>
    <line x1="${CX}" y1="${CY - 4}" x2="${CX}" y2="${CY + 4}" stroke="#556" stroke-width="0.8"/>
    <circle cx="${ex}" cy="${ey}" r="${earthLimbPxR.toFixed(1)}" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="0.9"/>
    <circle cx="${ex}" cy="${ey}" r="${earthPxR}" fill="#3a6ea5cc" stroke="#7aa8d8" stroke-width="0.6"/>
  </svg>`;

  // Sun/Earth markers + their labels live in a SEPARATE, unclipped overlay
  // <svg> stacked exactly on top of the clipped one above (same viewBox, so
  // coordinates line up 1:1) — that's what lets them sit right at r=R, the
  // true edge, in full instead of being cut in half by .stt-pov-svg's
  // clip-path (which only applies to the base layer).
  const overlaySvg = `<svg width="${RENDER_PX}" height="${RENDER_PX}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="stt-pov-overlay-svg">
    ${earthDial}
    ${_sunIconSVG(sx, sy)}
    <text x="${sx}" y="${sly.toFixed(1)}" text-anchor="middle" fill="#ffd166" font-size="6" font-family="monospace">${sunAngleDeg.toFixed(0)}°</text>
  </svg>`;

  const status = `<span class="stt-pov-status ${blinded ? 'blinded' : 'clear'}">${blinded ? 'BLINDED' : 'CLEAR'}</span>`;
  // Raw angle readout — lets you confirm frame-to-frame whether the geometry
  // is actually changing (vs. just eyeballing dot position, easy to misjudge
  // when the motion is small or slow relative to how often you glance at it).
  const angles = `<div class="stt-pov-angles">☉ ${geom.sunAngleDeg.toFixed(1)}° · ⊕ ${geom.earthAngleDeg.toFixed(1)}°</div>`;
  return `<div class="stt-pov-cone"><div class="stt-pov-stack">${baseSvg}${overlaySvg}</div><div class="stt-pov-caption">${label}${status}</div>${angles}</div>`;
}
