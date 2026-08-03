# Add a component

What to do when the part you need is not in
[../components/README.md](../components/README.md).

## First: is it really missing?

Search aliases before concluding it is absent — parts are often filed under a
generic name. `555` is `timer_555`, `LDR` is a `photoresistor`, `op-amp` is
`opamp`.

```bash
grep -ril "<the name you want>" knowledge/components/
```

## If it is genuinely missing

**Do not silently substitute a different part.** A circuit built around the wrong
IC looks correct and is not. You have two honest options.

### Option A — build it from parts that exist

Most missing ICs decompose. A missing comparator is an `opamp` wired open-loop;
a missing driver is a `bjt_npn` plus a base resistor and a flyback diode. Say in
your report that you did this and why.

### Option B — propose the component

Write `knowledge/components/<kind>.md` with `status: proposed`:

```yaml
---
kind: sn74hc14
label: "Hex Schmitt inverter"
category: analog-ic
pins: 14
pin_order: [1A, 1Y, 2A, 2Y, 3A, 3Y, GND, 4Y, 4A, 5Y, 5A, 6Y, 6A, VCC]
pin_order_source: proposed
spice_prefix: X
aliases: [74hc14, schmitt inverter]
status: proposed
---
```

Then write the same sections a `core` component has: pin contract, value,
wiring rules, worked example, gotchas.

**A `proposed` component is documentation, not a working part.** The validator
rejects any `kind` not in `src/core/componentKinds.js`, so a circuit using it
will fail. Proposing it records the need; it does not satisfy it. Say so
explicitly in your report rather than handing over a circuit that cannot build.

The generator never overwrites or deletes `proposed` files — it only manages
`status: core`. They accumulate safely until someone reviews them.

## Promoting a proposal to core

A human decision, not an agent one. It means editing
`src/core/componentKinds.js` (and `fixedPins` if the part has a pin contract),
adding footprint geometry, then rerunning:

```bash
node scripts/build-component-docs.mjs
```

which rewrites the frontmatter from the code and flips `status` to `core`,
leaving the prose intact.

## Why proposals are worth writing

They are the demand signal. A part proposed repeatedly across many requests is
one worth building properly; a part proposed once was probably a substitution
that should have been Option A. Neither is visible if you quietly work around
the gap.
