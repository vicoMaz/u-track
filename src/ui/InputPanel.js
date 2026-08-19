import { store, nextPlaceholderColor } from '../store.js';
import { parseTLE, propagate, placeholderTLE } from '../tle.js';
import { persistSatellite, deleteServerSatellite, saveSatOrder } from '../apiPoller.js';
import { satBaseUrl, setSatBaseUrl, satJwt, setSatJwt, pingSatellite, getPingIntervalSec, restartPingPoller } from '../satPing.js';
import { SUBSYSTEMS, satSubsystemIp, satSubsystemOverride, setSatSubsystemIp, derivedSubsystemIp } from '../satSubsystems.js';
import { setNetworkVisible } from '../satAntennas.js';
import { satIsSimulated, setSatIsSimulated } from '../satSimu.js';
import { satStarTrackerConesVisible, setSatStarTrackerConesVisible } from '../satStarTracker.js';
import { fetchSatGlobals } from '../satGlobals.js';
import { openAddPointPanel } from './AddPointPanel.js';
import { satPassNotifyEnabled, setSatPassNotifyEnabled, requestPassNotifyPermission } from '../satPassNotify.js';
import { showWarningToast } from './actionToast.js';

// ─── Icons ────────────────────────────────────────────────────────────────

const SVG_EYE     = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Eye-looking-at-a-star — toggles the star tracker FOV cone. Same eye outline
// as SVG_EYE, with the pupil swapped for a small sparkle/star.
const SVG_EYE_STAR     = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><path d="M12 8.5 L13.1 10.9 L15.5 12 L13.1 13.1 L12 15.5 L10.9 13.1 L8.5 12 L10.9 10.9 Z" fill="currentColor" stroke="none"/></svg>`;
const SVG_EYE_STAR_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Pass-notify toggle (renderSettingsSatList) — plain bell, same 13px outline
// icon convention as the eye toggles above.
const SVG_BELL = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

// ─── ID-key helpers for change detection ─────────────────────────────────

let _satIdKey = '';
// Only satellites THIS client can actually reach (store.accessibleSatellites)
// — a colleague whose VPN doesn't route to a given satellite never sees it
// in this operational list. Settings' own satellite list is the exception
// (see renderSettingsSatList below) — that one still shows everything so an
// unreachable satellite can be found and its IP fixed.
const _satListKey = () => _satPanelSats().map(s => s.id).join('\0');

// SIMU satellites have no globe/map entity (GlobeView.js/MapView.js already
// exclude them) — a "track"/visibility/network row here would just be dead
// UI pointing at nothing. They stay reachable in Fleet and Settings.
const _satPanelSats = () => store.accessibleSatellites.filter(s => !satIsSimulated(s.noradId));

// Which satellites have their station rows collapsed
const _stationsCollapsed = new Set();

// ─── Satellite side-panel list — fused with per-network toggles ──────────

function renderSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of _satPanelSats()) {
    const hidden     = sat.visible === false;
    const stHidden   = !satStarTrackerConesVisible(sat.noradId);
    const networks   = store.getSatNetworks(sat.id);
    const satPoints  = store.customPoints.filter(p => p.noradId === sat.noradId);
    const group = document.createElement('div');
    group.className = 'sat-group';
    group.dataset.itemId = sat.id;
    group.style.setProperty('--sat-color', sat.color);
    const collapsed = _stationsCollapsed.has(sat.id);
    const hasRows = networks.length > 0 || satPoints.length > 0;
    group.innerHTML = `
      <div class="sat-item${sat.id === store.trackedSatId ? ' tracking' : ''}">
        <span class="sat-dot" style="background:${sat.color}"></span>
        <span class="sat-name" data-id="${sat.id}" title="Centre view">${sat.name}</span>
        ${hasRows ? `<button class="gs-collapse-btn" data-id="${sat.id}" title="Toggle stations">${collapsed ? '▸' : '▾'}</button>` : ''}
        <button class="vis-btn st-vis-btn ${stHidden ? 'vis-off' : ''}" data-id="${sat.id}" title="${stHidden ? 'Show' : 'Hide'} star tracker cones">${stHidden ? SVG_EYE_STAR_OFF : SVG_EYE_STAR}</button>
        <button class="vis-btn ${hidden ? 'vis-off' : ''}" data-id="${sat.id}" title="${hidden ? 'Show' : 'Hide'}">${hidden ? SVG_EYE_OFF : SVG_EYE}</button>
      </div>
      <div class="gs-net-rows${collapsed ? ' gs-collapsed' : ''}">
        ${networks.map(n => {
          const visible = store.antennaToggles[`${sat.id}:${n.network}`] ?? true;
          return `
            <label class="gs-net-row">
              <input type="checkbox" class="gs-net-toggle" data-sat="${sat.id}" data-network="${n.network}" ${visible ? 'checked' : ''}>
              <span class="gs-net-name">${n.network}</span>
              <span class="gs-net-count">${n.siteCount} site${n.siteCount === 1 ? '' : 's'}</span>
            </label>`;
        }).join('')}
        ${satPoints.map(p => {
          const ptVisible = p.visible !== false;
          return `
          <label class="gs-pt-row">
            <input type="checkbox" class="gs-pt-toggle" data-id="${p.id}" ${ptVisible ? 'checked' : ''}>
            <span class="gs-pt-name" title="${p.name}">${p.name}</span>
            <span class="gs-pt-coords">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}${p.mask != null ? ` · ${p.mask}°` : ''}</span>
            <button class="gs-pt-remove" data-id="${p.id}" title="Remove point">×</button>
          </label>`;
        }).join('')}
        <button class="gs-pt-add-btn" data-sat="${sat.id}" title="Add custom point for ${sat.name}">+ Point</button>
      </div>
    `;
    list.appendChild(group);
  }
  // Points whose noradId matches no currently-loaded satellite — chiefly
  // points saved before customPoints switched from the ephemeral sat.id to
  // noradId (see store.js's addCustomPoint comment): re-attaching those to
  // whichever satellite now happens to hold their old sat.id would be
  // exactly the silent-misattribution bug this switch fixed, just done once
  // at migration time instead of continuously — so they're surfaced here
  // instead, still visible and removable, rather than guessed at or
  // silently dropped from the list entirely.
  const orphaned = store.customPoints.filter(p => !store.satellites.some(s => s.noradId === p.noradId));
  if (orphaned.length) {
    const group = document.createElement('div');
    group.className = 'sat-group';
    group.style.setProperty('--sat-color', '#ffb84d'); // amber — flags "needs attention", distinct from any real satellite's own color
    group.innerHTML = `
      <div class="sat-item">
        <span class="sat-name-unassigned" title="This point's original satellite isn't currently loaded">Unassigned points</span>
      </div>
      <div class="gs-net-rows">
        ${orphaned.map(p => {
          const ptVisible = p.visible !== false;
          return `
          <label class="gs-pt-row">
            <input type="checkbox" class="gs-pt-toggle" data-id="${p.id}" ${ptVisible ? 'checked' : ''}>
            <span class="gs-pt-name" title="${p.name}">${p.name}</span>
            <span class="gs-pt-coords">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}${p.mask != null ? ` · ${p.mask}°` : ''}</span>
            <button class="gs-pt-remove" data-id="${p.id}" title="Remove point">×</button>
          </label>`;
        }).join('')}
      </div>
    `;
    list.appendChild(group);
  }
  list.querySelectorAll('.sat-name').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      store.setTrackedSat(id === store.trackedSatId ? null : id);
    });
  });
  list.querySelectorAll('.vis-btn:not(.st-vis-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const sat = store._satById.get(id);
      // Satellite toggle drives STT in lockstep: hiding the satellite forces
      // STT off (no cones without the satellite itself shown), and re-showing
      // it forces STT back on — STT does not keep an independent on/off
      // preference across a sat hide → show round-trip. Written BEFORE
      // toggleSatVisibility (not after) — that call synchronously re-renders
      // the list via `notify`, so writing first is what lets that single
      // re-render already reflect the updated STT icon, instead of showing a
      // stale one until whatever click happens to trigger the next re-render.
      if (sat) setSatStarTrackerConesVisible(sat.noradId, sat.visible === false);
      store.toggleSatVisibility(id);
    });
  });
  list.querySelectorAll('.st-vis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const sat = store._satById.get(id);
      // No independent STT control while the satellite itself is hidden —
      // otherwise this could silently flip the stored preference (and this
      // button's own icon) to "on" while the sat-visibility handler's
      // forced-sync invariant above only re-asserts itself on the NEXT
      // sat-visibility click, not immediately.
      if (!sat || sat.visible === false) return;
      const nowVisible = !satStarTrackerConesVisible(sat.noradId);
      setSatStarTrackerConesVisible(sat.noradId, nowVisible);
      btn.classList.toggle('vis-off', !nowVisible);
      btn.title = `${nowVisible ? 'Hide' : 'Show'} star tracker cones`;
      btn.innerHTML = nowVisible ? SVG_EYE_STAR : SVG_EYE_STAR_OFF;
    });
  });
  list.querySelectorAll('.gs-net-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const sat = store._satById.get(cb.dataset.sat);
      if (sat) setNetworkVisible(sat, cb.dataset.network, cb.checked);
    });
  });
  list.querySelectorAll('.gs-collapse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const nowCollapsed = _stationsCollapsed.has(id)
        ? (_stationsCollapsed.delete(id), false)
        : (_stationsCollapsed.add(id),    true);
      btn.textContent = nowCollapsed ? '▸' : '▾';
      const group = btn.closest('.sat-group');
      group?.querySelector('.gs-net-rows')?.classList.toggle('gs-collapsed', nowCollapsed);
    });
  });
  list.querySelectorAll('.gs-pt-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sat = store._satById.get(btn.dataset.sat);
      if (sat) openAddPointPanel(sat);
    });
  });
  list.querySelectorAll('.gs-pt-remove').forEach(btn => {
    // Nested inside the .gs-pt-row <label> — stop the click reaching the
    // label's own default action (toggling the checkbox) on the way out.
    btn.addEventListener('click', e => { e.stopPropagation(); store.removeCustomPoint(btn.dataset.id); });
  });
  list.querySelectorAll('.gs-pt-toggle').forEach(cb => {
    cb.addEventListener('change', () => store.setCustomPointVisible(cb.dataset.id, cb.checked));
  });
}

// Patch visibility/tracking/color state without rebuilding the list
function _patchSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  for (const sat of _satPanelSats()) {
    const group = list.querySelector(`[data-item-id="${sat.id}"]`);
    if (!group) { renderSatList(); return; }
    // Color is only ever set once (satGlobals.js, at creation) but that
    // fetch is async and can resolve after this list's first render — this
    // patch path (not a full renderSatList()) is what runs on that same
    // 'satellites' notify, since the satellite's own id/count didn't change,
    // only its color — without this, the dot would just silently keep
    // showing whatever placeholder color it was created with.
    group.style.setProperty('--sat-color', sat.color);
    const dot = group.querySelector('.sat-dot');
    if (dot) dot.style.background = sat.color;
    const hidden = sat.visible === false;
    group.querySelector('.sat-item')?.classList.toggle('tracking', sat.id === store.trackedSatId);
    const btn = group.querySelector('.vis-btn:not(.st-vis-btn)');
    if (btn) {
      btn.classList.toggle('vis-off', hidden);
      btn.title     = hidden ? 'Show' : 'Hide';
      btn.innerHTML = hidden ? SVG_EYE_OFF : SVG_EYE;
    }
    const stHidden = !satStarTrackerConesVisible(sat.noradId);
    const stBtn = group.querySelector('.st-vis-btn');
    if (stBtn) {
      stBtn.classList.toggle('vis-off', stHidden);
      stBtn.title     = `${stHidden ? 'Show' : 'Hide'} star tracker cones`;
      stBtn.innerHTML = stHidden ? SVG_EYE_STAR_OFF : SVG_EYE_STAR;
    }
  }
}

// Patch checkbox states without rebuilding the list (e.g. after seeding defaults)
function _patchGsToggles() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  list.querySelectorAll('.gs-net-toggle').forEach(cb => {
    cb.checked = store.antennaToggles[`${cb.dataset.sat}:${cb.dataset.network}`] ?? true;
  });
}

// ─── Satellite component links modal ─────────────────────────────────────

const LINK_DEFS = [
  { key: 'scc',     label: 'SCC',     subnet: 1, port: 15000 },  // .1 SCC machine
  { key: 'fds',     label: 'FDS',     subnet: 2, port: 8000  },  // .2 FDS machine
  { key: 'gnm',     label: 'GNM',     subnet: 3, port: 15602 },  // .3 GNM machine
  { key: 'gnc',     label: 'GNC',     subnet: null, port: null },
  { key: 'sccRo',   label: 'SCC RO',  subnet: 5, port: 15500 },  // .5 SCC read-only
  { key: 'grafana', label: 'Grafana', subnet: 5, port: 3000  },  // .5 SCC RO box's Grafana
  { key: 'custom',  label: 'Custom',  subnet: null, port: null },
];

function _defUrl(ip, def) {
  if (!ip || def.subnet == null || def.port == null) return '';
  return `http://${ip.replace(/\.\d+$/, `.${def.subnet}`)}:${def.port}`;
}

