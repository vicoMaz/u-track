import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiMiddleware, startTleRefresher } from './server/api.js';

// Resolved once at config-eval time (dev server start / build) — falls back
// gracefully if git isn't available (e.g. a deploy from a tarball, no .git).
function _appVersion() {
  try {
    return execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'dev';
  }
}

// Every non-internal IPv4 this machine currently has (LAN, VPN tunnel(s),
// Docker bridges, whatever's up right now) — baked into the dev cert's SAN
// list below so it actually covers them, not just localhost.
function _localAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

// Self-signed dev cert, generated via openssl (already on the system, same
// idea as _appVersion's git call above) rather than @vitejs/plugin-basic-
// ssl — that plugin's own `domains` option always encodes every entry as a
// DNS-type SAN (see its dist/chunks/certificate.mjs:
// `domains.map(item => ({ type: 2, value: item }))`, type 2 = DNS; type 7 =
// IP is only ever used for its own hardcoded 127.0.0.1/fe80::1 defaults,
// never for anything passed in). Browsers do NOT accept a DNS-type SAN
// whose value happens to look like an IP address as a match when connecting
// to that literal IP — confirmed live: curl reports "no alternative
// certificate subject name matches target host name" for exactly this
// reason. That mismatch, ON TOP of the plain self-signed warning, is what
// escalates Chrome's mild "not secure" into the un-proceedable "Danger"
// variant. Explicit `IP:` SAN entries (openssl's `-addext`) get a cert real
// hostname verification actually accepts for these addresses — still self-
// signed (still needs the one-time click-through), just no longer ALSO a
// hostname mismatch.
//
// Cached (and keyed by the exact address list used) in node_modules/.vite/
// dev-cert so a plain restart doesn't force every browser to re-click-
// through — only regenerated when that list actually changes (e.g. the VPN
// handed out a different IP this time) or the cert's own 30-day TTL lapses.
const CERT_DIR = 'node_modules/.vite/dev-cert';

function _devCert() {
  const addrs      = _localAddresses();
  const certPath    = join(CERT_DIR, 'cert.pem');
  const keyPath     = join(CERT_DIR, 'key.pem');
  const addrsPath   = join(CERT_DIR, 'addrs.json');
  const cached = existsSync(certPath) && existsSync(keyPath) && existsSync(addrsPath)
    && JSON.stringify(JSON.parse(readFileSync(addrsPath, 'utf8'))) === JSON.stringify(addrs)
    && !isCertExpired(certPath);
  if (!cached) {
    mkdirSync(CERT_DIR, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...addrs.map(ip => `IP:${ip}`)].join(',');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 30 -subj "/CN=dev" -addext "subjectAltName=${san}"`,
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    writeFileSync(addrsPath, JSON.stringify(addrs));
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

function isCertExpired(certPath) {
  try {
    execSync(`openssl x509 -checkend 0 -noout -in "${certPath}"`, { stdio: 'ignore' });
    return false; // exit 0 = still valid
  } catch {
    return true; // non-zero = expired (or unreadable — regenerate either way)
  }
}

export default defineConfig({
  // Binds the dev server to all network interfaces (not just localhost) so
  // it's reachable from other devices on the LAN/VPN at this host's own IP —
  // `npm run dev` alone is enough, no need to remember `--host`.
  server: {
    host: true,
    https: _devCert(),
  },
  // Same cert for `vite preview` (npm run preview) — reruns _devCert(), but
  // that's cheap: it's a no-op read of the already-cached files unless the
  // address list or expiry actually forced a regeneration above.
  preview: {
    https: _devCert(),
  },
  define: {
    __APP_VERSION__: JSON.stringify(_appVersion()),
  },
  resolve: {
    alias: {
      // satellite.js v7 dist/index.js re-exports its WASM build which uses
      // top-level await — incompatible with Vite 8 / rolldown IIFE output.
      // Shim mirrors all pure-JS exports without the WASM barrel.
      'satellite.js': fileURLToPath(new URL('./satellite-shim.js', import.meta.url)),
    },
  },
  plugins: [
    {
      name: 'api-server',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware());
        startTleRefresher();
      },
    },
  ],
  // Cesium is loaded via CDN script tag — treat it as an external global
  build: {
    rollupOptions: {
      external: ['cesium'],
      output: {
        globals: { cesium: 'Cesium' },
      },
    },
  },
});
