#!/usr/bin/env node
// PCB Pilot MCP server — local stdio entry point.
//
// Exposes the deterministic half of the engine (validation, SPICE/KiCad export,
// Ngspice simulation, schematic and PCB geometry) as tools. The model authors the
// circuit; these tools check it, run it, and turn it into files.
//
// The tool surface itself lives in mcp/registerTools.ts, shared with the hosted
// HTTP transport. This file owns only stdio concerns.
//
// Run:  npx tsx mcp/server.ts [--artifact-dir <path>]
// See mcp/README.md for the Claude Desktop / Claude Code config.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveArtifactDir } from './artifacts.js';
import { fileSink } from './artifactSink.js';
import { createPcbPilotMcpServer } from './registerTools.js';

export const createPcbPilotServer = ({ artifactDir }: { artifactDir: string }) =>
  createPcbPilotMcpServer(fileSink(artifactDir));

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
