// Shared editor-window labels and split-pane persistence.
export const EDITOR_VIEW_LABELS = {
  spice: 'SPICE',
  json: 'JSON',
  canvas: 'Canvas',
  blockSchematic: 'Block schematic',
  realisticSchematic: 'Realistic schematic',
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
