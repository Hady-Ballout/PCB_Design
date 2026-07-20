import { normalizeChatMemory, sanitizeConversationHistory } from './chatMemory.js';
import { circuitKnowledgePrompt } from './circuitKnowledge.js';
import { parseSpiceNetlist } from '../../src/core/circuitSync.js';
import { toSpice } from '../../src/core/pcbGenerator.js';
import { applySafeAutoFixes, checkCircuitTopology, composeTopologyCorrection } from '../../src/core/topologyRules.js';
import {
  ALLOWED_KINDS,
  COMPOUND_SPICE_KINDS,
  DEFAULT_PIN_COUNT_BY_KIND,
  FIXED_PIN_NAMES,
  MCU_KINDS,
  WIRING_ONLY_KINDS,
} from '../../src/core/componentKinds.js';
import type {
  ChatMemory,
  ChatMessage,
  Circuit,
  CorrectionContext,
  CurrentDesign,
  GeneratedCircuit,
  OllamaRequestBody,
  OpenAiStreamHandlers,
  ParsedCircuitResponse,
  ProviderConfig,
  RuleViolation,
  StreamState,
} from '../types.js';

// Prompt/schema guidance derived from the component registry (componentKinds.js)
// so a kind added there is automatically offered to the model — no hand-editing
// of this file. Microcontroller boards keep their bespoke firmware/power
// guidance in the prompt below and are excluded from these generated lines.
const FIXED_PIN_CONTRACT = ALLOWED_KINDS
  .filter((kind) => FIXED_PIN_NAMES[kind] && !MCU_KINDS.has(kind))
  .map((kind) => `- ${kind} (${FIXED_PIN_NAMES[kind].length} nodes): ${FIXED_PIN_NAMES[kind].join(', ')}`)
  .join('\n');

const WIRING_ONLY_PARTS = ALLOWED_KINDS
  .filter((kind) => WIRING_ONLY_KINDS.has(kind) && !MCU_KINDS.has(kind))
  .join(', ');

const COMPOUND_NODE_HINTS = ALLOWED_KINDS
  .filter((kind) => COMPOUND_SPICE_KINDS.has(kind) && !FIXED_PIN_NAMES[kind])
  .map((kind) => `${kind} (${DEFAULT_PIN_COUNT_BY_KIND[kind]} nodes)`)
  .join(', ');

// Kinds whose pins are mapped by position downstream (breadboard leg layouts,
// fixed pin names, compound SPICE expansion); a wrong node count is rejected
// rather than silently mis-wired.
const POSITIONAL_NODE_KINDS = new Set([
  ...Object.keys(FIXED_PIN_NAMES),
  ...COMPOUND_SPICE_KINDS,
  'opamp', 'comparator', 'pushbutton', 'bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p',
]);

