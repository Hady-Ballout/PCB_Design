import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({mode}) => ({
  plugins: [react()],
  test: {
    // Repairs the jsdom environment's unusable localStorage. See the file.
    setupFiles: ['./src/test/setup.js'],
    // Each sandbox run holds a snapshot of knowledge/, which carries its own
    // test file. Without this the suite silently grows by ~150 duplicated tests
    // per run on disk and shrinks again when runs are cleaned up, so the count
    // means nothing and a stale snapshot could fail against current source.
    exclude: ['**/node_modules/**', '**/dist/**', 'sandbox/runs/**'],
  },
  server: {
    proxy: mode === 'development' ? {
      '/api': 'http://127.0.0.1:8787',
    } : {},
  },
}));
