// Run lifecycle: create, prompt, resume, close.
//
// A run is never auto-closed. The agent reaching PASS moves it to
// `awaiting-review`, not to `done` — marking work finished is the user's call,
// and a board that verifies clean can still be the wrong board. `say()` resumes
// the same model session so a follow-up keeps the context that produced the
// first answer instead of rebuilding it from the JSON.
//
// The store is a `session.json` per run. That is the second seam for remote
// execution: `readSession`/`writeSession` are the only two functions that know
// where state lives, so moving to Postgres (this repo already has `pg` and
// server/auth/db.ts) is a change to this file. The workspace plus its
// session.json is also the memory snapshot a future resume-after-done would
// restore — nothing extra needs capturing.
import { runAgent } from './agent.mjs';
import { verifyWorkspace } from './exec.mjs';
import { provision, open, list as listWorkspaces } from './workspace.mjs';
import { EMPTY_USAGE, addUsage, normalizeUsage } from './cost.mjs';

/** @typedef {'running'|'awaiting-review'|'done'|'failed'} Status */

const SESSION_FILE = 'session.json';
const TRACE_FILE = 'trace.jsonl';

export const readSession = (workspace) => workspace.readJson(SESSION_FILE);
export const writeSession = (workspace, record) => workspace.writeJson(SESSION_FILE, record);

const now = () => new Date().toISOString();

/**
 * Start a run: provision a workspace, seed its session record, and hand back a
 * handle. The agent has not been called yet — `say` does that.
 *
 * @param {{ prompt: string, id?: string, assertions?: string[] }} options
 */
export const create = ({ prompt, id, assertions = [] }) => {
  const workspace = provision({ id });
  workspace.write(TRACE_FILE, '');
  writeSession(workspace, {
    id: workspace.id,
    status: 'running',
    createdAt: now(),
    updatedAt: now(),
    prompt,
    assertions,
    sessionId: null,
    turns: [],
    // One entry per API round trip. Tokens are stored; money is not — cost is
    // recomputed from these against pricing.json whenever it is displayed, so
    // correcting the rates reprices history instead of stranding it.
    requests: [],
    usageByModel: {},
    verify: null,
    totals: { turns: 0, costUsd: 0, durationMs: 0 },
  });
  return workspace;
};

/**
 * Send a message to a run and stream the agent's events.
 *
 * The first call starts the conversation; later calls resume it. Yields the
 * same normalized events `runAgent` produces, plus a final `verify` event
 * carrying the scored result, so a caller can render progress and outcome from
 * one stream.
 *
 * @param {import('./workspace.mjs').Workspace} workspace
 * @param {string} message
 * @param {{ maxTurns?: number, signal?: AbortSignal }} [options]
 */
