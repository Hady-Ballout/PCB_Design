import { padMcuNodes } from '../../core/componentKinds.js';
import { LAYOUT_VERSION, layoutCircuitDiagram, repairDiagramLayout } from '../../core/schematicLayout.js';

export const CHAT_STORAGE_KEY = 'prompt-to-pcb-chats-v1';

const shouldResetStoredChats = () => {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    if (params.get('reset') !== '1') return false;
    params.delete('reset');
    const nextSearch = params.toString();
    const nextUrl = `${globalThis.location?.pathname || '/'}${nextSearch ? `?${nextSearch}` : ''}${globalThis.location?.hash || ''}`;
    globalThis.history?.replaceState?.(null, '', nextUrl);
    return true;
  } catch {
    return false;
  }
};

const createId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const COMPOSER_MODES = ['plan', 'ask', 'implement'];

export const createChat = ({ id = createId(), now = Date.now() } = {}) => ({
  id,
  title: 'New circuit',
  createdAt: now,
  updatedAt: now,
  draft: '',
  draftMode: 'implement',
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
  editableCircuitJson: '',
  editableCode: '',
  pendingCodeChange: null,
  editedDiagram: null,
  editedBreadboard: null,
  manualRouting: null,
  simulationRun: null,
  error: '',
  simulationError: '',
  spiceSyncError: '',
  kicadSyncError: '',
  circuitJsonSyncError: '',
});

export const chatTitleFromPrompt = (prompt) => {
  const title = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!title) return 'New circuit';
  return title.length > 42 ? `${title.slice(0, 39).trimEnd()}...` : title;
};

export const NO_PREFERENCE_ANSWER = 'No preference (you decide)';

const CLARIFICATION_STATUSES = ['pending', 'answered', 'skipped'];

const sanitizeClarification = (clarification) => {
  if (!clarification || typeof clarification !== 'object') return null;
  const questions = (Array.isArray(clarification.questions) ? clarification.questions : [])
    .filter((question) => question && typeof question === 'object')
    .map((question) => ({
      id: String(question.id || ''),
      question: String(question.question || ''),
      options: (Array.isArray(question.options) ? question.options : [])
        .map((option) => String(option || '').trim())
        .filter(Boolean),
    }))
    .filter((question) => question.id && question.question && question.options.length);
  if (!questions.length) return null;

  const rawAnswers = clarification.answers && typeof clarification.answers === 'object' ? clarification.answers : {};
  const answers = {};
  for (const question of questions) {
    const answer = String(rawAnswers[question.id] || '').trim();
    if (answer) answers[question.id] = answer;
  }

  return {
    forPrompt: String(clarification.forPrompt || ''),
    questions,
    answers,
    status: CLARIFICATION_STATUSES.includes(clarification.status) ? clarification.status : 'pending',
  };
};

const PLAN_STATUSES = ['proposed', 'built'];
const ASSIST_MESSAGE_MODES = ['plan', 'ask'];

const sanitizePlan = (plan) => {
  if (!plan || typeof plan !== 'object') return null;
  return {
    forPrompt: String(plan.forPrompt || ''),
    status: PLAN_STATUSES.includes(plan.status) ? plan.status : 'proposed',
  };
};

const normalizeMessage = (message) => {
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  const clarification = message.role === 'assistant' ? sanitizeClarification(message.clarification) : null;
  const plan = message.role === 'assistant' ? sanitizePlan(message.plan) : null;
  return {
    id: String(message.id || createId()),
    role: message.role,
    content: String(message.content || ''),
    createdAt: Number(message.createdAt) || Date.now(),
    // Assistant-message circuits replay to the server as revision context —
    // pad MCU boards saved before a pin-list extension so history stays valid.
    ...(message.circuit && typeof message.circuit === 'object' ? { circuit: padMcuNodes(message.circuit) } : {}),
    ...(clarification ? { clarification } : {}),
    ...(plan ? { plan } : {}),
    ...(message.role === 'assistant' && ASSIST_MESSAGE_MODES.includes(message.mode) ? { mode: message.mode } : {}),
  };
};

const migrateDiagram = (diagram, circuit = null) => {
  if (!diagram || typeof diagram !== 'object' || diagram.layoutVersion >= LAYOUT_VERSION) return diagram;
  try {
    return repairDiagramLayout(diagram, circuit ? { circuit } : {});
  } catch {
    // A full re-layout can itself fail to route; never let that crash app
    // startup — fall back to the stored diagram as-is.
    try {
      return circuit ? layoutCircuitDiagram(circuit) : diagram;
    } catch {
      return diagram;
    }
  }
};

// Keeps the JSON editor's stored text in step with an MCU pin-list migration:
// without this, App's debounced JSON-sync effect would "sync" the stale,
// shorter nodes array right back over the padded circuit after load.
const migrateCircuitJson = (stored, result) => {
  if (!stored) return result?.circuit ? JSON.stringify(result.circuit, null, 2) : '';
  try {
    const parsed = JSON.parse(stored);
    const padded = padMcuNodes(parsed);
    return padded === parsed ? stored : JSON.stringify(padded, null, 2);
  } catch {
    return stored; // unparseable user edit — leave it; the sync error already surfaces
  }
};

