// @vitest-environment jsdom
// Mounts the real card into jsdom and drives the "Build this" button,
// asserting the callback, the busy-disabled state, and the frozen state
// after a plan has been built.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanCard } from './PlanCard.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const baseMessage = (overrides = {}) => ({
  id: 'm1',
  role: 'assistant',
  content: '- Use a 555 timer\n- R1 10k',
  mode: 'plan',
  plan: {
    forPrompt: 'blink an LED',
    status: 'proposed',
    ...overrides,
  },
});

let container;
let root;

const mount = (props) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PlanCard {...props} />));
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('PlanCard', () => {
  it('fires onBuild when Build this is clicked', () => {
    const onBuild = vi.fn();
    mount({ message: baseMessage(), disabled: false, onBuild });

    const button = container.querySelector('.plan-build');
    expect(button.textContent).toBe('Build this');
    act(() => button.click());
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it('disables the button while the AI is busy', () => {
    mount({ message: baseMessage(), disabled: true, onBuild: vi.fn() });
    expect(container.querySelector('.plan-build').disabled).toBe(true);
  });

  it('freezes built plans into a resolved note without a button', () => {
    mount({ message: baseMessage({ status: 'built' }), disabled: false, onBuild: vi.fn() });
    expect(container.querySelector('.plan-build')).toBeNull();
    expect(container.querySelector('.plan-card').classList.contains('resolved')).toBe(true);
    expect(container.querySelector('.plan-resolved-note').textContent).toBe('Plan built.');
  });
});
