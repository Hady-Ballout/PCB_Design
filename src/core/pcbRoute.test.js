import { describe, expect, it } from 'vitest';
import { GROUND_NET_RE, routeBoard } from './pcbRoute.js';
import { checkConnectivity, runDrc } from './pcbDrc.js';
import { RULES } from './pcbDesignRules.js';

const pad = (x, y, net, extra = {}) => ({
  x, y, net, connected: true, diameter: 1.6, drill: 0.8, padNumber: '1', pinIndex: 1, ...extra,
});

const part = (ref, pads) => ({ ref, kind: 'resistor', value: '', x: 0, y: 0, width: 2, height: 2, pads });

/** A row/column of unwired pads: pure copper obstacle, never routed. */
const wall = (ref, points, extra = {}) => part(ref, points.map(([x, y], index) => pad(x, y, `${ref}_${index + 1}`, {
  connected: false, padNumber: String(index + 1), pinIndex: index + 1, ...extra,
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
      board: { width: 40, height: 31 },
      components: [
        part('R1', [pad(6, 15, 'SIG')]),
        part('R2', [pad(34, 15, 'SIG')]),
        // A wall from edge to edge: there is genuinely no way across, at any
        // rung of the neck-down ladder. 2 mm pads on a 2.54 mm pitch leave
        // 0.54 mm of air between neighbours, and even the 0.25 mm bottom rung
        // needs 0.25 + 2 x 0.3 = 0.85 mm to pass.
        wall('J1', Array.from({ length: 12 }, (_, index) => [20, 1.5 + index * 2.54]),
          { diameter: 2, drill: 1.2 }),
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

  it('threads a gap that only exists once oval pads are modelled as stadiums', () => {
    // A wall of 1.05 x 3.0 mm oval pads on a 3.81 mm pitch, sealed against both
    // board edges, with the routed net's pads on either side of it. The only
    // way through is the column midway between two wall pads, 1.905 mm from
    // each pad centre:
    //
    //   stadium model — the pad's core is a vertical 1.95 mm segment inflated
    //     by r = 0.525, so the cell has to clear the CORE by
    //     hypot(r + clearance + traceHalf, pitch/2) = hypot(1.225, 0.3175)
    //     = 1.2655 mm.  1.905 > 1.2655, the gap is open.
    //   circumscribing circle — the same pad becomes a max(w,h)/2 = 1.5 mm
    //     disc, needing hypot(1.5 + 0.7, 0.3175) = 2.2228 mm.  1.905 < 2.2228,
    //     every gap in the wall is walled off and the net is 'unroutable'.
    //
    // 0.45 mm per pad of copper that is not there is the difference between a
    // BJT board and a failure report.
    const wallPad = (x) => pad(x, 15.24, `J1_${Math.round(x * 100)}`, {
      connected: false, shape: 'oval', size: { w: 1.05, h: 3 }, diameter: 3, drill: 0.7,
      padNumber: String(Math.round(x * 100)),
    });
    const input = {
      board: { width: 34, height: 30 },
      components: [
        part('R1', [pad(3.81, 5.08, 'SIG')]),
        part('R2', [pad(3.81, 25.4, 'SIG')]),
        part('J1', Array.from({ length: 9 }, (_, index) => wallPad(1.905 + index * 3.81))),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toEqual([]);
    const layout = asLayout(input, routed);
    expect(runDrc(layout).violations).toEqual([]);
    expect(checkConnectivity(layout).ok).toBe(true);
    // The copper really does cross the wall's row rather than sneaking round it.
    expect(routed.traces.some((trace) => Math.min(trace.from.y, trace.to.y) < 15.24
      && Math.max(trace.from.y, trace.to.y) > 15.24)).toBe(true);
  });

  it('necks a job down only as far as the tight pad needs, and only that job', () => {
    // Two nets on one board. SIG has to leave a pad wedged between two foreign
    // pads 1.27 mm away on each side — a full 0.8 mm trace needs 0.7 mm of air
    // to each, which is not there — while WIDE has the whole board to itself.
    //
    // Escape room at the terminal cell, in trace half-widths: the pinched pad
    // allows 0.445 - |offset|, so the ladder has to walk 0.8 -> 0.5 -> 0.4 ->
    // 0.25 before the job fits. WIDE must stay at 0.8: the ladder is a rescue,
    // not a default.
    const pinched = (x, y, net, extra) => pad(x, y, net, {
      shape: 'oval', size: { w: 1.05, h: 1.5 }, diameter: 1.5, drill: 0.7, ...extra,
    });
    // 12.95 sits 0.25 mm off the 0.635 mm grid, which is what makes this hard:
    // the best cell inside the pad is 0.25 mm off centre, and 0.4 mm is the
    // widest half-trace that still clears the neighbour at 1.02 mm.
    const input = {
      board: { width: 30, height: 26 },
      components: [
        part('Q1', [
          pinched(12.95 - 1.27, 6.35, 'Q1_1', { connected: false, padNumber: '1' }),
          pinched(12.95, 6.35, 'SIG', { padNumber: '2' }),
          pinched(12.95 + 1.27, 6.35, 'Q1_3', { connected: false, padNumber: '3' }),
        ]),
        part('R1', [pad(12.7, 19.05, 'SIG')]),
        part('R2', [pad(3.81, 12.7, 'WIDE'), pad(25.4, 12.7, 'WIDE')]),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toEqual([]);
    const widths = new Map();
    for (const trace of routed.traces) {
      widths.set(trace.net, Math.min(widths.get(trace.net) ?? Infinity, trace.width));
    }
    expect(widths.get('WIDE')).toBe(RULES.traceWidth);
    expect(widths.get('SIG')).toBeLessThan(RULES.traceWidth);
    expect(widths.get('SIG')).toBeGreaterThanOrEqual(RULES.minTraceWidth);
    expect(RULES.traceWidthLadder).toContain(widths.get('SIG'));
    // One width per job: the whole SIG connection is laid at the neck.
    expect(new Set(routed.traces.filter((trace) => trace.net === 'SIG')
      .map((trace) => trace.width)).size).toBe(1);

    const layout = asLayout(input, routed);
    expect(runDrc(layout).violations).toEqual([]);
    expect(checkConnectivity(layout).ok).toBe(true);
  });

  it('will not start a full-width job from a cell only a neck ever fitted', () => {
    // A three-pad net whose first pad is the pinched middle pin of a TO-92.
    // Its terminal cell is (12.7, 6.985), and `escape.limit` there is 0.2276 —
    // room for the 0.4 mm rung and nothing wider.
    //
    // Job 1 (Q1.2 -> R1, the MST's short edge) necks to 0.4 and runs straight
    // down the corridor. Job 2 (R1 -> R2) has full-width endpoints, so it is
    // tried at 0.8 — and its source island now CONTAINS the pinched pad. The
    // cheapest way out to R2 is the row below the TO-92, which is one step off
    // the pinched terminal, so seeding that terminal as a source hands the wide
    // job a free start on a cell only a 0.4 mm trace was ever cleared for.
    //
    // The wall column (J1, sealed to both board edges, one gap at y = 8.255)
    // is what makes that start the cheapest one: every route to R2 has to come
    // through that gap, and the pinched terminal sits two rows above it while
    // R1 sits six rows below.
    //
    // Before the per-rung admission check the router laid
    // `top 0.8 (12.7,6.985)->(12.7,8.255)` straight off that terminal, and DRC
    // called it: clearance 0.174 against pad Q1.1, required 0.3. The board
    // failed loud rather than shorting silently, but it failed.
    const pinched = (x, y, net, extra) => pad(x, y, net, {
      shape: 'oval', size: { w: 1.05, h: 1.5 }, diameter: 1.5, drill: 0.7, ...extra,
    });
    const input = {
      board: { width: 32, height: 13.335 },
      components: [
        part('Q1', [
          pinched(11.68, 6.35, 'Q1_1', { connected: false, padNumber: '1' }),
          pinched(12.95, 6.35, 'SIG', { padNumber: '2' }),
          pinched(14.22, 6.35, 'Q1_3', { connected: false, padNumber: '3' }),
        ]),
        part('R1', [pad(12.95, 11.43, 'SIG')]),
        part('R2', [pad(26.67, 9.525, 'SIG')]),
        part('J1', [1.27, 3.175, 5.08, 6.985, 9.525, 11.43].map((y, index) => pad(19.05, y, `J1_${index + 1}`, {
          connected: false, diameter: 1, drill: 0.5, padNumber: String(index + 1),
        }))),
      ],
    };

    const routed = routeBoard(input);

    expect(routed.failedNets).toEqual([]);
    const layout = asLayout(input, routed);
    expect(runDrc(layout).violations).toEqual([]);
    expect(checkConnectivity(layout).ok).toBe(true);
    // The escape out of the pinched pad is still necked, and the rest of the
    // net is still laid at full width — the fix withholds the terminal cell,
    // it does not punish the whole net.
    const touchesPinchedTerminal = (trace) => [trace.from, trace.to]
      .some((point) => Math.hypot(point.x - 12.7, point.y - 6.985) < 1e-6);
    const escapes = routed.traces.filter(touchesPinchedTerminal);
    expect(escapes.length).toBeGreaterThan(0);
    for (const trace of escapes) expect(trace.width).toBeLessThanOrEqual(0.4);
    expect(routed.traces.some((trace) => trace.width === RULES.traceWidth)).toBe(true);
  });

  it('leaves every trace at full width on a board that has the room', () => {
    const routed = routeBoard({
      board: { width: 44, height: 34 },
      components: [
        part('R1', [pad(6, 6, 'A'), pad(6, 28, 'B')]),
        part('R2', [pad(38, 28, 'A'), pad(38, 6, 'B')]),
        part('R3', [pad(22, 17, '0'), pad(30, 17, 'A')]),
      ],
    });

    expect(routed.failedNets).toEqual([]);
    expect(routed.traces.length).toBeGreaterThan(0);
    expect(routed.traces.every((trace) => trace.width === RULES.traceWidth)).toBe(true);
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