function _getSatLinks(noradId) {
  try { return JSON.parse(localStorage.getItem(`sat-links-${noradId}`) ?? '{}'); }
  catch { return {}; }
}

function _setSatLink(noradId, key, val) {
  const links = _getSatLinks(noradId);
  links[key] = val;
  localStorage.setItem(`sat-links-${noradId}`, JSON.stringify(links));
}

function _openSatLinksModal(sat) {
  document.getElementById('sat-links-modal')?.remove();

  const ip    = satBaseUrl(sat.noradId);
  const saved = _getSatLinks(sat.noradId);

  const modal = document.createElement('div');
  modal.id = 'sat-links-modal';
  modal.innerHTML = `
    <div class="slm-backdrop"></div>
    <div class="slm-card">
      <div class="slm-header">
        <span class="slm-dot" style="background:${sat.color}"></span>
        <span class="slm-title">${sat.name}</span>
        <button class="slm-close" title="Close">×</button>
      </div>
      <div class="slm-links">
        ${LINK_DEFS.map(def => {
          const dflt = _defUrl(ip, def);
          const val  = saved[def.key] ?? dflt;
          return `<div class="slm-row" data-key="${def.key}">
            <span class="slm-label">${def.label}</span>
            <input class="slm-url" value="${val}" placeholder="http://…" spellcheck="false">
            <button class="slm-reset" title="Reset to default" ${dflt ? '' : 'disabled'}>↺</button>
            <button class="slm-open" title="Open in new tab" ${val ? '' : 'disabled'}>↗</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelectorAll('.slm-row').forEach(row => {
    const inp  = row.querySelector('.slm-url');
    const open = row.querySelector('.slm-open');
    const rst  = row.querySelector('.slm-reset');
    const key  = row.dataset.key;
    const def  = LINK_DEFS.find(d => d.key === key);
    const dflt = _defUrl(ip, def);

    const refresh = () => { open.disabled = !inp.value.trim(); };
    inp.addEventListener('input',  refresh);
    inp.addEventListener('blur',   () => { _setSatLink(sat.noradId, key, inp.value.trim()); refresh(); });
    open.addEventListener('click', () => { const u = inp.value.trim(); if (u) window.open(u, '_blank', 'noopener'); });
    rst.addEventListener('click',  () => { inp.value = dflt; _setSatLink(sat.noradId, key, dflt); refresh(); });
  });

  const close = () => modal.remove();
  modal.querySelector('.slm-close').addEventListener('click', close);
  modal.querySelector('.slm-backdrop').addEventListener('click', close);
  const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}

