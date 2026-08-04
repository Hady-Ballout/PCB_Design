// @vitest-environment jsdom
//
// The chat thread renders whatever a circuit turns out to be, and a generated
// circuit is not shaped like the ones the old pipeline produced. Getting that
// wrong took the entire app to a blank page, so the shape it must tolerate is
// pinned here.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel.jsx';

let container;
let root;

const baseProps = {
  chatPanelView: 'conversation',
  setChatPanelView: () => {},
  openImportCircuit: () => {},
  chatStore: { chats: [], activeChatId: 'c1' },
  sortedChats: [],
  openChat: () => {},
  isGenerating: false,
  composerMode: 'implement',
  setComposerMode: () => {},
  generationStage: null,
  generationMode: 'implement',
  verifyAttempts: 0,
  thinkingText: '',
  messagesEndRef: { current: null },
  prompt: '',
  setPrompt: () => {},
  generationBusy: false,
  onSubmit: () => {},
  onNewChat: () => {},
  error: '',
};

const chatWith = (circuit) => ({
  id: 'c1',
  title: 'A chat',
  messages: [{ id: 'm1', role: 'assistant', content: 'Built it.', createdAt: Date.now(), circuit }],
});

const render = (props) => {
  act(() => {
    root.render(<ChatPanel {...baseProps} {...props} />);
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('circuit chip', () => {
  // The regression. A sandbox circuit carries title, supplyVoltage and
  // components — and no `type`. Reading `circuit.type.replaceAll(...)` threw,
  // React unmounted the tree, and the window went white mid-generation.
  const generated = {
    title: '1 Hz LED blinker (555 astable)',
    supplyVoltage: 9,
    components: [{ ref: 'U1' }, { ref: 'R1' }, { ref: 'D1' }],
  };

  it('renders a circuit that has no type field', () => {
    render({ activeChat: chatWith(generated) });
    const chip = container.querySelector('.chat-artifact-chip');
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('3 parts');
    expect(chip.textContent).toContain('9 V');
    expect(chip.textContent).toContain('1 Hz LED blinker');
  });

  it('survives a circuit with no title and no components', () => {
    render({ activeChat: chatWith({}) });
    expect(container.querySelector('.chat-artifact-chip').textContent).toContain('0 parts');
  });
});

describe('starting a new design', () => {
  // A follow-up resumes the same sandbox run, so an unrelated board needs its
  // own entry point. There was none — `createChat` was imported and never
  // called from any control.
  it('offers a new design from the conversation header', () => {
    const onNewChat = vi.fn();
    render({ activeChat: chatWith(null), onNewChat });
    const button = container.querySelector('.chat-new-button');
    expect(button).not.toBeNull();
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('offers one from the history page too', () => {
    const onNewChat = vi.fn();
    render({ activeChat: chatWith(null), chatPanelView: 'history', onNewChat });
    const button = container.querySelector('.chat-new-design');
    expect(button).not.toBeNull();
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('does not let a board be abandoned mid-build', () => {
    render({ activeChat: chatWith(null), generationBusy: true });
    expect(container.querySelector('.chat-new-button').disabled).toBe(true);
  });
});

describe('progress readout', () => {
  // Every mode used to render the same three-stage trail, so an Ask turn
  // advertised a VERIFY step it never runs — and the live tool line was
  // captured but never displayed, which is why runs looked identical.
  const generating = { activeChat: chatWith(null), isGenerating: true };

  it('shows only a thinking indicator for a question', () => {
    render({ ...generating, generationMode: 'ask', generationStage: 'design' });
    expect(container.querySelector('.stage-trail')).toBeNull();
    expect(container.querySelector('.generation-status-ask').textContent).toMatch(/Thinking/);
  });

  it('drops the verify stage from a plan, which never builds', () => {
    render({ ...generating, generationMode: 'plan', generationStage: 'design' });
    const nodes = [...container.querySelectorAll('.stage-node')].map((node) => node.textContent);
    expect(nodes).toEqual(['Reading', 'Sizing']);
  });

  it('keeps all three for a board, and marks the active one', () => {
    render({ ...generating, generationMode: 'implement', generationStage: 'verify' });
    const nodes = [...container.querySelectorAll('.stage-node')];
    expect(nodes.map((node) => node.textContent)).toEqual(['Design', 'Values', 'Verify']);
    expect(nodes[2].className).toContain('active');
    expect(nodes[0].className).toContain('done');
  });

  it('surfaces what the agent is actually doing', () => {
    render({ ...generating, generationMode: 'implement', thinkingText: 'reading components/timer_555.md' });
    expect(container.querySelector('.generation-activity').textContent).toBe('reading components/timer_555.md');
  });

  it('says when the board failed a gate and is being fixed', () => {
    render({ ...generating, generationMode: 'implement', verifyAttempts: 1 });
    expect(container.querySelector('.generation-attempts')).toBeNull();
    render({ ...generating, generationMode: 'implement', verifyAttempts: 3 });
    expect(container.querySelector('.generation-attempts').textContent).toMatch(/attempt 3/);
  });
});

describe('composer', () => {
  it('sends on click and refuses an empty prompt', () => {
    const onSubmit = vi.fn();
    render({ activeChat: chatWith(null), prompt: '  ', onSubmit });
    expect(container.querySelector('.composer-send-button').disabled).toBe(true);

    render({ activeChat: chatWith(null), prompt: 'blink an LED', onSubmit });
    const button = container.querySelector('.composer-send-button');
    expect(button.disabled).toBe(false);
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('locks the composer while a board is being built', () => {
    render({ activeChat: chatWith(null), prompt: 'blink an LED', generationBusy: true });
    expect(container.querySelector('.chat-composer-input textarea').disabled).toBe(true);
    expect(container.querySelector('.composer-send-button').disabled).toBe(true);
  });

  it('changes the placeholder with the mode, since the modes do different work', () => {
    render({ activeChat: chatWith(null), composerMode: 'ask' });
    expect(container.querySelector('textarea').placeholder).toMatch(/Ask about/i);
    render({ activeChat: chatWith(null), composerMode: 'plan' });
    expect(container.querySelector('textarea').placeholder).toMatch(/plan/i);
  });
});
