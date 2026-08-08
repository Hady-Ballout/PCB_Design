// Provisioning the directory an agent works in.
//
// A run gets a snapshot, not a view of the repo. Two reasons: the agent cannot
// corrupt the engine it is judged by, and a finished run is a self-contained
// reproduction — zip sandbox/runs/<id> and it still verifies on another machine
// with nothing installed.
//
// This is one of the three seams that move when execution goes remote (the
// others are exec.mjs and the session store). Everything above it talks to a
// Workspace handle, never to `fs` directly, so an S3 or container-volume
// provider slots in here without touching the agent or the CLI.
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandboxDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(sandboxDir, '..');
export const runsDir = resolve(sandboxDir, 'runs');

/** Files the agent must never see: nothing in the workspace comes from outside this list. */
const SEED = [
  { from: 'CLAUDE.md', to: 'CLAUDE.md' },
  { from: 'knowledge', to: 'knowledge' },
  { from: 'src/core', to: 'src/core' },
  { from: 'sandbox/tools/verify.mjs', to: 'verify.mjs' },
  { from: 'sandbox/tools/solve.mjs', to: 'solve.mjs' },
];

/**
 * Which engine files a workspace gets.
 *
 * The goal is a workspace that runs with no `node_modules` at all, so the agent
 * cannot hit an install it is not allowed to perform. `src/core` is almost
 * dependency-free — the exception is five AVR-simulation modules that import
 * `avr8js`, and those have nothing to do with turning a request into circuit
 * JSON.
 *
 * The exclusion is computed by reading imports rather than hardcoded. A
 * hardcoded list is exactly the kind of thing that goes stale the first time
 * someone adds a module, and it fails as a missing file mid-run — the least
 * debuggable moment. Anything that transitively reaches a bare specifier other
 * than a `node:` builtin is left out.
 *
 * Do not "simplify" this to `exclude sim/`: topologyRules.js imports
 * sim/simValues.js, so dropping the directory breaks the verification path.
 */
const engineFileSet = (coreDir) => {
  const sources = new Map();
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__snapshots__') collect(full);
      } else if (/\.(js|d\.ts)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
        sources.set(full, readFileSync(full, 'utf8'));
      }
    }
  };
  collect(coreDir);

  // Interpolated specifiers are not imports. topologyRules.js builds SPICE text
  // containing `from "${outNet}"`, which a naive scan reads as a bare package
  // and quietly drops the single most important file in the engine. Ask for a
  // string with no interpolation.
  const importsOf = (file) => [...(sources.get(file) || '').matchAll(/(?:from|import)\s*['"]([^'"$]+)['"]/g)]
    .map((match) => match[1]);

  // A file is clean if it, and everything it reaches, imports only relative
  // paths and node: builtins.
  const verdicts = new Map();
  const isClean = (file, seen = new Set()) => {
    if (verdicts.has(file)) return verdicts.get(file);
    if (seen.has(file)) return true; // a cycle proves nothing on its own
    seen.add(file);

    let clean = true;
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) { clean = false; break; }
      const target = resolve(dirname(file), specifier);
      if (sources.has(target) && !isClean(target, seen)) { clean = false; break; }
    }
    verdicts.set(file, clean);
    return clean;
  };

  return [...sources.keys()].filter((file) => isClean(file));
};

const runId = (now, random) => {
  const stamp = new Date(now).toISOString().slice(0, 10);
  return `${stamp}-${random.toString(36).slice(2, 6)}`;
};

/**
 * A handle to one run's directory. Paths are always relative to the workspace
 * root and are refused if they escape it — the same rule the tool guard
 * enforces, applied to our own writes so a bug here cannot scribble on the repo.
 */
export class Workspace {
  constructor(id, root) {
    this.id = id;
    this.root = root;
  }

  path(relativePath = '.') {
    const full = resolve(this.root, relativePath);
    if (full !== this.root && !full.startsWith(`${this.root}/`)) {
      throw new Error(`Path escapes the workspace: ${relativePath}`);
    }
    return full;
  }

  exists(relativePath) { return existsSync(this.path(relativePath)); }

  read(relativePath) { return readFileSync(this.path(relativePath), 'utf8'); }

  readJson(relativePath) {
    try {
      return JSON.parse(this.read(relativePath));
    } catch {
      return null;
    }
  }

  write(relativePath, contents) {
    const full = this.path(relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  writeJson(relativePath, value) { this.write(relativePath, `${JSON.stringify(value, null, 2)}\n`); }

  /** Append one JSON line. The trace is the record of what the agent actually did. */
  appendLine(relativePath, value) {
    appendFileSync(this.path(relativePath), `${JSON.stringify(value)}\n`);
  }

  /** Files the agent produced, ignoring the seeded material. */
  outputs() {
    const seeded = new Set(['CLAUDE.md', 'WORKSPACE.md', 'knowledge', 'src', 'verify.mjs', 'solve.mjs']);
    return readdirSync(this.root)
      .filter((name) => !seeded.has(name))
      .map((name) => relative(this.root, join(this.root, name)));
  }

  dispose() { rmSync(this.root, { recursive: true, force: true }); }
}

/**
 * Create a run directory seeded with the engine, the knowledge base, CLAUDE.md
 * and the two tools.
 *
 * @param {{ id?: string, now?: number }} [options]
 * @returns {Workspace}
 */
export const provision = (options = {}) => {
  const id = options.id || runId(options.now ?? Date.now(), Math.random());
  const root = resolve(runsDir, id);
  if (existsSync(root)) throw new Error(`Run ${id} already exists.`);
  mkdirSync(root, { recursive: true });

  for (const { from, to } of SEED) {
    const source = resolve(repoRoot, from);
    if (!existsSync(source)) throw new Error(`Cannot seed workspace: missing ${from}`);

    if (from === 'src/core') {
      for (const file of engineFileSet(source)) {
        const target = resolve(root, to, relative(source, file));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(file, target);
      }
      continue;
    }
    cpSync(source, resolve(root, to), { recursive: true });
  }

  return new Workspace(id, root);
};

/** Reopen an existing run. */
export const open = (id) => {
  const root = resolve(runsDir, id);
  if (!existsSync(root)) throw new Error(`No run "${id}". Try: node sandbox/cli.mjs list`);
  return new Workspace(id, root);
};

/** Every run on disk, newest first. */
export const list = () => {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => existsSync(resolve(runsDir, name, 'session.json')))
    .map((name) => new Workspace(name, resolve(runsDir, name)))
    .sort((a, b) => b.id.localeCompare(a.id));
};
