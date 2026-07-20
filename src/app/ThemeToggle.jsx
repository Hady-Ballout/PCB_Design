import React from 'react';

// Sun/moon switch between the light and dark palettes. Rendered inside the
// workspace user bar, and as a fixed floating chip on the pages that have no
// user bar (home, auth, waveform).
export function ThemeToggle({ theme, onToggle, floating = false }) {
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      className={`theme-toggle ${floating ? 'theme-toggle-floating' : ''}`}
      onClick={onToggle}
      aria-pressed={dark}
      aria-label={label}
      title={label}
    >
      {dark ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M13.5 9.8A5.7 5.7 0 0 1 6.2 2.5a5.7 5.7 0 1 0 7.3 7.3Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
