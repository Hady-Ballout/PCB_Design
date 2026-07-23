import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIST_SCHEMA,
  ASK_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  buildAssistRequestBody,
  cleanAssistReply,
  generateAssistReply,
  sanitizeAssistHistory,
} from './assistProvider.js';

const assistContent = JSON.stringify({ reply: 'Use a 555 timer.\n- R1 10k\n- C1 10uF' });

const ollamaResponse = (content: string) => new Response(
  JSON.stringify({ message: { content } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const currentDesign = {
  circuit: {
    title: 'RC Filter',
    type: 'low_pass',
    supplyVoltage: 5,
    nodes: ['IN', 'OUT', '0'],
    components: [{ ref: 'R1', kind: 'resistor', value: '1k', nodes: ['IN', 'OUT'], footprint: '' }],
    notes: [],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('assist schema', () => {
  it('constrains the model to a single reply string', () => {
    expect(ASSIST_SCHEMA.required).toEqual(['reply']);
    expect(ASSIST_SCHEMA.properties.reply.type).toBe('string');
  });
});

describe('buildAssistRequestBody', () => {
  it('sends a non-streaming request with the plan prompt and a 1024-token budget', () => {
    const body = buildAssistRequestBody('plan', 'blink an LED', []);
    expect(body.stream).toBe(false);
    expect(body.format).toBe(ASSIST_SCHEMA);
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(1024);
    expect(body.messages[0]).toEqual({ role: 'system', content: PLAN_SYSTEM_PROMPT });
    expect(PLAN_SYSTEM_PROMPT).toContain('buildable component kinds');
    expect(PLAN_SYSTEM_PROMPT).toContain('resistor');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Circuit request to plan: blink an LED' });
  });

  it('uses the ask prompt and question framing in ask mode', () => {
    const body = buildAssistRequestBody('ask', 'why is R1 1k?', []);
    expect(body.messages[0]).toEqual({ role: 'system', content: ASK_SYSTEM_PROMPT });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Question: why is R1 1k?' });
  });

  it('includes the knowledge base for plan mode only', () => {
    const planContents = buildAssistRequestBody('plan', 'blink an LED', []).messages.map((m) => m.content);
    const askContents = buildAssistRequestBody('ask', 'why?', []).messages.map((m) => m.content);
    const knowledgeMarker = 'Additional circuit design rules';
    expect(planContents.some((content) => content.includes(knowledgeMarker))).toBe(true);
    expect(askContents.some((content) => content.includes(knowledgeMarker))).toBe(false);
  });

  it('describes the current design, with full circuit JSON only for ask', () => {
    const planBody = buildAssistRequestBody('plan', 'make it slower', [], currentDesign as never);
    const planTurn = planBody.messages.find((m) => m.content.includes('existing design'));
    expect(planTurn?.content).toContain('RC Filter');
    expect(planTurn?.content).toContain('plan for an edit');
    expect(planTurn?.content).not.toContain('"nodes":["IN","OUT","0"]');

    const askBody = buildAssistRequestBody('ask', 'why is R1 1k?', [], currentDesign as never);
    const askTurn = askBody.messages.find((m) => m.content.includes('existing design'));
    expect(askTurn?.content).toContain('"nodes":["IN","OUT","0"]');
  });

  it('includes chat memory and keeps assistant text turns in history', () => {
    const history = [
      { role: 'user' as const, content: 'Make a filter' },
      { role: 'assistant' as const, content: 'Here is a plan: use an RC pair.' },
      { role: 'assistant' as const, content: 'Ready', circuit: { title: 'Filter' } as never },
    ];
    const body = buildAssistRequestBody('ask', 'and now?', history, null, { summary: 'Uses 5V rail.', updatedAt: 1 });
    const contents = body.messages.map((m) => m.content);
    expect(contents.some((content) => content.includes('Active chat memory:'))).toBe(true);
    expect(contents.some((content) => content.includes('use an RC pair'))).toBe(true);
    expect(contents.some((content) => content.includes('Confirmed circuit:'))).toBe(true);
  });
});

describe('sanitizeAssistHistory', () => {
  it('keeps user and assistant turns, folding circuits into a compact summary', () => {
    const history = sanitizeAssistHistory([
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Plan text' },
      { role: 'assistant', content: 'Built', circuit: { title: 'Filter' } },
      { role: 'system', content: 'should drop' },
      { role: 'assistant', content: '' },
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Plan text' },
      { role: 'assistant', content: 'Confirmed circuit: {"title":"Filter"}' },
    ]);
  });

  it('caps history length and returns [] on garbage', () => {
    const long = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
    expect(sanitizeAssistHistory(long)).toHaveLength(12);
    expect(sanitizeAssistHistory(null)).toEqual([]);
  });
});

describe('cleanAssistReply', () => {
  it('preserves newlines, normalizes CRLF, trims, and caps length', () => {
    expect(cleanAssistReply('  line one\r\n- bullet  ')).toBe('line one\n- bullet');
    expect(cleanAssistReply('x'.repeat(9000))).toHaveLength(8000);
    expect(cleanAssistReply(null)).toBe('');
  });
});

describe('generateAssistReply', () => {
  it('parses the reply from an Ollama response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse(assistContent));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateAssistReply('plan', 'blink an LED');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mode: 'plan', reply: 'Use a 555 timer.\n- R1 10k\n- C1 10uF' });
  });

  it('falls back to raw text when the content is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse('Just use a bigger resistor.')));
    const result = await generateAssistReply('ask', 'how to dim the LED?');
    expect(result.reply).toBe('Just use a bigger resistor.');
  });

  it('throws without retrying on provider errors and empty replies', async () => {
    const failing = vi.fn().mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', failing);
    await expect(generateAssistReply('plan', 'blink an LED')).rejects.toThrow('Ollama returned 500');
    expect(failing).toHaveBeenCalledTimes(1);

    const empty = vi.fn().mockResolvedValue(ollamaResponse(JSON.stringify({ reply: '' })));
    vi.stubGlobal('fetch', empty);
    await expect(generateAssistReply('plan', 'blink an LED')).rejects.toThrow('empty reply');
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it('reads the OpenAI-compatible provider branch', async () => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_API_URL', 'https://api.example.com/v1');
    vi.stubEnv('AI_MODEL', 'test-model');
    vi.stubEnv('AI_API_KEY', 'key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: assistContent } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateAssistReply('ask', 'why?');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(result.mode).toBe('ask');
  });

  it('streams reasoning tokens to onThinking on the OpenAI-compatible branch', async () => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_API_URL', 'https://api.example.com/v1');
    vi.stubEnv('AI_MODEL', 'test-model');
    vi.stubEnv('AI_API_KEY', 'key');
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'A 555 timer fits. ' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Checking values.' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: assistContent } }] })}`,
      'data: [DONE]',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      `${sse}\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onThinking = vi.fn();

    const result = await generateAssistReply('plan', 'blink an LED', [], null, null, onThinking);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    expect(onThinking.mock.calls.map(([delta]) => delta)).toEqual(['A 555 timer fits. ', 'Checking values.']);
    expect(result.reply).toBe('Use a 555 timer.\n- R1 10k\n- C1 10uF');
  });
});
