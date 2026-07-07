import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const webHost = process.env.WEB_HOST || '127.0.0.1';
const webPort = process.env.WEB_PORT || '5173';
const spawnOptions = {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false,
};

const api = spawn(process.execPath, [tsxBin, 'server/index.ts'], {
  ...spawnOptions,
});
const web = spawn(process.execPath, [
  viteBin,
  '--host',
  webHost,
  '--port',
  webPort,
  '--strictPort',
  '--configLoader',
  'native',
], {
  ...spawnOptions,
});

const shutdown = () => {
  api.kill();
  web.kill();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

api.on('exit', (code) => {
  if (code && code !== 0) {
    process.exitCode = code;
    console.error(`[dev] API process (tsx server/index.ts) exited with code ${code}; shutting down web server.`);
  }
  web.kill();
});

web.on('exit', (code) => {
  if (code && code !== 0) {
    process.exitCode = code;
    console.error(`[dev] Web process (vite) exited with code ${code}; shutting down API server.`);
  }
  api.kill();
});