const normalizeChat = (chat) => {
  if (!chat || typeof chat !== 'object') return null;
  const base = createChat({ id: String(chat.id || createId()), now: Number(chat.createdAt) || Date.now() });
  const rawResult = chat.result && typeof chat.result === 'object'
    ? { ...chat.result }
    : null;
  // MCU pin lists only ever grow; pad circuits saved before an extension and
  // reset the diagram layout version for just the affected chats so the
  // migrateChatDiagram pass re-layouts them with the padded circuit.
  const paddedCircuit = rawResult?.circuit ? padMcuNodes(rawResult.circuit) : null;
  const mcuPadded = paddedCircuit !== null && paddedCircuit !== rawResult.circuit;
  const result = mcuPadded
    ? {
        ...rawResult,
        circuit: paddedCircuit,
        ...(rawResult.diagram && typeof rawResult.diagram === 'object'
          ? { diagram: { ...rawResult.diagram, layoutVersion: 0 } }
          : {}),
      }
    : rawResult;
  return {
    ...base,
    ...chat,
    id: base.id,
    title: String(chat.title || 'New circuit'),
    createdAt: base.createdAt,
    updatedAt: Number(chat.updatedAt) || base.createdAt,
    draft: String(chat.draft || ''),
    draftMode: COMPOSER_MODES.includes(chat.draftMode) ? chat.draftMode : 'implement',
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
    editableCircuitJson: migrateCircuitJson(String(chat.editableCircuitJson || ''), result),
    editableCode: String(chat.editableCode || chat.result?.code || ''),
    pendingCodeChange: chat.pendingCodeChange && typeof chat.pendingCodeChange === 'object'
      ? {
          previous: String(chat.pendingCodeChange.previous || ''),
          proposed: String(chat.pendingCodeChange.proposed || ''),
        }
      : null,
    editedDiagram: chat.editedDiagram && typeof chat.editedDiagram === 'object'
      ? (mcuPadded ? { ...chat.editedDiagram, layoutVersion: 0 } : chat.editedDiagram)
      : null,
    editedBreadboard: chat.editedBreadboard && typeof chat.editedBreadboard === 'object'
      ? chat.editedBreadboard
      : null,
    // Hand-drawn board copper; buildManualPcbLayout ignores it unless its
    // placement signature still matches, so stale values are inert not wrong.
    manualRouting: chat.manualRouting && typeof chat.manualRouting === 'object'
      ? chat.manualRouting
      : null,
    simulationRun: null,
    error: '',
    simulationError: '',
    spiceSyncError: '',
    kicadSyncError: '',
    circuitJsonSyncError: '',
  };
};

export const loadChatStore = (storage = globalThis.localStorage) => {
  try {
    if (shouldResetStoredChats()) {
      storage?.removeItem(CHAT_STORAGE_KEY);
      const chat = createChat();
      return { chats: [chat], activeChatId: chat.id };
    }

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

export const migrateChatDiagram = (chat) => {
  if (!chat) return chat;
  let changed = false;
  let result = chat.result;
  let editedDiagram = chat.editedDiagram;

  if (result?.diagram) {
    const migrated = migrateDiagram(result.diagram, result.circuit);
    if (migrated !== result.diagram) {
      result = { ...result, diagram: migrated };
      changed = true;
    }
  }

  if (editedDiagram) {
    const migrated = migrateDiagram(editedDiagram, result?.circuit);
    if (migrated !== editedDiagram) {
      editedDiagram = migrated;
      changed = true;
    }
  }

  return changed ? { ...chat, result, editedDiagram } : chat;
};

const resolvedAnswer = (answers, questionId) =>
  String(answers?.[questionId] || '').trim() || NO_PREFERENCE_ANSWER;

// The full prompt sent to /api/generate-circuit after a clarification round.
export const composeClarifiedPrompt = (forPrompt, questions, answers) => [
  `Original request: ${forPrompt}`,
  'User clarifications:',
  ...questions.map((question) => `- ${question.question} -> ${resolvedAnswer(answers, question.id)}`),
  'Design the circuit now honoring these clarifications.',
].join('\n');

// The full prompt sent to /api/generate-circuit when the user builds a plan.
export const composePlanBuildPrompt = (forPrompt, planText) => [
  `Original request: ${forPrompt}`,
  'Approved design plan:',
  String(planText || '').trim(),
  'Build this circuit now, following the approved plan.',
].join('\n');

// The compact user bubble shown in chat (and replayed as history context).
export const formatClarificationSummary = (questions, answers) =>
  `Clarifications: ${questions
    .map((question) => `${question.question} -> ${resolvedAnswer(answers, question.id)}`)
    .join('; ')}`;

// Generation/clarify context: assistant text-only turns ride along so the
// server's reply stage can see the AI's own past words. Clarification-question
// bubbles and empty turns stay out; the server re-filters per stage (stage 1
// keeps only circuit-bearing assistant turns).
export const buildConversationContext = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user'
      || (message.role === 'assistant'
        && (message.circuit || (String(message.content || '').trim() && !message.clarification))))
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.circuit ? { circuit: message.circuit } : {}),
    }));

// Context for /api/assist-circuit (Plan/Ask): keeps assistant text-only turns
// for conversational continuity.
export const buildAssistContext = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.circuit ? { circuit: message.circuit } : {}),
    }));
