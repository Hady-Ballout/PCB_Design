// Light/dark theme selection. The chosen theme lives on <html data-theme="…">
// (which the stylesheets key their palettes off), persists in localStorage,
// and falls back to the OS color-scheme preference until the user picks one.
// index.html runs the same resolution inline before first paint so a saved
// dark theme never flashes light.
export const THEME_STORAGE_KEY = 'pcb_theme';
export const THEMES = ['light', 'dark'];

// Meta theme-color per palette, kept in sync with --color-page in styles.css.
const PAGE_COLORS = { light: '#faf3e8', dark: '#171512' };

export function systemTheme(matchMedia = globalThis.matchMedia) {
  try {
    return matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function loadTheme(storage = globalThis.localStorage, matchMedia = globalThis.matchMedia) {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch {
    // Storage unavailable (private mode, blocked cookies) — use the OS preference.
  }
  return systemTheme(matchMedia);
}

export function saveTheme(theme, storage = globalThis.localStorage) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme still applies for this session even when it can't persist.
  }
}

export function applyTheme(theme, doc = globalThis.document) {
  if (!doc) return;
  doc.documentElement.dataset.theme = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', PAGE_COLORS[theme] || PAGE_COLORS.light);
}
