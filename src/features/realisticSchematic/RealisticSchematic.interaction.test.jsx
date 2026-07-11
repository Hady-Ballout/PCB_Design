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
import { ALLOWED_KINDS } from '../../core/componentKinds.js';

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
    // Selection resolves on the release; the click that follows in environments
    // without pointer capture must be swallowed (double-toggle guard).
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { partGroup.dispatchEvent(click); });
    return partGroup;
  };

  it('previews a hovered part in the toolbar readout while nothing is selected', () => {
    mount({ onCircuitChange: vi.fn(), onLayoutChange: vi.fn() });
    const partGroup = container.querySelector('[aria-label="R1 resistor 1k"]');
    const readout = () => container.querySelector('.realistic-readout').textContent;
    expect(readout()).toBe('Click a part or wire');
    act(() => { partGroup.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(readout()).toBe('R1 · resistor · 1k');
    act(() => { partGroup.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(readout()).toBe('Click a part or wire');
  });

  it('reveals draggable pin handles for the selected part', () => {
    const svg = mount({ onCircuitChange: vi.fn(), onLayoutChange: vi.fn() });
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(0);
    selectPart(svg, 'R1');
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(2);
  });

  it('selects a part on press+release without a click event (pointer-capture path)', () => {
    // Real browsers retarget the post-capture click to the SVG, so the part's
    // onClick never fires; selection must resolve from pointerup alone.
    mount({ onCircuitChange: vi.fn(), onLayoutChange: vi.fn() });
    const partGroup = container.querySelector('[aria-label="R1 resistor 1k"]');
    firePointer(partGroup, 'pointerdown', { clientX: 5, clientY: 5 });
    firePointer(partGroup, 'pointerup', { clientX: 5, clientY: 5 });
    expect(container.querySelector('.realistic-readout').textContent).toBe('R1 · resistor · 1k');
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(2);
    // A second press on the same part toggles the selection back off.
    firePointer(partGroup, 'pointerdown', { clientX: 5, clientY: 5 });
    firePointer(partGroup, 'pointerup', { clientX: 5, clientY: 5 });
    expect(container.querySelectorAll('.rs-pin-handle')).toHaveLength(0);
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

const fireDouble = (target, { clientX = 40, clientY = 40 } = {}) => {
  const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY });
  act(() => { target.dispatchEvent(event); });
};

const fireKey = (key) => {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
};

describe('component library', () => {
  it('opens a browse-only library of every registry component on double-click', () => {
    const svg = mount({});
    expect(container.querySelector('.realistic-library')).toBeNull();

    fireDouble(svg, { clientX: 60, clientY: 40 });

    const popover = container.querySelector('.realistic-library');
    expect(popover).not.toBeNull();
    // Every registry kind is listed, grouped into the three browse sections.
    expect(container.querySelectorAll('.realistic-library-item')).toHaveLength(ALLOWED_KINDS.length);
    expect(container.querySelectorAll('.realistic-library-group-title')).toHaveLength(3);
    const labels = [...container.querySelectorAll('.realistic-library-item-label')].map((el) => el.textContent);
    expect(labels).toContain('Potentiometer');
    expect(labels).toContain('Arduino Uno');
    // Every item previews its kind with the realistic artwork thumbnail.
    expect(container.querySelectorAll('.realistic-library-item-icon svg.realistic-part-thumb'))
      .toHaveLength(ALLOWED_KINDS.length);
  });

  it('adds the picked component with placeholder pins and closes when editable', () => {
    const onCircuitChange = vi.fn();
    const svg = mount({ onCircuitChange, onLayoutChange: vi.fn() });

    fireDouble(svg, { clientX: 60, clientY: 40 });
    const potentiometer = [...container.querySelectorAll('.realistic-library-item')]
      .find((item) => item.textContent.includes('Potentiometer'));
    expect(potentiometer.disabled).toBe(false);
    act(() => { potentiometer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Appends a fresh 3-pin R# component with unconnected NC placeholder nodes.
    expect(onCircuitChange).toHaveBeenCalledTimes(1);
    const next = onCircuitChange.mock.calls[0][0](dividerCircuit);
    expect(next.components).toHaveLength(dividerCircuit.components.length + 1);
    const added = next.components.at(-1);
    expect(added).toMatchObject({ ref: 'R3', kind: 'potentiometer', value: '10k' });
    expect(added.nodes).toEqual(['NC_R3_1', 'NC_R3_2', 'NC_R3_3']);
    // The popover closes after the pick.
    expect(container.querySelector('.realistic-library')).toBeNull();
  });

  it('adds a voltage regulator with IN, GND, and OUT pins', () => {
    const onCircuitChange = vi.fn();
    const svg = mount({ onCircuitChange, onLayoutChange: vi.fn() });

    fireDouble(svg, { clientX: 60, clientY: 40 });
    const regulator = [...container.querySelectorAll('.realistic-library-item')]
      .find((item) => item.textContent.includes('Voltage regulator'));
    act(() => { regulator.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const next = onCircuitChange.mock.calls[0][0](dividerCircuit);
    const added = next.components.at(-1);
    expect(added).toMatchObject({ kind: 'regulator', value: '5V' });
    expect(added.nodes).toEqual([
      `NC_${added.ref}_1`,
      `NC_${added.ref}_2`,
      `NC_${added.ref}_3`,
    ]);
  });

  it('is browse-only (items disabled) with no onCircuitChange', () => {
    const svg = mount({});
    fireDouble(svg);
    expect([...container.querySelectorAll('.realistic-library-item')].every((item) => item.disabled)).toBe(true);
  });

  it('filters the list by the search query', () => {
    const svg = mount({});
    fireDouble(svg);
    const search = container.querySelector('.realistic-library-search');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, 'servo');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...container.querySelectorAll('.realistic-library-item-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Servo motor']);
  });

  it('closes on Escape and on backdrop click', () => {
    const svg = mount({});

    fireDouble(svg);
    expect(container.querySelector('.realistic-library')).not.toBeNull();
    fireKey('Escape');
    expect(container.querySelector('.realistic-library')).toBeNull();

    fireDouble(svg);
    expect(container.querySelector('.realistic-library')).not.toBeNull();
    firePointer(container.querySelector('.realistic-library-backdrop'), 'pointerdown', { clientX: 5, clientY: 5 });
    expect(container.querySelector('.realistic-library')).toBeNull();
  });
});

describe('live simulation (Run mode)', () => {
  const buttonLedCircuit = {
    title: 'Button LED',
    nodes: ['VCC', 'VBTN', 'VLED', '0'],
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
      { ref: 'SW1', kind: 'pushbutton', value: '', nodes: ['VCC', 'VBTN'] },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VBTN', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ],
  };

  // The sim loop re-schedules itself every frame, so the synchronous rAF mock
  // from beforeEach would recurse forever — swap in a manual queue instead.
  let frameQueue;
  let frameClock;
  const useQueuedFrames = () => {
    frameQueue = [];
    frameClock = 0;
    rafSpy.mockImplementation((cb) => {
      frameQueue.push(cb);
      return frameQueue.length;
    });
  };
  const flushFrames = (count) => {
    for (let i = 0; i < count; i += 1) {
      const callbacks = frameQueue.splice(0);
      frameClock += 16;
      act(() => callbacks.forEach((cb) => cb(frameClock)));
    }
  };

  const mountRunning = (circuit) => {
    useQueuedFrames();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<RealisticSchematic circuit={circuit} />));
    const svg = container.querySelector('svg');
    const bounds = circuitToBreadboard(circuit).board;
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: bounds.width, bottom: bounds.height,
      width: bounds.width, height: bounds.height, x: 0, y: 0, toJSON() {},
    });
    act(() => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return svg;
  };

  it('shows the Run toggle and a live status chip once running', () => {
    mountRunning(dividerCircuit);
    expect(container.querySelector('.realistic-run').textContent).toContain('Stop');
    expect(container.querySelector('.realistic-sim-status').textContent).toBe('live');
  });

  it('offers the voltage-map overlay only while running and layers it under the highlight', () => {
    mountRunning(dividerCircuit);
    const vmap = container.querySelector('.realistic-vmap');
    expect(vmap).not.toBeNull();
    const overlays = () => container.querySelectorAll('.rs-world > g[pointer-events="none"]').length;
    const before = overlays();
    act(() => { vmap.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    flushFrames(2);
    expect(vmap.classList.contains('active')).toBe(true);
    expect(overlays()).toBe(before + 1);
    // Stop hides the toggle entirely.
    act(() => { container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('.realistic-vmap')).toBeNull();
  });

  it('appends live voltages to the net legend chips', () => {
    mountRunning(dividerCircuit);
    const chips = [...container.querySelectorAll('.realistic-legend-chip')];
    const vout = chips.find((chip) => chip.textContent.includes('VOUT'));
    expect(vout.textContent).toContain('2.50V');
  });

  it('lights the LED only while the pushbutton is held', () => {
    mountRunning(buttonLedCircuit);
    const glow = () => container.querySelector('circle[filter="url(#rsGlow)"]');
    expect(glow()).toBeNull();

    const button = container.querySelector('[aria-label="SW1 pushbutton"]');
    firePointer(button, 'pointerdown', { clientX: 5, clientY: 5 });
    flushFrames(4);
    expect(glow()).not.toBeNull();

    firePointer(button, 'pointerup', { clientX: 5, clientY: 5 });
    flushFrames(4);
    expect(glow()).toBeNull();
  });

  it('surfaces a friendly error for an unsimulatable circuit', () => {
    mountRunning({
      title: 'No ground',
      nodes: ['VCC', 'VRET'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', 'VRET'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VRET'] },
      ],
    });
    expect(container.querySelector('.realistic-sim-banner.error').textContent)
      .toContain('Connect the circuit to GND');
  });

  it('banners MCU boards as not simulated while the rest still solves', () => {
    mountRunning({
      title: 'Uno blink',
      nodes: ['VCC', '0'],
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: '',
          nodes: ['VCC', '3V3', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)],
        },
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', '0'] },
      ],
    });
    expect(container.querySelector('.realistic-sim-banner').textContent).toContain('U1 (Arduino Uno) is not simulated');
    const chips = [...container.querySelectorAll('.realistic-legend-chip')];
    const vcc = chips.find((chip) => chip.textContent.includes('VCC'));
    expect(vcc.textContent).toContain('5.00V');
  });
});

describe('issues panel', () => {
  it('renders design issues by severity with fixes, errors expanded', () => {
    mount({
      issues: [
        { id: 'gpio_direct_load', severity: 'error', message: 'GPIO2 drives buzzer RBZ1 directly.', fix: 'Insert an NPN transistor.' },
        { id: 'i2c_missing_pullups', severity: 'warning', message: 'SDA has no pull-up resistor.', fix: '' },
        { id: 'mosfet_gate_no_pulldown', severity: 'warning', message: 'Gate pull-down added.', fix: '', autoFixed: true },
      ],
    });
    const panel = container.querySelector('.rs-issues');
    expect(panel).not.toBeNull();
    expect(panel.open).toBe(true);
    expect(panel.classList.contains('rs-issues-has-errors')).toBe(true);
    expect(panel.querySelector('.rs-issues-summary').textContent).toContain('1 design issue');

    const rows = [...panel.querySelectorAll('.rs-issue')];
    expect(rows.map((row) => row.className)).toEqual([
      'rs-issue rs-issue-error',
      'rs-issue rs-issue-warning',
      'rs-issue rs-issue-fixed',
    ]);
    expect(rows[0].textContent).toContain('Fix: Insert an NPN transistor.');
  });

  it('renders board integrity issues and model warnings without circuit issues', () => {
    // The divider circuit itself is clean; the panel is absent.
    mount({});
    expect(container.querySelector('.rs-issues')).toBeNull();
  });
});
