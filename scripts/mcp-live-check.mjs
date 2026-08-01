// End-to-end check of the hosted MCP endpoint against the real API server.
//
// Why this exists as a script and not a vitest case: the thing most likely to
// break here is *route ordering* inside server/index.ts. The MCP route has to sit
// above the JWT gate, because a Claude connector authenticates as an OAuth client
// and has no app session token. Mount it below the gate and every call 401s —
// which is what happened the first time. Unit tests import the handler directly
// and so cannot see the router at all; only booting the real server can.
//
//   node scripts/mcp-live-check.mjs
//
// Requires ngspice on PATH for the simulation step.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Ask the OS for a free port, so a stale server can never be mistaken for ours. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const RC_LOW_PASS = {
  title: 'Live check RC',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let api;
let client;
let failed = false;

const check = (label, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  // `node --import tsx` rather than the `npx`/`tsx` shim: Node refuses to spawn a
  // Windows .cmd without a shell, and shelling out just to reach a launcher adds
  // quoting problems for no benefit.
  api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      MCP_HTTP_ENABLED: '1',
      JWT_SECRET: process.env.JWT_SECRET || 'live-check-secret',
      API_PORT: String(port),
      HOST: '127.0.0.1',
    },
    cwd: process.cwd(),
  });
  api.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));

  // Poll for readiness rather than sleeping a fixed amount.
  let up = false;
  for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch { /* not listening yet */ }
    if (!up) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!up) throw new Error(`API server did not come up on ${base}`);

  client = new Client({ name: 'mcp-live-check', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`)));

  // The assertion that actually guards route ordering: reaching this line at all
  // means /api/mcp answered without an app JWT.
  const { tools } = await client.listTools();
  check('MCP endpoint reachable without an app session JWT', true);
  check('six tools advertised', tools.length === 6, tools.map((tool) => tool.name).join(', '));

  const callJson = async (name, args) => JSON.parse(
    (await client.callTool({ name, arguments: args })).content[0].text,
  );

  const sim = await callJson('simulate_circuit', { circuit: RC_LOW_PASS });
  check('ngspice simulation runs in-process', sim.ok,
    sim.ok ? sim.series.map((s) => `${s.name}=${s.final.toFixed(2)}V`).join(' ') : sim.errors.join('; '));
  check('waveform CSV is a URL, not a server path', sim.waveformCsv?.kind === 'url', sim.waveformCsv?.location);

  const csv = await fetch(`${base}${sim.waveformCsv.location}`);
  const csvBody = await csv.text();
  check('CSV artifact downloads', csv.status === 200 && csvBody.startsWith('time,'),
    `${csv.status} ${csv.headers.get('content-type')}`);

  const svg = await callJson('render_schematic', { circuit: RC_LOW_PASS });
  const svgRes = await fetch(`${base}${svg.artifact.location}`);
  check('SVG artifact downloads', svgRes.status === 200 && (await svgRes.text()).includes('<svg'),
    `${svgRes.status} ${svgRes.headers.get('content-type')}`);

  const missing = await fetch(`${base}/api/mcp/artifacts/never-issued-id`);
  check('unknown artifact id 404s', missing.status === 404, String(missing.status));
} catch (error) {
  failed = true;
  console.error('FAIL  live check threw —', error.message);
} finally {
  try { await client?.close(); } catch { /* already gone */ }
  api?.kill();
}

console.log(failed ? '\nLIVE CHECK FAILED' : '\nLIVE CHECK PASSED');
process.exit(failed ? 1 : 0);
