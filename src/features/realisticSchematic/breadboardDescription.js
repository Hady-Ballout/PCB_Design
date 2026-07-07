// Plain-text debug description of a generated breadboard build. Turns the
// canonical `circuit` plus the placement `model` from breadboardModel.js into a
// human/AI-readable report: the intended netlist, the physical placement
// (rails, batteries, parts, jumpers), and a reconstructed-connectivity check
// that flags any net split across nodes or any node shorting two nets. Meant to
// be copied out and pasted into an AI to sanity-check the generated schematic.
// No React imports so it stays unit-testable.

import { GROUND_NET } from './breadboardModel.js';
import { TOP_STRIP_ROW_LETTERS, BOTTOM_STRIP_ROW_LETTERS } from './breadboardGeometry.js';
import { pinLabelsFor } from './selectionModel.js';

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

const netName = (net) => (net === GROUND_NET ? '0 (GND)' : String(net));

const RAIL_LABELS = {
  railTopPlus: 'TOP+ rail',
  railTopMinus: 'TOP- rail',
  railBottomPlus: 'BOT+ rail',
  railBottomMinus: 'BOT- rail',
};

// A breadboard-style hole address: "a5" (row letter + column) for terminal
// strips, "TOP+ rail col5" for the power rails.
const describeHole = (hole) => {
  if (!hole) return 'unplaced';
  if (RAIL_LABELS[hole.strip]) return `${RAIL_LABELS[hole.strip]} col${hole.column}`;
  const letters = hole.strip === 'top' ? TOP_STRIP_ROW_LETTERS : BOTTOM_STRIP_ROW_LETTERS;
  const rowLetter = letters[hole.row] ?? `row${hole.row}`;
  return `${rowLetter}${hole.column}`;
};

// Reconstruct electrical nodes from the physical board (tie groups + rails +
// jumpers) so we can diff the built board against the intended netlist. Mirrors
// the union-find used in breadboardModel.test.js.
const reconstructNodes = (model) => {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  const keyOf = (hole) =>
    hole.strip.startsWith('rail') ? `rail:${hole.strip}` : `${hole.strip}:${hole.column}`;
  (model.jumpers ?? []).forEach((jumper) => union(keyOf(jumper.from), keyOf(jumper.to)));
  return { find, keyOf };
};

const connectivityReport = (model) => {
  const { find, keyOf } = reconstructNodes(model);
  const netToNodes = new Map(); // net -> Set(node roots)
  const nodeToNets = new Map(); // node root -> Set(nets)
  (model.parts ?? []).forEach((part) => {
    (part.pinNets ?? []).forEach((net, index) => {
      if (isUnconnectedTerminal(net, part.ref, index + 1)) return;
      const hole = part.holes?.[index];
      if (!hole) return;
      const node = find(keyOf(hole));
      if (!netToNodes.has(net)) netToNodes.set(net, new Set());
      netToNodes.get(net).add(node);
      if (!nodeToNets.has(node)) nodeToNets.set(node, new Set());
      nodeToNets.get(node).add(net);
    });
  });

  const issues = [];
  netToNodes.forEach((nodes, net) => {
    if (nodes.size > 1) {
      issues.push(`SPLIT: net ${netName(net)} lands on ${nodes.size} unconnected nodes on the board.`);
    }
  });
  nodeToNets.forEach((nets) => {
    if (nets.size > 1) {
      issues.push(`SHORT: one board node carries multiple nets: ${[...nets].map(netName).join(', ')}.`);
    }
  });
  return issues;
};

