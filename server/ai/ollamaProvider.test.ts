import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIRCUIT_SCHEMA,
  REPLY_RESPONSE_SCHEMA,
  REVIEWER_RESPONSE_SCHEMA,
  STAGE1_RESPONSE_SCHEMA,
  runCircuitPipeline,
} from './ollamaProvider.js';

const validCircuit = {
  title: 'RC Filter',
  type: 'low_pass',
  supplyVoltage: 5,
  nodes: ['IN', 'OUT', '0'],
  components: [
    {
      ref: 'R1',
      kind: 'resistor',
      value: '1k',
      nodes: ['IN', 'OUT'],
      footprint: 'Resistor_THT:R_Axial',
    },
  ],
  notes: [],
};

const opampCircuit = {
  title: 'Op Amp Buffer',
  type: 'opamp_buffer',
  supplyVoltage: 5,
  nodes: ['VINP', 'VINN', 'VOUT', 'VCC', '0'],
  components: [
    {
      ref: 'XU1',
      kind: 'opamp',
      value: 'LM358',
      nodes: ['VINP', 'VINN', 'VOUT', 'VCC', '0'],
      footprint: 'Package_DIP:DIP-8_W7.62mm',
    },
  ],
  notes: [],
};

// Ollama's streaming NDJSON response shape (used only by the stage-1 circuit call).
const streamResponse = (content: string) => new Response(
  `${JSON.stringify({ message: { content } })}\n`,
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
);

