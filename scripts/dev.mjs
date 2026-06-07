import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const api = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  shell: false,
});
const web = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173'], {
  stdio: 'inherit',
  shell: false,
});

const shutdown = () => {
  api.kill();
  web.kill();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

api.on('exit', (code) => {
  if (code && code !== 0) process.exitCode = code;
  web.kill();
});

web.on('exit', (code) => {
  if (code && code !== 0) process.exitCode = code;
  api.kill();
});
