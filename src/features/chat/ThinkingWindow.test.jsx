// @vitest-environment jsdom
// Mounts the live-reasoning window into jsdom and asserts it renders only
// while there is thinking text and stays pinned to the newest text.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingWindow } from './ThinkingWindow.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

const mount = (props) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ThinkingWindow {...props} />));
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ThinkingWindow', () => {
  it('renders nothing without thinking text', () => {
    mount({ text: '' });
    expect(container.querySelector('.thinking-window')).toBeNull();
  });

  it('shows the streamed reasoning with a Thinking label', () => {
    mount({ text: 'An LED needs a series resistor.' });
    expect(container.querySelector('.thinking-window-label').textContent).toContain('Thinking');
    expect(container.querySelector('.thinking-window-scroll').textContent)
      .toBe('An LED needs a series resistor.');
  });

  it('pins the scroll window to the newest text as it streams', () => {
    mount({ text: 'first' });
    const scroller = container.querySelector('.thinking-window-scroll');
    // jsdom has no layout, so emulate an overflowing box.
    Object.defineProperty(scroller, 'scrollHeight', { value: 400, configurable: true });
    act(() => root.render(<ThinkingWindow text={'first second'} />));
    expect(scroller.scrollTop).toBe(400);
  });
});
