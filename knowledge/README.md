# Knowledge base

What an agent reads to build a circuit for this repo. Plain markdown in folders,
scannable top-down: an index tells you what exists, and you open only the pages
you need.

```
knowledge/
  components/   one file per component kind, plus an index
  patterns/     reusable circuit blocks with design equations
  prompts/      task guides — read the one that matches what you are doing
```

## Start here

| Doing this | Read |
|------------|------|
| Building a circuit | [prompts/build-a-circuit.md](prompts/build-a-circuit.md) |
| Missing a part | [prompts/add-a-component.md](prompts/add-a-component.md) |
| Checking a board | [prompts/verify-a-board.md](prompts/verify-a-board.md) |
| Looking up a part | [components/README.md](components/README.md) |

## How component files work

Each file is YAML frontmatter plus prose, and the two have different standing:

- **Frontmatter is generated and authoritative.** `kind`, `pins`, `pin_order`,
  `spice_prefix` are derived from `src/core/componentKinds.js` and
  `src/core/topologyRules.js` by `scripts/build-component-docs.mjs`. A test
  fails if they drift. Trust them.
- **Prose is written by hand or by an agent.** It carries judgment the code
  cannot express — wiring rules, typical values, what goes wrong. It is never
  overwritten by the generator, and it is only as good as its last author.

Files still marked **STUB** have correct frontmatter and unwritten prose. The
pin order is trustworthy; the advice is absent.

This split exists because of a specific failure: the previous system kept
component knowledge in a hand-written prompt while the real contract lived in
code. Thirty-nine kinds had a pin-order contract; two were documented. Anything
checkable is now derived, so that gap cannot reopen.

## Regenerating

```bash
node scripts/build-component-docs.mjs          # after editing componentKinds.js
node scripts/build-component-docs.mjs --check  # CI: fails on drift
```

## Adding knowledge

Write it down when you learn it. A gotcha discovered while debugging is worth
more than a page of restated datasheet — it is the thing the next agent will
otherwise rediscover the hard way.

Verify before you write. Prose here is trusted, so a plausible-sounding claim
that happens to be wrong is worse than no claim. Run the code and check.
