// @vitest-environment jsdom
// Behavioral tests for the interactive breadboard: they mount the real
// component into jsdom and drive native pointer/wheel events, asserting the
// pan/zoom transform and the rewiring/placement callbacks. Pointer coordinates
// map 1:1 to board space here (getScreenCTM is absent in jsdom, so
// clientToViewBox falls back to getBoundingClientRect, which we stub to the
// board box), and requestAnimationFrame is made synchronous so the rAF-coalesced
// view commits within the dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RealisticSchematic } from './RealisticSchematic.jsx';
import { circuitToBreadboard } from './breadboardModel.js';
import { holeCenter } from './breadboardGeometry.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dividerCircuit = {
  title: 'Voltage divider',
  nodes: ['VCC', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

const model = circuitToBreadboard(dividerCircuit);

let container;
let root;
let rafSpy;

const mount = (props) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<RealisticSchematic circuit={dividerCircuit} {...props} />));
  const svg = container.querySelector('svg');
  svg.getBoundingClientRect = () => ({
    left: 0, top: 0, right: model.board.width, bottom: model.board.height,
    width: model.board.width, height: model.board.height, x: 0, y: 0, toJSON() {},
  });
  return svg;
};

const firePointer = (target, type, { clientX = 0, clientY = 0, pointerId = 1, button = 0 } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  act(() => { target.dispatchEvent(event); });
};

const worldTransform = () => container.querySelector('.rs-world').getAttribute('transform');

beforeEach(() => {
  rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  rafSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('breadboard navigation', () => {
  it('pans the world group when dragging empty board', () => {
    const svg = mount({});
    expect(worldTransform()).toBe('translate(0 0) scale(1)');
    firePointer(svg, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(svg, 'pointermove', { clientX: 150, clientY: 130 });
    firePointer(svg, 'pointerup', { clientX: 150, clientY: 130 });
    const [, tx, ty] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(1\)/.exec(worldTransform());
    expect(Number(tx)).toBeCloseTo(50, 6);
    expect(Number(ty)).toBeCloseTo(30, 6);
  });

  it('zooms toward the cursor on ctrl+wheel, keeping that point fixed', () => {
    const svg = mount({});
    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(wheel, { deltaY: -100, deltaX: 0, clientX: 40, clientY: 40, ctrlKey: true });
    act(() => { svg.dispatchEvent(wheel); });
    const transform = worldTransform();
    const scale = Number(/scale\(([\d.]+)\)/.exec(transform)[1]);
    expect(scale).toBeGreaterThan(1); // zoomed in
    // The board point under (40,40) must still map to (40,40): tx + s*40 === 40.
    const [, tx] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
    expect(Number(tx) + scale * 40).toBeCloseTo(40, 3);
  });
});

describe('breadboard editing', () => {
  const selectPart = (svg, ref) => {
    const label = `${ref} resistor 1k`;
    const partGroup = container.querySelector(`[aria-label="${label}"]`);
    firePointer(partGroup, 'pointerdown', { clientX: 5, clientY: 5 });
    firePointer(partGroup, 'pointerup', { clientX: 5, clientY: 5 });
    // A press that never moves is a click → selection; dispatch the click too.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { partGroup.dispatchEvent(click); });
    return partGroup;
  };

  it('reveals draggable pin handles for the selected part', () => {
    const svg = mount({ onCircuitChange: vi.fn(), onLayoutChange: vi.fn() });
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(0);
    selectPart(svg, 'R1');
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(2);
  });

  it('rewires a pin dragged to another net and calls onCircuitChange', () => {
    const onCircuitChange = vi.fn();
    const svg = mount({ onCircuitChange, onLayoutChange: vi.fn() });
    selectPart(svg, 'R1');
    const handles = container.querySelectorAll('.rs-pin-handle');
    // R1 pin 2 carries VOUT; drag it onto the ground (-) rail.
    const from = holeCenter(model.parts.find((p) => p.ref === 'R1').holes[1]);
    const groundRail = holeCenter({ strip: 'railTopMinus', column: 5, row: 0 });
    firePointer(handles[1], 'pointerdown', { clientX: from.x, clientY: from.y });
    firePointer(svg, 'pointermove', { clientX: groundRail.x, clientY: groundRail.y });
    firePointer(svg, 'pointerup', { clientX: groundRail.x, clientY: groundRail.y });

    expect(onCircuitChange).toHaveBeenCalledTimes(1);
    const next = onCircuitChange.mock.calls[0][0](dividerCircuit);
    expect(next.components.find((c) => c.ref === 'R1').nodes).toEqual(['VCC', '0']);
  });

  it('moves a part to a new column and calls onLayoutChange with its anchor', () => {
    const onLayoutChange = vi.fn();
    const svg = mount({ onCircuitChange: vi.fn(), onLayoutChange });
    const r2 = model.parts.find((p) => p.ref === 'R2');
    const start = holeCenter(r2.holes[0]);
    const partGroup = container.querySelector('[aria-label="R2 resistor 1k"]');
    // Drag the body three columns to the right (3 * HOLE_PITCH = 42px).
    firePointer(partGroup, 'pointerdown', { clientX: start.x, clientY: start.y });
    firePointer(svg, 'pointermove', { clientX: start.x + 42, clientY: start.y });
    firePointer(svg, 'pointerup', { clientX: start.x + 42, clientY: start.y });

    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    const layout = onLayoutChange.mock.calls[0][0](null);
    expect(layout.parts.R2.column).toBe(r2.holes[0].column + 3);
    expect(layout.version).toBe(1);
  });
});
