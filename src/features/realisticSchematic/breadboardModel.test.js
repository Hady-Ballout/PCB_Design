import { describe, expect, it } from 'vitest';
import { MCU_SLOT_GAP, MCU_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT, boardSize } from './breadboardGeometry.js';
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
      // Canonical 24-pin order: 5V@0, GND@2, D13@17. LED rides D13.
      nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14', 'NC_U1_15', 'NC_U1_16', 'NC_U1_17', 'LED', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24'],
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

// 555 astable: canonical pins [GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC].
const timerCircuit = {
  title: '555 blink',
  nodes: ['VCC', 'TRIG', 'OUT', 'CTRL', 'DIS', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    { ref: 'XU1', kind: 'timer_555', value: 'NE555', nodes: ['0', 'TRIG', 'OUT', 'VCC', 'CTRL', 'TRIG', 'DIS', 'VCC'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'DIS'] },
    { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['TRIG', '0'] },
    { ref: 'C2', kind: 'capacitor', value: '10nF', nodes: ['CTRL', '0'] },
  ],
};

// Comparator shares the opamp's canonical 5-pin contract [IN+, IN-, OUT, V+, V-].
const comparatorCircuit = {
  title: 'Threshold detector',
  nodes: ['VIN', 'VREF', 'VOUT', 'VCC', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    { ref: 'XU1', kind: 'comparator', value: 'LM393', nodes: ['VIN', 'VREF', 'VOUT', 'VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VREF', '0'] },
    { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['VOUT', 'VCC'] },
  ],
};

const tempSensorCircuit = {
  title: 'Temperature probe',
  nodes: ['VCC', 'TOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'U1', kind: 'temp_sensor', value: 'TMP36', nodes: ['VCC', 'TOUT', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['TOUT', '0'] },
  ],
};