const SYSTEM_PROMPT = `You are a JSON API for beginner-safe electronics circuit generation.
Return exactly one valid JSON object and no other text.
The top-level object must contain "reply", "circuit", and "spice". When the circuit includes a microcontroller board it must also contain "code".
The "reply" field is a concise, conversational explanation of what you built or changed for the user. Mention important component refs when helpful, such as RLOAD, R1, or C1. Do not use Markdown.
The "circuit" field is the canonical structured circuit.
The "spice" field is a SPICE netlist generated from the same circuit.
Use node "0" for ground.
Every component needs ref, kind, value, nodes, and footprint.
The circuit may include optional compact "schematic" metadata for layout intent. Omit schematic unless it is needed to mark external terminals or an op amp primaryRef. Schematic metadata is visual only and must not add SPICE components.
Allowed component kinds: ${ALLOWED_KINDS.join(', ')}.
Component refs must be SPICE-compatible because the program will simulate them with Ngspice:
- resistor refs start with R, e.g. R1
- capacitor refs start with C, e.g. C1
- inductor refs start with L, e.g. L1
- diode and led refs start with D, e.g. D1 or DLED1; never use LED1
- voltage_source and signal_source refs start with V, e.g. V1 or VSIG1
- bjt refs start with Q, e.g. Q1
- mosfet refs start with M, e.g. M1
- opamp/optocoupler/subcircuit refs start with X, e.g. XU1
- opamp components must use value LM358 in JSON and LM358 as the SPICE subcircuit name; do not use GENERIC or OPAMP.
- optocoupler components must use value PC817 in JSON and PC817 as the SPICE subcircuit name, with nodes in the fixed order [A, K, E, C] and one SPICE line "X<REF> A K E C PC817".
- load refs should be modeled as resistors and start with R, e.g. RLOAD
- regulator refs may use U in the JSON, but include enough surrounding passives/load nodes for simulation.
- buck_converter is an LM2596 fixed-output step-down switcher (TO-220-5) with nodes [VIN, OUT, GND, FB, ON_OFF]; the value names the output, e.g. "LM2596-5.0" or "LM2596-3.3". Canonical wiring: supply -> VIN with an input capacitor (100uF) from VIN to 0; OUT -> inductor (33uH to 100uH) -> the output rail; a schottky catch diode from 0 to the OUT net (nodes ["0", "<OUT net>"], cathode on OUT); an output capacitor (220uF) from the output rail to 0; FB -> the output rail; ON_OFF -> 0 (active-low enable, tie to ground to run). Keep the input at least 2V above the output. In SPICE a buck_converter is exactly one ideal-source line on its OUT node, "V<REF> <OUT node> 0 DC <output volts>" — never lines for VIN/GND/FB/ON_OFF; the inductor, schottky, and capacitors are their own normal element lines.
- microcontroller board refs (arduino_uno, raspberry_pi, esp32) start with U, e.g. U1.
Microcontroller boards use fixed positional pin lists. The nodes array must have exactly this length and order, with "NC_<REF>_<pinNumber>" for every unused pin:
- arduino_uno (24 nodes): 5V, 3V3, GND, VIN, D0, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, A0, A1, A2, A3, A4, A5
- raspberry_pi (14 nodes): 5V, 3V3, GND, GPIO2, GPIO3, GPIO4, GPIO17, GPIO18, GPIO27, GPIO22, GPIO8, GPIO9, GPIO10, GPIO11 (GPIO8-11 are SPI0: CE0, MISO, MOSI, SCLK)
- esp32 (12 nodes): 3V3, GND, VIN, EN, GPIO2, GPIO4, GPIO5, GPIO13, GPIO18, GPIO19, GPIO21, GPIO22
Use value for the board name, e.g. "Uno R3", "Pi 5", or "DevKit V1".
Microcontroller boards are not simulated: never write a SPICE line for them; every other component must still appear in SPICE.
Connect the board's GND pin to node 0. When no separate supply exists, power the circuit from the board's 5V or 3V3 pin and set supplyVoltage accordingly (5 for arduino_uno, 3.3 for raspberry_pi and esp32).
Added sensor and module parts (${WIRING_ONLY_PARTS}) are wiring-only like microcontroller boards: they are never simulated, so emit each only as a SPICE comment line, for example "* U1 dht_sensor (wiring-only)". Every component that is not a microcontroller board or a wiring-only part must still appear as a real SPICE element.
The following parts use fixed positional node lists; the nodes array length and order must match exactly, using "NC_<REF>_<pinNumber>" for any unused pin:
${FIXED_PIN_CONTRACT}
Compound parts take a fixed node count (${COMPOUND_NODE_HINTS}; seven_segment uses its 9 fixed pins) and never appear in SPICE as one element line with their bare ref. Write only their derived lines, named <REF>_<suffix>, using the exact JSON node names:
- potentiometer nodes [END_A, WIPER, END_B]: "<REF>_A END_A WIPER 5k" plus "<REF>_B WIPER END_B 5k" (each line gets half the total resistance).
- switch_spdt nodes [THROW1, COM, THROW2]: "<REF>_A COM THROW1 1m" plus "<REF>_B COM THROW2 10Meg".
- rgb_led nodes [R_ANODE, G_ANODE, B_ANODE, CATHODE]: "<REF>_R R_ANODE CATHODE DRED", "<REF>_G G_ANODE CATHODE DGRN", "<REF>_B B_ANODE CATHODE DBLU". An rgb_led is never one two-node diode line.
- seven_segment: one diode per used segment to COM, e.g. "<REF>_A <A node> <COM node> DRED".
- current_sensor nodes [IP+, IP-, VCC, OUT, GND]: wire IP+ and IP- in series with the load's supply path (the measured current flows through them); VCC -> 5V, OUT -> an analog pin, GND -> 0. In SPICE write only one derived line "<REF>_S <IP+ node> <IP- node> 0.0012"; never a bare <REF> line and never lines for VCC/OUT/GND.
- bridge_rectifier (4 nodes) [AC1, AC2, V+, V-]: four derived diode lines "<REF>_A AC1 V+ DGEN", "<REF>_B AC2 V+ DGEN", "<REF>_C V- AC1 DGEN", "<REF>_D V- AC2 DGEN" using the exact JSON node names; drive AC1/AC2 from a signal_source SINE and take DC off V+/V- (add a smoothing capacitor). Never one bare <REF> line.
The remaining two-lead additions (zener as D with a breakdown value like 5.1, schottky as D with the DSCH model, photoresistor/thermistor/ir_phototransistor/buzzer/dc_motor/vibration_motor/fuse/pushbutton as R, crystal as C) follow the standard ref-prefix rules above.
ir_led is an infrared emitter LED: refs start with D, SPICE line "D<REF> ANODE CATHODE DIR" plus ".model DIR D(IS=1e-18 N=1.4 RS=6 CJO=2p BV=5 IBV=10u)", and it always needs a series resistor (100-330) like any LED. ir_phototransistor is the matching raw 2-pin analog receiver: an R element used in a voltage divider exactly like a photoresistor (its light level is a simulation slider). Use the ir_receiver module instead only when the user wants demodulated remote-control protocols.
solar_panel is a DC source: refs start with V, SPICE is "V<REF> PLUS MINUS DC <volts>", and its positive node feeds the circuit like a battery.
A GPIO/digital pin driving a load must share its net with at least one other component, e.g. a series resistor. Only add a separate voltage_source or signal_source for a pin's waveform when the user explicitly wants to simulate that pin's behavior.
Never drive a buzzer, motor, relay coil, or speaker directly from a GPIO pin — always switch it with an NPN transistor or N-MOSFET: GPIO pin -> 1k base resistor -> base, emitter -> 0, load between the supply and the collector, plus a flyback diode across any motor or coil (including vibration motors).
hall_sensor: VCC -> 5V, GND -> 0, OUT -> a GPIO with a 10k pull-up resistor to VCC (the A3144 output is open-collector).
Never build a resistor divider to "power" a load from a GPIO net: a resistor from a GPIO-driven load node to ground does not switch anything and just wastes current.
A stepper_motor's coil pins A-D must never connect to GPIO nets; always add a stepper_driver: MCU GPIOs -> IN1-IN4, VCC -> 5V, GND -> 0, OUTA-OUTD -> the motor's A-D coil pins, and the motor's COM -> 5V.
Drive a dc_motor from an MCU through a motor_driver (L298N): GPIOs -> IN1/IN2 (and ENA for speed control), the motor between OUT1 and OUT2, VS -> the motor supply, GND -> 0. A motor on driver OUT pins needs no extra transistor or flyback diode.
led_strip: VCC -> the 5V supply net (never a GPIO pin), GND -> 0, DIN -> one GPIO pin.
optocoupler: drive the input LED from a GPIO through a 220-1k series resistor into A, K -> 0; the output E/C switches the isolated side and must never share a net with A or K.
SPI modules (sd_card, rfid_reader, mouse_sensor): on arduino_uno use D13=SCK, D12=MISO, D11=MOSI and any free digital pin for CS (rfid_reader's SDA pin is its SS; mouse_sensor's NCS pin is its chip select); on esp32 use GPIO18=SCK, GPIO19=MISO and free listed GPIOs for MOSI/CS; on raspberry_pi use GPIO11=SCLK, GPIO9=MISO, GPIO10=MOSI, GPIO8=CE0. rfid_reader's 3V3 pin must connect to the 3.3V supply, never 5V. mouse_sensor's MOT pin is an optional active-low motion interrupt on any free digital pin.
keypad: R1-R4 and C1-C4 each connect to their own GPIO pin; no other components are needed.
raspberry_pi has no analog inputs: any analog-output sensor (joystick VRX/VRY, soil_moisture AOUT, gas_sensor AO, current_sensor OUT, photoresistor/thermistor dividers) on a raspberry_pi must go through an adc_module (MCP3008): VDD and VREF -> 3V3, AGND and DGND -> 0, CLK -> GPIO11, DOUT -> GPIO9, DIN -> GPIO10, CS -> GPIO8, sensor outputs into CH0-CH7.
When circuit.components includes a microcontroller board (arduino_uno, raspberry_pi, or esp32), also return a top-level "code" field with complete ready-to-run firmware for that board:
- arduino_uno: an Arduino C++ sketch with setup() and loop(). Use the digit from the pin name: D13 is pin 13, A0 is A0.
- esp32: an Arduino-style C++ sketch with setup() and loop(). Use the GPIO number: GPIO2 is pin 2.
- raspberry_pi: a Python 3 script using the gpiozero library. Use the GPIO number: GPIO17 is LED(17) or Button(17).
Per-part firmware libraries (Arduino sketches / raspberry_pi Python): servo -> Servo.h / gpiozero Servo; dht_sensor -> the DHT sensor library / Adafruit_DHT; stepper_motor via stepper_driver -> Stepper.h with Stepper(2048, IN1, IN3, IN2, IN4) (note the IN1-IN3-IN2-IN4 order) / four gpiozero OutputDevice half-step outputs; motor_driver -> plain digitalWrite on IN1/IN2 plus analogWrite on ENA / gpiozero Motor(forward, backward, enable); lcd_display -> Wire.h + LiquidCrystal_I2C at address 0x27 (lcd.init(), lcd.backlight(), lcd.print()) / RPLCD CharLCD(i2c_expander='PCF8574', address=0x27); rotary_encoder -> digitalRead on CLK/DT with INPUT_PULLUP on SW / gpiozero RotaryEncoder plus Button; led_strip -> Adafruit_NeoPixel(N, PIN, NEO_GRB + NEO_KHZ800) / the rpi_ws281x library (prefer GPIO18); imu_sensor -> Wire.h + Adafruit_MPU6050 at address 0x68 / smbus2 reads at 0x68; ir_receiver -> IRremote (IrReceiver.begin, decode) / a simple pulse read; shift_register -> the built-in shiftOut(SER, SRCLK, MSBFIRST, value) then pulse RCLK / gpiozero bit-banging; keypad -> the Keypad.h library with the 4x4 keymap / a gpiozero row-column scan; joystick -> analogRead on VRX/VRY with INPUT_PULLUP on SW / adc_module channels; rtc_module -> RTClib (RTC_DS3231) / smbus2 at 0x68; sd_card -> SD.h with SD.begin(CS) / the Pi mounts storage natively; rfid_reader -> MFRC522 with SPI.h / the mfrc522 python package; mouse_sensor -> the PMW3360 library with SPI.h (sensor.begin(NCS), readBurst() for dx/dy) / raw spidev register reads; soil_moisture and gas_sensor -> analogRead plus a threshold compare / adc_module channel reads; baro_sensor -> Adafruit_BMP280 at 0x76 / the bmp280 python library; adc_module -> SPI.h transfers on Arduino (the part IS the ADC) / gpiozero MCP3008(channel=N) on the Pi; current_sensor -> analogRead with midpoint math ((reading - 512) * 5.0 / 1024 / 0.185 amps); optocoupler -> plain digitalWrite on the input-side GPIO; sound_sensor -> analogRead on AO plus a digitalRead threshold on DO / adc_module channel; hall_sensor -> digitalRead with INPUT_PULLUP (open-collector output) / gpiozero Button.
The firmware must implement the exact behavior the user asked for (blink, button, fade, sensor read) and must only use pins that circuit.components actually wires to other components. Keep it under 40 lines, beginner-friendly, with brief comments. The "code" value is plain source text in one JSON string with \\n newlines: no Markdown, no \`\`\` fences, no explanation. When the circuit has no microcontroller board, set "code" to an empty string.
Use simple Ngspice-friendly values such as 1k, 100nF, 10uF, 5V, and SINE(0 1 1k).
Use voltage_source for DC supplies and fixed DC input biases (or solar_panel when the user asks for solar power). Use signal_source only for waveform or time-varying sources such as SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
If SPICE uses "V... ... DC value", the matching JSON component kind must be voltage_source or solar_panel. If SPICE uses a waveform source, the matching JSON component kind must be signal_source.
The SPICE netlist must use the exact same component refs, values, and node names as circuit.components.
Every node except ground "0" must connect to at least two component pins and have a DC path to ground; never leave a node floating.
Both op-amp inputs must be connected: wire the inverting input to the feedback/summing network, and the non-inverting input to a reference node — ground "0" for a dual-supply design, or a mid-rail bias-divider node for a single-supply design. Never put an op-amp input on a node that no other component uses.
When you create a reference or bias node (for example a divider midpoint), connect the op-amp input to that exact node name. Do not invent a separate, otherwise-unused input node.`;