// ─── Satellite edit modal ────────────────────────────────────────────────

function _openSatEditModal(sat) {
  document.getElementById('sat-edit-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'sat-edit-modal';
  modal.innerHTML = `
    <div class="sem-backdrop"></div>
    <div class="sem-card">
      <div class="sem-header">
        <span class="sem-dot" id="sem-dot-preview" style="background:${sat.color}"></span>
        <span class="sem-title">${sat.name}</span>
        <button class="sem-close" title="Close">×</button>
      </div>
      <div class="sem-body">

        <div class="sem-label">Name</div>
        <input class="sem-input" id="sem-name" value="${sat.name}" placeholder="Display name" maxlength="30" autocomplete="off">

        <div class="sem-label">Type</div>
        <div class="sem-model-row">
          <button class="sem-model-btn${(sat.model ?? '12U') === '12U' ? ' sem-model-active' : ''}" data-model="12U">12U</button>
          <button class="sem-model-btn${sat.model === 'FF' ? ' sem-model-active' : ''}" data-model="FF">FF</button>
        </div>

        <div class="sem-label">Base IP</div>
        <input class="sem-input" id="sem-ip" value="${satBaseUrl(sat.noradId)}" placeholder="172.17.x.1" spellcheck="false" autocomplete="off">

        <div class="sem-label">Subsystem IPs</div>
        <div class="sem-subsys">
          ${Object.entries(SUBSYSTEMS).map(([key, def]) => `
            <div class="slm-row" data-key="${key}">
              <span class="slm-label">${def.label}</span>
              <input class="slm-url" id="sem-ip-${key}" value="${satSubsystemIp(sat.noradId, key)}"
                     placeholder="${derivedSubsystemIp(satBaseUrl(sat.noradId), key) || '—'}" spellcheck="false" autocomplete="off">
              <button class="slm-reset" title="Reset to derived default" ${satSubsystemOverride(sat.noradId, key) ? '' : 'disabled'}>↺</button>
            </div>`).join('')}
        </div>

        <div class="sem-label">JWT Token</div>
        <input class="sem-input sem-jwt" id="sem-jwt" type="password" value="${satJwt(sat.noradId)}" placeholder="Raw token (no 'Bearer ' prefix)">

      </div>
    </div>`;

  document.body.appendChild(modal);

  // Model buttons — apply immediately
  modal.querySelectorAll('.sem-model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.sem-model-btn').forEach(b => b.classList.remove('sem-model-active'));
      btn.classList.add('sem-model-active');
      const m = btn.dataset.model;
      store.setSatModel(sat.id, m);
      fetch(`/api/satellites/${sat.noradId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m }),
      }).catch(() => {});
    });
  });

  // Name — save on blur/enter, update header title live
  const nameIn = modal.querySelector('#sem-name');
  const saveName = () => {
    const v = nameIn.value.trim();
    if (!v) return;
    store.setSatName(sat.id, v);
    modal.querySelector('.sem-title').textContent = v;
    fetch(`/api/satellites/${sat.noradId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v }),
    }).catch(() => {});
  };
  nameIn.addEventListener('blur', saveName);
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') nameIn.blur(); });

  // Subsystem IP overrides — each input shows the effective value (override, else
  // derived from Base IP); editing it saves an override, the reset button clears it.
  const subsysRows = modal.querySelectorAll('.sem-subsys .slm-row');
  const _refreshSubsysRow = row => {
    const key = row.dataset.key;
    const inp = row.querySelector('.slm-url');
    const rst = row.querySelector('.slm-reset');
    inp.placeholder = derivedSubsystemIp(ipIn.value.trim(), key) || '—';
    rst.disabled = !satSubsystemOverride(sat.noradId, key);
  };
  subsysRows.forEach(row => {
    const key = row.dataset.key;
    const inp = row.querySelector('.slm-url');
    const rst = row.querySelector('.slm-reset');
    const save = () => {
      const v       = inp.value.trim();
      const derived = derivedSubsystemIp(ipIn.value.trim(), key);
      setSatSubsystemIp(sat.noradId, key, v && v !== derived ? v : '');
      _refreshSubsysRow(row);
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    rst.addEventListener('click', () => {
      setSatSubsystemIp(sat.noradId, key, '');
      inp.value = derivedSubsystemIp(ipIn.value.trim(), key);
      _refreshSubsysRow(row);
    });
  });

  // Base IP — save on blur/enter; re-derives every subsystem row that has no override.
  // Skip the reset-and-reping when the value is unchanged — otherwise just clicking
  // into this field and away again restarts the satellite's ping cycle early.
  const ipIn = modal.querySelector('#sem-ip');
  const saveIp = () => {
    const v = ipIn.value.trim();
    if (v === satBaseUrl(sat.noradId)) return;
    setSatBaseUrl(sat.noradId, v);
    store.setSatTelemetry(sat.id, null);
    store.setSatPasses(sat.id, []);
    pingSatellite(sat.id);
    subsysRows.forEach(row => {
      const key = row.dataset.key;
      if (!satSubsystemOverride(sat.noradId, key)) {
        row.querySelector('.slm-url').value = derivedSubsystemIp(v, key);
      }
      _refreshSubsysRow(row);
    });
  };
  ipIn.addEventListener('blur', saveIp);
  ipIn.addEventListener('keydown', e => { if (e.key === 'Enter') ipIn.blur(); });

  // JWT — save on blur/enter
  const jwtIn = modal.querySelector('#sem-jwt');
  jwtIn.addEventListener('blur', () => setSatJwt(sat.noradId, jwtIn.value.trim()));
  jwtIn.addEventListener('keydown', e => { if (e.key === 'Enter') jwtIn.blur(); });

  const close = () => modal.remove();
  modal.querySelector('.sem-close').addEventListener('click', close);
  modal.querySelector('.sem-backdrop').addEventListener('click', close);
  const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}

