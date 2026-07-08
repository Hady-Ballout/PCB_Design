import { describe, expect, it } from 'vitest';
import { circuitToFlow, humanComponentName, pinLabel, GROUND_NODE_ID } from './blockSchematicModel.js';

const circuit = {
  title: 'Block view test',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VOUT', 'NC_DLED1_2'] },
  ],
};

describe('blockSchematicModel', () => {
  it('emits one node per component with derived titles and pin labels', () => {
    const { nodes } = circuitToFlow(circuit);
    const componentNodes = nodes.filter((node) => node.type === 'componentBlock');
    expect(componentNodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ id: 'V1', type: 'componentBlock' });
    expect(nodes[0].data.title).toBe('Voltage Source');
    expect(nodes[1].data.pins.map((pin) => pin.label)).toEqual(['Positive', 'Negative']);
  });

  it('marks NC_ / self-net pins as unconnected', () => {
    const { nodes } = circuitToFlow(circuit);
    const led = nodes.find((node) => node.id === 'DLED1');
    expect(led.data.pins[0].connected).toBe(true); // VOUT
    expect(led.data.pins[1].connected).toBe(false); // NC_DLED1_2
  });

  it('creates an edge between pins sharing a net but not for unconnected pins', () => {
    const { edges } = circuitToFlow(circuit);
    // VIN links V1.pin1 <-> R1.pin1; VOUT links R1.pin2 <-> DLED1.pin1;
    // ground stars out to the GND symbol even with a single member (V1.pin2).
    const nets = new Set(edges.map((edge) => edge.data.net));
    expect(nets).toContain('VIN');
    expect(nets).toContain('VOUT');
    expect(nets).toContain('0');
    // NC_ pins are still skipped.
    expect(nets.has('NC_DLED1_2')).toBe(false);
    expect(edges).toHaveLength(3);
  });

  it('adds a dedicated ground symbol node and wires every grounded pin to it in a star', () => {
    const { nodes, edges } = circuitToFlow(circuit);
    const groundNode = nodes.find((node) => node.id === GROUND_NODE_ID);
    expect(groundNode).toMatchObject({ id: GROUND_NODE_ID, type: 'groundSymbol' });

    const groundEdges = edges.filter((edge) => edge.data.net === '0');
    expect(groundEdges).toHaveLength(1);
    expect(groundEdges[0]).toMatchObject({ source: 'V1', target: GROUND_NODE_ID });
  });

  it('omits the ground symbol node when no component is grounded', () => {
    const ungrounded = {
      components: [{ ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] }],
    };
    const { nodes } = circuitToFlow(ungrounded);
    expect(nodes.some((node) => node.id === GROUND_NODE_ID)).toBe(false);
  });

  it('gives every edge a bus type with a distinct lane and contrasting color', () => {
    const { edges } = circuitToFlow(circuit);
    edges.forEach((edge) => {
      expect(edge.type).toBe('bus');
      expect(typeof edge.data.laneIndex).toBe('number');
      expect(typeof edge.data.color).toBe('string');
    });
    // Distinct nets occupy distinct lanes...
    const lanes = edges.map((edge) => edge.data.laneIndex);
    expect(new Set(lanes).size).toBe(edges.length);
    // ...and consecutive lanes never share a color.
    const byLane = [...edges].sort((a, b) => a.data.laneIndex - b.data.laneIndex);
    for (let index = 1; index < byLane.length; index += 1) {
      expect(byLane[index].data.color).not.toBe(byLane[index - 1].data.color);
    }
  });

  it('can exclude the ground net when requested', () => {
    const grounded = {
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
      ],
    };
    const withGround = circuitToFlow(grounded).edges;
    const withoutGround = circuitToFlow(grounded, { includeGround: false }).edges;
    expect(withGround.some((edge) => edge.data.net === '0')).toBe(true);
    expect(withoutGround.some((edge) => edge.data.net === '0')).toBe(false);
  });

  it('labels multi-pin parts positionally', () => {
    const opamp = { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['A', 'B', 'C', 'D', 'E'] };
    expect(pinLabel(opamp, 1)).toBe('IN+');
    expect(pinLabel(opamp, 3)).toBe('OUT');
    expect(humanComponentName(opamp)).toBe('Op-Amp');
  });
});

describe('microcontroller blocks', () => {
  it('labels MCU pins positionally and names the boards', () => {
    const uno = {
      ref: 'U1',
      kind: 'arduino_uno',
      value: 'Uno R3',
      nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'LED', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
    };
    expect(humanComponentName(uno)).toBe('Arduino Uno');
    expect(pinLabel(uno, 1)).toBe('5V');
    expect(pinLabel(uno, 9)).toBe('D13');
    expect(humanComponentName({ kind: 'raspberry_pi' })).toBe('Raspberry Pi');
    expect(pinLabel({ kind: 'esp32', nodes: new Array(12).fill('x') }, 5)).toBe('GPIO2');
  });

  it('builds flow nodes for MCU circuits with connected pins marked', () => {
    const { nodes } = circuitToFlow({
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'LED', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', '0'] },
      ],
    });
    const mcuNode = nodes.find((node) => node.id === 'U1');
    expect(mcuNode.data.pins).toHaveLength(12);
    expect(mcuNode.data.pins.filter((pin) => pin.connected).map((pin) => pin.label)).toEqual(['5V', 'GND', 'D13']);
  });
});
