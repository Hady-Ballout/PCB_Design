// Shared editor-window labels and split-pane persistence.
// The SPICE, JSON, Block schematic, and Schematic (canvas/KiCad) tabs were
// retired from the launchbar; their render code and the SPICE data/simulation
// pipeline stay in App.jsx (dead but restorable). pcb3d is the three.js board
// viewer.
// Listed in workflow order: the top bar renders them left to right with
// arrows between, so the order is the product's mental model.
export const EDITOR_VIEW_LABELS = {
  realisticSchematic: 'Breadboard',
  code: 'Code',
  pcb3d: '3D PCB',
};

export const EDITOR_SPLIT_STORAGE_KEY = 'prompt-to-pcb-editor-split-v1';

export const clampEditorSplit = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};

export const loadEditorSplit = () => {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(EDITOR_SPLIT_STORAGE_KEY) || 'null');
    return {
      columns: clampEditorSplit(saved?.columns, 25, 75, 50),
      rows: clampEditorSplit(saved?.rows, 32, 72, 58),
    };
  } catch {
    return { columns: 50, rows: 58 };
  }
};
