// Per-satellite subsystem IP resolution — dependency-free (no imports) so it can
// safely be imported both by satPing.js and by the fetch modules satPing.js itself
// imports (satTelemetry.js, satPasses.js, satGnss.js) without creating a cycle.

// Base IP stored per satellite seeds these via last-octet substitution + fixed port.
// Any of them can be individually overridden (e.g. non-standard deployment, testing
// against a different box).
export const SUBSYSTEMS = {
  scc:   { label: 'SCC',    subnet: 1, port: 15000 },
  gnm:   { label: 'GNM',    subnet: 3, port: 15602 },
  mic:   { label: 'MIC',    subnet: 4, port: 16060 },
  fds:   { label: 'FDS',    subnet: 2, port: 8000  },
  sccRo: { label: 'SCC RO', subnet: 5, port: 15500 },
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

// Hostname only (no scheme/port) — used where a sibling service on the same host but
// a different fixed port needs to be derived (e.g. Grafana on FDS's host, port 3000).
export function satSubsystemHost(noradId, key) {
  return satSubsystemIp(noradId, key);
}
