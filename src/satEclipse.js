// Standalone eclipse-window computation, for callers that just want a plain
// list of {start,end} windows over an arbitrary range and don't need
// Scheduler.js's own gantt-specific pan/zoom-driven recompute lifecycle
// (_eclipseGen/_eclipseJobSat there track a live, changing viewport; this is
// a one-shot compute over a fixed range, e.g. AlertAnalyzer.js's histogram
// band overlay).
//
// Same generator + time-budgeted chunk runner as Scheduler.js's own
// _eclipseWork/_runEclipseChunk — a flat loop over several days of 1-min-step
// SGP4 propagation is a single main-thread stall, visible as a hitch, if run
// in one go.
import { propagate } from './tle.js';
import { sunDirectionECI, isInEclipse } from './sunVector.js';

const ECLIPSE_STEP_MS = 60_000;

function* _eclipseWork(satrec, t0, t1) {
  const windows = [];
  let inEcl = false, wStart = 0;
  const d = new Date();
  for (let t = t0; t <= t1; t += ECLIPSE_STEP_MS) {
    d.setTime(t);
    const r = propagate(satrec, d);
    if (r) {
      const ecl = isInEclipse(r.eciPos, sunDirectionECI(d));
      if (ecl && !inEcl)      { wStart = t; inEcl = true; }
      else if (!ecl && inEcl) { windows.push({ start: wStart, end: t }); inEcl = false; }
    }
    yield;
  }
  if (inEcl) windows.push({ start: wStart, end: t1 });
  return windows;
}

// Calls onDone(windows) once, asynchronously — [] immediately if the
// satellite has no propagatable TLE at all.
//
// Returns a cancel function, and callers are expected to use it. This walks a
// 7-day window at a 60s step — ~10,080 propagate + sunDirectionECI + isInEclipse
// evaluations — spread over ~40-60 macrotasks that each hold the main thread for
// 8ms. Guarding only the CALLBACK (which is all AlertAnalyzer used to do) throws
// the result away but lets the work run to completion, so switching satellites a
// few times in a row stacked several full chains on top of each other and
// saturated the main thread for results all but one of which were discarded.
// The two other copies of this chunked-generator pattern (Scheduler.js,
// TimePlayer.js) both check a generation token inside step(); this is the same
// idea, expressed as a handle so the caller doesn't need module state.
export function computeEclipseWindows(sat, t0, t1, onDone) {
  if (!sat.satrec) { onDone([]); return () => {}; }
  const gen = _eclipseWork(sat.satrec, t0, t1);
  let cancelled = false;
  (function step() {
    if (cancelled) return;
    const budgetStart = performance.now();
    let result;
    do { result = gen.next(); } while (!result.done && performance.now() - budgetStart < 8);
    if (cancelled) return; // may have been cancelled during this slice
    if (result.done) onDone(result.value);
    else setTimeout(step, 0);
  })();
  return () => { cancelled = true; };
}