// ─── Settings view: satellite list ───────────────────────────────────────

// Dragged satellite's id, while a drag from this list is in progress — kept
// module-level (not just dataTransfer) since reading dataTransfer's own
// payload during dragover is restricted in most browsers until drop.
let _dragSatId = null;

function renderSettingsSatList() {
  const list = document.getElementById('st-sat-list');
  // The Settings view stays in the DOM (just CSS-hidden) when another tab is
  // active, so a plain existence check doesn't skip anything — this used to
  // rebuild the whole list on every satellites/trackedSatId change even
  // while nobody could see it. offsetParent is null while display:none
  // (or any hidden ancestor) applies; the tab-click listener below forces
  // one rebuild when Settings actually becomes visible again.
  if (!list || !list.offsetParent) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const model = sat.model ?? '12U';
    const unreachable = store.satAccessible[sat.id] === false;
    const item  = document.createElement('div');
    item.className = 'st-item st-sat-item';
    item.draggable = true;
    item.dataset.id = sat.id;
    item.style.setProperty('--sat-color', sat.color);
    const isSimu = satIsSimulated(sat.noradId);
    const notifyOn = satPassNotifyEnabled(sat.noradId);
    item.innerHTML = `
      <span class="st-drag-handle" title="Drag to reorder">⠿</span>
      <span class="st-sat-dot" style="background:${sat.color}"></span>
      <span class="st-item-name">${sat.name}</span>
      <span class="st-model-badge${model === 'FF' ? ' ff-active' : ''}">${model}</span>
      ${isSimu ? '<span class="st-simu-badge" title="Simulated satellite — not a real, currently-orbiting object; kept out of the Visualizer (Globe/Map)">🧪 SIM</span>' : ''}
      ${unreachable ? '<span class="st-unreachable-badge" title="Not reachable on your current VPN — hidden from the sat panel, Fleet table, globe/map and weekly schedule until it responds again">unreachable</span>' : ''}
      <button class="st-notify-btn${notifyOn ? ' st-notify-active' : ''}" title="Browser notification 1 min before each of this satellite's passes">${SVG_BELL}</button>
      <button class="st-gear-btn" title="Edit">⚙</button>
      <button class="remove-btn" data-id="${sat.id}" data-norad="${sat.noradId}" title="Remove">×</button>
    `;
    const notifyBtn = item.querySelector('.st-notify-btn');
    notifyBtn.addEventListener('click', async () => {
      const enabling = !satPassNotifyEnabled(sat.noradId);
      // Only actually asks the FIRST time (Notification.permission stays
      // 'granted'/'denied' after that) — see requestPassNotifyPermission's
      // own comment on why this has to happen synchronously in this click,
      // not inside satPassNotify.js's own background tick.
      if (enabling && !(await requestPassNotifyPermission())) {
        showWarningToast(`Browser notifications are blocked for this site — allow them in Chrome's site settings, then try the toggle again.`);
        return;
      }
      setSatPassNotifyEnabled(sat.noradId, enabling);
      notifyBtn.classList.toggle('st-notify-active', enabling);
    });
    item.querySelector('.st-gear-btn').addEventListener('click', () => _openSatEditModal(sat));
    item.querySelector('.remove-btn').addEventListener('click', () => {
      deleteServerSatellite(sat.noradId);
      store.removeSatellite(sat.id);
    });

    // Reorders store.satellites itself (store.js's moveSatellite), which
    // every list (Fleet, Settings, the Visualizer sidebar) just inherits the
    // order of — see saveSatOrder for how this survives a reload.
    item.addEventListener('dragstart', e => {
      _dragSatId = sat.id;
      item.classList.add('st-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sat.id); // Firefox requires real data to permit the drag at all
    });
    item.addEventListener('dragend', () => {
      _dragSatId = null;
      item.classList.remove('st-dragging');
      list.querySelectorAll('.st-drag-over').forEach(el => el.classList.remove('st-drag-over'));
    });
    item.addEventListener('dragover', e => {
      if (!_dragSatId || _dragSatId === sat.id) return;
      e.preventDefault(); // required for drop to fire at all
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('st-drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('st-drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('st-drag-over');
      if (!_dragSatId || _dragSatId === sat.id) return;
      const toIndex = store.satellites.findIndex(s => s.id === sat.id);
      if (toIndex === -1) return;
      store.moveSatellite(_dragSatId, toIndex);
      saveSatOrder();
    });

    list.appendChild(item);
  }
}

// ─── Model toggle ─────────────────────────────────────────────────────────

const modelToggle = document.getElementById('model-toggle');
let selectedModel = '12U';
if (modelToggle) {
  modelToggle.addEventListener('click', () => {
    selectedModel = selectedModel === '12U' ? 'FF' : '12U';
    modelToggle.textContent = selectedModel;
    modelToggle.classList.toggle('ff-active', selectedModel === 'FF');
  });
}

// ─── SIM toggle ───────────────────────────────────────────────────────────
// Same on/off-pill pattern as the model toggle above, just without a
// textContent swap — this button's own label ("🧪 SIM") never changes,
// only whether it's lit up (see .sat-simu-toggle.simu-active in style.css).

const simuToggleBtn = document.getElementById('sat-simu-toggle');
let simuActive = false;
if (simuToggleBtn) {
  simuToggleBtn.addEventListener('click', () => {
    simuActive = !simuActive;
    simuToggleBtn.classList.toggle('simu-active', simuActive);
  });
}

// ─── Add satellite ────────────────────────────────────────────────────────

async function finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl }) {
  const nameInput = document.getElementById('name-input');
  const testResult = propagate(satrec, store.currentTime);
  if (!testResult) throw new Error('Cannot propagate — object may have decayed.');

  statusEl.remove();
  const id    = `sat-${Date.now()}`;
  const color = nextPlaceholderColor(noradId);
  const name  = nameInput.value.trim() || satId || `SAT-${noradId}`;
  store.addSatellite({ id, noradId, name, color, satrec, model: selectedModel });
  await persistSatellite(name, line1, line2, selectedModel, satId);
  setSatBaseUrl(noradId, ip);
  nameInput.value = '';
  // One-off, right at creation — captures the satellite's static color
  // immediately (see satGlobals.js) rather than waiting on the next regular
  // ping-poller cycle to happen to pick it up. Not awaited: purely a nice-
  // to-have for how soon the real color shows up, not something the rest of
  // this flow depends on — the periodic poller is still there as a backstop
  // if SCC isn't reachable yet at this exact moment.
  fetchSatGlobals(store._satById.get(id));
}

