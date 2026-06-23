import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// The API server (Hono) the dev frontend proxies to. Keep in sync with
// server/server.mjs DEFAULT_PORT. Both bind 127.0.0.1 only — this UI reads a
// sensitive ~/.claude / ~/.codex and must never listen on a public interface.
const API_PORT = 4319;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Dev: Vite serves the app with HMR and proxies /api to the in-process
      // engine server. Prod (npm run build + start): Hono serves dist + /api on
      // one port, so this proxy is dev-only.
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
