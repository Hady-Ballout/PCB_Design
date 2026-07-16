import React, { useEffect, useRef } from 'react';

// Live model reasoning streamed while a request is in flight, shown as a
// small window that stays pinned to the newest text. Ephemeral by design:
// the app drops the text the moment the real reply arrives and nothing is
// ever written to the chat store.
export function ThinkingWindow({ text }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text) return null;
  return (
    <div className="thinking-window">
      <div className="thinking-window-label">
        Thinking{' '}
        <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
      <div
        className="thinking-window-scroll"
        ref={scrollRef}
        role="status"
        aria-label="AI reasoning in progress"
      >
        <p>{text}</p>
      </div>
    </div>
  );
}
