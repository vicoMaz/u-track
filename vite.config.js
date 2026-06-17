import { defineConfig } from 'vite';
import { createApiMiddleware, startTleRefresher } from './server/api.js';

export default defineConfig({
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
