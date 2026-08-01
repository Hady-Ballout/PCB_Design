// list_component_kinds — the contract Claude reads before authoring a circuit.
//
// Everything here derives from src/core/componentKinds.js, the same table the
// app's validator, SPICE exporter and canvas symbols use, so a kind added there
// shows up here with no extra work.

import { COMPONENT_KINDS, ALLOWED_KINDS } from '../../src/core/componentKinds.js';

export interface KindEntry {
  kind: string;
  label: string;
  pins: number;
  spicePrefix: string;
  /** Present only on the kinds that have one, to keep the unfiltered listing small. */
  hasFixedPinOrder?: true;
  /** The positional pin contract, returned when a caller asks for detail. */
  fixedPinOrder?: string[];
  /** Microcontroller board: carries firmware, drawn off-board. */
  mcu?: true;
  /** Never emitted into the SPICE deck (appears as a comment line instead). */
  wiringOnly?: true;
}

export interface ListComponentKindsArgs {
  kind?: string;
  includePinOrders?: boolean;
}

const CIRCUIT_SHAPE = {
  required: ['title', 'components'],
  groundNode: '0',
  component: {
    ref: 'Reference designator. Must start with the kind\'s spicePrefix (R1, C3, XU1, Q2, …).',
    kind: 'One of the kinds listed here.',
    value: 'Value string: "10k", "100nF", "5V", "LM358", "1N4148".',
    nodes: 'Net names in the kind\'s pin order. Ground is "0". Two parts sharing a net name are connected.',
  },
  optional: {
    type: 'Free-form category, defaults to "ai_generated".',
    supplyVoltage: 'Numeric rail voltage, defaults to 5.',
    notes: 'Array of design notes.',
    'schematic.externalTerminals': 'Named connection points: {net, label, type, side}.',
  },
  rules: [
    'Kinds with a fixedPinOrder are positional — list nodes in exactly that order, padding unused pins with a unique net name.',
    'Use voltage_source for DC rails and signal_source for AC/pulse stimulus.',
    'Op amps use the LM358 model by default; use kind "ua741" when the design calls for a 741.',
    'wiringOnly kinds (MCU boards, modules) are excluded from the SPICE deck.',
  ],
} as const;

const entryFor = (kind: string, withPinOrder: boolean): KindEntry => {
  const info = COMPONENT_KINDS[kind as keyof typeof COMPONENT_KINDS] as {
    spicePrefix: string; pins: number; label: string;
    fixedPins?: string[]; mcu?: boolean; wiringOnly?: boolean;
  };

  const entry: KindEntry = {
    kind,
    label: info.label,
    pins: info.pins,
    spicePrefix: info.spicePrefix,
  };

  if (info.fixedPins) {
    if (withPinOrder) entry.fixedPinOrder = [...info.fixedPins];
    else entry.hasFixedPinOrder = true;
  }
  if (info.mcu) entry.mcu = true;
  if (info.wiringOnly) entry.wiringOnly = true;

  return entry;
};

export const listComponentKinds = ({ kind, includePinOrders = false }: ListComponentKindsArgs) => {
  if (kind && !ALLOWED_KINDS.includes(kind)) {
    throw new Error(
      `Unknown component kind "${kind}". Call list_component_kinds with no arguments for the full table.`,
    );
  }

  // A single-kind request is a detail lookup, so it always carries the pin order.
  const kinds = kind
    ? [entryFor(kind, true)]
    : ALLOWED_KINDS.map((name) => entryFor(name, includePinOrders));

  return { kinds, circuitShape: CIRCUIT_SHAPE };
};
