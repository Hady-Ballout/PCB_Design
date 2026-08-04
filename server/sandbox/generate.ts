// Generation route: the sandbox, behind an HTTP endpoint.
//
// The agent takes 80-200 seconds per board and spends it reading the knowledge
// base and running the engine. A request/response route would leave the user
// staring at a spinner for three minutes with no idea whether anything was
// happening, so this streams the agent's own events as they arrive — the same
// normalized shape `sandbox/session.mjs` yields to the CLI.
//
// The route deliberately returns the *circuit*, not a finished workspace
// package. Building that package (validation, simulation, schematic, SVG, SPICE,
// KiCad netlist) already happens in the browser via `buildImportedResult`, which
// is the documented contract every downstream view reads. Producing it here as
// well would mean two paths that could disagree.
import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-expect-error — the sandbox is plain ESM JavaScript, deliberately: it is
// the same code the CLI runs, and a TS copy would be a second implementation.
import { create, say, open, readSession } from '../../sandbox/session.mjs';

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * What each composer mode asks of the turn.
 *
 * Only `implement` is allowed to write `circuit.json`. The other two exist so a
 * design can be interrogated before paying to build one — they skip the
 * place-and-route-and-verify loop entirely, which is most of the cost and
 * nearly all of the wall time.
 */
const MODES: Record<string, string> = {
  ask: 'Answer the question below about the current circuit. Do not modify circuit.json '
    + 'and do not run the verification tools — this is a question, not a change request. '
    + 'Read whatever files you need, then reply in prose.',
  plan: 'Propose an approach for the request below: the topology you would use, the parts '
    + 'it needs, and the values you would solve for. Do NOT write circuit.json and do not '
    + 'verify anything — this is a plan for the user to approve, not a board.',
};

const writeEvent = (response: ServerResponse, event: StreamEvent): void => {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
};

/**
 * Run one sandbox turn, streaming progress as Server-Sent Events.
 *
 * A new prompt starts a run; passing `runId` continues one, which is how a
 * follow-up ("make it 5 seconds") keeps the context that produced the first
 * board instead of rebuilding it from the JSON.
 */
export const handleSandboxGenerate = async (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> => {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'A prompt is required.' }));
    return;
  }

  const mode = MODES[String(body.mode || 'implement')] ? String(body.mode) : 'implement';
  const turn = mode === 'implement' ? prompt : `${MODES[mode]}\n\n${prompt}`;

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer text/event-stream by default, which would hold
    // every event until the run ended and defeat the point.
    'X-Accel-Buffering': 'no',
  });

  const runId = body.runId ? String(body.runId) : null;
  let workspace;
  try {
    workspace = runId ? open(runId) : create({ prompt });
  } catch (error) {
    writeEvent(response, { type: 'error', message: (error as Error).message });
    response.end();
    return;
  }

  writeEvent(response, { type: 'run', runId: workspace.id });

  // If the client disconnects mid-run, stop streaming. The agent finishes on its
  // own and the workspace is still on disk, so the run is recoverable by id
  // rather than lost.
  let aborted = false;
  let reply = '';
  request.on('close', () => { aborted = true; });

  try {
    for await (const event of say(workspace, turn)) {
      if (aborted) break;
      switch (event.event) {
        case 'init':
          writeEvent(response, { type: 'stage', stage: 'thinking', model: event.model });
          break;
        case 'text':
          // Keep the last block: the agent's closing summary is what a user
          // reading an Ask or Plan answer actually wants.
          reply = event.text;
          writeEvent(response, { type: 'text', text: event.text });
          break;
        case 'thinking':
          writeEvent(response, { type: 'thinking', text: event.text });
          break;
        case 'tool':
          // The tool name and its target are enough to show progress without
          // leaking the workspace's absolute paths to the browser.
          writeEvent(response, {
            type: 'tool',
            tool: event.tool,
            detail: summarizeTool(event.tool, event.input as Record<string, unknown>),
          });
          break;
        case 'result':
          writeEvent(response, { type: 'turn', turns: event.turns, durationMs: event.durationMs });
          break;
        case 'verify':
          writeEvent(response, { type: 'verify', verify: event.verify });
          break;
        case 'error':
          writeEvent(response, { type: 'error', message: event.message });
          break;
        default:
          break;
      }
    }

    if (aborted) return;

    const record = readSession(workspace);
    const circuit = workspace.exists('circuit.json') ? workspace.readJson('circuit.json') : null;
    const report = workspace.exists('report.md') ? workspace.read('report.md') : '';

    writeEvent(response, {
      type: 'done',
      runId: workspace.id,
      mode,
      // Ask and Plan produce prose, not a board. The client needs the reply to
      // show as the assistant's message; in implement mode it is a summary the
      // client replaces with its own verdict line.
      reply,
      // In ask/plan mode this is whatever the previous implement turn left, so
      // the client must not treat it as a new result.
      circuit: mode === 'implement' ? circuit : null,
      report,
      verify: mode === 'implement' ? (record?.verify ?? null) : null,
      // Cost is priced from stored tokens, so the UI shows the same number
      // `node sandbox/cli.mjs cost <id>` would.
      totals: record?.totals ?? null,
      usageByModel: record?.usageByModel ?? null,
    });
  } catch (error) {
    writeEvent(response, { type: 'error', message: (error as Error).message });
  } finally {
    if (!aborted) response.end();
  }
};

/**
 * Read a run's current state by id.
 *
 * A generation survives the browser: the agent runs server-side and writes into
 * its workspace, so closing the tab or reloading mid-run loses the event stream
 * but not the work. This is how the client picks a run back up — it stores the
 * run id on the chat, and asks here what became of it.
 */
export const handleSandboxRun = (
  response: ServerResponse,
  runId: string,
): void => {
  const send = (status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  let workspace;
  try {
    workspace = open(runId);
  } catch {
    send(404, { error: `No run "${runId}".` });
    return;
  }

  const record = readSession(workspace);
  send(200, {
    runId,
    status: record?.status ?? 'unknown',
    circuit: workspace.exists('circuit.json') ? workspace.readJson('circuit.json') : null,
    report: workspace.exists('report.md') ? workspace.read('report.md') : '',
    verify: record?.verify ?? null,
    totals: record?.totals ?? null,
  });
};

/** One short line describing what a tool call is doing, for the progress list. */
const summarizeTool = (tool: string, input: Record<string, unknown> = {}): string => {
  if (tool === 'Bash') {
    const command = String(input.command || '');
    if (command.includes('verify.mjs')) return 'verifying the board';
    if (command.includes('solve.mjs')) return 'searching component values';
    return command.slice(0, 60);
  }
  const path = String(input.file_path || input.path || '');
  const name = path.split('/').slice(-2).join('/');
  if (tool === 'Read') return name ? `reading ${name}` : 'reading';
  if (tool === 'Write' || tool === 'Edit') return name ? `writing ${name}` : 'writing';
  if (tool === 'Grep' || tool === 'Glob') return 'searching the knowledge base';
  return tool;
};
