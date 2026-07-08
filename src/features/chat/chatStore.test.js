import { describe, expect, it } from 'vitest';
import {
  CHAT_STORAGE_KEY,
  buildConversationContext,
  chatTitleFromPrompt,
  createChat,
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

  it('builds compact AI context from prior user prompts and generated circuits', () => {
    const messages = [
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
      { role: 'assistant', content: 'Temporary error' },
    ];

    expect(buildConversationContext(messages)).toEqual([
      { role: 'user', content: 'Make a filter' },
      { role: 'assistant', content: 'Ready', circuit: { title: 'Filter' } },
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
