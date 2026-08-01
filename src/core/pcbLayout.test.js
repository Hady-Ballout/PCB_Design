import { describe, expect, it } from 'vitest';
import { buildPcbLayout } from './pcbLayout.js';
import { footprintRecordFor } from './pcbFootprints.js';
import { placeComponents } from './pcbPlace.js';

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
    expect(layout.routing.complete).toBe(true);
    expect(layout.routing.failedNets).toEqual([]);
    expect(layout.connectivity).toEqual({ ok: true, incompleteNets: [] });

    for (const net of layout.nets) {
      const pads = layout.components.flatMap((component) =>
        component.pads.filter((pad) => pad.connected && pad.net === net));
      if (pads.length < 2) continue;
      const netTraces = layout.traces.filter((trace) => trace.net === net);
      expect(netTraces.length).toBeGreaterThan(0);
      for (const trace of netTraces) {
        expect(trace.from.x === trace.to.x || trace.from.y === trace.to.y).toBe(true);
      }
    }
  });

  it('leaves no different-net copper closer than the clearance rule', () => {
    expect(layout.drc).toEqual({ ok: true, violations: [] });
  });

  it('reports the board outline the copper was routed inside', () => {
    expect(layout.board.outline).toEqual({
      x: 0, y: 0, width: layout.board.width, height: layout.board.height,
    });
  });

  it('puts every via inside the board on a real layer change', () => {
    for (const via of layout.vias) {
      expect(via.x).toBeGreaterThanOrEqual(0);
      expect(via.y).toBeGreaterThanOrEqual(0);
      expect(via.x).toBeLessThanOrEqual(layout.board.width);
      expect(via.y).toBeLessThanOrEqual(layout.board.height);

      const touching = layout.traces.filter((trace) => trace.net === via.net
        && [trace.from, trace.to].some((point) =>
          Math.hypot(point.x - via.x, point.y - via.y) < 1e-6));
      expect(touching.length).toBeGreaterThanOrEqual(2);
      expect(new Set(touching.map((trace) => trace.layer))).toEqual(new Set(['top', 'bottom']));
    }
  });

  it('stretches footprints for parts with extra nodes', () => {
    // A resistor with 4 nodes doesn't fit the vendored 2-pad R_Axial, so it
    // falls through to the synthesized header fallback instead.
    const part = { kind: 'resistor', ref: 'RX', nodes: ['A', 'B', 'C', 'D'] };
    const { record, padOrder } = footprintRecordFor(part);
    expect(record.pads).toHaveLength(4);
    expect(padOrder).toHaveLength(4);
  });

  it("records the placer's rotation on every component", () => {
    for (const component of layout.components) {
      expect([0, 90, 180, 270]).toContain(component.rotation);
      // Pads sit inside the component's (rotated) courtyard extent.
      for (const pad of component.pads) {
        expect(Math.abs(pad.x - component.x)).toBeLessThanOrEqual(component.width / 2 + 0.01);
        expect(Math.abs(pad.y - component.y)).toBeLessThanOrEqual(component.height / 2 + 0.01);
      }
    }
  });

  it('spreads the board out when asked to expand', () => {
    const expanded = buildPcbLayout(sampleCircuit, { expandFactor: 1.35 });
    expect(expanded.board.width * expanded.board.height)
      .toBeGreaterThan(layout.board.width * layout.board.height);
  });

  it('keeps the tight board when the first routing attempt already succeeds', () => {
    // The expansion ladder is a retry, not a default: a board that routes
    // straight away must not be spread out for nothing.
    const tight = placeComponents(sampleCircuit.components, { expandFactor: 1 }).board;

    expect(layout.routing.complete).toBe(true);
    expect(layout.board.width).toBe(tight.width);
    expect(layout.board.height).toBe(tight.height);
  });

  it('gives the uA741 a clean DIP-8 footprint', () => {
    const part = { kind: 'ua741', ref: 'XU1', nodes: ['N1', 'O', 'I', '0', 'N5', 'O', 'V', 'N8'] };
    const { libId, record } = footprintRecordFor(part);
    expect(libId).toBe('Package_DIP:DIP-8_W7.62mm');
    expect(record.pads).toHaveLength(8);
    const component = buildPcbLayout({ components: [part] }).components[0];
    expect(component.body).toBe('dip');
  });
});

/**
 * The manufacturability contract, run end to end on real circuits: whatever
 * the placer and router come up with, an independent checker has to agree the
 * board is short-free and fully wired, and two runs have to agree byte for
 * byte.
 */
