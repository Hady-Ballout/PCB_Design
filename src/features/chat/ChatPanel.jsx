import { formatChatTime } from './chatFormat.js';

// Conversation + history sidebar. All workspace state is supplied by the
// app shell (src/app/App.jsx) so this feature can be edited independently.
export function ChatPanel({
  chatPanelView,
  setChatPanelView,
  startNewChat,
  chatStore,
  sortedChats,
  activeChat,
  openChat,
  exportAll,
  result,
  isGenerating,
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
            <button className="new-chat-button" onClick={startNewChat} type="button">
              + New chat
            </button>
          </header>

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
              <p className="eyebrow">AI circuit assistant</p>
              <h1>{activeChat?.title}</h1>
            </div>
            <button onClick={exportAll} disabled={!result} type="button">Export</button>
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
                  <div className="chat-message-meta"><strong>AI</strong></div>
                  <p>Designing the circuit package...</p>
                </article>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); generate(); }}>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={3}
                placeholder="Message the circuit assistant..."
                aria-label="Message the circuit assistant"
              />
              <div className="chat-composer-footer">
                <small>Enter to send, Shift+Enter for a new line</small>
                <button className="primary" type="submit" disabled={generationBusy || !prompt.trim()}>
                  {isGenerating ? 'Sending...' : generationBusy ? 'AI busy...' : 'Send'}
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
