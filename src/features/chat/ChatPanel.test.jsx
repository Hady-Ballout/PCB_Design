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

  it('stays available while a board is building', () => {
    // Being unable to start a new design because an earlier run hung is a trap,
    // and a hang is exactly when you most want out.
    const onNewChat = vi.fn();
    render({ activeChat: chatWith(null), generationBusy: true, onNewChat });
    const button = container.querySelector('.chat-new-button');
    expect(button.disabled).toBe(false);
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe('stopping a run', () => {
  // A run can stall on the provider's side with no error and no output —
  // observed live, seven minutes of silence after a tool call was approved.
  // Without a stop control there is no way out of that.
  it('turns the send button into stop while building', () => {
    const onStop = vi.fn();
    render({ activeChat: chatWith(null), generationBusy: true, onStop });
    const stop = container.querySelector('.composer-stop-button');
    expect(stop).not.toBeNull();
    expect(stop.disabled).toBe(false);
    act(() => stop.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows send again when nothing is running', () => {
    render({ activeChat: chatWith(null), prompt: 'blink an LED' });
    expect(container.querySelector('.composer-stop-button')).toBeNull();
    expect(container.querySelector('.composer-send-button').disabled).toBe(false);
  });
});

describe('assistant replies are markdown', () => {
  // The agent answers in markdown — parts tables, solved values, fenced
  // assertion blocks. Rendered as plain text that became a wall of pipes and
  // hashes.
  const reply = (content) => ({
    id: 'c1',
    title: 'A chat',
    messages: [{ id: 'm1', role: 'assistant', content, createdAt: Date.now() }],
  });

  it('renders a parts table, which is the densest thing in a reply', () => {
    render({ activeChat: reply('| Ref | Value |\n|---|---|\n| R1 | 9.1k |\n| R2 | 82k |') });
    expect(container.querySelectorAll('.chat-markdown table th')).toHaveLength(2);
    expect(container.querySelectorAll('.chat-markdown table tbody tr')).toHaveLength(2);
    // Wide tables scroll inside the bubble instead of stretching the panel.
    expect(container.querySelector('.chat-md-table-wrap')).not.toBeNull();
  });

  it('renders headings, emphasis and code without showing the syntax', () => {
    render({ activeChat: reply('## Plan\n\nAchieved **1.200 s** via `solve.mjs`.') });
    const text = container.querySelector('.chat-markdown').textContent;
    expect(container.querySelector('.chat-md-heading').textContent).toBe('Plan');
    expect(container.querySelector('.chat-markdown strong')).not.toBeNull();
    expect(container.querySelector('.chat-markdown code').textContent).toBe('solve.mjs');
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
  });

  it('renders a fenced block of assertions', () => {
    render({ activeChat: reply('```\nU1.TRIG == U1.THRES\n```') });
    expect(container.querySelector('.chat-markdown pre code').textContent).toContain('U1.TRIG == U1.THRES');
  });

  it('does not execute HTML embedded in a reply', () => {
    // The text comes from a model, so raw HTML must stay inert — no rehype-raw.
    render({ activeChat: reply('<img src=x onerror="window.__x=1"> and <b>bold</b>') });
    const markdown = container.querySelector('.chat-markdown');
    expect(markdown.querySelector('img')).toBeNull();
    expect(markdown.querySelector('b')).toBeNull();
    expect(window.__x).toBeUndefined();
  });

  it('leaves the user\'s own words exactly as typed', () => {
    render({
      activeChat: {
        id: 'c1',
        title: 'A chat',
        messages: [{ id: 'm1', role: 'user', content: 'blink an LED **fast**', createdAt: Date.now() }],
      },
    });
    expect(container.querySelector('.chat-markdown')).toBeNull();
    expect(container.querySelector('.chat-message.user p').textContent).toBe('blink an LED **fast**');
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

  it('locks the input while a board is being built, but offers stop', () => {
    // The send button is replaced by Stop rather than disabled — a disabled
    // control at this moment would leave no way out of a stalled run.
    render({ activeChat: chatWith(null), prompt: 'blink an LED', generationBusy: true });
    expect(container.querySelector('.chat-composer-input textarea').disabled).toBe(true);
    expect(container.querySelector('.composer-stop-button').disabled).toBe(false);
  });

  it('changes the placeholder with the mode, since the modes do different work', () => {
    render({ activeChat: chatWith(null), composerMode: 'ask' });
    expect(container.querySelector('textarea').placeholder).toMatch(/Ask about/i);
    render({ activeChat: chatWith(null), composerMode: 'plan' });
    expect(container.querySelector('textarea').placeholder).toMatch(/plan/i);
  });
});
