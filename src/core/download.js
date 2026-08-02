// Shared browser download helper used by the waveform, editor, and chat features.

/**
 * Hands `parts` to the browser as a download. The one subtlety, shared by both
 * exported helpers: Firefox and Safari need the anchor in the DOM, and they
 * abort the download if the object URL is revoked before the blob has been
 * fetched — hence the deferred revoke.
 */
const offerBlob = (filename, parts, mime) => {
  const blob = new Blob(parts, { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const downloadText = (filename, text, mime = 'text/plain') =>
  offerBlob(filename, [text], mime);

/**
 * Binary counterpart of `downloadText`, for output that is bytes rather than
 * characters — the zipped Gerber package. Sending those through `downloadText`
 * would encode them as UTF-8 and corrupt every byte above 0x7f.
 *
 * @param {string} filename
 * @param {Uint8Array | ArrayBuffer | Blob} bytes
 * @param {string} [mime]
 */
export const downloadBlob = (filename, bytes, mime = 'application/octet-stream') =>
  offerBlob(filename, [bytes], mime);