export async function* say(workspace, message, options = {}) {
  const record = readSession(workspace);
  if (!record) throw new Error(`Run ${workspace.id} has no session.json.`);
  if (record.status === 'done') {
    throw new Error(`Run ${workspace.id} is closed. Start a new run, or reopen it by editing session.json.`);
  }

  record.status = 'running';
  record.updatedAt = now();
  writeSession(workspace, record);

  const trace = (entry) => workspace.appendLine(TRACE_FILE, { at: now(), ...entry });
  trace({ event: 'prompt', text: message });

  let result = null;
  let settled = false;
  let streamEnded = false;
  const turnIndex = record.turns.length;

  /**
   * Leave the record in a terminal state no matter how iteration ends.
   *
   * A consumer that stops early — an HTTP handler breaking out of its
   * `for await` when the browser disconnects — resumes this generator through
   * `.return()`, which runs this `finally` but none of the code after the loop.
   * Without it the run stayed `status: "running"` forever: the UI kept polling
   * it, the workspace looked busy, and the only way out was editing JSON by
   * hand. That is precisely how a stalled generation trapped the app.
   */
  const settle = (status, error) => {
    if (settled) return;
    settled = true;
    record.status = status;
    if (error) record.error = error;
    record.updatedAt = now();
    writeSession(workspace, record);
  };

  try {
    for await (const event of runAgent({
      workspace,
      prompt: message,
      resume: record.sessionId ?? undefined,
      maxTurns: options.maxTurns,
      abortController: options.abortController,
    })) {
      trace(event);
      if (event.event === 'init') record.sessionId = event.sessionId;
      if (event.event === 'usage') {
        // Per-request shape only — NOT the cost basis. The SDK reports
        // `output_tokens: 0` on assistant messages, so these cannot price a run;
        // `modelUsage` on the result does that. What they are good for is
        // counting API round trips and watching the prompt grow.
        //
        // Deduplicated by message id: one API response arrives as several
        // assistant messages (one per content block) that each repeat the same
        // usage. Counting them raw reported 40 requests where there were 22,
        // and summing them gave 140k input against a true 36k.
        const last = record.requests[record.requests.length - 1];
        const duplicate = event.messageId && last?.messageId === event.messageId;
        if (!duplicate) {
          record.requests.push({
            at: now(), turn: turnIndex, model: event.model,
            messageId: event.messageId, ...normalizeUsage(event.usage),
          });
        }
      }
      if (event.event === 'result') {
        result = event;
        // `modelUsage` is what the SDK itself bills from, it splits by model —
        // catching the small model used for side work, which never appears as an
        // assistant message — and it is per-turn, not cumulative across a resume
        // (measured: a follow-up turn reported 4,233 input against the first
        // turn's 35,950, so summing is correct and does not double-count).
        for (const [model, usage] of Object.entries(event.modelUsage || {})) {
          record.usageByModel[model] =
            addUsage(record.usageByModel[model] ?? { ...EMPTY_USAGE }, normalizeUsage(usage));
        }
      }
      yield event;
    }
    // The agent finished on its own; the outcome is decided below, not here.
    streamEnded = true;
  } catch (error) {
    const cancelled = options.abortController?.signal.aborted || /abort/i.test(error.message || '');
    trace({ event: cancelled ? 'cancelled' : 'error', message: error.message });
    settle(cancelled ? 'cancelled' : 'failed', cancelled ? 'Stopped before it finished.' : error.message);
    yield { event: cancelled ? 'cancelled' : 'error', message: record.error };
    return;
  } finally {
    // `finally` also runs on success, so it must not claim every run it sees.
    // Only an unfinished stream means the consumer walked away — a `return()`
    // from an HTTP handler whose browser disconnected — and only then is there
    // an agent still running that nobody is listening to.
    if (!streamEnded && !settled) {
      options.abortController?.abort();
      settle('cancelled', 'Stopped before it finished.');
    }
  }

  // Score the run by executing the workspace's own verify.mjs — the same
  // command the agent ran, against the same snapshot. Scoring by re-importing
  // the engine from the repo would let a green result come from a different
  // engine than the one under test.
  const verify = workspace.exists('circuit.json')
    ? await verifyWorkspace(workspace.root, record.assertions)
    : { pass: false, stage: 'output', error: 'The agent did not write circuit.json.' };

  record.verify = verify;
  record.turns.push({
    at: now(),
    message,
    reply: result?.text ?? '',
    turns: result?.turns ?? 0,
    requests: record.requests.filter((entry) => entry.turn === turnIndex).length,
    // The SDK's per-model snapshot at the end of this turn. Kept alongside our
    // own per-request tally because it also covers models we never see as
    // assistant messages — the small model the SDK uses for side work.
    modelUsage: result?.modelUsage ?? null,
    costUsd: result?.reportedCostUsd ?? 0,
    durationMs: result?.durationMs ?? 0,
    pass: Boolean(verify?.pass),
  });
  record.totals = {
    turns: record.turns.reduce((sum, turn) => sum + turn.turns, 0),
    requests: record.requests.length,
    costUsd: record.turns.reduce((sum, turn) => sum + turn.costUsd, 0),
    durationMs: record.turns.reduce((sum, turn) => sum + turn.durationMs, 0),
  };
  // PASS moves the run to review, not to done. Closing it is the user's call.
  record.status = verify?.pass ? 'awaiting-review' : 'failed';
  record.updatedAt = now();
  writeSession(workspace, record);
  trace({ event: 'verify', pass: Boolean(verify?.pass) });

  yield { event: 'verify', verify };
}

/**
 * Mark a running run as stopped, without waiting for the agent to agree.
 *
 * Cancelling cannot depend on the agent noticing. A consumer sits suspended in
 * `for await` until the next event arrives, so if the model stalls — which is
 * the case you most want to cancel — aborting the controller changes nothing
 * that the loop can observe, and the record stays `running` forever. Writing the
 * terminal state here frees whatever is watching immediately. If the agent does
 * eventually finish, `say` records the real outcome over the top.
 *
 * @returns {boolean} whether this call was the one that stopped it
 */
export const cancel = (workspace, note = 'Stopped before it finished.') => {
  const record = readSession(workspace);
  if (!record || record.status !== 'running') return false;
  record.status = 'cancelled';
  record.error = note;
  record.updatedAt = now();
  writeSession(workspace, record);
  workspace.appendLine(TRACE_FILE, { at: now(), event: 'cancelled', message: note });
  return true;
};

/** Mark a run reviewed and closed. Only the user calls this. */
export const close = (workspace, { status = 'done', note } = {}) => {
  const record = readSession(workspace);
  if (!record) throw new Error(`Run ${workspace.id} has no session.json.`);
  record.status = status;
  record.closedAt = now();
  record.updatedAt = now();
  if (note) record.note = note;
  writeSession(workspace, record);
  return record;
};

export const summaries = () => listWorkspaces()
  .map((workspace) => ({ workspace, record: readSession(workspace) }))
  .filter((entry) => entry.record);

export { open, listWorkspaces };
