import { describe, expect, it } from 'vitest';
import {
  CHAT_STORAGE_KEY,
  COMPOSER_MODES,
  NO_PREFERENCE_ANSWER,
  buildAssistContext,
  buildConversationContext,
  chatTitleFromPrompt,
  composeClarifiedPrompt,
  composePlanBuildPrompt,
  createChat,
  formatClarificationSummary,
  loadChatStore,
  migrateChatDiagram,
  saveChatStore,
} from './chatStore.js';
import { LAYOUT_VERSION, layoutCircuitDiagram } from '../../core/schematicLayout.js';

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

describe('chat store', () => {
  it('creates a blank chat and shortens long prompt titles', () => {
    expect(createChat({ id: 'chat-1', now: 10 })).toMatchObject({
      id: 'chat-1',
      title: 'New circuit',
      createdAt: 10,
      messages: [],
      memory: { summary: '', updatedAt: 0 },
    });
    expect(chatTitleFromPrompt('  Design   a voltage divider  ')).toBe('Design a voltage divider');
    expect(chatTitleFromPrompt('x'.repeat(50))).toHaveLength(42);
  });

  it('persists chats without transient simulation results', () => {
    const storage = memoryStorage();
    const chat = { ...createChat({ id: 'chat-1', now: 10 }), simulationRun: { rawOutput: 'large log' } };

    expect(saveChatStore({ chats: [chat], activeChatId: chat.id }, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(CHAT_STORAGE_KEY)).chats[0].simulationRun).toBeUndefined();
    expect(loadChatStore(storage)).toMatchObject({ activeChatId: 'chat-1', chats: [{ id: 'chat-1' }] });
  });

  it('hydrates editable circuit JSON from saved results', () => {
    const storage = memoryStorage();
    const circuit = {
      title: 'JSON visible circuit',
      type: 'debug',
      supplyVoltage: 5,
      components: [{ ref: 'R1', kind: 'resistor', value: '1k', footprint: '', nodes: ['A', '0'] }],
      notes: [],
    };
    const chat = {
      ...createChat({ id: 'json-chat', now: 10 }),
      result: { circuit, diagram: null, spice: '', kicadNetlist: '' },
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    expect(loadChatStore(storage).chats[0].editableCircuitJson).toContain('"ref": "R1"');
  });

  it('tracks firmware code per chat and hydrates it from saved results', () => {
    expect(createChat({ id: 'code-chat', now: 10 })).toMatchObject({
      editableCode: '',
      pendingCodeChange: null,
    });

    const storage = memoryStorage();
    const result = { circuit: null, diagram: null, spice: '', kicadNetlist: '', code: 'void setup() {}' };
    const backfilled = { ...createChat({ id: 'backfill', now: 10 }), result };
    delete backfilled.editableCode;
    const edited = { ...createChat({ id: 'edited', now: 10 }), result, editableCode: '// my edit' };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [backfilled, edited], activeChatId: backfilled.id }));

    const loaded = loadChatStore(storage);
    // Older stored chats backfill from result.code; user edits win over it.
    expect(loaded.chats[0].editableCode).toBe('void setup() {}');
    expect(loaded.chats[1].editableCode).toBe('// my edit');
  });

  it('builds AI context from prior prompts, circuits, and assistant replies', () => {
    const messages = [
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
      { role: 'assistant', content: 'Temporary error' },
      { role: 'assistant', content: '   ' },
    ];

    expect(buildConversationContext(messages)).toEqual([
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
      { role: 'assistant', content: 'Temporary error' },
    ]);
  });

  it('migrates legacy chats with empty memory and persists updated memory', () => {
    const storage = memoryStorage();
    const legacy = { ...createChat({ id: 'legacy', now: 10 }) };
    delete legacy.memory;
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [legacy], activeChatId: legacy.id }));

    expect(loadChatStore(storage).chats[0].memory).toEqual({ summary: '', updatedAt: 0 });

    const chat = {
      ...createChat({ id: 'remembered', now: 20 }),
      memory: { summary: 'Use through-hole parts.', updatedAt: 30 },
    };
    saveChatStore({ chats: [chat], activeChatId: chat.id }, storage);
    expect(loadChatStore(storage).chats[0].memory).toEqual(chat.memory);
  });

  it('leaves history truncation to the server', () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: 'user',
      content: `Requirement ${index + 1}`,
    }));

    expect(buildConversationContext(messages)).toHaveLength(8);
  });

  it('persists clarification rounds on assistant messages and drops malformed ones', () => {
    const storage = memoryStorage();
    const clarification = {
      forPrompt: 'blink an LED',
      questions: [{ id: 'q1', question: 'Supply?', options: ['USB 5V', NO_PREFERENCE_ANSWER] }],
      answers: { q1: 'USB 5V', ghost: 'dropped' },
    };
    const chat = {
      ...createChat({ id: 'clarify-chat', now: 10 }),
      messages: [
        { id: 'm1', role: 'assistant', content: 'Questions:', createdAt: 10, clarification },
        { id: 'm2', role: 'assistant', content: 'Bad round', createdAt: 11, clarification: { questions: 'nope' } },
        { id: 'm3', role: 'user', content: 'Ignored on user turns', createdAt: 12, clarification },
      ],
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    const [pending, malformed, userTurn] = loadChatStore(storage).chats[0].messages;
    // Status defaults to pending; answers for unknown question ids are dropped.
    expect(pending.clarification).toEqual({
      forPrompt: 'blink an LED',
      questions: clarification.questions,
      answers: { q1: 'USB 5V' },
      status: 'pending',
    });
    expect(malformed.clarification).toBeUndefined();
    expect(userTurn.clarification).toBeUndefined();
  });

  it('excludes clarification-only assistant messages from AI context', () => {
    const messages = [
      { role: 'user', content: 'blink an LED' },
      {
        role: 'assistant',
        content: 'Questions:',
        clarification: { questions: [{ id: 'q1', question: 'Supply?', options: ['5V'] }] },
      },
      { role: 'assistant', content: 'Done', circuit: { title: 'Blinker' } },
    ];

    expect(buildConversationContext(messages)).toEqual([
      { role: 'user', content: 'blink an LED' },
      { role: 'assistant', content: 'Done', circuit: { title: 'Blinker' } },
    ]);
  });

  it('composes the clarified generation prompt and the compact chat summary', () => {
    const questions = [
      { id: 'q1', question: 'What supply?', options: ['USB 5V', NO_PREFERENCE_ANSWER] },
      { id: 'q2', question: 'Blink rate?', options: ['1 Hz', NO_PREFERENCE_ANSWER] },
    ];
    const answers = { q1: 'USB 5V' };

    expect(composeClarifiedPrompt('blink an LED', questions, answers)).toBe([
      'Original request: blink an LED',
      'User clarifications:',
      '- What supply? -> USB 5V',
      `- Blink rate? -> ${NO_PREFERENCE_ANSWER}`,
      'Design the circuit now honoring these clarifications.',
    ].join('\n'));

    expect(formatClarificationSummary(questions, answers)).toBe(
      `Clarifications: What supply? -> USB 5V; Blink rate? -> ${NO_PREFERENCE_ANSWER}`,
    );
  });

  it('persists the composer mode per chat and coerces junk to implement', () => {
    expect(COMPOSER_MODES).toEqual(['plan', 'ask', 'implement']);
    expect(createChat({ id: 'mode-chat', now: 10 }).draftMode).toBe('implement');

    const storage = memoryStorage();
    const planChat = { ...createChat({ id: 'plan-chat', now: 10 }), draftMode: 'plan' };
    const junkChat = { ...createChat({ id: 'junk-chat', now: 10 }), draftMode: 'yolo' };
    const legacyChat = { ...createChat({ id: 'legacy-chat', now: 10 }) };
    delete legacyChat.draftMode;
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [planChat, junkChat, legacyChat], activeChatId: planChat.id }));

    const [plan, junk, legacy] = loadChatStore(storage).chats;
    expect(plan.draftMode).toBe('plan');
    expect(junk.draftMode).toBe('implement');
    expect(legacy.draftMode).toBe('implement');
  });

  it('persists plan state and assist mode on assistant messages only', () => {
    const storage = memoryStorage();
    const chat = {
      ...createChat({ id: 'plan-msg-chat', now: 10 }),
      messages: [
        { id: 'm1', role: 'assistant', content: 'The plan:', createdAt: 10, mode: 'plan', plan: { forPrompt: 'blink an LED', status: 'proposed' } },
        { id: 'm2', role: 'assistant', content: 'Built plan', createdAt: 11, plan: { forPrompt: 'blink', status: 'built' } },
        { id: 'm3', role: 'assistant', content: 'Weird', createdAt: 12, mode: 'yolo', plan: { forPrompt: 'x', status: 'wat' } },
        { id: 'm4', role: 'assistant', content: 'Not a plan', createdAt: 13, plan: 'nope' },
        { id: 'm5', role: 'user', content: 'Ignored on user turns', createdAt: 14, mode: 'ask', plan: { forPrompt: 'y', status: 'proposed' } },
      ],
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    const [proposed, built, weird, notPlan, userTurn] = loadChatStore(storage).chats[0].messages;
    expect(proposed.plan).toEqual({ forPrompt: 'blink an LED', status: 'proposed' });
    expect(proposed.mode).toBe('plan');
    expect(built.plan.status).toBe('built');
    // Unknown statuses coerce to proposed; unknown modes are dropped.
    expect(weird.plan.status).toBe('proposed');
    expect(weird.mode).toBeUndefined();
    expect(notPlan.plan).toBeUndefined();
    expect(userTurn.plan).toBeUndefined();
    expect(userTurn.mode).toBeUndefined();
  });

  it('composes the build-this generation prompt from the approved plan', () => {
    expect(composePlanBuildPrompt('blink an LED', ' - 555 timer\n - R1 10k ')).toBe([
      'Original request: blink an LED',
      'Approved design plan:',
      '- 555 timer\n - R1 10k',
      'Build this circuit now, following the approved plan.',
    ].join('\n'));
  });

  it('keeps assistant text-only turns in both assist and generation contexts', () => {
    const messages = [
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Here is a plan.', mode: 'plan' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
    ];
    const expected = [
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Here is a plan.' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
    ];

    expect(buildAssistContext(messages)).toEqual(expected);
    expect(buildConversationContext(messages)).toEqual(expected);
  });

  it('migrates and repairs saved diagrams without changing the circuit model', () => {
    const storage = memoryStorage();
    const circuit = {
      title: 'Saved filter',
      type: 'filter',
      supplyVoltage: 5,
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'OUT'] },
        { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['OUT', '0'] },
      ],
      notes: [],
    };
    const oldDiagram = layoutCircuitDiagram(circuit);
    delete oldDiagram.layoutVersion;
    delete oldDiagram.netLabels;
    oldDiagram.bridges = [{ wireId: oldDiagram.wires[0].id, x: 100, y: 100 }];
    oldDiagram.junctions = [{ x: 120, y: 120 }];
    oldDiagram.wires = oldDiagram.wires.map(({ routingMode, preferredWaypoints, labelId, ...wire }) => wire);
    const chat = {
      ...createChat({ id: 'saved', now: 10 }),
      result: { circuit, diagram: oldDiagram, spice: '', kicadNetlist: '' },
      editedDiagram: oldDiagram,
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    const loaded = migrateChatDiagram(loadChatStore(storage).chats[0]);
    expect(loaded.result.circuit).toEqual(circuit);
    expect(loaded.result.diagram.layoutVersion).toBe(LAYOUT_VERSION);
    expect(loaded.editedDiagram.layoutVersion).toBe(LAYOUT_VERSION);
    expect(loaded.editedDiagram.wires.every((wire) => wire.routingMode && Array.isArray(wire.points))).toBe(true);
    if (loaded.editedDiagram.layoutMode === 'fallback') {
      expect(loaded.editedDiagram.netLabels).toHaveLength(loaded.editedDiagram.wires.length);
    } else {
      expect(loaded.editedDiagram.netLabels).toHaveLength(0);
    }
    expect(loaded.editedDiagram.bridges).toEqual([]);
    expect(loaded.editedDiagram.junctions).toEqual([]);
  });
});

