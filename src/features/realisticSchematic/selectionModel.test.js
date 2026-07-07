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
});
