import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSpice } from '../../src/core/pcbGenerator.js';
import {
  AI_RESPONSE_SCHEMA,
  CIRCUIT_SCHEMA,
  buildOllamaRequestBody,
  parseCircuitResponse,
  streamCircuitWithOllama,
  streamOpenAiCompatibleContent,
} from './ollamaProvider.js';

const validCircuit = {
  title: 'RC Filter',
  type: 'low_pass',
  supplyVoltage: 5,
  nodes: ['IN', 'OUT', '0'],
  components: [
    {
      ref: 'R1',
      kind: 'resistor',
      value: '1k',
      nodes: ['IN', 'OUT'],
      footprint: 'Resistor_THT:R_Axial',
    },
  ],
  notes: [],
};

const validAiResponse = {
  reply: 'I built an RC filter with R1 between IN and OUT.',
  circuit: validCircuit,
  spice: '* RC Filter\nR1 IN OUT 1k\n.end',
};

// parseCircuitResponse always adds a code field ('' when the AI omits it).
// The stream/generate wrappers additionally attach issues + generation
// metadata, so resolved values are asserted with toMatchObject.
const parsedAiResponse = { ...validAiResponse, code: '' };

const ESP32_PINS = ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'];
const esp32Nodes = (pins: Record<string, string>) =>
  ESP32_PINS.map((name, index) => pins[name] || `NC_U1_${index + 1}`);

// The field bug the topology gate exists for: perfect net continuity, no
// transistor driver — R2 is a fixed divider to ground on GPIO2's net while
// the buzzer is fed straight from 3V3.
const buzzerBugCircuit = {
  title: 'Buzzer bug',
  type: 'buzzer',
  supplyVoltage: 3.3,
  nodes: ['3V3', 'BUZZER', '0'],
  components: [
    { ref: 'U1', kind: 'esp32', value: 'DevKit V1', nodes: esp32Nodes({ '3V3': '3V3', GND: '0', GPIO2: 'BUZZER' }), footprint: '' },
    { ref: 'R2', kind: 'resistor', value: '330', nodes: ['BUZZER', '0'], footprint: '' },
    { ref: 'RBZ1', kind: 'buzzer', value: '100', nodes: ['3V3', 'BUZZER'], footprint: '' },
  ],
  notes: [],
};

const buzzerFixedCircuit = {
  title: 'Buzzer driver',
  type: 'buzzer',
  supplyVoltage: 3.3,
  nodes: ['3V3', 'CTRL', 'BASE', 'BZLOW', '0'],
  components: [
    { ref: 'U1', kind: 'esp32', value: 'DevKit V1', nodes: esp32Nodes({ '3V3': '3V3', GND: '0', GPIO2: 'CTRL' }), footprint: '' },
    { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'], footprint: '' },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['BZLOW', 'BASE', '0'], footprint: '' },
    { ref: 'RBZ1', kind: 'buzzer', value: '100', nodes: ['3V3', 'BZLOW'], footprint: '' },
  ],
  notes: [],
};

// Reversed LEDs (each with a series resistor) trip exactly one led_polarity
// error apiece — a convenient dial for best-candidate selection tests.
const reversedLedCircuit = (title: string, ledCount: number) => ({
  title,
  type: 'led_demo',
  supplyVoltage: 5,
  nodes: ['VCC', '0', ...Array.from({ length: ledCount }, (_, index) => `LEDA${index + 1}`)],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
    ...Array.from({ length: ledCount }, (_, index) => [
      { ref: `R${index + 1}`, kind: 'resistor', value: '330', nodes: [`LEDA${index + 1}`, '0'], footprint: '' },
      { ref: `DLED${index + 1}`, kind: 'led', value: 'red', nodes: [`LEDA${index + 1}`, 'VCC'], footprint: '' },
    ]).flat(),
  ],
  notes: [],
});

const aiResponseFor = (circuit: Record<string, unknown>, reply = 'Here is the circuit.') => JSON.stringify({
  reply,
  circuit,
  spice: toSpice(circuit),
});

const opampCircuit = {
  title: 'Op Amp Buffer',
  type: 'opamp_buffer',
  supplyVoltage: 5,
  nodes: ['VINP', 'VINN', 'VOUT', 'VCC', '0'],
  components: [
    {
      ref: 'XU1',
      kind: 'opamp',
      value: 'LM358',
      nodes: ['VINP', 'VINN', 'VOUT', 'VCC', '0'],
      footprint: 'Package_DIP:DIP-8_W7.62mm',
    },
  ],
  notes: [],
};

const sourceCircuit = {
  title: 'Source Test',
  type: 'source_test',
  supplyVoltage: 5,
  nodes: ['VIN', '0'],
  components: [
    {
      ref: 'V1',
      kind: 'voltage_source',
      value: '1V',
      nodes: ['VIN', '0'],
      footprint: '',
    },
  ],
  notes: [],
};