export function describeBreadboard(circuit, model) {
  const components = circuit?.components ?? [];
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('BREADBOARD BUILD — DEBUG DESCRIPTION');
  push(`Title: ${circuit?.title ?? '(untitled)'}`);
  if (circuit?.supplyVoltage != null) push(`Supply voltage: ${circuit.supplyVoltage} V`);
  push(`Board: ${model?.board?.columns ?? '?'} columns (${Math.round(model?.board?.width ?? 0)}×${Math.round(model?.board?.height ?? 0)} px)`);
  push();

  push('== INTENDED NETLIST (source circuit) ==');
  components.forEach((component) => {
    const value = component.value ? ` ${component.value}` : '';
    push(`${component.ref}  ${component.kind}${value}  nodes: ${(component.nodes ?? []).join(', ')}`);
  });
  push();

  push('== NETS (pins that must share one electrical node) ==');
  const roleByNet = new Map((model?.nets ?? []).map((entry) => [entry.net, entry.role]));
  const pinsByNet = new Map();
  components.forEach((component) => {
    (component.nodes ?? []).forEach((net, index) => {
      if (isUnconnectedTerminal(net, component.ref, index + 1)) return;
      if (!pinsByNet.has(net)) pinsByNet.set(net, []);
      pinsByNet.get(net).push(`${component.ref}.${index + 1}`);
    });
  });
  [...pinsByNet.keys()].forEach((net) => {
    const role = roleByNet.get(net);
    push(`${netName(net)}${role ? ` [${role}]` : ''}: ${pinsByNet.get(net).join(', ')}`);
  });
  push();

  push('== BREADBOARD PLACEMENT ==');
  push('Power rails:');
  ['railTopPlus', 'railTopMinus', 'railBottomPlus', 'railBottomMinus'].forEach((key) => {
    const net = model?.rails?.[key];
    push(`  ${RAIL_LABELS[key]} = ${net != null ? netName(net) : '(unused)'}`);
  });
  push();

  push('Battery packs (off-board voltage sources):');
  if (!(model?.batteries?.length)) push('  (none)');
  (model?.batteries ?? []).forEach((battery) => {
    const value = battery.value ? ` ${battery.value}` : '';
    const plus = battery.plusHole ? `+ -> ${netName(battery.nets?.[0])} @ ${describeHole(battery.plusHole)}` : '+ (unconnected)';
    const minus = battery.minusHole ? `- -> ${netName(battery.nets?.[1])} @ ${describeHole(battery.minusHole)}` : '- (unconnected)';
    push(`  ${battery.ref}${value}: ${plus}; ${minus}`);
  });
  push();

  push('Parts:');
  if (!(model?.parts?.length)) push('  (none)');
  (model?.parts ?? []).forEach((part) => {
    const value = part.value ? ` ${part.value}` : '';
    push(`  ${part.ref}  ${part.kind}${value}  [${part.body}] on ${part.strip} strip`);
    const labels = pinLabelsFor(part);
    (part.pinNets ?? []).forEach((net, index) => {
      const label = labels?.[index] ? ` (${labels[index]})` : '';
      const hole = describeHole(part.holes?.[index]);
      if (isUnconnectedTerminal(net, part.ref, index + 1)) {
        push(`    pin${index + 1}${label}: not connected -> ${hole}`);
      } else {
        push(`    pin${index + 1}${label}: ${netName(net)} -> ${hole}`);
      }
    });
  });
  push();

  push('Jumper wires:');
  if (!(model?.jumpers?.length)) push('  (none)');
  (model?.jumpers ?? []).forEach((jumper) => {
    push(`  ${netName(jumper.net)}: ${describeHole(jumper.from)} -> ${describeHole(jumper.to)}`);
  });
  push();

  push('== CONNECTIVITY CHECK (rebuilt from holes + jumpers vs. netlist) ==');
  const issues = connectivityReport(model);
  if (!issues.length) {
    push('OK: every net is one connected node on the board and no node mixes nets.');
  } else {
    issues.forEach((issue) => push(issue));
  }
  push();

  push('== WARNINGS ==');
  if (!(model?.warnings?.length)) push('(none)');
  (model?.warnings ?? []).forEach((warning) => push(`- ${warning}`));

  return lines.join('\n');
}
