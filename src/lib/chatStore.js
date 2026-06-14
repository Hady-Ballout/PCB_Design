import { LAYOUT_VERSION, layoutCircuitDiagram, repairDiagramLayout } from './schematicLayout.js';

export const CHAT_STORAGE_KEY = 'prompt-to-pcb-chats-v1';

const createId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const createChat = ({ id = createId(), now = Date.now() } = {}) => ({
  id,
  title: 'New circuit',
  createdAt: now,
  updatedAt: now,
  draft: '',
  messages: [],
  memory: {
    summary: '',
    updatedAt: 0,
  },
  result: null,
  editableSpice: '',
  pendingSpiceChange: null,
  editableKicadNetlist: '',
  pendingKicadChange: null,
  editedDiagram: null,
  simulationRun: null,
  error: '',
  simulationError: '',
  spiceSyncError: '',
  kicadSyncError: '',
});

export const chatTitleFromPrompt = (prompt) => {
  const title = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!title) return 'New circuit';
  return title.length > 42 ? `${title.slice(0, 39).trimEnd()}...` : title;
};

const normalizeMessage = (message) => {
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  return {
    id: String(message.id || createId()),
    role: message.role,
    content: String(message.content || ''),
    createdAt: Number(message.createdAt) || Date.now(),
    ...(message.circuit && typeof message.circuit === 'object' ? { circuit: message.circuit } : {}),
  };
};

const migrateDiagram = (diagram, circuit = null) => {
  if (!diagram || typeof diagram !== 'object' || diagram.layoutVersion >= LAYOUT_VERSION) return diagram;
  try {
    return repairDiagramLayout(diagram, circuit ? { circuit } : {});
  } catch {
    return circuit ? layoutCircuitDiagram(circuit) : diagram;
  }
};

const normalizeChat = (chat) => {
  if (!chat || typeof chat !== 'object') return null;
  const base = createChat({ id: String(chat.id || createId()), now: Number(chat.createdAt) || Date.now() });
  const result = chat.result && typeof chat.result === 'object'
    ? { ...chat.result, diagram: migrateDiagram(chat.result.diagram, chat.result.circuit) }
    : null;
  return {
    ...base,
    ...chat,
    id: base.id,
    title: String(chat.title || 'New circuit'),
    createdAt: base.createdAt,
    updatedAt: Number(chat.updatedAt) || base.createdAt,
    draft: String(chat.draft || ''),
    messages: Array.isArray(chat.messages) ? chat.messages.map(normalizeMessage).filter(Boolean) : [],
    memory: {
      summary: String(chat.memory?.summary || ''),
      updatedAt: Number(chat.memory?.updatedAt) || 0,
    },
    result,
    editableSpice: String(chat.editableSpice || chat.result?.spice || ''),
    pendingSpiceChange: chat.pendingSpiceChange && typeof chat.pendingSpiceChange === 'object'
      ? {
          previous: String(chat.pendingSpiceChange.previous || ''),
          proposed: String(chat.pendingSpiceChange.proposed || ''),
        }
      : null,
    editableKicadNetlist: String(chat.editableKicadNetlist || chat.result?.kicadNetlist || ''),
    pendingKicadChange: chat.pendingKicadChange && typeof chat.pendingKicadChange === 'object'
      ? {
          previous: String(chat.pendingKicadChange.previous || ''),
          proposed: String(chat.pendingKicadChange.proposed || ''),
        }
      : null,
    editedDiagram: chat.editedDiagram && typeof chat.editedDiagram === 'object'
      ? migrateDiagram(chat.editedDiagram, chat.result?.circuit)
      : null,
    simulationRun: null,
    error: '',
    simulationError: '',
    spiceSyncError: '',
    kicadSyncError: '',
  };
};

export const loadChatStore = (storage = globalThis.localStorage) => {
  try {
    const saved = JSON.parse(storage?.getItem(CHAT_STORAGE_KEY) || 'null');
    const chats = Array.isArray(saved?.chats) ? saved.chats.map(normalizeChat).filter(Boolean) : [];
    if (chats.length === 0) {
      const chat = createChat();
      return { chats: [chat], activeChatId: chat.id };
    }

    const activeChatId = chats.some((chat) => chat.id === saved.activeChatId)
      ? saved.activeChatId
      : chats[0].id;
    return { chats, activeChatId };
  } catch {
    const chat = createChat();
    return { chats: [chat], activeChatId: chat.id };
  }
};

export const saveChatStore = (store, storage = globalThis.localStorage) => {
  try {
    const chats = store.chats.map(({ simulationRun, ...chat }) => chat);
    storage?.setItem(CHAT_STORAGE_KEY, JSON.stringify({ chats, activeChatId: store.activeChatId }));
    return true;
  } catch {
    return false;
  }
};

export const buildConversationContext = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user' || (message.role === 'assistant' && message.circuit))
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.circuit ? { circuit: message.circuit } : {}),
    }));
