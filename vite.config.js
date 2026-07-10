import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createApiMiddleware, startTleRefresher } from './server/api.js';

export default defineConfig({
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
