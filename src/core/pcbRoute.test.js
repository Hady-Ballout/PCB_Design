import { describe, expect, it } from 'vitest';
import { GROUND_NET_RE, routeBoard } from './pcbRoute.js';
import { checkConnectivity, runDrc } from './pcbDrc.js';
import { RULES } from './pcbDesignRules.js';

const pad = (x, y, net, extra = {}) => ({
  x, y, net, connected: true, diameter: 1.6, drill: 0.8, padNumber: '1', pinIndex: 1, ...extra,
});

const part = (ref, pads) => ({ ref, kind: 'resistor', value: '', x: 0, y: 0, width: 2, height: 2, pads });

/** A row/column of unwired pads: pure copper obstacle, never routed. */
const wall = (ref, points) => part(ref, points.map(([x, y], index) => pad(x, y, `${ref}_${index + 1}`, {
  connected: false, padNumber: String(index + 1), pinIndex: index + 1,
})));

const asLayout = (input, routed) => ({
  board: { width: input.board.width, height: input.board.height, thickness: RULES.boardThickness },
  components: input.components,
  traces: routed.traces,
  vias: routed.vias,
});

describe('routeBoard', () => {
  const straight = {
    board: { width: 40, height: 20 },
    components: [part('R1', [pad(8, 10, 'SIG')]), part('R2', [pad(32, 10, 'SIG')])],
  };

  it('connects a two-pad net and reports no failures', () => {
    const routed = routeBoard(straight);

    expect(routed.failedNets).toEqual([]);
    expect(routed.traces.length).toBeGreaterThan(0);
    expect(routed.traces.every((trace) => trace.net === 'SIG')).toBe(true);
    expect(checkConnectivity(asLayout(straight, routed)).ok).toBe(true);
    expect(runDrc(asLayout(straight, routed)).violations).toEqual([]);
  });

  it('emits orthogonal segments of the design-rule trace width', () => {
    const routed = routeBoard(straight);

    for (const trace of routed.traces) {
      expect(trace.from.x === trace.to.x || trace.from.y === trace.to.y).toBe(true);
      expect(trace.from.x !== trace.to.x || trace.from.y !== trace.to.y).toBe(true);
      expect(trace.width).toBe(RULES.traceWidth);
      expect(['top', 'bottom']).toContain(trace.layer);
    }
  });

  it('leaves a single-pad net unrouted', () => {
    const routed = routeBoard({
      board: { width: 20, height: 20 },
      components: [part('R1', [pad(10, 10, 'LONELY')])],
    });

    expect(routed).toMatchObject({ traces: [], vias: [], failedNets: [] });
  });

  it('detours around another net rather than shorting to it', () => {
    // A wall of foreign copper straight across the direct path, open only
    // past its bottom end.
    const input = {
      board: { width: 40, height: 30 },
      components: [
        part('R1', [pad(6, 15, 'SIG')]),
        part('R2', [pad(34, 15, 'SIG')]),
        wall('J1', Array.from({ length: 9 }, (_, index) => [20, 3 + index * 2.54])),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toEqual([]);
    const layout = asLayout(input, routed);
    expect(runDrc(layout).violations).toEqual([]);
    expect(checkConnectivity(layout).ok).toBe(true);
    // The wall ends at y = 23.32, so the only way across is below it.
    const lowest = Math.max(...routed.traces.flatMap((trace) => [trace.from.y, trace.to.y]));
    expect(lowest).toBeGreaterThan(23.32);
  });

  it('reports the nets it could not route instead of shorting them', () => {
    const input = {
      board: { width: 40, height: 32 },
      components: [
        part('R1', [pad(6, 15, 'SIG')]),
        part('R2', [pad(34, 15, 'SIG')]),
        // A wall from edge to edge: there is genuinely no way across.
        wall('J1', Array.from({ length: 12 }, (_, index) => [20, 1.5 + index * 2.54])),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toHaveLength(1);
    expect(routed.failedNets[0]).toMatchObject({ net: 'SIG', reason: 'unroutable' });
    expect(routed.failedNets[0].from).toEqual({ x: 6, y: 15 });
    expect(routed.failedNets[0].to).toEqual({ x: 34, y: 15 });
    // Nothing half-finished is left behind on a failed job.
    expect(runDrc(asLayout(input, routed)).violations).toEqual([]);
  });

  it('joins a third pad onto copper that is already down', () => {
    const input = {
      board: { width: 40, height: 30 },
      components: [
        part('R1', [pad(6, 8, 'SIG')]),
        part('R2', [pad(34, 8, 'SIG')]),
        part('R3', [pad(20, 24, 'SIG')]),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toEqual([]);
    expect(checkConnectivity(asLayout(input, routed)).ok).toBe(true);
  });

  it('puts every via on a real layer change', () => {
    const input = {
      board: { width: 44, height: 34 },
      components: [
        part('R1', [pad(6, 6, 'A'), pad(6, 28, 'B')]),
        part('R2', [pad(38, 28, 'A'), pad(38, 6, 'B')]),
        wall('J1', Array.from({ length: 7 }, (_, index) => [22, 8 + index * 2.54])),
      ],
    };

    const routed = routeBoard(input);

    for (const via of routed.vias) {
      expect(via).toMatchObject({ diameter: RULES.viaDiameter, drill: RULES.viaDrill });
      const touching = routed.traces.filter((trace) => trace.net === via.net
        && [trace.from, trace.to].some((point) => Math.hypot(point.x - via.x, point.y - via.y) < 1e-6));
      expect(touching.length).toBeGreaterThanOrEqual(2);
      expect(new Set(touching.map((trace) => trace.layer)).size).toBe(2);
    }
  });

  it('is deterministic', () => {
    const input = {
      board: { width: 44, height: 34 },
      components: [
        part('R1', [pad(6, 6, 'A'), pad(6, 28, 'B')]),
        part('R2', [pad(38, 28, 'A'), pad(38, 6, 'B')]),
        part('R3', [pad(22, 17, '0'), pad(30, 17, 'A')]),
      ],
    };

    expect(routeBoard(input)).toEqual(routeBoard(input));
    expect(JSON.stringify(routeBoard(input))).toBe(JSON.stringify(routeBoard(input)));
  });

  it('snaps every coordinate to three decimals', () => {
    const routed = routeBoard(straight);
    const coordinates = routed.traces.flatMap((trace) => [trace.from.x, trace.from.y, trace.to.x, trace.to.y]);

    for (const value of coordinates) expect(value).toBe(Math.round(value * 1000) / 1000);
  });
});

describe('GROUND_NET_RE', () => {
  it('recognises the net names a ground pour would claim', () => {
    for (const name of ['gnd', 'GND', 'Ground', '0']) expect(GROUND_NET_RE.test(name)).toBe(true);
    for (const name of ['VCC', 'VIN', 'GND2', '00']) expect(GROUND_NET_RE.test(name)).toBe(false);
  });
});
