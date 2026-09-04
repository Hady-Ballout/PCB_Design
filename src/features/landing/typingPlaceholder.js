// The hero prompt's self-typing placeholder. Given the example builds and the
// elapsed time, return the text to show: each example is typed one character
// per `typeMs`, held for `holdMs`, erased one character per `eraseMs`, then
// the next example starts. Pure so the cycle is testable without timers.
export const DEFAULT_TYPING = { typeMs: 45, holdMs: 1800, eraseMs: 18 };

const cycleLength = (text, { typeMs, holdMs, eraseMs }) =>
  text.length * typeMs + holdMs + text.length * eraseMs;

export function placeholderAt(examples, elapsedMs, opts = DEFAULT_TYPING) {
  if (!examples?.length) return '';
  const total = examples.reduce((sum, text) => sum + cycleLength(text, opts), 0);
  if (total <= 0) return examples[0];

  let t = ((elapsedMs % total) + total) % total;
  for (const text of examples) {
    const length = cycleLength(text, opts);
    if (t >= length) {
      t -= length;
      continue;
    }
    const typed = text.length * opts.typeMs;
    if (t < typed) return text.slice(0, Math.floor(t / opts.typeMs));
    if (t < typed + opts.holdMs) return text;
    const erased = Math.floor((t - typed - opts.holdMs) / opts.eraseMs);
    return text.slice(0, Math.max(0, text.length - erased));
  }
  return '';
}
