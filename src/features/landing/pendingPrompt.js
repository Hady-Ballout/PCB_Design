// Hands the landing-page prompt across the sign-up wall: the hero stashes it
// here, and the workspace drains it into the chat draft on its first mount.
// sessionStorage so an abandoned prompt does not outlive the tab.
export const PENDING_PROMPT_KEY = 'impedo_pending_prompt';

const defaultStorage = () => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export function stashPendingPrompt(text, storage = defaultStorage()) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;
  try {
    storage?.setItem(PENDING_PROMPT_KEY, trimmed);
  } catch {
    // Storage blocked: the prompt is simply not carried over.
  }
}

export function takePendingPrompt(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(PENDING_PROMPT_KEY) ?? '';
    if (value) storage.removeItem(PENDING_PROMPT_KEY);
    return String(value);
  } catch {
    return '';
  }
}
