import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveArtifactDir, writeArtifact } from './artifacts.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeArtifact', () => {
  it('writes the content and returns an absolute path', () => {
    const target = path.join(root, 'out');

    const file = writeArtifact(target, 'deck.cir', '* netlist\n.end\n');

    expect(path.isAbsolute(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('* netlist\n.end\n');
  });

  it('creates the artifact directory when it does not exist yet', () => {
    const target = path.join(root, 'nested', 'deeper');
    expect(existsSync(target)).toBe(false);

    writeArtifact(target, 'schematic.svg', '<svg/>');

    expect(existsSync(target)).toBe(true);
  });

  it('refuses a filename that would escape the artifact directory', () => {
    expect(() => writeArtifact(root, '../escaped.txt', 'nope')).toThrow(/filename/i);
  });

  it('does not let a nested path in the filename escape either', () => {
    const file = writeArtifact(root, 'sub/dir/report.json', '{}');

    expect(path.dirname(file)).toBe(root);
    expect(path.basename(file)).toBe('report.json');
  });
});

describe('resolveArtifactDir', () => {
  it('prefers an explicit override', () => {
    expect(resolveArtifactDir(path.join(root, 'custom'))).toBe(path.join(root, 'custom'));
  });

  it('falls back to a directory inside the repo when nothing is configured', () => {
    const resolved = resolveArtifactDir(undefined, {});

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join('mcp', '.artifacts'))).toBe(true);
  });

  it('honours PCB_MCP_ARTIFACT_DIR from the environment', () => {
    const resolved = resolveArtifactDir(undefined, { PCB_MCP_ARTIFACT_DIR: path.join(root, 'from-env') });

    expect(resolved).toBe(path.join(root, 'from-env'));
  });
});
