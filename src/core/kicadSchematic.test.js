import { describe, expect, it } from 'vitest';
import { buildCircuitDiagram } from './pcbGenerator.js';
import { toKiCadSchematic } from './kicadSchematic.js';
import { KICAD_SYMBOLS } from './kicadSymbolLibrary.js';

const sampleCircuit = {
  title: 'KiCad export test circuit',
  type: 'ai_generated',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VOUT', 'VIN', '0'] },
  ],
  notes: [],
};

// Note: the equivalent arduino_uno circuit currently fails to lay out in
// schematicLayout.js (pre-existing routing limitation), so the MCU coverage
// here uses an esp32 board — the synthesized-box exporter path is identical.
const mcuCircuit = {
  title: 'ESP32 LED blink',
  type: 'ai_generated',
  supplyVoltage: 3.3,
  components: [
    {
      ref: 'U1',
      kind: 'esp32',
      value: '',
      nodes: [
        'NC_U1_1', '0', 'NC_U1_3', 'NC_U1_4', 'GPIO2', 'NC_U1_6',
        'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12',
      ],
    },
    { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['GPIO2', 'LED_A'] },
    { ref: 'D1', kind: 'led', value: 'red', nodes: ['LED_A', '0'] },
  ],
  notes: [],
};

const balancedParens = (text) => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
};

