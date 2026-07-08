// Pure selection/highlight logic for the realistic-schematic view. Given the
// breadboard placement model and a selection ({type:'part', ref} or
// {type:'net', net}), computes everything the renderer should light up.
// No React imports so it stays unit-testable.

import { GROUND_NET, MCU_PINS } from './breadboardModel.js';
import { capStyle } from './partVisuals.js';

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

// Positional pin labels shown while a part is selected. BJT order matches the
// canonical [C, B, E]; MOSFET matches the SPICE M-line [D, G, S]
// (src/core/circuitSync.js parses "drain, gate, source").
const PIN_LABELS = {
  opamp: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  bjt_npn: ['C', 'B', 'E'],
  bjt_pnp: ['C', 'B', 'E'],
  mosfet_n: ['D', 'G', 'S'],
  mosfet_p: ['D', 'G', 'S'],
  led: ['A', 'K'],
  diode: ['A', 'K'],
  ...MCU_PINS,
};

// Labels for a part's pins, or null when labels would add nothing (plain
// two-lead passives, modules with numbered pins).
export const pinLabelsFor = (part) => {
  if (PIN_LABELS[part.kind]) return PIN_LABELS[part.kind];
  if (part.kind === 'capacitor' && capStyle(part.value).type === 'electrolytic') return ['+', '−'];
  return null;
};

const connectedNetsOf = (part) =>
  (part.pinNets ?? []).filter((net, index) => !isUnconnectedTerminal(net, part.ref, index + 1));

const emptyHighlight = () => ({
  active: false,
  partRefs: new Set(),
  jumperIds: new Set(),
  nets: new Set(),
  railStrips: new Set(),
  groupKeys: new Set(),
  batteryRefs: new Set(),
  // Net identity per lit carrier, so the overlay can tint each tie group /
  // rail stripe with its net's legend color instead of one uniform yellow.
  groupKeyNets: new Map(),
  railStripNets: new Map(),
});

// Everything to light up for a selection. A part lights itself plus the full
// electrical neighborhood of its pins (nets, jumpers, tie groups, rails,
// feeding batteries) — neighbor parts stay dimmed. A net lights all of its
// carriers including the parts with a pin on it.
export function highlightFor(model, selection) {
  const highlight = emptyHighlight();
  if (!model || !selection) return highlight;

  if (selection.type === 'part') {
    const part = model.parts.find((candidate) => candidate.ref === selection.ref);
    const battery = model.batteries.find((candidate) => candidate.ref === selection.ref);
    if (!part && !battery) return highlight;
    highlight.partRefs.add(selection.ref);
    const nets = part ? connectedNetsOf(part) : (battery.nets ?? []).filter((net) => net != null);
    nets.forEach((net) => highlight.nets.add(net));
  } else if (selection.type === 'net') {
    highlight.nets.add(selection.net);
    model.parts.forEach((part) => {
      if (connectedNetsOf(part).includes(selection.net)) highlight.partRefs.add(part.ref);
    });
  } else {
    return highlight;
  }

  highlight.active = true;
  model.jumpers.forEach((jumper) => {
    if (highlight.nets.has(jumper.net)) highlight.jumperIds.add(jumper.id);
  });
  Object.entries(model.rails).forEach(([strip, net]) => {
    if (net != null && highlight.nets.has(net)) {
      highlight.railStrips.add(strip);
      highlight.railStripNets.set(strip, net);
    }
  });
  highlight.nets.forEach((net) => {
    (model.netGroups[net] ?? []).forEach(({ strip, column }) => {
      highlight.groupKeys.add(`${strip}:${column}`);
      highlight.groupKeyNets.set(`${strip}:${column}`, net);
    });
  });
  model.batteries.forEach((battery) => {
    if ((battery.nets ?? []).some((net) => net != null && highlight.nets.has(net))) {
      highlight.batteryRefs.add(battery.ref);
    }
  });
  return highlight;
}

const netDisplayName = (net) => (net === GROUND_NET ? 'GND' : net);

// One-line toolbar description of the current selection.
export function readoutFor(model, selection) {
  if (!model || !selection) return null;
  if (selection.type === 'part') {
    const part = model.parts.find((candidate) => candidate.ref === selection.ref);
    if (part) {
      const kind = String(part.kind || 'part').replaceAll('_', ' ');
      return part.value ? `${part.ref} · ${kind} · ${part.value}` : `${part.ref} · ${kind}`;
    }
    const battery = model.batteries.find((candidate) => candidate.ref === selection.ref);
    if (battery) return `${battery.ref} · voltage source · ${battery.value ?? ''}`.trim();
    return null;
  }
  if (selection.type === 'net') {
    let pins = 0;
    model.parts.forEach((part) => {
      pins += connectedNetsOf(part).filter((net) => net === selection.net).length;
    });
    model.batteries.forEach((battery) => {
      pins += (battery.nets ?? []).filter((net) => net === selection.net).length;
    });
    return `net ${netDisplayName(selection.net)} · ${pins} pin${pins === 1 ? '' : 's'}`;
  }
  return null;
}
