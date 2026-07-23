// Serial monitor for the live simulation: streams the emulated Uno's
// Serial.print output, and — when the engine offers sending — feeds typed
// lines back into the sketch's Serial (a trailing newline is appended, like
// the Arduino IDE's monitor). Collapsible, auto-scrolling, local Clear.
import { useEffect, useRef, useState } from 'react';

export function SerialMonitor({ text, onSendSerial }) {
  const [open, setOpen] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef(null);
  const visible = text.length >= clearedAt ? text.slice(clearedAt) : text;

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [visible]);

  const send = () => {
    if (!draft) return;
    onSendSerial?.(`${draft}\n`);
    setDraft('');
  };

  return (
    <div className="realistic-serial">
      <div className="realistic-serial-bar">
        <button type="button" onClick={() => setOpen((value) => !value)}>
          {open ? '▾' : '▸'} Serial monitor
        </button>
        {open && (
          <button type="button" onClick={() => setClearedAt(text.length)}>Clear</button>
        )}
      </div>
      {open && (
        <pre ref={bodyRef} className="realistic-serial-body">
          {visible || '(no output yet)'}
        </pre>
      )}
      {open && typeof onSendSerial === 'function' && (
        <div className="realistic-serial-input">
          <input
            type="text"
            value={draft}
            placeholder="Send to the sketch…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') send();
            }}
          />
          <button type="button" onClick={send}>Send</button>
        </div>
      )}
    </div>
  );
}
