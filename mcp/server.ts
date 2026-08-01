#!/usr/bin/env node
// PCB Pilot MCP server — exposes the deterministic half of the engine
// (validation, SPICE/KiCad export, Ngspice simulation, schematic and PCB
// geometry) as tools. The model authors the circuit; these tools check it,
// run it, and turn it into files.
//
// Run over stdio:  npx tsx mcp/server.ts [--artifact-dir <path>]
// See mcp/README.md for the Claude Desktop / Claude Code config.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { resolveArtifactDir } from './artifacts.js';
import { circuitSchema } from './schemas.js';
import { listComponentKinds } from './tools/componentKinds.js';
import { validateCircuitTool } from './tools/validate.js';
import { exportNetlist } from './tools/export.js';
import { simulateCircuitTool } from './tools/simulate.js';
import { renderSchematic } from './tools/render.js';
import { pcbLayoutTool } from './tools/layout.js';

const asText = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

const asError = (error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
});

/**
 * Wraps a handler so nothing escapes as a transport-level failure: a bad
 * argument or an exception inside src/core comes back as a tool error the
 * model can read and correct, and the session survives.
 */
const guarded = <A>(handler: (args: A) => unknown | Promise<unknown>) => async (args: A) => {
  try {
    return asText(await handler(args));
  } catch (error) {
    return asError(error);
  }
};

export const createPcbPilotServer = ({ artifactDir }: { artifactDir: string }) => {
  const server = new McpServer({ name: 'pcb-pilot', version: '0.1.0' });

  server.registerTool('list_component_kinds', {
    title: 'List component kinds',
    description:
      'The component registry and circuit-JSON contract this server accepts. Call this before '
      + 'authoring a circuit: it gives every supported kind with its SPICE ref prefix, pin count, '
      + 'and positional pin order, plus the rules the other tools enforce.',
    inputSchema: {
      kind: z.string().optional().describe('Return full detail for one kind instead of the whole table.'),
      includePinOrders: z.boolean().optional()
        .describe('Include the positional pin order for every kind (verbose).'),
    },
  }, guarded(listComponentKinds));

  server.registerTool('validate_circuit', {
    title: 'Validate circuit',
    description:
      'Checks a circuit structurally (missing values, node counts, ground references) and '
      + 'functionally against the topology rule engine — LEDs without series resistors, GPIOs '
      + 'driving loads directly, floating MOSFET gates, missing flyback diodes, and ~30 more. '
      + 'Run this before exporting or simulating.',
    inputSchema: {
      circuit: circuitSchema,
      applyFixes: z.boolean().optional()
        .describe('Apply the safe additive auto-fixes (gate pull-down, flyback diode) and return the patched circuit.'),
    },
  }, guarded(validateCircuitTool));

  server.registerTool('export_netlist', {
    title: 'Export netlist',
    description:
      'Writes the circuit as a SPICE deck (.cir), a KiCad netlist (.net), or a KiCad schematic '
      + '(.kicad_sch). Returns the text and the path of the written file.',
    inputSchema: {
      circuit: circuitSchema,
      format: z.enum(['spice', 'kicad_netlist', 'kicad_schematic']),
    },
  }, guarded((args: Parameters<typeof exportNetlist>[0]) => exportNetlist(args, artifactDir)));

  server.registerTool('simulate_circuit', {
    title: 'Simulate circuit',
    description:
      'Runs a transient analysis in Ngspice and returns per-node statistics (min/max/mean/final) '
      + 'with a downsampled trace; the full sample set goes to a CSV artifact. Requires Ngspice on PATH.',
    inputSchema: {
      circuit: circuitSchema,
      spice: z.string().optional()
        .describe('Use this deck instead of generating one — for hand-tuned .tran directives or extra models.'),
      maxPoints: z.number().int().min(2).max(500).optional()
        .describe('Samples per node to return inline (default 40).'),
    },
  }, guarded((args: Parameters<typeof simulateCircuitTool>[0]) => simulateCircuitTool(args, artifactDir)));

  server.registerTool('render_schematic', {
    title: 'Render schematic',
    description:
      'Lays out the circuit and writes an SVG schematic. Returns the file path and what was '
      + 'placed — the markup itself is not returned.',
    inputSchema: { circuit: circuitSchema },
  }, guarded((args: Parameters<typeof renderSchematic>[0]) => renderSchematic(args, artifactDir)));

  server.registerTool('pcb_layout', {
    title: 'Generate PCB layout',
    description:
      'Places footprints and routes a two-layer board. Returns the board envelope, footprint '
      + 'positions and copper counts; full geometry (pads, trace segments, vias) goes to a JSON artifact.',
    inputSchema: { circuit: circuitSchema },
  }, guarded((args: Parameters<typeof pcbLayoutTool>[0]) => pcbLayoutTool(args, artifactDir)));

  return server;
};

const parseArtifactDirFlag = (argv: string[]): string | undefined => {
  const index = argv.indexOf('--artifact-dir');
  return index >= 0 ? argv[index + 1] : undefined;
};

const main = async () => {
  // stdout is the MCP protocol channel on this transport. Anything printed
  // there by imported modules would corrupt the framing, so send it to stderr.
  console.log = console.error;

  const artifactDir = resolveArtifactDir(parseArtifactDirFlag(process.argv.slice(2)));
  const server = createPcbPilotServer({ artifactDir });
  await server.connect(new StdioServerTransport());
  console.error(`[pcb-pilot] MCP server ready. Artifacts: ${artifactDir}`);
};

// Only take over stdio when run as the entry point, never on import from tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error('[pcb-pilot] fatal:', error);
    process.exit(1);
  });
}
