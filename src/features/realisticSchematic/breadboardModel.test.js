import { describe, expect, it } from 'vitest';
import { circuitToBreadboard, GROUND_NET } from './breadboardModel.js';

const dividerCircuit = {
  title: 'Voltage divider',
  nodes: ['VCC', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

const opampCircuit = {
  title: 'Buffer',
  nodes: ['VIN', 'VOUT', 'VCC', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
  ],
};

const transistorCircuit = {
  title: 'LED driver',
  nodes: ['VCC', 'BASE', 'LEDK', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDA'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', 'LEDK'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LEDK', 'BASE', '0'] },
    { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['BASE', '0'] },
  ],
};

// Reconstructs electrical connectivity from the placement model (tie groups +
// rails + jumpers) with a union-find, so tests can assert the board wires up
// exactly like the circuit netlist.
const connectivityOf = (model) => {
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
  model.jumpers.forEach((jumper) => union(keyOf(jumper.from), keyOf(jumper.to)));
  return { find, keyOf };
};

const assertBoardMatchesNetlist = (circuit, model) => {
  const { find, keyOf } = connectivityOf(model);
  const pins = [];
  model.parts.forEach((part) => {
    part.pinNets.forEach((net, index) => {
      if (/^NC_/i.test(net) || net === `${part.ref}_${index + 1}`) return;
      pins.push({ net, root: find(keyOf(part.holes[index])) });
    });
  });
  pins.forEach((a) => {
    pins.forEach((b) => {
      if (a.net === b.net) expect(a.root).toBe(b.root);
      else expect(a.root).not.toBe(b.root);
    });
  });
};

describe('circuitToBreadboard', () => {
  it('puts the supply and ground on the rails and emits a battery', () => {
    const model = circuitToBreadboard(dividerCircuit);
    expect(model.rails.railTopPlus).toBe('VCC');
    expect(model.rails.railTopMinus).toBe(GROUND_NET);
    expect(model.batteries).toHaveLength(1);
    expect(model.batteries[0]).toMatchObject({ ref: 'V1', value: '5V' });
    expect(model.parts.map((part) => part.ref)).toEqual(['R1', 'R2']);
  });

  it('lets series parts share a tie group instead of adding a jumper', () => {
    const model = circuitToBreadboard(dividerCircuit);
    const [r1, r2] = model.parts;
    // R1 pin 2 and R2 pin 1 both carry VOUT and should plug into one column.
    expect(r2.holes[0].column).toBe(r1.holes[1].column);
    expect(r2.holes[0].strip).toBe(r1.holes[1].strip);
    expect(model.jumpers.some((jumper) => jumper.net === 'VOUT')).toBe(false);
  });

  it('wires the board exactly like the circuit netlist', () => {
    [dividerCircuit, opampCircuit, transistorCircuit].forEach((circuit) => {
      assertBoardMatchesNetlist(circuit, circuitToBreadboard(circuit));
    });
  });

  it('places an opamp as a DIP-8 straddling the trench', () => {
    const model = circuitToBreadboard(opampCircuit);
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    // Canonical pins [IN+, IN-, OUT, V+, V-] -> DIP 3, 2, 6, 7, 4.
    expect(dip.holes.map((hole) => hole.strip)).toEqual(['bottom', 'bottom', 'top', 'top', 'bottom']);
    const { columnStart, columnEnd } = dip.meta;
    expect(columnEnd - columnStart).toBe(3);
    dip.holes.forEach((hole) => {
      expect(hole.column).toBeGreaterThanOrEqual(columnStart);
      expect(hole.column).toBeLessThanOrEqual(columnEnd);
    });
    expect(dip.holes.map((hole) => hole.column - columnStart)).toEqual([2, 1, 2, 1, 3]);
  });

  it('places a BJT across three adjacent columns in node order', () => {
    const model = circuitToBreadboard(transistorCircuit);
    const bjt = model.parts.find((part) => part.ref === 'Q1');
    expect(bjt.body).toBe('to92');
    bjt.holes.forEach((hole, index) => {
      expect(hole.strip).toBe(bjt.holes[0].strip);
      expect(hole.column).toBe(bjt.holes[0].column + index);
    });
  });

  it('gives NC pins a hole but no jumper', () => {
    const model = circuitToBreadboard({
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VCC', 'NC_DLED1_2'] },
      ],
    });
    const led = model.parts[0];
    expect(led.holes).toHaveLength(2);
    expect(led.holes[1]).toBeTruthy();
    expect(model.jumpers.every((jumper) => jumper.net !== 'NC_DLED1_2')).toBe(true);
  });

  it('grows the board when the default size overflows and warns past full size', () => {
    const big = {
      components: Array.from({ length: 40 }, (_, index) => ({
        ref: `R${index + 1}`,
        kind: 'resistor',
        value: '1k',
        nodes: [`A${index + 1}`, `B${index + 1}`],
      })),
    };
    const model = circuitToBreadboard(big);
    expect(model.board.columns).toBeGreaterThan(30);
    model.parts.forEach((part) => {
      part.holes.forEach((hole) => {
        expect(hole.column).toBeGreaterThanOrEqual(1);
        expect(hole.column).toBeLessThanOrEqual(model.board.columns);
      });
    });
    expect(model.warnings.some((warning) => warning.includes('full size'))).toBe(true);
  });

  it('exposes net groups, a net legend, and battery nets for the view', () => {
    const model = circuitToBreadboard(dividerCircuit);
    expect(model.batteries[0].nets).toEqual(['VCC', GROUND_NET]);
    expect(model.netGroups.VOUT).toHaveLength(1);
    expect(model.nets.map((entry) => entry.net)).toEqual(['VCC', GROUND_NET, 'VOUT']);
    expect(model.nets.find((entry) => entry.net === GROUND_NET).role).toBe('ground');
    expect(model.nets.find((entry) => entry.net === 'VCC').role).toBe('supply');
    expect(model.nets.every((entry) => typeof entry.color === 'string')).toBe(true);
  });

  it('is deterministic', () => {
    const first = circuitToBreadboard(transistorCircuit);
    const second = circuitToBreadboard(transistorCircuit);
    expect(second).toEqual(first);
  });
});
