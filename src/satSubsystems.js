// Per-satellite subsystem IP resolution — dependency-free (no imports) so it can
// safely be imported both by satPing.js and by the fetch modules satPing.js itself
// imports (satTelemetry.js, satPasses.js, satGnss.js) without creating a cycle.

// Base IP stored per satellite seeds these via last-octet substitution + fixed port.
// Any of them can be individually overridden (e.g. non-standard deployment, testing
// against a different box).
// pingPath is each subsystem's own confirmed health-check route — they are
// NOT all the same (FDS has no /api prefix) — see satPing.js's
// _probeSubsystems, which uses this instead of assuming every subsystem
// shares SCC RO's /api/v1/ping.
//
// MIC is special: its ping lives on a DIFFERENT port (16020, the "plan"
// service) than the rest of MIC's API that satAttitudeReal.js/satVersions.js/
// ChadOps.js's link badge talk to (16060, "platform" service) — MIC hosts
// multiple services on different ports, not one API behind one port like the
// other subsystems. pingPort overrides `port` for the reachability probe
// only; satSubsystemOrigin (used everywhere else) still resolves to `port`.
export const SUBSYSTEMS = {
  scc:   { label: 'SCC',    subnet: 1, port: 15000, pingPath: '/api/v1/ping' },
  gnm:   { label: 'GNM',    subnet: 3, port: 15602, pingPath: '/api/v1/ping' },
  mic:   { label: 'MIC',    subnet: 4, port: 16060, pingPort: 16020, pingPath: '/api/plan/v1/ping' },
  fds:   { label: 'FDS',    subnet: 2, port: 8000,  pingPath: '/v1/ping' },
  sccRo: { label: 'SCC RO', subnet: 5, port: 15500, pingPath: '/api/v1/ping' },
  // Same box/subnet as `mic` above — this is that box's "plan" service
  // (planData.js's Plan distribution, fills the gantt's "Plans" row), port
  // 16020, as opposed to MIC's own "platform"/attitude service on 16060.
  // Confirmed live: the same MIC token (satJwt) authenticates both.
  planApi: { label: 'Plan API', subnet: 4, port: 16020, pingPath: '/api/plan/v1/ping' },
};

export function satBaseIp(noradId) {
  return localStorage.getItem(`sat-baseurl-${noradId}`) ?? '';
}

function _deriveIp(baseIp, subnet) {
  return baseIp ? baseIp.replace(/\.\d+$/, `.${subnet}`) : '';
}

export function derivedSubsystemIp(baseIp, key) {
  const def = SUBSYSTEMS[key];
  return def ? _deriveIp(baseIp, def.subnet) : '';
}

// The effective IP for a subsystem: an explicit override if set, else derived
// from the satellite's base IP by swapping the last octet.
export function satSubsystemIp(noradId, key) {
  const override = localStorage.getItem(`sat-ip-${noradId}-${key}`);
  if (override) return override;
  return derivedSubsystemIp(satBaseIp(noradId), key);
}

export function satSubsystemOverride(noradId, key) {
  return localStorage.getItem(`sat-ip-${noradId}-${key}`) ?? '';
}

export function setSatSubsystemIp(noradId, key, ip) {
  if (ip) localStorage.setItem(`sat-ip-${noradId}-${key}`, ip);
  else     localStorage.removeItem(`sat-ip-${noradId}-${key}`);
}

// The full origin (http://ip:port) to prefix onto that subsystem's API paths.
export function satSubsystemOrigin(noradId, key) {
  const def = SUBSYSTEMS[key];
  const ip  = satSubsystemIp(noradId, key);
  return ip && def ? `http://${ip}:${def.port}` : '';
}

// Same as satSubsystemOrigin, but for the reachability probe specifically —
// only MIC differs (see its pingPort comment above); everyone else's ping
// lives on the same port as their regular API.
export function satSubsystemPingOrigin(noradId, key) {
  const def = SUBSYSTEMS[key];
  const ip  = satSubsystemIp(noradId, key);
  return ip && def ? `http://${ip}:${def.pingPort ?? def.port}` : '';
}

// Hostname only (no scheme/port) — used where a sibling service on the same host but
// a different fixed port needs to be derived (e.g. Grafana on FDS's host, port 3000).
export function satSubsystemHost(noradId, key) {
  return satSubsystemIp(noradId, key);
}
