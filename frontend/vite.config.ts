import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client calls the API at the relative path /api, so it has to be served
 * from the same origin as the backend. Production does that by serving both
 * from agenthelm-core; everywhere else this proxy stands in for it. Shared by
 * `vite` and `vite preview` — a static file server has no way to do this, so
 * serving the build with one leaves every API call returning index.html.
 */
const proxy = {
  '/api': {
    target: 'http://localhost:5001',
    changeOrigin: true,
  },
  '/mcp': {
    target: 'http://localhost:5001',
    changeOrigin: true,
  },
  '/ws': {
    target: 'ws://localhost:5001',
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6173,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: ['reins.btv.pw'],
    proxy,
  },
  preview: {
    port: 6173,
    strictPort: true,
    host: '0.0.0.0',
    proxy,
  },
});