const SCHEMATIC_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'number' },
    topology: { type: 'string' },
    primaryRef: { type: 'string' },
    externalTerminals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          net: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] },
        },
        required: ['net', 'label', 'type', 'side'],
      },
    },
    netRoles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          net: { type: 'string' },
          role: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
        },
        required: ['net', 'role'],
      },
    },
    componentRoles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          role: { type: 'string' },
          block: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
          orientation: { type: 'string', enum: ['horizontal', 'vertical'] },
          order: { type: 'number' },
          pinRoles: { type: 'object' },
        },
        required: ['ref', 'role'],
      },
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          role: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' } },
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
          order: { type: 'number' },
        },
        required: ['id', 'role', 'refs'],
      },
    },
  },
} as const;

export const CIRCUIT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: { type: 'string' },
    supplyVoltage: { type: 'number' },
    nodes: { type: 'array', items: { type: 'string' }, minItems: 1 },
    components: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          kind: {
            type: 'string',
            enum: ALLOWED_KINDS,
          },
          value: { type: 'string' },
          nodes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          footprint: { type: 'string' },
        },
        required: ['ref', 'kind', 'value', 'nodes', 'footprint'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    schematic: SCHEMATIC_SCHEMA,
  },
  required: ['title', 'type', 'supplyVoltage', 'nodes', 'components', 'notes'],
} as const;

export const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    circuit: CIRCUIT_SCHEMA,
    spice: { type: 'string' },
    // Firmware source for the circuit's microcontroller board. Declared so the
    // structured-output grammar lets the model emit it; not required so
    // non-MCU responses can omit it.
    code: { type: 'string' },
  },
  required: ['reply', 'circuit', 'spice'],
} as const;

