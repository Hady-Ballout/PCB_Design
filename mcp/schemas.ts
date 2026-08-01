// Input schemas for the MCP tools. Every tool that accepts a circuit runs it
// through `circuitSchema` first, so malformed input fails with a precise zod
// message instead of throwing somewhere inside src/core.
//
// The schema is deliberately forgiving about the fields a caller would have to
// guess at (footprint, notes, nodes, type) and strict about the ones that carry
// electrical meaning (kind, nodes membership).

import { z } from 'zod';
import { ALLOWED_KINDS } from '../src/core/componentKinds.js';

// Deliberately a refinement rather than z.enum: the registry has ~70 kinds, and
// an enum would inline all of them into every tool's JSON schema (paid for on
// every request) and into every validation error. A short message that names the
// offending kind and points at list_component_kinds is cheaper and clearer.
const KIND_SET = new Set(ALLOWED_KINDS);

const kindSchema = z.string()
  .describe('Component kind from the registry — call list_component_kinds for the full table.')
  .superRefine((kind, ctx) => {
    if (KIND_SET.has(kind)) return;
    ctx.addIssue({
      code: 'custom',
      message: `Unknown component kind "${kind}". Call list_component_kinds for the supported table.`,
    });
  });

export const componentSchema = z.object({
  ref: z.string().min(1).describe('Reference designator, e.g. R1. Must use the kind\'s SPICE prefix.'),
  kind: kindSchema,
  value: z.string().min(1).describe('Component value, e.g. "10k", "100nF", "5V", "LM358".'),
  nodes: z.array(z.string().min(1)).min(1)
    .describe('Net names this part connects to, in the kind\'s pin order. Ground is "0".'),
  footprint: z.string().default(''),
  order: z.number().optional(),
});

const externalTerminalSchema = z.object({
  net: z.string(),
  label: z.string().default(''),
  type: z.string().default(''),
  side: z.string().default(''),
  explicit: z.boolean().optional(),
});

const schematicHintsSchema = z.object({
  externalTerminals: z.array(externalTerminalSchema).optional(),
  netRoles: z.array(z.object({ net: z.string(), role: z.string(), side: z.string().default('') })).optional(),
  componentRoles: z.array(z.object({ ref: z.string(), role: z.string() })).optional(),
}).passthrough();

/**
 * Upper bound on circuit size. Comfortably above any real design the engine is
 * meant for, and low enough that a hostile caller can't drive the layout router
 * or ngspice into a pathological run on the hosted endpoint.
 */
export const MAX_COMPONENTS = 200;

export const circuitSchema = z.object({
  title: z.string().min(1).describe('Short human-readable name for the design.'),
  type: z.string().default('ai_generated'),
  supplyVoltage: z.number().default(5),
  nodes: z.array(z.string()).optional(),
  components: z.array(componentSchema)
    .min(1)
    .max(MAX_COMPONENTS, `A circuit may contain at most ${MAX_COMPONENTS} components.`),
  notes: z.array(z.string()).default([]),
  schematic: schematicHintsSchema.optional(),
}).transform((circuit) => ({
  ...circuit,
  // src/core walks `nodes` in a few places but every caller inside the app
  // derives it from the components, so do the same rather than making the
  // model repeat itself.
  nodes: circuit.nodes?.length
    ? circuit.nodes
    : [...new Set(circuit.components.flatMap((part) => part.nodes))],
}));

export type CircuitInput = z.input<typeof circuitSchema>;
export type ParsedCircuit = z.output<typeof circuitSchema>;
