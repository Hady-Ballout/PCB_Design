import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({mode}) => ({
  plugins: [react()],
  test: {
    // Repairs the jsdom environment's unusable localStorage. See the file.
    setupFiles: ['./src/test/setup.js'],
  },
  server: {
    proxy: mode === 'development' ? {
      '/api': 'http://127.0.0.1:8787',
    } : {},
  },
}));
