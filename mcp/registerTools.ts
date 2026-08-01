// The tool surface, registered once and shared by every transport.
//
// `mcp/server.ts` (stdio, local) and `server/mcp/httpServer.ts` (streamable HTTP,
// hosted) both call this. Keeping one list is the point: a tool added here reaches
// both, and the two can't drift apart in description, schema, or behaviour.
//
// Transports differ only in the ArtifactSink they pass — a directory on disk
// locally, a short-lived URL store when hosted.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ArtifactSink } from './artifactSink.js';
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
 * Wraps a handler so nothing escapes as a transport-level failure: a bad argument
 * or an exception inside src/core comes back as a tool error the model can read
 * and correct, and the session survives.
 */
const guarded = <A>(handler: (args: A) => unknown | Promise<unknown>) => async (args: A) => {
  try {
    return asText(await handler(args));
  } catch (error) {
    return asError(error);
  }
};

export interface ToolOptions {
  /**
   * Wraps the one expensive tool. The hosted transport passes a per-user
   * concurrency limit here; the local stdio server has a single user on their own
   * machine and passes nothing.
   */
  guardSimulation?: <T>(task: () => Promise<T>) => Promise<T>;
}

export const registerPcbPilotTools = (
  server: McpServer,
  sink: ArtifactSink,
  { guardSimulation = (task) => task() }: ToolOptions = {},
): McpServer => {
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
      'Writes the circuit as a SPICE deck (.cir), a KiCad netlist (.net), a KiCad schematic '
      + '(.kicad_sch), or a KiCad PCB board (.kicad_pcb). Returns the text inline plus a reference '
      + 'to the written artifact.',
    inputSchema: {
      circuit: circuitSchema,
      format: z.enum(['spice', 'kicad_netlist', 'kicad_schematic', 'kicad_pcb']),
    },
  }, guarded((args: Parameters<typeof exportNetlist>[0]) => exportNetlist(args, sink)));

  server.registerTool('simulate_circuit', {
    title: 'Simulate circuit',
    description:
      'Runs a transient analysis in Ngspice and returns per-node statistics (min/max/mean/final) '
      + 'with a downsampled trace; the full sample set goes to a CSV artifact. Requires Ngspice.',
    inputSchema: {
      circuit: circuitSchema,
      spice: z.string().optional()
        .describe('Use this deck instead of generating one — for hand-tuned .tran directives or extra models.'),
      maxPoints: z.number().int().min(2).max(500).optional()
        .describe('Samples per node to return inline (default 40).'),
    },
  }, guarded((args: Parameters<typeof simulateCircuitTool>[0]) =>
    guardSimulation(() => simulateCircuitTool(args, sink))));

  server.registerTool('render_schematic', {
    title: 'Render schematic',
    description:
      'Lays out the circuit and writes an SVG schematic. Returns the artifact reference and what '
      + 'was placed — the markup itself is not returned.',
    inputSchema: { circuit: circuitSchema },
  }, guarded((args: Parameters<typeof renderSchematic>[0]) => renderSchematic(args, sink)));

  server.registerTool('pcb_layout', {
    title: 'Generate PCB layout',
    description:
      'Places footprints and routes a two-layer board. Returns the board envelope, footprint '
      + 'positions and copper counts; full geometry (pads, trace segments, vias) goes to an artifact.',
    inputSchema: { circuit: circuitSchema },
  }, guarded((args: Parameters<typeof pcbLayoutTool>[0]) => pcbLayoutTool(args, sink)));

  return server;
};

export const createPcbPilotMcpServer = (sink: ArtifactSink, options: ToolOptions = {}): McpServer =>
  registerPcbPilotTools(new McpServer({ name: 'pcb-pilot', version: '0.1.0' }), sink, options);
