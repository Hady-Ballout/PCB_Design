import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({mode}) => ({
  plugins: [react()],
  server: {
    proxy: mode === 'development' ? {
      '/api': 'http://127.0.0.1:8787',
    } : {},
  },
}));
