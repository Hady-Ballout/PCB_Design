import { describe, expect, it } from 'vitest';
import { RULES } from '../../core/pcbDesignRules.js';
import { buildManualPcbLayout } from '../../core/pcbLayout.js';
import {
  addWaypoint,
  autoRoutedManual,
  beginStroke,
  commitStroke,
  currentLayer,
  deleteStroke,
  dropLastWaypoint,
  finishStroke,
  netPads,
  progressSummary,
  ratsnestFor,
  routeCorner,
  snapPoint,
  toggleStrokeLayer,
} from './pcbEditorModel.js';

const circuit = {
  title: 'RC low-pass',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

const layout = buildManualPcbLayout(circuit);

describe('snapPoint / routeCorner', () => {
  it('snaps to the routing grid', () => {
    expect(snapPoint({ x: 1.0, y: 1.4 })).toEqual({ x: 1.27, y: 1.27 });
    expect(snapPoint({ x: 0.4, y: 0.32 })).toEqual({ x: 0.635, y: 0.635 });
  });

  it('constrains a mostly-horizontal cursor to a horizontal segment', () => {
    const corner = routeCorner({ x: 0, y: 0 }, { x: 5.2, y: 0.4 });
    expect(corner.y).toBe(0);
    expect(corner.x).toBeCloseTo(5.08, 9);
  });

  it('constrains a mostly-vertical cursor to a vertical segment', () => {
    const corner = routeCorner({ x: 0, y: 0 }, { x: 0.4, y: -5.2 });
    expect(corner.x).toBe(0);
    expect(corner.y).toBeCloseTo(-5.08, 9);
  });

  it('produces exact 45° segments in the diagonal band', () => {
    const corner = routeCorner({ x: 0, y: 0 }, { x: 4.9, y: -4.4 });
    expect(Math.abs(corner.x)).toBeCloseTo(Math.abs(corner.y), 9);
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeLessThan(0);
  });
});

describe('stroke drawing', () => {
  it('builds segment traces from waypoints, all at the design trace width', () => {
    let stroke = beginStroke('s1', 'VIN', { x: 0, y: 0 });
    stroke = addWaypoint(stroke, { x: 2.54, y: 0 });
    stroke = addWaypoint(stroke, { x: 2.54, y: 2.54 });
    const { traces, vias } = finishStroke(stroke, { x: 5.08, y: 2.54 });

    expect(vias).toEqual([]);
    expect(traces).toEqual([
      { stroke: 's1', layer: 'top', net: 'VIN', from: { x: 0, y: 0 }, to: { x: 2.54, y: 0 }, width: RULES.traceWidth },
      { stroke: 's1', layer: 'top', net: 'VIN', from: { x: 2.54, y: 0 }, to: { x: 2.54, y: 2.54 }, width: RULES.traceWidth },
      { stroke: 's1', layer: 'top', net: 'VIN', from: { x: 2.54, y: 2.54 }, to: { x: 5.08, y: 2.54 }, width: RULES.traceWidth },
    ]);
  });

  it('drops a via and switches layer on toggle, resuming on the other side', () => {
    let stroke = beginStroke('s2', '0', { x: 0, y: 0 });
    stroke = addWaypoint(stroke, { x: 2.54, y: 0 });
    expect(currentLayer(stroke)).toBe('top');
    stroke = toggleStrokeLayer(stroke);
    expect(currentLayer(stroke)).toBe('bottom');
    stroke = addWaypoint(stroke, { x: 2.54, y: 2.54 });
    const { traces, vias } = finishStroke(stroke, { x: 2.54, y: 2.54 });

    expect(vias).toEqual([
      { stroke: 's2', x: 2.54, y: 0, net: '0', diameter: RULES.viaDiameter, drill: RULES.viaDrill },
    ]);
    expect(traces.map((trace) => trace.layer)).toEqual(['top', 'bottom']);
  });

  it('ignores zero-length waypoints and supports Backspace', () => {
    let stroke = beginStroke('s3', 'VIN', { x: 0, y: 0 });
    stroke = addWaypoint(stroke, { x: 0, y: 0 });
    expect(stroke.points).toHaveLength(1);
    stroke = addWaypoint(stroke, { x: 1.27, y: 0 });
    stroke = dropLastWaypoint(stroke);
    expect(stroke.points).toHaveLength(1);
    // The start point survives any number of Backspaces.
    stroke = dropLastWaypoint(stroke);
    expect(stroke.points).toHaveLength(1);
  });
});

describe('manualRouting value', () => {
  it('commits and deletes strokes as units', () => {
    let stroke = beginStroke('s1', 'VIN', { x: 0, y: 0 });
    stroke = toggleStrokeLayer(stroke);
    stroke = addWaypoint(stroke, { x: 2.54, y: 0 });
    const finished = finishStroke(stroke, { x: 2.54, y: 0 });

    const committed = commitStroke(null, 'sig', finished);
    expect(committed.placement).toBe('sig');
    expect(committed.traces).toHaveLength(1);
    expect(committed.vias).toHaveLength(1);

    const emptied = deleteStroke(committed, 's1');
    expect(emptied.traces).toEqual([]);
    expect(emptied.vias).toEqual([]);
    expect(emptied.placement).toBe('sig');
  });

  it('auto-routes onto the manual placement with per-net stroke tags', () => {
    const auto = autoRoutedManual(layout);
    expect(auto.placement).toBe(layout.placement);
    expect(auto.failedNets).toEqual([]);
    expect(auto.traces.length).toBeGreaterThan(0);
    for (const trace of auto.traces) expect(trace.stroke).toBe(`auto:${trace.net}`);

    // The stored value round-trips through the layout builder to a clean board.
    const routedLayout = buildManualPcbLayout(circuit, auto);
    expect(routedLayout.connectivity.ok).toBe(true);
    expect(routedLayout.drc.ok).toBe(true);
  });
});

describe('ratsnest and progress', () => {
  it('shows ghost lines for every incomplete multi-pad net on a bare board', () => {
    const lines = ratsnestFor(layout);
    const netsWithLines = new Set(lines.map((line) => line.net));
    for (const net of layout.nets) {
      if (netPads(layout, net).length >= 2) expect(netsWithLines.has(net)).toBe(true);
    }
    // A net with n pads needs n-1 spanning edges.
    const zeroPads = netPads(layout, '0');
    expect(lines.filter((line) => line.net === '0')).toHaveLength(zeroPads.length - 1);
  });

  it('clears the ratsnest once the board is fully routed', () => {
    const routedLayout = buildManualPcbLayout(circuit, autoRoutedManual(layout));
    expect(ratsnestFor(routedLayout)).toEqual([]);
  });

  it('summarises progress and violations', () => {
    expect(progressSummary(layout)).toBe('0 of 3 nets connected');
    const routedLayout = buildManualPcbLayout(circuit, autoRoutedManual(layout));
    expect(progressSummary(routedLayout)).toBe('3 of 3 nets connected');
    expect(progressSummary(null)).toBe('');
  });
});
