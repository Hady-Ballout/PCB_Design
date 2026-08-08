import React from 'react';

/**
 * Last line of defence against a render bug taking the whole app to a blank page.
 *
 * This exists because one did. A generated circuit has no `type` field — the
 * contract is title, supplyVoltage and components — but the chat thread read
 * `circuit.type.replaceAll(...)` unguarded, left over from a pipeline that
 * happened to emit one. React unmounted the entire tree, the window went white,
 * and the work in progress looked lost.
 *
 * A white screen is the worst possible failure here: it destroys trust in a
 * board the user may have waited two minutes for, and it hides the error that
 * would explain it. Showing the message and offering a reload is strictly
 * better, and chats live in localStorage so a reload keeps them.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the component stack in the console — it is what identifies the
    // offending render, and it is otherwise swallowed by the boundary.
    console.error('Render failed:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h1>Something broke while drawing this page</h1>
        <p>
          Your chats are saved locally, so reloading keeps them. If a circuit was
          being generated it is still running — it finishes on the server and the
          board is written to its run folder either way.
        </p>
        <pre>{String(error?.message || error)}</pre>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
