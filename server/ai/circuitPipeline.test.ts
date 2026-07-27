import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIRCUIT_SCHEMA,
  REPLY_RESPONSE_SCHEMA,
  REVIEWER_RESPONSE_SCHEMA,
  STAGE1_RESPONSE_SCHEMA,
  runCircuitPipeline,
} from './circuitPipeline.js';

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

// Arduino Uno pin order (FIXED_PIN_NAMES.arduino_uno, 24 pins):
// 5V,3V3,GND,VIN,D0..D13,A0..A5. GND -> '0' (index 2), D13 -> 'D13' (index 17),
// every other pin is NC_U1_<index+1>.
const unoCircuit = {
  title: 'Uno Blink',
  type: 'mcu_blink',
  supplyVoltage: 5,
  nodes: [
    '0', 'D13', 'LED_A',
    'NC_U1_1', 'NC_U1_2', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8',
    'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14', 'NC_U1_15',
    'NC_U1_16', 'NC_U1_17', 'NC_U1_19', 'NC_U1_20', 'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24',
  ],
  components: [
    {
      ref: 'U1',
      kind: 'arduino_uno',
      value: 'Uno R3',
      nodes: [
        'NC_U1_1', 'NC_U1_2', '0', 'NC_U1_4',
        'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8',
        'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12',
        'NC_U1_13', 'NC_U1_14', 'NC_U1_15', 'NC_U1_16',
        'NC_U1_17', 'D13', 'NC_U1_19', 'NC_U1_20',
        'NC_U1_21', 'NC_U1_22', 'NC_U1_23', 'NC_U1_24',
      ],
      footprint: 'Module:Arduino_UNO_R3',
    },
    {
      ref: 'RLED',
      kind: 'resistor',
      value: '330',
      nodes: ['D13', 'LED_A'],
      footprint: 'Resistor_THT:R_Axial',
    },
    {
      ref: 'DLED1',
      kind: 'led',
      value: 'LED',
      nodes: ['LED_A', '0'],
      footprint: 'LED_THT:LED_D5.0mm',
    },
  ],
  notes: [],
};

