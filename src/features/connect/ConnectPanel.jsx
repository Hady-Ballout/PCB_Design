import { useCallback, useMemo, useState } from 'react';
import {
  claudeCodeCommand,
  desktopSteps,
  examplePrompts,
  mcpEndpointUrl,
} from './connectInstructions.js';
import './connect.css';

/** Copy-to-clipboard button that confirms itself and resets. */
function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions). The value
      // is on screen and selectable, so this is a downgrade, not a failure.
      setCopied(false);
    }
  }, [value]);

  return (
    <button type="button" className="connect-copy" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * "Connect to Claude" — hands the user the MCP endpoint URL and tells them where
 * to paste it.
 *
 * The whole page exists for the copy button: everything else is the context needed
 * to know what to do with what was copied.
 */
export default function ConnectPanel({ onBack }) {
  const endpoint = useMemo(
    () => mcpEndpointUrl({
      origin: typeof window === 'undefined' ? '' : window.location.origin,
      configuredBase: import.meta.env?.VITE_MCP_BASE_URL,
    }),
    [],
  );
  const command = useMemo(() => claudeCodeCommand(endpoint), [endpoint]);

  return (
    <main className="app-shell connect-page">
      <header className="connect-header">
        <div>
          <p className="eyebrow">Model Context Protocol</p>
          <h1>Connect PCB Pilot to Claude</h1>
          <p className="connect-lede">
            Give Claude direct access to this engine. It can then validate circuits against
            the topology rules, run Ngspice, and export SPICE, KiCad, and PCB layouts —
            using the same code that runs here, not a description of it.
          </p>
        </div>
        {onBack && <button type="button" onClick={onBack}>Back to generator</button>}
      </header>

      <section className="connect-card connect-card-primary">
        <h2>Your connection URL</h2>
        <div className="connect-url-row">
          <code className="connect-url">{endpoint}</code>
          <CopyButton value={endpoint} label="Copy URL" />
        </div>
        <p className="connect-note">
          Claude will ask you to sign in and approve access the first time it connects.
          That authorization is separate from your PCB Pilot login — you can revoke it
          without signing out here.
        </p>
      </section>

      <div className="connect-columns">
        <section className="connect-card">
          <h2>Claude Code</h2>
          <p className="connect-card-lede">Run this in your terminal:</p>
          <div className="connect-url-row">
            <code className="connect-url connect-url-command">{command}</code>
            <CopyButton value={command} />
          </div>
        </section>

        <section className="connect-card">
          <h2>Claude Desktop &amp; claude.ai</h2>
          <ol className="connect-steps">
            {desktopSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>
      </div>

      <section className="connect-card">
        <h2>Once connected, try asking</h2>
        <ul className="connect-prompts">
          {examplePrompts.map((prompt) => (
            <li key={prompt}><span className="connect-quote">{prompt}</span></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