export function findBalancedJson(text: string): { jsonText: string; balanced: boolean } {
  const start = text.indexOf('{');
  if (start === -1) return { jsonText: '', balanced: false };

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return { jsonText: text.slice(start, index + 1), balanced: true };
  }

  return { jsonText: text.slice(start), balanced: false };
}

class CircuitGenerationError extends Error {
  code: string;
  constructor(code: string, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CircuitGenerationError';
    this.code = code;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanReply = (value: unknown): string => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 1200);

interface ComponentLike {
  ref?: string;
  kind?: string;
  value?: string;
  nodes?: string[];
}

const describeComponent = (component: ComponentLike): string => {
  const ref = String(component?.ref || '').toUpperCase();
  const kind = String(component?.kind || 'component');
  const value = String(component?.value || 'unknown value');
  const nodes = Array.isArray(component?.nodes) ? component.nodes.join(' - ') : 'unknown nodes';
  return `${ref}: ${kind}, value=${value}, nodes=${nodes}`;
};

export const currentCircuitInventory = (circuit: Circuit | null | undefined): string => {
  const components = Array.isArray(circuit?.components) ? circuit!.components : [];
  if (!components.length) return '';
  const refs = components.map((component) => String(component.ref || '').toUpperCase()).filter(Boolean);
  const loadRefs = components
    .filter((component) => (
      String(component.ref || '').toUpperCase().includes('LOAD')
      || String(component.kind || '').toLowerCase() === 'load'
    ))
    .map(describeComponent);
  return [
    `Current component inventory (${components.length} components):`,
    ...components.map(describeComponent),
    refs.length ? `Known refs and aliases are case-insensitive: ${refs.join(', ')}.` : '',
    loadRefs.length
      ? `Load references present now: ${loadRefs.join('; ')}. User phrases like "Rload", "RLOAD", "load resistor", or "the load" refer to these current load components unless they explicitly ask for a new load.`
      : '',
  ].filter(Boolean).join('\n');
};

export function validateCircuitResponse(circuit: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isPlainObject(circuit)) return ['response must be a JSON object'];

  if (typeof circuit.title !== 'string') errors.push('title must be a string');
  if (typeof circuit.type !== 'string') errors.push('type must be a string');
  if (!Number.isFinite(circuit.supplyVoltage)) errors.push('supplyVoltage must be a number');
  if (!Array.isArray(circuit.nodes) || (circuit.nodes as unknown[]).length === 0 || (circuit.nodes as unknown[]).some((node: unknown) => typeof node !== 'string')) {
    errors.push('nodes must be a non-empty array of strings');
  }
  if (!Array.isArray(circuit.notes) || (circuit.notes as unknown[]).some((note: unknown) => typeof note !== 'string')) {
    errors.push('notes must be an array of strings');
  }
  if (circuit.schematic !== undefined && !isPlainObject(circuit.schematic)) {
    errors.push('schematic must be an object when present');
  }
  if (!Array.isArray(circuit.components) || (circuit.components as unknown[]).length === 0) {
    errors.push('components must be a non-empty array');
  } else {
    const allowedKinds = new Set(CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum);
    (circuit.components as Record<string, unknown>[]).forEach((component, index) => {
      const label = `components[${index}]`;
      if (!isPlainObject(component)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof component.ref !== 'string' || !component.ref) errors.push(`${label}.ref must be a non-empty string`);
      if (!allowedKinds.has(component.kind as string)) errors.push(`${label}.kind is not supported`);
      if (typeof component.value !== 'string' || !component.value) errors.push(`${label}.value must be a non-empty string`);
      if (!Array.isArray(component.nodes) || (component.nodes as unknown[]).length === 0 || (component.nodes as unknown[]).some((node: unknown) => typeof node !== 'string')) {
        errors.push(`${label}.nodes must be a non-empty array of strings`);
      } else if (POSITIONAL_NODE_KINDS.has(component.kind as string)
        && (component.nodes as unknown[]).length !== DEFAULT_PIN_COUNT_BY_KIND[component.kind as string]) {
        // Positional kinds map pins by index (breadboard leg layouts, SPICE
        // expansion, fixed pin names), so a wrong-length nodes array silently
        // wires the wrong physical pins downstream.
        const expectedOrder = FIXED_PIN_NAMES[component.kind as string];
        errors.push(`${label}.nodes must list exactly ${DEFAULT_PIN_COUNT_BY_KIND[component.kind as string]} nodes for kind ${component.kind}${expectedOrder ? ` in the order [${expectedOrder.join(', ')}]` : ''}, using NC_<REF>_<pinNumber> for unused pins`);
      }
      if (typeof component.footprint !== 'string') errors.push(`${label}.footprint must be a string`);
    });
  }

  return errors;
}

const OPAMP_MODEL = 'LM358';
const OPAMP_MODEL_ALIASES = new Set(['', 'GENERIC', 'OPAMP', 'UNKNOWN']);

const normalizeOpampModel = (value: unknown): string => {
  const normalized = String(value || '').trim().toUpperCase();
  return OPAMP_MODEL_ALIASES.has(normalized) || normalized === OPAMP_MODEL ? OPAMP_MODEL : normalized;
};

// The optocoupler's SPICE image is an X line whose model name lands in the
// electrical signature, so the JSON value must normalize to PC817 exactly
// like the opamp's LM358 — otherwise "value: optocoupler" burns a retry.
const OPTO_MODEL = 'PC817';
const OPTO_MODEL_ALIASES = new Set(['', 'GENERIC', 'OPTO', 'OPTOCOUPLER', 'UNKNOWN']);

const normalizeOptoModel = (value: unknown): string => {
  const normalized = String(value || '').trim().toUpperCase();
  return OPTO_MODEL_ALIASES.has(normalized) || normalized === OPTO_MODEL ? OPTO_MODEL : normalized;
};

const isSourceKind = (kind: string): boolean => kind === 'voltage_source' || kind === 'signal_source';

const voltageValue = (value: string): string => {
  const text = String(value || '').trim();
  return /v$/i.test(text) ? text : `${text}V`;
};