describe('MCU pin-list migration', () => {
  it('pads a saved 10-node raspberry_pi chat to 14 pins everywhere on load', () => {
    const storage = memoryStorage();
    const legacyNodes = ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'LED', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'];
    const circuit = {
      title: 'Old Pi blink',
      type: 'mcu_led',
      supplyVoltage: 3.3,
      components: [
        { ref: 'U1', kind: 'raspberry_pi', value: 'Pi 4', footprint: '', nodes: legacyNodes },
        { ref: 'R1', kind: 'resistor', value: '330', footprint: '', nodes: ['LED', '0'] },
      ],
      notes: [],
    };
    const chat = {
      ...createChat({ id: 'pi-chat', now: 10 }),
      messages: [
        { id: 'm1', role: 'user', content: 'blink', createdAt: 10 },
        { id: 'm2', role: 'assistant', content: 'done', createdAt: 11, circuit },
      ],
      result: { circuit, diagram: { layoutVersion: LAYOUT_VERSION, components: [], wires: [] }, spice: '', kicadNetlist: '' },
      editableCircuitJson: JSON.stringify(circuit, null, 2),
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    const loaded = loadChatStore(storage).chats[0];
    const pi = loaded.result.circuit.components.find((part) => part.ref === 'U1');
    expect(pi.nodes).toHaveLength(14);
    expect(pi.nodes.slice(10)).toEqual(['NC_U1_11', 'NC_U1_12', 'NC_U1_13', 'NC_U1_14']);
    // The JSON editor text was re-serialized (otherwise App's JSON-sync effect
    // would revert the padded circuit right after load).
    expect(JSON.parse(loaded.editableCircuitJson).components[0].nodes).toHaveLength(14);
    // History circuits replayed to the server were padded too.
    expect(loaded.messages[1].circuit.components[0].nodes).toHaveLength(14);
    // The stored diagram was flagged for re-layout with the padded circuit.
    expect(loaded.result.diagram.layoutVersion).toBe(0);
  });

  it('leaves up-to-date chats byte-identical (no migration churn)', () => {
    const storage = memoryStorage();
    const circuit = {
      title: 'Fresh',
      type: 'debug',
      supplyVoltage: 5,
      components: [{ ref: 'R1', kind: 'resistor', value: '1k', footprint: '', nodes: ['A', '0'] }],
      notes: [],
    };
    const stored = JSON.stringify(circuit, null, 2);
    const chat = {
      ...createChat({ id: 'fresh-chat', now: 10 }),
      result: { circuit, diagram: null, spice: '', kicadNetlist: '' },
      editableCircuitJson: stored,
    };
    storage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats: [chat], activeChatId: chat.id }));

    const loaded = loadChatStore(storage).chats[0];
    expect(loaded.result.circuit).toEqual(circuit);
    expect(loaded.editableCircuitJson).toBe(stored);
  });
});
