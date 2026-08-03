// The knowledge base must not drift from the engine.
//
// This is the regression test for the failure that motivated the whole
// directory: the old system documented component knowledge in a hand-written
// prompt while the real contract lived in src/core, and 37 of 39 pin-order
// contracts were missing from it. Frontmatter here is generated, so drift is a
// test failure rather than a silently wrong circuit.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_KINDS } from '../../src/core/componentKinds.js';
import { ROLE_PINS } from '../../src/core/topologyRules.js';

const dir = dirname(fileURLToPath(import.meta.url));

/** Minimal frontmatter reader — enough for the flat scalars/lists used here. */
const readDoc = (file) => {
  const text = readFileSync(resolve(dir, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw === 'null') meta[key] = null;
    else if (raw.startsWith('[')) meta[key] = raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean);
    else meta[key] = raw.replace(/^"|"$/g, '');
  }
  return { meta, body: match[2] };
};

const docFiles = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
const kinds = Object.keys(COMPONENT_KINDS);

describe('component knowledge base', () => {
  it('has a file for every kind the validator accepts', () => {
    const documented = new Set(docFiles.map((f) => f.replace(/\.md$/, '')));
    expect([...kinds].filter((kind) => !documented.has(kind))).toEqual([]);
  });

  it('has no file for a kind that does not exist, unless it is a proposal', () => {
    const known = new Set(kinds);
    const orphans = docFiles
      .map((file) => ({ file, doc: readDoc(file) }))
      .filter(({ file, doc }) => !known.has(file.replace(/\.md$/, '')) && doc?.meta.status !== 'proposed')
      .map(({ file }) => file);
    expect(orphans).toEqual([]);
  });

  it.each(kinds)('%s frontmatter matches the engine', (kind) => {
    const doc = readDoc(`${kind}.md`);
    expect(doc, `${kind}.md is missing or has malformed frontmatter`).toBeTruthy();

    const spec = COMPONENT_KINDS[kind];
    expect(doc.meta.kind).toBe(kind);
    expect(doc.meta.label).toBe(spec.label);
    expect(doc.meta.category).toBe(spec.category);
    expect(Number(doc.meta.pins)).toBe(spec.pins);
    expect(doc.meta.spice_prefix).toBe(spec.spicePrefix);
    expect(doc.meta.status).toBe('core');

    // The load-bearing field: the order net names must appear in `nodes`.
    const expected = spec.fixedPins || ROLE_PINS[kind] || null;
    expect(doc.meta.pin_order).toEqual(expected);
    if (expected) expect(doc.meta.pin_order).toHaveLength(spec.pins);
  });

  it('documents a pin order for every kind that has one', () => {
    const contracted = kinds.filter((kind) => COMPONENT_KINDS[kind].fixedPins || ROLE_PINS[kind]);
    const missing = contracted.filter((kind) => !readDoc(`${kind}.md`)?.meta.pin_order);
    expect(missing).toEqual([]);
    // Guards the regression directly: 2 of 39 documented is what went wrong.
    expect(contracted.length).toBeGreaterThan(35);
  });

  it('keeps the written pages written', () => {
    // These carry hand-verified prose. If one reverts to a stub the generator
    // has clobbered a body it was never supposed to touch.
    for (const kind of ['timer_555', 'led', 'resistor', 'capacitor', 'voltage_source']) {
      expect(readDoc(`${kind}.md`).body, `${kind}.md lost its prose`).not.toMatch(/\*\*STUB\*\*/);
    }
  });
});