const rcLowPass = {
  title: 'RC low-pass',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

const invertingAmp = {
  title: 'Inverting amplifier',
  components: [
    { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['0', 'INV', 'OUT', 'VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['IN', 'INV'] },
    { ref: 'R2', kind: 'resistor', value: '100k', nodes: ['INV', 'OUT'] },
    { ref: 'V1', kind: 'signal_source', value: '1Vpp', nodes: ['IN', '0'] },
    { ref: 'V2', kind: 'voltage_source', value: '12V', nodes: ['VCC', '0'] },
  ],
};

const astable555 = {
  title: '555 astable',
  components: [
    { ref: 'U1', kind: 'timer_555', value: 'NE555', nodes: ['0', 'THR', 'OUT', 'VCC', 'CTRL', 'THR', 'DIS', 'VCC'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'DIS'] },
    { ref: 'R2', kind: 'resistor', value: '47k', nodes: ['DIS', 'THR'] },
    { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['THR', '0'] },
    { ref: 'C2', kind: 'capacitor', value: '10nF', nodes: ['CTRL', '0'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['OUT', 'LEDA'] },
    { ref: 'R3', kind: 'resistor', value: '330', nodes: ['LEDA', '0'] },
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
  ],
};

const sensorBoard = {
  title: 'Sensor board',
  components: [
    {
      ref: 'U1',
      kind: 'esp32',
      value: 'ESP32-WROOM',
      nodes: ['VCC', '0', 'SDA', 'SCL', 'LED1', 'LED2', 'BTN', 'ADC', 'TX', 'RX', 'VCC', '0'],
    },
    { ref: 'U2', kind: 'temp_sensor', value: 'TMP36', nodes: ['VCC', 'ADC', '0'] },
    { ref: 'U3', kind: 'oled_display', value: 'SSD1306', nodes: ['VCC', '0', 'SDA', 'SCL'] },
    { ref: 'R1', kind: 'resistor', value: '4k7', nodes: ['VCC', 'SDA'] },
    { ref: 'R2', kind: 'resistor', value: '4k7', nodes: ['VCC', 'SCL'] },
    { ref: 'R3', kind: 'resistor', value: '330', nodes: ['LED1', 'A1'] },
    { ref: 'R4', kind: 'resistor', value: '330', nodes: ['LED2', 'A2'] },
    { ref: 'R5', kind: 'resistor', value: '10k', nodes: ['VCC', 'BTN'] },
    { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['A1', '0'] },
    { ref: 'DLED2', kind: 'led', value: 'green', nodes: ['A2', '0'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VCC', '0'] },
    { ref: 'C2', kind: 'capacitor', value: '10uF', nodes: ['VCC', '0'] },
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
  ],
};

describe.each([
  ['an RC low-pass', rcLowPass],
  ['an inverting amplifier', invertingAmp],
  ['a 555 astable', astable555],
  ['a module-based sensor board', sensorBoard],
])('buildPcbLayout on %s', (_name, circuit) => {
  const layout = buildPcbLayout(circuit);

  it('routes every net', () => {
    expect(layout.routing.failedNets).toEqual([]);
    expect(layout.routing.complete).toBe(true);
  });

  it('passes an independent design rule check', () => {
    expect(layout.drc.violations).toEqual([]);
    expect(layout.drc.ok).toBe(true);
  });

  it('leaves every net in one electrical island', () => {
    expect(layout.connectivity.incompleteNets).toEqual([]);
    expect(layout.connectivity.ok).toBe(true);
  });

  it('keeps every pad and trace inside the board outline', () => {
    const { outline } = layout.board;
    for (const trace of layout.traces) {
      for (const point of [trace.from, trace.to]) {
        expect(point.x).toBeGreaterThanOrEqual(outline.x);
        expect(point.y).toBeGreaterThanOrEqual(outline.y);
        expect(point.x).toBeLessThanOrEqual(outline.x + outline.width);
        expect(point.y).toBeLessThanOrEqual(outline.y + outline.height);
      }
    }
  });

  it('is byte-for-byte deterministic', () => {
    expect(JSON.stringify(buildPcbLayout(circuit))).toBe(JSON.stringify(buildPcbLayout(circuit)));
  });
});

describe('buildPcbLayout when a footprint is too tight to escape', () => {
  // TO-92_Inline puts its three pads on a 1.27 mm pitch. There is no room for
  // a 0.8 mm trace to leave the middle pad at 0.3 mm clearance, so the router
  // has to say so rather than lay copper that shorts to the neighbours.
  const layout = buildPcbLayout({
    components: [
      { ref: 'Q1', kind: 'bjt_npn', value: '2N3904', nodes: ['C', 'B', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'C'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['IN', 'B'] },
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'V2', kind: 'signal_source', value: '1Vpp', nodes: ['IN', '0'] },
    ],
  });

  it('reports the failure structurally instead of shorting', () => {
    expect(layout.routing.complete).toBe(false);
    expect(layout.routing.failedNets.every((failure) => failure.reason === 'no_escape')).toBe(true);
    expect(layout.connectivity.ok).toBe(false);
  });

  it('still leaves the copper it did lay design-rule clean', () => {
    expect(layout.drc).toEqual({ ok: true, violations: [] });
  });
});

describe('buildPcbLayout performance', () => {
  it('routes a 30-part board well inside the time budget', () => {
    const components = [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      ...Array.from({ length: 12 }, (_, index) => ({
        ref: `R${index + 1}`, kind: 'resistor', value: '1k',
        nodes: ['VCC', `N${index + 1}`],
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        ref: `DLED${index + 1}`, kind: 'led', value: 'red',
        nodes: [`N${index + 1}`, '0'],
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        ref: `C${index + 1}`, kind: 'capacitor', value: '100nF',
        nodes: ['VCC', '0'],
      })),
    ];

    const started = Date.now();
    const layout = buildPcbLayout({ components });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(layout.components).toHaveLength(30);
    expect(layout.drc.violations).toEqual([]);
  });
});
