// Tokens and money.
//
// The unit that matters is the *request* — one API round trip, one assistant
// message. A run is a sum of requests, and the interesting question ("what does
// a board of this size cost?") is that sum divided by something about the board.
//
// Cost is always recomputed from stored token counts, never stored as a number.
// That way correcting pricing.json reprices every past run instead of leaving a
// pile of figures computed under rates you no longer believe.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandboxDir = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ input:number, output:number, cacheRead:number, cacheWrite:number }} Usage */

export const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const loadPricing = (file = resolve(sandboxDir, 'pricing.json')) =>
  JSON.parse(readFileSync(file, 'utf8'));

/**
 * Rates for a model id. Longest matching prefix wins, so `deepseek-v4-pro[1m]`
 * resolves through `deepseek-v4-pro` without needing an entry per context-window
 * variant, and an unknown model falls back rather than silently costing zero.
 */
export const ratesFor = (model, pricing) => {
  const models = pricing.models || {};
  const key = Object.keys(models)
    .filter((candidate) => candidate !== 'default' && String(model || '').startsWith(candidate))
    .sort((a, b) => b.length - a.length)[0];
  return { ...(models[key] || models.default), model: key || 'default', matched: Boolean(key) };
};

/**
 * Normalize the SDK's snake_case usage into our four numbers.
 *
 * The SDK reports `input_tokens` as *fresh* input, with cache hits counted
 * separately — they are not a subset. Adding them gives the real prompt size.
 */
export const normalizeUsage = (usage) => (usage ? {
  input: usage.input_tokens ?? usage.inputTokens ?? 0,
  output: usage.output_tokens ?? usage.outputTokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0,
  cacheWrite: usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0,
} : { ...EMPTY_USAGE });

export const addUsage = (a, b) => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export const sumUsage = (list) => list.reduce(addUsage, { ...EMPTY_USAGE });

/** Every token that entered the model, cached or not. */
export const promptTokens = (usage) => usage.input + usage.cacheRead + usage.cacheWrite;
export const totalTokens = (usage) => promptTokens(usage) + usage.output;

/** @returns {number} USD */
export const costOf = (usage, rates) =>
  (usage.input * rates.input
    + usage.output * rates.output
    + usage.cacheRead * rates.cacheRead
    + usage.cacheWrite * rates.cacheWrite) / 1e6;

/**
 * Price a run's per-model usage.
 *
 * Runs are not single-model: the SDK uses a small model for side work
 * (titles, summaries) alongside the one doing the design, and they can bill at
 * different rates. Keeping the split means a cheap model doing lots of tokens
 * cannot be mistaken for the expensive one.
 *
 * @param {Record<string, Usage>} byModel
 * @returns {{ total:number, usage:Usage, models:Array<object> }}
 */
export const priceRun = (byModel, pricing) => {
  const models = Object.entries(byModel || {}).map(([model, usage]) => {
    const rates = ratesFor(model, pricing);
    return { model, usage, rates, cost: costOf(usage, rates) };
  });
  return {
    total: models.reduce((sum, entry) => sum + entry.cost, 0),
    usage: sumUsage(models.map((entry) => entry.usage)),
    models: models.sort((a, b) => b.cost - a.cost),
  };
};

// ------------------------------------------------------------------ shaping

/** Board facts worth correlating cost against. */
export const boardMetrics = (verify) => {
  const board = verify?.board;
  return {
    components: verify?.componentCount ?? 0,
    areaCm2: board ? (board.width * board.height) / 100 : 0,
    traces: verify?.traces ?? 0,
    vias: verify?.vias ?? 0,
    size: board ? `${board.width}x${board.height}mm` : '',
  };
};

/**
 * One row per run: what was built, what it took, what it cost.
 *
 * @param {object} record a session.json
 */
export const runRow = (record, pricing) => {
  const priced = priceRun(record.usageByModel, pricing);
  const metrics = boardMetrics(record.verify);
  const requests = record.requests?.length ?? 0;
  return {
    id: record.id,
    status: record.status,
    prompt: record.prompt,
    pass: Boolean(record.verify?.pass),
    requests,
    turns: record.totals?.turns ?? 0,
    ...metrics,
    ...priced.usage,
    tokens: totalTokens(priced.usage),
    cost: priced.total,
    reportedCost: record.totals?.costUsd ?? 0,
    models: priced.models,
    costPerComponent: metrics.components ? priced.total / metrics.components : 0,
    costPerCm2: metrics.areaCm2 ? priced.total / metrics.areaCm2 : 0,
  };
};

// ---------------------------------------------------------------- rendering

export const money = (value) => `$${value < 0.01 && value > 0 ? value.toFixed(5) : value.toFixed(4)}`;
export const thousands = (value) => value.toLocaleString('en-US');

export const compact = (value) => {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
};

/**
 * Fixed-width table. Numeric columns right-align so magnitudes line up — the
 * whole point of the report is noticing that one column is ten times another.
 */
export const table = (headers, rows, align = []) => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column] ?? '').length)));
  const line = (cells) => cells
    .map((cell, column) => (align[column] === 'r'
      ? String(cell ?? '').padStart(widths[column])
      : String(cell ?? '').padEnd(widths[column])))
    .join('  ')
    .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
};
