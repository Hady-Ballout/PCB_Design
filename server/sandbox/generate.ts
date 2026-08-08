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
// The sandbox is plain ESM JavaScript, deliberately: it is the same code the
// CLI runs, and a TS copy would be a second implementation. Same for src/core,
// which is dependency-free JavaScript shared with the browser.
import { create, say, open, readSession, cancel } from '../../sandbox/session.mjs';
import { COMPONENT_KINDS } from '../../src/core/componentKinds.js';

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
interface SandboxHooks {
  /** User id the run belongs to; stored on the session and enforced on resume. */
  owner?: number;
  /** Called once per turn with the billable token count (fresh input + cache writes + output). */
  onUsage?: (tokens: number) => void;
}

type UsageByModel = Record<string, { input?: number; output?: number; cacheWrite?: number }> | null | undefined;

const billableOf = (usageByModel: UsageByModel): number => Object.values(usageByModel ?? {})
  .reduce((sum, usage) => sum + (usage.input ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0), 0);

/**
 * What a turn costs the user's daily allowance: the growth of the session's
 * usageByModel over the turn. usageByModel, not the per-request entries — the
 * SDK reports output_tokens as 0 on assistant messages, so only the per-turn
 * modelUsage totals carry real output counts. Cache reads are excluded on
 * purpose: they are 85–95% of a run's raw volume at ~1/5 the input price, so
 * metering them would exhaust a day's allowance on one board while the other
 * three buckets track real spend within ~20%.
 */
export const billableTokens = (before: UsageByModel, after: UsageByModel): number =>
  Math.max(0, billableOf(after) - billableOf(before));

export const handleSandboxGenerate = async (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
  hooks: SandboxHooks = {},
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
    workspace = runId ? open(runId) : create({ prompt, owner: hooks.owner });
  } catch (error) {
    writeEvent(response, { type: 'error', message: (error as Error).message });
    response.end();
    return;
  }

  // Resuming someone else's run is answered exactly like a missing one, so an
  // id is not a capability and existence is not leaked.
  if (runId && hooks.owner !== undefined) {
    const existing = readSession(workspace);
    if (existing?.owner !== undefined && existing.owner !== hooks.owner) {
      writeEvent(response, { type: 'error', message: `No run "${runId}".` });
      response.end();
      return;
    }
  }

  // Daily-token metering charges only this turn's growth — a resumed session
  // must not re-bill turns that were already recorded when they ran.
  const usageBefore = readSession(workspace)?.usageByModel ?? {};

  writeEvent(response, { type: 'run', runId: workspace.id });

  // A disconnect now stops the agent, rather than only stopping the stream.
  // Leaving it running meant a hung generation could not be cancelled at all —
  // the browser could look away, but the run kept its workspace marked busy and
  // there was no way to reach it.
  const controller = new AbortController();
  let aborted = false;
  let reply = '';
  // `response.on('close')`, not `request.on('close')`. The request body is fully
  // read before this handler is called, so that stream has already closed and
  // its event either never fires again or fires instantly — measured: a
  // disconnect left the run `running` because nothing was listening to the
  // socket. The response closes when the connection does, which is the actual
  // signal that the browser went away.
  response.on('close', () => {
    if (aborted) return;
    aborted = true;
    controller.abort();
    // Mark it stopped here rather than waiting for the loop to notice. The
    // `for await` below is suspended until the agent produces its next event,
    // so a stalled model — the case most worth cancelling — would otherwise
    // leave the run `running` indefinitely with nothing able to clear it.
    cancel(workspace);
  });

  try {
    for await (const event of say(workspace, turn, { abortController: controller })) {
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
            detail: summarizeTool(event.tool, event.input as Record<string, unknown>, workspace.root),
          });
          break;
        case 'result':
          writeEvent(response, { type: 'turn', turns: event.turns, durationMs: event.durationMs });
          break;
        case 'verify':
          writeEvent(response, { type: 'verify', verify: event.verify });
          break;
        case 'cancelled':
          writeEvent(response, { type: 'cancelled', message: event.message });
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
    // Meter in the finally so an aborted or failed turn still records what it
    // spent — the tokens are gone either way.
    try {
      hooks.onUsage?.(billableTokens(usageBefore, readSession(workspace)?.usageByModel));
    } catch {
      // Metering must never take down the stream teardown.
    }
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
  userId?: number,
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
  // Someone else's run reads exactly like a missing one — a run id is not a
  // capability. Ownerless runs (created before owners existed) stay readable.
  if (userId !== undefined && record?.owner !== undefined && record.owner !== userId) {
    send(404, { error: `No run "${runId}".` });
    return;
  }
  send(200, {
    runId,
    status: record?.status ?? 'unknown',
    circuit: workspace.exists('circuit.json') ? workspace.readJson('circuit.json') : null,
    report: workspace.exists('report.md') ? workspace.read('report.md') : '',
    verify: record?.verify ?? null,
    totals: record?.totals ?? null,
  });
};

