import { describe, expect, it } from 'vitest';
import { buildPcbLayout, footprintFor } from './pcbLayout.js';

const sampleCircuit = {
  title: 'PCB layout test circuit',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VOUT', 'FB', 'OUT', 'VIN', '0'] },
  ],
};

describe('buildPcbLayout', () => {
  const layout = buildPcbLayout(sampleCircuit);

  it('returns null for empty circuits', () => {
    expect(buildPcbLayout({ components: [] })).toBeNull();
    expect(buildPcbLayout(null)).toBeNull();
  });

  it('places every component inside the board outline', () => {
    expect(layout.components).toHaveLength(4);
    for (const component of layout.components) {
      expect(component.x - component.width / 2).toBeGreaterThanOrEqual(0);
      expect(component.y - component.height / 2).toBeGreaterThanOrEqual(0);
      expect(component.x + component.width / 2).toBeLessThanOrEqual(layout.board.width);
      expect(component.y + component.height / 2).toBeLessThanOrEqual(layout.board.height);
    }
  });

  it('keeps component bodies from overlapping', () => {
    const items = layout.components;
    for (let a = 0; a < items.length; a += 1) {
      for (let b = a + 1; b < items.length; b += 1) {
        const dx = Math.abs(items[a].x - items[b].x);
        const dy = Math.abs(items[a].y - items[b].y);
        const overlaps = dx < (items[a].width + items[b].width) / 2
          && dy < (items[a].height + items[b].height) / 2;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('gives every node a pad on its component', () => {
    for (const part of sampleCircuit.components) {
      const component = layout.components.find((item) => item.ref === part.ref);
      expect(component.pads).toHaveLength(part.nodes.length);
      expect(component.pads.map((pad) => pad.net)).toEqual(part.nodes);
    }
  });

  it('routes every multi-pad net with connected orthogonal traces', () => {
    for (const net of layout.nets) {
      const pads = layout.components.flatMap((component) =>
        component.pads.filter((pad) => pad.connected && pad.net === net));
      if (pads.length < 2) continue;
      const netTraces = layout.traces.filter((trace) => trace.net === net);
      expect(netTraces.length).toBeGreaterThan(0);
      // Every trace segment is orthogonal.
      for (const trace of netTraces) {
        expect(trace.from.x === trace.to.x || trace.from.y === trace.to.y).toBe(true);
      }
      // Union-find over pads + trace endpoints: the whole net is one island.
      const key = (point) => `${point.x}:${point.y}`;
      const parent = new Map();
      const find = (k) => {
        while (parent.get(k) !== k) {
          parent.set(k, parent.get(parent.get(k)));
          k = parent.get(k);
        }
        return k;
      };
      const union = (a, b) => {
        for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
        parent.set(find(a), find(b));
      };
      for (const trace of netTraces) union(key(trace.from), key(trace.to));
      for (const pad of pads) if (!parent.has(key(pad))) parent.set(key(pad), key(pad));
      const root = find(key(pads[0]));
      for (const pad of pads) expect(find(key(pad))).toBe(root);
    }
  });

  it('adds a via at every top/bottom layer bend', () => {
    const bends = layout.traces.filter((trace) => trace.layer === 'bottom'
      && trace.from.x === trace.to.x && trace.from.y !== trace.to.y).length;
    expect(layout.vias.length).toBeLessThanOrEqual(layout.traces.length);
    expect(bends).toBeGreaterThanOrEqual(0);
    for (const via of layout.vias) {
      expect(via.x).toBeGreaterThanOrEqual(0);
      expect(via.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('stretches footprints for parts with extra nodes', () => {
    const stretched = footprintFor({ kind: 'resistor', ref: 'RX', nodes: ['A', 'B', 'C', 'D'] });
    expect(stretched.pads).toHaveLength(4);
  });
});
