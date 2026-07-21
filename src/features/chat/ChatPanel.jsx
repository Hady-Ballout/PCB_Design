import React, { useEffect, useRef, useState } from 'react';
import { formatChatTime } from './chatFormat.js';
import { ClarificationCard } from './ClarificationCard.jsx';
import { PlanCard } from './PlanCard.jsx';
import { ThinkingWindow } from './ThinkingWindow.jsx';

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
  newChatPrompt,
  setNewChatPrompt,
  startChatFromHistory,
  handleNewChatComposerKeyDown,
  chatStore,
  sortedChats,
  activeChat,
  openChat,
  isGenerating,
  isClarifying,
  isAssisting,
  composerMode,
  setComposerMode,
  buildFromPlan,
  generationStage,
  thinkingText,
  answerClarification,
  submitClarification,
  skipClarification,
  messagesEndRef,
  prompt,
  setPrompt,
  handleComposerKeyDown,
  generate,
  generationBusy,
  error,
  errorCode,
}) {
  return (
    <aside className={`side-panel chat-panel-${chatPanelView}`}>
      {chatPanelView === 'history' ? (
        <>
          <header className="chat-sidebar-header chat-history-header">
            <div>
              <p className="eyebrow">Prompt-to-PCB MVP</p>
              <h1>Previous chats</h1>
            </div>
          </header>

          <form
            className="chat-composer new-chat-composer"
            onSubmit={(event) => { event.preventDefault(); startChatFromHistory(); }}
          >
            <div className="chat-composer-input">
              <textarea
                value={newChatPrompt}
                onChange={(event) => setNewChatPrompt(event.target.value)}
                onKeyDown={handleNewChatComposerKeyDown}
                rows={3}
                placeholder="Describe a new circuit to start a new chat..."
                aria-label="Describe a new circuit to start a new chat"
              />
              <button
                className="composer-send-button"
                type="submit"
                disabled={generationBusy || !newChatPrompt.trim()}
                aria-label="Start new chat"
                title="Start new chat"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M3 11.5L21 3l-8.5 18-2.2-7.3L3 11.5z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </form>

          <section className="chat-history chat-history-page" aria-label="Previous chats">
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
              aria-label="Open previous chats"
              title="Previous chats"
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
                </div>
              )}
              {activeChat?.messages.map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <div className="chat-message-meta">
                    <time>{formatChatTime(message.createdAt)}</time>
                  </div>
                  <p className={message.mode ? 'chat-multiline' : ''}>{message.content}</p>
                  {message.plan && (
                    <PlanCard
                      message={message}
                      disabled={generationBusy}
                      onBuild={() => buildFromPlan(message.id)}
                    />
                  )}
                  {message.clarification && (
                    <ClarificationCard
                      message={message}
                      disabled={generationBusy}
                      onAnswer={(questionId, answer) => answerClarification(message.id, questionId, answer)}
                      onSubmit={() => submitClarification(message.id)}
                      onSkip={() => skipClarification(message.id)}
                    />
                  )}
                  {message.circuit && (
                    <div className="chat-artifact-chip">
                      <span>{message.circuit.type.replaceAll('_', ' ')}</span>
                      <strong>{message.circuit.title}</strong>
                    </div>
                  )}
                </article>
              ))}
              {isClarifying && (
                <article className="chat-message assistant pending">
                  <p>
                    Preparing a few quick questions...{' '}
                    <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                  </p>
                  <ThinkingWindow text={thinkingText} />
                </article>
              )}
              {isAssisting && (
                <article className="chat-message assistant pending">
                  <p>
                    {composerMode === 'plan' ? 'Drafting a design plan...' : 'Thinking...'}{' '}
                    <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                  </p>
                  <ThinkingWindow text={thinkingText} />
                </article>
              )}
              {isGenerating && (
                <article className="chat-message assistant pending">
                  <GenerationStatus stage={generationStage} />
                  <ThinkingWindow text={thinkingText} />
                </article>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); generate(); }}>
              <div className="chat-composer-input">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={3}
                  placeholder={COMPOSER_PLACEHOLDERS[composerMode] || COMPOSER_PLACEHOLDERS.implement}
                  aria-label="Message the circuit assistant"
                />
                <ComposerModeMenu mode={composerMode} onSelect={setComposerMode} />
                <button
                  className="composer-send-button"
                  type="submit"
                  disabled={generationBusy || !prompt.trim()}
                  aria-label={isGenerating ? 'Sending...' : generationBusy ? 'AI busy...' : 'Send message'}
                  title={isGenerating ? 'Sending...' : generationBusy ? 'AI busy...' : 'Send message'}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path d="M3 11.5L21 3l-8.5 18-2.2-7.3L3 11.5z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </form>
            {errorCode === 'quota_exceeded' ? (
              <div className="quota-upsell">
                <h4>Monthly AI limit reached</h4>
                <p>{error}</p>
                <a className="btn btn-primary" href="#pricing">See plans</a>
              </div>
            ) : error && <p className="inline-error chat-error">{error}</p>}
          </section>
        </>
      )}
    </aside>
  );
}
