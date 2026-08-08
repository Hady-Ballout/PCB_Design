// Stage the runtime assets the compiled server needs next to its output.
//
// tsc emits only server/**/*.ts, but dist/server/server/index.js reaches out at
// runtime to ../../sandbox/session.mjs (plain ESM, deliberately not TypeScript)
// and the sandbox seeds every run workspace from its repoRoot — which, once
// deployed, is dist/server/. So the engine, the knowledge base, the sandbox
// itself and CLAUDE.md must all exist under dist/server/ or the generate route
// dies on its first request. Run snapshots and eval results are working state,
// not code, and are filtered out.
import { cpSync, copyFileSync } from 'node:fs';

cpSync('src/core', 'dist/server/src/core', { recursive: true });
cpSync('knowledge', 'dist/server/knowledge', { recursive: true });
cpSync('sandbox', 'dist/server/sandbox', {
  recursive: true,
  filter: (source) => !/sandbox[\\/](runs|results)([\\/]|$)/.test(source),
});
copyFileSync('CLAUDE.md', 'dist/server/CLAUDE.md');
