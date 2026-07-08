import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildConversationContext,
  chatTitleFromPrompt,
  createChat,
  loadChatStore,
  migrateChatDiagram,
  saveChatStore,
} from '../features/chat/chatStore.js';
import {
  circuitElectricalSignature,
  circuitFromDiagram,
  parseCircuitJson,
  parseKiCadNetlist,
  parseSpiceNetlist,
  synchronizeResult,
} from '../core/circuitSync.js';
import { toDiagramSvg } from '../core/pcbGenerator.js';
import { changedLineIndexes } from '../core/lineDiff.js';
import { layoutCircuitDiagram } from '../core/schematicLayout.js';
import { API_BASE } from '../core/config.js';
import { downloadText } from '../core/download.js';
import { AUTH_PAGES, PUBLIC_PAGES, pageFromHash } from './routing.js';
import { markSpiceAsProvisional, readGenerationStream } from './generationStream.js';
import { messageId } from '../features/chat/chatFormat.js';
import { ChatPanel } from '../features/chat/ChatPanel.jsx';
import { EDITOR_SPLIT_STORAGE_KEY, EDITOR_VIEW_LABELS, loadEditorSplit } from '../features/editors/editorConfig.js';
import { WaveformChart } from '../features/waveform/WaveformChart.jsx';
import { CircuitDiagram } from '../features/schematic/CircuitDiagram.jsx';
import { BlockSchematic } from '../features/blockSchematic/BlockSchematic.jsx';
import { RealisticSchematic } from '../features/realisticSchematic/RealisticSchematic.jsx';
import { ComponentToolIcon } from '../features/schematic/symbols.jsx';
import {
  ADD_COMPONENT_TOOLS,
  addedComponent,
  cloneDiagram,
  slotCanvasSize,
  slotGridFor,
  wireId,
} from '../features/schematic/geometry.js';
import { AuthProvider, useAuth, HomePage, LoginPage, SignupPage, VerifyPage } from '../features/auth/auth.jsx';
import '../features/auth/auth.css';

