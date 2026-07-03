import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_RESPONSE_SCHEMA,
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

const validAiResponse = {
  reply: 'I built an RC filter with R1 between IN and OUT.',
  circuit: validCircuit,
  spice: '* RC Filter\nR1 IN OUT 1k\n.end',
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

const sourceCircuit = {
  title: 'Source Test',
  type: 'source_test',
  supplyVoltage: 5,
  nodes: ['VIN', '0'],
  components: [
    {
      ref: 'V1',
      kind: 'voltage_source',
      value: '1V',
      nodes: ['VIN', '0'],
      footprint: '',
    },
  ],
  notes: [],
};

const circuitWithLoad = {
  ...validCircuit,
  title: 'RC Filter With Load',
  components: [
    ...validCircuit.components,
    {
      ref: 'RLOAD',
      kind: 'load',
      value: '10k',
      nodes: ['OUT', '0'],
      footprint: 'Resistor_THT:R_Axial',
    },
  ],
};

const streamResponse = (content) => new Response(
  `${JSON.stringify({ message: { content } })}\n`,
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
);

const openAiResponse = (content) => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ollama circuit output', () => {
  it('requests schema-constrained deterministic output with a larger context window', () => {
    const body = buildOllamaRequestBody('Make an RC filter', [], true);

    expect(body.format).toEqual(AI_RESPONSE_SCHEMA);
    expect(body.format.properties.circuit).toEqual(CIRCUIT_SCHEMA);
    expect(body.options).toMatchObject({ num_ctx: 8192, num_predict: 4096, temperature: 0 });
    expect(body.format.properties.circuit.properties.schematic).toBeTruthy();
    expect(body.messages[0].content).toContain('opamp components must use value LM358');
    expect(body.messages[0].content).toContain('Use voltage_source for DC supplies');
    expect(body.messages[0].content).toContain('Omit schematic unless');
    expect(body.messages[1].content).toContain('A SPICE line like `V1 VIN 0 DC 1` must match a JSON `voltage_source`');
    expect(body.messages[1].content).toContain('Schematic Intent Metadata');
    expect(body.messages.at(-1).content).toContain('use LM358 as the SPICE subcircuit name');
    expect(body.messages.at(-1).content).toContain('use voltage_source for DC values');
    expect(body.messages.at(-1).content).toContain('Only include circuit.schematic');
    expect(body.messages.at(-1).content).toContain('Omit netRoles, componentRoles, and blocks');
    expect(body.messages.at(-1).content).not.toContain('"schematic":{"version"');
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

    expect(body.messages[1].content).toContain('Additional circuit design rules');
    expect(body.messages.find((message) => message.content.includes('Active chat memory'))?.content).toContain(
      'Use through-hole parts',
    );
    expect(body.messages.find((message) => message.content.includes('exact canonical current design'))?.content)
      .toContain('R1 IN OUT 1k');
    expect(body.messages.find((message) => message.content.includes('Requirement 4'))?.content)
      .toContain('Previous circuit request');
    expect(body.messages.at(-1).content).toContain('Change R1 to 2.2k');
    expect(body.messages.at(-1).content).toContain('Replace the whole circuit only');
    expect(body.messages.filter((message) => message.content.includes('Previous circuit request'))).toHaveLength(12);
  });

  it('includes current component inventory and load aliases for follow-up edits', () => {
    const body = buildOllamaRequestBody(
      'remove Rload',
      [],
      true,
      { circuit: circuitWithLoad, spice: 'R1 IN OUT 1k\nRLOAD OUT 0 10k', kicadNetlist: '<export />' },
    );

    const revisionContext = body.messages.find((message) => message.content.includes('Current component inventory'));
    expect(revisionContext.content).toContain('RLOAD: load, value=10k, nodes=OUT - 0');
    expect(revisionContext.content).toContain('Rload');
    expect(revisionContext.content).toContain('load resistor');
    expect(revisionContext.content).toContain('modify or remove that existing component');
  });

  it('does not attach memory or revision context to a new chat', () => {
    const body = buildOllamaRequestBody('Make a new filter', [], true, null, null);

    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toContain('Additional circuit design rules');
    expect(body.messages.some((message) => message.content.includes('Active chat memory'))).toBe(false);
    expect(body.messages.some((message) => message.content.includes('canonical current design'))).toBe(false);
  });

  it('validates AI response envelopes and returns the canonical circuit', () => {
    expect(parseCircuitResponse(JSON.stringify(validAiResponse))).toEqual(validAiResponse);
  });

  it('accepts optional schematic intent metadata in AI responses', () => {
    const response = parseCircuitResponse(JSON.stringify({
      ...validAiResponse,
      circuit: {
        ...validCircuit,
        schematic: {
          version: 1,
          topology: 'rc_filter',
          primaryRef: '',
          externalTerminals: [
            { net: 'IN', label: 'VIN', type: 'input', side: 'left' },
            { net: 'OUT', label: 'VOUT', type: 'output', side: 'right' },
          ],
          netRoles: [
            { net: 'IN', role: 'input', side: 'left' },
            { net: 'OUT', role: 'output', side: 'right' },
          ],
          componentRoles: [
            { ref: 'R1', role: 'input_network', block: 'filter', side: 'left', orientation: 'horizontal', order: 1 },
          ],
          blocks: [
            { id: 'filter', role: 'filter', refs: ['R1'], side: 'center', order: 1 },
          ],
        },
      },
    }));

    expect(response.circuit.schematic.externalTerminals).toHaveLength(2);
    expect(response.circuit.schematic.componentRoles[0]).toMatchObject({ ref: 'R1', role: 'input_network' });
  });

  it('normalizes generic op amp aliases to the canonical LM358 model', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'GENERIC' }],
      },
      spice: '* op amp\nXU1 VINP VINN VOUT VCC 0 OPAMP\n.end',
    }));

    expect(response.circuit.components.find((part) => part.ref === 'XU1').value).toBe('LM358');
  });

  it('accepts LM358 SPICE when the op amp JSON used an alias', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'OPAMP' }],
      },
      spice: '* op amp\nXU1 VINP VINN VOUT VCC 0 LM358\n.end',
    }));

    expect(response.circuit.components.find((part) => part.ref === 'XU1').value).toBe('LM358');
  });

  it('still rejects op amp SPICE when the nodes differ from the JSON circuit', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'I built an LM358 voltage follower around XU1.',
      circuit: {
        ...opampCircuit,
        components: [{ ...opampCircuit.components[0], value: 'GENERIC' }],
      },
      spice: '* wrong op amp output\nXU1 VINP VINN VDIFF VCC 0 OPAMP\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('normalizes a DC V-source JSON signal_source to voltage_source', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built a 1 V DC source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'signal_source',
          value: 'DC 1',
        }],
      },
      spice: '* source\nV1 VIN 0 DC 1\n.end',
    }));

    const source = response.circuit.components.find((part) => part.ref === 'V1');
    expect(source.kind).toBe('voltage_source');
    expect(source.value).toBe('1V');
  });

  it('normalizes a waveform V-source JSON voltage_source to signal_source', () => {
    const response = parseCircuitResponse(JSON.stringify({
      reply: 'I built a sine source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'voltage_source',
          value: 'SINE(0 1 1k)',
        }],
      },
      spice: '* source\nV1 VIN 0 SINE(0 1 1k)\n.end',
    }));

    const source = response.circuit.components.find((part) => part.ref === 'V1');
    expect(source.kind).toBe('signal_source');
    expect(source.value).toBe('SINE(0 1 1k)');
  });

  it('still rejects source SPICE when nodes differ from the JSON circuit', () => {
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'I built a 1 V DC source at VIN.',
      circuit: {
        ...sourceCircuit,
        components: [{
          ...sourceCircuit.components[0],
          kind: 'signal_source',
          value: 'DC 1',
        }],
      },
      spice: '* wrong source node\nV1 VWRONG 0 DC 1\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('classifies malformed and schema-invalid responses', () => {
    expect(() => parseCircuitResponse('{"title": broken}')).toThrowError(
      expect.objectContaining({ code: 'json_syntax' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ title: 'Incomplete' }))).toThrowError(
      expect.objectContaining({ code: 'schema_validation' }),
    );
  });

  it('rejects missing, invalid, and mismatched AI SPICE', () => {
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit, spice: 'R1 IN' }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({ reply: 'Here is the filter.', circuit: validCircuit, spice: 'Y1 IN OUT 1k' }))).toThrowError(
      expect.objectContaining({ code: 'spice_validation' }),
    );
    expect(() => parseCircuitResponse(JSON.stringify({
      reply: 'Here is the filter.',
      circuit: validCircuit,
      spice: '* wrong node\nR1 IN 0 1k\n.end',
    }))).toThrowError(expect.objectContaining({ code: 'spice_validation' }));
  });

  it('retries a malformed stream once with corrective context', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse('{"title": broken}'))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    const onContent = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter', [], null, onContent)).resolves.toEqual(validAiResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.format).toEqual(AI_RESPONSE_SCHEMA);
    expect(retryBody.messages.at(-1).content).toContain('previous response was rejected');
    expect(retryBody.messages.at(-1).content).toContain('top-level "reply", "circuit", and "spice"');
    expect(retryBody.messages.at(-1).content).toContain('smaller complete response');
    expect(onContent).toHaveBeenLastCalledWith(
      JSON.stringify(validAiResponse),
      expect.objectContaining({ attempt: 1, correcting: true }),
    );
  });

  it('does not resend truncated JSON content during correction retry', async () => {
    const longTruncatedContent = `{"reply":"${'partial response '.repeat(200)}"`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(longTruncatedContent))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toEqual(validAiResponse);

    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.some((message) => message.role === 'assistant')).toBe(false);
    expect(retryBody.messages.map((message) => message.content).join('\n')).not.toContain('partial response partial response');
    expect(retryBody.messages.at(-1).content).toContain('Omit circuit.schematic unless');
  });

  it('retries once when AI SPICE does not match the JSON circuit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({
        reply: 'Here is the filter.',
        circuit: validCircuit,
        spice: '* wrong node\nR1 IN 0 1k\n.end',
      })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toEqual(validAiResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('SPICE must exactly match');
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

  it('uses the OpenAI-compatible endpoint for Z.ai with JSON mode and thinking disabled', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse(JSON.stringify(validAiResponse)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toEqual(validAiResponse);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'glm-5.2',
      max_tokens: 12000,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    });
  });

  it('reads array-style OpenAI-compatible assistant content', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(openAiResponse([
      { type: 'text', text: JSON.stringify(validAiResponse) },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make an RC filter')).resolves.toEqual(validAiResponse);
  });

  it('reports length-stopped Z.ai reasoning output as an output budget problem', async () => {
    vi.stubEnv('AI_PROVIDER', 'zai');
    vi.stubEnv('AI_API_URL', 'https://open.bigmodel.cn/api/paas/v4');
    vi.stubEnv('AI_MODEL', 'glm-5.2');
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: '',
            reasoning_content: 'The user wants a difference amplifier circuit. '.repeat(20),
          },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamCircuitWithOllama('Make a difference amplifier')).rejects.toMatchObject({
      code: 'provider_response',
      message: expect.stringContaining('max_tokens was exhausted'),
    });
  });
});