// Ollama's non-streaming response shape (used by the stage-2/stage-3 calls).
const ollamaResponse = (content: string) => new Response(
  JSON.stringify({ message: { content } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const openAiResponse = (content: string | unknown[]) => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const okReviewer = () => ollamaResponse(JSON.stringify({ ok: true }));
const okReply = (reply = 'Here is the circuit.') => ollamaResponse(JSON.stringify({ reply }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('circuit generation pipeline', () => {
  it('runs circuit, reviewer, and reply as three separate calls and returns the final circuit + reply', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply('I built an RC filter with R1 between IN and OUT.'));
    vi.stubGlobal('fetch', fetchMock);

    const onEvent = vi.fn();
    const result = await runCircuitPipeline('Make an RC filter', [], null, null, onEvent);

    expect(result).toEqual({ reply: 'I built an RC filter with R1 between IN and OUT.', circuit: validCircuit });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const stage1Body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(stage1Body.format).toEqual(STAGE1_RESPONSE_SCHEMA);
    expect(stage1Body.format.properties.circuit).toEqual(CIRCUIT_SCHEMA);
    expect(stage1Body.messages[0].content).toContain('opamp components must use value LM358');
    expect(stage1Body.messages[0].content).not.toContain('SPICE netlist must use the exact same component refs');

    const stage2Body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stage2Body.format).toEqual(REVIEWER_RESPONSE_SCHEMA);
    expect(stage2Body.messages.at(-1).content).toContain('R1');

    const stage3Body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(stage3Body.format).toEqual(REPLY_RESPONSE_SCHEMA);
    expect(stage3Body.messages.at(-1).content).toContain('Make an RC filter');

    const stageEvents = onEvent.mock.calls.map((call) => call[0]).filter((event) => event.type === 'stage');
    expect(stageEvents.map((event) => event.stage)).toEqual(['circuit', 'reviewing', 'reply']);
    expect(onEvent.mock.calls.some((call) => call[0].type === 'content' && call[0].stage === 'circuit')).toBe(true);
  });

  it('applies the reviewer correction and passes its issues to the reply stage', async () => {
    const correctedCircuit = {
      ...validCircuit,
      components: [{ ...validCircuit.components[0], value: '2.2k' }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(ollamaResponse(JSON.stringify({
        ok: false,
        issues: ['R1 value was implausibly low for the stated filter corner'],
        circuit: correctedCircuit,
      })))
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', [], null, null);

    expect(result.circuit).toEqual(correctedCircuit);
    const stage3Body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(stage3Body.messages.at(-1).content).toContain('R1 value was implausibly low');
  });

  it('skips the reviewer stage entirely when AI_PIPELINE_REVIEWER=0', async () => {
    vi.stubEnv('AI_PIPELINE_REVIEWER', '0');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const onEvent = vi.fn();
    const result = await runCircuitPipeline('Make an RC filter', [], null, null, onEvent);

    expect(result.circuit).toEqual(validCircuit);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stageEvents = onEvent.mock.calls.map((call) => call[0]).filter((event) => event.type === 'stage');
    expect(stageEvents.map((event) => event.stage)).toEqual(['circuit', 'reply']);
  });

  it('keeps the stage-1 circuit and continues when the reviewer never returns a usable response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(ollamaResponse('{"ok": broken'))
      .mockResolvedValueOnce(ollamaResponse('{"ok": stillBroken'))
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', [], null, null);

    expect(result.circuit).toEqual(validCircuit);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('falls back to an empty reply when the reply stage never returns a usable response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(ollamaResponse('not json'))
      .mockResolvedValueOnce(ollamaResponse('still not json'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', [], null, null);

    expect(result.reply).toBe('');
    expect(result.circuit).toEqual(validCircuit);
  });

  it('retries stage 1 once with corrective context on malformed JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"circuit": broken'))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', []);

    expect(result.circuit).toEqual(validCircuit);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('previous response was rejected');
    expect(retryBody.messages.at(-1).content).toContain('top-level "circuit" field');
  });

  it('retries stage 1 once when an op-amp input is left floating', async () => {
    const floatingCircuit = {
      ...opampCircuit,
      components: [{ ...opampCircuit.components[0], nodes: ['VINP', 'ORPHAN', 'VOUT', 'VCC', '0'] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: floatingCircuit })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: opampCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an op amp buffer', []);

    expect(result.circuit).toEqual(opampCircuit);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('Floating op-amp input');
  });

  it('reports a classified error after stage 1 fails schema validation twice', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ title: 'Incomplete' })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ title: 'Still incomplete' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCircuitPipeline('Make a filter', [])).rejects.toMatchObject({
      code: 'schema_validation',
      message: expect.stringContaining('failed after one automatic correction attempt'),
    });
  });

  it('normalizes generic op amp aliases to the canonical LM358 model', async () => {
    // A lone op amp with no feedback network trips the floating-input heuristic on the
    // first attempt (its inputs are only ever used once), so stage 1 retries once before
    // being accepted; the retry response is the same circuit the model already returned.
    const genericOpampCircuit = { ...opampCircuit, components: [{ ...opampCircuit.components[0], value: 'GENERIC' }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: genericOpampCircuit })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: genericOpampCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an op amp buffer', []);

    expect(result.circuit.components.find((part) => part.ref === 'XU1')!.value).toBe('LM358');
  });

  it('uses distinct per-stage models when configured, falling back to AI_MODEL otherwise', async () => {
    vi.stubEnv('AI_PROVIDER', 'groq');
    vi.stubEnv('AI_API_URL', 'https://api.groq.com/openai/v1');
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('AI_MODEL', 'llama-3.3-70b-versatile');
    vi.stubEnv('AI_MODEL_REVIEWER', 'openai/gpt-oss-120b');
    vi.stubEnv('AI_MODEL_REPLY', 'openai/gpt-oss-20b');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ reply: 'Done.' })));
    vi.stubGlobal('fetch', fetchMock);

    await runCircuitPipeline('Make an RC filter', []);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('llama-3.3-70b-versatile');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('openai/gpt-oss-120b');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).model).toBe('openai/gpt-oss-20b');
  });

  it('works end-to-end through an OpenAI-compatible provider for all three stages', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(openAiResponse(JSON.stringify({ reply: 'Built it.' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', []);

    expect(result).toEqual({ reply: 'Built it.', circuit: validCircuit });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mock.calls.forEach((call) => {
      expect(call[0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
      expect(call[1].headers).toMatchObject({ Authorization: 'Bearer test-key' });
    });
    const stage1Body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(stage1Body).toMatchObject({
      model: 'glm-5.2',
      max_tokens: 12000,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    });
  });

  it('reports length-stopped output as a max-tokens budget problem', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: { content: '', reasoning_content: 'The user wants a difference amplifier circuit. '.repeat(20) },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCircuitPipeline('Make a difference amplifier', [])).rejects.toMatchObject({
      code: 'provider_response',
      message: expect.stringContaining('max_tokens was exhausted'),
    });
  });
});
