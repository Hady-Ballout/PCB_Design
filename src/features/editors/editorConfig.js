// Shared editor-window labels and split-pane persistence.
// The SPICE, JSON, and Block schematic tabs were retired from the launchbar;
// their render code and the SPICE data/simulation pipeline stay in App.jsx
// (dead but restorable). Canvas hosts the KiCad/KiCanvas schematic view with
// an edit mode, and pcb3d is the three.js board viewer.
export const EDITOR_VIEW_LABELS = {
  code: 'Code',
  realisticSchematic: 'Realistic schematic',
  canvas: 'Schematic',
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
