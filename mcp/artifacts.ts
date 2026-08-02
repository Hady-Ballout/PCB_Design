// Artifact files. Tools that produce anything bulky — SVG schematics, PCB
// geometry, full waveform CSVs — write it here and return the path plus a
// summary, rather than inlining thousands of tokens into the conversation.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ArtifactContent } from './artifactSink.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Precedence: explicit `--artifact-dir` flag, then PCB_MCP_ARTIFACT_DIR, then
 * `mcp/.artifacts` inside the repo (gitignored).
 */
export const resolveArtifactDir = (
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string => {
  const configured = override || env.PCB_MCP_ARTIFACT_DIR;
  if (configured) return path.resolve(configured);
  return path.join(here, '.artifacts');
};

/**
 * Writes `content` into `dir` under a flattened basename. A caller-supplied
 * name never controls the directory: `..` is rejected outright and any nested
 * path is collapsed to its basename, so an artifact cannot land outside `dir`.
 */
export const writeArtifact = (dir: string, filename: string, content: ArtifactContent): string => {
  const segments = String(filename).split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    // Flattening this quietly would hide the bug that produced it.
    throw new Error(`Invalid artifact filename "${filename}": path traversal is not allowed.`);
  }

  const base = path.basename(filename);
  if (!base || base === '.') {
    throw new Error(`Invalid artifact filename: "${filename}"`);
  }

  const absoluteDir = path.resolve(dir);
  mkdirSync(absoluteDir, { recursive: true });
  const target = path.join(absoluteDir, base);
  // No encoding argument: strings still land as UTF-8, and a Uint8Array (the
  // zipped Gerber package) is written verbatim rather than round-tripped
  // through a text decode that would corrupt every byte above 0x7f.
  writeFileSync(target, content);
  return target;
};

/** Filesystem-safe slug used to name artifacts after the circuit they came from. */
export const slugify = (title: string, fallback = 'circuit'): string => {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
};
