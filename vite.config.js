import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
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

export default defineConfig({
  // Binds the dev server to all network interfaces (not just localhost) so
  // it's reachable from other devices on the LAN/VPN at this host's own IP —
  // `npm run dev` alone is enough, no need to remember `--host`.
  server: {
    host: true,
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
