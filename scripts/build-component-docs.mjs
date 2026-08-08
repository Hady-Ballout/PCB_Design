// Generates knowledge/components/<kind>.md from the engine's own tables.
//
// Why generate: the previous system kept the model's component knowledge in a
// hand-written prompt while the real contract lived in src/core. They drifted —
// 39 kinds had a pin-order contract in code and 2 were documented. Anything a
// validator can check is derived here instead of retyped, so it cannot drift.
//
// What is generated: the YAML frontmatter, and a stub body for files that do
// not exist yet. What is NOT generated: the body of a file that already exists.
// Prose written by a human or an agent survives every rerun — only the
// frontmatter is rewritten in place.
//
//   node scripts/build-component-docs.mjs          # write
//   node scripts/build-component-docs.mjs --check  # verify, exit 1 on drift
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_KINDS, COMPONENT_CATEGORIES } from '../src/core/componentKinds.js';
import { ROLE_PINS } from '../src/core/topologyRules.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'knowledge/components');
const checkOnly = process.argv.includes('--check');

const categoryTitle = Object.fromEntries(COMPONENT_CATEGORIES.map((c) => [c.id, c.title]));

/** Pin order for a kind, and where it came from — fixedPins wins, then ROLE_PINS. */
const pinOrderFor = (kind, spec) => {
  if (spec.fixedPins) return { order: spec.fixedPins, source: 'fixedPins' };
  if (ROLE_PINS[kind]) return { order: ROLE_PINS[kind], source: 'ROLE_PINS' };
  return { order: null, source: 'none' };
};

const yamlList = (values) => `[${values.map((v) => (/[:,#[\]{}]/.test(v) ? JSON.stringify(v) : v)).join(', ')}]`;

const frontmatterFor = (kind, spec) => {
  const { order, source } = pinOrderFor(kind, spec);
  const lines = [
    `kind: ${kind}`,
    `label: ${JSON.stringify(spec.label)}`,
    `category: ${spec.category}`,
    `pins: ${spec.pins}`,
  ];
  if (order) {
    lines.push(`pin_order: ${yamlList(order)}`);
    lines.push(`pin_order_source: ${source}`);
  } else {
    lines.push('pin_order: null');
    lines.push('pin_order_source: none');
  }
  lines.push(`spice_prefix: ${spec.spicePrefix}`);
  if (spec.aliases?.length) lines.push(`aliases: ${yamlList(spec.aliases)}`);
  if (spec.preferredValues?.length) lines.push(`preferred_values: ${yamlList(spec.preferredValues)}`);
  if (spec.mcu) lines.push('mcu: true');
  if (spec.wiringOnly) lines.push('wiring_only: true');
  // core = declared in src/core/componentKinds.js and accepted by the validator.
  // proposed = added by an agent, not yet a real kind. Never generated.
  lines.push('status: core');
  return lines;
};

const stubBody = (kind, spec) => {
  const { order } = pinOrderFor(kind, spec);
  const pinRows = order
    ? order.map((pin, i) => `| ${i + 1} | \`${pin}\` | TODO |`).join('\n')
    : Array.from({ length: spec.pins }, (_, i) => `| ${i + 1} | pin ${i + 1} | TODO |`).join('\n');
  return `
# ${spec.label}

> **STUB** — the frontmatter above is generated and authoritative. The prose
> below is not written yet. Fill it in when you use this part, then delete this
> callout: that is what flips the part to "written" in the index.

TODO: one sentence on what this part is and when to reach for it.

## Pin contract

\`nodes\` must list exactly ${spec.pins} net name${spec.pins === 1 ? '' : 's'}, in this order:

| # | Pin | Role |
|---|-----|------|
${pinRows}

Ground is \`"0"\`. For a pin you deliberately leave unconnected use
\`"NC_<REF>_<pinNumber>"\`.

## Value

TODO: what the \`value\` string means for this kind.

## Wiring rules

TODO: what must be true for this part to work.

## Worked example

TODO: a minimal component entry, copy-pasteable.

## Gotchas

TODO: what goes wrong most often.
`;
};

