import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Admin console runs on its own port (5174) so it can sit beside the main
// product app (5173). API/auth/ws are proxied to the same dam-api backend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: ['admin-dam.suchirasoistories.in', '.suchirasoistories.in'],
    proxy: {
      '/api': 'http://dam-api:3000',
      '/auth': 'http://dam-api:3000',
      '/ws': { target: 'http://dam-api:3000', ws: true },
    },
  },
});
