// The one place a command runs.
//
// Nothing else in the sandbox calls child_process. That is the whole point:
// moving execution into a container, or onto a Fargate task, is a change to
// this file and nothing else.
//
// Note what this does and does not cover today. The agent's own Bash calls go
// through the Agent SDK's Bash tool, which runs on the host — they are
// constrained by the `canUseTool` guard in agent.mjs, not by this file. This
// module is what the sandbox itself uses (running verify.mjs to score a run),
// and it is the seam the agent's Bash will be routed through when the container
// mode lands. Keeping both paths pointed at one `exec()` is why that later
// change stays small.
import { spawn } from 'node:child_process';

/** @typedef {{ code: number, stdout: string, stderr: string, timedOut: boolean }} ExecResult */

export const MODE = process.env.SANDBOX_EXEC_MODE || 'local';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a command with its cwd pinned to a workspace.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number, env?: Record<string,string> }} options
 * @returns {Promise<ExecResult>}
 */
export const exec = (command, args, options) => {
  if (MODE === 'docker') {
    // Deliberately unimplemented rather than half-implemented: a container mode
    // that silently falls back to the host would be worse than none, because
    // the isolation would be assumed and absent.
    throw new Error('SANDBOX_EXEC_MODE=docker is not implemented yet. Unset it to run locally.');
  }
  return localRun(command, args, options);
};

const localRun = (command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env }) => new Promise((resolvePromise) => {
  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    shell: false, // no shell means no injection through a crafted argument
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    clearTimeout(timer);
    resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
  });
});

/**
 * Score a workspace by running its own copy of verify.mjs. The sandbox never
 * imports the engine directly for this — it runs the same command the agent
 * runs, against the same snapshot, so a green score cannot come from a
 * different engine than the one the agent was working with.
 *
 * @param {string} cwd workspace root
 * @param {string[]} [assertions]
 * @returns {Promise<object|null>} the parsed --json report, or null if it did not run
 */
export const verifyWorkspace = async (cwd, assertions = []) => {
  const args = ['verify.mjs', 'circuit.json', '--json'];
  for (const assertion of assertions) args.push('--assert', assertion);
  const result = await exec(process.execPath, args, { cwd, timeoutMs: 180_000 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.timedOut
      ? { pass: false, stage: 'verify', error: 'verify.mjs timed out' }
      : { pass: false, stage: 'verify', error: result.stderr.trim() || `verify.mjs exited ${result.code}` };
  }
};
