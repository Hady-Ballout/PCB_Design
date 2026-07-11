// Pure transform from the canonical `circuit` object into React Flow nodes/edges
// for the block-schematic view. No React imports so it stays unit-testable.

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

// Friendly, human-readable block titles keyed by component `kind`.
const KIND_LABELS = {
  resistor: 'Resistor',
  capacitor: 'Capacitor',
  inductor: 'Inductor',
  diode: 'Diode',
  led: 'LED',
  bjt_npn: 'NPN Transistor',
  bjt_pnp: 'PNP Transistor',
  mosfet_n: 'N-MOSFET',
  mosfet_p: 'P-MOSFET',
  opamp: 'Op-Amp',
  regulator: 'Regulator',
  voltage_source: 'Voltage Source',
  signal_source: 'Signal Source',
  load: 'Load',
  arduino_uno: 'Arduino Uno',
  raspberry_pi: 'Raspberry Pi',
  esp32: 'ESP32',
};

// Positional pin labels for parts with more than two pins. The ordering mirrors
// the convention baked into componentPinPoint (src/features/schematic/geometry.js).
const MULTI_PIN_LABELS = {
  opamp: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  bjt_npn: ['C', 'B', 'E'],
  bjt_pnp: ['C', 'B', 'E'],
  arduino_uno: ['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
  raspberry_pi: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22'],
  esp32: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
};

export const humanComponentName = (component) =>
  KIND_LABELS[component.kind] || String(component.kind || 'Component').replaceAll('_', ' ');

export const pinLabel = (component, pinIndex) => {
  const pinCount = component.nodes?.length ?? 0;
  if (pinCount <= 2) return pinIndex === 1 ? 'Positive' : 'Negative';
  const labels = MULTI_PIN_LABELS[component.kind];
  return labels?.[pinIndex - 1] || `Pin ${pinIndex}`;
};

// Lane palette: nets are colored by lane order (not by hash) so neighbouring
// wires always differ. The palette is arranged so consecutive entries contrast.
const LANE_COLORS = [
  '#e0533d', '#3ab4a8', '#d4943a', '#5b8def', '#c264d6',
  '#61c05b', '#e6a33e', '#4bb3d1', '#d15b8f', '#8a7de0',
];

export const laneColor = (laneIndex) => LANE_COLORS[laneIndex % LANE_COLORS.length];

// Two handles (source + target) share each pin's coordinate so an edge can attach
// in either direction to the same visual point.
export const pinHandleId = (ref, pinIndex, role) => `${ref}-${pinIndex}-${role}`;

// Ground (SPICE node '0') gets a dedicated symbol node instead of blending in as
// just another colored net, so it reads as ground at a glance.
export const GROUND_NODE_ID = '__GND__';
export const GROUND_PIN_INDEX = 1;

export function circuitToFlow(circuit, { includeGround = true } = {}) {
  const components = circuit?.components ?? [];

  const nodes = components.map((component, index) => ({
    id: component.ref,
    type: 'componentBlock',
    position: { x: 0, y: index * 220 },
    data: {
      title: humanComponentName(component),
      ref: component.ref,
      value: component.value,
      kind: component.kind,
      pins: (component.nodes ?? []).map((net, pinOffset) => {
        const pinIndex = pinOffset + 1;
        return {
          pinIndex,
          net,
          label: pinLabel(component, pinIndex),
          connected: !isUnconnectedTerminal(net, component.ref, pinIndex),
        };
      }),
    },
  }));

  // Group connected pins by net, then chain the members of each net into edges.
  const pinsByNet = new Map();
  components.forEach((component) => {
    (component.nodes ?? []).forEach((net, pinOffset) => {
      const pinIndex = pinOffset + 1;
      if (isUnconnectedTerminal(net, component.ref, pinIndex)) return;
      if (!includeGround && net === '0') return;
      if (!pinsByNet.has(net)) pinsByNet.set(net, []);
      pinsByNet.get(net).push({ ref: component.ref, pinIndex });
    });
  });

  const groundPins = pinsByNet.get('0') ?? [];
  if (groundPins.length > 0) {
    nodes.push({
      id: GROUND_NODE_ID,
      type: 'groundSymbol',
      position: { x: 0, y: components.length * 220 },
      data: {},
    });
  }

  const edges = [];
  let laneIndex = 0;
  pinsByNet.forEach((members, net) => {
    // Ground fans out in a star to the shared symbol instead of chaining pin to
    // pin, so every grounded pin gets a wire even when it's the net's only member.
    if (net === '0') {
      const lane = laneIndex;
      laneIndex += 1;
      const color = laneColor(lane);
      members.forEach((member) => {
        edges.push({
          id: `0-${member.ref}.${member.pinIndex}-GND`,
          type: 'bus',
          source: member.ref,
          sourceHandle: pinHandleId(member.ref, member.pinIndex, 's'),
          target: GROUND_NODE_ID,
          targetHandle: pinHandleId(GROUND_NODE_ID, GROUND_PIN_INDEX, 't'),
          data: { net, laneIndex: lane, color },
        });
      });
      return;
    }

    // Only nets that actually produce a wire consume a lane, keeping lane
    // indexes (and therefore colors) dense and contrasting.
    if (members.length < 2) return;
    const lane = laneIndex;
    laneIndex += 1;
    const color = laneColor(lane);
    for (let index = 1; index < members.length; index += 1) {
      const from = members[index - 1];
      const to = members[index];
      edges.push({
        id: `${net}-${from.ref}.${from.pinIndex}-${to.ref}.${to.pinIndex}`,
        type: 'bus',
        source: from.ref,
        sourceHandle: pinHandleId(from.ref, from.pinIndex, 's'),
        target: to.ref,
        targetHandle: pinHandleId(to.ref, to.pinIndex, 't'),
        data: { net, laneIndex: lane, color },
      });
    }
  });

  return { nodes, edges };
}
