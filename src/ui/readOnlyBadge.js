// Toggles the "Read-only VPN" pill in the tab bar — see store.readOnlyVpn's
// own doc comment for exactly what it means (SCC RO reachable, nothing else).
import { store } from '../store.js';

export function initReadOnlyBadge() {
  const pill = document.getElementById('readonly-vpn-pill');
  if (!pill) return;
  const update = () => { pill.hidden = !store.readOnlyVpn; };
  store.subscribe((key) => {
    if (key === 'satAccessible' || key === 'satSubsystemReachable' || key === 'satellites') update();
  });
  update();
}
