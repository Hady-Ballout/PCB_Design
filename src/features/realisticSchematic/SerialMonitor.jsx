// Read-only serial monitor for the live simulation: streams the emulated
// Uno's Serial.print output. Collapsible, auto-scrolling, with a local Clear
// (the engine's ring buffer keeps at most 4 KB; Clear just hides what came
// before). Serial input to the sketch is a future milestone.
import { useEffect, useRef, useState } from 'react';

export function SerialMonitor({ text }) {
  const [open, setOpen] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);
  const bodyRef = useRef(null);
  const visible = text.length >= clearedAt ? text.slice(clearedAt) : text;

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [visible]);

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
    </div>
  );
}
