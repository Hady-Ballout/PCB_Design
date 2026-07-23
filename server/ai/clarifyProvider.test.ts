import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLARIFY_SCHEMA,
  NO_PREFERENCE_OPTION,
  buildClarifyRequestBody,
  generateClarifyingQuestions,
  sanitizeClarifyQuestions,
} from './clarifyProvider.js';

const clarifyContent = JSON.stringify({
  questions: [
    { question: 'What supply powers the LED?', options: ['USB 5V', '9V battery'] },
  ],
});

const ollamaResponse = (content: string) => new Response(
  JSON.stringify({ message: { content } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('clarify schema', () => {
  it('constrains the model to 1-3 questions with 2-4 options each', () => {
    expect(CLARIFY_SCHEMA.required).toEqual(['questions']);
    expect(CLARIFY_SCHEMA.properties.questions.minItems).toBe(1);
    expect(CLARIFY_SCHEMA.properties.questions.maxItems).toBe(3);
    const item = CLARIFY_SCHEMA.properties.questions.items;
    expect(item.required).toEqual(['question', 'options']);
    expect(item.properties.options.minItems).toBe(2);
    expect(item.properties.options.maxItems).toBe(4);
  });
});

describe('buildClarifyRequestBody', () => {
  it('sends a non-streaming grammar-constrained request with a small budget', () => {
    const body = buildClarifyRequestBody('blink an LED', []);
    expect(body.stream).toBe(false);
    expect(body.format).toBe(CLARIFY_SCHEMA);
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(512);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('requirements assistant');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Circuit request: blink an LED' });
  });

  it('includes chat memory and prior user turns but never assistant circuits', () => {
    const history = [
      { role: 'user' as const, content: 'Make a filter' },
      { role: 'assistant' as const, content: 'Ready', circuit: { title: 'Filter' } as never },
    ];
    const body = buildClarifyRequestBody('add a load', history, null, { summary: 'Uses 5V rail.', updatedAt: 1 });

    const contents = body.messages.map((message) => message.content);
    expect(contents.some((content) => content.includes('Active chat memory:'))).toBe(true);
    expect(contents.some((content) => content.includes('Previous circuit request: Make a filter'))).toBe(true);
    expect(contents.some((content) => content.includes('"title":"Filter"'))).toBe(false);
  });

  it('describes the current design when the prompt is a revision', () => {
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
    const body = buildClarifyRequestBody('make it slower', [], currentDesign as never);
    const designTurn = body.messages.find((message) => message.content.includes('editing an existing design'));
    expect(designTurn?.content).toContain('RC Filter');
    expect(designTurn?.content).toContain('R1: resistor');
  });
});

describe('sanitizeClarifyQuestions', () => {
  it('assigns ids, dedupes options, and appends the canonical no-preference option', () => {
    const questions = sanitizeClarifyQuestions({
      questions: [
        { question: '  What supply?  ', options: ['USB 5V', 'usb 5v', ' 9V battery ', 'No preference'] },
        { question: 'Blink rate?', options: ['1 Hz', '2 Hz'] },
      ],
    });

    expect(questions).toEqual([
      { id: 'q1', question: 'What supply?', options: ['USB 5V', '9V battery', NO_PREFERENCE_OPTION] },
      { id: 'q2', question: 'Blink rate?', options: ['1 Hz', '2 Hz', NO_PREFERENCE_OPTION] },
    ]);
  });

  it('caps at 3 questions and 4 model options per question', () => {
    const questions = sanitizeClarifyQuestions({
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `Question ${index + 1}?`,
        options: ['A', 'B', 'C', 'D', 'E', 'F'],
      })),
    });

    expect(questions).toHaveLength(3);
    expect(questions[2].id).toBe('q3');
    // 4 model options + the appended no-preference option
    expect(questions[0].options).toHaveLength(5);
    expect(questions[0].options.at(-1)).toBe(NO_PREFERENCE_OPTION);
  });

  it('drops questions with no concrete options and returns [] on garbage', () => {
    expect(sanitizeClarifyQuestions({
      questions: [
        { question: 'Anything?', options: ['You decide', "Don't care"] },
        { question: '', options: ['A', 'B'] },
        'not-an-object',
      ],
    })).toEqual([]);
    expect(sanitizeClarifyQuestions(null)).toEqual([]);
    expect(sanitizeClarifyQuestions({ questions: 'nope' })).toEqual([]);
  });
});

describe('generateClarifyingQuestions', () => {
  it('parses sanitized questions from an Ollama response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ollamaResponse(clarifyContent));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateClarifyingQuestions('blink an LED');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.questions).toEqual([
      {
        id: 'q1',
        question: 'What supply powers the LED?',
        options: ['USB 5V', '9V battery', NO_PREFERENCE_OPTION],
      },
    ]);
  });

  it('throws without retrying when the provider fails or returns junk', async () => {
    const failing = vi.fn().mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', failing);
    await expect(generateClarifyingQuestions('blink an LED')).rejects.toThrow('Ollama returned 500');
    expect(failing).toHaveBeenCalledTimes(1);

    const junk = vi.fn().mockResolvedValue(ollamaResponse('no json here'));
    vi.stubGlobal('fetch', junk);
    await expect(generateClarifyingQuestions('blink an LED')).rejects.toThrow('complete JSON object');
    expect(junk).toHaveBeenCalledTimes(1);
  });

  it('reads the OpenAI-compatible provider branch', async () => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_API_URL', 'https://api.example.com/v1');
    vi.stubEnv('AI_MODEL', 'test-model');
    vi.stubEnv('AI_API_KEY', 'key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: clarifyContent } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateClarifyingQuestions('blink an LED');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(result.questions[0].options.at(-1)).toBe(NO_PREFERENCE_OPTION);
  });
});