const sourceExpressionKind = (value: string): string | null => {
  const expression = String(value || '').trim();
  if (/^(SINE|SIN|PULSE|PWL|EXP|AC)\b/i.test(expression)) return 'signal_source';
  if (/^DC\b/i.test(expression)) return 'voltage_source';
  if (/^[+-]?\d+(?:\.\d+)?(?:[munpfkKMegG]+)?V?$/i.test(expression)) return 'voltage_source';
  return null;
};

interface SourceComponent {
  kind: string;
  value: string;
  [key: string]: unknown;
}

const normalizeSourceComponent = (component: SourceComponent): SourceComponent => {
  if (!isSourceKind(component.kind)) return component;
  const expression = String(component.value || '').trim();
  const kind = sourceExpressionKind(expression) || component.kind;
  const dcMatch = expression.match(/^DC\s+(.+)$/i);
  if (kind === 'voltage_source') {
    return { ...component, kind, value: voltageValue(dcMatch ? dcMatch[1] : expression) };
  }
  return { ...component, kind, value: expression };
};

export const normalizeCircuitForValidation = (circuit: Record<string, unknown>): Record<string, unknown> => ({
  ...circuit,
  components: ((circuit.components as SourceComponent[]) || []).map((component) => {
    const normalizedSource = normalizeSourceComponent(component);
    if (normalizedSource.kind === 'opamp') return { ...normalizedSource, value: OPAMP_MODEL };
    if (normalizedSource.kind === 'optocoupler') return { ...normalizedSource, value: OPTO_MODEL };
    return normalizedSource;
  }),
});

const normalizeSignatureValue = (component: { kind: string; value: string }): string => {
  if (component.kind === 'opamp') return normalizeOpampModel(component.value);
  if (component.kind === 'optocoupler') return normalizeOptoModel(component.value);
  return String(component.value || '').trim().toUpperCase();
};

interface SignatureEntry {
  ref: string;
  kind: string;
  value: string;
  nodes: string[];
}

const electricalSignature = (circuit: Record<string, unknown> | null | undefined): SignatureEntry[] => (
  (circuit?.components as ComponentLike[]) || []
).map((component) => ({
  ref: String(component.ref || '').toUpperCase(),
  kind: String(component.kind || ''),
  value: normalizeSignatureValue(component as { kind: string; value: string }),
  nodes: (component.nodes || []).map((node) => String(node)),
})).sort((a, b) => a.ref.localeCompare(b.ref));

// Derived-line suffixes per compound kind, mirrored from the toSpice exporter,
// so a mismatch on a compound part tells the correction retry exactly which
// SPICE lines to write instead of just naming the wrong kind.
const COMPOUND_DERIVED_SUFFIXES: Record<string, string[]> = {
  potentiometer: ['A', 'B'],
  switch_spdt: ['A', 'B'],
  rgb_led: ['R', 'G', 'B'],
  seven_segment: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'],
  current_sensor: ['S'],
  bridge_rectifier: ['A', 'B', 'C', 'D'],
};

const compoundSpiceHint = (component: SignatureEntry | undefined): string | null => {
  const suffixes = component && COMPOUND_DERIVED_SUFFIXES[component.kind];
  if (!component || !suffixes) return null;
  const derived = suffixes.map((suffix) => `${component.ref}_${suffix}`).join(', ');
  return `${component.ref} is a ${component.kind}, which must appear in SPICE only as derived lines (${derived}) connecting its JSON nodes, never as a single ${component.ref} element line.`;
};

const describeSignatureMismatch = (expected: SignatureEntry[], actual: SignatureEntry[]): string => {
  const expectedByRef = new Map(expected.map((component) => [component.ref, component]));
  const actualByRef = new Map(actual.map((component) => [component.ref, component]));
  const missing = expected.filter((component) => !actualByRef.has(component.ref)).map((component) => component.ref);
  const extra = actual.filter((component) => !expectedByRef.has(component.ref)).map((component) => component.ref);
  if (missing.length) return compoundSpiceHint(expectedByRef.get(missing[0])) || `SPICE is missing component ${missing[0]}.`;
  if (extra.length) return `SPICE includes unexpected component ${extra[0]}.`;

  for (const expectedComponent of expected) {
    const actualComponent = actualByRef.get(expectedComponent.ref);
    if (!actualComponent) continue;
    if (actualComponent.kind !== expectedComponent.kind) {
      return compoundSpiceHint(expectedComponent)
        || `${expectedComponent.ref} has kind ${actualComponent.kind} in SPICE but ${expectedComponent.kind} in JSON.`;
    }
    if (actualComponent.value !== expectedComponent.value) {
      return `${expectedComponent.ref} has value ${actualComponent.value} in SPICE but ${expectedComponent.value} in JSON.`;
    }
    if (JSON.stringify(actualComponent.nodes) !== JSON.stringify(expectedComponent.nodes)) {
      return `${expectedComponent.ref} has nodes ${actualComponent.nodes.join(', ')} in SPICE but ${expectedComponent.nodes.join(', ')} in JSON.`;
    }
  }

  return 'SPICE does not match the JSON circuit.';
};

export function validateAiSpice(spice: unknown, circuit: Record<string, unknown>): void {
  if (typeof spice !== 'string' || !spice.trim()) {
    throw new CircuitGenerationError('spice_validation', 'AI response must include a non-empty spice string.');
  }

  const parsed = parseSpiceNetlist(spice, circuit);
  if (!parsed.ok) {
    throw new CircuitGenerationError(
      'spice_validation',
      `AI SPICE netlist could not be parsed: ${parsed.errors.slice(0, 3).join('; ')}.`,
    );
  }

  const expected = electricalSignature(circuit);
  const actual = electricalSignature(parsed.circuit);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new CircuitGenerationError('spice_validation', describeSignatureMismatch(expected, actual));
  }
}