const rgbLedCircuit = {
  title: 'RGB LED demo',
  type: 'rgb_led_demo',
  supplyVoltage: 5,
  nodes: ['VCC', 'ANO_R', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
    { ref: 'R1', kind: 'resistor', value: '220', nodes: ['VCC', 'ANO_R'], footprint: '' },
    {
      ref: 'DLED1',
      kind: 'rgb_led',
      value: 'RGB',
      nodes: ['ANO_R', 'NC_DLED1_2', 'NC_DLED1_3', '0'],
      footprint: '',
    },
  ],
  notes: [],
};

// The classic small-model mistake: one plain diode line instead of the
// derived DLED1_R/_G/_B compound expansion.
const rgbLedBadSpiceResponse = {
  reply: 'I wired the red channel of the RGB LED through R1.',
  circuit: rgbLedCircuit,
  spice: '* rgb\nV1 VCC 0 DC 5\nR1 VCC ANO_R 220\nDLED1 ANO_R 0 DRED\n.end',
};

const circuitWithLoad = {
  ...validCircuit,
  title: 'RC Filter With Load',
  components: [
    ...validCircuit.components,
    {
      ref: 'RLOAD',
      kind: 'load',
      value: '10k',
      nodes: ['OUT', '0'],
      footprint: 'Resistor_THT:R_Axial',
    },
  ],
};

const streamResponse = (content: string) => new Response(
  `${JSON.stringify({ message: { content } })}\n`,
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
);