/**
 * One short line describing what a tool call is doing, in the language of the
 * work rather than the language of the implementation.
 *
 * The readout used to print file paths — "reading components/voltage_source.md"
 * — which exposes how the knowledge base happens to be laid out and tells the
 * person waiting nothing they care about. They want to know the agent is looking
 * at the voltage source, not which file that lives in.
 *
 * Component pages are named from the engine's own label table, so "555 timer"
 * and "Barometric sensor (BMP280, I2C)" come out right without a second list to
 * keep in sync.
 */
export const summarizeTool = (tool: string, input: Record<string, unknown> = {}, root = ''): string => {
  if (tool === 'Bash') {
    // Collapse whitespace first: the agent writes multi-line node scripts, and a
    // raw newline breaks the single-line readout.
    const command = String(input.command || '').replace(/\s+/g, ' ').trim();
    if (command.includes('verify.mjs')) return 'Checking the board';
    if (command.includes('solve.mjs')) return 'Solving component values';
    // It reads reference pages with `cat` as often as with the Read tool.
    const read = /(?:^|\s)(?:cat|head|tail|less)\s+(\S+)/.exec(command);
    if (read) return describePath(read[1]);
    if (/^node\s+-e/.test(command)) return 'Working through the arithmetic';
    if (/^(grep|rg|ls|find)\b/.test(command)) return 'Looking for the right part';
    return 'Working';
  }

  // The agent keeps a todo list; the tool's name is not a progress update.
  if (/^(TodoWrite|Task(Create|Update|List))$/.test(tool)) return 'Planning the next step';

  const raw = String(input.file_path || input.path || '');
  const relative = root && raw.startsWith(root) ? raw.slice(root.length).replace(/^\//, '') : raw;

  if (tool === 'Grep' || tool === 'Glob') return 'Looking for the right part';
  // Anything without a path to describe gets a neutral line rather than a tool
  // name — "TaskUpdate" is internal vocabulary leaking into the UI.
  if (!relative) return 'Working';
  if (tool === 'Write' || tool === 'Edit') {
    if (/circuit\.json$/.test(relative)) return 'Drafting the circuit';
    if (/report\.md$/.test(relative)) return 'Writing up the result';
    return 'Working';
  }
  return describePath(relative);
};

/** Turn a workspace path into something worth reading. */
const describePath = (path: string): string => {
  const clean = String(path).replace(/^\.\//, '');

  const component = /components\/([\w-]+)\.md$/.exec(clean);
  if (component) {
    const kind = component[1];
    if (kind === 'README') return 'Browsing the component index';
    const label = (COMPONENT_KINDS as Record<string, { label?: string }>)[kind]?.label;
    return `Exploring ${label || kind.replace(/_/g, ' ')}`;
  }

  const pattern = /patterns\/([\w-]+)\.md$/.exec(clean);
  if (pattern) {
    return pattern[1] === 'README'
      ? 'Looking for a matching pattern'
      : `Studying the ${pattern[1].replace(/-/g, ' ')} pattern`;
  }

  if (/prompts\//.test(clean)) return 'Reviewing the design procedure';
  if (/^(CLAUDE|WORKSPACE)\.md$/.test(clean)) return 'Re-reading the brief';
  if (/circuit\.json$/.test(clean)) return 'Reviewing the circuit';
  if (/report\.md$/.test(clean)) return 'Reviewing the write-up';
  if (/src\/core\//.test(clean)) return 'Consulting the design rules';
  return 'Reading the reference';
};