// Firmware arrives as one JSON string; models occasionally wrap it in
// Markdown fences despite instructions. Strip them defensively so every
// provider path (streaming, non-streaming, correction retry) benefits.
const sanitizeFirmwareCode = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.replace(/^```[a-zA-Z0-9+-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
};

export function parseCircuitResponse(
  text: string,
  options: { regenerateSpiceOnMismatch?: boolean } = {},
): ParsedCircuitResponse {
  const trimmed = text.trim();
  const { jsonText, balanced } = findBalancedJson(trimmed);
  if (!jsonText) {
    throw new CircuitGenerationError('json_missing', 'AI response did not contain a JSON object.');
  }
  if (!balanced) {
    throw new CircuitGenerationError('json_truncated', 'AI response ended before the JSON object was complete.');
  }

  let responseObject: Record<string, unknown>;
  try {
    responseObject = JSON.parse(jsonText);
  } catch (error) {
    throw new CircuitGenerationError('json_syntax', `AI returned malformed JSON: ${(error as Error).message}`, error as Error);
  }

  if (!isPlainObject(responseObject)) {
    throw new CircuitGenerationError('schema_validation', 'AI response must be a JSON object.');
  }
  const reply = cleanReply(responseObject.reply);
  if (!reply) {
    throw new CircuitGenerationError('schema_validation', 'AI response must include a conversational reply string.');
  }
  if (!isPlainObject(responseObject.circuit)) {
    throw new CircuitGenerationError('schema_validation', 'AI response must include a circuit object.');
  }

  const circuit = responseObject.circuit as Record<string, unknown>;
  const validationErrors = validateCircuitResponse(circuit);
  if (validationErrors.length) {
    throw new CircuitGenerationError(
      'schema_validation',
      `AI circuit did not match the required schema: ${validationErrors.slice(0, 4).join('; ')}.`,
    );
  }
  const normalizedCircuit = normalizeCircuitForValidation(circuit);
  let spice = responseObject.spice as string;
  try {
    validateAiSpice(responseObject.spice, normalizedCircuit);
  } catch (error) {
    // The JSON circuit is canonical and already schema-validated. On the last
    // attempt, a deck the model still cannot reconcile (compound parts like
    // rgb_led are the usual culprit) is regenerated deterministically from the
    // JSON instead of failing the whole chat turn.
    if (!options.regenerateSpiceOnMismatch || (error as CircuitGenerationError).code !== 'spice_validation') throw error;
    try {
      spice = toSpice(normalizedCircuit);
    } catch {
      throw error;
    }
  }

  return {
    reply,
    circuit: normalizedCircuit as unknown as Circuit,
    spice,
    code: sanitizeFirmwareCode(responseObject.code),
  };
}

export const positiveIntegerOption = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const providerConfig = (): ProviderConfig => {
  const provider = String(process.env.AI_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'ollama') {
    return {
      provider,
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
      apiKey: process.env.OLLAMA_API_KEY || '',
    };
  }

  return {
    provider,
    baseUrl: process.env.AI_API_URL || '',
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
  };
};

export const buildOllamaRequestBody = (
  prompt: string,
  history: ChatMessage[],
  stream: boolean,
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
  correction: CorrectionContext | null = null,
): OllamaRequestBody => {
  const conversation = sanitizeConversationHistory(history)
    .map((message) => ({
      role: message.role,
      content: message.role === 'assistant'
        ? JSON.stringify(message.circuit).slice(0, 12000)
        : `Previous circuit request: ${String(message.content || '')}`,
    }));

  const normalizedMemory = normalizeChatMemory(memory);
  const memoryContext = normalizedMemory.summary
    ? [{ role: 'system', content: `Active chat memory:\n${normalizedMemory.summary}` }]
    : [];
  const revisionContext = currentDesign?.circuit
    ? [{
        role: 'system',
        content: `This request belongs to an existing circuit conversation. The following circuit is the exact canonical current design:\n${JSON.stringify(currentDesign.circuit)}\n${currentCircuitInventory(currentDesign.circuit)}\nCurrent edited SPICE deck, included only as supplemental context:\n${String(currentDesign.spice || '').slice(0, 6000)}\nCurrent edited KiCad netlist, included only as supplemental context:\n${String(currentDesign.kicadNetlist || '').slice(0, 6000)}\nTreat the new request as an edit to this exact current design. If the user names a component ref case-insensitively, such as Rload, RLOAD, RLoad, or "the load resistor", modify or remove that existing component when present instead of inventing a new circuit. Keep every unchanged component, reference, node, value, and footprint exactly as-is. Only replace the whole design when the new request explicitly asks to start over, replace it, or create a different circuit.`,
      }]
    : [];

  const correctionMessages = correction
    ? [
        {
          role: 'user',
          content: `Your previous response was rejected: ${correction.error}. Return a smaller complete response as one valid JSON object with top-level "reply", "circuit", "spice", and "code" when a microcontroller board is present. Omit circuit.schematic unless it is essential for external terminals or op amp intent. The reply must be conversational and concise. The SPICE must exactly match the JSON circuit refs, values, and node names. Do not explain the correction and do not use Markdown outside the JSON.`,
        },
      ]
    : [];
  const knowledgePrompt = circuitKnowledgePrompt();

  return {
    model: process.env.OLLAMA_MODEL || 'llama3.2:latest',
    stream,
    format: AI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    options: {
      num_ctx: positiveIntegerOption(process.env.OLLAMA_NUM_CTX, 8192),
      num_predict: positiveIntegerOption(process.env.OLLAMA_NUM_PREDICT, 4096),
      temperature: 0,
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(knowledgePrompt ? [{ role: 'system', content: knowledgePrompt }] : []),
      ...memoryContext,
      ...revisionContext,
      ...conversation,
      {
        role: 'user',
        content: `Return this exact compact JSON shape with real circuit values:
{"reply":"I built a concise explanation of the circuit or edit for the user.","circuit":{"title":"...","type":"...","supplyVoltage":5,"nodes":["VIN","VOUT","0"],"components":[{"ref":"R1","kind":"resistor","value":"1k","nodes":["VIN","VOUT"],"footprint":"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"}],"notes":["..."]},"spice":"* Example\\nR1 VIN VOUT 1k\\n.end"}
Use SPICE-safe component refs. For example, an LED must be {"ref":"DLED1","kind":"led",...}, not {"ref":"LED1",...}.
For op amps, use {"ref":"XU1","kind":"opamp","value":"LM358",...} and use LM358 as the SPICE subcircuit name; never use GENERIC or OPAMP.
For sources, use voltage_source for DC values and signal_source only for waveform values like SINE(...), PULSE(...), PWL(...), EXP(...), or AC.
Only include circuit.schematic when it adds essential layout intent. Keep it compact: use primaryRef for op amps and externalTerminals for intentional single-pin user connections such as VINP, VINN, VIN, VOUT, CTRL, or test points. Omit netRoles, componentRoles, and blocks unless the user request truly needs them.
Schematic metadata is visual only. Do not create extra SPICE lines for schematic fields.
The SPICE field must describe the same circuit.components entries using the same refs, values, and node names.
The reply field should sound like a helpful chat assistant: briefly explain what changed, mention relevant refs, and do not paste the netlist.
If the circuit contains an arduino_uno, raspberry_pi, or esp32 board, add a top-level "code" field containing the firmware source for it as a single JSON string.
Circuit prompt: ${prompt}
This is a follow-up whenever canonical design context is present. Preserve all prior requirements and unchanged design details. Replace the whole circuit only when this request explicitly asks to start over, replace it, or create a different circuit.`,
      },
      ...correctionMessages,
    ],
  };
};

const authHeaders = (apiKey = ''): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
};

export const ollamaHeaders = (): Record<string, string> => authHeaders(process.env.OLLAMA_API_KEY);

const retryableOutputCodes = new Set([
  'json_missing', 'json_truncated', 'json_syntax', 'schema_validation', 'spice_validation',
]);

const MAX_GENERATION_ATTEMPTS = 3;

const finalOutputError = (error: CircuitGenerationError): CircuitGenerationError => new CircuitGenerationError(
  error.code || 'invalid_output',
  `Circuit generation failed after ${MAX_GENERATION_ATTEMPTS - 1} automatic correction attempts. ${error.message}`,
  error,
);

// Retry policy: structural failures (bad JSON/schema/SPICE) retry with the
// parser's error text; a parseable circuit is then gated on the topology rule
// engine, whose error-severity violations become the corrective feedback.
// Once any attempt has parsed, this never throws — after the retry budget the
// best candidate (fewest errors, later attempt wins ties) is accepted and its
// remaining violations surface to the UI instead of failing the chat turn.
const parseWithCorrectionRetry = async (
  requestAttempt: (correction: CorrectionContext | null, attempt: number) => Promise<string>,
): Promise<GeneratedCircuit> => {
  let correction: CorrectionContext | null = null;
  let best: { parsed: ParsedCircuitResponse; issues: RuleViolation[]; errorCount: number } | null = null;
  let lastStructuralError: CircuitGenerationError | null = null;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const content = await requestAttempt(correction, attempt);
    let parsed: ParsedCircuitResponse;
    try {
      parsed = parseCircuitResponse(content, { regenerateSpiceOnMismatch: attempt === MAX_GENERATION_ATTEMPTS - 1 });
    } catch (error) {
      if (!retryableOutputCodes.has((error as CircuitGenerationError).code)) throw finalOutputError(error as CircuitGenerationError);
      lastStructuralError = error as CircuitGenerationError;
      if (attempt === MAX_GENERATION_ATTEMPTS - 1) break;
      correction = { content, error: (error as Error).message };
      continue;
    }
    const { violations } = checkCircuitTopology(parsed.circuit) as { violations: RuleViolation[] };
    const errorCount = violations.filter((entry) => entry.severity === 'error').length;
    if (!best || errorCount <= best.errorCount) best = { parsed, issues: violations, errorCount };
    if (!errorCount) {
      return { ...parsed, issues: violations, generation: { attempts: attempt + 1, degraded: false } };
    }
    correction = { content, error: composeTopologyCorrection(violations) };
  }

  if (best) {
    // Additive-only repairs (gate pull-down, flyback diode) are safe to apply
    // deterministically; the deck is regenerated so SPICE stays in sync.
    const { circuit, violations, applied } = applySafeAutoFixes(best.parsed.circuit, best.issues) as {
      circuit: Circuit; violations: RuleViolation[]; applied: boolean;
    };
    let spice = best.parsed.spice;
    if (applied) {
      try {
        spice = toSpice(circuit as unknown as Record<string, unknown>);
      } catch { /* keep the original deck if regeneration fails */ }
    }
    return {
      ...best.parsed,
      circuit,
      spice,
      issues: violations,
      generation: { attempts: MAX_GENERATION_ATTEMPTS, degraded: true },
    };
  }
  throw finalOutputError(lastStructuralError
    || new CircuitGenerationError('invalid_output', 'Circuit generation did not return a usable response.'));
};

export const ollamaUrl = (): string => `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;

const isZaiProvider = (provider: string): boolean => new Set(['zai', 'zhipu', 'bigmodel']).has(provider);

const shouldUseJsonResponseFormat = (): boolean => process.env.AI_RESPONSE_FORMAT !== 'text';

export const buildOpenAiCompatibleBody = (config: ProviderConfig, ollamaBody: OllamaRequestBody): Record<string, unknown> => ({
  model: config.model,
  ...(ollamaBody.stream ? { stream: true } : {}),
  temperature: ollamaBody.options.temperature,
  max_tokens: positiveIntegerOption(process.env.AI_MAX_TOKENS, isZaiProvider(config.provider) ? 12000 : 4096),
  ...(shouldUseJsonResponseFormat() ? { response_format: { type: 'json_object' } } : {}),
  ...(isZaiProvider(config.provider)
    ? {
        thinking: { type: process.env.ZAI_THINKING_TYPE || 'disabled' },
        reasoning_effort: process.env.ZAI_REASONING_EFFORT || 'none',
      }
    : {}),
  messages: ollamaBody.messages,
});

export const openAiCompatibleHeaders = (config: ProviderConfig): Record<string, string> => {
  const headers = authHeaders(config.apiKey);
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://pcb-pilot.web.app';
    headers['X-Title'] = 'PCB Pilot';
  }
  return headers;
};