const regulatorCircuit = {
  title: '7805 supply',
  nodes: ['VIN', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
    { ref: 'VREG1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
    { ref: 'CIN', kind: 'capacitor', value: '330nF', nodes: ['VIN', '0'] },
    { ref: 'COUT', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    { ref: 'RLOAD', kind: 'load', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

const buckConverterCircuit = {
  title: 'LM2596 5V buck',
  nodes: ['VIN', 'VOUT', 'FB', 'EN', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'] },
    { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'VOUT', '0', 'FB', 'EN'] },
    { ref: 'COUT', kind: 'capacitor', value: '100uF', nodes: ['VOUT', '0'] },
    { ref: 'RLOAD', kind: 'load', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

const buttonCircuit = {
  title: 'Button pull-up',
  nodes: ['VCC', 'BTN', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'BTN'] },
    { ref: 'RBTN', kind: 'pushbutton', value: '', nodes: ['BTN', '0'] },
  ],
};

// 5161AS pinout: canonical pins [A,B,C,D,E,F,G,DP,COM]; only A is driven, the
// other segment nets float on their own single-pin nets.
const sevenSegCircuit = {
  title: 'Segment test',
  nodes: ['VCC', 'SA', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VCC', 'SA'] },
    { ref: 'D1', kind: 'seven_segment', value: '5161AS', nodes: ['SA', 'SB', 'SC', 'SD', 'SE', 'SF', 'SG', 'SDP', '0'] },
  ],
};

const servoCircuit = {
  title: 'Servo sweep',
  nodes: ['VCC', 'SIG', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'U1', kind: 'servo', value: 'SG90', nodes: ['VCC', '0', 'SIG'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['SIG', '0'] },
  ],
};

// Servo listed before the Uno on purpose: MCU boards must still claim the
// first slots regardless of circuit order.
const mixedOffboardCircuit = {
  title: 'Uno + servo',
  nodes: ['VCC5', 'SIG', '0'],
  components: [
    { ref: 'U2', kind: 'servo', value: 'SG90', nodes: ['VCC5', '0', 'SIG'] },
    {
      ref: 'U1',
      kind: 'arduino_uno',
      value: 'Uno R3',
      nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'SIG', ...Array.from({ length: 7 }, (_, i) => `NC_U1_${i + 6}`)],
    },
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

  it('places a 555 timer as a DIP-8 straddling the trench', () => {
    const model = circuitToBreadboard(timerCircuit);
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    // DIP pins 1-4 (indexes 0-3) on the bottom strip, 8-5 (7-4) on the top.
    expect(dip.holes.map((hole) => hole.strip)).toEqual([
      'bottom', 'bottom', 'bottom', 'bottom', 'top', 'top', 'top', 'top',
    ]);
    const { columnStart, columnEnd } = dip.meta;
    expect(columnEnd - columnStart).toBe(3);
    expect(dip.holes.map((hole) => hole.column - columnStart)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    assertBoardMatchesNetlist(timerCircuit, model);
  });

  it('places a comparator as an LM393-style DIP-8 like the opamp', () => {
    const model = circuitToBreadboard(comparatorCircuit);
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    expect(dip.holes.map((hole) => hole.strip)).toEqual(['bottom', 'bottom', 'top', 'top', 'bottom']);
    expect(dip.meta.columnEnd - dip.meta.columnStart).toBe(3);
    assertBoardMatchesNetlist(comparatorCircuit, model);
  });

  it('places a temperature sensor in a TO-92 can across three columns', () => {
    const model = circuitToBreadboard(tempSensorCircuit);
    const sensor = model.parts.find((part) => part.ref === 'U1');
    expect(sensor.body).toBe('to92');
    sensor.holes.forEach((hole, index) => {
      expect(hole.strip).toBe(sensor.holes[0].strip);
      expect(hole.column).toBe(sensor.holes[0].column + index);
    });
    assertBoardMatchesNetlist(tempSensorCircuit, model);
  });

  it('places a regulator as a three-pin TO-220 in IN, GND, OUT order', () => {
    const model = circuitToBreadboard(regulatorCircuit);
    const regulator = model.parts.find((part) => part.ref === 'VREG1');
    expect(regulator.body).toBe('to220');
    expect(regulator.pinNets).toEqual(['VIN', '0', 'VOUT']);
    expect(regulator.holes).toHaveLength(3);
    regulator.holes.forEach((hole, index) => {
      expect(hole.strip).toBe(regulator.holes[0].strip);
      expect(hole.column).toBe(regulator.holes[0].column + index);
    });
    assertBoardMatchesNetlist(regulatorCircuit, model);
  });

  it('places a buck converter as a five-pin TO-220 on consecutive columns of one strip', () => {
    const model = circuitToBreadboard(buckConverterCircuit);
    const buck = model.parts.find((part) => part.ref === 'U1');
    expect(buck.body).toBe('to220');
    expect(buck.pinNets).toEqual(['VIN', 'VOUT', '0', 'FB', 'EN']);
    expect(buck.holes).toHaveLength(5);
    buck.holes.forEach((hole, index) => {
      expect(hole.strip).toBe(buck.holes[0].strip);
      expect(hole.column).toBe(buck.holes[0].column + index);
    });
    assertBoardMatchesNetlist(buckConverterCircuit, model);
  });

  it('places a pushbutton straddling the trench with both pins on the bottom strip', () => {
    const model = circuitToBreadboard(buttonCircuit);
    const button = model.parts.find((part) => part.ref === 'RBTN');
    expect(button.body).toBe('pushbutton');
    const { columnStart, columnEnd } = button.meta;
    expect(columnEnd - columnStart).toBe(1);
    // Electrical pins on row f (bottom row 0); the top-strip legs are
    // decorative and claim no holes.
    expect(button.holes.map((hole) => hole.strip)).toEqual(['bottom', 'bottom']);
    expect(button.holes.map((hole) => hole.row)).toEqual([0, 0]);
    expect(button.holes.map((hole) => hole.column - columnStart)).toEqual([0, 1]);
    assertBoardMatchesNetlist(buttonCircuit, model);
  });

  it('places a 7-segment display as a DIP-10 with the 5161AS leg layout', () => {
    const model = circuitToBreadboard(sevenSegCircuit);
    const display = model.parts.find((part) => part.ref === 'D1');
    expect(display.body).toBe('seven_segment');
    const { columnStart, columnEnd } = display.meta;
    expect(columnEnd - columnStart).toBe(4);
    // Canonical [A,B,C,D,E,F,G,DP,COM] → physical bottom pins E,D,COM,C,DP and
    // top pins G,F,·,A,B (the second COM leg is decorative).
    expect(display.holes.map((hole) => hole.strip)).toEqual([
      'top', 'top', 'bottom', 'bottom', 'bottom', 'top', 'top', 'bottom', 'bottom',
    ]);
    expect(display.holes.map((hole) => hole.column - columnStart)).toEqual([3, 4, 3, 1, 0, 1, 0, 4, 2]);
    assertBoardMatchesNetlist(sevenSegCircuit, model);
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

  it('carries a SEAM warning from checkPhysicalModel when growth pushes the board past 63 columns', () => {
    // Many two-lead parts on distinct nets (no series reuse) so the greedy
    // allocator keeps consuming fresh columns and grows the board past one
    // full-size (63-column) breadboard, which physicalChecks flags.
    const huge = {
      components: Array.from({ length: 40 }, (_, index) => ({
        ref: `R${index + 1}`,
        kind: 'resistor',
        value: '1k',
        nodes: [`A${index + 1}`, `B${index + 1}`],
      })),
    };
    const model = circuitToBreadboard(huge);
    expect(model.board.columns).toBeGreaterThan(63);
    expect(model.warnings.some((warning) => warning.startsWith('SEAM:'))).toBe(true);
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
    expect(model.board.height).toBe(boardSize(model.board.columns, [MCU_SLOT_HEIGHT]).height);
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

  it('taps existing net groups directly and fans the rest out left-to-right', () => {
    const model = circuitToBreadboard(unoCircuit);
    const uno = model.parts.find((part) => part.ref === 'U1');
    const rled = model.parts.find((part) => part.ref === 'RLED');
    // D13 (pin index 17) plugs straight into the tie group RLED's lead already
    // earned — no spare attachment group, no joining jumper on that net.
    expect(uno.holes[17].strip).toBe(rled.holes[0].strip);
    expect(uno.holes[17].column).toBe(rled.holes[0].column);
    expect(model.jumpers.filter((jumper) => jumper.net === 'LED')).toHaveLength(0);
    // Every other connected pin lands on a rail or a fresh column, and those
    // columns run left-to-right in pin order without crossing.
    const reusedKey = `${rled.holes[0].strip}:${rled.holes[0].column}`;
    const fanned = uno.holes
      .filter(Boolean)
      .filter((hole) => `${hole.strip}:${hole.column}` !== reusedKey)
      .map((hole) => hole.column);
    expect(fanned).toEqual([...fanned].sort((a, b) => a - b));
    expect(new Set(fanned).size).toBe(fanned.length);
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
    expect(model.board.height).toBe(boardSize(model.board.columns, [MCU_SLOT_HEIGHT, MCU_SLOT_HEIGHT]).height);
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

  it('places a servo in a compact off-board slot', () => {
    const model = circuitToBreadboard(servoCircuit);
    const servo = model.parts.find((part) => part.ref === 'U1');
    expect(servo.body).toBe('servo');
    expect(servo.meta.slotIndex).toBe(0);
    expect(servo.meta.slot).toMatchObject({ height: PERIPHERAL_SLOT_HEIGHT });
    expect(servo.meta.slot.y).toBeGreaterThanOrEqual(boardSize(model.board.columns).height);
    expect(model.board.height).toBe(boardSize(model.board.columns, [PERIPHERAL_SLOT_HEIGHT]).height);
    // VCC/GND land on rails, SIG taps the strip.
    expect(servo.holes[0].strip.startsWith('rail')).toBe(true);
    expect(servo.holes[1].strip.startsWith('rail')).toBe(true);
    assertBoardMatchesNetlist(servoCircuit, model);
  });

  it('sends a DC motor off-board instead of placing it as a two-lead part', () => {
    const model = circuitToBreadboard({
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'RM1', kind: 'dc_motor', value: '12ohm', nodes: ['M', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'M'] },
      ],
    });
    const motor = model.parts.find((part) => part.ref === 'RM1');
    expect(motor.body).toBe('dc_motor');
    expect(motor.meta.slotIndex).not.toBeNull();
    expect(motor.meta.slot).toMatchObject({ height: PERIPHERAL_SLOT_HEIGHT });
  });

  it('stacks MCU slots before peripheral slots with per-part heights', () => {
    const model = circuitToBreadboard(mixedOffboardCircuit);
    const uno = model.parts.find((part) => part.ref === 'U1');
    const servo = model.parts.find((part) => part.ref === 'U2');
    // The Uno claims slot 0 even though the servo comes first in the circuit.
    expect([uno.meta.slotIndex, servo.meta.slotIndex]).toEqual([0, 1]);
    expect(servo.meta.slot.y - uno.meta.slot.y).toBe(MCU_SLOT_HEIGHT + MCU_SLOT_GAP);
    expect(model.board.height).toBe(boardSize(model.board.columns, [MCU_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT]).height);
    assertBoardMatchesNetlist(mixedOffboardCircuit, model);
  });

  it('wires sensor modules and off-board peripherals exactly like the netlist', () => {
    const circuit = {
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'ultrasonic_sensor', value: 'HC-SR04', nodes: ['VCC', 'TRIG', 'ECHO', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['TRIG', 'ECHO'] },
        { ref: 'U2', kind: 'servo', value: 'SG90', nodes: ['VCC', '0', 'TRIG'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    // The HC-SR04 stays on-board as a generic module footprint.
    expect(model.parts.find((part) => part.ref === 'U1').body).toBe('module');
    assertBoardMatchesNetlist(circuit, model);
  });

  it('exposes the canonical MCU pin lists', () => {
    expect(MCU_PINS.arduino_uno).toHaveLength(24);
    expect(MCU_PINS.raspberry_pi).toHaveLength(14);
    expect(MCU_PINS.esp32).toHaveLength(12);
    expect(MCU_PINS.arduino_uno[17]).toBe('D13');
    // GPIO8-11 (SPI0) were appended in the tier-2 pin extension.
    expect(MCU_PINS.raspberry_pi.slice(10)).toEqual(['GPIO8', 'GPIO9', 'GPIO10', 'GPIO11']);
  });
});

describe('circuitToBreadboard with placement overrides', () => {
  it('reproduces the pure auto-placement when overrides are empty', () => {
    // The byte-identical guarantee that keeps every test above valid.
    [dividerCircuit, opampCircuit, transistorCircuit, unoCircuit, esp32Circuit, timerCircuit, comparatorCircuit, tempSensorCircuit, buttonCircuit, sevenSegCircuit, servoCircuit, mixedOffboardCircuit].forEach((circuit) => {
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

  it('pins the new DIP kinds at their anchors like the opamp', () => {
    // The anchored pass must mirror the greedy dispatch for every straddle kind.
    [timerCircuit, comparatorCircuit].forEach((circuit) => {
      const model = circuitToBreadboard(circuit, { parts: { XU1: { strip: 'top', column: 15 } } });
      const dip = model.parts.find((part) => part.ref === 'XU1');
      expect(dip.body).toBe('dip');
      expect(dip.meta.columnStart).toBe(15);
      assertBoardMatchesNetlist(circuit, model);
    });
  });

  it('pins the trench-straddling pushbutton and 7-segment at their anchors', () => {
    [[buttonCircuit, 'RBTN', 'pushbutton'], [sevenSegCircuit, 'D1', 'seven_segment']].forEach(([circuit, ref, body]) => {
      const model = circuitToBreadboard(circuit, { parts: { [ref]: { strip: 'top', column: 15 } } });
      const part = model.parts.find((candidate) => candidate.ref === ref);
      expect(part.body).toBe(body);
      expect(part.meta.columnStart).toBe(15);
      assertBoardMatchesNetlist(circuit, model);
    });
  });

  it('keeps the TO-92 body for an anchored temperature sensor', () => {
    const model = circuitToBreadboard(tempSensorCircuit, { parts: { U1: { strip: 'bottom', column: 12 } } });
    const sensor = model.parts.find((part) => part.ref === 'U1');
    expect(sensor.body).toBe('to92');
    expect(sensor.holes[0]).toMatchObject({ strip: 'bottom', column: 12 });
    assertBoardMatchesNetlist(tempSensorCircuit, model);
  });

  it('grows the board to honor an anchor past the default edge', () => {
    const model = circuitToBreadboard(dividerCircuit, { parts: { R1: { strip: 'top', column: 40 } } });
    expect(model.board.columns).toBeGreaterThanOrEqual(41);
    const r1 = model.parts.find((part) => part.ref === 'R1');
    expect(r1.holes[0].column).toBe(40);
  });

  it('ignores anchors on off-board parts, which live in fixed slots', () => {
    const model = circuitToBreadboard(servoCircuit, { parts: { U1: { strip: 'top', column: 10 } } });
    const servo = model.parts.find((part) => part.ref === 'U1');
    expect(servo.body).toBe('servo');
    expect(servo.meta.slotIndex).toBe(0);
    assertBoardMatchesNetlist(servoCircuit, model);
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

describe('board integrity', () => {
  const fixtures = {
    dividerCircuit,
    opampCircuit,
    unoCircuit,
    esp32Circuit,
    timerCircuit,
    comparatorCircuit,
    tempSensorCircuit,
    regulatorCircuit,
    buttonCircuit,
    sevenSegCircuit,
    servoCircuit,
    mixedOffboardCircuit,
    transistorCircuit,
  };

  for (const [name, circuit] of Object.entries(fixtures)) {
    it(`${name} builds with a clean integrity report`, () => {
      const model = circuitToBreadboard(circuit);
      expect(model.integrity.ok).toBe(true);
      expect(model.integrity.issues).toEqual([]);
    });
  }

  it('promotes a crowded net to a rail instead of dropping jumpers', () => {
    // Seven taps on one net would exhaust a single 5-hole tie group.
    const starCircuit = {
      title: 'Star net',
      nodes: ['VCC', 'STAR', '0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'R0', kind: 'resistor', value: '1k', nodes: ['VCC', 'STAR'] },
        ...Array.from({ length: 6 }, (_, index) => (
          { ref: `R${index + 1}`, kind: 'resistor', value: '1k', nodes: ['STAR', index < 3 ? '0' : `N${index + 1}`] }
        )),
      ],
    };
    const model = circuitToBreadboard(starCircuit);
    expect(Object.values(model.rails)).toContain('STAR');
    assertBoardMatchesNetlist(starCircuit, model);
    expect(model.integrity.ok).toBe(true);
    expect(model.warnings.filter((warning) => /dropped|no free holes/i.test(warning))).toEqual([]);
  });

  it('keeps a heavily chained non-promotable net connected via relay groups', () => {
    // Four taps stay under the rail-promotion threshold but still stress a
    // single home group once jumper holes accumulate.
    const chainCircuit = {
      title: 'Chained net',
      nodes: ['VCC', 'MID', '0', 'A', 'B'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'MID'] },
        { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['MID', '0'] },
        { ref: 'R3', kind: 'resistor', value: '1k', nodes: ['MID', 'A'] },
        { ref: 'R4', kind: 'resistor', value: '1k', nodes: ['MID', 'B'] },
      ],
    };
    const model = circuitToBreadboard(chainCircuit);
    assertBoardMatchesNetlist(chainCircuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('flags a straddle package with the wrong node count as unreliable', () => {
    const wrongOpamp = {
      title: 'Broken op amp',
      nodes: ['VIN', 'VOUT', 'VCC', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
        { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VIN', 'VOUT', 'VOUT', 'VCC'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
      ],
    };
    const model = circuitToBreadboard(wrongOpamp);
    expect(model.integrity.ok).toBe(false);
    expect(model.integrity.issues.some((issue) =>
      issue.severity === 'error' && issue.message.includes('XU1') && issue.message.includes('unreliable'))).toBe(true);
  });

  it('reports a third supply as an integrity error', () => {
    const threeSupplies = {
      title: 'Too many supplies',
      nodes: ['V1P', 'V2P', 'V3P', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['V1P', '0'] },
        { ref: 'V2', kind: 'voltage_source', value: '9V', nodes: ['V2P', '0'] },
        { ref: 'V3', kind: 'voltage_source', value: '12V', nodes: ['V3P', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['V1P', '0'] },
      ],
    };
    const model = circuitToBreadboard(threeSupplies);
    expect(model.integrity.issues.some((issue) =>
      issue.severity === 'error' && issue.message.includes('V3'))).toBe(true);
  });

  it('renders a functionally wrong circuit faithfully (wrong is not broken)', () => {
    // The known buzzer bug: electrically wrong (no driver stage), but every
    // net must still be wired exactly as specified — the topology checker,
    // not the breadboard, owns functional complaints.
    const buzzerBug = {
      title: 'Buzzer bug',
      nodes: ['3V3', 'BUZZER', '0'],
      components: [
        {
          ref: 'U1',
          kind: 'esp32',
          value: 'DevKit V1',
          nodes: ['3V3', '0', 'NC_U1_3', 'NC_U1_4', 'BUZZER', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
        { ref: 'R2', kind: 'resistor', value: '330', nodes: ['BUZZER', '0'] },
        { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['3V3', 'BUZZER'] },
      ],
    };
    const model = circuitToBreadboard(buzzerBug);
    assertBoardMatchesNetlist(buzzerBug, model);
    expect(model.integrity.ok).toBe(true);
  });
});

// --- Tier-1 kinds: DIP-16 straddle, TO-92 inline, off-board modules ---------

// 74HC595 in DIP order [QB..QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC];
// unused outputs float on their own single-pin nets like the 7-segment fixture.
const shiftRegCircuit = {
  title: 'Shift register LED',
  nodes: ['VCC', 'QA', 'LEDK', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'XU1', kind: 'shift_register', value: '74HC595', nodes: ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', '0', 'QH2', 'VCC', 'SRCLK', 'RCLK', '0', 'SER', 'QA', 'VCC'] },
    { ref: 'R1', kind: 'resistor', value: '330', nodes: ['QA', 'LEDK'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
  ],
};

const irReceiverCircuit = {
  title: 'IR receiver',
  nodes: ['VCC', 'IROUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'U1', kind: 'ir_receiver', value: 'TSOP38238', nodes: ['IROUT', '0', 'VCC'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['IROUT', 'VCC'] },
  ],
};

// Uno + three off-board peripherals: the crowding fixture from the plan.
const stepperSystemCircuit = {
  title: 'Stepper + LCD',
  nodes: ['VCC5', 'SIN1', 'SIN2', 'SIN3', 'SIN4', 'COILA', 'COILB', 'COILC', 'COILD', 'SDA', 'SCL', '0'],
  components: [
    {
      ref: 'U1',
      kind: 'arduino_uno',
      value: 'Uno R3',
      // D8-D11 at indices 12-15, A4/A5 (I2C) at 22/23.
      nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'SIN1', 'SIN2', 'SIN3', 'SIN4', 'NC_U1_17', 'NC_U1_18', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'SDA', 'SCL'],
    },
    { ref: 'U2', kind: 'stepper_driver', value: 'ULN2003', nodes: ['SIN1', 'SIN2', 'SIN3', 'SIN4', 'VCC5', '0', 'COILA', 'COILB', 'COILC', 'COILD'] },
    { ref: 'M1', kind: 'stepper_motor', value: '28BYJ-48', nodes: ['COILA', 'COILB', 'COILC', 'COILD', 'VCC5'] },
    { ref: 'U3', kind: 'lcd_display', value: 'LCD1602', nodes: ['0', 'VCC5', 'SDA', 'SCL'] },
  ],
};

describe('tier-1 component placement', () => {
  it('straddles the 74HC595 across the trench as a DIP-16', () => {
    const model = circuitToBreadboard(shiftRegCircuit);
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    expect(dip.meta.columnEnd - dip.meta.columnStart).toBe(7);
    const strips = dip.holes.map((hole) => hole?.strip);
    // DIP order: pins 1-8 (indices 0-7) on the bottom row, 16-9 on the top.
    [0, 1, 2, 3, 4, 5, 6, 7].forEach((pin) => expect(strips[pin]).toBe('bottom'));
    [8, 9, 10, 11, 12, 13, 14, 15].forEach((pin) => expect(strips[pin]).toBe('top'));
    assertBoardMatchesNetlist(shiftRegCircuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('flags a shift register with the wrong node count as unreliable', () => {
    const broken = {
      ...shiftRegCircuit,
      components: shiftRegCircuit.components.map((part) =>
        (part.ref === 'XU1' ? { ...part, nodes: part.nodes.slice(0, 15) } : part)),
    };
    const model = circuitToBreadboard(broken);
    expect(model.integrity.ok).toBe(false);
    expect(model.integrity.issues.some((issue) =>
      issue.severity === 'error' && issue.message.includes('XU1') && issue.message.includes('unreliable'))).toBe(true);
  });

  it('pins an anchored 74HC595 at its column like the other straddle kinds', () => {
    const model = circuitToBreadboard(shiftRegCircuit, { parts: { XU1: { strip: 'top', column: 15 } } });
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    expect(dip.meta.columnStart).toBe(15);
    assertBoardMatchesNetlist(shiftRegCircuit, model);
  });

  it('keeps the IR receiver inline in a TO-92 can', () => {
    const model = circuitToBreadboard(irReceiverCircuit);
    const receiver = model.parts.find((part) => part.ref === 'U1');
    expect(receiver.body).toBe('to92');
    expect(receiver.meta.slotIndex ?? null).toBeNull();
    assertBoardMatchesNetlist(irReceiverCircuit, model);
  });

  it('places encoder and IMU modules inline on the strip', () => {
    const circuit = {
      title: 'Encoder + IMU',
      nodes: ['VCC', 'CLK', 'DT', 'SW', 'SDA', 'SCL', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'ENC1', kind: 'rotary_encoder', value: 'KY-040', nodes: ['CLK', 'DT', 'SW', 'VCC', '0'] },
        { ref: 'U2', kind: 'imu_sensor', value: 'MPU6050', nodes: ['VCC', '0', 'SCL', 'SDA'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['CLK', 'VCC'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['DT', 'VCC'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['SW', 'VCC'] },
        { ref: 'R4', kind: 'resistor', value: '4.7k', nodes: ['SDA', 'VCC'] },
        { ref: 'R5', kind: 'resistor', value: '4.7k', nodes: ['SCL', 'VCC'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    expect(model.parts.find((part) => part.ref === 'ENC1').body).toBe('module');
    expect(model.parts.find((part) => part.ref === 'U2').body).toBe('module');
    assertBoardMatchesNetlist(circuit, model);
  });

  it('stacks the MCU slot before three off-board peripherals and stays intact', () => {
    const model = circuitToBreadboard(stepperSystemCircuit);
    const uno = model.parts.find((part) => part.ref === 'U1');
    const offboard = ['U2', 'M1', 'U3'].map((ref) => model.parts.find((part) => part.ref === ref));
    expect(uno.meta.slotIndex).toBe(0);
    offboard.forEach((part) => {
      expect(part.body).toBe(part.kind);
      expect(part.meta.slotIndex).toBeGreaterThan(0);
      expect(part.meta.slot).toMatchObject({ height: PERIPHERAL_SLOT_HEIGHT });
    });
    expect(model.board.height).toBe(boardSize(model.board.columns, [MCU_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT]).height);
    assertBoardMatchesNetlist(stepperSystemCircuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('sends the motor driver and LED strip off-board', () => {
    const circuit = {
      title: 'Driver + strip',
      nodes: ['VCC5', 'MIN1', 'MIN2', 'MA', 'MB', 'DATA', '0'],
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'DATA', 'NC_U1_12', 'MIN1', 'MIN2', 'NC_U1_15', 'NC_U1_16', 'NC_U1_17', 'NC_U1_18', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24'],
        },
        { ref: 'U2', kind: 'motor_driver', value: 'L298N', nodes: ['VCC5', '0', 'NC_U2_3', 'MIN1', 'MIN2', 'NC_U2_6', 'NC_U2_7', 'NC_U2_8', 'MA', 'MB', 'NC_U2_11', 'NC_U2_12'] },
        { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['MA', 'MB'] },
        { ref: 'LS1', kind: 'led_strip', value: 'WS2812', nodes: ['VCC5', 'DATA', '0'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    ['U2', 'LS1'].forEach((ref) => {
      const part = model.parts.find((candidate) => candidate.ref === ref);
      expect(part.body).toBe(part.kind);
      expect(part.meta.slot).toMatchObject({ height: PERIPHERAL_SLOT_HEIGHT });
    });
    assertBoardMatchesNetlist(circuit, model);
    expect(model.integrity.ok).toBe(true);
  });
});

// --- Tier-2 kinds: DIP-4/DIP-16 straddles, off-board and inline modules -----

describe('tier-2 component placement', () => {
  const optoCircuit = {
    title: 'Opto isolation',
    nodes: ['CTRL', 'ANO', 'V12', 'BZLOW', '0'],
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['V12', '0'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['CTRL', 'ANO'] },
      { ref: 'XU1', kind: 'optocoupler', value: 'PC817', nodes: ['ANO', '0', '0', 'BZLOW'] },
      { ref: 'RBZ1', kind: 'buzzer', value: '100', nodes: ['V12', 'BZLOW'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['CTRL', '0'] },
    ],
  };

  it('straddles the PC817 across the trench as a DIP-4', () => {
    const model = circuitToBreadboard(optoCircuit);
    const dip = model.parts.find((part) => part.ref === 'XU1');
    expect(dip.body).toBe('dip');
    expect(dip.meta.columnEnd - dip.meta.columnStart).toBe(1);
    const strips = dip.holes.map((hole) => hole?.strip);
    // DIP order [A, K, E, C]: pins 1-2 on the bottom row, 4-3 on the top.
    expect(strips[0]).toBe('bottom');
    expect(strips[1]).toBe('bottom');
    expect(strips[2]).toBe('top');
    expect(strips[3]).toBe('top');
    assertBoardMatchesNetlist(optoCircuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('straddles the MCP3008 as a DIP-16 like the shift register', () => {
    const circuit = {
      title: 'ADC breakout',
      nodes: ['VCC3', 'AIN', 'CSN', 'DINN', 'DOUTN', 'CLKN', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '3.3V', nodes: ['VCC3', '0'] },
        { ref: 'U2', kind: 'adc_module', value: 'MCP3008', nodes: ['AIN', 'NC_U2_2', 'NC_U2_3', 'NC_U2_4', 'NC_U2_5', 'NC_U2_6', 'NC_U2_7', 'NC_U2_8', '0', 'CSN', 'DINN', 'DOUTN', 'CLKN', '0', 'VCC3', 'VCC3'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['AIN', 'VCC3'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['CSN', 'VCC3'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['DINN', 'VCC3'] },
        { ref: 'R4', kind: 'resistor', value: '10k', nodes: ['DOUTN', 'VCC3'] },
        { ref: 'R5', kind: 'resistor', value: '10k', nodes: ['CLKN', 'VCC3'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    const dip = model.parts.find((part) => part.ref === 'U2');
    expect(dip.body).toBe('dip');
    expect(dip.meta.columnEnd - dip.meta.columnStart).toBe(7);
    assertBoardMatchesNetlist(circuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('flags a wrong-node-count optocoupler as unreliable', () => {
    const broken = {
      ...optoCircuit,
      components: optoCircuit.components.map((part) =>
        (part.ref === 'XU1' ? { ...part, nodes: part.nodes.slice(0, 3) } : part)),
    };
    const model = circuitToBreadboard(broken);
    expect(model.integrity.ok).toBe(false);
    expect(model.integrity.issues.some((issue) =>
      issue.severity === 'error' && issue.message.includes('XU1') && issue.message.includes('unreliable'))).toBe(true);
  });

  it('sends keypad, joystick, RFID reader, and current sensor off-board', () => {
    const circuit = {
      title: 'Peripheral pack',
      nodes: ['VCC', 'K1', 'JX', 'RR', 'M1', 'M2', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'keypad', value: '4x4', nodes: ['K1', 'NC_U1_2', 'NC_U1_3', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8'] },
        { ref: 'U2', kind: 'joystick', value: 'KY-023', nodes: ['0', 'VCC', 'JX', 'NC_U2_4', 'NC_U2_5'] },
        { ref: 'U3', kind: 'rfid_reader', value: 'RC522', nodes: ['VCC', 'NC_U3_2', '0', 'NC_U3_4', 'NC_U3_5', 'NC_U3_6', 'NC_U3_7', 'RR'] },
        { ref: 'RCS1', kind: 'current_sensor', value: 'ACS712', nodes: ['M1', 'M2', 'VCC', 'NC_RCS1_4', '0'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['K1', 'VCC'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['JX', '0'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['RR', 'VCC'] },
        { ref: 'R4', kind: 'resistor', value: '10', nodes: ['M1', 'M2'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    ['U1', 'U2', 'U3', 'RCS1'].forEach((ref) => {
      const part = model.parts.find((candidate) => candidate.ref === ref);
      expect(part.body, ref).toBe(part.kind);
      expect(part.meta.slot, ref).toMatchObject({ height: PERIPHERAL_SLOT_HEIGHT });
    });
    assertBoardMatchesNetlist(circuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('keeps the small tier-2 breakouts inline as modules', () => {
    const circuit = {
      title: 'Small breakouts',
      nodes: ['VCC', 'SDA', 'SCL', 'AOUT', 'DO', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'rtc_module', value: 'DS3231', nodes: ['0', 'VCC', 'SDA', 'SCL'] },
        { ref: 'U2', kind: 'soil_moisture', value: '', nodes: ['VCC', '0', 'AOUT'] },
        { ref: 'U3', kind: 'gas_sensor', value: 'MQ-2', nodes: ['VCC', '0', 'DO', 'AOUT'] },
        { ref: 'R1', kind: 'resistor', value: '4.7k', nodes: ['SDA', 'VCC'] },
        { ref: 'R2', kind: 'resistor', value: '4.7k', nodes: ['SCL', 'VCC'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['AOUT', '0'] },
        { ref: 'R4', kind: 'resistor', value: '10k', nodes: ['DO', 'VCC'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    ['U1', 'U2', 'U3'].forEach((ref) => {
      expect(model.parts.find((part) => part.ref === ref).body, ref).toBe('module');
    });
    assertBoardMatchesNetlist(circuit, model);
  });

  it('sends a solar panel off-board as a rail-feeding pack, not a strip part', () => {
    const circuit = {
      title: 'Solar LED',
      nodes: ['SUN', 'LEDA', '0'],
      components: [
        { ref: 'VSOL1', kind: 'solar_panel', value: '6V', nodes: ['SUN', '0'] },
        { ref: 'R1', kind: 'resistor', value: '330', nodes: ['SUN', 'LEDA'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDA', '0'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    expect(model.parts.some((part) => part.ref === 'VSOL1')).toBe(false);
    const pack = model.batteries.find((battery) => battery.ref === 'VSOL1');
    expect(pack).toBeDefined();
    expect(pack.kind).toBe('solar_panel');
    expect(model.rails.railTopPlus).toBe('SUN');
    assertBoardMatchesNetlist(circuit, model);
    expect(model.integrity.ok).toBe(true);
  });

  it('fits a battery plus a solar panel on the rails but rejects a third source', () => {
    const circuit = {
      title: 'Hybrid supply',
      nodes: ['VBAT', 'SUN', 'X1', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VBAT', '0'] },
        { ref: 'VSOL1', kind: 'solar_panel', value: '6V', nodes: ['SUN', '0'] },
        { ref: 'V3', kind: 'voltage_source', value: '9V', nodes: ['X1', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VBAT', '0'] },
        { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['SUN', '0'] },
        { ref: 'R3', kind: 'resistor', value: '1k', nodes: ['X1', '0'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    expect(model.batteries).toHaveLength(2);
    expect(model.integrity.issues.some((issue) =>
      issue.severity === 'error' && issue.message.includes('V3'))).toBe(true);
  });

  it('keeps the hall sensor inline in a TO-92 can and the sound sensor as a module', () => {
    const circuit = {
      title: 'Tier-3 sensors',
      nodes: ['VCC', 'HOUT', 'AO1', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'hall_sensor', value: 'A3144', nodes: ['VCC', '0', 'HOUT'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['HOUT', 'VCC'] },
        { ref: 'U2', kind: 'sound_sensor', value: 'KY-038', nodes: ['VCC', '0', 'NC_U2_3', 'AO1'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['AO1', '0'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    expect(model.parts.find((part) => part.ref === 'U1').body).toBe('to92');
    expect(model.parts.find((part) => part.ref === 'U2').body).toBe('module');
    assertBoardMatchesNetlist(circuit, model);
  });

  it('places all 14 Raspberry Pi pins with wires only on connected ones', () => {
    const circuit = {
      title: 'Pi SPI',
      nodes: ['VCC5', 'SCLK', 'MISO', 'MOSI', 'CE0', '0'],
      components: [
        {
          ref: 'U1',
          kind: 'raspberry_pi',
          value: 'Pi 4',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'CE0', 'MISO', 'MOSI', 'SCLK'],
        },
        { ref: 'U2', kind: 'sd_card', value: '', nodes: ['VCC5', '0', 'MISO', 'MOSI', 'SCLK', 'CE0'] },
      ],
    };
    const model = circuitToBreadboard(circuit);
    const pi = model.parts.find((part) => part.ref === 'U1');
    expect(pi.body).toBe('raspberry_pi');
    expect(pi.holes).toHaveLength(14);
    // NC pins claim no holes; the four SPI pins and the power pins do.
    expect(pi.holes.filter(Boolean).length).toBe(6);
    assertBoardMatchesNetlist(circuit, model);
    expect(model.integrity.ok).toBe(true);
  });
});
