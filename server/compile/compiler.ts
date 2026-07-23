// Compiles Arduino sketches to Intel HEX with a local arduino-cli, following
// the ngspice pattern in server/simulation/simulator.ts: env-overridable
// binary, temp working dir, spawn wrapper that never rejects, friendly
// missing-binary hint. Sketches never leave the machine.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { CompileResult } from '../types.js';

const getArduinoCliCommand = (): string => process.env.ARDUINO_CLI_BINARY || 'arduino-cli';

// The sketch's main .ino must live in a folder of the same name.
export const SKETCH_NAME = 'sketch';

export const buildCompileArgs = (sketchDir: string, outputDir: string): string[] => [
  'compile',
  '--fqbn',
  'arduino:avr:uno',
  '--output-dir',
  outputDir,
  sketchDir,
];

export const isMissingCli = (rawOutput: string): boolean =>
  /ENOENT|not found|not recognized/i.test(rawOutput);

// avr-gcc errors carry the temp-dir path; strip it so users see
// "sketch.ino:5:3: error: ..." instead of a /tmp/... prefix.
export const extractCompileErrors = (stderr: string): string[] => {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .filter((line) => /error|warning/i.test(line) && !/^Error during build/i.test(line))
    .map((line) => line.replace(/^.*?([\w-]+\.(?:ino|cpp|h))/, '$1').trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(0, 20);
};

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runProcess = (command: string, args: string[], options: Record<string, unknown> = {}): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
  });

// Repeat Runs of the same sketch skip arduino-cli entirely.
const CACHE_LIMIT = 32;
const hexCache = new Map<string, string>();

const cacheGet = (key: string): string | undefined => {
  const hit = hexCache.get(key);
  if (hit !== undefined) {
    // Refresh recency (Map iteration order is insertion order).
    hexCache.delete(key);
    hexCache.set(key, hit);
  }
  return hit;
};

const cachePut = (key: string, hex: string): void => {
  hexCache.set(key, hex);
  if (hexCache.size > CACHE_LIMIT) {
    hexCache.delete(hexCache.keys().next().value as string);
  }
};

export async function compileSketch({ code }: { code: string }): Promise<CompileResult> {
  const failure = (errors: string[], rawOutput = ''): CompileResult => ({
    ok: false, hex: '', errors, warnings: [], rawOutput,
  });
  if (!String(code || '').trim()) {
    return failure(['Sketch source is empty.']);
  }

  const hash = createHash('sha256').update(code).digest('hex');
  const cached = cacheGet(hash);
  if (cached !== undefined) {
    return { ok: true, hex: cached, errors: [], warnings: [], rawOutput: '(cached)' };
  }

  const workingDir = await mkdtemp(join(tmpdir(), 'prompt-to-pcb-ino-'));
  try {
    const sketchDir = join(workingDir, SKETCH_NAME);
    const outputDir = join(workingDir, 'build');
    await mkdir(sketchDir);
    await writeFile(join(sketchDir, `${SKETCH_NAME}.ino`), code, 'utf8');

    const command = getArduinoCliCommand();
    const result = await runProcess(command, buildCompileArgs(sketchDir, outputDir));
    const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (result.code !== 0) {
      if (isMissingCli(rawOutput)) {
        return failure([
          `arduino-cli was not found. Install it (winget install ArduinoSA.CLI on Windows), run "arduino-cli core install arduino:avr" once, and make sure ${command} is on PATH — see docs/OPERATIONS.md.`,
        ], rawOutput);
      }
      const errors = extractCompileErrors(result.stderr);
      return failure(errors.length ? errors : ['arduino-cli failed to compile the sketch.'], rawOutput);
    }

    let hex = '';
    try {
      // Application-only image (the .with_bootloader variant is for flashing).
      hex = await readFile(join(outputDir, `${SKETCH_NAME}.ino.hex`), 'utf8');
    } catch {
      return failure(['arduino-cli completed but produced no .hex artifact.'], rawOutput);
    }
    cachePut(hash, hex);
    return { ok: true, hex, errors: [], warnings: extractCompileErrors(result.stderr).filter((line) => /warning/i.test(line)), rawOutput };
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}
