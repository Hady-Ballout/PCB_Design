// Hosted MCP transport — streamable HTTP, mounted at /api/mcp.
//
// Stateless by design: a fresh McpServer and transport are built per request and
// torn down when it completes. Render runs several instances and recycles them,
// so nothing may live in one process's memory between calls — any instance has
// to be able to serve any request. (The artifact store is the one exception, and
// it is explicitly best-effort: a miss costs the user one re-run.)
//
// The tool surface comes from mcp/registerTools.ts, shared with the stdio server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ArtifactStore } from '../../mcp/artifactSink.js';
import { SubjectConcurrencyLimit } from '../../mcp/limits.js';
import { createPcbPilotMcpServer } from '../../mcp/registerTools.js';

// Process-wide, not per-request: the whole point is to bound what one caller can
// have in flight across concurrent requests. Each Render instance enforces its own
// share, which is the right granularity — the limit protects this container.
const simulationLimit = new SubjectConcurrencyLimit(
  Number(process.env.MCP_MAX_CONCURRENT_SIMULATIONS || 1),
);

export interface McpRequestContext {
  store: ArtifactStore;
  /** Stable identifier for the authenticated caller; scopes their artifacts. */
  subject: string;
}

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  { store, subject }: McpRequestContext,
): Promise<void> {
  const server = createPcbPilotMcpServer(store.sinkFor(subject), {
    guardSimulation: (task) => simulationLimit.run(subject, task),
  });
  const transport = new StreamableHTTPServerTransport({
    // undefined = stateless: no session id, no server-side session table.
    sessionIdGenerator: undefined,
    // Answer with a plain JSON body rather than holding an SSE stream open.
    // These tools are request/response — none of them push notifications — and a
    // long-lived stream per call would pin a connection on Render for nothing.
    enableJsonResponse: true,
  });

  // Tear both down when the HTTP response finishes, however it finishes.
  response.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: (error as Error).message },
        id: null,
      }));
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  csv: 'text/csv',
  json: 'application/json',
  cir: 'text/plain',
  net: 'application/xml',
  kicad_sch: 'text/plain',
  kicad_pcb: 'text/plain',
  zip: 'application/zip',
  drl: 'text/plain',
  txt: 'text/plain',
};

const contentTypeFor = (filename: string): string => {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
};

/**
 * GET /api/mcp/artifacts/:id
 *
 * A miss, an expiry, and someone else's artifact are all a flat 404 — the store
 * already collapses them, so ids can't be probed for existence.
 */
export function handleArtifactDownload(
  request: IncomingMessage,
  response: ServerResponse,
  { store, subject }: McpRequestContext,
): void {
  const id = (request.url ?? '').split('/').pop()?.split('?')[0] ?? '';
  const artifact = store.get(id, subject);

  if (!artifact) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Artifact not found or expired.' }));
    return;
  }

  // Length in BYTES, not characters: an artifact can be a zipped Gerber package
  // (raw bytes) or UTF-8 text whose length differs from its character count.
  // Buffer.byteLength answers both correctly; response.end writes a Uint8Array
  // through untouched.
  response.writeHead(200, {
    'Content-Type': contentTypeFor(artifact.filename),
    'Content-Disposition': `attachment; filename="${artifact.filename}"`,
    'Content-Length': String(Buffer.byteLength(artifact.content)),
    'Cache-Control': 'private, no-store',
  });
  response.end(artifact.content);
}
