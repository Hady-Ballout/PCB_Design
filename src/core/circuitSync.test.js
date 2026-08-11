import { describe, expect, it } from 'vitest';
import { buildCircuitDiagram, toKiCadNetlist, toSpice } from './pcbGenerator.js';
import {
  circuitElectricalSignature,
  circuitFromDiagram,
  parseCircuitJson,
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

  it('parses circuit JSON edits back into the synchronized circuit', () => {
    const editedJson = JSON.stringify({
      ...circuit,
      components: circuit.components.map((part) =>
        part.ref === 'R1' ? { ...part, value: '4.7k', nodes: ['VIN', 'FILTERED'] } : part.ref === 'C1' ? { ...part, nodes: ['FILTERED', '0'] } : part,
      ),
    });
    const parsed = parseCircuitJson(editedJson, circuit);

    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'R1')).toMatchObject({
      value: '4.7k',
      nodes: ['VIN', 'FILTERED'],
    });
    const synchronized = synchronizeResult({ intent: {} }, parsed.circuit, buildCircuitDiagram(circuit));
    expect(synchronized.spice).toContain('R1 VIN FILTERED 4.7k');
    expect(synchronized.diagram.components.find((part) => part.ref === 'R1').value).toBe('4.7k');
  });

  it('pauses JSON synchronization for malformed or invalid circuit JSON', () => {
    expect(parseCircuitJson('{ broken', circuit)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('JSON syntax error')],
    });
    expect(parseCircuitJson(JSON.stringify({ ...circuit, components: [] }), circuit)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('components array')],
    });
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

  it('parses a UA741 subcircuit line into an 8-node ua741 component', () => {
    const deck = '* deck\nV1 VCC 0 DC 12\nXU1 N1 VOUT VIN 0 N5 VOUT VCC N8 UA741\nRL1 VOUT 0 10k\n.end';
    const parsed = parseSpiceNetlist(deck, { title: 'deck', components: [] });

    expect(parsed.ok).toBe(true);
    const part = parsed.circuit.components.find((component) => component.ref === 'XU1');
    expect(part).toMatchObject({ kind: 'ua741', value: 'UA741' });
    expect(part.nodes).toEqual(['N1', 'VOUT', 'VIN', '0', 'N5', 'VOUT', 'VCC', 'N8']);
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

  it('keeps op amp canvas placement stable when SPICE lines are deleted and restored', () => {
    const amplifier = {
      title: 'Op amp buffer',
      type: 'opamp',
      supplyVoltage: 12,
      components: [
        { ref: 'XU1', kind: 'opamp', value: 'LM358', footprint: '', nodes: ['VINP', 'VINN', 'VOUT', 'VCC', '0'] },
        { ref: 'V1', kind: 'voltage_source', value: '12V', footprint: '', nodes: ['VCC', '0'] },
      ],
      notes: [],
    };
    const originalDiagram = buildCircuitDiagram(amplifier);
    const opamp = originalDiagram.components.find((part) => part.ref === 'XU1');
    opamp.x += 90;
    opamp.y += 40;
    opamp.pins = opamp.pins.map((pin) => ({ ...pin, x: pin.x + 90, y: pin.y + 40 }));
    const previousPositions = new Map(originalDiagram.components.map((part) => [part.ref, { x: part.x, y: part.y }]));
    const originalDeck = toSpice(amplifier);
    const deletedDeck = originalDeck.replace(/^V1 .*\r?\n/m, '');
    const deleted = parseSpiceNetlist(deletedDeck, amplifier);

    expect(deleted.ok).toBe(true);
    const afterDeletion = synchronizeResult({ intent: {} }, deleted.circuit, originalDiagram, { spice: deletedDeck });
    expect(afterDeletion.diagram.components.map((part) => part.ref)).toEqual(['XU1']);
    for (const part of afterDeletion.diagram.components) {
      expect({ x: part.x, y: part.y }).toEqual(previousPositions.get(part.ref));
    }

    const restored = parseSpiceNetlist(originalDeck, afterDeletion.circuit);
    expect(restored.ok).toBe(true);
    const afterRestore = synchronizeResult(afterDeletion, restored.circuit, afterDeletion.diagram, {
      spice: originalDeck,
    });

    expect(afterRestore.diagram.components.map((part) => part.ref)).toEqual(['XU1', 'V1']);
    for (const ref of ['XU1']) {
      const part = afterRestore.diagram.components.find((component) => component.ref === ref);
      expect({ x: part.x, y: part.y }).toEqual(previousPositions.get(ref));
    }
    expect(afterRestore.diagram.components.some((part) => part.ref === 'V1')).toBe(true);
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
    expect(capacitorWires.every((wire) => !wire.labelId)).toBe(true);
    expect(afterRestore.diagram.netLabels).toHaveLength(0);
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

describe('microcontroller board synchronization', () => {
  const mcuCircuit = {
    title: 'Uno blink',
    type: 'mcu_led',
    supplyVoltage: 5,
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['VIN', '0'] },
      {
        ref: 'U1',
        kind: 'arduino_uno',
        value: 'Uno R3',
        footprint: 'Module:Arduino_UNO_R3',
        nodes: ['NC_U1_1', 'NC_U1_2', '0', 'VIN', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'LED', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
      },
      { ref: 'RLED', kind: 'resistor', value: '330', footprint: '', nodes: ['LED', 'LEDK'] },
      { ref: 'DLED1', kind: 'led', value: 'red', footprint: '', nodes: ['LEDK', '0'] },
    ],
    notes: [],
  };

  it('accepts MCU kinds in circuit JSON', () => {
    const parsed = parseCircuitJson(JSON.stringify(mcuCircuit), null);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'U1').kind).toBe('arduino_uno');
  });

  it('preserves MCUs through the SPICE round-trip at their original index', () => {
    const spice = toSpice(mcuCircuit);
    expect(spice).toContain('* U1 arduino_uno');
    const parsed = parseSpiceNetlist(spice, mcuCircuit);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.map((part) => part.ref)).toEqual(['V1', 'U1', 'RLED', 'DLED1']);
    const preserved = parsed.circuit.components[1];
    expect(preserved).toMatchObject({ ref: 'U1', kind: 'arduino_uno', value: 'Uno R3' });
    expect(preserved.nodes).toEqual(mcuCircuit.components[1].nodes);
    // The electrical signature must not register a spurious edit.
    expect(circuitElectricalSignature(parsed.circuit)).toBe(circuitElectricalSignature(mcuCircuit));
  });

  it('keeps the MCU when the user edits another component in SPICE', () => {
    const editedDeck = toSpice(mcuCircuit).replace('RLED LED LEDK 330', 'RLED LED LEDK 470');
    const parsed = parseSpiceNetlist(editedDeck, mcuCircuit);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'U1')).toBeTruthy();
    expect(parsed.circuit.components.find((part) => part.ref === 'RLED').value).toBe('470');
  });
});

