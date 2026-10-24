import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the proxy injects the session token server-side, so it never reaches the browser bundle.
const apiUrl = process.env.HERMES_API_URL;
const token = process.env.HERMES_TOKEN;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: Number(process.env.HERMES_UI_PORT ?? 1420),
    strictPort: true,
    host: '127.0.0.1',
    proxy: apiUrl
      ? // ws: the voice stream is a WebSocket; it authenticates with its own single-use ticket.
        { '/api': { target: apiUrl, ws: true, headers: { Authorization: `Bearer ${token ?? ''}` } } }
      : undefined,
  },
  build: { target: 'es2022', outDir: 'dist' },
});
