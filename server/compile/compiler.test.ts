import { describe, expect, it } from 'vitest';
import { buildCompileArgs, extractCompileErrors, isMissingCli, SKETCH_NAME } from './compiler.js';

describe('buildCompileArgs', () => {
  it('targets the Uno and the output dir', () => {
    expect(buildCompileArgs('/tmp/x/sketch', '/tmp/x/build')).toEqual([
      'compile', '--fqbn', 'arduino:avr:uno', '--output-dir', '/tmp/x/build', '/tmp/x/sketch',
    ]);
  });

  it('keeps the folder-equals-ino contract discoverable', () => {
    expect(SKETCH_NAME).toBe('sketch');
  });
});

describe('extractCompileErrors', () => {
  it('strips temp-dir prefixes from avr-gcc diagnostics', () => {
    const stderr = [
      'C:\\Users\\x\\AppData\\Local\\Temp\\prompt-to-pcb-ino-abc\\sketch\\sketch.ino:5:3: error: expected \';\' before \'}\' token',
      '/tmp/prompt-to-pcb-ino-xyz/sketch/sketch.ino:9:1: warning: unused variable [-Wunused]',
      'Error during build: exit status 1',
    ].join('\n');
    const errors = extractCompileErrors(stderr);
    expect(errors).toContain("sketch.ino:5:3: error: expected ';' before '}' token");
    expect(errors).toContain('sketch.ino:9:1: warning: unused variable [-Wunused]');
    expect(errors.some((line) => /Error during build/.test(line))).toBe(false);
  });

  it('dedupes and caps the list', () => {
    const line = 'sketch.ino:1:1: error: boom';
    const errors = extractCompileErrors(Array.from({ length: 40 }, () => line).join('\n'));
    expect(errors).toEqual([line]);
  });
});

describe('isMissingCli', () => {
  it('recognizes the platform not-found messages', () => {
    expect(isMissingCli('spawn arduino-cli ENOENT')).toBe(true);
    expect(isMissingCli("'arduino-cli' is not recognized as an internal or external command")).toBe(true);
    expect(isMissingCli('arduino-cli: not found')).toBe(true);
    expect(isMissingCli('sketch.ino:1:1: error: boom')).toBe(false);
  });
});
