import { store, PALETTE } from '../store.js';
import { parseTLE, propagate } from '../tle.js';
import { persistSatellite, deleteServerSatellite } from '../apiPoller.js';
import { satBaseUrl, setSatBaseUrl, satJwt, setSatJwt, pingSatellite, getPingIntervalSec, restartPingPoller } from '../satPing.js';
import { SUBSYSTEMS, satSubsystemIp, satSubsystemOverride, setSatSubsystemIp, derivedSubsystemIp } from '../satSubsystems.js';
import { setNetworkVisible } from '../satAntennas.js';

// ─── Icons ────────────────────────────────────────────────────────────────

const SVG_EYE     = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// ─── ID-key helpers for change detection ─────────────────────────────────

let _satIdKey = '';
const _satListKey = () => store.satellites.map(s => s.id).join('\0');

// Which satellites have their station rows collapsed
const _stationsCollapsed = new Set();

// ─── Satellite side-panel list — fused with per-network toggles ──────────

function renderSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const hidden     = sat.visible === false;
    const networks   = store.getSatNetworks(sat.id);
    const group = document.createElement('div');
    group.className = 'sat-group';
    group.dataset.itemId = sat.id;
    group.style.setProperty('--sat-color', sat.color);
    const collapsed = _stationsCollapsed.has(sat.id);
    group.innerHTML = `
      <div class="sat-item${sat.id === store.trackedSatId ? ' tracking' : ''}">
        <span class="sat-dot" style="background:${sat.color}"></span>
        <span class="sat-name" data-id="${sat.id}" title="Centre view">${sat.name}</span>
        ${networks.length ? `<button class="gs-collapse-btn" data-id="${sat.id}" title="Toggle stations">${collapsed ? '▸' : '▾'}</button>` : ''}
        <button class="vis-btn ${hidden ? 'vis-off' : ''}" data-id="${sat.id}" title="${hidden ? 'Show' : 'Hide'}">${hidden ? SVG_EYE_OFF : SVG_EYE}</button>
      </div>
      ${networks.length ? `<div class="gs-net-rows${collapsed ? ' gs-collapsed' : ''}">${networks.map(n => {
        const visible = store.antennaToggles[`${sat.id}:${n.network}`] ?? true;
        return `
          <label class="gs-net-row">
            <input type="checkbox" class="gs-net-toggle" data-sat="${sat.id}" data-network="${n.network}" ${visible ? 'checked' : ''}>
            <span class="gs-net-name">${n.network}</span>
            <span class="gs-net-count">${n.siteCount} site${n.siteCount === 1 ? '' : 's'}</span>
          </label>`;
      }).join('')}</div>` : ''}
    `;
    list.appendChild(group);
  }
  list.querySelectorAll('.sat-name').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      store.setTrackedSat(id === store.trackedSatId ? null : id);
    });
  });
  list.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', () => store.toggleSatVisibility(btn.dataset.id));
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
}

