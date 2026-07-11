// @vitest-environment jsdom
// Mounts the real card into jsdom and drives clicks/typing, asserting the
// answer/submit/skip callbacks and the frozen state after a round resolves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ClarificationCard } from './ClarificationCard.jsx';
import { NO_PREFERENCE_ANSWER } from './chatStore.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const baseMessage = (overrides = {}) => ({
  id: 'm1',
  role: 'assistant',
  content: 'Questions:',
  clarification: {
    forPrompt: 'blink an LED',
    questions: [
      { id: 'q1', question: 'What supply?', options: ['USB 5V', '9V battery', NO_PREFERENCE_ANSWER] },
    ],
    answers: {},
    status: 'pending',
    ...overrides,
  },
});

let container;
let root;

const mount = (props) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ClarificationCard {...props} />));
};

const chipByText = (text) =>
  [...container.querySelectorAll('.clarify-chip')].find((chip) => chip.textContent === text);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('ClarificationCard', () => {
  it('answers a question when a chip is clicked and marks the selection', () => {
    const onAnswer = vi.fn();
    mount({ message: baseMessage(), disabled: false, onAnswer, onSubmit: vi.fn(), onSkip: vi.fn() });

    act(() => chipByText('USB 5V').click());
    expect(onAnswer).toHaveBeenCalledWith('q1', 'USB 5V');

    mount({ message: baseMessage({ answers: { q1: 'USB 5V' } }), disabled: false, onAnswer, onSubmit: vi.fn(), onSkip: vi.fn() });
    const selected = chipByText('USB 5V');
    expect(selected.classList.contains('selected')).toBe(true);
    expect(selected.getAttribute('aria-pressed')).toBe('true');
  });

  it('commits a custom typed answer via Enter and renders it as a selected chip', () => {
    const onAnswer = vi.fn();
    mount({ message: baseMessage(), disabled: false, onAnswer, onSubmit: vi.fn(), onSkip: vi.fn() });

    const input = container.querySelector('.clarify-custom input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ' solar panel ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onAnswer).toHaveBeenCalledWith('q1', 'solar panel');

    mount({ message: baseMessage({ answers: { q1: 'solar panel' } }), disabled: false, onAnswer, onSubmit: vi.fn(), onSkip: vi.fn() });
    expect(chipByText('solar panel').classList.contains('selected')).toBe(true);
  });

  it('submits and skips through the footer actions', () => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    mount({ message: baseMessage(), disabled: false, onAnswer: vi.fn(), onSubmit, onSkip });

    act(() => container.querySelector('.clarify-submit').click());
    act(() => container.querySelector('.clarify-skip').click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('freezes resolved rounds and disables everything while busy', () => {
    mount({ message: baseMessage({ status: 'answered', answers: { q1: 'USB 5V' } }), disabled: false, onAnswer: vi.fn(), onSubmit: vi.fn(), onSkip: vi.fn() });
    expect(container.querySelector('.clarify-submit')).toBeNull();
    expect(container.querySelector('.clarify-custom')).toBeNull();
    expect(chipByText('USB 5V').disabled).toBe(true);
    expect(container.querySelector('.clarify-resolved-note').textContent).toBe('Answers submitted.');

    mount({ message: baseMessage(), disabled: true, onAnswer: vi.fn(), onSubmit: vi.fn(), onSkip: vi.fn() });
    expect(chipByText('USB 5V').disabled).toBe(true);
    expect(container.querySelector('.clarify-submit').disabled).toBe(true);
    expect(container.querySelector('.clarify-skip').disabled).toBe(true);
  });
});
