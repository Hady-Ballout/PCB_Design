import { describe, expect, it } from 'vitest';
import { circuitToBreadboard } from './breadboardModel.js';
import { highlightFor, pinLabelsFor, readoutFor } from './selectionModel.js';

const circuit = {
  nodes: ['VCC', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['VOUT', 'NC_DLED1_2'] },
  ],
};
const model = circuitToBreadboard(circuit);

describe('highlightFor', () => {
  it('is inactive with no selection', () => {
    const highlight = highlightFor(model, null);
    expect(highlight.active).toBe(false);
    expect(highlight.partRefs.size).toBe(0);
  });

  it('lights a part plus the full neighborhood of its pins', () => {
    const highlight = highlightFor(model, { type: 'part', ref: 'R1' });
    expect(highlight.active).toBe(true);
    expect([...highlight.partRefs]).toEqual(['R1']); // neighbors stay dimmed
    expect(highlight.nets).toEqual(new Set(['VCC', 'VOUT']));
    expect(highlight.railStrips).toEqual(new Set(['railTopPlus']));
    // R1's VCC leg jumpers to the + rail.
    const vccJumpers = model.jumpers.filter((jumper) => jumper.net === 'VCC').map((jumper) => jumper.id);
    vccJumpers.forEach((id) => expect(highlight.jumperIds.has(id)).toBe(true));
    // The VOUT tie group glows.
    expect(highlight.groupKeys.size).toBeGreaterThan(0);
    expect(highlight.batteryRefs).toEqual(new Set(['V1'])); // V1 feeds VCC
    // Each lit carrier knows its net, so the overlay can tint per net.
    highlight.groupKeys.forEach((key) => expect(highlight.nets.has(highlight.groupKeyNets.get(key))).toBe(true));
    expect([...highlight.groupKeyNets.values()]).toContain('VOUT');
    expect(highlight.railStripNets.get('railTopPlus')).toBe('VCC');
  });

  it('lights a whole net including the parts on it', () => {
    const highlight = highlightFor(model, { type: 'net', net: 'VOUT' });
    expect(highlight.partRefs).toEqual(new Set(['R1', 'R2', 'DLED1']));
    expect(highlight.railStrips.size).toBe(0);
  });

  it('treats a battery like a part on its rail nets', () => {
    const highlight = highlightFor(model, { type: 'part', ref: 'V1' });
    expect(highlight.nets).toEqual(new Set(['VCC', '0']));
    expect(highlight.railStrips).toEqual(new Set(['railTopPlus', 'railTopMinus']));
  });

  it('ignores NC pins', () => {
    const highlight = highlightFor(model, { type: 'part', ref: 'DLED1' });
    expect(highlight.nets).toEqual(new Set(['VOUT']));
  });
});

describe('readoutFor', () => {
  it('describes parts, batteries, and nets', () => {
    expect(readoutFor(model, { type: 'part', ref: 'R1' })).toBe('R1 · resistor · 1k');
    expect(readoutFor(model, { type: 'part', ref: 'V1' })).toBe('V1 · voltage source · 5V');
    // VOUT: R1 pin2, R2 pin1, DLED1 pin1.
    expect(readoutFor(model, { type: 'net', net: 'VOUT' })).toBe('net VOUT · 3 pins');
    expect(readoutFor(model, { type: 'net', net: '0' })).toContain('net GND');
    expect(readoutFor(model, null)).toBeNull();
  });
});

describe('pinLabelsFor', () => {
  it('labels multi-pin and polarized parts only', () => {
    expect(pinLabelsFor({ kind: 'opamp' })).toEqual(['IN+', 'IN-', 'OUT', 'V+', 'V-']);
    expect(pinLabelsFor({ kind: 'mosfet_n' })).toEqual(['D', 'G', 'S']);
    expect(pinLabelsFor({ kind: 'led' })).toEqual(['A', 'K']);
    expect(pinLabelsFor({ kind: 'capacitor', value: '10uF' })).toEqual(['+', '−']);
    expect(pinLabelsFor({ kind: 'capacitor', value: '100nF' })).toBeNull();
    expect(pinLabelsFor({ kind: 'resistor', value: '1k' })).toBeNull();
  });

  it('labels the extended kinds from the registry and the SPICE contracts', () => {
    // fixedPins kinds come straight from the componentKinds registry…
    expect(pinLabelsFor({ kind: 'timer_555' })).toEqual(['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC']);
    expect(pinLabelsFor({ kind: 'temp_sensor' })).toEqual(['VCC', 'OUT', 'GND']);
    expect(pinLabelsFor({ kind: 'regulator' })).toEqual(['IN', 'GND', 'OUT']);
    expect(pinLabelsFor({ kind: 'relay_module' })).toEqual(['VCC', 'GND', 'IN', 'COM', 'NO', 'NC']);
    // …the rest mirror the canonical orders in the SPICE exporter.
    expect(pinLabelsFor({ kind: 'zener' })).toEqual(['A', 'K']);
    expect(pinLabelsFor({ kind: 'comparator' })).toEqual(['IN+', 'IN-', 'OUT', 'V+', 'V-']);
    expect(pinLabelsFor({ kind: 'potentiometer' })).toEqual(['A', 'W', 'B']);
    expect(pinLabelsFor({ kind: 'switch_spdt' })).toEqual(['A', 'COM', 'B']);
    expect(pinLabelsFor({ kind: 'rgb_led' })).toEqual(['R', 'G', 'B', 'K']);
    expect(pinLabelsFor({ kind: 'buzzer' })).toEqual(['+', '−']);
    expect(pinLabelsFor({ kind: 'dc_motor' })).toEqual(['+', '−']);
  });

  it('labels microcontroller boards with their canonical header pins', () => {
    expect(pinLabelsFor({ kind: 'arduino_uno' })).toEqual(['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    expect(pinLabelsFor({ kind: 'raspberry_pi' })).toEqual(['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22']);
    expect(pinLabelsFor({ kind: 'esp32' })).toEqual(['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22']);
  });
});

describe('MCU highlighting', () => {
  const mcuModel = circuitToBreadboard({
    nodes: ['VCC5', 'LED', '0'],
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

  it('lights an MCU part plus the neighborhood of its connected pins only', () => {
    const highlight = highlightFor(mcuModel, { type: 'part', ref: 'U1' });
    expect(highlight.active).toBe(true);
    expect(highlight.nets).toEqual(new Set(['VCC5', '0', 'LED']));
    expect(highlight.railStrips.has('railTopPlus')).toBe(true);
  });

  it('describes an MCU part in the readout', () => {
    expect(readoutFor(mcuModel, { type: 'part', ref: 'U1' })).toBe('U1 · arduino uno · Uno R3');
  });
});
