// Pure selection/highlight logic for the realistic-schematic view. Given the
// breadboard placement model and a selection ({type:'part', ref} or
// {type:'net', net}), computes everything the renderer should light up.
// No React imports so it stays unit-testable.

import { FIXED_PIN_NAMES } from '../../core/componentKinds.js';
import { formatSI } from '../../core/sim/simObservables.js';
import { GROUND_NET } from './breadboardModel.js';
import { capStyle } from './partVisuals.js';

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

// Positional pin labels shown while a part is selected. Kinds with a fixedPins
// contract (sensor modules, MCU boards, DIP ICs, 7-segment) come straight from
// the registry; the manual entries below cover kinds whose canonical order is
// only spelled out in the SPICE exporter (src/core/pcbGenerator.js). BJT order
// matches the canonical [C, B, E]; MOSFET matches the SPICE M-line [D, G, S]
// (src/core/circuitSync.js parses "drain, gate, source"); potentiometer pin 2
// is the wiper and switch_spdt pin 2 the common, per their compound SPICE
// images.
const PIN_LABELS = {
  ...FIXED_PIN_NAMES,
  opamp: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  comparator: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  bjt_npn: ['C', 'B', 'E'],
  bjt_pnp: ['C', 'B', 'E'],
  mosfet_n: ['D', 'G', 'S'],
  mosfet_p: ['D', 'G', 'S'],
  led: ['A', 'K'],
  diode: ['A', 'K'],
  zener: ['A', 'K'],
  schottky: ['A', 'K'],
  buzzer: ['+', '−'],
  dc_motor: ['+', '−'],
  vibration_motor: ['+', '−'],
  solar_panel: ['+', '−'],
  potentiometer: ['A', 'W', 'B'],
  switch_spdt: ['A', 'COM', 'B'],
  rgb_led: ['R', 'G', 'B', 'K'],
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

// Voltage → color for the run-mode voltage overlay: hue 220 (blue, 0 V) ramps
// to 0 (red, vMax); negative voltages clamp to deep blue.
export const voltageColor = (volts, vMax) => {
  const t = Math.min(1, Math.max(0, volts / Math.max(vMax, 1e-9)));
  return `hsl(${Math.round(220 - 220 * t)}, 85%, 52%)`;
};

// Carrier map for the live voltage overlay: every tie group and rail stripe
// tinted by its net's simulated voltage. Same shape HighlightOverlay renders,
// but with explicit per-carrier colors instead of net-legend lookups.
export function voltageOverlayFor(model, netVoltages) {
  const overlay = {
    active: false,
    partRefs: new Set(),
    jumperIds: new Set(),
    nets: new Set(),
    railStrips: new Set(),
    groupKeys: new Set(),
    batteryRefs: new Set(),
    groupKeyNets: new Map(),
    railStripNets: new Map(),
    groupKeyColors: new Map(),
    railStripColors: new Map(),
  };
  if (!model || !netVoltages) return overlay;
  let vMax = 1;
  for (const [, volts] of netVoltages) vMax = Math.max(vMax, Math.abs(volts));
  Object.entries(model.netGroups ?? {}).forEach(([net, cells]) => {
    if (!netVoltages.has(net)) return;
    const color = voltageColor(netVoltages.get(net), vMax);
    cells.forEach(({ strip, column }) => {
      const key = `${strip}:${column}`;
      overlay.groupKeys.add(key);
      overlay.groupKeyNets.set(key, net);
      overlay.groupKeyColors.set(key, color);
    });
  });
  Object.entries(model.rails ?? {}).forEach(([strip, net]) => {
    if (net == null || !netVoltages.has(net)) return;
    overlay.railStrips.add(strip);
    overlay.railStripNets.set(strip, net);
    overlay.railStripColors.set(strip, voltageColor(netVoltages.get(net), vMax));
  });
  overlay.active = overlay.groupKeys.size > 0 || overlay.railStrips.size > 0;
  return overlay;
}

// Live measurements appended to the readout while the simulation runs.
const liveSuffixFor = (selection, simFrame) => {
  if (!simFrame) return '';
  if (selection.type === 'net') {
    const volts = simFrame.netVoltages?.get?.(selection.net);
    return volts === undefined ? '' : ` · ${formatSI(volts, 'V')}`;
  }
  const observable = simFrame.observables?.get?.(selection.ref);
  if (!observable) return '';
  const parts = [];
  if (typeof observable.volts === 'number') parts.push(formatSI(observable.volts, 'V'));
  if (typeof observable.amps === 'number') parts.push(formatSI(observable.amps, 'A'));
  // Free-text observables (e.g. the RTC's rolling clock).
  if (typeof observable.text === 'string' && observable.text) parts.push(observable.text);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
};

// One-line toolbar description of the current selection. Pass the running
// simulation's frame as the optional third argument to append live values.
export function readoutFor(model, selection, simFrame = null) {
  if (!model || !selection) return null;
  if (selection.type === 'part') {
    const part = model.parts.find((candidate) => candidate.ref === selection.ref);
    if (part) {
      const kind = String(part.kind || 'part').replaceAll('_', ' ');
      const base = part.value ? `${part.ref} · ${kind} · ${part.value}` : `${part.ref} · ${kind}`;
      return `${base}${liveSuffixFor(selection, simFrame)}`;
    }
    const battery = model.batteries.find((candidate) => candidate.ref === selection.ref);
    if (battery) {
      return `${`${battery.ref} · voltage source · ${battery.value ?? ''}`.trim()}${liveSuffixFor(selection, simFrame)}`;
    }
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
    return `net ${netDisplayName(selection.net)} · ${pins} pin${pins === 1 ? '' : 's'}${liveSuffixFor(selection, simFrame)}`;
  }
  return null;
}