const render = (kind, spec, existingBody) => {
  const body = existingBody ?? stubBody(kind, spec);
  return `---\n${frontmatterFor(kind, spec).join('\n')}\n---\n${body}`;
};

/** Split a file into its frontmatter block and everything after it. */
const splitDoc = (text) => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return match ? { frontmatter: match[1], body: match[2] } : null;
};

mkdirSync(dir, { recursive: true });

const kinds = Object.entries(COMPONENT_KINDS).sort(([a], [b]) => a.localeCompare(b));
const drifted = [];
let created = 0;
let updated = 0;

for (const [kind, spec] of kinds) {
  const file = resolve(dir, `${kind}.md`);
  const existing = existsSync(file) ? splitDoc(readFileSync(file, 'utf8')) : null;
  const next = render(kind, spec, existing?.body);
  const current = existing ? `---\n${existing.frontmatter}\n---\n${existing.body}` : null;
  if (current === next) continue;
  if (checkOnly) { drifted.push(`${kind}.md`); continue; }
  writeFileSync(file, next);
  if (existing) updated += 1; else created += 1;
}

// Index: one line per component so an agent can scan 69 parts without opening
// 69 files — the same reason a memory directory carries a flat index.
const indexRows = kinds.map(([kind, spec]) => {
  const { order } = pinOrderFor(kind, spec);
  const file = resolve(dir, `${kind}.md`);
  const parsed = existsSync(file) ? splitDoc(readFileSync(file, 'utf8')) : null;
  const written = parsed ? !/> \*\*STUB\*\*/.test(parsed.body) : false;
  // "no contract" is the honest label: the engine declares no order for these.
  // Some still care (voltage_source reads nodes[0] as the rail) — that lives in
  // the component's own file, because only prose can carry it.
  const pinCell = order ? `\`${order.join(', ')}\`` : `${spec.pins} pins, no contract`;
  return `| [\`${kind}\`](${kind}.md) | ${spec.label} | ${categoryTitle[spec.category] || spec.category} | ${pinCell} | ${written ? '✅' : '—'} |`;
});

const index = `# Components

Every component kind the circuit validator accepts. One file per kind.

**\`kind\` and \`pin_order\` are the two facts that must be right.** \`kind\` is the
exact string that goes in the JSON; \`pin_order\` is the order net names must
appear in that component's \`nodes\` array. Both are generated from
\`src/core/componentKinds.js\` and \`src/core/topologyRules.js\`, so they cannot
drift from what the code accepts.

Regenerate after changing either source file:

\`\`\`bash
node scripts/build-component-docs.mjs
\`\`\`

- **Written ✅** — the prose has been filled in and reviewed.
- **Written —** — frontmatter is correct, but the prose is still a stub. The
  pin order is still trustworthy; the wiring advice is not there yet.

To add a component that does not exist yet, see
[../prompts/add-a-component.md](../prompts/add-a-component.md).

| Kind | Label | Category | Pin order | Written |
|------|-------|----------|-----------|---------|
${indexRows.join('\n')}

${kinds.length} kinds.
`;

const indexFile = resolve(dir, 'README.md');
if (checkOnly) {
  if (!existsSync(indexFile) || readFileSync(indexFile, 'utf8') !== index) drifted.push('README.md');
  if (drifted.length) {
    console.error(`Component docs are out of date (${drifted.length}): ${drifted.slice(0, 10).join(', ')}`);
    console.error('Run: node scripts/build-component-docs.mjs');
    process.exit(1);
  }
  console.log(`Component docs are up to date (${kinds.length} kinds).`);
} else {
  writeFileSync(indexFile, index);
  console.log(`${kinds.length} kinds — ${created} created, ${updated} frontmatter updated, index written.`);
}