const openAiResponse = (content: string | unknown[]) => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ollama circuit output', () => {
  it('requests schema-constrained deterministic output with a larger context window', () => {
    const body = buildOllamaRequestBody('Make an RC filter', [], true);

    expect(body.format).toEqual(AI_RESPONSE_SCHEMA);
    expect((body.format as any).properties.circuit).toEqual(CIRCUIT_SCHEMA);
    expect(body.options).toMatchObject({ num_ctx: 8192, num_predict: 4096, temperature: 0 });
    expect((body.format as any).properties.circuit.properties.schematic).toBeTruthy();
    expect(body.messages[0].content).toContain('opamp components must use value LM358');
    expect(body.messages[0].content).toContain('Use voltage_source for DC supplies');
    expect(body.messages[0].content).toContain('Omit schematic unless');
    expect(body.messages[1].content).toContain('A SPICE line like `V1 VIN 0 DC 1` must match a JSON `voltage_source`');
    expect(body.messages[1].content).toContain('Schematic Intent Metadata');
    expect(body.messages.at(-1)!.content).toContain('use LM358 as the SPICE subcircuit name');
    expect(body.messages.at(-1)!.content).toContain('use voltage_source for DC values');
    expect(body.messages.at(-1)!.content).toContain('Only include circuit.schematic');
    expect(body.messages.at(-1)!.content).toContain('Omit netRoles, componentRoles, and blocks');
    expect(body.messages.at(-1)!.content).not.toContain('"schematic":{"version"');
  });

  it('orders memory, canonical design, recent turns, and the new request', () => {
    const history = Array.from({ length: 15 }, (_, index) => ({
      role: 'user' as const,
      content: `Requirement ${index + 1}`,
    }));
    const body = buildOllamaRequestBody(
      'Change R1 to 2.2k',
      history,
      true,
      { circuit: validCircuit as any, spice: 'R1 IN OUT 1k', kicadNetlist: '<export />' },
      { summary: 'Use through-hole parts and keep the output node named OUT.', updatedAt: 10 },
    );

    expect(body.messages[1].content).toContain('Additional circuit design rules');
    expect(body.messages.find((message) => message.content.includes('Active chat memory'))?.content).toContain(
      'Use through-hole parts',
    );
    expect(body.messages.find((message) => message.content.includes('exact canonical current design'))?.content)
      .toContain('R1 IN OUT 1k');
    expect(body.messages.find((message) => message.content.includes('Requirement 4'))?.content)
      .toContain('Previous circuit request');
    expect(body.messages.at(-1)!.content).toContain('Change R1 to 2.2k');
    expect(body.messages.at(-1)!.content).toContain('Replace the whole circuit only');
    expect(body.messages.filter((message) => message.content.includes('Previous circuit request'))).toHaveLength(12);
  });

  it('includes current component inventory and load aliases for follow-up edits', () => {
    const body = buildOllamaRequestBody(
      'remove Rload',
      [],
      true,
      { circuit: circuitWithLoad as any, spice: 'R1 IN OUT 1k\nRLOAD OUT 0 10k', kicadNetlist: '<export />' },
    );

    const revisionContext = body.messages.find((message) => message.content.includes('Current component inventory'));
    expect(revisionContext!.content).toContain('RLOAD: load, value=10k, nodes=OUT - 0');
    expect(revisionContext!.content).toContain('Rload');
    expect(revisionContext!.content).toContain('load resistor');
    expect(revisionContext!.content).toContain('modify or remove that existing component');
  });

  it('does not attach memory or revision context to a new chat', () => {
    const body = buildOllamaRequestBody('Make a new filter', [], true, null, null);

    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toContain('Additional circuit design rules');
    expect(body.messages.some((message) => message.content.includes('Active chat memory'))).toBe(false);
    expect(body.messages.some((message) => message.content.includes('canonical current design'))).toBe(false);
  });

  it('validates AI response envelopes and returns the canonical circuit', () => {
    expect(parseCircuitResponse(JSON.stringify(validAiResponse))).toEqual(parsedAiResponse);
  });

  it('accepts optional schematic intent metadata in AI responses', () => {
    const response = parseCircuitResponse(JSON.stringify({
      ...validAiResponse,
      circuit: {
        ...validCircuit,
        schematic: {
          version: 1,
          topology: 'rc_filter',
          primaryRef: '',
          externalTerminals: [
            { net: 'IN', label: 'VIN', type: 'input', side: 'left' },
            { net: 'OUT', label: 'VOUT', type: 'output', side: 'right' },
          ],
          netRoles: [
            { net: 'IN', role: 'input', side: 'left' },
            { net: 'OUT', role: 'output', side: 'right' },
          ],
          componentRoles: [
            { ref: 'R1', role: 'input_network', block: 'filter', side: 'left', orientation: 'horizontal', order: 1 },
          ],
          blocks: [
            { id: 'filter', role: 'filter', refs: ['R1'], side: 'center', order: 1 },
          ],
        },
      },
    }));

    expect(response.circuit.schematic!.externalTerminals).toHaveLength(2);
    expect(response.circuit.schematic!.componentRoles[0]).toMatchObject({ ref: 'R1', role: 'input_network' });
  });

  it('normalizes generic op amp aliases to the canonical LM358 model', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'GENERIC' }],
      },
      spice: '* op amp\nXU1 VINP VINN VOUT VCC 0 OPAMP\n.end',
    }));

    expect(response.circuit.components.find((part) => part.ref === 'XU1')!.value).toBe('LM358');
  });

  it('accepts LM358 SPICE when the op amp JSON used an alias', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'OPAMP' }],
      },
      spice: '* op amp\nXU1 VINP VINN VOUT VCC 0 LM358\n.end',
    }));

    expect(response.circuit.components.find((part) => part.ref === 'XU1')!.value).toBe('LM358');
  });

  it('teaches the MCU kinds and pin contracts in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    ['arduino_uno', 'raspberry_pi', 'esp32'].forEach((kind) => expect(kinds).toContain(kind));
    const body = buildOllamaRequestBody('Blink an LED with an Arduino', [], true);
    expect(body.messages[0].content).toContain('arduino_uno (24 nodes)');
    expect(body.messages[0].content).toContain('raspberry_pi (14 nodes)');
    expect(body.messages[0].content).toContain('esp32 (12 nodes)');
    expect(body.messages[0].content).toContain('never write a SPICE line for them');
  });

  it('teaches the tier-1 module kinds in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    ['stepper_motor', 'stepper_driver', 'motor_driver', 'lcd_display', 'rotary_encoder', 'led_strip', 'imu_sensor', 'ir_receiver', 'shift_register']
      .forEach((kind) => expect(kinds).toContain(kind));
    const body = buildOllamaRequestBody('Spin a stepper with an Arduino', [], true);
    const prompt = body.messages[0].content;
    // Fixed-pin contracts auto-derive from the registry.
    expect(prompt).toContain('stepper_driver (10 nodes)');
    expect(prompt).toContain('motor_driver (12 nodes)');
    expect(prompt).toContain('shift_register (16 nodes)');
    // Manual driver-rule prose and firmware library guidance.
    expect(prompt).toContain('always add a stepper_driver');
    expect(prompt).toContain('never a GPIO pin');
    expect(prompt).toContain('LiquidCrystal_I2C');
    expect(prompt).toContain('Adafruit_NeoPixel');
  });

  it('teaches the IR discrete parts in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    ['ir_led', 'ir_phototransistor'].forEach((kind) => expect(kinds).toContain(kind));
    const body = buildOllamaRequestBody('Build an IR beam-break sensor', [], true);
    const prompt = body.messages[0].content;
    expect(prompt).toContain('.model DIR');
    expect(prompt).toContain('ir_phototransistor');
    // Steers demodulated remote-control asks to the TSOP module instead.
    expect(prompt).toContain('ir_receiver');
  });

  it('rejects a wiring-only module whose nodes array has the wrong length', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'Motor driver circuit.',
      circuit: {
        title: 'Motor driver',
        type: 'motor',
        supplyVoltage: 5,
        nodes: ['VCC5', 'MIN1', 'MIN2', 'MA', 'MB', '0'],
        components: [
          { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC5', '0'], footprint: '' },
          { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['MIN1', '0'], footprint: '' },
          { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['MIN2', '0'], footprint: '' },
          // 11 nodes instead of the fixed 12.
          { ref: 'U2', kind: 'motor_driver', value: 'L298N', nodes: ['VCC5', '0', 'NC_U2_3', 'MIN1', 'MIN2', 'NC_U2_6', 'NC_U2_7', 'NC_U2_8', 'MA', 'MB', 'NC_U2_11'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Motor driver\nV1 VCC5 0 DC 5\nR1 MIN1 0 1k\nR2 MIN2 0 1k\n* U2 motor_driver (wiring-only)\n.end',
    }))).toThrowError(expect.objectContaining({
      code: 'schema_validation',
      message: expect.stringContaining('exactly 12 nodes for kind motor_driver'),
    }));
  });

  it('rejects a buck_converter whose nodes array has the wrong length', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'Buck converter circuit.',
      circuit: {
        title: 'Buck converter',
        type: 'power',
        supplyVoltage: 12,
        nodes: ['VIN', 'VOUT', '0'],
        components: [
          { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VIN', '0'], footprint: '' },
          // 4 nodes instead of the fixed 5 [VIN, OUT, GND, FB, ON_OFF].
          { ref: 'U1', kind: 'buck_converter', value: 'LM2596-5.0', nodes: ['VIN', 'VOUT', '0', 'VOUT'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Buck converter\nV1 VIN 0 DC 12\nVU1 VOUT 0 DC 5\n.end',
    }))).toThrowError(expect.objectContaining({
      code: 'schema_validation',
      message: expect.stringContaining('exactly 5 nodes for kind buck_converter in the order [VIN, OUT, GND, FB, ON_OFF]'),
    }));
  });

  it('teaches the buck_converter kind and canonical wiring in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    expect(kinds).toContain('buck_converter');
    const body = buildOllamaRequestBody('Step 12V down to 5V with a buck converter', [], true);
    const prompt = body.messages[0].content;
    // Fixed-pin contract auto-derives from the registry.
    expect(prompt).toContain('buck_converter (5 nodes): VIN, OUT, GND, FB, ON_OFF');
    // Manual canonical-wiring rule.
    expect(prompt).toContain('LM2596');
    expect(prompt).toContain('inductor (33uH to 100uH)');
    expect(prompt).toContain('schottky catch diode from 0 to the OUT net');
    expect(prompt).toContain('at least 2V above the output');
  });

  it('teaches the tier-2 module kinds in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    ['optocoupler', 'current_sensor', 'keypad', 'joystick', 'rtc_module', 'sd_card', 'rfid_reader', 'mouse_sensor', 'soil_moisture', 'gas_sensor', 'baro_sensor', 'adc_module']
      .forEach((kind) => expect(kinds).toContain(kind));
    const body = buildOllamaRequestBody('Read soil moisture on a Pi', [], true);
    const prompt = body.messages[0].content;
    expect(prompt).toContain('optocoupler (4 nodes)');
    expect(prompt).toContain('adc_module (16 nodes)');
    expect(prompt).toContain('PC817 as the SPICE subcircuit name');
    expect(prompt).toContain('raspberry_pi has no analog inputs');
    expect(prompt).toContain('<REF>_S');
    expect(prompt).toContain('MFRC522');
    expect(prompt).toContain('PMW3360');
  });

  it('rejects a legacy 10-node raspberry_pi in fresh AI output', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'Pi blink.',
      circuit: {
        title: 'Pi blink',
        type: 'mcu_led',
        supplyVoltage: 3.3,
        nodes: ['LED', 'LEDK', '0'],
        components: [
          { ref: 'U1', kind: 'raspberry_pi', value: 'Pi 4', nodes: ['NC_U1_1', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'LED', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'], footprint: '' },
          { ref: 'R1', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'], footprint: '' },
          { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Pi blink\nR1 LED LEDK 330\nDLED1 LEDK 0 DRED\n* U1 raspberry_pi (microcontroller board, not simulated)\n.end',
    }))).toThrowError(expect.objectContaining({
      code: 'schema_validation',
      message: expect.stringContaining('exactly 14 nodes for kind raspberry_pi'),
    }));
  });

  it('accepts an optocoupler deck and normalizes value aliases to PC817', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'Opto isolation stage around XU1.',
      circuit: {
        title: 'Opto stage',
        type: 'isolation',
        supplyVoltage: 5,
        nodes: ['CTRL', 'ANO', 'V12', 'BZLOW', '0'],
        components: [
          { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['V12', '0'], footprint: '' },
          { ref: 'V2', kind: 'voltage_source', value: '3.3V', nodes: ['CTRL', '0'], footprint: '' },
          { ref: 'R1', kind: 'resistor', value: '330', nodes: ['CTRL', 'ANO'], footprint: '' },
          { ref: 'XU1', kind: 'optocoupler', value: 'OPTOCOUPLER', nodes: ['ANO', '0', '0', 'BZLOW'], footprint: '' },
          { ref: 'RBZ1', kind: 'buzzer', value: '100', nodes: ['V12', 'BZLOW'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Opto stage\nV1 V12 0 DC 12\nV2 CTRL 0 DC 3.3\nR1 CTRL ANO 330\nXU1 ANO 0 0 BZLOW PC817\nRBZ1 V12 BZLOW 100\n.end',
    }));
    expect(response.circuit.components.find((part) => part.ref === 'XU1')!.value).toBe('PC817');
  });

  it('accepts a current sensor written only as its derived shunt line', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'Current sensing on the motor loop with RCS1.',
      circuit: {
        title: 'Current sense',
        type: 'measurement',
        supplyVoltage: 5,
        nodes: ['VCC', 'MTOP', '0'],
        components: [
          { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
          { ref: 'RCS1', kind: 'current_sensor', value: 'ACS712', nodes: ['VCC', 'MTOP', 'VCC', 'NC_RCS1_4', '0'], footprint: '' },
          { ref: 'RM1', kind: 'dc_motor', value: '12', nodes: ['MTOP', '0'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Current sense\nV1 VCC 0 DC 5\nRCS1_S VCC MTOP 0.0012\nRM1 MTOP 0 12\n.end',
    }));
    expect(response.circuit.components.find((part) => part.ref === 'RCS1')!.kind).toBe('current_sensor');
  });

  it('teaches the tier-3 kinds in the schema and prompt', () => {
    const kinds = CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum as readonly string[];
    ['schottky', 'bridge_rectifier', 'fuse', 'vibration_motor', 'sound_sensor', 'hall_sensor', 'solar_panel']
      .forEach((kind) => expect(kinds).toContain(kind));
    const body = buildOllamaRequestBody('Solar powered night light', [], true);
    const prompt = body.messages[0].content;
    expect(prompt).toContain('schottky as D with the DSCH model');
    expect(prompt).toContain('bridge_rectifier (4 nodes)');
    expect(prompt).toContain('<REF>_A AC1 V+ DGEN');
    expect(prompt).toContain('or solar_panel when the user asks for solar power');
    expect(prompt).toContain('including vibration motors');
    expect(prompt).toContain('open-collector');
  });

  it('accepts a bridge rectifier written only as derived diode lines', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'AC to DC rectifier around DB1.',
      circuit: {
        title: 'Rectifier',
        type: 'power',
        supplyVoltage: 6,
        nodes: ['AC1N', 'AC2N', 'DCP', 'DCM'],
        components: [
          { ref: 'V1', kind: 'signal_source', value: 'SINE(0 6 50)', nodes: ['AC1N', 'AC2N'], footprint: '' },
          { ref: 'DB1', kind: 'bridge_rectifier', value: 'DB107', nodes: ['AC1N', 'AC2N', 'DCP', 'DCM'], footprint: '' },
          { ref: 'C1', kind: 'capacitor', value: '100u', nodes: ['DCP', 'DCM'], footprint: '' },
        ],
        notes: [],
      },
      spice: '* Rectifier\nV1 AC1N AC2N SINE(0 6 50)\nDB1_A AC1N DCP DGEN\nDB1_B AC2N DCP DGEN\nDB1_C DCM AC1N DGEN\nDB1_D DCM AC2N DGEN\nC1 DCP DCM 100u\n.end',
    }));
    expect(response.circuit.components.find((part) => part.ref === 'DB1')!.kind).toBe('bridge_rectifier');
  });

  it('declares the optional firmware code field and teaches it in the prompt', () => {
    expect((AI_RESPONSE_SCHEMA.properties as any).code).toEqual({ type: 'string' });
    expect(AI_RESPONSE_SCHEMA.required).not.toContain('code');
    const body = buildOllamaRequestBody('Blink an LED with an Arduino', [], true);
    expect(body.messages[0].content).toContain('top-level "code" field');
    expect(body.messages[0].content).toContain('gpiozero');
    expect(body.messages[0].content).toContain('setup() and loop()');
    expect(body.messages.at(-1)!.content).toContain('add a top-level "code" field');
  });

  it('passes firmware code through and strips accidental Markdown fences', () => {
    const withCode = parseCircuitResponse(JSON.stringify({
      ...validAiResponse,
      code: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}',
    }));
    expect(withCode.code).toBe('void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}');

    const fenced = parseCircuitResponse(JSON.stringify({
      ...validAiResponse,
      code: '```cpp\nvoid setup() {}\n```',
    }));
    expect(fenced.code).toBe('void setup() {}');
  });

  it('accepts an MCU circuit whose SPICE deck omits the board', () => {
    const mcuCircuit = {
      title: 'Uno blink',
      type: 'mcu_led',
      supplyVoltage: 5,
      nodes: ['LED', 'LEDK', '0'],
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          // Canonical 24-pin order: GND@2, D13@17 drives the LED.
          nodes: ['NC_U1_1', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14', 'NC_U1_15', 'NC_U1_16', 'NC_U1_17', 'LED', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24'],
          footprint: 'Module:Arduino_UNO_R3',
        },
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'], footprint: '' },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'], footprint: '' },
      ],
      notes: [],
    };
    const sketch = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(1000); digitalWrite(13, LOW); delay(1000); }';
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I wired an LED to the Arduino Uno pin D13 through RLED.',
      circuit: mcuCircuit,
      spice: '* Uno blink\nRLED LED LEDK 330\nDLED1 LEDK 0 DRED\n.end',
      code: sketch,
    }));

    expect(response.circuit.components.find((part) => part.ref === 'U1')!.kind).toBe('arduino_uno');
    expect(response.code).toBe(sketch);
  });

  it('still rejects op amp SPICE when the nodes differ from the JSON circuit', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'GENERIC' }],
      },
      spice: '* wrong op amp output\nXU1 VINP VINN VDIFF VCC 0 OPAMP\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('normalizes a DC V-source JSON signal_source to voltage_source', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built a 1 V DC source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'signal_source',
          value: 'DC 1',
        }],
      },
      spice: '* source\nV1 VIN 0 DC 1\n.end',
    }));

    const source = response.circuit.components.find((part) => part.ref === 'V1')!;
    expect(source.kind).toBe('voltage_source');
    expect(source.value).toBe('1V');
  });

  it('normalizes a waveform V-source JSON voltage_source to signal_source', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built a sine source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'voltage_source',
          value: 'SINE(0 1 1k)',
        }],
      },
      spice: '* source\nV1 VIN 0 SINE(0 1 1k)\n.end',
    }));

    const source = response.circuit.components.find((part) => part.ref === 'V1')!;
    expect(source.kind).toBe('signal_source');
    expect(source.value).toBe('SINE(0 1 1k)');
  });

  it('still rejects source SPICE when nodes differ from the JSON circuit', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'I built a 1 V DC source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'signal_source',
          value: 'DC 1',
        }],
      },
      spice: '* wrong source node\nV1 VWRONG 0 DC 1\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('teaches the compound-part derived SPICE line contract in the prompt', () => {
    const body = buildOllamaRequestBody('Make an RGB LED circuit', [], true);
    expect(body.messages[0].content).toContain('never appear in SPICE as one element line with their bare ref');
    expect(body.messages[0].content).toContain('"<REF>_R R_ANODE CATHODE DRED"');
    expect(body.messages[0].content).toContain('"<REF>_A COM THROW1 1m"');
    expect(body.messages[0].content).toContain('An rgb_led is never one two-node diode line');
  });

  it('accepts compound-part SPICE written as derived lines', () => {
    const response = parseCircuitResponse(JSON.stringify({
      ...rgbLedBadSpiceResponse,
      spice: '* rgb\nV1 VCC 0 DC 5\nR1 VCC ANO_R 220\nDLED1_R ANO_R 0 DRED\n.end',
    }));

    expect(response.circuit.components.find((part) => part.ref === 'DLED1')!.kind).toBe('rgb_led');
  });

  it('explains the derived-line contract when a compound part is one bare SPICE line', () => {
    expect(() => parseCircuitResponse(JSON.stringify(rgbLedBadSpiceResponse))).toThrowError(
      expect.objectContaining({
        code: 'spice_validation',
        message: expect.stringContaining('derived lines (DLED1_R, DLED1_G, DLED1_B)'),
      }),
    );
  });

  it('rejects a compound part whose JSON nodes array has the wrong length', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      ...rgbLedBadSpiceResponse,
      circuit: {
        ...rgbLedCircuit,
        components: rgbLedCircuit.components.map((part) => (
          part.ref === 'DLED1' ? { ...part, nodes: ['ANO_R', '0'] } : part
        )),
      },
    }))).toThrowError(expect.objectContaining({
      code: 'schema_validation',
      message: expect.stringContaining('exactly 4 nodes for kind rgb_led'),
    }));
  });

  it('regenerates the deck from the canonical JSON when every correction attempt still mismatches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify(rgbLedBadSpiceResponse)))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(rgbLedBadSpiceResponse)))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(rgbLedBadSpiceResponse)));
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamCircuitWithOllama('Make an RGB LED circuit');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('derived lines (DLED1_R, DLED1_G, DLED1_B)');
    expect(response.circuit.components.find((part) => part.ref === 'DLED1')!.kind).toBe('rgb_led');
    expect(response.spice).toContain('DLED1_R ANO_R 0 DRED');
    expect(response.spice).not.toMatch(/^DLED1 /m);
  });

  it('classifies malformed and schema-invalid responses', () => {
    expect(() => parseCircuitResponse('{"title": broken}')).toThrowError(
      expect.objectContaining({ code: 'json_syntax' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ title: 'Incomplete' }))).toThrowError(
      expect.objectContaining({ code: 'schema_validation' }),
    );
  });

  it('rejects missing, invalid, and mismatched AI SPICE', () => {
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit, spice: 'R1 IN' }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit, spice: 'Y1 IN OUT 1k' }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'Here is the filter.',
      circuit: validCircuit,
      spice: '* wrong node\nR1 IN 0 1k\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('retries a malformed stream once with corrective context', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"title": broken}'))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    const onContent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter', [], null, onContent)).resolves.toMatchObject(parsedAiResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.format).toEqual(AI_RESPONSE_SCHEMA);
    expect(retryBody.messages.at(-1).content).toContain('previous response was rejected');
    expect(retryBody.messages.at(-1).content).toContain('top-level "reply", "circuit", "spice", and "code" when a microcontroller board is present');
    expect(retryBody.messages.at(-1).content).toContain('smaller complete response');
    expect(onContent).toHaveBeenLastCalledWith(
      JSON.stringify(validAiResponse),
      expect.objectContaining({ attempt: 1, correcting: true }),
    );
  });

  it('does not resend truncated JSON content during correction retry', async () => {
    const longTruncatedContent = `{"reply":"${'partial response '.repeat(200)}"`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(longTruncatedContent))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);

    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.some((message: any) => message.role === 'assistant')).toBe(false);
    expect(retryBody.messages.map((message: any) => message.content).join('\n')).not.toContain('partial response partial response');
    expect(retryBody.messages.at(-1).content).toContain('Omit circuit.schematic unless');
  });

  it('retries once when AI SPICE does not match the JSON circuit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({
        reply: 'Here is the filter.',
        circuit: validCircuit,
        spice: '* wrong node\nR1 IN 0 1k\n.end',
      })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('SPICE must exactly match');
  });

  it('reports a classified error after every correction attempt fails structurally', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"title": broken}'))
      .mockResolvedValueOnce(streamResponse('{"title": stillBroken}'))
      .mockResolvedValueOnce(streamResponse('{"title": brokenAgain}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make a filter')).rejects.toMatchObject({
      code: 'json_syntax',
      message: expect.stringContaining('after 2 automatic correction attempts'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('feeds topology violations back to the model and resolves once corrected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(aiResponseFor(buzzerBugCircuit)))
      .mockResolvedValueOnce(streamResponse(aiResponseFor(buzzerFixedCircuit)));
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamCircuitWithOllama('Add a buzzer on GPIO2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('functional design errors');
    expect(retryBody.messages.at(-1).content).toContain('divider_powered_load');
    expect(retryBody.messages.at(-1).content).toContain('NPN transistor');
    expect(response.circuit.title).toBe('Buzzer driver');
    expect(response.generation).toEqual({ attempts: 2, degraded: false });
    expect(response.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('degrades gracefully instead of failing when violations survive every retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(aiResponseFor(buzzerBugCircuit)))
      .mockResolvedValueOnce(streamResponse(aiResponseFor(buzzerBugCircuit)))
      .mockResolvedValueOnce(streamResponse(aiResponseFor(buzzerBugCircuit)));
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamCircuitWithOllama('Add a buzzer on GPIO2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.circuit.title).toBe('Buzzer bug');
    expect(response.generation).toEqual({ attempts: 3, degraded: true });
    expect(response.issues.map((issue) => issue.id)).toContain('divider_powered_load');
  });

  it('accepts the best candidate across attempts, not the last one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(aiResponseFor(reversedLedCircuit('Two errors', 2))))
      .mockResolvedValueOnce(streamResponse(aiResponseFor(reversedLedCircuit('One error', 1))))
      .mockResolvedValueOnce(streamResponse(aiResponseFor(reversedLedCircuit('Two errors again', 2))));
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamCircuitWithOllama('Make an LED demo');
    expect(response.circuit.title).toBe('One error');
    expect(response.generation).toEqual({ attempts: 3, degraded: true });
    expect(response.issues.filter((issue) => issue.severity === 'error')).toHaveLength(1);
  });

  it('uses the OpenAI-compatible endpoint for Z.ai with JSON mode and thinking disabled', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'glm-5.2',
      max_tokens: 12000,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    });
  });

  it('raises max_tokens to 30000 when Z.ai thinking is enabled, so reasoning and JSON share a bigger budget', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('ZAI_THINKING_TYPE', 'enabled');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      max_tokens: 30000,
      thinking: { type: 'enabled' },
    });
  });

  it('lets an explicit AI_MAX_TOKENS override the Z.ai thinking-mode default', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('ZAI_THINKING_TYPE', 'enabled');
    vi.stubEnv('AI_MAX_TOKENS', '8000');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ max_tokens: 8000 });
  });

  it('reads array-style OpenAI-compatible assistant content', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse([
      { type: 'text', text: JSON.stringify(validAiResponse) },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toMatchObject(parsedAiResponse);
  });

  it('reports length-stopped Z.ai reasoning output as an output budget problem', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: '',
            reasoning_content: 'The user wants a difference amplifier circuit. '.repeat(20),
          },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make a difference amplifier')).rejects.toMatchObject({
      code: 'provider_response',
      message: expect.stringContaining('max_tokens was exhausted'),
    });
  });
});

