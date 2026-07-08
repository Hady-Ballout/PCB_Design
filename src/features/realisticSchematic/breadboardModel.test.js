import { describe, expect, it } from 'vitest';
import { MCU_SLOT_GAP, MCU_SLOT_HEIGHT, boardSize } from './breadboardGeometry.js';
import { circuitToBreadboard, reconcileOverrides, GROUND_NET, MCU_PINS } from './breadboardModel.js';

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

// Arduino Uno blink: 5V powers a standing LED, D13 drives a switched LED.
// Pin order is the canonical MCU_PINS.arduino_uno contract.
const unoCircuit = {
  title: 'Uno blink',
  nodes: ['VCC5', 'LED', 'LEDK', 'LED2A', '0'],
  components: [
    {
      ref: 'U1',
      kind: 'arduino_uno',
      value: 'Uno R3',
      nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'LED', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
    },
    { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
    { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC5', 'LED2A'] },
    { ref: 'DLED2', kind: 'led', value: 'green', nodes: ['LED2A', '0'] },
  ],
};

const esp32Circuit = {
  title: 'ESP32 LED',
  nodes: ['VCC3', 'LED', 'LEDK', '0'],
  components: [
    {
      ref: 'U1',
      kind: 'esp32',
      value: 'DevKit V1',
      nodes: ['VCC3', '0', 'NC_U1_3', 'NC_U1_4', 'LED', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
    },
    { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
    { ref: 'DLED1', kind: 'led', value: 'blue', nodes: ['LEDK', '0'] },
    { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VCC3', '0'] },
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

  it('places an Arduino Uno off-board in a slot below the breadboard', () => {
    const model = circuitToBreadboard(unoCircuit);
    const uno = model.parts.find((part) => part.ref === 'U1');
    expect(uno.body).toBe('arduino_uno');
    expect(uno.meta.slotIndex).toBe(0);
    expect(uno.meta.slot).toMatchObject({ height: MCU_SLOT_HEIGHT });
    // The slot sits below the plain board and the drawing grows to hold it.
    expect(uno.meta.slot.y).toBeGreaterThanOrEqual(boardSize(model.board.columns).height);
    expect(model.board.height).toBe(boardSize(model.board.columns, 1).height);
    // NC pins are not wired to the board at all.
    uno.pinNets.forEach((net, index) => {
      if (/^NC_/i.test(net)) expect(uno.holes[index]).toBeNull();
      else expect(uno.holes[index]).toBeTruthy();
    });
    expect(uno.meta.pinColors.filter(Boolean)).toHaveLength(3);
  });

  it('puts the MCU supply pin on a + rail even without a battery', () => {
    const model = circuitToBreadboard(unoCircuit);
    expect(model.rails.railTopPlus).toBe('VCC5');
    expect(model.rails.railTopMinus).toBe(GROUND_NET);
    expect(model.batteries).toHaveLength(0);
    const uno = model.parts.find((part) => part.ref === 'U1');
    // Power pins plug straight into rail holes; the GND wire lands on a rail too.
    expect(uno.holes[0].strip.startsWith('rail')).toBe(true);
    expect(uno.holes[2].strip.startsWith('rail')).toBe(true);
  });

  it('fans MCU wires out left-to-right without crossing', () => {
    const model = circuitToBreadboard(unoCircuit);
    const uno = model.parts.find((part) => part.ref === 'U1');
    const columns = uno.holes.filter(Boolean).map((hole) => hole.column);
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('wires MCU circuits exactly like their netlists', () => {
    [unoCircuit, esp32Circuit].forEach((circuit) => {
      assertBoardMatchesNetlist(circuit, circuitToBreadboard(circuit));
    });
  });

  it('stacks two off-board boards into separate slots', () => {
    const model = circuitToBreadboard({
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', ...Array.from({ length: 9 }, (_, i) => `NC_U1_${i + 4}`)],
        },
        {
          ref: 'U2',
          kind: 'raspberry_pi',
          value: 'Pi 5',
          nodes: ['NC_U2_1', 'VCC3', '0', ...Array.from({ length: 7 }, (_, i) => `NC_U2_${i + 4}`)],
        },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC5', '0'] },
        { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VCC3', '0'] },
      ],
    });
    const uno = model.parts.find((part) => part.ref === 'U1');
    const pi = model.parts.find((part) => part.ref === 'U2');
    expect(pi.body).toBe('raspberry_pi');
    expect([uno.meta.slotIndex, pi.meta.slotIndex]).toEqual([0, 1]);
    expect(pi.meta.slot.y - uno.meta.slot.y).toBe(MCU_SLOT_HEIGHT + MCU_SLOT_GAP);
    expect(model.board.height).toBe(boardSize(model.board.columns, 2).height);
    // Each board's supply lands on its own + rail.
    expect(model.rails.railTopPlus).toBe('VCC5');
    expect(model.rails.railBottomPlus).toBe('VCC3');
  });

  it('places an ESP32 module straddling the trench like a wide DIP', () => {
    const model = circuitToBreadboard(esp32Circuit);
    const esp = model.parts.find((part) => part.ref === 'U1');
    expect(esp.body).toBe('esp32');
    const { columnStart, columnEnd } = esp.meta;
    expect(columnEnd - columnStart).toBe(5);
    // Legs split 6/6 across the trench per the DevKit layout.
    const strips = esp.holes.map((hole) => hole?.strip);
    [0, 1, 4, 5, 6, 7].forEach((pin) => expect(strips[pin]).toBe('bottom'));
    [2, 3, 8, 9, 10, 11].forEach((pin) => expect(strips[pin]).toBe('top'));
    esp.holes.forEach((hole) => {
      expect(hole.column).toBeGreaterThanOrEqual(columnStart);
      expect(hole.column).toBeLessThanOrEqual(columnEnd);
    });
    // The module supply rides the + rail like any other supply net.
    expect(model.rails.railTopPlus).toBe('VCC3');
  });

  it('exposes the canonical MCU pin lists', () => {
    expect(MCU_PINS.arduino_uno).toHaveLength(12);
    expect(MCU_PINS.raspberry_pi).toHaveLength(10);
    expect(MCU_PINS.esp32).toHaveLength(12);
    expect(MCU_PINS.arduino_uno[8]).toBe('D13');
  });
});

describe('circuitToBreadboard with placement overrides', () => {
  it('reproduces the pure auto-placement when overrides are empty', () => {
    // The byte-identical guarantee that keeps every test above valid.
    [dividerCircuit, opampCircuit, transistorCircuit, unoCircuit, esp32Circuit].forEach((circuit) => {
      expect(circuitToBreadboard(circuit, {})).toEqual(circuitToBreadboard(circuit));
      expect(circuitToBreadboard(circuit, { parts: {} })).toEqual(circuitToBreadboard(circuit));
    });
  });

  it('pins a two-lead part at its anchor column and strip', () => {
    const model = circuitToBreadboard(dividerCircuit, { parts: { R2: { strip: 'bottom', column: 20 } } });
    const r2 = model.parts.find((part) => part.ref === 'R2');
    expect(r2.holes[0].strip).toBe('bottom');
    expect(r2.holes[0].column).toBe(20);
    // Pinning must not break connectivity — the board still wires up correctly.
    assertBoardMatchesNetlist(dividerCircuit, model);
  });

  it('pins a straddling DIP at its anchor and greedy-places the rest around it', () => {
    const model = circuitToBreadboard(opampCircuit, { parts: { XU1: { strip: 'top', column: 15 } } });
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.meta.columnStart).toBe(15);
    const r1 = model.parts.find((part) => part.ref === 'R1');
    // R1 (auto-placed) must not overlap the pinned DIP's reserved columns.
    r1.holes.filter(Boolean).forEach((hole) => {
      const overlapsDip = hole.column >= 15 && hole.column <= 18;
      expect(overlapsDip).toBe(false);
    });
    assertBoardMatchesNetlist(opampCircuit, model);
  });

  it('grows the board to honor an anchor past the default edge', () => {
    const model = circuitToBreadboard(dividerCircuit, { parts: { R1: { strip: 'top', column: 40 } } });
    expect(model.board.columns).toBeGreaterThanOrEqual(41);
    const r1 = model.parts.find((part) => part.ref === 'R1');
    expect(r1.holes[0].column).toBe(40);
  });

  it('ignores anchors for parts that are no longer in the circuit', () => {
    // A stale anchor (part removed) must not throw or place a phantom part.
    const model = circuitToBreadboard(dividerCircuit, { parts: { GONE: { strip: 'top', column: 10 } } });
    expect(model.parts.map((part) => part.ref).sort()).toEqual(['R1', 'R2']);
    assertBoardMatchesNetlist(dividerCircuit, model);
  });
});

describe('reconcileOverrides', () => {
  it('drops anchors whose part no longer exists', () => {
    const overrides = { version: 1, parts: { R1: { strip: 'top', column: 5 }, GONE: { strip: 'top', column: 9 } } };
    const reconciled = reconcileOverrides(overrides, dividerCircuit);
    expect(Object.keys(reconciled.parts)).toEqual(['R1']);
  });

  it('returns the same object when every anchor is still live', () => {
    const overrides = { version: 1, parts: { R1: { strip: 'top', column: 5 } } };
    expect(reconcileOverrides(overrides, dividerCircuit)).toBe(overrides);
  });

  it('is null-safe for missing overrides', () => {
    expect(reconcileOverrides(null, dividerCircuit)).toBeNull();
    expect(reconcileOverrides({}, dividerCircuit)).toEqual({});
  });
});
