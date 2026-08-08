import React, { useEffect, useRef, useState } from 'react';
import { IMPORT_SIZE_LIMIT, parseImportedCircuit } from './importCircuit.js';
import './importCircuit.css';

const SAMPLE = `{
  "title": "RC low-pass",
  "supplyVoltage": 5,
  "components": [
    { "ref": "V1", "kind": "voltage_source", "value": "5V", "nodes": ["VIN", "0"] },
    { "ref": "R1", "kind": "resistor", "value": "1k", "nodes": ["VIN", "VOUT"] },
    { "ref": "C1", "kind": "capacitor", "value": "100nF", "nodes": ["VOUT", "0"] }
  ]
}`;

/**
 * Paste-or-upload circuit JSON and drop it straight into the workspace.
 *
 * Validation runs here so errors land next to the text that caused them; the
 * parsed circuit goes to `onImport`, which owns creating the chat.
 */
export function ImportCircuitDialog({ open, onClose, onImport }) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setErrors([]);
    setImporting(false);
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !importing) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    textareaRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, importing]);

  if (!open) return null;

  const readFile = async (file) => {
    if (!file) return;
    if (file.size > IMPORT_SIZE_LIMIT) {
      setErrors([`${file.name} is ${Math.round(file.size / 1000)} kB; the limit is ${IMPORT_SIZE_LIMIT / 1000} kB.`]);
      return;
    }
    setFileName(file.name);
    setErrors([]);
    setText(await file.text());
  };

  const submit = async () => {
    const parsed = parseImportedCircuit(text);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    // Building the workspace package is synchronous CPU work — the schematic
    // router alone can run for a second on a dense board — so it blocks paint.
    // Flip the busy state, then wait two frames: the first lets React commit
    // it, the second lets the browser actually paint before the main thread is
    // taken. Without this the spinner never appears, however long the wait.
    setImporting(true);
    setErrors([]);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    try {
      // onImport returns a message when the circuit parses but cannot be built
      // into a workspace package; the dialog stays open so the text is editable.
      const failure = onImport(parsed.circuit, fileName);
      if (failure) {
        setErrors([failure]);
        return;
      }
      setText('');
      setFileName('');
      setErrors([]);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <div
        className="import-circuit-backdrop"
        onClick={() => { if (!importing) onClose(); }}
        role="presentation"
      />
      <div
        className="import-circuit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-circuit-title"
      >
        <header className="import-circuit-header">
          <span className="import-circuit-title" id="import-circuit-title">Import circuit JSON</span>
          <button
            type="button"
            className="import-circuit-close"
            onClick={onClose}
            disabled={importing}
            aria-label="Close import dialog"
          >
            ×
          </button>
        </header>

        <p className="import-circuit-hint">
          Paste a circuit — components with <code>ref</code>, <code>kind</code>, <code>value</code> and{' '}
          <code>nodes</code>. The schematic, board, 3D view and exports are all generated from it.
        </p>

        <textarea
          ref={textareaRef}
          className="import-circuit-input"
          value={text}
          spellCheck={false}
          disabled={importing}
          onChange={(event) => { setText(event.target.value); setFileName(''); }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            readFile(event.dataTransfer.files?.[0]);
          }}
          placeholder={SAMPLE}
          aria-label="Circuit JSON"
          rows={16}
        />

        {errors.length > 0 && (
          <ul className="import-circuit-errors" role="alert">
            {errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        )}

        <footer className="import-circuit-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="import-circuit-file"
            onChange={(event) => {
              readFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="import-circuit-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            Choose file…
          </button>
          <span className="import-circuit-filename" role="status" aria-live="polite">
            {importing ? 'Placing, routing and checking the board — this can take a moment.' : fileName}
          </span>
          <button
            type="button"
            className="import-circuit-secondary"
            onClick={() => { setText(SAMPLE); setFileName(''); setErrors([]); }}
            disabled={importing}
          >
            Use example
          </button>
          <button
            type="button"
            className="import-circuit-primary"
            onClick={submit}
            disabled={!text.trim() || importing}
          >
            {importing ? (
              <>
                <span className="import-circuit-spinner" aria-hidden="true" />
                Building board...
              </>
            ) : 'Import'}
          </button>
        </footer>
      </div>
    </>
  );
}
