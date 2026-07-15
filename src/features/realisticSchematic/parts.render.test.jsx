// Render smoke test for the realistic-schematic SVG part bodies: server-side
// renders the full parts layer for representative circuits so a runtime error
// in any renderer (bad props, missing meta, null holes) fails fast without a
// browser.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALLOWED_KINDS } from '../../core/componentKinds.js';
import { circuitToBreadboard } from './breadboardModel.js';
import { BatteryPack, JumperWire, mcuPadPoint, PartDefs, PartThumbnail, PinLabels, RealisticPart } from './parts.jsx';

const renderModel = (circuit) => {
  const model = circuitToBreadboard(circuit);
  const markup = renderToStaticMarkup(
    <svg>
      <PartDefs />
      {model.parts.map((part) => (
        <g key={part.ref}>
          <RealisticPart part={part} />
          <PinLabels part={part} />
        </g>
      ))}
      {model.batteries.map((battery, index) => (
        <BatteryPack key={battery.ref} battery={battery} index={index} />
      ))}
      {model.jumpers.map((jumper) => (
        <JumperWire key={jumper.id} jumper={jumper} />
      ))}
    </svg>,
  );
  return { model, markup };
};

describe('realistic part rendering', () => {
  it('renders an off-board Arduino Uno with header labels and pin wires', () => {
    const { markup } = renderModel({
      title: 'Uno blink',
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14', 'NC_U1_15', 'NC_U1_16', 'NC_U1_17', 'LED', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24'],
        },
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC5', '0'] },
      ],
    });
    expect(markup).toContain('ARDUINO');
    expect(markup).toContain('D13');
    expect(markup).toContain('rsPartUno');
    expect(markup).toContain('ATMEGA328P');
    expect(markup).toContain('rsGoldPad');
    // Pin wires paint after the opaque board body so they terminate visibly
    // on the header pads instead of vanishing under the board.
    expect(markup.indexOf('rsPartUno)')).toBeLessThan(markup.indexOf('rs-mcu-wires'));
  });

  it('renders an off-board Raspberry Pi', () => {
    const { markup } = renderModel({
      title: 'Pi LED',
      components: [
        {
          ref: 'U1',
          kind: 'raspberry_pi',
          value: 'Pi 5',
          nodes: ['NC_U1_1', 'VCC3', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'LED', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'],
        },
        { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VCC3', '0'] },
      ],
    });
    expect(markup).toContain('Raspberry Pi');
    expect(markup).toContain('GPIO17');
    expect(markup).toContain('rsPartPi');
    expect(markup).toContain('BCM2711');
    expect(markup.indexOf('rsPartPi)')).toBeLessThan(markup.indexOf('rs-mcu-wires'));
  });

  it('renders an ESP32 module straddling the trench', () => {
    const { markup } = renderModel({
      title: 'ESP32 LED',
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
    });
    expect(markup).toContain('ESP32');
    expect(markup).toContain('U1');
  });

  it('still renders every classic part body alongside an MCU', () => {
    const { markup } = renderModel({
      title: 'Kitchen sink',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'A'] },
        { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['A', '0'] },
        { ref: 'L1', kind: 'inductor', value: '10uH', nodes: ['A', 'B'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['B', '0'] },
        { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['B', 'A', '0'] },
        { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['A', 'B', 'B', 'VCC', '0'] },
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['NC_U1_1', 'NC_U1_2', '0', 'NC_U1_4', 'A', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
      ],
    });
    ['R1', 'C1', 'L1', 'DLED1', 'Q1', 'XU1', 'ARDUINO'].forEach((label) => {
      expect(markup).toContain(label);
    });
    // Part labels carry a paint-order halo so crossing wires don't strike text.
    expect(markup).toContain('paint-order:stroke');
    // Electrolytic cap polarity glyphs.
    expect(markup).toContain('−');
  });
  it('renders the extended two-lead kinds with dedicated artwork', () => {
    // No voltage source on purpose: the buzzer's "+" must be the only plus
    // glyph in the markup (a battery pack would add its own).
    const { markup } = renderModel({
      title: 'Extended passives',
      components: [
        { ref: 'DZ1', kind: 'zener', value: '5.1V', nodes: ['VCC', 'A'] },
        { ref: 'R1', kind: 'photoresistor', value: '10k', nodes: ['A', 'B'] },
        { ref: 'R2', kind: 'thermistor', value: '10k', nodes: ['B', 'C'] },
        { ref: 'R3', kind: 'buzzer', value: '8ohm', nodes: ['C', 'D'] },
        { ref: 'C1', kind: 'crystal', value: '8MHz', nodes: ['D', 'E'] },
      ],
    });
    expect(markup).toContain('rsPartZener'); // blue-tinted diode glass
    expect(markup).toContain('rsPartLdr'); // LDR ceramic disc
    expect(markup).toContain('NTC'); // thermistor silk
    expect(markup).toContain('>+</text>'); // buzzer polarity mark
    expect(markup).toContain('8MHz'); // crystal prints its own frequency
    expect(markup).not.toContain('url(#rsPartModule)'); // nothing fell back to the gray box
  });

  it('renders 555 and comparator DIPs with part-number silk', () => {
    const { model, markup } = renderModel({
      title: 'DIP kinds',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
        // Empty value exercises the LM393/NE555 fallback silk.
        { ref: 'XU1', kind: 'timer_555', value: '', nodes: ['0', 'TRIG', 'OUT', 'VCC', 'CTRL', 'TRIG', 'DIS', 'VCC'] },
        { ref: 'XU2', kind: 'comparator', value: '', nodes: ['A', 'B', 'O', 'VCC', '0'] },
        { ref: 'U1', kind: 'temp_sensor', value: 'TMP36', nodes: ['VCC', 'A', '0'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['B', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['TRIG', 'DIS'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['O', 'VCC'] },
      ],
    });
    expect(model.parts.find((part) => part.ref === 'XU1').body).toBe('dip');
    expect(model.parts.find((part) => part.ref === 'XU2').body).toBe('dip');
    expect(model.parts.find((part) => part.ref === 'U1').body).toBe('to92');
    expect(markup).toContain('NE555');
    expect(markup).toContain('LM393');
    expect(markup).toContain('TMP36');
  });

  it('renders the phase-2 kinds with dedicated artwork', () => {
    const { model, markup } = renderModel({
      title: 'Phase 2 kinds',
      components: [
        { ref: 'RBTN', kind: 'pushbutton', value: '', nodes: ['A', 'B'] },
        { ref: 'RPOT', kind: 'potentiometer', value: '10k', nodes: ['B', 'W', 'C'] },
        { ref: 'RSW', kind: 'switch_spdt', value: '', nodes: ['C', 'D', 'E'] },
        { ref: 'DRGB', kind: 'rgb_led', value: '', nodes: ['E', 'F', 'G', 'H'] },
        { ref: 'D1', kind: 'seven_segment', value: '5161AS', nodes: ['SA', 'SB', 'SC', 'SD', 'SE', 'SF', 'SG', 'SDP', 'H'] },
      ],
    });
    expect(model.parts.find((part) => part.ref === 'RBTN').body).toBe('pushbutton');
    expect(model.parts.find((part) => part.ref === 'D1').body).toBe('seven_segment');
    expect(model.parts.find((part) => part.ref === 'RPOT').body).toBe('module');
    expect(markup).toContain('url(#rsBluePlastic)'); // potentiometer trimmer body
    expect(markup).toContain('#565b52'); // unlit 7-segment bars
    expect(markup).toContain('skewX(-6)'); // italic digit
    expect(markup).toContain('#3fae5a'); // RGB LED green die
    expect(markup).not.toContain('url(#rsPartModule)'); // nothing fell back to the gray box
  });

  it('renders the on-board sensor modules with dedicated artwork', () => {
    const { markup } = renderModel({
      title: 'Sensor modules',
      components: [
        { ref: 'U1', kind: 'ultrasonic_sensor', value: 'HC-SR04', nodes: ['VCC', 'TRIG', 'ECHO', 'GNDX'] },
        { ref: 'U2', kind: 'dht_sensor', value: 'DHT22', nodes: ['VCC', 'DATA', 'GNDX'] },
        { ref: 'U3', kind: 'oled_display', value: '', nodes: ['VCC', 'GNDX', 'SCL', 'SDA'] },
        { ref: 'U4', kind: 'pir_sensor', value: '', nodes: ['VCC', 'PIROUT', 'GNDX'] },
      ],
    });
    expect(markup).toContain('url(#rsPcbBlue)'); // HC-SR04 PCB
    expect(markup).toContain('HC-SR04');
    expect(markup).toContain('DHT22');
    expect(markup).toContain('SSD1306'); // OLED fallback silk
    expect(markup).toContain('url(#rsPirDome)'); // PIR Fresnel dome
    expect(markup).not.toContain('url(#rsPartModule)'); // nothing fell back to the gray box
  });

  it('renders the off-board peripherals in slots with header pads and wires', () => {
    const { model, markup } = renderModel({
      title: 'Peripherals',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'servo', value: 'SG90', nodes: ['VCC', '0', 'SIG'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['SIG', 'M'] },
        { ref: 'RM1', kind: 'dc_motor', value: '', nodes: ['M', '0'] },
        { ref: 'U2', kind: 'relay_module', value: '', nodes: ['VCC', '0', 'SIG', 'COMX', 'NOX', 'NC_U2_6'] },
      ],
    });
    ['servo', 'dc_motor', 'relay_module'].forEach((kind) => {
      expect(model.parts.find((part) => part.kind === kind).meta.slot).toBeTruthy();
    });
    expect(markup).toContain('Micro Servo');
    expect(markup).toContain('SONGLE');
    expect(markup).toContain('rs-mcu-wires'); // pin wires fan up to the board
    // Terminals are integrated into each body: servo 3-pin connector, motor tab
    // polarity, relay input header + screw-terminal names.
    ['>VCC</text>', '>GND</text>', '>SIG</text>'].forEach((label) => expect(markup).toContain(label));
    expect(markup).toContain('>+</text>'); // motor + tab
    ['>IN</text>', '>COM</text>', '>NO</text>', '>NC</text>'].forEach((label) => expect(markup).toContain(label));
  });

  it('rotates the stepper shaft marker by the sim angle', () => {
    const model = circuitToBreadboard({
      title: 'stepper',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'M1', kind: 'stepper_motor', value: '', nodes: ['VA', 'VB', 'VC', 'VD', 'VCC'] },
      ],
    });
    const part = model.parts.find((p) => p.kind === 'stepper_motor');
    const markup = renderToStaticMarkup(
      <svg><PartDefs /><RealisticPart part={part} sim={{ angle: 90 }} /></svg>,
    );
    expect(markup).toContain('rotate(90 ');
  });

  it('offsets the joystick cap by the sim axis values', () => {
    const model = circuitToBreadboard({
      title: 'joystick',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'J1', kind: 'joystick', value: '', nodes: ['0', 'VCC', 'VX', 'VY', 'VSW'] },
      ],
    });
    const part = model.parts.find((p) => p.kind === 'joystick');
    const markup = renderToStaticMarkup(
      <svg><PartDefs /><RealisticPart part={part} sim={{ x: 1, y: 0 }} /></svg>,
    );
    expect(markup).toContain('translate(8 -8)');
  });

  it('shows the RFID card overlay only while a tap is active', () => {
    const model = circuitToBreadboard({
      title: 'rfid',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        {
          ref: 'RF1', kind: 'rfid_reader', value: '',
          nodes: ['VCC', 'NC_RF1_2', '0', 'NC_RF1_4', 'VMISO', 'VMOSI', 'VSCK', 'VSDA'],
        },
      ],
    });
    const part = model.parts.find((p) => p.kind === 'rfid_reader');
    const idle = renderToStaticMarkup(<svg><PartDefs /><RealisticPart part={part} /></svg>);
    expect(idle).not.toContain('DE AD BE EF');
    const tapped = renderToStaticMarkup(
      <svg><PartDefs /><RealisticPart part={part} sim={{ cardPresent: true, uid: 'DE AD BE EF' }} /></svg>,
    );
    expect(tapped).toContain('DE AD BE EF');
  });

  it('shows the mouse sensor motion readout and pending glow only during sim', () => {
    const model = circuitToBreadboard({
      title: 'mouse',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        {
          ref: 'M1', kind: 'mouse_sensor', value: '',
          nodes: ['NC_M1_1', '0', 'NC_M1_3', 'VNCS', 'VSCK', 'VMOSI', 'VMISO', 'VCC'],
        },
      ],
    });
    const part = model.parts.find((p) => p.kind === 'mouse_sensor');
    const idle = renderToStaticMarkup(<svg><PartDefs /><RealisticPart part={part} /></svg>);
    expect(idle).toContain('PMW3360');
    expect(idle).not.toContain('X 12');
    const running = renderToStaticMarkup(
      <svg><PartDefs /><RealisticPart part={part} sim={{ x: 12, y: -3, pending: true }} /></svg>,
    );
    expect(running).toContain('X 12  Y -3');
    expect(running).toContain('url(#rsGlow)');
  });

  it('anchors peripheral pads on their body terminals but keeps MCU pads collinear', () => {
    const slot = { x: 0, y: 0, width: 448, height: 120 };
    // Peripherals: pads sit on the body (servo top-edge connector at y=58,
    // motor tabs flanking the can center, relay input header vs. screw block).
    expect(mcuPadPoint(slot, 0, 'servo')).toEqual({ x: 74, y: 58 });
    expect(mcuPadPoint(slot, 0, 'dc_motor').y).toBeLessThan(mcuPadPoint(slot, 1, 'dc_motor').y);
    expect(mcuPadPoint(slot, 2, 'relay_module').y).toBe(40); // IN on the top edge
    expect(mcuPadPoint(slot, 3, 'relay_module').x).toBeGreaterThan(mcuPadPoint(slot, 2, 'relay_module').x); // COM on the screw side
    // MCU boards are untouched: every pad stays on the collinear y=18 row their
    // board rect is drawn around.
    ['arduino_uno', 'raspberry_pi', 'esp32'].forEach((kind) => {
      expect(mcuPadPoint(slot, 0, kind).y).toBe(18);
      expect(mcuPadPoint(slot, 5, kind).y).toBe(18);
    });
  });

  it('renders the tier-1 off-board modules with their own bodies', () => {
    const { model, markup } = renderModel({
      title: 'Tier-1 peripherals',
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'DATA', 'NC_U1_12', 'SIN1', 'SIN2', 'SIN3', 'SIN4', 'NC_U1_17', 'NC_U1_18', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'SDA', 'SCL'],
        },
        { ref: 'U2', kind: 'stepper_driver', value: 'ULN2003', nodes: ['SIN1', 'SIN2', 'SIN3', 'SIN4', 'VCC5', '0', 'COILA', 'COILB', 'COILC', 'COILD'] },
        { ref: 'M1', kind: 'stepper_motor', value: '', nodes: ['COILA', 'COILB', 'COILC', 'COILD', 'VCC5'] },
        { ref: 'U3', kind: 'lcd_display', value: '', nodes: ['0', 'VCC5', 'SDA', 'SCL'] },
        { ref: 'LS1', kind: 'led_strip', value: 'WS2812', nodes: ['VCC5', 'DATA', '0'] },
      ],
    });
    ['stepper_driver', 'stepper_motor', 'lcd_display', 'led_strip'].forEach((kind) => {
      const part = model.parts.find((candidate) => candidate.kind === kind);
      expect(part.body).toBe(kind);
      expect(part.meta.slot).toBeTruthy();
    });
    expect(markup).toContain('28BYJ-48'); // stepper can silk
    expect(markup).toContain('LCD1602 I2C'); // LCD fallback silk
    expect(markup).toContain('NeoPixel strip'); // OffboardModuleBody subtitle
    expect(markup).toContain('Stepper driver');
    expect(markup).toContain('rs-mcu-wires');
    // Pad names come from the fixedPins contract.
    ['>IN1</text>', '>OUTA</text>', '>SDA</text>', '>DIN</text>', '>COM</text>'].forEach((label) =>
      expect(markup).toContain(label));
  });

  it('renders the L298N with its control header and screw-block outputs', () => {
    const { markup } = renderModel({
      title: 'Motor driver',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '6V', nodes: ['VMOT', '0'] },
        { ref: 'U2', kind: 'motor_driver', value: '', nodes: ['VMOT', '0', 'ENA', 'MIN1', 'MIN2', 'NC_U2_6', 'NC_U2_7', 'NC_U2_8', 'MA', 'MB', 'NC_U2_11', 'NC_U2_12'] },
        { ref: 'RM1', kind: 'dc_motor', value: '', nodes: ['MA', 'MB'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['MIN1', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['MIN2', '0'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['ENA', '0'] },
      ],
    });
    expect(markup).toContain('L298N'); // fallback silk
    ['>VS</text>', '>ENA</text>', '>IN1</text>', '>OUT1</text>', '>OUT2</text>'].forEach((label) =>
      expect(markup).toContain(label));
    // Control pads are collinear on the top edge; OUT pads sit on the side blocks.
    const slot = { x: 0, y: 0, width: 448, height: 120 };
    expect(mcuPadPoint(slot, 0, 'motor_driver').y).toBe(40);
    expect(mcuPadPoint(slot, 7, 'motor_driver').y).toBe(40);
    expect(mcuPadPoint(slot, 8, 'motor_driver').x).toBeLessThan(mcuPadPoint(slot, 0, 'motor_driver').x);
    expect(mcuPadPoint(slot, 10, 'motor_driver').x).toBeGreaterThan(mcuPadPoint(slot, 7, 'motor_driver').x);
  });

  it('renders the tier-2 off-board modules with their own bodies', () => {
    const { model, markup } = renderModel({
      title: 'Tier-2 peripherals',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'U1', kind: 'keypad', value: '4x4', nodes: ['K1', 'NC_U1_2', 'NC_U1_3', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8'] },
        { ref: 'U2', kind: 'joystick', value: '', nodes: ['0', 'VCC', 'JX', 'NC_U2_4', 'NC_U2_5'] },
        { ref: 'U3', kind: 'rfid_reader', value: '', nodes: ['VCC', 'NC_U3_2', '0', 'NC_U3_4', 'NC_U3_5', 'NC_U3_6', 'NC_U3_7', 'RR'] },
        { ref: 'RCS1', kind: 'current_sensor', value: '', nodes: ['M1', 'M2', 'VCC', 'NC_RCS1_4', '0'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['K1', 'VCC'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['JX', '0'] },
        { ref: 'R3', kind: 'resistor', value: '10k', nodes: ['RR', 'VCC'] },
        { ref: 'R4', kind: 'resistor', value: '10', nodes: ['M1', 'M2'] },
      ],
    });
    ['keypad', 'joystick', 'rfid_reader', 'current_sensor'].forEach((kind) => {
      const part = model.parts.find((candidate) => candidate.kind === kind);
      expect(part.body, kind).toBe(kind);
      expect(part.meta.slot, kind).toBeTruthy();
    });
    // Keypad legend digits + joystick default silk + OffboardModuleBody silk.
    ['>1</text>', '>9</text>', '>*</text>', '>#</text>', '>D</text>'].forEach((digit) =>
      expect(markup).toContain(digit));
    expect(markup).toContain('KY-023');
    expect(markup).toContain('RFID reader');
    expect(markup).toContain('Current sensor');
    ['>R1</text>', '>C4</text>', '>VRX</text>', '>IP+</text>', '>IP-</text>'].forEach((label) =>
      expect(markup).toContain(label));
  });

  it('falls back to the labeled module box for unknown kinds', () => {
    const { markup } = renderModel({
      title: 'Mystery',
      components: [{ ref: 'U9', kind: 'mystery_widget', value: '???', nodes: ['A', 'B', 'C'] }],
    });
    expect(markup).toContain('url(#rsPartModule)');
    expect(markup).toContain('U9');
  });
});

describe('library part thumbnails', () => {
  it('renders a non-empty artwork SVG for every registry kind', () => {
    ALLOWED_KINDS.forEach((kind) => {
      const markup = renderToStaticMarkup(<PartThumbnail kind={kind} />);
      expect(markup, kind).toContain('realistic-part-thumb');
      expect(markup, kind).toMatch(/viewBox="[^"]+"/);
      // More than just the defs block: the body artwork actually rendered.
      expect(markup.split('</defs>')[1].length, kind).toBeGreaterThan(50);
    });
  });

  it('shows the real artwork, not generic glyphs', () => {
    expect(renderToStaticMarkup(<PartThumbnail kind="resistor" />)).toContain('url(#rsPartResistor)');
    expect(renderToStaticMarkup(<PartThumbnail kind="arduino_uno" />)).toContain('ARDUINO');
    expect(renderToStaticMarkup(<PartThumbnail kind="timer_555" />)).toContain('NE555');
    expect(renderToStaticMarkup(<PartThumbnail kind="pir_sensor" />)).toContain('url(#rsPirDome)');
    expect(renderToStaticMarkup(<PartThumbnail kind="voltage_source" />)).toContain('url(#rsPartBattery)');
    expect(renderToStaticMarkup(<PartThumbnail kind="shift_register" />)).toContain('74HC595');
    expect(renderToStaticMarkup(<PartThumbnail kind="lcd_display" />)).toContain('LCD1602 I2C');
    expect(renderToStaticMarkup(<PartThumbnail kind="stepper_motor" />)).toContain('28BYJ-48');
    expect(renderToStaticMarkup(<PartThumbnail kind="motor_driver" />)).toContain('L298N');
    expect(renderToStaticMarkup(<PartThumbnail kind="rotary_encoder" />)).toContain('KY-040');
    expect(renderToStaticMarkup(<PartThumbnail kind="imu_sensor" />)).toContain('MPU-6050');
    expect(renderToStaticMarkup(<PartThumbnail kind="optocoupler" />)).toContain('PC817');
    expect(renderToStaticMarkup(<PartThumbnail kind="adc_module" />)).toContain('MCP3008');
    expect(renderToStaticMarkup(<PartThumbnail kind="keypad" />)).toContain('>*</text>');
    expect(renderToStaticMarkup(<PartThumbnail kind="rfid_reader" />)).toContain('RC522');
    expect(renderToStaticMarkup(<PartThumbnail kind="mouse_sensor" />)).toContain('PMW3360');
    expect(renderToStaticMarkup(<PartThumbnail kind="schottky" />)).toContain('url(#rsPartSchottky)');
    expect(renderToStaticMarkup(<PartThumbnail kind="bridge_rectifier" />)).toContain('DB107');
    expect(renderToStaticMarkup(<PartThumbnail kind="solar_panel" />)).toContain('url(#rsPartSolar)');
  });

  it('renders the regulator thumbnail with three TO-220 leads', () => {
    const markup = renderToStaticMarkup(<PartThumbnail kind="regulator" />);
    const body = markup.split('</defs>')[1];
    expect(body.match(/<path /g)).toHaveLength(3);
    expect(body).toContain('7805');
  });
});

describe('jumper wire geometry', () => {
  const controlPoints = (jumper) => {
    const markup = renderToStaticMarkup(<svg><JumperWire jumper={jumper} /></svg>);
    const [, ax, ay, c1x, c1y, c2x, c2y, bx, by] =
      /M ([\d.-]+) ([\d.-]+) C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+)/.exec(markup);
    return { a: { x: +ax, y: +ay }, c1: { x: +c1x, y: +c1y }, c2: { x: +c2x, y: +c2y }, b: { x: +bx, y: +by } };
  };

  it('bows a same-column rail-to-strip stub sideways within its vertical range', () => {
    const { a, c1, c2, b } = controlPoints({
      id: 'j1', net: 'X', color: '#000',
      from: { strip: 'railTopMinus', column: 5, row: 0 },
      to: { strip: 'top', column: 5, row: 0 },
    });
    // Sideways bow (no straight vertical line) …
    expect(c1.x).toBeGreaterThan(a.x);
    expect(c2.x).toBeGreaterThan(b.x);
    // … and no overshoot past the rails above or the strip below.
    const [top, bottom] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    expect(c1.y).toBeGreaterThanOrEqual(top);
    expect(c1.y).toBeLessThanOrEqual(bottom);
    expect(c2.y).toBeGreaterThanOrEqual(top);
    expect(c2.y).toBeLessThanOrEqual(bottom);
  });

  it('bows a same-column rail-to-rail bridge left into the board', () => {
    const { a, c1, c2, b } = controlPoints({
      id: 'j2', net: '0', color: '#1f1f1f',
      from: { strip: 'railTopMinus', column: 30, row: 0 },
      to: { strip: 'railBottomMinus', column: 30, row: 0 },
    });
    expect(c1.x).toBeLessThan(a.x);
    expect(c2.x).toBeLessThan(b.x);
  });
});
