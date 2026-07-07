// Shared browser download helper used by the waveform, editor, and chat features.
export const downloadText = (filename, text, mime = 'text/plain') => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Firefox/Safari require the anchor in the DOM and can abort the download if
  // the object URL is revoked before the browser has fetched the blob.
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
