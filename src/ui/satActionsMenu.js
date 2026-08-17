// Fleet row "⋮" more-actions menu — a small floating dropdown, click-
// triggered (not hover, like the rest of Fleet's tooltips — these are real
// actions against the real satellite, not just information, so accidental
// hover-exposure would be the wrong default). One singleton menu element
// shared by the whole table, same precedent as actionToast.js/passTooltip.js's
// createPassTooltip — repositioned and re-filled for whichever row's icon was
// actually clicked, rather than each row standing up its own copy.
//
// Every action here is a real call against a real satellite's SCC — no
// confirm() gate (same as TimePlayer.js's own TMR-gap-download button: click
// fires immediately, the clicked item shows "Requesting…" while in flight,
// and the result — success or failure — is acknowledged via actionToast.js's
// showActionToast (its own ⚡ icon), same as that button's own two
// showActionToast calls for its success/failure outcomes.
import { satSubsystemOrigin } from '../satSubsystems.js';
import { showActionToast } from './actionToast.js';
import { fetchSatMissionMode } from '../satMissionMode.js';

let _menuEl = null;

function _ensureMenu() {
  if (_menuEl) return _menuEl;
  const el = document.createElement('div');
  el.className = 'sam-menu';
  el.style.display = 'none';
  document.body.appendChild(el);
  document.addEventListener('click', e => {
    if (el.style.display !== 'none' && !el.contains(e.target) && !e.target.closest('.co-actions-btn')) {
      _close();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });
  _menuEl = el;
  return el;
}

function _close() {
  if (_menuEl) _menuEl.style.display = 'none';
}

// POST with an empty body, same shape as the curl reference this was built
// against (accept: */*, no content-type/body needed) — SCC lives on the
// 'scc' subsystem (subnet .1, port 15000), same one satSubsystemOrigin
// already resolves for every other direct-to-SCC call in this app.
async function _postMissionMode(sat, enable, btn) {
  const label = enable ? 'Enable' : 'Disable';
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  const origin = satSubsystemOrigin(sat.noradId, 'scc');
  if (!origin) {
    showActionToast(`No SCC IP configured for ${sat.name} — can't ${label.toLowerCase()} mission mode.`);
    _close();
    return;
  }
  try {
    const res = await fetch(`${origin}/api/v1/events/mission/${enable ? 'enable' : 'disable'}`, {
      method: 'POST',
      headers: { accept: '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showActionToast(`Mission mode ${enable ? 'enabled' : 'disabled'} for ${sat.name}.`);
    fetchSatMissionMode(sat); // reflect the new state in the Fleet row right away, don't wait for the next poll cycle
  } catch (e) {
    showActionToast(`Failed to ${label.toLowerCase()} mission mode for ${sat.name}: ${e.message}`);
  }
  _close();
}

// Menu content — a flat list of section-labeled actions. Only one section
// today (Mission Mode); a later addition just appends another
// sam-menu-section + sam-menu-item pair here, no structural change needed.
function _menuHTML(sat) {
  return `
    <div class="sam-menu-section">Mission Mode</div>
    <button type="button" class="sam-menu-item" data-action="mission-enable">Enable</button>
    <button type="button" class="sam-menu-item" data-action="mission-disable">Disable</button>
  `;
}

// Attaches the click-to-open behavior to one row's "⋮" icon. Called once per
// row on every Fleet render (ChadOps.js), same wiring lifetime as its other
// per-row listeners (.co-track-btn etc.) — cheap to re-wire since the whole
// tbody is rebuilt from scratch each render anyway.
export function wireSatActionsIcon(btn, sat) {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const menu = _ensureMenu();
    const alreadyOpenForThisSat = menu.style.display !== 'none' && menu.dataset.satId === sat.id;
    _close();
    if (alreadyOpenForThisSat) return; // clicking the same icon again just closes it
    menu.dataset.satId = sat.id;
    menu.innerHTML = _menuHTML(sat);
    menu.style.display = 'block';
    const rect = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 160;
    let x = rect.left;
    let y = rect.bottom + 4;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (y + menu.offsetHeight > window.innerHeight - 8) y = rect.top - menu.offsetHeight - 4;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top  = Math.max(8, y) + 'px';

    menu.querySelector('[data-action="mission-enable"]')?.addEventListener('click', e => _postMissionMode(sat, true, e.currentTarget));
    menu.querySelector('[data-action="mission-disable"]')?.addEventListener('click', e => _postMissionMode(sat, false, e.currentTarget));
  });
}
