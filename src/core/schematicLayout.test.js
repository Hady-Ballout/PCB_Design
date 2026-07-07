import { describe, expect, it } from 'vitest';
import {
  DiagramLayoutError,
  LAYOUT_VERSION,
  buildFallbackCircuitDiagram,
  findNearestLegalPlacement,
  layoutCircuitDiagram,
  repairDiagramLayout,
  rerouteAffectedNets,
  slotCenter,
  slotRects,
  validateDiagramLayout,
} from './schematicLayout.js';

const circuit = (title, components) => ({ title, type: 'test', supplyVoltage: 5, components, notes: [] });

const schematicSlotCenters = (layout) => slotRects(layout.rows, layout.cols).map(slotCenter);

const fixtures = [
  circuit('RC filter', [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'OUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['OUT', '0'] },
  ]),
  circuit('Voltage divider', [
    { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '7.5k', nodes: ['VCC', 'OUT'] },
    { ref: 'R2', kind: 'resistor', value: '2.7k', nodes: ['OUT', '0'] },
    { ref: 'RL', kind: 'load', value: '10k', nodes: ['OUT', '0'] },
  ]),
  circuit('Op amp feedback', [
    { ref: 'V1', kind: 'signal_source', value: 'SINE(0 1 1k)', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', 'NIN'] },
    { ref: 'R2', kind: 'resistor', value: '100k', nodes: ['OUT', 'NIN'] },
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['0', 'NIN', 'OUT', 'VCC', '0'] },
    { ref: 'VCC', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'RL', kind: 'load', value: '10k', nodes: ['OUT', '0'] },
  ]),
  circuit('Transistor switch', [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LOAD', 'BASE', '0'] },
    { ref: 'D1', kind: 'led', value: 'red', nodes: ['VCC', 'LOAD'] },
  ]),
  circuit('Dense shared nets', [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    ...Array.from({ length: 8 }, (_, index) => ({
      ref: `R${index + 1}`,
      kind: 'load',
      value: `${index + 1}k`,
      nodes: ['VCC', '0'],
    })),
  ]),
];

