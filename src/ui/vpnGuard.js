import { store }             from '../store.js';
import { satBaseUrl }        from '../satPing.js';
import { showWarningToast }  from './actionToast.js';

// Satellite backends sit behind VPN-only 172.* addresses. If every configured
// 172.* satellite is unreachable at once, that's almost always the VPN being
// down rather than N unrelated satellites failing simultaneously — worth a
// nudge. Fires once per bad transition (not every ping cycle while it stays
// down) and stays up — no auto-dismiss timer — until connectivity recovers
// or the user dismisses it via the toast's Ignore button.
let _vpnDown   = false;
let _hideToast = null;

function _check() {
  const candidates = store.satellites.filter(s => satBaseUrl(s.noradId).startsWith('172.'));
  if (!candidates.length) { _resolve(); return; }

  const allUnreachable = candidates.every(s => {
    const status = store.pingStatus[s.id];
    return status === 'timeout' || status === 'error';
  });

  if (allUnreachable && !_vpnDown) {
    _vpnDown   = true;
    _hideToast = showWarningToast('Check your VPN.');
  } else if (!allUnreachable) {
    _resolve();
  }
}

function _resolve() {
  if (_vpnDown) _hideToast?.();
  _vpnDown   = false;
  _hideToast = null;
}

export function initVpnGuard() {
  store.subscribe(key => {
    if (key === 'pingStatus' || key === 'satellites') _check();
  });
}
