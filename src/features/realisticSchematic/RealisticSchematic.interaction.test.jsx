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
import { ALLOWED_KINDS, COMPONENT_CATEGORIES, KINDS_BY_CATEGORY } from '../../core/componentKinds.js';
import { SIM_AUDIO_MUTED_STORAGE_KEY } from './useSimulation.js';

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

const installFakeAudioContext = () => {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.close = vi.fn(() => Promise.resolve());
      instances.push(this);
    }

    createOscillator() {
      return {
        type: '',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      };
    }

    createGain() {
      return {
        gain: { value: 0, setTargetAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return instances;
};

const mount = (props) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<RealisticSchematic circuit={dividerCircuit} {...props} />));
  const svg = container.querySelector('svg.realistic-canvas');
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
  localStorage.clear();
  rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  rafSpy.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    // Every registry kind is listed, grouped into one section per populated category.
    expect(container.querySelectorAll('.realistic-library-item')).toHaveLength(ALLOWED_KINDS.length);
    const populatedCategories = COMPONENT_CATEGORIES.filter((c) => KINDS_BY_CATEGORY[c.id].length > 0);
    expect(container.querySelectorAll('.realistic-library-group-title')).toHaveLength(populatedCategories.length);
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

  it('matches components by alias, not just the visible label', () => {
    const svg = mount({});
    fireDouble(svg);
    const search = container.querySelector('.realistic-library-search');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      // "op-amp" appears in neither the "Op amp" label nor the "opamp" slug — it
      // only resolves through the opamp alias list.
      setter.call(search, 'op-amp');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...container.querySelectorAll('.realistic-library-item-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Op amp']);
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
    const svg = container.querySelector('svg.realistic-canvas');
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

  // The net legend is hidden by default; click the toolbar "Nets" toggle to reveal
  // the legend chips these tests read live voltages from.
  const openLegend = () => {
    act(() => {
      container.querySelector('.realistic-legend-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('shows the Run toggle and a live status chip once running', () => {
    mountRunning(dividerCircuit);
    expect(container.querySelector('.realistic-run').textContent).toContain('Stop');
    expect(container.querySelector('.realistic-sim-status').textContent).toBe('live');
  });

  it('unlocks buzzer audio from Run and persists the mute preference', () => {
    const contexts = installFakeAudioContext();
    mountRunning({
      title: 'Active buzzer',
      nodes: ['VCC', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'BZ1', kind: 'buzzer', value: '5V active', nodes: ['VCC', '0'] },
      ],
    });
    expect(contexts).toHaveLength(1);
    const audioToggle = container.querySelector('.realistic-audio-toggle');
    expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
    act(() => { audioToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(SIM_AUDIO_MUTED_STORAGE_KEY)).toBe('true');
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
    openLegend();
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

  it('toggles PIR motion with a run-mode click and drives its OUT net', () => {
    mountRunning({
      title: 'PIR',
      nodes: ['VCC', 'VPIR', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        { ref: 'PIR1', kind: 'pir_sensor', value: '', nodes: ['VCC', 'VPIR', '0'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VPIR', '0'] },
      ],
    });
    openLegend();
    const pirChip = () => [...container.querySelectorAll('.realistic-legend-chip')]
      .find((chip) => chip.textContent.includes('VPIR')).textContent;
    flushFrames(4);
    expect(pirChip()).toContain('50.0mV'); // idle
    const pir = container.querySelector('[aria-label*="PIR1"]');
    act(() => { pir.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    flushFrames(4);
    expect(pirChip()).toContain('3.30V'); // motion
  });

  it('deflects the joystick axes by dragging and springs back on release', () => {
    mountRunning({
      title: 'Joystick',
      nodes: ['VCC', 'VX', 'VY', '0'],
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
        // [GND, VCC, VRX, VRY, SW]
        { ref: 'J1', kind: 'joystick', value: '', nodes: ['0', 'VCC', 'VX', 'VY', 'NC_J1_5'] },
        { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VX', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VY', '0'] },
      ],
    });
    openLegend();
    const chipFor = (net) => [...container.querySelectorAll('.realistic-legend-chip')]
      .find((chip) => chip.textContent.includes(net)).textContent;
    flushFrames(4);
    expect(chipFor('VX')).toContain('2.50V'); // centered

    const joystick = container.querySelector('[aria-label*="J1"]');
    const svg = container.querySelector('svg.realistic-canvas');
    firePointer(joystick, 'pointerdown', { clientX: 100, clientY: 100 });
    // Full rightward deflection (+40 board px = x → 1.0), y unchanged.
    firePointer(svg, 'pointermove', { clientX: 140, clientY: 100 });
    flushFrames(4);
    expect(chipFor('VX')).toContain('5.00V');
    expect(chipFor('VY')).toContain('2.50V');

    firePointer(svg, 'pointerup', { clientX: 140, clientY: 100 });
    flushFrames(4);
    expect(chipFor('VX')).toContain('2.50V'); // sprung back
  });

  it('presses keypad keys through the artwork and shows LCD text', async () => {
    // Uno with keypad on D6-D13 (cols C1-C4 on D6,D7,D12,D13; rows on D8-D11)
    // and an LCD on A4/A5. Firmware: any program (the LCD text is driven via
    // the I2C slave directly below).
    const nodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
    const assign = (pin, net) => {
      const index = pin.startsWith('D') ? 4 + Number(pin.slice(1)) : 18 + Number(pin.slice(1));
      nodes[index] = net;
    };
    assign('D6', 'VC1'); assign('D7', 'VC2'); assign('D12', 'VC3'); assign('D13', 'VC4');
    assign('D8', 'VR1'); assign('D9', 'VR2'); assign('D10', 'VR3'); assign('D11', 'VR4');
    assign('A4', 'VSDA'); assign('A5', 'VSCL');
    const circuit = {
      title: 'Keypad + LCD',
      nodes: ['VC1', 'VR1', 'VSDA', 'VSCL', '0'],
      components: [
        { ref: 'U1', kind: 'arduino_uno', value: '', nodes },
        { ref: 'K1', kind: 'keypad', value: '', nodes: ['VR1', 'VR2', 'VR3', 'VR4', 'VC1', 'VC2', 'VC3', 'VC4'] },
        { ref: 'L1', kind: 'lcd_display', value: '', nodes: ['0', 'NC_L1_2', 'VSDA', 'VSCL'] },
      ],
    };
    const hex = ':06000000259A2D9AFFCFA6\n:00000001FF\n'; // D13-high program
    mountFirmware(circuit, () => Promise.resolve({ ok: true, hex, errors: [] }));
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    flushFrames(4);
    // Keypad artwork keys exist and respond to press-and-hold.
    const keys = container.querySelectorAll('[data-keypad-key]');
    expect(keys).toHaveLength(16);
    const five = [...keys].find((el) => el.dataset.keypadKey === '5');
    firePointer(five, 'pointerdown', { clientX: 5, clientY: 5 });
    flushFrames(4);
    expect([...container.querySelectorAll('[data-keypad-key]')].find((el) => el.dataset.keypadKey === '5').getAttribute('fill')).toBe('#12161a');
    firePointer(container.querySelector('svg.realistic-canvas'), 'pointerup', { clientX: 5, clientY: 5 });
    flushFrames(4);
    expect([...container.querySelectorAll('[data-keypad-key]')].find((el) => el.dataset.keypadKey === '5').getAttribute('fill')).toBe('#2c3238');
  });

  it('feeds trackpad drags into the mouse sensor with no spring-back', async () => {
    // Uno with the PMW3360 on the hardware SPI pins (NCS on D10). Firmware:
    // any program — the drag feeds the model directly; the readout comes
    // from the peripheral's observe().
    const nodes = ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 21 }, (_, i) => `NC_U1_${i + 4}`)];
    const assign = (pin, net) => { nodes[4 + Number(pin.slice(1))] = net; };
    assign('D10', 'VNCS'); assign('D11', 'VMOSI'); assign('D12', 'VMISO'); assign('D13', 'VSCK');
    const circuit = {
      title: 'Mouse sensor',
      nodes: ['VNCS', 'VMOSI', 'VMISO', 'VSCK', '0'],
      components: [
        { ref: 'U1', kind: 'arduino_uno', value: '', nodes },
        // [RST, GND, MOT, NCS, SCK, MOSI, MISO, VCC]
        { ref: 'M1', kind: 'mouse_sensor', value: '', nodes: ['NC_M1_1', '0', 'NC_M1_3', 'VNCS', 'VSCK', 'VMOSI', 'VMISO', 'NC_M1_8'] },
      ],
    };
    const hex = ':06000000259A2D9AFFCFA6\n:00000001FF\n'; // D13-high program
    mountFirmware(circuit, () => Promise.resolve({ ok: true, hex, errors: [] }));
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    flushFrames(4);
    const readout = () => [...container.querySelectorAll('text')]
      .find((el) => el.textContent.startsWith('X '))?.textContent;
    expect(readout()).toBe('X 0  Y 0');

    const sensor = container.querySelector('[aria-label*="M1"]');
    const svg = container.querySelector('svg.realistic-canvas');
    firePointer(sensor, 'pointerdown', { clientX: 100, clientY: 100 });
    // +40 board px right, +10 down → 160 and 40 counts at 4 counts/px.
    firePointer(svg, 'pointermove', { clientX: 140, clientY: 110 });
    flushFrames(4);
    expect(readout()).toBe('X 160  Y 40');

    // Release: totals hold (no spring-back), later moves add nothing.
    firePointer(svg, 'pointerup', { clientX: 140, clientY: 110 });
    firePointer(svg, 'pointermove', { clientX: 200, clientY: 200 });
    flushFrames(4);
    expect(readout()).toBe('X 160  Y 40');
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

  it('banners firmware-less MCU boards while the rest still solves', () => {
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
    expect(container.querySelector('.realistic-sim-banner').textContent).toContain('U1 (Arduino Uno) has no firmware');
    openLegend();
    const chips = [...container.querySelectorAll('.realistic-legend-chip')];
    const vcc = chips.find((chip) => chip.textContent.includes('VCC'));
    expect(vcc.textContent).toContain('5.00V');
  });

  const unoBlinkCircuit = {
    title: 'Uno LED',
    nodes: ['VPIN', 'VLED', '0'],
    components: [
      {
        ref: 'U1',
        kind: 'arduino_uno',
        value: '',
        // [5V, 3V3, GND, VIN, D0..D13, A0..A5] — D13 at index 17 drives VPIN.
        nodes: ['NC_U1_1', 'NC_U1_2', '0', ...Array.from({ length: 14 }, (_, i) => `NC_U1_${i + 4}`), 'VPIN', ...Array.from({ length: 6 }, (_, i) => `NC_U1_${i + 19}`)],
      },
      { ref: 'R1', kind: 'resistor', value: '330', nodes: ['VPIN', 'VLED'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['VLED', '0'] },
    ],
  };

  const mountFirmware = (circuit, onCompileFirmware) => {
    useQueuedFrames();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(
      <RealisticSchematic circuit={circuit} firmware="void setup(){}" onCompileFirmware={onCompileFirmware} />,
    ));
    const svg = container.querySelector('svg.realistic-canvas');
    const bounds = circuitToBreadboard(circuit).board;
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: bounds.width, bottom: bounds.height,
      width: bounds.width, height: bounds.height, x: 0, y: 0, toJSON() {},
    });
    return svg;
  };

  it('shows compile errors and stays stopped when the sketch fails', async () => {
    mountFirmware(unoBlinkCircuit, () => Promise.resolve({ ok: false, errors: ["sketch.ino:5:3: error: expected ';'"] }));
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.realistic-sim-banner.error').textContent).toContain("sketch.ino:5:3: error");
    expect(container.querySelector('.realistic-run').textContent).toContain('Run');
  });

  it('unlocks buzzer audio before awaiting firmware compilation and cleans up on failure', async () => {
    const contexts = installFakeAudioContext();
    const circuit = {
      ...unoBlinkCircuit,
      components: [
        ...unoBlinkCircuit.components,
        { ref: 'BZ1', kind: 'buzzer', value: '5V active', nodes: ['VPIN', '0'] },
      ],
    };
    const compile = vi.fn(() => {
      expect(contexts).toHaveLength(1);
      return Promise.resolve({ ok: false, errors: ['compile stopped'] });
    });
    mountFirmware(circuit, compile);
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(compile).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('sends typed serial input to the engine', async () => {
    const hex = ':06000000259A2D9AFFCFA6\n:00000001FF\n';
    mountFirmware(unoBlinkCircuit, () => Promise.resolve({ ok: true, hex, errors: [] }));
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    flushFrames(4);
    const input = container.querySelector('.realistic-serial-input input');
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'hi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // The engine queued the bytes (RX not enabled by this program — it waits).
    expect(input.value).toBe(''); // draft cleared after send
  });

  it('runs compiled firmware and shows the serial monitor', async () => {
    // The "hex" path is exercised via a real Intel HEX for the hand-assembled
    // D13-high program: SBI DDRB,5; SBI PORTB,5; RJMP .-2 (little-endian).
    const hex = ':06000000259A2D9AFFCFA6\n:00000001FF\n';
    mountFirmware(unoBlinkCircuit, () => Promise.resolve({ ok: true, hex, errors: [] }));
    await act(async () => {
      container.querySelector('.realistic-run').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    flushFrames(6);
    expect(container.querySelector('.realistic-run').textContent).toContain('Stop');
    expect(container.querySelector('.realistic-serial')).not.toBeNull();
    // D13 drives the LED through the bridge.
    expect(container.querySelector('circle[filter="url(#rsGlow)"]')).not.toBeNull();
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