async function addSatellite() {
  const satIdInput = document.getElementById('sat-id-input');
  const satIpInput = document.getElementById('sat-ip-input');
  const addBtn     = document.getElementById('add-sat-btn');

  const satId = satIdInput.value.trim();
  const ip    = satIpInput.value.trim();
  if (!satId) { _flash(satIdInput, '#ff3860'); return; }
  if (!ip)    { _flash(satIpInput, '#ff3860'); return; }

  addBtn.disabled = true; addBtn.textContent = '…';
  const statusEl = _statusEl(`Fetching TLE for ${satId}…`);
  try {
    let line1, line2;
    try {
      const host = ip.replace(/\.\d+$/, '.3');
      const res  = await fetch(`http://${host}:15602/api/v1/data/orbit/best-tle?satellite_id=${encodeURIComponent(satId)}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const detail = body.match(/No satellite with id (.+)/)?.[0]
                    ?? body.match(/Caused by \d+: (.+)/)?.[1]
                    ?? `FDS returned ${res.status}`;
        throw new Error(detail.trim());
      }
      const data = await res.json();
      if (!data.first_line || !data.second_line) throw new Error('No TLE in response');
      line1 = data.first_line;
      line2 = data.second_line;
    } catch (fetchErr) {
      // A satellite tagged simulated may genuinely have no real orbital
      // data published anywhere — it's not a real orbiting object, so
      // GNM's lookup fails outright rather than just being unreachable.
      // Only fall back when the toggle is actually on; a REAL satellite's
      // failed TLE fetch should still surface as a real error, not
      // silently substitute a meaningless orbit.
      if (!simuActive) throw fetchErr;
      statusEl.textContent = `No real TLE for ${satId} (${fetchErr.message}) — using a placeholder orbit since this is tagged simulated…`;
      ({ line1, line2 } = placeholderTLE(satId));
    }

    const { satrec, noradId } = parseTLE(`${line1}\n${line2}`);
    if (store.satellites.some(s => s.noradId === noradId)) throw new Error(`${satId} is already loaded`);

    // Set BEFORE finaliseSatellite, not after — it calls store.addSatellite,
    // which notifies 'satellites' synchronously, and GlobeView.js/MapView.js
    // react to that immediately. Setting the flag after would leave a
    // window where the new satellite briefly gets a globe/map entity before
    // ever being tagged simulated.
    setSatIsSimulated(noradId, simuActive);
    await finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl });
    satIdInput.value = '';
    satIpInput.value = '';
    simuActive = false;
    simuToggleBtn?.classList.remove('simu-active');
  } catch (err) {
    statusEl.className = 'sat-error';
    statusEl.textContent = 'Error: ' + err.message;
    setTimeout(() => statusEl.remove(), 4000);
  } finally { addBtn.disabled = false; addBtn.textContent = 'Add'; }
}

function _statusEl(text) {
  const el = document.createElement('div');
  el.className = 'sat-loading';
  el.textContent = text;
  document.getElementById('st-sat-list')?.prepend(el);
  return el;
}

function _flash(input, color) {
  input.style.borderColor = color;
  setTimeout(() => (input.style.borderColor = ''), 1500);
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initInputPanel() {
  document.getElementById('add-sat-btn')?.addEventListener('click', addSatellite);
  document.getElementById('sat-ip-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') addSatellite(); });

  document.getElementById('sat-toggle')?.addEventListener('click', () => {
    document.getElementById('sat-panel').classList.toggle('collapsed');
  });

  const allFpBtn = document.getElementById('gs-footprint-all-btn');
  allFpBtn?.addEventListener('click', () => {
    store.setShowFootprints(!store.showFootprints);
  });

  store.subscribe((key) => {
    if (key === 'satellites' || key === 'trackedSatId' || key === 'satAccessible') {
      const newKey     = _satListKey();
      const idsChanged = newKey !== _satIdKey;
      _satIdKey = newKey;
      if (idsChanged) {
        renderSatList();
      } else {
        _patchSatList();
      }
      renderSettingsSatList(); // always: catches color/model changes too
    }
    if (key === 'satAntennas' || key === 'customPoints') {
      renderSatList();
    }
    if (key === 'antennaToggles') {
      _patchGsToggles();
    }
    if (key === 'groundStations') {
      allFpBtn?.classList.toggle('active', store.showFootprints);
    }
  });

  // Ping interval setting
  const pingIntervalInput = document.getElementById('ping-interval-input');
  if (pingIntervalInput) {
    pingIntervalInput.value = getPingIntervalSec();
    const savePingInterval = () => {
      const v = Math.max(5, Math.min(300, parseInt(pingIntervalInput.value, 10) || 20));
      pingIntervalInput.value = v;
      localStorage.setItem('ping-interval', String(v));
      restartPingPoller();
    };
    pingIntervalInput.addEventListener('change', savePingInterval);
    pingIntervalInput.addEventListener('keydown', e => { if (e.key === 'Enter') pingIntervalInput.blur(); });
  }

  // Force a Settings-list rebuild when that tab actually becomes visible —
  // renderSettingsSatList() now skips itself while hidden (see above), so
  // without this it would never rebuild until some unrelated satellites/
  // trackedSatId change happened to fire while Settings was open.
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'settings') renderSettingsSatList();
    });
  });

  renderSatList();
  renderSettingsSatList();
  _satIdKey = _satListKey();
}