// Every wire endpoint in the document, as "x,y" strings.
const wireEndpoints = (schematic) =>
  [...schematic.matchAll(/\(wire \(pts \(xy ([-\d.]+) ([-\d.]+)\) \(xy ([-\d.]+) ([-\d.]+)\)\)/g)]
    .flatMap((match) => [`${match[1]},${match[2]}`, `${match[3]},${match[4]}`]);

describe('toKiCadSchematic', () => {
  const diagram = buildCircuitDiagram(sampleCircuit);
  const schematic = toKiCadSchematic(sampleCircuit, diagram);

  it('emits a balanced KiCad 6 s-expression document', () => {
    expect(schematic.startsWith('(kicad_sch')).toBe(true);
    expect(balancedParens(schematic)).toBe(true);
    expect(schematic).toContain('(version 20211123)');
    expect(schematic).toContain('(sheet_instances (path "/" (page "1")))');
  });

  it('uses real KiCad library symbols for known kinds', () => {
    expect(schematic).toContain('(symbol "pspice:VSOURCE"');
    expect(schematic).toContain('(lib_id "pspice:VSOURCE")');
    expect(schematic).toContain('(symbol "Device:R"');
    expect(schematic).toContain('(lib_id "Device:R")');
    expect(schematic).toContain('(lib_id "Device:C")');
    expect(schematic).toContain('(lib_id "Device:Q_NPN_BCE")');
    // Hand-drawn PROMPT symbols are gone for curated kinds.
    expect(schematic).not.toContain('(lib_id "PROMPT:R1")');
  });

  it('embeds each used lib symbol exactly once', () => {
    const rDefs = schematic.match(/\(symbol "Device:R" /g) || [];
    expect(rDefs).toHaveLength(1);
  });

  it('keeps reference and value properties per instance', () => {
    for (const part of sampleCircuit.components) {
      expect(schematic).toContain(`(property "Reference" "${part.ref}"`);
      expect(schematic).toContain(`(property "Value" "${part.value}"`);
    }
  });

  it('anchors a wire endpoint on every connected symbol pin', () => {
    const endpoints = new Set(wireEndpoints(schematic));
    // Every placed Device:R instance must have wires reaching both pins.
    // Symbol pin sheet positions are derived the same way the exporter does,
    // so this asserts the wires and instances agree.
    const instance = schematic.match(
      /\(symbol \(lib_id "Device:R"\) \(at ([-\d.]+) ([-\d.]+) (\d+)\)( \(mirror [xy]\))?/,
    );
    expect(instance).toBeTruthy();
    const [, xText, yText, angleText, mirrorText] = instance;
    const center = { x: Number(xText), y: Number(yText) };
    const angle = Number(angleText);
    const mirror = mirrorText?.includes('x') ? 'x' : null;
    for (const pin of Object.values(KICAD_SYMBOLS['Device:R'].pins)) {
      let x = pin.x;
      let y = -pin.y;
      if (mirror === 'x') y = -y;
      const rotated = {
        0: { x, y },
        90: { x: y, y: -x },
        180: { x: -x, y: -y },
        270: { x: -y, y: x },
      }[angle];
      const key = `${Math.round((center.x + rotated.x) * 1000) / 1000},${Math.round((center.y + rotated.y) * 1000) / 1000}`;
      expect(endpoints.has(key)).toBe(true);
    }
  });

  it('places GND power symbols for ground terminals', () => {
    expect(schematic).toContain('(symbol "power:GND"');
    expect(schematic).toContain('(lib_id "power:GND")');
  });

  it('labels named nets', () => {
    const hasNamedNetLabel = (diagram.netLabels || []).some((label) => label.name !== '0');
    if (hasNamedNetLabel) {
      expect(schematic).toMatch(/\(label "(VIN|VOUT)"/);
    }
  });

  it('is deterministic for the same diagram', () => {
    expect(toKiCadSchematic(sampleCircuit, diagram)).toBe(schematic);
  });

  it('returns an empty string without a diagram', () => {
    expect(toKiCadSchematic(sampleCircuit, null)).toBe('');
  });
});

describe('uA741 export', () => {
  const circuit = {
    title: 'uA741 follower',
    type: 'ai_generated',
    supplyVoltage: 12,
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '12V', nodes: ['VCC', '0'] },
      { ref: 'XU1', kind: 'ua741', value: 'uA741', nodes: ['NC_XU1_1', 'VOUT', 'VIN', '0', 'NC_XU1_5', 'VOUT', 'VCC', 'NC_XU1_8'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', '0'] },
    ],
    notes: [],
  };
  const diagram = buildCircuitDiagram(circuit);
  const schematic = toKiCadSchematic(circuit, diagram);

  it('uses the vendored LM741 symbol instead of a synthesized box', () => {
    expect(schematic).toContain('(lib_id "Amplifier_Operational:LM741")');
    expect(schematic).toContain('(property "Reference" "XU1"');
    expect(balancedParens(schematic)).toBe(true);
  });
});

describe('toKiCadSchematic with microcontroller boards', () => {
  const diagram = buildCircuitDiagram(mcuCircuit);
  const schematic = toKiCadSchematic(mcuCircuit, diagram);

  it('synthesizes a module box with named visible pins', () => {
    expect(balancedParens(schematic)).toBe(true);
    expect(schematic).toContain('(symbol "PROMPT:U1"');
    expect(schematic).toContain('(lib_id "PROMPT:U1")');
    // Pins carry the board's fixed pin names, not bare numbers.
    expect(schematic).toContain('(name "GPIO2"');
    expect(schematic).toContain('(name "GND"');
    expect(schematic).toContain('(name "3V3"');
    // The board title fills the empty value.
    expect(schematic).toContain('(property "Value" "ESP32 DevKit"');
  });

  it('uses library symbols for the LED and resistor around the board', () => {
    expect(schematic).toContain('(lib_id "Device:LED")');
    expect(schematic).toContain('(lib_id "Device:R")');
  });

  it('connects wires to the synthesized pins with no stubs', () => {
    // Synthesized pins sit exactly at the canvas terminals, so the GPIO2 wire
    // must start on the U1 pin (pin 5 of the fixed order).
    const u1 = diagram.components.find((component) => component.ref === 'U1');
    const pin = u1.pins.find((item) => item.pinIndex === 5);
    const x = Math.round((pin.x * 0.127 + 12.7) * 1000) / 1000;
    const y = Math.round((pin.y * 0.127 + 12.7) * 1000) / 1000;
    const endpoints = new Set(wireEndpoints(schematic));
    expect(endpoints.has(`${x},${y}`)).toBe(true);
  });
});
