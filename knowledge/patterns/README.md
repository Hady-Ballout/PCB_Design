# Patterns

Circuit building blocks that recur across requests, with the design equations
that size them.

A pattern is worth adding when you have built the same shape twice. Prefer
instantiating a pattern over inventing a topology: the equations here are
checked arithmetic, and free-form design gets less reliable as component count
grows.

| Pattern | Provides | Uses |
|---------|----------|------|
| [astable-555](astable-555.md) | Square wave, ~1 Hz to ~100 kHz | `timer_555` |

To add one, copy the frontmatter shape from `astable-555.md`: `pattern`,
`provides`, `uses`, `params`, `status`. Include worked numbers you have actually
verified, not a formula alone.
