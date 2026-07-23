import React, { useState } from 'react';

// Per-question free-text answer. Kept as its own component so each question
// owns its draft text; committing hands the value up and clears the field.
function CustomAnswerInput({ disabled, onCommit }) {
  const [text, setText] = useState('');

  const commit = () => {
    const answer = text.trim();
    if (!answer) return;
    onCommit(answer);
    setText('');
  };

  return (
    <div className="clarify-custom">
      <input
        type="text"
        value={text}
        maxLength={200}
        disabled={disabled}
        placeholder="Or type your own..."
        aria-label="Type a custom answer"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
      />
      <button type="button" disabled={disabled || !text.trim()} onClick={commit}>
        Use
      </button>
    </div>
  );
}

// Clarifying-question round rendered inside an assistant chat message.
// Answers live on the message itself (persisted with the chat), so the card
// freezes in place once the round is answered or skipped.
export function ClarificationCard({ message, disabled, onAnswer, onSubmit, onSkip }) {
  const { questions, answers, status } = message.clarification;
  const pending = status === 'pending';
  const locked = disabled || !pending;

  return (
    <div className={`clarify-card ${pending ? '' : 'resolved'}`}>
      {questions.map((question) => {
        const selected = answers[question.id] || '';
        const isCustomAnswer = Boolean(selected) && !question.options.includes(selected);
        return (
          <div className="clarify-question" key={question.id}>
            <p>{question.question}</p>
            <div className="clarify-chips">
              {question.options.map((option) => (
                <button
                  className={`clarify-chip ${selected === option ? 'selected' : ''}`}
                  key={option}
                  type="button"
                  disabled={locked}
                  aria-pressed={selected === option}
                  onClick={() => onAnswer(question.id, option)}
                >
                  {option}
                </button>
              ))}
              {isCustomAnswer && (
                <button className="clarify-chip selected" type="button" disabled aria-pressed="true">
                  {selected}
                </button>
              )}
            </div>
            {pending && (
              <CustomAnswerInput
                disabled={disabled}
                onCommit={(answer) => onAnswer(question.id, answer)}
              />
            )}
          </div>
        );
      })}
      {pending ? (
        <div className="clarify-actions">
          <button className="clarify-submit" type="button" disabled={disabled} onClick={onSubmit}>
            Generate circuit
          </button>
          <button className="clarify-skip" type="button" disabled={disabled} onClick={onSkip}>
            Skip questions
          </button>
          <small>Unanswered questions use "No preference".</small>
        </div>
      ) : (
        <p className="clarify-resolved-note">
          {status === 'skipped' ? 'Questions skipped.' : 'Answers submitted.'}
        </p>
      )}
    </div>
  );
}
