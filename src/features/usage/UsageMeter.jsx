import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../core/config.js';
import './usageMeter.css';

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function toneFor(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'ok';
}

// "in 5h 23m" until the daily allowance resets (00:00 UTC).
function formatCountdown(resetsAt) {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'shortly';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${Math.max(1, minutes)}m`;
}

// Compact daily-token usage indicator: a ring that fills as the allowance is
// spent and opens a popover with the exact numbers and reset time. Fetches
// /api/usage/daily on mount and whenever `refreshKey` changes (bumped after
// each AI call so the ring reflects the latest spend).
export function UsageMeter({ refreshKey = 0 }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [, forceTick] = useState(0);
  const containerRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem('pcb_token');
    if (!token) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/api/usage/daily`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (!cancelled && data) setStatus(data); })
      .catch(() => { /* transient: keep the last known status */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Keep the countdown honest while the popover is open.
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [open]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!status) return null;

  const percent = status.percentUsed;
  const tone = toneFor(percent);
  const filled = (Math.min(100, percent) / 100) * CIRCUMFERENCE;

  return (
    <div className="usage-meter" ref={containerRef}>
      <button
        type="button"
        className={`usage-ring tone-${tone}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Daily AI usage: ${percent}% used`}
        aria-expanded={open}
        title="Daily AI usage"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle className="usage-ring-track" cx="12" cy="12" r={RADIUS} />
          <circle
            className="usage-ring-fill"
            cx="12"
            cy="12"
            r={RADIUS}
            strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            transform="rotate(-90 12 12)"
          />
        </svg>
      </button>

      {open && (
        <div className="usage-popover" role="dialog" aria-label="Daily AI usage">
          <div className="usage-popover-head">Daily AI usage</div>
          <div className="usage-popover-track">
            <span className={`usage-popover-bar tone-${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <div className="usage-popover-percent"><strong>{percent}%</strong> used</div>
          <div className="usage-popover-sub">
            {status.used.toLocaleString()} / {status.limit.toLocaleString()} tokens
          </div>
          <div className="usage-popover-sub">Resets {formatCountdown(status.resetsAt)} (00:00 UTC)</div>
        </div>
      )}
    </div>
  );
}