export const openAiCompatibleUrl = (config: ProviderConfig): string => {
  if (!config.baseUrl) throw new Error('AI_API_URL is not set.');
  if (!config.model) throw new Error('AI_MODEL is not set.');
  if (!config.apiKey) throw new Error('AI_API_KEY is not set.');
  return `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
};

const stringifyContentPart = (part: unknown): string => {
  if (typeof part === 'string') return part;
  if (!isPlainObject(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.output_text === 'string') return part.output_text;
  return '';
};

export const readOpenAiCompatibleContent = (data: Record<string, unknown>): string => {
  const choice = (data?.choices as Record<string, unknown>[])?.[0]
    || ((data?.data as Record<string, unknown>)?.choices as Record<string, unknown>[])?.[0];
  const message = (choice?.message || choice?.delta || choice) as Record<string, unknown> | undefined;
  const content = message?.content ?? (data as Record<string, unknown>)?.output_text ?? (data as Record<string, unknown>)?.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(stringifyContentPart).join('');
  if (isPlainObject(content)) return stringifyContentPart(content);
  return '';
};

const compactResponsePreview = (data: Record<string, unknown>): string => JSON.stringify(data)
  .replace(/"content"\s*:\s*"[^"]{120,}"/g, '"content":"<long content omitted>"')
  .replace(/"reasoning_content"\s*:\s*"[^"]{120,}"/g, '"reasoning_content":"<long reasoning omitted>"')
  .slice(0, 500);

const providerContentError = (config: ProviderConfig, data: Record<string, unknown>): CircuitGenerationError => {
  const choice = (data?.choices as Record<string, unknown>[])?.[0]
    || ((data?.data as Record<string, unknown>)?.choices as Record<string, unknown>[])?.[0];
  const finishReason = (choice as Record<string, unknown>)?.finish_reason;
  if (finishReason === 'length') {
    return new CircuitGenerationError(
      'provider_response',
      `${config.provider} stopped because max_tokens was exhausted before returning final JSON. Increase AI_MAX_TOKENS or keep ZAI_THINKING_TYPE=disabled. Response preview: ${compactResponsePreview(data)}`,
    );
  }
  return new CircuitGenerationError(
    'provider_response',
    `${config.provider} returned no assistant content. Response preview: ${compactResponsePreview(data)}`,
  );
};

// Streaming variant of the OpenAI-compatible call: parses SSE "data:" lines,
// forwards reasoning tokens (delta.reasoning_content — the live "thinking"
// display) and cumulative answer text, and resolves to the full content.
// Gateways that ignore stream:true and answer with one JSON body still work.
export async function streamOpenAiCompatibleContent(
  config: ProviderConfig,
  ollamaBody: OllamaRequestBody,
  handlers: OpenAiStreamHandlers = {},
): Promise<string> {
  const response = await fetch(openAiCompatibleUrl(config), {
    method: 'POST',
    headers: openAiCompatibleHeaders(config),
    body: JSON.stringify(buildOpenAiCompatibleBody(config, { ...ollamaBody, stream: true })),
  });
  if (!response.ok) throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);

  if ((response.headers.get('content-type') || '').includes('application/json')) {
    const data = await response.json() as Record<string, unknown>;
    const content = readOpenAiCompatibleContent(data);
    if (!content) throw providerContentError(config, data);
    handlers.onContent?.(content);
    return content;
  }
  if (!response.body) throw new Error(`${config.provider} did not return a readable response stream.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let lastEvent: Record<string, unknown> = {};

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return; // blank or SSE keepalive comment
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise between events — skip
    }
    if (event.error) {
      throw new Error(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    }
    lastEvent = event;
    const choice = (event.choices as Record<string, unknown>[])?.[0];
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      handlers.onThinking?.(delta.reasoning_content);
    }
    const token = readOpenAiCompatibleContent(event);
    if (token) {
      content += token;
      handlers.onContent?.(content);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (buffered.trim()) consumeLine(buffered);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) throw providerContentError(config, lastEvent);
  return content;
}

