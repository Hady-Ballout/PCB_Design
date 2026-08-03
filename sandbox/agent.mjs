// Driving the model, and deciding what it is allowed to do.
//
// Two jobs live here. `runAgent` wraps the SDK's `query()` and normalizes its
// message stream into flat events the CLI and the eval harness both consume.
// `makeGuard` is the permission boundary.
//
// On the boundary: `bypassPermissions` would be less code, but it hands the
// model unrestricted Bash on the host — and the host is this repo, with an API
// token in .env.deepseek. A `canUseTool` callback costs one function and denies
// by rule instead of by trust. It is also exactly the seam that becomes the
// container wall later, so writing it now is not throwaway work.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { repoRoot } from './workspace.mjs';

/**
 * Tools the agent may use. The guard checks membership; this list is NOT passed
 * to the SDK as `allowedTools`.
 *
 * That distinction is the whole security of the sandbox. A bare name in
 * `allowedTools` auto-approves the tool *before* `canUseTool` is consulted — the
 * SDK warns about it (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) and the effect is that
 * the guard silently becomes dead code while still looking wired up. Leaving
 * `allowedTools` empty makes every call fall through to the callback.
 *
 * If you add `allowedTools` back, the path checks and the Bash denials below
 * stop running. Do not.
 */
export const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite'];

/** Never offered to the model at all, so it does not waste turns trying. */
export const DISALLOWED_TOOLS = ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

/** Seeded material the agent reads but must not rewrite under itself. */
const READ_ONLY_PREFIXES = ['src/core', 'knowledge', 'CLAUDE.md', 'WORKSPACE.md', 'verify.mjs', 'solve.mjs'];

/**
 * Bash commands to refuse. The list is about capability, not about suspicion:
 * there is no package manager in the workspace, no network the agent should
 * need, and nothing outside the run directory it should reach. A denial comes
 * back as text the model can read, so a wrong guess costs it a turn, not the run.
 */
const DENIED_BASH = [
  { pattern: /\b(npm|npx|yarn|pnpm|pip|pip3|brew|apt|apt-get)\b/, why: 'There is no package manager here. The engine needs no install — plain `node` runs it.' },
  { pattern: /\b(curl|wget|nc|ssh|scp|telnet)\b/, why: 'No network access. Everything you need is in this directory.' },
  { pattern: /\bgit\b/, why: 'This workspace is not a git repository.' },
  { pattern: /\b(sudo|chmod|chown|kill|killall|shutdown|reboot)\b/, why: 'Not permitted in the sandbox.' },
  { pattern: /rm\s+(-[a-zA-Z]*\s+)*\//, why: 'Refusing a recursive delete against an absolute path.' },
  { pattern: /(^|[\s;&|])(cd|pushd)\s+([/~]|\.\.)/, why: 'Stay in the workspace directory. Use paths relative to it.' },
  { pattern: /\.\.\/\.\./, why: 'That path leaves the workspace.' },
  { pattern: /\.env/, why: 'Credentials are not available to the sandbox.' },
];

const deny = (message) => ({ behavior: 'deny', message });
const allow = () => ({ behavior: 'allow' });

/**
 * Permission callback bound to one workspace.
 *
 * @param {string} workspaceRoot absolute path
 * @param {(entry: object) => void} [log] receives every decision
 * @returns {import('@anthropic-ai/claude-agent-sdk').CanUseTool}
 */
export const makeGuard = (workspaceRoot, log = () => {}) => {
  const root = resolve(workspaceRoot);

  /** Resolve a tool's path argument against the workspace and refuse escapes. */
  const checkPath = (rawPath, { write }) => {
    if (!rawPath) return null;
    const full = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
    if (full !== root && !full.startsWith(`${root}/`)) {
      return `Path is outside the workspace: ${rawPath}. Work only inside the current directory.`;
    }
    if (!write) return null;
    const relativePath = full.slice(root.length + 1);
    if (READ_ONLY_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
      return `${relativePath} is read-only. The engine, the knowledge base and the tools are fixed inputs — `
        + 'write your circuit to circuit.json instead.';
    }
    return null;
  };

  return async (toolName, input) => {
    const decide = () => {
      if (!ALLOWED_TOOLS.includes(toolName)) return deny(`${toolName} is not available in the sandbox.`);

      if (toolName === 'Bash') {
        const command = String(input.command || '');
        const rule = DENIED_BASH.find((entry) => entry.pattern.test(command));
        if (rule) return deny(rule.why);
        return allow();
      }

      const write = toolName === 'Write' || toolName === 'Edit';
      const problem = checkPath(input.file_path || input.path || input.notebook_path, { write })
        ?? (toolName === 'Grep' || toolName === 'Glob' ? checkPath(input.path, { write: false }) : null);
      return problem ? deny(problem) : allow();
    };

    const result = decide();
    log({
      event: 'permission',
      tool: toolName,
      behavior: result.behavior,
      ...(result.behavior === 'deny' ? { reason: result.message } : {}),
      input: toolName === 'Bash' ? { command: input.command } : { file_path: input.file_path ?? input.path },
    });
    return result;
  };
};

// ------------------------------------------------------------------- env

/**
 * Read a dotenv file into a plain object. The sandbox reads credentials from
 * exactly one place — the file named here — and never inherits an ambient key.
 */
export const readEnvFile = (file) => {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, '')];
    })
    .filter(([key]) => key));
};

