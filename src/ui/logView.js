// Shared log-line rendering + error-detection/navigation — used by both
// grafanaModal.js's click-triggered pop-up (one procedure's window, dimmed
// context outside it) and PassAnalyzer.js's permanent full-pass-log panel
// (no procedure boundary, so no dimming, but otherwise identical rendering).
// Split out so both places show errors the same way instead of carrying two
// copies of the same heuristic that could quietly drift apart.

export const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtLogTime(nsStr) {
  const ms = Number(nsStr) / 1e6;
  const d  = new Date(ms);
  const p  = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

// Heuristic — SCC log lines don't carry a structured severity field visible
// to this app, so error lines are found by matching common log-level/failure
// wording. Untested against real production log content; if real error lines
// use different wording than this, they'll silently not be picked up (no
// false "no errors" alarm bell — the log text itself is still there and
// readable, just not highlighted/jumpable).
export const ERROR_RE = /\b(error|fail(?:ure|ed)?|exception|critical)\b/i;

// nominalStart/nominalEnd (ms), both optional: when given, they're a
// procedure's OWN recorded start/end within a wider-padded `lines` fetch —
// lines outside that window are dimmed as context (with a divider marking
// the transition) rather than looking like part of the procedure, and only
// errors INSIDE the window count/navigate. Omit both for an unscoped view
// (e.g. a whole pass) where every line is equally "in bounds" and none of
// that applies.
export function renderLogRows(lines, nominalStart, nominalEnd) {
  if (!lines.length) return { html: '', errorIndices: [] };
  const hasNominal = Number.isFinite(nominalStart) && Number.isFinite(nominalEnd);

  if (hasNominal && !lines.some(l => { const ms = l.ts / 1e6; return ms >= nominalStart && ms <= nominalEnd; })) {
    return { html: '', errorIndices: [], noneInWindow: true };
  }

  const errorIndices = [];
  const rows = [];
  let wasCore = null; // null = not started yet; tracks the previous line's core/context state to place dividers
  lines.forEach((l, i) => {
    const ms     = l.ts / 1e6;
    const isCore = !hasNominal || (ms >= nominalStart && ms <= nominalEnd);
    if (hasNominal && wasCore !== null && isCore !== wasCore) {
      rows.push(`<div class="grm-log-divider">${isCore ? '▾ procedure starts' : '▴ procedure ends'}</div>`);
    }
    wasCore = isCore;
    const isErr = ERROR_RE.test(l.text);
    // Only count/navigate errors within the nominal window (when there is
    // one) — an error line from the dimmed before/after context belongs to
    // a different, adjacent procedure and would otherwise inflate the count
    // and get jumped to even though it's not part of what was scoped.
    if (isErr && isCore) errorIndices.push(i);
    const cls = [isErr && 'grm-log-err', !isCore && 'grm-log-context'].filter(Boolean).join(' ');
    // data-t (ms) alongside data-idx — lets a caller (PassAnalyzer.js) wire
    // a plain time-based cursor link (hover a line → drive the shared pass
    // cursor; the cursor moving → highlight the nearest line) without also
    // needing the original `lines` array kept around just for this lookup.
    rows.push(`<div class="grm-log-line${cls ? ' ' + cls : ''}" data-idx="${i}" data-t="${Math.round(ms)}"><span class="grm-log-ts">${fmtLogTime(l.ts)}</span><span class="grm-log-text">${escapeHtml(l.text)}</span></div>`);
  });
  return { html: `<div class="grm-log">${rows.join('')}</div>`, errorIndices };
}

// Wires a `.grm-err-nav`-shaped control (jump/prev/next buttons + a count
// span — see grafanaModal.js/PassAnalyzer.js's markup) to scroll/flash
// matching `.grm-log-line[data-idx]` rows inside `bodyEl`. Each caller gets
// its OWN instance/state (not shared module-level globals), since the modal
// and the permanent panel can both have log content on screen at once.
export function createErrorNav(navEl, bodyEl) {
  const jumpBtn  = navEl.querySelector('.grm-err-jump');
  const prevBtn  = navEl.querySelector('.grm-err-prev');
  const nextBtn  = navEl.querySelector('.grm-err-next');
  const countEl  = navEl.querySelector('.grm-err-count');
  let errorIndices = [];
  let cursor = -1;

  function gotoError(idx) {
    if (!errorIndices.length) return;
    cursor = ((idx % errorIndices.length) + errorIndices.length) % errorIndices.length;
    const lineIdx = errorIndices[cursor];
    const el = bodyEl.querySelector(`.grm-log-line[data-idx="${lineIdx}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Clear any earlier jump's flash first — the animation is one-shot and
    // doesn't remove its own class on end, so without this every previously
    // visited error line would stay marked .grm-log-flash forever.
    bodyEl.querySelectorAll('.grm-log-flash').forEach(f => f.classList.remove('grm-log-flash'));
    void el.offsetWidth; // restart the animation if it's already mid-flash from a previous jump to the SAME line
    el.classList.add('grm-log-flash');
    if (errorIndices.length > 1) countEl.textContent = `${cursor + 1}/${errorIndices.length}`;
  }

  jumpBtn?.addEventListener('click', () => gotoError(0));
  prevBtn?.addEventListener('click', () => gotoError(cursor - 1));
  nextBtn?.addEventListener('click', () => gotoError(cursor + 1));

  // Called after each (re-)render of bodyEl's rows with the fresh error
  // index list — resets position and updates control visibility/count.
  function setErrorIndices(indices) {
    errorIndices = indices;
    cursor = -1;
    if (prevBtn)  prevBtn.hidden  = errorIndices.length <= 1;
    if (nextBtn)  nextBtn.hidden  = errorIndices.length <= 1;
    if (countEl)  countEl.hidden = errorIndices.length <= 1;
    navEl.hidden = errorIndices.length === 0;
    // countEl's text is otherwise only ever written inside gotoError() —
    // without this, a fresh render left the counter showing whatever the
    // PREVIOUS render's count was (or blank, on the very first render)
    // until the user clicked ▲/▼/"Go to error" at least once.
    if (countEl && errorIndices.length > 1) countEl.textContent = `1/${errorIndices.length}`;
  }

  return { setErrorIndices };
}
