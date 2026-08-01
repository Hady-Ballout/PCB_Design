import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPcbPilotServer } from './server.js';
import { ledNoResistor, rcLowPass } from './testFixtures.js';

let artifactDir: string;
let client: Client;

const textOf = (result: unknown) => {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
};

const jsonOf = (result: unknown) => JSON.parse(textOf(result));

beforeEach(async () => {
  artifactDir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-server-'));
  const server = createPcbPilotServer({ artifactDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('PCB Pilot MCP server', () => {
  it('advertises exactly the six circuit tools', async () => {
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

  it('gives every tool a description so the model knows when to reach for it', async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
    }
  });

  it('returns the component registry through list_component_kinds', async () => {
    const result = await client.callTool({ name: 'list_component_kinds', arguments: {} });

    const payload = jsonOf(result);
    expect(payload.kinds.length).toBeGreaterThan(50);
    expect(payload.circuitShape.groundNode).toBe('0');
  });

  it('reports a topology violation through validate_circuit', async () => {
    const result = await client.callTool({
      name: 'validate_circuit',
      arguments: { circuit: ledNoResistor },
    });

    const payload = jsonOf(result);
    expect(payload.ok).toBe(false);
    expect(payload.violations.map((entry: { id: string }) => entry.id))
      .toContain('led_no_series_resistor');
  });

  it('exports a SPICE deck through export_netlist', async () => {
    const result = await client.callTool({
      name: 'export_netlist',
      arguments: { circuit: rcLowPass, format: 'spice' },
    });

    expect(textOf(result)).toContain('.end');
  });

  it('turns invalid arguments into a tool error rather than a transport failure', async () => {
    const result = await client.callTool({
      name: 'validate_circuit',
      arguments: { circuit: { title: 'bad', components: [{ ref: 'X1', kind: 'warp_core', value: '1', nodes: ['A'] }] } },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('warp_core');
  });

  it('turns a failure inside the engine into a tool error with the reason', async () => {
    const result = await client.callTool({
      name: 'export_netlist',
      arguments: { circuit: rcLowPass, format: 'gerber' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain('format');
  });
});
