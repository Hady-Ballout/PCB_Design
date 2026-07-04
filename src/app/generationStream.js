// Parsing helpers for the streaming circuit-generation response.
export const readGenerationStream = async (response, onEvent) => {
  if (!response.body) throw new Error('Generation response could not be streamed.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let completed = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      const error = new Error(event.error || 'Circuit generation failed.');
      error.code = event.code;
      throw error;
    }
    onEvent(event);
    if (event.type === 'complete') completed = event.data;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffered.trim()) consumeLine(buffered);
  if (!completed) throw new Error('Generation ended before the final circuit was returned.');
  return completed;
};

export const markSpiceAsProvisional = (spice, correcting = false) => {
  const label = correcting
    ? '* Unconfirmed AI preview - correcting an invalid model response'
    : '* Unconfirmed AI preview - generation is still in progress';
  return `${label}\n${String(spice || '')}`;
};
