import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const GATEWAY_TARGET = process.env.VITE_GATEWAY_URL || 'http://localhost:4000';

// https://vite.dev/config/
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    open: true,
    // Proxy API + WebSocket calls to the Node API gateway during local dev.
    proxy: {
      '/api': {
        target: GATEWAY_TARGET,
        changeOrigin: true,
        ws: true, // WebSocket support for /api/audits/:id/stream
      },
      '/webhooks': {
        target: GATEWAY_TARGET,
        changeOrigin: true,
      },
      '/auth': {
        target: GATEWAY_TARGET,
        changeOrigin: true,
      },
    },
  },
});