function App() {
  const { user, loading, logout } = useAuth();
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('pcb_token')}`,
  });
  const [chatStore, setChatStore] = useState(loadChatStore);
  const [diagramTool, setDiagramTool] = useState('select');
  const [diagramSelection, setDiagramSelection] = useState(null);
  const [pendingTerminal, setPendingTerminal] = useState(null);
  const [openEditorViews, setOpenEditorViews] = useState(['spice']);
  const [activeEditorView, setActiveEditorView] = useState('spice');
  const [maximizedEditorView, setMaximizedEditorView] = useState(null);
  const [editorSplit, setEditorSplit] = useState(loadEditorSplit);
  const [resizingAxis, setResizingAxis] = useState(null);
  const [chatPanelView, setChatPanelView] = useState('conversation');
  const [newChatPrompt, setNewChatPrompt] = useState('');
  const [page, setPage] = useState(pageFromHash);
  const [generatingChatId, setGeneratingChatId] = useState(null);
  const [generationStage, setGenerationStage] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const messagesEndRef = useRef(null);
  const spiceEditorRef = useRef(null);
  const resizeDragRef = useRef(null);
  const activeChat = chatStore.chats.find((chat) => chat.id === chatStore.activeChatId) || chatStore.chats[0];
  const prompt = activeChat?.draft || '';
  const result = activeChat?.result || null;
  const editableSpice = activeChat?.editableSpice || '';
  const pendingSpiceChange = activeChat?.pendingSpiceChange || null;
  const editableKicadNetlist = activeChat?.editableKicadNetlist || '';
  const pendingKicadChange = activeChat?.pendingKicadChange || null;
  const editableCircuitJson = activeChat?.editableCircuitJson || '';
  const editedDiagram = activeChat?.editedDiagram || null;
  const simulationRun = activeChat?.simulationRun || null;
  const error = activeChat?.error || '';
  const simulationError = activeChat?.simulationError || '';
  const spiceSyncError = activeChat?.spiceSyncError || '';
  const kicadSyncError = activeChat?.kicadSyncError || '';
  const circuitJsonSyncError = activeChat?.circuitJsonSyncError || '';
  const isGenerating = generatingChatId === activeChat?.id;
  const generationBusy = Boolean(generatingChatId);
  const sortedChats = useMemo(
    () => [...chatStore.chats].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatStore.chats],
  );
  const pendingSpiceChangedLines = useMemo(
    () => pendingSpiceChange
      ? changedLineIndexes(pendingSpiceChange.previous, pendingSpiceChange.proposed)
      : new Set(),
    [pendingSpiceChange],
  );

  const updateChat = (chatId, updater) => {
    setChatStore((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === chatId ? updater(chat) : chat)),
    }));
  };

  const updateActiveChat = (updater) => updateChat(chatStore.activeChatId, updater);
  const setChatField = (field, value) => {
    updateActiveChat((chat) => ({
      ...chat,
      [field]: typeof value === 'function' ? value(chat[field]) : value,
    }));
  };
  const setPrompt = (value) => setChatField('draft', value);
  const setEditableSpice = (value) => setChatField('editableSpice', value);
  const setEditableCircuitJson = (value) => setChatField('editableCircuitJson', value);
  const setEditedDiagram = (value) => setChatField('editedDiagram', value);
  const setSimulationRun = (value) => setChatField('simulationRun', value);
  const setError = (value) => setChatField('error', value);
  const setSimulationError = (value) => setChatField('simulationError', value);

  const applyDiagramChange = (value) => {
    updateActiveChat((chat) => {
      try {
        const currentDiagram = chat.editedDiagram || chat.result?.diagram;
        const nextDiagram = typeof value === 'function' ? value(currentDiagram) : value;
        if (!chat.result || !nextDiagram) return { ...chat, editedDiagram: nextDiagram };

        const nextCircuit = circuitFromDiagram(nextDiagram, chat.result.circuit);
        if (circuitElectricalSignature(nextCircuit) === circuitElectricalSignature(chat.result.circuit)) {
          return { ...chat, editedDiagram: nextDiagram, error: '' };
        }

        const synchronized = synchronizeResult(chat.result, nextCircuit, nextDiagram);
        return {
          ...chat,
          updatedAt: Date.now(),
          result: synchronized,
          editedDiagram: synchronized.diagram,
          editableSpice: synchronized.spice,
          editableKicadNetlist: synchronized.kicadNetlist,
          editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
          simulationRun: null,
          simulationError: '',
          spiceSyncError: '',
          kicadSyncError: '',
          circuitJsonSyncError: '',
          error: '',
        };
      } catch (layoutError) {
        return { ...chat, error: layoutError.message };
      }
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveChatStore(chatStore);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chatStore]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(EDITOR_SPLIT_STORAGE_KEY, JSON.stringify(editorSplit));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [editorSplit]);

  useEffect(() => {
    const syncPageFromHash = () => {
      setPage(pageFromHash());
    };

    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  useEffect(() => {
    if (loading) return;

    if (!user && !PUBLIC_PAGES.has(page)) {
      if (window.location.hash !== '#home') {
        window.location.hash = 'home';
      } else {
        setPage('home');
      }
      return;
    }

    if (user && AUTH_PAGES.has(page)) {
      if (window.location.hash) {
        window.location.hash = '';
      } else {
        setPage('workspace');
      }
    }
  }, [loading, user, page]);

  useEffect(() => {
    const active = chatStore.chats.find((c) => c.id === chatStore.activeChatId);
    if (!active) return;
    const migrated = migrateChatDiagram(active);
    if (migrated !== active) {
      setChatStore((prev) => ({
        ...prev,
        chats: prev.chats.map((c) => (c.id === active.id ? migrated : c)),
      }));
    }
  }, [chatStore.activeChatId]);

  useEffect(() => {
    if (result?.diagram && !activeChat?.editedDiagram) {
      setEditedDiagram(cloneDiagram(result.diagram));
    }
  }, [result?.diagram, activeChat?.editedDiagram]);

  // Seed the editable JSON when a result first appears (keyed on the circuit,
  // so clearing the field by hand never snaps the text back).
  useEffect(() => {
    if (result?.circuit && !editableCircuitJson) {
      setEditableCircuitJson(JSON.stringify(result.circuit, null, 2));
    }
  }, [result?.circuit]);

  useEffect(() => {
    setDiagramSelection(null);
    setPendingTerminal(null);
    setDiagramTool('select');
  }, [chatStore.activeChatId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [chatStore.activeChatId, activeChat?.messages.length, generatingChatId, chatPanelView]);

  useEffect(() => {
    if (!isGenerating || !openEditorViews.includes('spice') || !spiceEditorRef.current) return;
    spiceEditorRef.current.scrollTop = spiceEditorRef.current.scrollHeight;
  }, [editableSpice, isGenerating, openEditorViews]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    if (pendingSpiceChange) return undefined;
    if (editableSpice === result.spice) {
      if (spiceSyncError) setChatField('spiceSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableSpice;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableSpice !== source) return chat;
        const parsed = parseSpiceNetlist(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, spiceSyncError: parsed.errors.join(' ') };

        if (circuitElectricalSignature(parsed.circuit) === circuitElectricalSignature(chat.result.circuit)) {
          return {
            ...chat,
            result: { ...chat.result, spice: source },
            editableCircuitJson: JSON.stringify(chat.result.circuit, null, 2),
            spiceSyncError: '',
          };
        }

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
            { spice: source },
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableKicadNetlist: synchronized.kicadNetlist,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            spiceSyncError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, spiceSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableSpice, isGenerating, result?.spice, pendingSpiceChange]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    if (pendingKicadChange) return undefined;
    if (editableKicadNetlist === result.kicadNetlist) {
      if (kicadSyncError) setChatField('kicadSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableKicadNetlist;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableKicadNetlist !== source) return chat;
        const parsed = parseKiCadNetlist(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, kicadSyncError: parsed.errors.join(' ') };

        if (circuitElectricalSignature(parsed.circuit) === circuitElectricalSignature(chat.result.circuit)) {
          return {
            ...chat,
            result: { ...chat.result, kicadNetlist: source },
            editableCircuitJson: JSON.stringify(chat.result.circuit, null, 2),
            kicadSyncError: '',
          };
        }

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
            { kicadNetlist: source },
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableSpice: synchronized.spice,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, kicadSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableKicadNetlist, isGenerating, result?.kicadNetlist, pendingKicadChange]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    const canonicalJson = JSON.stringify(result.circuit, null, 2);
    if (editableCircuitJson === canonicalJson) {
      if (circuitJsonSyncError) setChatField('circuitJsonSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableCircuitJson;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableCircuitJson !== source) return chat;
        const parsed = parseCircuitJson(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, circuitJsonSyncError: parsed.errors.join(' ') };

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableSpice: synchronized.spice,
            editableKicadNetlist: synchronized.kicadNetlist,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            spiceSyncError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, circuitJsonSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableCircuitJson, isGenerating, result?.circuit, circuitJsonSyncError]);

  const circuitJson = useMemo(
    () => editableCircuitJson || (result?.circuit ? JSON.stringify(result.circuit, null, 2) : ''),
    [editableCircuitJson, result?.circuit],
  );

  const openEditorView = (view) => {
    setOpenEditorViews((current) => {
      if (current.includes(view)) return current;
      const next = [...current, view];
      // The layout renders at most three windows; evict the oldest so a fourth
      // never becomes an active tab with no visible window.
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
    setActiveEditorView(view);
    // While one window is maximized, selecting a tab swaps the full-screen view (browser-tab behavior).
    setMaximizedEditorView((current) => (current ? view : current));
  };

  const closeEditorView = (view) => {
    const next = openEditorViews.filter((item) => item !== view);
    setOpenEditorViews(next);
    if (activeEditorView === view) setActiveEditorView(next.at(-1) || null);
    if (maximizedEditorView === view) setMaximizedEditorView(null);
  };

  const toggleMaximizeEditorView = (view) => {
    setActiveEditorView(view);
    setMaximizedEditorView((current) => (current === view ? null : view));
  };

  const startEditorResize = (axis, event) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = { axis, container };
    setResizingAxis(axis);
  };

  const moveEditorResize = (event) => {
    const drag = resizeDragRef.current;
    if (!drag || !drag.container) return;
    const bounds = drag.container.getBoundingClientRect();
    const raw = drag.axis === 'columns'
      ? ((event.clientX - bounds.left) / bounds.width) * 100
      : ((event.clientY - bounds.top) / bounds.height) * 100;
    const minimum = drag.axis === 'columns' ? 25 : 32;
    const maximum = drag.axis === 'columns' ? 75 : 72;
    setEditorSplit((current) => ({
      ...current,
      [drag.axis]: Math.min(maximum, Math.max(minimum, raw)),
    }));
  };

  const stopEditorResize = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeDragRef.current = null;
    setResizingAxis(null);
  };

  const generate = async () => {
    const submittedPrompt = prompt.trim();
    if (!submittedPrompt) {
      setError('Enter a circuit prompt before sending.');
      return;
    }
    await submitToChat(activeChat, submittedPrompt);
  };

  const submitToChat = async (chat, submittedPrompt) => {
    const chatId = chat.id;
    const priorMessages = chat.messages;
    const currentDesign = chat.result
      ? {
          circuit: chat.result.circuit,
          spice: chat.editableSpice,
          kicadNetlist: chat.editableKicadNetlist,
        }
      : null;
    const isRevision = Boolean(currentDesign);
    const previousSpice = chat.editableSpice;
    const userMessage = {
      id: messageId(),
      role: 'user',
      content: submittedPrompt,
      createdAt: Date.now(),
    };

    setGeneratingChatId(chatId);
    setGenerationStage('circuit');
    openEditorView('spice');
    window.location.hash = '';
    setPage('workspace');
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.messages.length ? chat.title : chatTitleFromPrompt(submittedPrompt),
      updatedAt: Date.now(),
      draft: '',
      error: '',
      editableSpice: isRevision
        ? chat.editableSpice
        : '* AI is preparing the circuit...\n* Components will appear here as they are generated.',
      editableCircuitJson: isRevision ? chat.editableCircuitJson : '',
      pendingSpiceChange: null,
      pendingKicadChange: null,
      simulationRun: null,
      simulationError: '',
      circuitJsonSyncError: '',
      messages: [...chat.messages, userMessage],
    }));

    try {
      const response = await fetch(`${API_BASE}/api/generate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: submittedPrompt,
          messages: buildConversationContext(priorMessages),
          currentDesign,
          memory: chat.memory,
        }),
      });

      if (!response.ok) {
        const failed = await response.json().catch(() => ({}));
        throw new Error(failed.error || `Generation failed with HTTP ${response.status}.`);
      }
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/x-ndjson')
        ? await readGenerationStream(response, (event) => {
            if (event.type === 'stage') {
              setGenerationStage(event.stage);
              return;
            }
            if (event.type !== 'spice') return;
            updateChat(chatId, (chat) => ({
              ...chat,
              editableSpice: event.provisional
                ? markSpiceAsProvisional(event.spice, event.correcting)
                : event.spice,
              updatedAt: Date.now(),
            }));
          })
        : await response.json();
      if (data.error) throw new Error(data.error);
      const fallbackReply = `${isRevision ? 'Updated' : 'Generated'} ${data.circuit.title} with ${data.circuit.components.length} components. The latest circuit package is open in the workspace.`;
      const assistantMessage = {
        id: messageId(),
        role: 'assistant',
        content: String(data.reply || '').trim() || fallbackReply,
        circuit: data.circuit,
        createdAt: Date.now(),
      };
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: Date.now(),
        messages: [...chat.messages, assistantMessage],
        memory: data.memory || chat.memory,
        result: data,
        editableSpice: data.spice || '',
        pendingSpiceChange: currentDesign && currentDesign.spice !== data.spice
          ? { previous: currentDesign.spice, proposed: data.spice || '' }
          : null,
        editableKicadNetlist: data.kicadNetlist || '',
        pendingKicadChange: currentDesign && currentDesign.kicadNetlist !== data.kicadNetlist
          ? { previous: currentDesign.kicadNetlist, proposed: data.kicadNetlist || '' }
          : null,
        editableCircuitJson: JSON.stringify(data.circuit, null, 2),
        editedDiagram: cloneDiagram(data.diagram),
        simulationRun: null,
        simulationError: '',
        spiceSyncError: '',
        kicadSyncError: '',
        circuitJsonSyncError: '',
        error: '',
      }));
      window.location.hash = '';
      setPage('workspace');
    } catch (requestError) {
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: Date.now(),
        editableSpice: currentDesign ? currentDesign.spice : previousSpice,
        editableCircuitJson: currentDesign
          ? JSON.stringify(currentDesign.circuit, null, 2)
          : chat.editableCircuitJson,
        error: requestError.message,
        messages: [
          ...chat.messages,
          {
            id: messageId(),
            role: 'assistant',
            content: `I could not generate the circuit: ${requestError.message}`,
            createdAt: Date.now(),
          },
        ],
      }));
    } finally {
      setGeneratingChatId(null);
      setGenerationStage(null);
    }
  };

  const runSimulation = async () => {
    if (!result) return;
    const chatId = activeChat.id;
    setIsSimulating(true);
    setSimulationError('');

    try {
      const response = await fetch(`${API_BASE}/api/simulate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ circuit: result.circuit, spice: editableSpice }),
      });
      const data = await response.json().catch(() => ({ ok: false, errors: [`Simulation failed with HTTP ${response.status}.`] }));
      updateChat(chatId, (chat) => ({ ...chat, simulationRun: data }));
      if (!response.ok || !data.ok) {
        throw new Error(data.errors?.join(' ') || data.error || `Simulation failed with HTTP ${response.status}.`);
      }
      window.location.hash = 'waveform';
      setPage('waveform');
    } catch (requestError) {
      updateChat(chatId, (chat) => ({ ...chat, simulationError: requestError.message }));
    } finally {
      setIsSimulating(false);
    }
  };

  const addDiagramComponent = (type) => {
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      const next = cloneDiagram(base);
      const component = addedComponent(next, type);
      next.components.push(component);
      // Grow the slot grid to hold the new part and resize the canvas to match.
      const grid = slotGridFor(next.components.length);
      next.slotLayout = grid;
      const size = slotCanvasSize(grid.rows, grid.cols);
      next.width = Math.max(next.width, size.width);
      next.height = Math.max(next.height, size.height);
      setDiagramSelection({ type: 'component', ref: component.ref });
      setPendingTerminal(null);
      setDiagramTool('select');
      return next;
    });
  };

  const deleteDiagramSelection = () => {
    if (!diagramSelection) return;
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      const next = cloneDiagram(base);
      if (diagramSelection.type === 'component') {
        next.components = next.components.filter((component) => component.ref !== diagramSelection.ref);
        next.wires = next.wires.filter((wire) => {
          if (wire.manual) return wire.from.ref !== diagramSelection.ref && wire.to.ref !== diagramSelection.ref;
          return wire.ref !== diagramSelection.ref;
        });
      }
      if (diagramSelection.type === 'wire') {
        next.wires = next.wires.filter((wire) => wireId(wire) !== diagramSelection.id);
      }
      if (diagramSelection.type === 'netLabel') {
        next.netLabels = next.netLabels.filter((label) => label.id !== diagramSelection.id);
        next.wires = next.wires.filter((wire) => wire.labelId !== diagramSelection.id);
      }
      return next;
    });
    setDiagramSelection(null);
    setPendingTerminal(null);
  };

  const updateSelectedComponentValue = (value) => {
    if (diagramSelection?.type !== 'component') return;
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      return {
        ...base,
        components: base.components.map((component) =>
          component.ref === diagramSelection.ref ? { ...component, value } : component,
        ),
      };
    });
  };

  const showWorkspace = () => {
    window.location.hash = '';
    setPage('workspace');
  };

  const openChat = (chatId) => {
    setChatStore((current) => ({ ...current, activeChatId: chatId }));
    setChatPanelView('conversation');
    openEditorView('spice');
    window.location.hash = '';
    setPage('workspace');
  };

  const startChatFromHistory = async () => {
    const submittedPrompt = newChatPrompt.trim();
    if (!submittedPrompt) return;

    let chat = activeChat;
    if (!chat || chat.messages.length > 0 || chat.result) {
      chat = createChat();
      setChatStore((current) => ({
        chats: [chat, ...current.chats],
        activeChatId: chat.id,
      }));
    }

    setNewChatPrompt('');
    setChatPanelView('conversation');
    openEditorView('spice');
    await submitToChat(chat, submittedPrompt);
  };

  const handleComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!generationBusy) generate();
    }
  };

  const handleNewChatComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!generationBusy) startChatFromHistory();
    }
  };

  const acceptCircuitRevision = () => {
    updateActiveChat((chat) => ({
      ...chat,
      pendingSpiceChange: null,
      pendingKicadChange: null,
      editableCircuitJson: chat.result?.circuit ? JSON.stringify(chat.result.circuit, null, 2) : chat.editableCircuitJson,
      circuitJsonSyncError: '',
    }));
  };

  const rejectCircuitRevision = () => {
    updateActiveChat((chat) => {
      const previousSpice = chat.pendingSpiceChange?.previous;
      const previousKicad = chat.pendingKicadChange?.previous;
      if (!chat.result || (!previousSpice && !previousKicad)) {
        return { ...chat, pendingSpiceChange: null, pendingKicadChange: null };
      }

      const parsed = previousSpice
        ? parseSpiceNetlist(previousSpice, chat.result.circuit)
        : parseKiCadNetlist(previousKicad, chat.result.circuit);
      if (!parsed.ok) {
        return {
          ...chat,
          editableSpice: previousSpice || chat.editableSpice,
          editableKicadNetlist: previousKicad || chat.editableKicadNetlist,
          editableCircuitJson: chat.result?.circuit ? JSON.stringify(chat.result.circuit, null, 2) : chat.editableCircuitJson,
          pendingSpiceChange: null,
          pendingKicadChange: null,
          circuitJsonSyncError: '',
        };
      }

      const synchronized = synchronizeResult(
        chat.result,
        parsed.circuit,
        chat.editedDiagram || chat.result.diagram,
        {
          ...(previousSpice ? { spice: previousSpice } : {}),
          ...(previousKicad ? { kicadNetlist: previousKicad } : {}),
        },
      );
      return {
        ...chat,
        result: synchronized,
        editableSpice: previousSpice || synchronized.spice,
        editableKicadNetlist: previousKicad || synchronized.kicadNetlist,
        editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
        editedDiagram: synchronized.diagram,
        pendingSpiceChange: null,
        pendingKicadChange: null,
        simulationRun: null,
        simulationError: '',
        spiceSyncError: '',
        kicadSyncError: '',
        circuitJsonSyncError: '',
      };
    });
  };

  const renderReviewActions = (label) => (
    <span className="netlist-review-actions" aria-label={`Review AI ${label} changes`}>
      <button
        className="netlist-review-button accept"
        onClick={acceptCircuitRevision}
        type="button"
        aria-label={`Accept ${label} changes`}
        title="Accept changes"
      >
        &#10003;
      </button>
      <button
        className="netlist-review-button reject"
        onClick={rejectCircuitRevision}
        type="button"
        aria-label={`Reject ${label} changes`}
        title="Reject changes"
      >
        &times;
      </button>
    </span>
  );

  const renderChangedCode = (text, changedLines, label) => {
    const lastChangedLine = changedLines.size
      ? Math.max(...changedLines)
      : text.split('\n').length - 1;
    return (
      <pre className="code-editor editor-window-code netlist-diff" aria-label={`Pending ${label} changes`}>
        {text.split('\n').map((line, index) => {
          const changed = changedLines.has(index);
          return (
            <span className={`diff-line ${changed ? 'changed' : ''}`} key={`${index}-${line}`}>
              <code>{line || ' '}</code>
              {index === lastChangedLine && renderReviewActions(label)}
            </span>
          );
        })}
      </pre>
    );
  };

  const selectedDiagramComponent = diagramSelection?.type === 'component'
    ? (editedDiagram || result?.diagram)?.components.find((component) => component.ref === diagramSelection.ref)
    : null;
  const selectedEditableComponent = selectedDiagramComponent?.symbolType === 'ground'
    ? null
    : selectedDiagramComponent;

  const renderSpiceView = () => (
    <div className="editor-window-body code-window-body">
      <div className="editor-header">
        <div>
          <h3>SPICE deck</h3>
          <p>
            {isGenerating
              ? 'AI is updating this deck in real time.'
              : result
                ? ''
                : 'The live deck will appear here while the AI generates the circuit.'}
          </p>
        </div>
        <div className="spice-editor-actions">
          <button
            className="play-simulation-button"
            onClick={runSimulation}
            disabled={!result || isSimulating || isGenerating}
            type="button"
            aria-label={isSimulating ? 'Simulation running' : 'Run simulation'}
            title={isSimulating ? 'Simulation running' : 'Run simulation'}
          >
            <span aria-hidden="true">{isSimulating ? '...' : '\u25B6'}</span>
          </button>
          <button onClick={() => { setEditableSpice(result?.spice || ''); setSimulationRun(null); setSimulationError(''); }} disabled={!result || isGenerating || Boolean(pendingSpiceChange)}>Reset</button>
          <button onClick={() => downloadText('generated.cir', editableSpice)} disabled={!editableSpice || isGenerating}>Download</button>
        </div>
      </div>
      {pendingSpiceChange
        ? renderChangedCode(editableSpice, pendingSpiceChangedLines, 'SPICE')
        : (
          <textarea
            ref={spiceEditorRef}
            className={`code-editor editor-window-code ${isGenerating ? 'live-code-editor' : ''}`}
            value={editableSpice}
            readOnly={isGenerating}
            onChange={(event) => {
              setEditableSpice(event.target.value);
              setSimulationRun(null);
              setSimulationError('');
            }}
            spellCheck="false"
            rows={24}
            aria-label="Editable SPICE deck"
            placeholder="Generate a circuit to create a SPICE deck."
          />
        )}
      <div className="spice-simulation-results">
        {spiceSyncError && <p className="inline-error simulation-message">Canvas sync paused: {spiceSyncError}</p>}
        {simulationError && <p className="inline-error simulation-message">{simulationError}</p>}
        {simulationRun?.ok && (
          <p className="simulation-ok">
            Simulation completed successfully. <button className="text-button" onClick={() => { window.location.hash = 'waveform'; setPage('waveform'); }}>Open waveform page</button>
          </p>
        )}
        {simulationRun?.rawOutput && (
          <details className="sim-log">
            <summary>Ngspice log</summary>
            <pre>{simulationRun.rawOutput}</pre>
          </details>
        )}
      </div>
    </div>
  );

  const renderCanvasView = () => (
    <div className="editor-window-body canvas-window-body">
      {!result ? (
        <div className="editor-window-empty">
          <strong>No canvas available</strong>
          <p>Generate a circuit to open its editable schematic canvas.</p>
        </div>
      ) : (
        <>
          <div className="canvas-window-toolbar">
            <div className="canvas-tool-stack">
              <div className="diagram-editbar" aria-label="Diagram tools">
                <button className={diagramTool === 'select' ? 'active-tool' : ''} onClick={() => { setDiagramTool('select'); setPendingTerminal(null); }}>Select</button>
                <button className={diagramTool === 'wire' ? 'active-tool' : ''} onClick={() => { setDiagramTool('wire'); setPendingTerminal(null); }}>Wire</button>
                {ADD_COMPONENT_TOOLS.map((tool) => (
                  <button
                    className="component-symbol-button"
                    key={tool.type}
                    onClick={() => addDiagramComponent(tool.type)}
                    title={tool.label}
                    type="button"
                    aria-label={tool.label}
                  >
                    <ComponentToolIcon type={tool.type} />
                  </button>
                ))}
                <button onClick={deleteDiagramSelection} disabled={!diagramSelection}>Delete</button>
              </div>
              {selectedEditableComponent && (
                <label className="component-value-editor">
                  <span>{selectedEditableComponent.ref} value</span>
                  <input
                    type="text"
                    value={selectedEditableComponent.value}
                    onChange={(event) => updateSelectedComponentValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                        setDiagramSelection(null);
                      }
                    }}
                    aria-label={`Value for ${selectedEditableComponent.ref}`}
                    spellCheck="false"
                  />
                </label>
              )}
            </div>
            <div className="button-row">
              <button onClick={() => applyDiagramChange(() => layoutCircuitDiagram(result.circuit, { slots: true }))}>Auto-layout</button>
              <button onClick={() => setEditedDiagram(cloneDiagram(result.diagram))}>Reset</button>
              <button onClick={() => downloadText('generated.svg', toDiagramSvg(editedDiagram || result.diagram), 'image/svg+xml')}>Download SVG</button>
            </div>
          </div>
          <CircuitDiagram
            diagram={editedDiagram || result.diagram}
            onChange={applyDiagramChange}
            tool={diagramTool}
            selected={diagramSelection}
            onSelect={setDiagramSelection}
            pendingTerminal={pendingTerminal}
            onPendingTerminal={setPendingTerminal}
          />
        </>
      )}
    </div>
  );

  const renderJsonView = () => (
    <div className="editor-window-body code-window-body">
      <div className="editor-header">
        <div>
          <h3>Circuit JSON</h3>
          <p>{result ? '' : 'Generate a circuit to inspect its structured JSON.'}</p>
        </div>
        <div className="spice-editor-actions">
          <button
            onClick={() => {
              setEditableCircuitJson(result?.circuit ? JSON.stringify(result.circuit, null, 2) : '');
              setChatField('circuitJsonSyncError', '');
            }}
            disabled={!result || isGenerating}
          >
            Reset
          </button>
          <button
            onClick={() => downloadText('circuit.json', circuitJson, 'application/json')}
            disabled={!circuitJson || isGenerating}
          >
            Download
          </button>
        </div>
      </div>
      <textarea
        className={`code-editor editor-window-code ${isGenerating ? 'live-code-editor' : ''}`}
        value={editableCircuitJson}
        readOnly={isGenerating || !result}
        onChange={(event) => {
          setEditableCircuitJson(event.target.value);
          setSimulationRun(null);
          setSimulationError('');
        }}
        spellCheck="false"
        rows={24}
        aria-label="Editable circuit JSON"
        placeholder="Generate a circuit to inspect and edit the JSON."
      />
      {circuitJsonSyncError && <p className="inline-error simulation-message">JSON sync paused: {circuitJsonSyncError}</p>}
    </div>
  );

  const renderBlockSchematicView = () => (
    <div className="editor-window-body canvas-window-body">
      {!result ? (
        <div className="editor-window-empty">
          <strong>No schematic available</strong>
          <p>Generate a circuit to view its block schematic.</p>
        </div>
      ) : (
        <BlockSchematic circuit={result.circuit} />
      )}
    </div>
  );

  const renderRealisticSchematicView = () => (
    <div className="editor-window-body canvas-window-body">
      {!result ? (
        <div className="editor-window-empty">
          <strong>No breadboard available</strong>
          <p>Generate a circuit to view its breadboard build.</p>
        </div>
      ) : (
        <RealisticSchematic circuit={result.circuit} />
      )}
    </div>
  );

  const renderEditorWindow = (view) => {
    const isMaximized = maximizedEditorView === view;
    return (
      <article
        className={`editor-window ${activeEditorView === view ? 'active' : ''} ${isMaximized ? 'maximized' : ''}`}
        key={view}
        onMouseDown={() => setActiveEditorView(view)}
      >
        <header className="editor-window-titlebar">
          <strong>{EDITOR_VIEW_LABELS[view]}</strong>
          <div className="editor-window-controls">
            <button
              className="editor-window-control"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => toggleMaximizeEditorView(view)}
              type="button"
              aria-pressed={isMaximized}
              aria-label={`${isMaximized ? 'Restore' : 'Maximize'} ${EDITOR_VIEW_LABELS[view]}`}
              title={isMaximized ? 'Restore' : 'Maximize'}
            >
              {isMaximized ? (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                  <rect x="2.5" y="5" width="8.5" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M5.5 5V3.2A1.7 1.7 0 0 1 7.2 1.5h6A1.3 1.3 0 0 1 14.5 2.8v6a1.7 1.7 0 0 1-1.7 1.7H11" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                  <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </button>
            <button
              className="editor-window-control editor-window-close"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => closeEditorView(view)}
              type="button"
              aria-label={`Close ${EDITOR_VIEW_LABELS[view]}`}
              title={`Close ${EDITOR_VIEW_LABELS[view]}`}
            >
              &times;
            </button>
          </div>
        </header>
        {view === 'spice' && renderSpiceView()}
        {view === 'json' && renderJsonView()}
        {view === 'canvas' && renderCanvasView()}
        {view === 'blockSchematic' && renderBlockSchematicView()}
        {view === 'realisticSchematic' && renderRealisticSchematicView()}
      </article>
    );
  };

  const adjustEditorSplit = (axis, amount) => {
    const minimum = axis === 'columns' ? 25 : 32;
    const maximum = axis === 'columns' ? 75 : 72;
    setEditorSplit((current) => ({
      ...current,
      [axis]: Math.min(maximum, Math.max(minimum, current[axis] + amount)),
    }));
  };

  const renderResizeHandle = (axis) => (
    <div
      className={`editor-resize-handle ${axis}`}
      role="separator"
      aria-label={`Resize editor windows ${axis === 'columns' ? 'horizontally' : 'vertically'}`}
      aria-orientation={axis === 'columns' ? 'vertical' : 'horizontal'}
      aria-valuemin={axis === 'columns' ? 25 : 32}
      aria-valuemax={axis === 'columns' ? 75 : 72}
      aria-valuenow={Math.round(editorSplit[axis])}
      tabIndex={0}
      onPointerDown={(event) => startEditorResize(axis, event)}
      onPointerMove={moveEditorResize}
      onPointerUp={stopEditorResize}
      onPointerCancel={stopEditorResize}
      onKeyDown={(event) => {
        const decrease = axis === 'columns' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
        const increase = axis === 'columns' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
        if (!decrease && !increase) return;
        event.preventDefault();
        adjustEditorSplit(axis, decrease ? -5 : 5);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );

  const renderEditorLayout = () => {
    if (maximizedEditorView && openEditorViews.includes(maximizedEditorView)) {
      return (
        <section className="editor-window-layout single maximized">
          {renderEditorWindow(maximizedEditorView)}
        </section>
      );
    }

    if (openEditorViews.length === 1) {
      return <section className="editor-window-layout single">{renderEditorWindow(openEditorViews[0])}</section>;
    }

    if (openEditorViews.length === 2) {
      return (
        <section
          className={`editor-window-layout split-two ${resizingAxis ? `resizing-${resizingAxis}` : ''}`}
          style={{ '--column-split': `${editorSplit.columns}%` }}
        >
          {renderEditorWindow(openEditorViews[0])}
          {renderResizeHandle('columns')}
          {renderEditorWindow(openEditorViews[1])}
        </section>
      );
    }

    return (
      <section
        className={`editor-window-layout split-three ${resizingAxis ? `resizing-${resizingAxis}` : ''}`}
        style={{ '--column-split': `${editorSplit.columns}%`, '--row-split': `${editorSplit.rows}%` }}
      >
        <div className="editor-split-row">
          {renderEditorWindow(openEditorViews[0])}
          {renderResizeHandle('columns')}
          {renderEditorWindow(openEditorViews[1])}
        </div>
        {renderResizeHandle('rows')}
        {renderEditorWindow(openEditorViews[2])}
      </section>
    );
  };

  if (loading) return <div className="loading-screen">Loading...</div>;

  const visiblePage = user && AUTH_PAGES.has(page) ? 'workspace' : page;

  if (!user && !PUBLIC_PAGES.has(visiblePage)) return <HomePage />;
  if (visiblePage === 'home') return <HomePage />;
  if (visiblePage === 'login') return <LoginPage />;
  if (visiblePage === 'signup') return <SignupPage />;
  if (visiblePage === 'verify') return <VerifyPage />;

  if (visiblePage === 'waveform') {
    return (
      <main className="app-shell waveform-page-shell">
        <section className="waveform-page">
          <header className="waveform-page-header">
            <div>
              <p className="eyebrow">Ngspice waveform</p>
              <h1>{result?.circuit?.title || 'Simulation waveform'}</h1>
            </div>
            <button onClick={showWorkspace}>Back to generator</button>
          </header>

          {!simulationRun?.waveform?.series?.length ? (
            <section className="panel-block empty-waveform-page">
              <h2>No waveform data yet</h2>
              <p>Run a successful simulation from the play button in the Spice tab to open the waveform here.</p>
            </section>
          ) : (
            <section className="panel-block waveform-page-panel">
              <div className="waveform-page-summary">
                <div>
                  <h2>{result?.simulation?.engine || 'Simulation complete'}</h2>
                  <p>{simulationRun.waveform.series.length} plotted signal{simulationRun.waveform.series.length === 1 ? '' : 's'} from the current SPICE deck.</p>
                </div>
                <button onClick={() => downloadText('ngspice-log.txt', simulationRun.rawOutput || '')} disabled={!simulationRun.rawOutput}>
                  Download log
                </button>
              </div>
              <WaveformChart waveform={simulationRun.waveform} />
              {simulationRun.rawOutput && (
                <details className="sim-log">
                  <summary>Ngspice log</summary>
                  <pre>{simulationRun.rawOutput}</pre>
                </details>
              )}
            </section>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="user-bar app-user-bar">
        <span>{user.email}</span>
        <button type="button" onClick={logout}>Log out</button>
      </div>
      <section className="workspace">
        <ChatPanel
          chatPanelView={chatPanelView}
          setChatPanelView={setChatPanelView}
          newChatPrompt={newChatPrompt}
          setNewChatPrompt={setNewChatPrompt}
          startChatFromHistory={startChatFromHistory}
          handleNewChatComposerKeyDown={handleNewChatComposerKeyDown}
          chatStore={chatStore}
          sortedChats={sortedChats}
          activeChat={activeChat}
          openChat={openChat}
          isGenerating={isGenerating}
          generationStage={generationStage}
          messagesEndRef={messagesEndRef}
          prompt={prompt}
          setPrompt={setPrompt}
          handleComposerKeyDown={handleComposerKeyDown}
          generate={generate}
          generationBusy={generationBusy}
          error={error}
        />

        <section className="main-panel editor-workbench">
          <nav className="editor-launchbar" aria-label="Editor windows">
            {Object.entries(EDITOR_VIEW_LABELS).map(([view, label]) => {
              const isOpen = openEditorViews.includes(view);
              return (
                <button
                  className={`${isOpen ? 'open' : ''} ${activeEditorView === view ? 'active' : ''}`}
                  key={view}
                  onClick={() => openEditorView(view)}
                  type="button"
                >
                  {isOpen ? label : `+ ${label}`}
                </button>
              );
            })}
          </nav>

          {openEditorViews.length === 0 ? (
            <section className="workbench-empty">
              <h3>All editor windows are closed</h3>
              <p>Open Spice or Canvas from the bar above.</p>
            </section>
          ) : (
            renderEditorLayout()
          )}
        </section>
      </section>
    </main>
  );
}

export default function WrappedApp() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