describe('tier-2 synchronization', () => {
  const optoBase = {
    title: 'Opto circuit',
    type: 'isolation',
    supplyVoltage: 5,
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '12V', footprint: '', nodes: ['V12', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', footprint: '', nodes: ['CTRL', 'ANO'] },
      { ref: 'XU1', kind: 'optocoupler', value: 'PC817', footprint: '', nodes: ['ANO', '0', '0', 'BZLOW'] },
      { ref: 'RBZ1', kind: 'buzzer', value: '100', footprint: '', nodes: ['V12', 'BZLOW'] },
    ],
    notes: [],
  };

  it('round-trips an optocoupler through SPICE export and reparse', () => {
    const parsed = parseSpiceNetlist(toSpice(optoBase), optoBase);
    expect(parsed.ok).toBe(true);
    const opto = parsed.circuit.components.find((part) => part.ref === 'XU1');
    expect(opto).toMatchObject({ kind: 'optocoupler', value: 'PC817', nodes: ['ANO', '0', '0', 'BZLOW'] });
  });

  it('recognizes a PC817 X line without a base circuit', () => {
    const parsed = parseSpiceNetlist('* deck\nXU9 A1 0 0 C1 PC817\nR1 A1 0 1k\n.end', null);
    expect(parsed.ok).toBe(true);
    const opto = parsed.circuit.components.find((part) => part.ref === 'XU9');
    expect(opto).toMatchObject({ kind: 'optocoupler', nodes: ['A1', '0', '0', 'C1'] });
  });

  it('carries a current sensor over from its derived shunt line', () => {
    const base = {
      title: 'Current sense',
      type: 'measurement',
      supplyVoltage: 5,
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['VCC', '0'] },
        { ref: 'RCS1', kind: 'current_sensor', value: 'ACS712', footprint: '', nodes: ['VCC', 'MTOP', 'VCC', 'AOUT', '0'] },
        { ref: 'RM1', kind: 'dc_motor', value: '6V', footprint: '', nodes: ['MTOP', '0'] },
      ],
      notes: [],
    };
    const parsed = parseSpiceNetlist(toSpice(base), base);
    expect(parsed.ok).toBe(true);
    const sensor = parsed.circuit.components.find((part) => part.ref === 'RCS1');
    expect(sensor).toMatchObject({ kind: 'current_sensor', nodes: ['VCC', 'MTOP', 'VCC', 'AOUT', '0'] });
    // No spurious resistor was reconstructed from the derived line.
    expect(parsed.circuit.components.filter((part) => part.ref.startsWith('RCS1'))).toHaveLength(1);
  });

  it('round-trips tier-3 discrete kinds through SPICE export and reparse', () => {
    const base = {
      title: 'Tier-3 power path',
      type: 'power',
      supplyVoltage: 6,
      components: [
        { ref: 'VSOL1', kind: 'solar_panel', value: '6V', footprint: '', nodes: ['SUN', '0'] },
        { ref: 'F1', kind: 'fuse', value: '1A', footprint: '', nodes: ['SUN', 'FOUT'] },
        { ref: 'DS1', kind: 'schottky', value: '1N5819', footprint: '', nodes: ['FOUT', 'MLOW'] },
        { ref: 'RVM1', kind: 'vibration_motor', value: '3V', footprint: '', nodes: ['MLOW', '0'] },
      ],
      notes: [],
    };
    const parsed = parseSpiceNetlist(toSpice(base), base);
    expect(parsed.ok).toBe(true);
    const kinds = Object.fromEntries(parsed.circuit.components.map((part) => [part.ref, part.kind]));
    expect(kinds).toMatchObject({ VSOL1: 'solar_panel', F1: 'fuse', DS1: 'schottky', RVM1: 'vibration_motor' });
  });

  it('round-trips the IR parts through SPICE export and reparse', () => {
    const base = {
      title: 'IR link',
      type: 'sensor',
      supplyVoltage: 5,
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', footprint: '', nodes: ['VCC', '0'] },
        { ref: 'R1', kind: 'resistor', value: '220', footprint: '', nodes: ['VCC', 'IRA'] },
        { ref: 'DIR1', kind: 'ir_led', value: '940nm', footprint: '', nodes: ['IRA', '0'] },
        { ref: 'RIR1', kind: 'ir_phototransistor', value: '', footprint: '', nodes: ['VCC', 'VSENSE'] },
        { ref: 'R2', kind: 'resistor', value: '10k', footprint: '', nodes: ['VSENSE', '0'] },
      ],
      notes: [],
    };
    const parsed = parseSpiceNetlist(toSpice(base), base);
    expect(parsed.ok).toBe(true);
    const kinds = Object.fromEntries(parsed.circuit.components.map((part) => [part.ref, part.kind]));
    expect(kinds).toMatchObject({ DIR1: 'ir_led', RIR1: 'ir_phototransistor' });
  });

  it('recognizes a DIR line as an ir_led even without a base circuit', () => {
    const parsed = parseSpiceNetlist('* deck\nV1 VCC 0 DC 5\nD7 VCC K1 DIR\nR1 K1 0 220\n.end', null);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'D7').kind).toBe('ir_led');
  });

  it('recognizes a DSCH line as a schottky even without a base circuit', () => {
    const parsed = parseSpiceNetlist('* deck\nV1 VCC 0 DC 5\nDS9 VCC K1 DSCH\nR1 K1 0 330\n.end', null);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'DS9').kind).toBe('schottky');
  });

  it('recognizes a DTVS line as a tvs even without a base circuit', () => {
    const parsed = parseSpiceNetlist('* deck\nV1 VCC 0 DC 5\nD3 0 VCC DTVS_12\nR1 VCC 0 1k\n.end', null);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'D3').kind).toBe('tvs');
  });

  it('keeps plain DC sources as voltage_source and waveforms as signal_source', () => {
    // The V-branch base-kind preservation must not disturb existing behavior:
    // a hand-added V line with no base is a voltage_source, and a base
    // signal_source rewritten to a DC expression becomes a voltage_source.
    const base = {
      title: 'Sources',
      type: 'test',
      supplyVoltage: 5,
      components: [
        { ref: 'VSIG1', kind: 'signal_source', value: 'SINE(0 1 1k)', footprint: '', nodes: ['IN', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', footprint: '', nodes: ['IN', '0'] },
      ],
      notes: [],
    };
    const parsed = parseSpiceNetlist('* deck\nVSIG1 IN 0 DC 2\nR1 IN 0 1k\nVNEW VCC 0 DC 5\nR2 VCC 0 1k\n.end', base);
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components.find((part) => part.ref === 'VSIG1').kind).toBe('voltage_source');
    expect(parsed.circuit.components.find((part) => part.ref === 'VNEW').kind).toBe('voltage_source');
  });

  it('carries a bridge rectifier over from its derived diode lines', () => {
    const base = {
      title: 'Bridge',
      type: 'power',
      supplyVoltage: 6,
      components: [
        { ref: 'V1', kind: 'signal_source', value: 'SINE(0 6 50)', footprint: '', nodes: ['AC1N', 'AC2N'] },
        { ref: 'DB1', kind: 'bridge_rectifier', value: 'DB107', footprint: '', nodes: ['AC1N', 'AC2N', 'DCP', 'DCM'] },
        { ref: 'C1', kind: 'capacitor', value: '100uF', footprint: '', nodes: ['DCP', 'DCM'] },
      ],
      notes: [],
    };
    const parsed = parseSpiceNetlist(toSpice(base), base);
    expect(parsed.ok).toBe(true);
    const bridge = parsed.circuit.components.find((part) => part.ref === 'DB1');
    expect(bridge).toMatchObject({ kind: 'bridge_rectifier', nodes: ['AC1N', 'AC2N', 'DCP', 'DCM'] });
    expect(parsed.circuit.components.filter((part) => part.ref.startsWith('DB1'))).toHaveLength(1);
  });

  it('pads a pasted legacy 10-node raspberry_pi circuit to the current 14 pins', () => {
    const legacy = JSON.stringify({
      title: 'Old Pi blink',
      type: 'mcu_led',
      supplyVoltage: 3.3,
      components: [
        { ref: 'U1', kind: 'raspberry_pi', value: 'Pi 4', footprint: '', nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'LED', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'] },
        { ref: 'R1', kind: 'resistor', value: '330', footprint: '', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', footprint: '', nodes: ['LEDK', '0'] },
      ],
      notes: [],
    });
    const parsed = parseCircuitJson(legacy);
    expect(parsed.ok).toBe(true);
    const pi = parsed.circuit.components.find((part) => part.ref === 'U1');
    expect(pi.nodes).toHaveLength(14);
    expect(pi.nodes.slice(10)).toEqual(['NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14']);
  });
});
