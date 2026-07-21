// Hash-based page routing shared by the app shell.
export const AUTH_PAGES = new Set(['login', 'signup']);
export const PUBLIC_PAGES = new Set(['home', 'login', 'signup', 'verify', 'pricing']);

export const pageFromHash = () => {
  const hash = window.location.hash;
  if (hash.startsWith('#verify')) return 'verify';
  if (hash === '#home') return 'home';
  if (hash === '#login') return 'login';
  if (hash === '#signup') return 'signup';
  if (hash === '#waveform') return 'waveform';
  if (hash === '#pricing') return 'pricing';
  // '#billing=success' / '#billing=cancel' are Stripe checkout return URLs;
  // they land on the workspace, which reads and clears the flag.
  return 'workspace';
};
