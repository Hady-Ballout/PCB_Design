import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ArtifactStore } from '../../mcp/artifactSink.js';
import { handleArtifactDownload, handleMcpRequest } from './httpServer.js';
import { ledNoResistor, rcLowPass } from '../../mcp/testFixtures.js';

let store: ArtifactStore;
let httpServer: Server;
let baseUrl: string;
let client: Client;
/** Swapped mid-test to prove artifacts are scoped to the authenticated user. */
let subject: string;

const textOf = (result: unknown) => {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
};

const jsonOf = (result: unknown) => JSON.parse(textOf(result));

beforeEach(async () => {
  store = new ArtifactStore();
  subject = 'user-1';

  httpServer = createServer(async (request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/api/mcp/artifacts/')) {
      handleArtifactDownload(request, response, { store, subject });
      return;
    }
    await handleMcpRequest(request, response, { store, subject });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  client = new Client({ name: 'http-test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`)));
});

afterEach(async () => {
  await client.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('MCP over streamable HTTP', () => {
  it('serves the same six tools as the stdio transport', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'export_netlist',
      'list_component_kinds',
      'pcb_layout',
      'render_schematic',
      'simulate_circuit',
      'validate_circuit',
    ]);
  });

  it('runs the topology rule engine over the wire', async () => {
    const result = await client.callTool({
      name: 'validate_circuit',
      arguments: { circuit: ledNoResistor },
    });

    const payload = jsonOf(result);
    expect(payload.ok).toBe(false);
    expect(payload.violations.map((entry: { id: string }) => entry.id))
      .toContain('led_no_series_resistor');
  });

  it('hands back a URL for bulky output, never a server filesystem path', async () => {
    const result = await client.callTool({
      name: 'render_schematic',
      arguments: { circuit: rcLowPass },
    });

    const payload = jsonOf(result);
    expect(payload.artifact.kind).toBe('url');
    expect(payload.artifact.location).toMatch(/^\/api\/mcp\/artifacts\//);
    expect(payload.artifact.location).not.toMatch(/[A-Za-z]:\\|\/tmp\//);
  });

  it('serves that artifact back over HTTP', async () => {
    const rendered = jsonOf(await client.callTool({
      name: 'render_schematic',
      arguments: { circuit: rcLowPass },
    }));

    const response = await fetch(`${baseUrl}${rendered.artifact.location}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<svg');
  });

  it('404s an artifact belonging to a different user', async () => {
    const rendered = jsonOf(await client.callTool({
      name: 'render_schematic',
      arguments: { circuit: rcLowPass },
    }));

    subject = 'someone-else';
    const response = await fetch(`${baseUrl}${rendered.artifact.location}`);

    expect(response.status).toBe(404);
  });

  it('404s an artifact id that was never issued', async () => {
    const response = await fetch(`${baseUrl}/api/mcp/artifacts/not-a-real-id`);

    expect(response.status).toBe(404);
  });

  it('caps concurrent simulations per user rather than letting them pile up', async () => {
    // Two simulations fired without awaiting the first. One must be turned away —
    // ngspice is the only tool that costs real CPU, so this is the guard that
    // stops a looping client from saturating the container.
    const circuit = { ...rcLowPass, title: 'Concurrency probe' };
    const [first, second] = await Promise.all([
      client.callTool({ name: 'simulate_circuit', arguments: { circuit } }),
      client.callTool({ name: 'simulate_circuit', arguments: { circuit } }),
    ]);

    const outcomes = [first, second].map((result) => ({
      isError: Boolean((result as { isError?: boolean }).isError),
      text: textOf(result),
    }));
    const rejected = outcomes.filter((outcome) => /at a time/i.test(outcome.text));

    expect(rejected).toHaveLength(1);
    expect(rejected[0].isError).toBe(true);
  });

  it('frees the simulation slot once a run completes', async () => {
    const circuit = { ...rcLowPass, title: 'Sequential probe' };
    await client.callTool({ name: 'simulate_circuit', arguments: { circuit } });

    const second = await client.callTool({ name: 'simulate_circuit', arguments: { circuit } });

    expect(jsonOf(second).ok).toBe(true);
  });

  it('reports a tool failure as an error result rather than an HTTP failure', async () => {
    const result = await client.callTool({
      name: 'export_netlist',
      arguments: { circuit: rcLowPass, format: 'pdf' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain('format');
  });

  it('serves a zipped Gerber package as binary, byte for byte', async () => {
    const exported = jsonOf(await client.callTool({
      name: 'export_netlist',
      arguments: { circuit: rcLowPass, format: 'gerber' },
    }));

    expect(exported.artifact.location).toMatch(/^\/api\/mcp\/artifacts\//);
    const response = await fetch(`${baseUrl}${exported.artifact.location}`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('-gerbers.zip');
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length);
    // PK\x03\x04 — a text encoding pass anywhere on the way out would break it.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