const sseConfig = { provider: 'zai', baseUrl: 'https://api.example.com/v1', model: 'glm-5.2', apiKey: 'key' };

const sseBody = {
  model: 'glm-5.2',
  stream: true,
  format: {},
  options: { num_ctx: 8192, num_predict: 4096, temperature: 0 },
  messages: [{ role: 'user', content: 'hi' }],
};

const sseChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}`;

const sseResponse = (lines: string[]) => new Response(
  `${lines.join('\n')}\n`,
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);

describe('streamOpenAiCompatibleContent', () => {
  it('forwards reasoning deltas, accumulates content, and requests stream mode', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse([
      ': keepalive comment',
      sseChunk({ reasoning_content: 'The user wants ' }),
      sseChunk({ reasoning_content: 'an RC filter.' }),
      '',
      'not json noise',
      sseChunk({ content: '{"reply":' }),
      sseChunk({ content: '"done"}' }),
      'data: [DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onThinking = vi.fn();
    const onContent = vi.fn();

    const content = await streamOpenAiCompatibleContent(sseConfig, sseBody, { onThinking, onContent });

    expect(content).toBe('{"reply":"done"}');
    expect(onThinking.mock.calls.map(([delta]) => delta)).toEqual(['The user wants ', 'an RC filter.']);
    expect(onContent).toHaveBeenLastCalledWith('{"reply":"done"}');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.stream).toBe(true);
  });

  it('accepts a plain JSON body from gateways that ignore stream mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(openAiResponse('full answer')));
    const onContent = vi.fn();

    const content = await streamOpenAiCompatibleContent(sseConfig, sseBody, { onContent });

    expect(content).toBe('full answer');
    expect(onContent).toHaveBeenCalledWith('full answer');
  });

  it('reports a stream that ends with reasoning but no content as a provider problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sseResponse([
      sseChunk({ reasoning_content: 'thinking forever' }, { finish_reason: 'length' }),
      'data: [DONE]',
    ])));

    await expect(streamOpenAiCompatibleContent(sseConfig, sseBody)).rejects.toMatchObject({
      code: 'provider_response',
      message: expect.stringContaining('max_tokens was exhausted'),
    });
  });

  it('surfaces in-stream provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sseResponse([
      `data: ${JSON.stringify({ error: 'quota exceeded' })}`,
    ])));

    await expect(streamOpenAiCompatibleContent(sseConfig, sseBody)).rejects.toThrow('quota exceeded');
  });

  it('streams thinking through the circuit generation path', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://api.example.com/v1');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sseResponse([
      sseChunk({ reasoning_content: 'Choosing R and C values.' }),
      sseChunk({ content: JSON.stringify(validAiResponse) }),
      'data: [DONE]',
    ])));
    const onContent = vi.fn();
    const onThinking = vi.fn();

    await expect(streamCircuitWithOllama('Make an RC filter', [], null, onContent, null, onThinking))
      .resolves.toMatchObject(parsedAiResponse);

    expect(onThinking).toHaveBeenCalledWith('Choosing R and C values.', { attempt: 0, correcting: false });
    expect(onContent).toHaveBeenCalledWith(JSON.stringify(validAiResponse), { attempt: 0, correcting: false });
  });
});