async function callOpenAiCompatible(
  config: ProviderConfig,
  prompt: string,
  history: ChatMessage[],
  currentDesign: CurrentDesign | null,
  memory: Partial<ChatMemory> | null,
  correction: CorrectionContext | null,
  handlers: OpenAiStreamHandlers | null = null,
): Promise<string> {
  const ollamaBody = buildOllamaRequestBody(prompt, history, Boolean(handlers), currentDesign, memory, correction);
  if (handlers) return streamOpenAiCompatibleContent(config, ollamaBody, handlers);

  const response = await fetch(openAiCompatibleUrl(config), {
    method: 'POST',
    headers: openAiCompatibleHeaders(config),
    body: JSON.stringify(buildOpenAiCompatibleBody(config, ollamaBody)),
  });

  if (!response.ok) throw new Error(`${config.provider} returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as Record<string, unknown>;
  const content = readOpenAiCompatibleContent(data);
  if (!content) {
    throw providerContentError(config, data);
  }
  return content;
}

export async function generateCircuitWithOllama(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  memory: Partial<ChatMemory> | null = null,
): Promise<GeneratedCircuit> {
  const config = providerConfig();
  if (config.provider !== 'ollama') {
    return parseWithCorrectionRetry((correction) =>
      callOpenAiCompatible(config, prompt, history, currentDesign, memory, correction));
  }

  return parseWithCorrectionRetry(async (correction) => {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(buildOllamaRequestBody(prompt, history, false, currentDesign, memory, correction)),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    return (data.message as Record<string, unknown>)?.content as string || '';
  });
}

export async function streamCircuitWithOllama(
  prompt: string,
  history: ChatMessage[] = [],
  currentDesign: CurrentDesign | null = null,
  onContent: (content: string, state: StreamState) => void = () => {},
  memory: Partial<ChatMemory> | null = null,
  onThinking: (delta: string, state: StreamState) => void = () => {},
): Promise<GeneratedCircuit> {
  const config = providerConfig();
  if (config.provider !== 'ollama') {
    return parseWithCorrectionRetry(async (correction, attempt) => {
      const state: StreamState = { attempt, correcting: attempt > 0 };
      return callOpenAiCompatible(config, prompt, history, currentDesign, memory, correction, {
        onThinking: (delta) => onThinking(delta, state),
        onContent: (partial) => onContent(partial, state),
      });
    });
  }

  return parseWithCorrectionRetry(async (correction, attempt) => {
    const response = await fetch(ollamaUrl(), {
      method: 'POST',
      headers: ollamaHeaders(),
      body: JSON.stringify(buildOllamaRequestBody(prompt, history, true, currentDesign, memory, correction)),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('Ollama did not return a readable response stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let content = '';

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as { error?: string; message?: { content?: string; thinking?: string } };
      if (event.error) throw new Error(event.error);
      // Ollama only emits thinking for models/requests that support it;
      // forward it when present so those setups get the live display too.
      const thinking = event.message?.thinking || '';
      if (thinking) onThinking(thinking, { attempt, correcting: attempt > 0 });
      const token = event.message?.content || '';
      if (!token) return;
      content += token;
      onContent(content, { attempt, correcting: attempt > 0 });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        lines.forEach(consumeLine);
        if (done) break;
      }
      if (buffered.trim()) consumeLine(buffered);
    } finally {
      reader.cancel().catch(() => {});
    }
    return content;
  });
}
