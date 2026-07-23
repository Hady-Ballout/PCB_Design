// Issues banner for the realistic breadboard view: functional design-rule
// findings from the AI generation pass (topology rule engine + ERC) plus
// board-level integrity problems from the placement engine. Errors mean the
// circuit likely won't behave as intended even though it renders cleanly —
// exactly the class of problem a wiring-continuity check cannot see.

const SEVERITY_LABEL = {
  error: 'Needs attention',
  warning: 'Warning',
  fixed: 'Auto-fixed',
};

const normalizeIssue = (issue) => {
  if (typeof issue === 'string') return { severity: 'warning', message: issue, fix: '' };
  return {
    severity: issue.autoFixed ? 'fixed' : (issue.severity === 'error' ? 'error' : 'warning'),
    message: String(issue.message || ''),
    fix: String(issue.fix || ''),
  };
};

const SEVERITY_ORDER = { error: 0, warning: 1, fixed: 2 };

export function IssuesPanel({ issues = [], boardIssues = [] }) {
  const rows = [...issues, ...boardIssues]
    .map(normalizeIssue)
    .filter((issue) => issue.message)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  if (!rows.length) return null;

  const errorCount = rows.filter((issue) => issue.severity === 'error').length;
  const summary = errorCount
    ? `${errorCount} design issue${errorCount === 1 ? '' : 's'} need attention`
    : `${rows.length} note${rows.length === 1 ? '' : 's'} about this build`;

  return (
    <details className={`rs-issues ${errorCount ? 'rs-issues-has-errors' : ''}`} open={errorCount > 0}>
      <summary className="rs-issues-summary">{summary}</summary>
      <ul className="rs-issues-list">
        {rows.map((issue, index) => (
          <li key={`${issue.severity}-${index}-${issue.message.slice(0, 40)}`} className={`rs-issue rs-issue-${issue.severity}`}>
            <span className="rs-issue-tag">{SEVERITY_LABEL[issue.severity]}</span>
            <span className="rs-issue-body">
              {issue.message}
              {issue.fix ? <span className="rs-issue-fix"> Fix: {issue.fix}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
