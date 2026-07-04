import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Behind the Caddy HTTPS proxy the Host header is the public domain; allow it.
    allowedHosts: ['dam.suchirasoistories.in', '.suchirasoistories.in'],
    proxy: {
      '/api': 'http://dam-api:3000',
      '/auth': 'http://dam-api:3000',
      '/ws': { target: 'http://dam-api:3000', ws: true },
    },
  },
});
