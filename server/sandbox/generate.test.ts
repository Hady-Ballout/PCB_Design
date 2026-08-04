// The progress readout is the only window into a run that takes two minutes, so
// what it says matters. It must describe the work, not the plumbing: a file path
// tells the person waiting how the knowledge base is laid out, which is not
// something they asked to know.
import { describe, expect, it } from 'vitest';
import { summarizeTool } from './generate.js';

const ROOT = '/repo/sandbox/runs/2026-08-04-a1b2';

describe('progress lines', () => {
  it('names components from the engine, not from the filename', () => {
    // The label table is the engine's own, so "555 timer" and the parenthesised
    // part numbers come out right without a second list to keep in sync.
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/voltage_source.md` }, ROOT))
      .toBe('Exploring Voltage source');
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/timer_555.md` }, ROOT))
      .toBe('Exploring 555 timer');
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/baro_sensor.md` }, ROOT))
      .toBe('Exploring Barometric sensor (BMP280, I2C)');
  });

  it('falls back to the kind when a page has no label', () => {
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/not_a_kind.md` }, ROOT))
      .toBe('Exploring not a kind');
  });

  it('describes indexes and patterns in their own terms', () => {
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/README.md` }, ROOT))
      .toBe('Browsing the component index');
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/patterns/README.md` }, ROOT))
      .toBe('Looking for a matching pattern');
    expect(summarizeTool('Read', { file_path: `${ROOT}/knowledge/patterns/astable-555.md` }, ROOT))
      .toBe('Studying the astable 555 pattern');
  });

  it('describes the run\'s own files as work, not as writes', () => {
    expect(summarizeTool('Write', { file_path: `${ROOT}/circuit.json` }, ROOT)).toBe('Drafting the circuit');
    expect(summarizeTool('Write', { file_path: `${ROOT}/report.md` }, ROOT)).toBe('Writing up the result');
    expect(summarizeTool('Read', { file_path: `${ROOT}/circuit.json` }, ROOT)).toBe('Reviewing the circuit');
  });

  it('recognises the tools the agent runs through bash', () => {
    expect(summarizeTool('Bash', { command: 'node verify.mjs circuit.json' })).toBe('Checking the board');
    expect(summarizeTool('Bash', { command: 'node solve.mjs 555-astable --period 2' }))
      .toBe('Solving component values');
    // It reads reference pages with `cat` as often as with the Read tool.
    expect(summarizeTool('Bash', { command: 'cat knowledge/components/led.md' })).toBe('Exploring LED');
  });

  it('never leaks a raw command or a path into the readout', () => {
    // The agent writes multi-line node scripts; a newline broke the layout and
    // the source itself is meaningless to the reader.
    const script = summarizeTool('Bash', { command: 'node -e "\nconst E24 = [1.0,1.1];\nconsole.log(E24)\n"' });
    expect(script).toBe('Working through the arithmetic');
    expect(script).not.toContain('\n');

    // A run id in the path was the specific leak: "2026-08-04-a1b2/circuit.json".
    for (const line of [
      summarizeTool('Write', { file_path: `${ROOT}/circuit.json` }, ROOT),
      summarizeTool('Read', { file_path: `${ROOT}/knowledge/components/led.md` }, ROOT),
      summarizeTool('Bash', { command: 'ls -la /repo/sandbox/runs' }),
    ]) {
      expect(line).not.toMatch(/2026-08-04-a1b2|\.md|\.json|\//);
    }
  });

  it('never shows a tool name', () => {
    // "TaskUpdate" appeared as a progress line: the agent keeps a todo list, and
    // the bookkeeping tool's name is internal vocabulary, not an update.
    expect(summarizeTool('TodoWrite', {})).toBe('Planning the next step');
    expect(summarizeTool('TaskUpdate', {})).toBe('Planning the next step');
    expect(summarizeTool('SomeToolAddedLater', {})).toBe('Working');
  });

  it('keeps the engine and the brief vague on purpose', () => {
    expect(summarizeTool('Read', { file_path: `${ROOT}/src/core/topologyRules.js` }, ROOT))
      .toBe('Consulting the design rules');
    expect(summarizeTool('Read', { file_path: `${ROOT}/CLAUDE.md` }, ROOT)).toBe('Re-reading the brief');
  });
});
