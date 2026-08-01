import { describe, expect, it } from 'vitest';
import { checkConnectivity, runDrc } from './pcbDrc.js';
import { RULES } from './pcbDesignRules.js';

/** Minimal hand-built layout: no placer, no router, just copper. */
const layoutOf = ({ components = [], traces = [], vias = [], board } = {}) => ({
  board: { width: 40, height: 40, thickness: RULES.boardThickness, ...board },
  components,
  traces,
  vias,
  nets: [...new Set([
    ...components.flatMap((component) => component.pads.map((pad) => pad.net)),
    ...traces.map((trace) => trace.net),
  ])],
});

const pad = (x, y, net, extra = {}) => ({
  x, y, net, connected: true, diameter: 1.6, drill: 0.8, pinIndex: 1, padNumber: '1', ...extra,
});

const part = (ref, pads) => ({ ref, kind: 'resistor', value: '1k', x: 0, y: 0, width: 2, height: 2, pads });

const trace = (net, from, to, layer = 'top') => ({
  layer, net, from, to, width: RULES.traceWidth,
});

describe('runDrc', () => {
  it('accepts a layout whose different-net copper is far apart', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 20, 'B')])],
    }));

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags two different-net pads left with only a 0.2 mm gap', () => {
    // Copper edges 0.2 mm apart: 1.8 mm centres minus two 0.8 mm radii.
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(11.8, 10, 'B')])],
    }));

    expect(result.ok).toBe(false);
    const violation = result.violations.find((item) => item.type === 'clearance');
    expect(violation.distance).toBeCloseTo(0.2, 6);
    expect(violation.required).toBe(RULES.clearance);
    expect([violation.netA, violation.netB].sort()).toEqual(['A', 'B']);
  });

  it('ignores pad spacing inside one footprint, which the library fixes', () => {
    // TO-92_Inline really does put its pads 1.27 mm apart; that is the
    // vendor's geometry, not something the pipeline can route around.
    const result = runDrc(layoutOf({
      components: [part('Q1', [pad(10, 10, 'A'), pad(11.27, 10, 'B')])],
    }));

    expect(result.violations).toEqual([]);
  });

  it('never complains about copper that shares a net', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(10.4, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 10.4, y: 10 })],
    }));

    expect(result.violations).toEqual([]);
  });

  it('separates the two copper layers', () => {
    const crossing = { components: [], traces: [], vias: [] };
    crossing.traces = [
      trace('A', { x: 5, y: 10 }, { x: 30, y: 10 }, 'top'),
      trace('B', { x: 20, y: 5 }, { x: 20, y: 30 }, 'bottom'),
    ];

    expect(runDrc(layoutOf(crossing)).violations).toEqual([]);
    crossing.traces[1].layer = 'top';
    expect(runDrc(layoutOf(crossing)).ok).toBe(false);
  });

  it('treats through-hole pads and vias as copper on both layers', () => {
    const bottomOnly = layoutOf({
      components: [part('R1', [pad(10, 10, 'A')])],
      traces: [trace('B', { x: 5, y: 11 }, { x: 20, y: 11 }, 'bottom')],
    });

    // 1 mm between the pad centre and the trace axis: 1 - 0.8 - 0.4 < 0.
    expect(runDrc(bottomOnly).ok).toBe(false);
    expect(runDrc(bottomOnly).violations[0].type).toBe('clearance');
  });

  it('flags copper that crowds the board edge', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(1, 10, 'A')])],
    }));

    const violation = result.violations.find((item) => item.type === 'edge');
    expect(violation.distance).toBeCloseTo(0.2, 6);
    expect(violation.required).toBe(RULES.edgeClearance);
  });

  it('flags a pad whose annular ring is too thin', () => {
    const result = runDrc(layoutOf({
      components: [part('R1', [pad(10, 10, 'A', { diameter: 1.2, drill: 0.8 })])],
    }));

    expect(result.violations.map((item) => item.type)).toContain('annular');
  });

  it('flags a via whose annular ring is too thin', () => {
    const result = runDrc(layoutOf({
      vias: [{ x: 10, y: 10, net: 'A', diameter: 1.2, drill: 0.9 }],
    }));

    const violation = result.violations.find((item) => item.type === 'annular');
    expect(violation.required).toBeCloseTo(1.3, 6);
  });

  it('reports violations in a stable order', () => {
    const layout = layoutOf({
      components: [
        part('R1', [pad(10, 10, 'A'), pad(20, 20, 'C')]),
        part('R2', [pad(11.8, 10, 'B'), pad(21.8, 20, 'D')]),
      ],
    });

    expect(JSON.stringify(runDrc(layout))).toBe(JSON.stringify(runDrc(layout)));
    expect(runDrc(layout).violations).toHaveLength(2);
  });
});

describe('checkConnectivity', () => {
  it('accepts a net whose pads are joined by a trace', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 20, y: 10 })],
    }));

    expect(result).toEqual({ ok: true, incompleteNets: [] });
  });

  it('reports a net whose pads were never wired together', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
    }));

    expect(result.ok).toBe(false);
    expect(result.incompleteNets).toEqual([{ net: 'A', islands: 2 }]);
  });

  it('reports a net whose trace stops short of the far pad', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 10, 'A')])],
      traces: [trace('A', { x: 10, y: 10 }, { x: 15, y: 10 })],
    }));

    expect(result.incompleteNets).toEqual([{ net: 'A', islands: 2 }]);
  });

  it('walks a net through a via between the two layers', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')]), part('R2', [pad(20, 20, 'A')])],
      traces: [
        trace('A', { x: 10, y: 10 }, { x: 20, y: 10 }, 'top'),
        trace('A', { x: 20, y: 10 }, { x: 20, y: 20 }, 'bottom'),
      ],
      vias: [{ x: 20, y: 10, net: 'A', diameter: RULES.viaDiameter, drill: RULES.viaDrill }],
    }));

    expect(result.ok).toBe(true);
  });

  it('accepts a T-junction where a trace lands mid-way along another', () => {
    const result = checkConnectivity(layoutOf({
      components: [
        part('R1', [pad(10, 10, 'A')]),
        part('R2', [pad(20, 10, 'A')]),
        part('R3', [pad(15, 20, 'A')]),
      ],
      traces: [
        trace('A', { x: 10, y: 10 }, { x: 20, y: 10 }),
        trace('A', { x: 15, y: 10 }, { x: 15, y: 20 }),
      ],
    }));

    expect(result.ok).toBe(true);
  });

  it('ignores pads that are not wired to anything', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'R1_1', { connected: false })])],
    }));

    expect(result).toEqual({ ok: true, incompleteNets: [] });
  });

  it('ignores single-pad nets, which need no copper at all', () => {
    const result = checkConnectivity(layoutOf({
      components: [part('R1', [pad(10, 10, 'A')])],
    }));

    expect(result.ok).toBe(true);
  });
});
