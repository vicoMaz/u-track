// The ONE severity vocabulary shared across fleet-scale views (Fleet Health Grid
// today; the globe declutter/fleet-horizon designs from the audit build on this
// too). Colors mirror style.css's :root --sev-* tokens — keep them in sync;
// duplicated here as plain hex because consumers (Cesium color parsing, inline
// style strings) need literal values, not var() references.
import { store } from '../store.js';

export const SEV = { NOMINAL: 0, WATCH: 1, WARNING: 2, DISTRESS: 3, CRITICAL: 4 };
export const SEV_COLOR = ['#2db872', '#8bc34a', '#ffbe0b', '#ff8c00', '#e63946'];
export const SEV_LABEL = ['OK', 'WATCH', 'WARN', 'DIST', 'CRIT'];

const _rank = status => SEV[status] ?? SEV.NOMINAL;

// Per-subsystem severities for one satellite — reads store fields already
// polled fleet-wide by satPing.js, no new fetches.
export function satSeverities(sat) {
  const tm   = store.satTelemetry[sat.id];
  const gnss = store.satGnss[sat.id];
  const ge   = store.satGroundEvents[sat.id] ?? {};
  const ping = store.pingStatus[sat.id];
  const gAge = gnss?.lastBothGood ? Date.now() - gnss.lastBothGood.getTime() : Infinity;
  return {
    ping:   ping === 'ok' ? SEV.NOMINAL : ping === 'unconfigured' ? SEV.WATCH : SEV.CRITICAL,
    mode:   Math.max(_rank(tm?.sysMode?.status), _rank(tm?.gncMode?.status)),
    batt:   _rank(tm?.battVoltage?.status),
    gnss:   gAge < 86_400_000 ? SEV.NOMINAL : gAge < 172_800_000 ? SEV.WARNING : SEV.CRITICAL,
    ground: ge.critical ? SEV.CRITICAL : ge.distress ? SEV.DISTRESS : ge.warning ? SEV.WARNING : ge.watch ? SEV.WATCH : SEV.NOMINAL,
  };
}

export function worstSev(sat) {
  return Math.max(0, ...Object.values(satSeverities(sat)));
}
