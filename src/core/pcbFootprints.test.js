import { describe, expect, it } from 'vitest';
import { footprintRecordFor } from './pcbFootprints.js';
import { KICAD_FOOTPRINTS } from './kicadFootprintLibrary.js';
import { ALLOWED_KINDS, DEFAULT_PIN_COUNT_BY_KIND } from './componentKinds.js';

const partWithNodes = (kind, nodeCount) => ({
  ref: 'X1',
  kind,
  value: '',
  nodes: Array.from({ length: nodeCount }, (_, index) => `N${index + 1}`),
});

describe('footprintRecordFor', () => {
  it('resolves every kind in the component registry with enough pads and a full padOrder', () => {
    for (const kind of ALLOWED_KINDS) {
      const nodeCount = DEFAULT_PIN_COUNT_BY_KIND[kind] ?? 2;
      const part = partWithNodes(kind, nodeCount);
      const { record, padOrder } = footprintRecordFor(part);

      expect(record.pads.length, `${kind}: pad count`).toBeGreaterThanOrEqual(nodeCount);
      expect(padOrder, `${kind}: padOrder length`).toHaveLength(nodeCount);
      const padNumbers = new Set(record.pads.map((pad) => pad.number));
      for (const number of padOrder) {
        expect(padNumbers.has(number), `${kind}: padOrder references pad "${number}"`).toBe(true);
      }
    }
  });

  it('gives the DIP-8 footprint 8 pads, a 0.8mm drill and a 7.62mm row span', () => {
    const record = KICAD_FOOTPRINTS['Package_DIP:DIP-8_W7.62mm'];

    expect(record.pads).toHaveLength(8);
    for (const pad of record.pads) expect(pad.drill).toBe(0.8);
    const xs = record.pads.map((pad) => pad.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(7.62, 5);
    const pin1 = record.pads.find((pad) => pad.number === '1');
    expect(pin1.x).toBeLessThan(0);
    expect(pin1.y).toBeLessThan(0);
  });

  it('maps diode anode to pad 2 and cathode to pad 1', () => {
    const { padOrder } = footprintRecordFor({ ref: 'D1', kind: 'diode', nodes: ['ANODE', 'CATHODE'] });

    expect(padOrder).toEqual(['2', '1']);
  });

  it('round-trips an exact part.footprint string to its vendored record', () => {
    const part = { ref: 'U1', kind: 'opamp', footprint: 'Package_DIP:DIP-8_W7.62mm', nodes: ['1', '2', '3', '4', '5', '6', '7', '8'] };
    const { libId, record } = footprintRecordFor(part);

    expect(libId).toBe('Package_DIP:DIP-8_W7.62mm');
    expect(record).toBe(KICAD_FOOTPRINTS['Package_DIP:DIP-8_W7.62mm']);
  });

  it('synthesizes a 2x6 dual-row header with a 1.0mm drill for a 12-node module', () => {
    const part = { ref: 'U1', kind: 'weird_module', nodes: Array.from({ length: 12 }, (_, index) => `P${index + 1}`) };
    const { record, padOrder } = footprintRecordFor(part);

    expect(record.pads).toHaveLength(12);
    expect(padOrder).toHaveLength(12);
    for (const pad of record.pads) expect(pad.drill).toBe(1.0);
    const uniqueX = new Set(record.pads.map((pad) => pad.x));
    const uniqueY = new Set(record.pads.map((pad) => pad.y));
    expect(uniqueX.size).toBe(6);
    expect(uniqueY.size).toBe(2);
  });

  it('is deterministic: two calls for the same part produce deeply equal results', () => {
    const part = { ref: 'R1', kind: 'resistor', nodes: ['A', 'B'] };

    expect(footprintRecordFor(part)).toEqual(footprintRecordFor({ ...part }));
  });
});
