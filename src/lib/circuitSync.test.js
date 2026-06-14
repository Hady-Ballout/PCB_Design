import { describe, expect, it } from 'vitest';
import { buildCircuitDiagram, toKiCadNetlist, toSpice } from './pcbGenerator.js';
import {
  circuitElectricalSignature,
  circuitFromDiagram,
  parseKiCadNetlist,
  parseSpiceNetlist,
  preserveDiagramLayout,
  synchronizeResult,
} from './circuitSync.js';

const circuit = {
  title: 'Synchronized RC filter',
  type: 'low_pass',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', footprint: 'Resistor_SMD:R_0805', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', footprint: 'Capacitor_SMD:C_0805', nodes: ['VOUT', '0'] },
  ],
  notes: [],
};

describe('circuit editor synchronization', () => {
  it('parses KiCad component values and net names back into the circuit', () => {
    const editedNetlist = toKiCadNetlist(circuit)
      .replace('<value>1k</value>', '<value>2.2k</value>')
      .replaceAll('VOUT', 'FILTERED');
    const parsed = parseKiCadNetlist(editedNetlist, circuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'R1')).toMatchObject({
      value: '2.2k',
      nodes: ['VIN', 'FILTERED'],
    });
    expect(parsed.circuit.components.find((part) => part.ref === 'C1').nodes).toEqual(['FILTERED', '0']);
  });

  it('parses SPICE value and connectivity edits back into the canvas circuit', () => {
    const parsed = parseSpiceNetlist(`* edited filter
V1 INPUT 0 SINE(0 1 60)
R1 INPUT FILTERED 2.2k
C1 FILTERED 0 220n
.tran 0.1ms 20ms
.end`, circuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'V1')).toMatchObject({
      kind: 'signal_source',
      value: 'SINE(0 1 60)',
      nodes: ['INPUT', '0'],
    });
    expect(parsed.circuit.components.find((part) => part.ref === 'R1')).toMatchObject({
      value: '2.2k',
      nodes: ['INPUT', 'FILTERED'],
    });
    expect(buildCircuitDiagram(parsed.circuit).nets.find((net) => net.name === 'FILTERED').connections).toHaveLength(2);
  });

  it('adds and removes canvas components based on SPICE component lines', () => {
    const parsed = parseSpiceNetlist(`R1 IN OUT 1k
C1 OUT 0 100n
V2 IN 0 DC 5
.end`, circuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.map((part) => part.ref)).toEqual(['R1', 'C1', 'V2']);
    expect(parsed.circuit.components.find((part) => part.ref === 'V2')).toMatchObject({
      kind: 'voltage_source',
      value: '5V',
      nodes: ['IN', '0'],
    });
    expect(parsed.circuit.components.some((part) => part.ref === 'V1')).toBe(false);
  });

  it('ignores model internals when deleting a top-level component from an op amp deck', () => {
    const opampCircuit = {
      title: 'Inverting amplifier',
      type: 'amplifier',
      supplyVoltage: 5,
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['VCC', '0'] },
        { ref: 'VSIG1', kind: 'signal_source', value: 'SINE(0 1 1k)', footprint: '', nodes: ['IN', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', footprint: '', nodes: ['IN', 'INN'] },
        { ref: 'R2', kind: 'resistor', value: '10k', footprint: '', nodes: ['OUT', 'INN'] },
        { ref: 'XU1', kind: 'opamp', value: 'LM358', footprint: '', nodes: ['0', 'INN', 'OUT', 'VCC', '0'] },
        { ref: 'RLOAD', kind: 'load', value: '1k', footprint: '', nodes: ['OUT', '0'] },
      ],
      notes: [],
    };
    const editedDeck = toSpice(opampCircuit).replace(/^RLOAD .*\r?\n/m, '');
    const parsed = parseSpiceNetlist(editedDeck, opampCircuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.map((part) => part.ref)).toEqual(['V1', 'VSIG1', 'R1', 'R2', 'XU1']);
    expect(parsed.circuit.components.some((part) => part.ref === 'EGAIN' || part.ref === 'EOUT')).toBe(false);
  });

  it('pauses SPICE synchronization for incomplete component lines', () => {
    const parsed = parseSpiceNetlist('R1 IN', circuit);

    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('needs two nodes and a value');
  });

  it('round-trips XML-sensitive values without breaking synchronization', () => {
    const specialCircuit = {
      ...circuit,
      components: circuit.components.map((part) =>
        part.ref === 'R1' ? { ...part, value: '1k & 2k', nodes: ['VIN', 'OUT<1>'] } : part,
      ),
    };
    const parsed = parseKiCadNetlist(toKiCadNetlist(specialCircuit), specialCircuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'R1')).toMatchObject({
      value: '1k & 2k',
      nodes: ['VIN', 'OUT<1>'],
    });
  });

  it('turns schematic wire changes into netlist changes', () => {
    const diagram = buildCircuitDiagram(circuit);
    diagram.wires.push({
      id: 'merge-input-output',
      manual: true,
      from: { ref: 'V1', pin: 1 },
      to: { ref: 'C1', pin: 1 },
    });

    const synchronizedCircuit = circuitFromDiagram(diagram, circuit);
    const netlist = toKiCadNetlist(synchronizedCircuit);
    const sourceNode = synchronizedCircuit.components.find((part) => part.ref === 'V1').nodes[0];

    expect(synchronizedCircuit.components.find((part) => part.ref === 'C1').nodes[0]).toBe(sourceNode);
    expect(netlist).toContain(`<net code="0" name="${sourceNode}">`);
  });

  it('disconnects a schematic pin when its net wire is deleted', () => {
    const diagram = buildCircuitDiagram(circuit);
    diagram.wires = diagram.wires.filter(
      (wire) => !(wire.ref === 'C1' && wire.pin === 1 && wire.node === 'VOUT'),
    );

    const synchronizedCircuit = circuitFromDiagram(diagram, circuit);
    expect(synchronizedCircuit.components.find((part) => part.ref === 'C1').nodes[0]).toBe('NC_C1_1');
    expect(synchronizedCircuit.components.find((part) => part.ref === 'R1').nodes[1]).toBe('VOUT');
  });

  it('keeps newly added unconnected components visible without drawing automatic wires', () => {
    const withUnconnectedResistor = {
      ...circuit,
      components: [
        ...circuit.components,
        { ref: 'R2', kind: 'resistor', value: '1k', footprint: '', nodes: ['NC_R2_1', 'NC_R2_2'] },
      ],
    };
    const diagram = buildCircuitDiagram(withUnconnectedResistor);

    expect(diagram.components.some((part) => part.ref === 'R2')).toBe(true);
    expect(diagram.nets.some((net) => net.name.startsWith('NC_R2'))).toBe(false);
    expect(diagram.wires.some((wire) => wire.ref === 'R2')).toBe(false);
    expect(toKiCadNetlist(withUnconnectedResistor)).toContain('<comp ref="R2">');
  });

  it('treats legacy ref-pin placeholder nodes as unconnected', () => {
    const withLegacySource = {
      ...circuit,
      components: [
        ...circuit.components,
        { ref: 'V2', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['V2_1', 'V2_2'] },
      ],
    };
    const diagram = buildCircuitDiagram(withLegacySource);

    expect(diagram.components.some((part) => part.ref === 'V2')).toBe(true);
    expect(diagram.nets.some((net) => net.name === 'V2_1' || net.name === 'V2_2')).toBe(false);
    expect(diagram.wires.some((wire) => wire.ref === 'V2')).toBe(false);
  });

  it('does not treat schematic movement as an electrical edit', () => {
    const diagram = buildCircuitDiagram(circuit);
    const resistor = diagram.components.find((part) => part.ref === 'R1');
    resistor.x += 80;
    resistor.y += 30;
    resistor.pins = resistor.pins.map((pin) => ({ ...pin, x: pin.x + 80, y: pin.y + 30 }));

    expect(circuitElectricalSignature(circuitFromDiagram(diagram, circuit))).toBe(
      circuitElectricalSignature(circuit),
    );
  });

  it('synchronizes a component value edited on the schematic', () => {
    const diagram = buildCircuitDiagram(circuit);
    diagram.components.find((part) => part.ref === 'R1').value = '4.7k';

    const synchronizedCircuit = circuitFromDiagram(diagram, circuit);
    const synchronized = synchronizeResult({ intent: {} }, synchronizedCircuit, diagram);

    expect(synchronizedCircuit.components.find((part) => part.ref === 'R1').value).toBe('4.7k');
    expect(synchronized.spice).toContain('R1 VIN VOUT 4.7k');
    expect(synchronized.kicadNetlist).toContain('<value>4.7k</value>');
  });

  it('preserves component positions when a netlist edit redraws the schematic', () => {
    const previousDiagram = buildCircuitDiagram(circuit);
    const previousResistor = previousDiagram.components.find((part) => part.ref === 'R1');
    previousResistor.x += 120;
    previousResistor.pins = previousResistor.pins.map((pin) => ({ ...pin, x: pin.x + 120 }));
    const nextCircuit = {
      ...circuit,
      components: circuit.components.map((part) =>
        part.ref === 'R1' ? { ...part, value: '4.7k' } : part,
      ),
    };

    const diagram = preserveDiagramLayout(buildCircuitDiagram(nextCircuit), previousDiagram);
    expect(diagram.components.find((part) => part.ref === 'R1').x).toBe(previousResistor.x);
    expect(synchronizeResult({ intent: {} }, nextCircuit, previousDiagram).spice).toContain('R1 VIN VOUT 4.7k');
  });

  it('keeps the surviving canvas layout and wires when a netlist component is deleted', () => {
    const previousDiagram = buildCircuitDiagram(circuit);
    const resistor = previousDiagram.components.find((part) => part.ref === 'R1');
    resistor.x += 120;
    resistor.y += 80;
    resistor.pins = resistor.pins.map((pin) => ({ ...pin, x: pin.x + 120, y: pin.y + 80 }));
    const previousPositions = new Map(previousDiagram.components.map((part) => [part.ref, { x: part.x, y: part.y }]));
    const editedDeck = toSpice(circuit).replace(/^C1 .*\r?\n/m, '');
    const parsed = parseSpiceNetlist(editedDeck, circuit);

    expect(parsed.ok).toBe(true);
    const synchronized = synchronizeResult({ intent: {} }, parsed.circuit, previousDiagram, { spice: editedDeck });

    expect(synchronized.diagram.components.map((part) => part.ref)).toEqual(['V1', 'R1']);
    for (const part of synchronized.diagram.components) {
      expect({ x: part.x, y: part.y }).toEqual(previousPositions.get(part.ref));
    }
    expect(synchronized.diagram.wires).toHaveLength(4);
    expect(synchronized.diagram.wires.every((wire) => wire.points.length >= 2)).toBe(true);
  });

  it('restores component wires when a deleted netlist line is added back', () => {
    const originalDeck = toSpice(circuit);
    const deletedDeck = originalDeck.replace(/^C1 .*\r?\n/m, '');
    const deleted = parseSpiceNetlist(deletedDeck, circuit);
    const afterDeletion = synchronizeResult({ intent: {} }, deleted.circuit, buildCircuitDiagram(circuit), {
      spice: deletedDeck,
    });
    const restored = parseSpiceNetlist(originalDeck, afterDeletion.circuit);

    expect(restored.ok).toBe(true);
    const afterRestore = synchronizeResult(afterDeletion, restored.circuit, afterDeletion.diagram, {
      spice: originalDeck,
    });

    expect(afterRestore.diagram.components.map((part) => part.ref)).toEqual(['V1', 'R1', 'C1']);
    expect(afterRestore.diagram.wires.filter((wire) => wire.ref === 'C1')).toHaveLength(2);
    expect(afterRestore.diagram.wires.filter((wire) => wire.ref === 'C1').every((wire) => wire.points.length >= 2)).toBe(true);
  });

  it('repairs missing visual connections when a netlist component is restored', () => {
    const originalDeck = toSpice(circuit);
    const deletedDeck = originalDeck.replace(/^C1 .*\r?\n/m, '');
    const deleted = parseSpiceNetlist(deletedDeck, circuit);
    const afterDeletion = synchronizeResult({ intent: {} }, deleted.circuit, buildCircuitDiagram(circuit), {
      spice: deletedDeck,
    });
    const restored = parseSpiceNetlist(originalDeck, afterDeletion.circuit);
    const incompleteDiagram = buildCircuitDiagram(restored.circuit);
    incompleteDiagram.wires = incompleteDiagram.wires.filter((wire) => wire.ref !== 'C1');
    incompleteDiagram.netLabels = incompleteDiagram.netLabels.filter((label) => label.ref !== 'C1');

    const afterRestore = synchronizeResult(afterDeletion, restored.circuit, incompleteDiagram, {
      spice: originalDeck,
    });
    const capacitorWires = afterRestore.diagram.wires.filter((wire) => wire.ref === 'C1');

    expect(capacitorWires).toHaveLength(2);
    expect(capacitorWires.every((wire) => wire.points.length >= 2)).toBe(true);
    expect(capacitorWires.every((wire) =>
      afterRestore.diagram.netLabels.some((label) => label.id === wire.labelId))).toBe(true);
  });

  it('separates preserved component positions that collide', () => {
    const previousDiagram = buildCircuitDiagram(circuit);
    const first = previousDiagram.components[0];
    const second = previousDiagram.components[1];
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    second.x = first.x;
    second.y = first.y;
    second.pins = second.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy }));

    const preserved = preserveDiagramLayout(buildCircuitDiagram(circuit), previousDiagram);
    const [preservedFirst, preservedSecond] = preserved.components;
    const horizontalGap = Math.abs(preservedFirst.x - preservedSecond.x)
      - (preservedFirst.width + preservedSecond.width) / 2;
    const verticalGap = Math.abs(preservedFirst.y - preservedSecond.y)
      - (preservedFirst.height + preservedSecond.height) / 2;

    expect(horizontalGap >= 24 || verticalGap >= 24).toBe(true);
  });

  it('rejects incomplete or inconsistent netlists without producing a circuit', () => {
    expect(parseKiCadNetlist('<export><components>', circuit)).toMatchObject({ ok: false });
    const unknownComponent = toKiCadNetlist(circuit).replace('ref="R1" pin="1"', 'ref="MISSING" pin="1"');
    const parsed = parseKiCadNetlist(unknownComponent, circuit);

    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('unknown component MISSING');
  });
});
