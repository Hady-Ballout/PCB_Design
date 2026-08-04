import React, { useEffect, useRef, useState } from 'react';
import { formatChatTime } from './chatFormat.js';

// The three modes change what the agent is asked to do with its turn, which is
// the only difference that matters: Implement writes a board, the other two
// deliberately do not. Ask and Plan are cheap — no place-and-route, no
// verification loop — so they are the right way to interrogate a design before
// paying to build it.
const COMPOSER_MODE_OPTIONS = [
  { value: 'plan', label: 'Plan', hint: 'Propose an approach without building it' },
  { value: 'ask', label: 'Ask', hint: 'Answer a question about the current circuit' },
  { value: 'implement', label: 'Implement', hint: 'Design and verify a board' },
];

// Minimal mode dropdown pinned to the composer's bottom-left corner: the
// trigger shows the current choice, the menu opens upward over the thread.
function ComposerModeMenu({ mode, onSelect }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = COMPOSER_MODE_OPTIONS.find((option) => option.value === mode)
    || COMPOSER_MODE_OPTIONS.at(-1);

  return (
    <div className="composer-mode-menu" ref={menuRef}>
      {open && (
        <ul className="composer-mode-list" role="listbox" aria-label="Assistant mode">
          {COMPOSER_MODE_OPTIONS.map(({ value, label, hint }) => (
            <li key={value}>
              <button
                type="button"
                role="option"
                aria-selected={mode === value}
                className={`composer-mode-option ${mode === value ? 'selected' : ''}`}
                title={hint}
                onClick={() => { onSelect(value); setOpen(false); }}
              >
                {label}
                <em>{hint}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="composer-mode-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Assistant mode"
        onClick={() => setOpen((value) => !value)}
      >
        {current.label}
        <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

const COMPOSER_PLACEHOLDERS = {
  plan: 'Describe a circuit to plan before building...',
  ask: 'Ask about the design or electronics...',
  implement: 'Message the circuit assistant...',
};

// The sandbox's actual loop, not a fixed pipeline: it reads the knowledge base,
// searches component values, then runs the engine — and goes back to reading
// whenever verification fails. The trail shows where it is now, so a stage can
// light up more than once during a run.
const GENERATION_STAGES = [
  { id: 'design', node: 'Design', label: 'Reading the component reference...' },
  { id: 'solve', node: 'Values', label: 'Searching component values...' },
  { id: 'verify', node: 'Verify', label: 'Placing, routing and checking the board...' },
];

// Live pipeline readout: past stages are copper, the active stage pulses
// phosphor, upcoming stages stay dim.
function GenerationStatus({ stage }) {
  const activeIndex = GENERATION_STAGES.findIndex((entry) => entry.id === stage);
  const label = activeIndex === -1
    ? 'Designing the circuit package...'
    : GENERATION_STAGES[activeIndex].label;
  return (
    <div className="generation-status" role="status">
      <div className="stage-trail" aria-hidden="true">
        {GENERATION_STAGES.map((entry, index) => (
          <React.Fragment key={entry.id}>
            {index > 0 && <span className="stage-link" />}
            <span
              className={`stage-node ${
                activeIndex === -1 ? '' : index < activeIndex ? 'done' : index === activeIndex ? 'active' : ''
              }`}
            >
              {entry.node}
            </span>
          </React.Fragment>
        ))}
      </div>
      <p>
        {label}{' '}
        <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
      </p>
    </div>
  );
}

// Conversation + history sidebar. All workspace state is supplied by the
// app shell (src/app/App.jsx) so this feature can be edited independently.
export function ChatPanel({
  chatPanelView,
  setChatPanelView,
  openImportCircuit,
  chatStore,
  sortedChats,
  activeChat,
  openChat,
  isGenerating,
  composerMode,
  setComposerMode,
  generationStage,
  thinkingText,
  messagesEndRef,
  prompt,
  setPrompt,
  generationBusy,
  onSubmit,
  onNewChat,
  error,
}) {
  return (
    <aside className={`side-panel chat-panel-${chatPanelView}`}>
      {chatPanelView === 'history' ? (
        <>
          <button
            type="button"
            className="chat-new-design"
            onClick={onNewChat}
            title="Start a new design"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            New design
          </button>

          <button
            type="button"
            className="import-circuit-trigger"
            onClick={openImportCircuit}
            title="Import a circuit from JSON instead of generating one"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M12 3v11m0 0l-4-4m4 4l4-4M4 17v3h16v-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Import JSON
          </button>

          <section className="chat-history chat-history-page" aria-label="Chat history">
            <div className="chat-section-label">
              <span>All conversations</span>
              <span>{chatStore.chats.length}</span>
            </div>
            <div className="chat-history-list">
              {sortedChats.map((chat) => (
                <button
                  className={`chat-history-item ${chat.id === activeChat?.id ? 'active' : ''}`}
                  key={chat.id}
                  onClick={() => openChat(chat.id)}
                  type="button"
                >
                  <span className="chat-history-copy">
                    <strong>{chat.title}</strong>
                    <small>{chat.messages.at(-1)?.content || 'Start a new circuit conversation'}</small>
                  </span>
                  <time>{formatChatTime(chat.updatedAt)}</time>
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <header className="chat-conversation-header">
            <button
              className="chat-back-button"
              onClick={() => setChatPanelView('history')}
              type="button"
              aria-label="Open chat history"
              title="Chat history"
            >
              <span aria-hidden="true">&larr;</span>
            </button>
            <div className="chat-conversation-title">
              <h1>{activeChat?.title}</h1>
            </div>
            {/* A follow-up message continues the same design — and resumes the
                same agent session — so starting an unrelated board needs its own
                affordance rather than a fresh sentence in an old thread. */}
            <button
              className="chat-new-button"
              onClick={onNewChat}
              type="button"
              disabled={generationBusy}
              aria-label="New design"
              title={generationBusy ? 'Finish the current board first' : 'Start a new design'}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          <section className="chat-thread" aria-label="Current conversation">

            <div className="chat-messages" aria-live="polite">
              {activeChat?.messages.length === 0 && (
                <div className="chat-welcome">
                  <strong>What would you like to build?</strong>
                  <p>Describe a circuit, then continue refining it with follow-up messages.</p>
                  <button
                    type="button"
                    className="import-circuit-trigger"
                    onClick={openImportCircuit}
                    title="Import a circuit from JSON instead of generating one"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path
                        d="M12 3v11m0 0l-4-4m4 4l4-4M4 17v3h16v-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Import JSON
                  </button>
                </div>
              )}
              {activeChat?.messages.map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <div className="chat-message-meta">
                    <time>{formatChatTime(message.createdAt)}</time>
                  </div>
                  <p className={message.mode ? 'chat-multiline' : ''}>{message.content}</p>
                  {message.circuit && (
                    // `type` is not part of the circuit contract — title,
                    // supplyVoltage and components are. The old pipeline
                    // happened to emit one and this read it unguarded, so a
                    // generated circuit crashed the whole app to a white page.
                    // Describe the board from fields that are always there.
                    <div className="chat-artifact-chip">
                      <span>
                        {message.circuit.components?.length ?? 0} parts
                        {message.circuit.supplyVoltage ? ` · ${message.circuit.supplyVoltage} V` : ''}
                      </span>
                      <strong>{message.circuit.title || 'Circuit'}</strong>
                    </div>
                  )}
                </article>
              ))}
              {isGenerating && (
                <article className="chat-message assistant pending">
                  <GenerationStatus stage={generationStage} />
                </article>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form
              className="chat-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!generationBusy && prompt.trim()) onSubmit?.();
              }}
            >
              <div className="chat-composer-input">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter sends, Shift+Enter breaks the line — a circuit
                    // request is usually one sentence.
                    if (event.key !== 'Enter' || event.shiftKey) return;
                    event.preventDefault();
                    if (!generationBusy && prompt.trim()) onSubmit?.();
                  }}
                  rows={3}
                  disabled={generationBusy}
                  // Short enough to sit on one line at the panel's narrowest.
                  // The long version wrapped to three lines and ran under the
                  // mode chip and send button.
                  placeholder={COMPOSER_PLACEHOLDERS[composerMode] || COMPOSER_PLACEHOLDERS.implement}
                  aria-label="Message the circuit assistant"
                />
                <ComposerModeMenu mode={composerMode} onSelect={setComposerMode} />
                <button
                  className="composer-send-button"
                  type="submit"
                  disabled={generationBusy || !prompt.trim()}
                  aria-label={generationBusy ? 'Building the board' : 'Send'}
                  title={generationBusy ? 'Building the board' : 'Send'}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path d="M3 11.5L21 3l-8.5 18-2.2-7.3L3 11.5z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </form>
            {error && <p className="inline-error chat-error">{error}</p>}
          </section>
        </>
      )}
    </aside>
  );
}
