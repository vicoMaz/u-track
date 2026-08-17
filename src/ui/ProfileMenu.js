// Left-rail profile hover popover — VPN/read-only status and per-satellite
// reachability. Replaces the old top-bar readonly-vpn-pill (readOnlyBadge.js)
// 1:1, same store.readOnlyVpn signal, just relocated + given the satellite
// breakdown it never had room for inline.
import { store } from '../store.js';

const _PING_DOT = {
  ok:           'var(--sev-nominal)',
  pending:      '#667',
  timeout:      'var(--sev-critical)',
  error:        'var(--sev-critical)',
  unconfigured: '#667',
};
const _PING_LABEL = {
  ok:           'Reachable',
  pending:      'Checking…',
  timeout:      'Timeout',
  error:        'Error',
  unconfigured: 'Unconfigured',
};

export function initProfileMenu() {
  const vpnStatusEl = document.getElementById('pp-vpn-status');
  const vpnDetailEl = document.getElementById('pp-vpn-detail');
  const satListEl   = document.getElementById('pp-sat-list');
  const profileIcon = document.getElementById('profile-icon');
  if (!vpnStatusEl) return;

  function update() {
    const down     = store.vpnDown;
    const readOnly = store.readOnlyVpn;
    if (profileIcon) {
      profileIcon.classList.toggle('profile-icon-vpn-ok',   !down);
      profileIcon.classList.toggle('profile-icon-vpn-down',  down);
    }
    // down takes priority — readOnlyVpn reads as `false` ("full access")
    // once every satellite drops out of accessibleSatellites, which is
    // exactly what happens when the VPN itself is down, not evidence of
    // full access. Same store.vpnDown the "Check your VPN." toast uses
    // (see vpnGuard.js), so the two never disagree.
    if (down) {
      vpnStatusEl.textContent = 'VPN Down';
      vpnStatusEl.style.color = 'var(--sev-critical)';
      vpnDetailEl.textContent = 'No configured satellite is reachable — check your VPN connection.';
    } else {
      vpnStatusEl.textContent = readOnly ? 'Read-only access' : 'Operator access';
      vpnStatusEl.style.color = readOnly ? 'var(--sev-warning)' : 'var(--sev-nominal)';
      vpnDetailEl.textContent = readOnly
        ? 'Only the SCC RO (.5) subnet is reachable on your current VPN — SCC/FDS/GNM/MIC are not, so ground stations, TMR gap data, GNSS status and procedure scheduling won’t have data.'
        : '';
    }

    const sats = store.satellites;
    satListEl.innerHTML = sats.length ? sats.map(sat => {
      const status = store.pingStatus[sat.id] ?? 'pending';
      return `<div class="pp-sat-row">
        <span class="pp-sat-dot" style="background:${_PING_DOT[status]}"></span>
        <span>${sat.name}</span>
        <span class="pp-sat-status">${_PING_LABEL[status]}</span>
      </div>`;
    }).join('') : '<div class="pp-empty">No satellites configured</div>';
  }

  store.subscribe(key => {
    if (key === 'satellites' || key === 'pingStatus' || key === 'satSubsystemReachable' || key === 'vpnDown') update();
  });
  update();
}
