import React, { useEffect, useRef, useState } from 'react';
import { formatChatTime } from './chatFormat.js';

const COMPOSER_MODE_OPTIONS = [
  { value: 'plan', label: 'Plan' },
  { value: 'ask', label: 'Ask' },
  { value: 'implement', label: 'Implement' },
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
          {COMPOSER_MODE_OPTIONS.map(({ value, label }) => (
            <li key={value}>
              <button
                type="button"
                role="option"
                aria-selected={mode === value}
                className={`composer-mode-option ${mode === value ? 'selected' : ''}`}
                onClick={() => { onSelect(value); setOpen(false); }}
              >
                {label}
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

const GENERATION_STAGES = [
  { id: 'circuit', node: 'Circuit', label: 'Generating circuit...' },
  { id: 'reviewing', node: 'Review', label: 'Reviewing design...' },
  { id: 'reply', node: 'Reply', label: 'Writing summary...' },
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
  error,
}) {
  return (
    <aside className={`side-panel chat-panel-${chatPanelView}`}>
      {chatPanelView === 'history' ? (
        <>
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
                    <div className="chat-artifact-chip">
                      <span>{message.circuit.type.replaceAll('_', ' ')}</span>
                      <strong>{message.circuit.title}</strong>
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

            <form className="chat-composer" onSubmit={(event) => event.preventDefault()}>
              <div className="chat-composer-input">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                  disabled
                  placeholder="Circuit generation has been removed. Use Import JSON to load a circuit."
                  aria-label="Message the circuit assistant"
                />
                <ComposerModeMenu mode={composerMode} onSelect={setComposerMode} />
                <button
                  className="composer-send-button"
                  type="submit"
                  disabled
                  aria-label="Circuit generation removed"
                  title="Circuit generation removed"
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