export const ENV_FILE = process.env.SANDBOX_ENV_FILE || '.env.deepseek';

// -------------------------------------------------------------- the prompt

/**
 * The system prompt is CLAUDE.md plus a workspace addendum.
 *
 * CLAUDE.md is used verbatim and is not edited for the sandbox — it is the
 * portable domain prompt, and it must stay portable. What it cannot know is
 * where to write output, that verify.mjs exists, and that the run pauses for
 * review. That is what the addendum carries, and every future host of CLAUDE.md
 * supplies its own.
 */
export const buildSystemPrompt = (workspace) => {
  const claudeMd = readFileSync(resolve(repoRoot, 'CLAUDE.md'), 'utf8');
  const addendum = workspace.exists('WORKSPACE.md')
    ? workspace.read('WORKSPACE.md')
    : readFileSync(resolve(repoRoot, 'sandbox/WORKSPACE.md'), 'utf8');
  return `${claudeMd}\n\n---\n\n${addendum}`;
};

// ---------------------------------------------------------------- the loop

/**
 * Run one turn of the agent against a workspace, yielding normalized events.
 *
 * Events: `init`, `text`, `thinking`, `tool`, `permission`, `result`. The CLI
 * renders them, the eval harness counts them, and an HTTP route can forward
 * them as SSE without either of those knowing about the SDK's message union.
 *
 * @param {object} params
 * @param {import('./workspace.mjs').Workspace} params.workspace
 * @param {string} params.prompt
 * @param {string} [params.resume] SDK session id, for follow-up turns
 * @param {number} [params.maxTurns]
 * @param {AbortSignal} [params.signal]
 */
export const buildQueryOptions = ({ workspace, guard, resume, maxTurns = 60, signal, env }) => ({
  cwd: workspace.root,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemPrompt(workspace) },
  // Nothing from the host reaches the agent: no user CLAUDE.md, no project
  // settings, no skills. The workspace is the entire world it sees.
  settingSources: [],
  // Deliberately no `allowedTools`: a bare entry there shadows canUseTool and
  // the guard stops being consulted. See ALLOWED_TOOLS above.
  disallowedTools: DISALLOWED_TOOLS,
  permissionMode: 'default',
  canUseTool: guard,
  maxTurns,
  model: env.ANTHROPIC_MODEL,
  env,
  ...(resume ? { resume } : {}),
  ...(signal ? { abortController: { signal } } : {}),
});

export async function* runAgent({ workspace, prompt, resume, maxTurns = 60, signal }) {
  const pending = [];
  const guard = makeGuard(workspace.root, (entry) => pending.push(entry));

  const env = { ...process.env, ...readEnvFile(ENV_FILE) };

  const stream = query({
    prompt,
    options: buildQueryOptions({ workspace, guard, resume, maxTurns, signal, env }),
  });

  for await (const message of stream) {
    // Permission decisions are recorded by the guard as they happen; drain them
    // in order so the trace interleaves correctly with the tool calls.
    while (pending.length) yield pending.shift();

    if (message.type === 'system' && message.subtype === 'init') {
      yield { event: 'init', sessionId: message.session_id, model: message.model, tools: message.tools };
      continue;
    }

    if (message.type === 'assistant') {
      // One assistant message is one API request, and it carries its own usage.
      // This is the finest granularity available and the only place per-request
      // cost can be attributed — the result message reports run totals only.
      if (message.message.usage) {
        yield {
          event: 'usage',
          model: message.message.model || 'unknown',
          usage: message.message.usage,
          // The SDK delivers one assistant message per content block, each
          // repeating the whole response's usage — three blocks look like three
          // requests carrying identical token counts. `message.id` is the API
          // response id and is shared across them, so it is what makes a
          // request countable. `request_id` on the wrapper is null here.
          messageId: message.message.id ?? null,
          requestId: message.request_id ?? null,
        };
      }
      for (const block of message.message.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          yield { event: 'text', text: block.text };
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          yield { event: 'thinking', text: block.thinking };
        } else if (block.type === 'tool_use') {
          yield { event: 'tool', tool: block.name, input: block.input };
        }
      }
      continue;
    }

    if (message.type === 'result') {
      yield {
        event: 'result',
        ok: !message.is_error,
        sessionId: message.session_id,
        text: message.result ?? '',
        turns: message.num_turns,
        durationMs: message.duration_ms,
        // The SDK's own figure, kept for comparison only. It is computed from
        // its internal rate table, which is not necessarily what the endpoint
        // behind ANTHROPIC_BASE_URL bills. We price from tokens ourselves.
        reportedCostUsd: message.total_cost_usd ?? 0,
        costUsd: message.total_cost_usd ?? 0,
        usage: message.usage ?? null,
        // Per-model split: a run uses a small model for side work alongside the
        // one doing the design, and they can bill at different rates.
        modelUsage: message.modelUsage ?? null,
      };
    }
  }

  while (pending.length) yield pending.shift();
}