const differenceAmplifier = circuit('Difference Amplifier', [
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
  { ref: 'V2', kind: 'voltage_source', value: '2.5V', nodes: ['VBIAS', '0'] },
  { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VINP', 'OPP'] },
  { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['OPP', 'VBIAS'] },
  { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['VINN', 'OPN'] },
  { ref: 'R4', kind: 'resistor', value: '10k', nodes: ['OPN', 'VBIAS'] },
  { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['OPP', 'OPN', 'VOUT', 'VCC', '0'] },
  { ref: 'RLOAD', kind: 'load', value: '10k', nodes: ['VOUT', '0'] },
]);

const testPathSegments = (points) => points.slice(1).map((point, index) => ({ from: points[index], to: point }));
const testPointOnSegment = (point, segment) => (
  segment.from.x === segment.to.x
    ? point.x === segment.from.x
      && point.y >= Math.min(segment.from.y, segment.to.y)
      && point.y <= Math.max(segment.from.y, segment.to.y)
    : point.y === segment.from.y
      && point.x >= Math.min(segment.from.x, segment.to.x)
      && point.x <= Math.max(segment.from.x, segment.to.x)
);
const testSegmentsTouch = (first, second) =>
  [first.from, first.to].some((point) => testPointOnSegment(point, second))
  || [second.from, second.to].some((point) => testPointOnSegment(point, first));

const expectNodePhysicallyConnected = (diagram, node) => {
  const wires = diagram.wires.filter((wire) => wire.node === node);
  expect(wires.length).toBeGreaterThan(1);
  const visited = new Set([wires[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const wire of wires) {
      if (visited.has(wire.id)) continue;
      const touchesVisited = wires
        .filter((other) => visited.has(other.id))
        .some((other) => testPathSegments(wire.points).some((segment) =>
          testPathSegments(other.points).some((otherSegment) => testSegmentsTouch(segment, otherSegment))));
      if (touchesVisited) {
        visited.add(wire.id);
        changed = true;
      }
    }
  }
  expect(visited.size).toBe(wires.length);
};

describe('schematic layout engine', () => {
  it.each(fixtures)('produces a valid deterministic layout for $title', (fixture) => {
    const first = layoutCircuitDiagram(fixture);
    const second = layoutCircuitDiagram(fixture);

    expect(first.layoutVersion).toBe(LAYOUT_VERSION);
    expect(validateDiagramLayout(first)).toEqual({ ok: true, violations: [] });
    expect(second).toEqual(first);
  });

  it('places every component on a slot center in slot mode', () => {
    for (const fixture of [fixtures[0], differenceAmplifier]) {
      const diagram = layoutCircuitDiagram(fixture, { slots: true });
      expect(diagram.slotLayout).toBeTruthy();
      const centers = new Set(
        schematicSlotCenters(diagram.slotLayout).map((center) => `${center.x}:${center.y}`),
      );
      for (const component of diagram.components) {
        expect(centers.has(`${component.x}:${component.y}`)).toBe(true);
      }
      expect(validateDiagramLayout(diagram)).toEqual({ ok: true, violations: [] });
    }
  });

  it('grows slot rows to hold more components than a single grid page', () => {
    const many = circuit('Many loads', [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      ...Array.from({ length: 13 }, (_, index) => ({
        ref: `R${index + 1}`,
        kind: 'load',
        value: `${index + 1}k`,
        nodes: ['VCC', '0'],
      })),
    ]);
    const small = layoutCircuitDiagram(fixtures[0], { slots: true });
    const large = layoutCircuitDiagram(many, { slots: true });
    expect(large.slotLayout.rows).toBeGreaterThan(small.slotLayout.rows);
    expect(large.slotLayout.rows * large.slotLayout.cols).toBeGreaterThanOrEqual(14);
  });

  it('reports typed body, clearance, crossing, and bounds violations', () => {
    const invalid = {
      width: 300,
      height: 220,
      components: [
        { ref: 'A', x: 80, y: 80, width: 80, height: 50, pins: [] },
        { ref: 'B', x: 100, y: 80, width: 80, height: 50, pins: [] },
        { ref: 'C', x: 210, y: 80, width: 80, height: 50, pins: [] },
        { ref: 'D', x: 306, y: 80, width: 80, height: 50, pins: [] },
      ],
      labels: [],
      nets: [],
      bridges: [],
      wires: [
        { id: 'horizontal', node: 'A', points: [{ x: 20, y: 170 }, { x: 280, y: 170 }] },
        { id: 'vertical', node: 'B', points: [{ x: 150, y: 130 }, { x: 150, y: 210 }] },
      ],
    };
    const types = validateDiagramLayout(invalid).violations.map((violation) => violation.type);

    expect(types).toContain('body_collision');
    expect(types).toContain('insufficient_clearance');
    expect(types).toContain('wire_wire_intersection');
    expect(types).toContain('out_of_bounds');
  });

  it('validates crossings and routes shared nets as physical wire groups', () => {
    const crossed = {
      width: 300,
      height: 220,
      components: [],
      labels: [],
      nets: [],
      wires: [
        { id: 'horizontal', node: 'A', points: [{ x: 20, y: 100 }, { x: 280, y: 100 }] },
        { id: 'vertical', node: 'B', points: [{ x: 150, y: 20 }, { x: 150, y: 200 }] },
      ],
      bridges: [{ wireId: 'vertical', x: 150, y: 100, orientation: 'vertical', radius: 7 }],
      junctions: [],
    };
    const unbridged = { ...crossed, bridges: [] };
    expect(validateDiagramLayout(unbridged).violations).toContainEqual({
      type: 'wire_wire_intersection',
      wires: ['vertical', 'horizontal'],
    });
    expect(validateDiagramLayout(crossed).violations).not.toContainEqual({
      type: 'wire_wire_intersection',
      wires: ['vertical', 'horizontal'],
    });

    const dense = layoutCircuitDiagram(fixtures.at(-1));
    expect(dense.junctions.length).toBeGreaterThan(0);
    expect(dense.netLabels).toHaveLength(0);
    expect(dense.wires.every((wire) => !wire.stub)).toBe(true);
    expect(dense.wires.every((wire) => !wire.labelId)).toBe(true);
    expectNodePhysicallyConnected(dense, 'VCC');
    expectNodePhysicallyConnected(dense, '0');
  });

  it('physically connects op amp signal, power, and ground nets', () => {
    const diagram = layoutCircuitDiagram(fixtures[2]);

    expect(diagram.netLabels).toHaveLength(0);
    ['NIN', 'OUT', 'VCC', '0'].forEach((node) => expectNodePhysicallyConnected(diagram, node));
    expect(diagram.junctions.length).toBeGreaterThan(0);
    expect(validateDiagramLayout(diagram)).toEqual({ ok: true, violations: [] });
  });

  it('physically routes a generated difference amplifier without net labels', () => {
    const diagram = layoutCircuitDiagram(differenceAmplifier);

    expect(diagram.netLabels).toHaveLength(0);
    expect(diagram.wires.every((wire) => wire.points.length >= 2 && !wire.labelId)).toBe(true);
    ['VBIAS', 'OPP', 'OPN', 'VCC', 'VOUT', '0'].forEach((node) => expectNodePhysicallyConnected(diagram, node));
    expect(validateDiagramLayout(diagram)).toEqual({ ok: true, violations: [] });
  });

  it('renders schematic external terminals as visual ports', () => {
    const diagram = layoutCircuitDiagram({
      ...fixtures[0],
      schematic: {
        version: 1,
        topology: 'rc_filter',
        externalTerminals: [
          { net: 'VIN', label: 'VIN', type: 'input', side: 'left', explicit: true },
          { net: 'OUT', label: 'VOUT', type: 'output', side: 'right', explicit: true },
        ],
        netRoles: [
          { net: 'VIN', role: 'input', side: 'left' },
          { net: 'OUT', role: 'output', side: 'right' },
        ],
      },
    });

    expect(diagram.ports.map((port) => port.net).sort()).toEqual(['OUT', 'VIN']);
    expect(diagram.wires.filter((wire) => wire.portId)).toHaveLength(2);
    expectNodePhysicallyConnected(diagram, 'OUT');
    expect(validateDiagramLayout(diagram)).toEqual({ ok: true, violations: [] });
  });

  it('builds fallback port stubs without empty wires', () => {
    const diagram = buildFallbackCircuitDiagram({
      ...fixtures[0],
      schematic: {
        externalTerminals: [
          { net: 'VIN', label: 'VIN', type: 'input', side: 'left', explicit: true },
          { net: 'OUT', label: 'OUT', type: 'output', side: 'right', explicit: true },
        ],
      },
    });

    expect(diagram.layoutMode).toBe('fallback');
    expect(diagram.ports.map((port) => port.net).sort()).toEqual(['OUT', 'VIN']);
    expect(diagram.wires.every((wire) => wire.points.length >= 2)).toBe(true);
    expect(diagram.wires.filter((wire) => wire.portId)).toHaveLength(2);
  });

  it('reports near-parallel wires that violate the 16px clearance', () => {
    const diagram = {
      width: 320,
      height: 220,
      components: [],
      labels: [],
      netLabels: [],
      nets: [],
      wires: [
        { id: 'first', node: 'A', points: [{ x: 20, y: 100 }, { x: 280, y: 100 }] },
        { id: 'second', node: 'B', points: [{ x: 20, y: 112 }, { x: 280, y: 112 }] },
      ],
    };

    expect(validateDiagramLayout(diagram).violations).toContainEqual({
      type: 'wire_wire_clearance',
      wires: ['second', 'first'],
    });
  });

  it('reports wires that overlap component bodies or unrelated net labels', () => {
    const diagram = {
      width: 360,
      height: 240,
      components: [{ ref: 'R1', x: 180, y: 100, width: 100, height: 50, pins: [] }],
      labels: [],
      nets: [],
      netLabels: [{
        id: 'net-label:other:1',
        name: 'OUT',
        x: 260,
        y: 180,
        labelX: 260,
        labelY: 167,
        labelWidth: 54,
      }],
      wires: [
        { id: 'through-component', node: 'A', points: [{ x: 40, y: 100 }, { x: 320, y: 100 }] },
        { id: 'through-label', node: 'B', points: [{ x: 40, y: 180 }, { x: 320, y: 180 }] },
      ],
    };
    const types = validateDiagramLayout(diagram).violations.map((violation) => violation.type);

    expect(types).toContain('wire_component_overlap');
    expect(types).toContain('wire_label_overlap');
  });

  it('throws a typed error instead of returning a partial invalid repair', () => {
    const impossible = {
      width: 180,
      height: 160,
      components: [{
        ref: 'A',
        x: 90,
        y: 80,
        width: 170,
        height: 150,
        pinCount: 2,
        pins: [
          { node: 'N1', pinIndex: 1, x: 90, y: 80 },
          { node: 'N2', pinIndex: 2, x: 90, y: 80 },
        ],
      }],
      labels: [],
      nets: [
        { name: 'N1', connections: [{ ref: 'A', pin: 1 }] },
        { name: 'N2', connections: [{ ref: 'A', pin: 2 }] },
      ],
      netLabels: [],
      wires: [
        { id: 'A-1-N1', ref: 'A', pin: 1, node: 'N1' },
        { id: 'A-2-N2', ref: 'A', pin: 2, node: 'N2' },
      ],
    };

    expect(() => repairDiagramLayout(impossible)).toThrow(DiagramLayoutError);
  });

  it('expands a constrained canvas until labels and routes fit', () => {
    const constrained = {
      width: 220,
      height: 180,
      components: [{
        ref: 'R1',
        kind: 'resistor',
        value: '1k',
        symbolType: 'resistor',
        orientation: 'horizontal',
        x: 110,
        y: 90,
        width: 108,
        height: 58,
        pinCount: 2,
        pins: [
          { node: 'IN', pinIndex: 1, x: 56, y: 90 },
          { node: 'OUT', pinIndex: 2, x: 164, y: 90 },
        ],
      }],
      labels: [],
      nets: [
        { name: 'IN', connections: [{ ref: 'R1', pin: 1 }] },
        { name: 'OUT', connections: [{ ref: 'R1', pin: 2 }] },
      ],
      netLabels: [],
      wires: [
        { id: 'R1-1-IN', ref: 'R1', pin: 1, node: 'IN' },
        { id: 'R1-2-OUT', ref: 'R1', pin: 2, node: 'OUT' },
      ],
    };

    const repaired = repairDiagramLayout(constrained);
    expect(repaired.width > constrained.width || repaired.height > constrained.height).toBe(true);
    expect(validateDiagramLayout(repaired)).toEqual({ ok: true, violations: [] });
  });

  it('expands the canvas to find the nearest legal snapped placement', () => {
    const diagram = {
      width: 220,
      height: 180,
      components: [
        { ref: 'A', x: 110, y: 90, width: 90, height: 60, pins: [] },
        { ref: 'B', x: 110, y: 90, width: 90, height: 60, pins: [] },
      ],
    };
    const placement = findNearestLegalPlacement(diagram, 'B', { x: 110, y: 90 });

    expect(placement).not.toBeNull();
    expect(placement.width > diagram.width || placement.height > diagram.height).toBe(true);
    expect(placement.x % 20).toBe(0);
    expect(placement.y % 20).toBe(0);
  });

  it('allows interactive component placement along both axes', () => {
    const diagram = layoutCircuitDiagram(fixtures[0]);
    const component = diagram.components.find((item) => item.ref === 'R1');
    const vertical = findNearestLegalPlacement(diagram, component.ref, {
      x: component.x,
      y: component.y + 120,
    });
    const horizontal = findNearestLegalPlacement(diagram, component.ref, {
      x: component.x + 120,
      y: component.y,
    });

    expect(vertical.y).not.toBe(component.y);
    expect(horizontal.x).not.toBe(component.x);
  });

  it('preserves waypoint intent while repairing and incrementally rerouting', () => {
    const diagram = layoutCircuitDiagram(fixtures[1]);
    const selected = diagram.wires.find((wire) => wire.node === 'OUT');
    const waypoint = { x: diagram.width - 100, y: 80 };
    const edited = {
      ...diagram,
      wires: diagram.wires.map((wire) => wire.id === selected.id
        ? { ...wire, routingMode: 'manual', preferredWaypoints: [waypoint], points: [] }
        : wire),
    };
    const repaired = repairDiagramLayout(edited);
    const rerouted = rerouteAffectedNets(repaired, ['OUT']);

    expect(repaired.wires.find((wire) => wire.id === selected.id).preferredWaypoints).toEqual([waypoint]);
    expect(validateDiagramLayout(rerouted)).toEqual({ ok: true, violations: [] });
  });

  it('lays out 50 components within an interactive budget without partial invalid output', () => {
    const components = [{ ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['N0', '0'] }];
    for (let index = 1; index < 50; index += 1) {
      components.push({
        ref: `R${index}`,
        kind: index % 7 === 0 ? 'load' : 'resistor',
        value: `${index + 1}k`,
        nodes: [`N${index - 1}`, index === 49 ? '0' : `N${index}`],
      });
    }
    const started = performance.now();
    const diagram = layoutCircuitDiagram(circuit('50 component chain', components));
    const elapsed = performance.now() - started;

    expect(validateDiagramLayout(diagram)).toEqual({ ok: true, violations: [] });
    expect(elapsed).toBeLessThan(5000);
  });
});