// The named ESP32 buzzer-divider bug (mirrors esp32BuzzerBug in
// src/core/topologyRules.test.js): GPIO2 fights the buzzer directly through a
// resistor divider with no transistor driver. Trips divider_powered_load
// (error). footprint: '' on every part because the stage-1 schema requires a
// footprint string (circuitPipeline.ts validateCircuitResponse).
const esp32BuzzerBugCircuit = {
  title: 'ESP32 Buzzer',
  type: 'buzzer_driver',
  supplyVoltage: 3.3,
  nodes: ['3V3', '0', 'BUZZER', 'NC_U1_3', 'NC_U1_4', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
  components: [
    {
      ref: 'U1',
      kind: 'esp32',
      value: 'DevKit V1',
      nodes: ['3V3', '0', 'NC_U1_3', 'NC_U1_4', 'BUZZER', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
      footprint: '',
    },
    { ref: 'R2', kind: 'resistor', value: '330', nodes: ['BUZZER', '0'], footprint: '' },
    { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['3V3', 'BUZZER'], footprint: '' },
  ],
  notes: [],
};

// The corrected transistor-driver topology (mirrors esp32BuzzerFixed): GPIO2 ->
// 1k base resistor -> NPN, buzzer between 3V3 and the collector. Zero errors.
const esp32BuzzerFixedCircuit = {
  title: 'ESP32 Buzzer',
  type: 'buzzer_driver',
  supplyVoltage: 3.3,
  nodes: ['3V3', '0', 'CTRL', 'BASE', 'BZ_LOW', 'NC_U1_3', 'NC_U1_4', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
  components: [
    {
      ref: 'U1',
      kind: 'esp32',
      value: 'DevKit V1',
      nodes: ['3V3', '0', 'NC_U1_3', 'NC_U1_4', 'CTRL', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
      footprint: '',
    },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['CTRL', 'BASE'], footprint: '' },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['BZ_LOW', 'BASE', '0'], footprint: '' },
    { ref: 'RBZ1', kind: 'buzzer', value: '5V active', nodes: ['3V3', 'BZ_LOW'], footprint: '' },
  ],
  notes: [],
};

// A transistor-switched DC motor with no flyback diode (mirrors the
// missing_flyback_diode fixture in topologyRules.test.js). The error survives a
// retry but applySafeAutoFixes can repair it by adding a DFB1 diode.
const switchedMotorCircuit = {
  title: 'Motor Driver',
  type: 'motor_driver',
  supplyVoltage: 5,
  nodes: ['VCC', '0', 'SW', 'BASE'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'], footprint: '' },
    { ref: 'RM1', kind: 'dc_motor', value: '6V', nodes: ['VCC', 'SW'], footprint: '' },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['SW', 'BASE', '0'], footprint: '' },
    { ref: 'RB1', kind: 'resistor', value: '1k', nodes: ['VCC', 'BASE'], footprint: '' },
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

    expect(result).toEqual({ reply: 'I built an RC filter with R1 between IN and OUT.', circuit: validCircuit, code: '' });
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
    expect(retryBody.messages.at(-1).content).toContain('functional design errors');
    expect(retryBody.messages.at(-1).content).toContain('opamp_input_floating');
  });

  it('gates stage 1 on topology errors and retries with the rule violation as correction', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: esp32BuzzerBugCircuit })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: esp32BuzzerFixedCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Drive a buzzer from an ESP32', []);

    // The corrected topology from the retry is what ships.
    expect(result.circuit).toEqual(esp32BuzzerFixedCircuit);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toContain('functional design errors');
    expect(retryBody.messages.at(-1).content).toContain('divider_powered_load');
  });

  it('auto-fixes the best attempt before the reviewer when an error survives the retry', async () => {
    // Both attempts keep the same missing_flyback_diode error; the best attempt
    // gets an additive DFB1 diode applied BEFORE the reviewer stage runs.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: switchedMotorCircuit })))
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: switchedMotorCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Switch a motor with a transistor', []);

    const flyback = result.circuit.components.find((part) => part.ref === 'DFB1');
    expect(flyback).toMatchObject({ ref: 'DFB1', kind: 'diode' });
    // The reviewer request (call index 2) must already contain the repaired part.
    const reviewerBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(reviewerBody.messages.at(-1).content).toContain('DFB1');
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

    expect(result).toEqual({ reply: 'Built it.', circuit: validCircuit, code: '' });
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

describe('microcontroller board support', () => {
  it('allows the three MCU kinds in the circuit schema', () => {
    expect(CIRCUIT_SCHEMA.properties.components.items.properties.kind.enum).toEqual(
      expect.arrayContaining(['arduino_uno', 'raspberry_pi', 'esp32']),
    );
  });

  it('carries reviewer-written firmware through to the pipeline result when the circuit needs no correction', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: unoCircuit })))
      .mockResolvedValueOnce(ollamaResponse(JSON.stringify({
        ok: true,
        code: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); delay(500); }',
      })))
      .mockResolvedValueOnce(okReply('I wired D13 through a resistor to the LED.'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Blink an LED from an Arduino Uno on pin 13', []);

    expect(result.circuit).toEqual(unoCircuit);
    expect(result.code).toContain('digitalWrite(13, HIGH)');
  });

  it('strips accidental Markdown fences from reviewer-written firmware', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: unoCircuit })))
      .mockResolvedValueOnce(ollamaResponse(JSON.stringify({
        ok: true,
        code: '```cpp\nvoid setup() {}\nvoid loop() {}\n```',
      })))
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Blink an LED from an Arduino Uno on pin 13', []);

    expect(result.code).toBe('void setup() {}\nvoid loop() {}');
  });

  it('returns an empty code string when the circuit has no MCU board', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: validCircuit })))
      .mockResolvedValueOnce(okReviewer())
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Make an RC filter', []);

    expect(result.code).toBe('');
  });

  it('carries firmware through even when the reviewer also corrects the circuit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ circuit: unoCircuit })))
      .mockResolvedValueOnce(ollamaResponse(JSON.stringify({
        ok: false,
        issues: ['RLED value was too small for a 5V logic level'],
        circuit: { ...unoCircuit, components: unoCircuit.components.map((c) => (c.ref === 'RLED' ? { ...c, value: '220' } : c)) },
        code: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}',
      })))
      .mockResolvedValueOnce(okReply());
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCircuitPipeline('Blink an LED from an Arduino Uno on pin 13', []);

    expect(result.circuit.components.find((c: { ref: string }) => c.ref === 'RLED')).toMatchObject({ value: '220' });
    expect(result.code).toContain('pinMode(13, OUTPUT)');
  });
});
