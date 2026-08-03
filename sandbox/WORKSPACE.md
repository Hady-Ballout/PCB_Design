# This workspace

Everything above is the domain procedure. This section is the environment it
runs in — where things are, what to produce, and when you are done.

## Where things are

```
CLAUDE.md            the procedure above
knowledge/           components, patterns, prompts   (read-only)
src/core/            the engine you verify against    (read-only)
verify.mjs           the five verdicts + pin table
solve.mjs            E24 component-value search
```

`node` is available and the engine needs no install — it is dependency-free.
There is no package manager, no network, and nothing outside this directory.
Do not try to install anything; it is not a permissions problem you can work
around, the dependencies genuinely are not needed.

## What to produce

Two files, in this directory:

- **`circuit.json`** — the circuit, exactly the shape CLAUDE.md specifies.
- **`report.md`** — what you built and the evidence. Achieved values with their
  error (`2.010 s (0.49% error)`, not "2 s"), the board size, component, trace
  and via counts, the five verdicts, and any assumption you made resolving the
  request.

## Verifying — use the tools, do not rewrite them

Step 7 of the procedure says to write a script and run it. That script already
exists here. Use it:

```bash
node verify.mjs circuit.json
```

It prints the five verdicts, then the **pin-assignment table** step 8 asks for,
then any structural findings. Exit code 0 means every gate passed.

State your intent as an assertion and it gets checked:

```bash
node verify.mjs circuit.json --assert 'U1.TRIG == U1.THRES' --assert 'U1.RESET == VCC'
```

This matters more than it looks. A 555 blinker wired as a one-shot passes
validate, topology, routing, DRC **and** connectivity — all five verdicts clean,
on a board that cannot blink. Nothing in the engine knows what you meant. The
assertion is the only place intent gets checked, so write the assertions that
would have caught your topology being wrong.

For step 4, search instead of hand-picking:

```bash
node solve.mjs 555-astable --period 2.0 --cap 100uF
node solve.mjs led-resistor --supply 9 --vf 2.0 --current 15mA --driver 555
node solve.mjs --help
```

Writing your own script is allowed when neither tool covers what you need —
that is what the engine being dependency-free is for.

## When you are done

You are done when `verify.mjs` prints `VERDICT: PASS`, and not before. If it
does not, read the actual error and fix the cause; a failing gate is
information, not an obstacle to route around.

Then **stop and summarize.** Do not keep polishing. The person who asked reviews
the board and may come back with changes, and this conversation continues from
where it stopped — so leave the workspace in the state you would want to resume
from.

If the request cannot be built with the parts that exist, say so plainly and
explain what is missing, rather than substituting something that merely
validates. `knowledge/prompts/add-a-component.md` covers that case.
