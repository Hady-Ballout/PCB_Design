// Hash-based page routing shared by the app shell.
export const pageFromHash = () => {
  const hash = window.location.hash;
  if (hash === '' || hash === '#' || hash === '#home') return 'home';
  if (hash === '#waveform') return 'waveform';
  // '#app' and anything unrecognized open the workspace.
  return 'workspace';
};
