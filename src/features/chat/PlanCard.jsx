import React from 'react';

// "Build this" action rendered inside a Plan-mode assistant message. The plan
// status lives on the message itself (persisted with the chat), so the card
// freezes in place once the plan has been built.
export function PlanCard({ message, disabled, onBuild }) {
  const proposed = message.plan.status === 'proposed';

  return (
    <div className={`plan-card ${proposed ? '' : 'resolved'}`}>
      {proposed ? (
        <div className="plan-actions">
          <button className="plan-build" type="button" disabled={disabled} onClick={onBuild}>
            Build this
          </button>
          <small>Runs circuit generation using this plan.</small>
        </div>
      ) : (
        <p className="plan-resolved-note">Plan built.</p>
      )}
    </div>
  );
}