// Patch visibility + tracking state without rebuilding the list
function _patchSatList() {
  const list = document.getElementById('sat-list');
  if (!list) return;
  for (const sat of store.satellites) {
    const group = list.querySelector(`[data-item-id="${sat.id}"]`);
    if (!group) { renderSatList(); return; }
    const hidden = sat.visible === false;
    group.querySelector('.sat-item')?.classList.toggle('tracking', sat.id === store.trackedSatId);
    const btn = group.querySelector('.vis-btn');
    if (btn) {
      btn.classList.toggle('vis-off', hidden);
      btn.title     = hidden ? 'Show' : 'Hide';
      btn.innerHTML = hidden ? SVG_EYE_OFF : SVG_EYE;
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
        <span class="slm-meta">#${sat.noradId}</span>
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

const EDIT_COLORS = [
  '#00d4ff', '#00ff9d', '#7DF9FF', '#26c6da',
  '#ff6b35', '#ff3860', '#fb5607', '#ef476f',
  '#c77dff', '#8338ec', '#7c4dff', '#a78bfa',
  '#ffbe0b', '#ffd166', '#ff6d00', '#06d6a0',
];

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
        <span class="sem-meta">#${sat.noradId}</span>
        <button class="sem-close" title="Close">×</button>
      </div>
      <div class="sem-body">

        <div class="sem-label">Name</div>
        <input class="sem-input" id="sem-name" value="${sat.name}" placeholder="Display name" maxlength="30" autocomplete="off">

        <div class="sem-label">Color</div>
        <div class="sem-colors">
          ${EDIT_COLORS.map(c => `<button class="sem-swatch${c === sat.color ? ' sem-swatch-sel' : ''}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join('')}
        </div>
        <button class="sem-scc-color-btn" id="sem-scc-color" ${store.satGlobals[sat.id]?.sccColor ? '' : 'disabled'}
                title="${store.satGlobals[sat.id]?.sccColor ? `Match ${store.satGlobals[sat.id].sccColor}` : 'SCC color not loaded yet'}">
          Use SCC Color
        </button>

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
        <input class="sem-input sem-jwt" id="sem-jwt" type="password" value="${satJwt(sat.noradId)}" placeholder="Bearer token">

      </div>
    </div>`;

  document.body.appendChild(modal);

  // Color swatches — apply immediately
  const _applyColor = c => {
    modal.querySelectorAll('.sem-swatch').forEach(s => s.classList.toggle('sem-swatch-sel', s.dataset.color === c));
    modal.querySelector('#sem-dot-preview').style.background = c;
    store.setSatColor(sat.id, c);
    localStorage.setItem(`sat-color-${sat.noradId}`, c);
  };
  modal.querySelectorAll('.sem-swatch').forEach(sw => {
    sw.addEventListener('click', () => _applyColor(sw.dataset.color));
  });

  // "Use SCC Color" — matches the color the satellite itself reports (globals endpoint),
  // not necessarily one of the fixed EDIT_COLORS swatches.
  modal.querySelector('#sem-scc-color')?.addEventListener('click', () => {
    const sccColor = store.satGlobals[sat.id]?.sccColor;
    if (sccColor) _applyColor(sccColor);
  });

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

function renderSettingsSatList() {
  const list = document.getElementById('st-sat-list');
  if (!list) return;
  list.innerHTML = '';
  for (const sat of store.satellites) {
    const model = sat.model ?? '12U';
    const item  = document.createElement('div');
    item.className = 'st-item st-sat-item';
    item.style.setProperty('--sat-color', sat.color);
    item.innerHTML = `
      <span class="st-sat-dot" style="background:${sat.color}"></span>
      <span class="st-item-name">${sat.name}</span>
      <span class="st-item-meta">#${sat.noradId}</span>
      <span class="st-model-badge${model === 'FF' ? ' ff-active' : ''}">${model}</span>
      <button class="st-gear-btn" title="Edit">⚙</button>
      <button class="remove-btn" data-id="${sat.id}" data-norad="${sat.noradId}" title="Remove">×</button>
    `;
    item.querySelector('.st-gear-btn').addEventListener('click', () => _openSatEditModal(sat));
    item.querySelector('.remove-btn').addEventListener('click', () => {
      deleteServerSatellite(sat.noradId);
      store.removeSatellite(sat.id);
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

// ─── Add satellite ────────────────────────────────────────────────────────

function nextColor() {
  return PALETTE[store.satellites.length % PALETTE.length];
}

async function finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl }) {
  const nameInput = document.getElementById('name-input');
  const testResult = propagate(satrec, store.currentTime);
  if (!testResult) throw new Error('Cannot propagate — object may have decayed.');

  statusEl.remove();
  const id    = `sat-${Date.now()}`;
  const color = nextColor();
  const name  = nameInput.value.trim() || satId || `SAT-${noradId}`;
  store.addSatellite({ id, noradId, name, color, satrec, model: selectedModel });
  await persistSatellite(name, line1, line2, selectedModel, satId);
  setSatBaseUrl(noradId, ip);
  nameInput.value = '';
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

    const { satrec, noradId, line1, line2 } = parseTLE(`${data.first_line}\n${data.second_line}`);
    if (store.satellites.some(s => s.noradId === noradId)) throw new Error(`Already loaded (NORAD ${noradId})`);

    await finaliseSatellite({ satrec, noradId, satId, ip, line1, line2, statusEl });
    satIdInput.value = '';
    satIpInput.value = '';
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
    if (key === 'satellites' || key === 'trackedSatId') {
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
    if (key === 'satAntennas') {
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

  renderSatList();
  renderSettingsSatList();
  _satIdKey = _satListKey();
}
