import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIRCUIT_SCHEMA,
  buildOllamaRequestBody,
  parseCircuitResponse,
  streamCircuitWithOllama,
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

const streamResponse = (content) => new Response(
  `${JSON.stringify({ message: { content } })}\n`,
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ollama circuit output', () => {
  it('requests schema-constrained deterministic output with a larger context window', () => {
    const body = buildOllamaRequestBody('Make an RC filter', [], true);

    expect(body.format).toEqual(CIRCUIT_SCHEMA);
    expect(body.options).toMatchObject({ num_ctx: 8192, num_predict: 2400, temperature: 0 });
  });

  it('orders memory, canonical design, recent turns, and the new request', () => {
    const history = Array.from({ length: 15 }, (_, index) => ({
      role: 'user',
      content: `Requirement ${index + 1}`,
    }));
    const body = buildOllamaRequestBody(
      'Change R1 to 2.2k',
      history,
      true,
      { circuit: validCircuit, spice: 'R1 IN OUT 1k', kicadNetlist: '<export />' },
      { summary: 'Use through-hole parts and keep the output node named OUT.', updatedAt: 10 },
    );

    expect(body.messages[1].content).toContain('Active chat memory');
    expect(body.messages[2].content).toContain('exact canonical current design');
    expect(body.messages[3].content).toContain('Requirement 4');
    expect(body.messages.at(-1).content).toContain('Change R1 to 2.2k');
    expect(body.messages.at(-1).content).toContain('Replace the whole circuit only');
    expect(body.messages.filter((message) => message.content.includes('Previous circuit request'))).toHaveLength(12);
  });

  it('does not attach memory or revision context to a new chat', () => {
    const body = buildOllamaRequestBody('Make a new filter', [], true, null, null);

    expect(body.messages).toHaveLength(2);
    expect(body.messages.some((message) => message.content.includes('Active chat memory'))).toBe(false);
    expect(body.messages.some((message) => message.content.includes('canonical current design'))).toBe(false);
  });

  it('classifies malformed and schema-invalid responses', () => {
    expect(() => parseCircuitResponse('{"title": broken}')).toThrowError(
      expect.objectContaining({ code: 'json_syntax' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ title: 'Incomplete' }))).toThrowError(
      expect.objectContaining({ code: 'schema_validation' }),
    );
  });

  it('retries a malformed stream once with corrective context', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"title": broken}'))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validCircuit)));
    const onContent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter', [], null, onContent)).resolves.toEqual(validCircuit);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.format).toEqual(CIRCUIT_SCHEMA);
    expect(retryBody.messages.at(-1).content).toContain('previous response was rejected');
    expect(onContent).toHaveBeenLastCalledWith(
      JSON.stringify(validCircuit),
      expect.objectContaining({ attempt: 1, correcting: true }),
    );
  });

  it('reports a classified error after the correction attempt also fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"title": broken}'))
      .mockResolvedValueOnce(streamResponse('{"title": stillBroken}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make a filter')).rejects.toMatchObject({
      code: 'json_syntax',
      message: expect.stringContaining('after one automatic correction attempt'),
    });
  });
});
