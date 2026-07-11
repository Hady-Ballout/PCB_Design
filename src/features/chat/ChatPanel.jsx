import React from 'react';
import { formatChatTime } from './chatFormat.js';
import { ClarificationCard } from './ClarificationCard.jsx';

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
  generationStage,
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
                    <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                    <time>{formatChatTime(message.createdAt)}</time>
                  </div>
                  <p>{message.content}</p>
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
                  <div className="chat-message-meta"><strong>AI</strong></div>
                  <p>
                    Preparing a few quick questions...{' '}
                    <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                  </p>
                </article>
              )}
              {isGenerating && (
                <article className="chat-message assistant pending">
                  <div className="chat-message-meta"><strong>AI</strong></div>
                  <GenerationStatus stage={generationStage} />
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
                  placeholder="Message the circuit assistant..."
                  aria-label="Message the circuit assistant"
                />
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
            {error && <p className="inline-error chat-error">{error}</p>}
          </section>
        </>
      )}
    </aside>
  );
}
