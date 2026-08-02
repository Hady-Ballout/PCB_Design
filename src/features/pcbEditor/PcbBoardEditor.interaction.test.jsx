// @vitest-environment jsdom
// Behavioral tests for the manual routing editor: mount the real component,
// drive native events, assert the highlight/lock/draw/commit flow. Pointer
// coordinates map to board space through the clientToBoard fallback
// (getScreenCTM is absent in jsdom): with the rect stubbed to the viewBox
// size, boardX = clientX + viewBox.x.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PcbBoardEditor } from './PcbBoardEditor.jsx';
import { buildManualPcbLayout } from '../../core/pcbLayout.js';
import { autoRoutedManual, netPads } from './pcbEditorModel.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const circuit = {
  title: 'RC low-pass',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

const layout = buildManualPcbLayout(circuit);
const MARGIN = 3;

let container;
let root;

const mount = (props = {}) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PcbBoardEditor layout={layout} onRoutingChange={vi.fn()} {...props} />));
  const svg = container.querySelector('svg.pcb-editor-canvas');
  const width = layout.board.width + 2 * MARGIN;
  const height = layout.board.height + 2 * MARGIN;
  svg.getBoundingClientRect = () => ({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {},
  });
  return svg;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

const click = (target, { clientX = 0, clientY = 0 } = {}) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX, clientY,
    }));
  });
};

const key = (keyName) => {
  act(() => {
    container.querySelector('.pcb-editor').dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: keyName,
    }));
  });
};

const padElement = (net, index = 0) =>
  container.querySelectorAll(`[data-net="${net}"].pcb-pad`)[index];

const hint = () => container.querySelector('.pcb-editor-hint').textContent;

describe('net highlighting', () => {
  it('highlights every pad of the hovered net and dims the rest', () => {
    mount();
    const pads = netPads(layout, 'VIN');
    act(() => {
      padElement('VIN').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(container.querySelectorAll('.pcb-pad-net')).toHaveLength(pads.length);
    expect(container.querySelectorAll('.pcb-pad.pcb-dimmed').length).toBeGreaterThan(0);
    act(() => {
      padElement('VIN').dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    expect(container.querySelectorAll('.pcb-pad-net')).toHaveLength(0);
  });

  it('shows ratsnest ghost lines for the unrouted board', () => {
    mount();
    expect(container.querySelectorAll('.pcb-ratsnest').length).toBeGreaterThan(0);
  });

  it('draws the real footprint silkscreen so parts read as parts', () => {
    mount();
    // Every component in this circuit has vendored silk artwork (axial
    // resistor outline, capacitor body, header frame).
    expect(container.querySelectorAll('.pcb-silk-group')).toHaveLength(3);
    expect(container.querySelectorAll('.pcb-silk').length).toBeGreaterThan(3);
  });
});

describe('drawing a trace', () => {
  it('locks the net on click, draws waypoints, and commits on a highlighted pad', () => {
    const onRoutingChange = vi.fn();
    const svg = mount({ onRoutingChange });
    const [padA, padB] = netPads(layout, 'VIN');

    click(padElement('VIN', 0));
    expect(hint()).toContain('finish on a highlighted pad');
    // The lock survives with no hover: every VIN pad stays highlighted.
    expect(container.querySelectorAll('.pcb-pad-net').length).toBeGreaterThan(1);

    // One waypoint out in free space (clientX = boardX + MARGIN).
    click(svg, { clientX: padA.x + MARGIN + 4, clientY: padA.y + MARGIN });
    expect(container.querySelectorAll('[data-testid="pcb-draft-segment"]').length).toBeGreaterThan(0);

    click(padElement('VIN', 1));
    expect(onRoutingChange).toHaveBeenCalledTimes(1);
    const value = onRoutingChange.mock.calls[0][0];
    expect(value.placement).toBe(layout.placement);
    expect(value.traces.length).toBeGreaterThanOrEqual(2);
    for (const trace of value.traces) {
      expect(trace.net).toBe('VIN');
      expect(trace.stroke).toBe('m1');
      expect(trace.layer).toBe('top');
    }
    expect(value.traces[0].from).toEqual({ x: padA.x, y: padA.y });
    expect(value.traces.at(-1).to).toEqual({ x: padB.x, y: padB.y });
  });

  it('refuses to finish on a pad of a different net', () => {
    const onRoutingChange = vi.fn();
    mount({ onRoutingChange });
    click(padElement('VIN', 0));
    click(padElement('VOUT', 0));
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(hint()).toContain('finish on a highlighted pad');
  });

  it('drops a via with V and finishes the far side on the bottom layer', () => {
    const onRoutingChange = vi.fn();
    const svg = mount({ onRoutingChange });
    const [padA] = netPads(layout, 'VIN');

    click(padElement('VIN', 0));
    click(svg, { clientX: padA.x + MARGIN + 4, clientY: padA.y + MARGIN });
    key('v');
    click(padElement('VIN', 1));

    const value = onRoutingChange.mock.calls[0][0];
    expect(value.vias).toHaveLength(1);
    expect(value.vias[0].net).toBe('VIN');
    expect(value.traces[0].layer).toBe('top');
    expect(value.traces.at(-1).layer).toBe('bottom');
  });

  it('cancels with Escape and undoes the last corner with Backspace', () => {
    const onRoutingChange = vi.fn();
    const svg = mount({ onRoutingChange });
    const [padA] = netPads(layout, 'VIN');

    click(padElement('VIN', 0));
    click(svg, { clientX: padA.x + MARGIN + 6, clientY: padA.y + MARGIN });
    click(svg, { clientX: padA.x + MARGIN + 6, clientY: padA.y + MARGIN + 6 });
    key('Backspace');
    key('Escape');
    expect(hint()).toContain('Hover a pad');
    expect(container.querySelectorAll('[data-testid="pcb-draft-segment"]')).toHaveLength(0);
    expect(onRoutingChange).not.toHaveBeenCalled();
  });
});

describe('editing existing copper', () => {
  const routedLayout = buildManualPcbLayout(circuit, autoRoutedManual(layout));

  it('selects a trace on click and deletes its whole stroke with Delete', () => {
    const onRoutingChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(
      <PcbBoardEditor layout={routedLayout} onRoutingChange={onRoutingChange} />,
    ));

    const trace = container.querySelector('.pcb-trace');
    const strokeId = trace.getAttribute('data-stroke');
    expect(strokeId).toMatch(/^auto:/);
    click(trace);
    expect(container.querySelectorAll('.pcb-selected').length).toBeGreaterThan(0);

    key('Delete');
    const value = onRoutingChange.mock.calls[0][0];
    expect(value.traces.every((item) => item.stroke !== strokeId)).toBe(true);
    expect(value.traces.length).toBeLessThan(routedLayout.traces.length);
  });

  it('auto-routes the whole board from the toolbar', () => {
    const onRoutingChange = vi.fn();
    mount({ onRoutingChange });
    const autoButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Auto-route');
    click(autoButton);
    const value = onRoutingChange.mock.calls[0][0];
    expect(value.placement).toBe(layout.placement);
    expect(value.traces.length).toBeGreaterThan(0);
    expect(value.traces.every((trace) => trace.stroke.startsWith('auto:'))).toBe(true);
  });

  it('shows progress and DRC state in the status line', () => {
    mount();
    expect(container.querySelector('.pcb-editor-progress').textContent)
      .toBe('0 of 3 nets connected');
  });
});
