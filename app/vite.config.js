// Vite config for the app shell. In dev, Vite serves the Vue app and proxies the
// API (REST + WebSocket) and the static asset prefixes to the Fastify backend.
// In production, `vite build` emits to app/dist which the backend serves at '/'.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const BACKEND = process.env.MCC_BACKEND || 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: Number(process.env.MCC_APP_PORT || 5173),
    strictPort: false,
    proxy: {
      // REST + WebSocket (/api/events, /api/agent) -> Fastify
      '/api': { target: BACKEND, ws: true, changeOrigin: true },
      // Static asset prefixes the viewer/controller need
      '/samples': { target: BACKEND, changeOrigin: true },
      '/runs': { target: BACKEND, changeOrigin: true },
      '/viewer': { target: BACKEND, changeOrigin: true },
      '/node_modules/three': { target: BACKEND, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
