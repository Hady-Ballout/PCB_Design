// Breadboard geometry: board constants plus hole-address -> pixel math for the
// realistic-schematic view. No React imports so it stays unit-testable.
//
// A hole address is `{ strip, column, row }` where `strip` is one of the keys of
// STRIP_BASE_ROW, `column` is 1-based across the board, and `row` is the 0-based
// row within the strip (terminal strips have 5 rows per tie group, rails have 1).

export const HOLE_PITCH = 14; // px per 0.1" pitch
export const DEFAULT_COLUMNS = 30; // half-size board
export const FULL_SIZE_COLUMNS = 63;
export const BOARD_MARGIN_LEFT = 130; // off-board space reserved for battery packs
export const BOARD_PAD_X = HOLE_PITCH * 1.5;

// First hole row of each strip, in pitch units from the top of the drawing.
// Top rails, terminal strip a-e, the DIP trench, strip f-j, bottom rails.
// The rail-to-strip gaps are wider than a real board so part bodies and their
// labels have room to sit above their holes without covering the rails.
export const STRIP_BASE_ROW = {
  railTopPlus: 1.5,
  railTopMinus: 2.5,
  top: 6,
  bottom: 13,
  railBottomPlus: 19.5,
  railBottomMinus: 20.5,
};

export const STRIP_ROWS = {
  railTopPlus: 1,
  railTopMinus: 1,
  top: 5,
  bottom: 5,
  railBottomPlus: 1,
  railBottomMinus: 1,
};

export const TOP_STRIP_ROW_LETTERS = ['a', 'b', 'c', 'd', 'e'];
export const BOTTOM_STRIP_ROW_LETTERS = ['f', 'g', 'h', 'i', 'j'];

const TOTAL_ROWS = 22.5;
export const TRENCH_CENTER_Y = HOLE_PITCH * 11.5;
export const TRENCH_HALF_HEIGHT = HOLE_PITCH * 0.55;

// Extra room past the board's right edge for the rail net-name labels.
const RIGHT_LABEL_MARGIN = 26;

export const columnX = (column) => BOARD_MARGIN_LEFT + BOARD_PAD_X + (column - 1) * HOLE_PITCH;

export const holeCenter = (hole) => ({
  x: columnX(hole.column),
  y: (STRIP_BASE_ROW[hole.strip] + (hole.row || 0)) * HOLE_PITCH,
});

// --- inverse (board-space pixel -> hole address) --------------------------
// Used by the editor to snap a dropped pin/part to the breadboard hole under
// the pointer. The forward math above is the contract these invert.

// Nearest column for a board-space x. Unclamped; callers clamp to [1, columns].
export const columnAt = (x) => Math.round((x - BOARD_MARGIN_LEFT - BOARD_PAD_X) / HOLE_PITCH) + 1;

// Every addressable (strip, row) and its y center, precomputed once. There are
// only ~14 rows across the six strips, so a linear nearest-scan is trivial.
const ROW_LEVELS = Object.keys(STRIP_ROWS).flatMap((strip) =>
  Array.from({ length: STRIP_ROWS[strip] }, (_, row) => ({ strip, row, y: (STRIP_BASE_ROW[strip] + row) * HOLE_PITCH })));

// Nearest hole to a board-space point, or null if the point lands in a gap
// (the trench, the rail-to-strip spacing, or off the column grid) — i.e. no
// hole center is within `tolerance` px on both axes. Returns {strip,column,row}.
export const holeAt = (point, columns, tolerance = HOLE_PITCH * 0.6) => {
  if (!point) return null;
  const column = Math.max(1, Math.min(columns, columnAt(point.x)));
  if (Math.abs(columnX(column) - point.x) > tolerance) return null;
  let best = null;
  for (const level of ROW_LEVELS) {
    const dy = Math.abs(level.y - point.y);
    if (best === null || dy < best.dy) best = { strip: level.strip, row: level.row, dy };
  }
  if (!best || best.dy > tolerance) return null;
  return { strip: best.strip, column, row: best.row };
};

// Electrical tie-group identity of a hole: a rail row ties across every column
// (keyed by strip name), a terminal-strip column ties its 5 rows vertically
// (keyed "strip:column"). Mirrors the groupKey/rail logic in breadboardModel.
export const isRailStrip = (strip) => STRIP_ROWS[strip] === 1;
export const tieGroupKey = (hole) =>
  (isRailStrip(hole.strip) ? hole.strip : `${hole.strip}:${hole.column}`);

// Map client coordinates into the SVG's viewBox space, using the element's real
// screen transform so viewBox scaling and the preserveAspectRatio letterbox are
// both accounted for (a plain box-ratio mapping drifts when the element aspect
// differs from the viewBox aspect). Mirrors svgPointer in
// ../schematic/geometry.js; duplicated here to keep this feature chunk from
// importing another feature chunk. Returns viewBox coords — the frame of the
// pan/zoom <g>; divide out its translate/scale for board space.
export const clientToViewBox = (svg, clientX, clientY, width, height) => {
  const ctm = svg?.getScreenCTM?.();
  if (ctm && typeof DOMPoint !== 'undefined') {
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }
  const rect = svg?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: width || 1, height: height || 1 };
  return {
    x: ((clientX - rect.left) / rect.width) * width,
    y: ((clientY - rect.top) / rect.height) * height,
  };
};

// Board space (inside the pan/zoom <g>) from a viewBox point and the current
// view transform { tx, ty, s }. Inverse of translate(tx,ty) scale(s).
export const viewBoxToBoard = (point, view) => ({
  x: (point.x - view.tx) / view.s,
  y: (point.y - view.ty) / view.s,
});

// Off-board microcontroller boards (Arduino Uno, Raspberry Pi) sit in a stack
// of fixed-height slots below the breadboard, one board per slot. Their header
// pins fan out upward to the bottom strip and rails.
export const MCU_SLOT_HEIGHT = 292; // tall enough for a true ~1.3:1 board aspect
export const MCU_SLOT_GAP = 14;
export const MCU_MARGIN_TOP = 20; // gap between the board body and the first slot
export const MCU_PIN_SPACING = 2 * HOLE_PITCH; // px between header pads

export const mcuSlotRect = (index, columns) => ({
  x: BOARD_MARGIN_LEFT,
  y: TOTAL_ROWS * HOLE_PITCH + MCU_MARGIN_TOP + index * (MCU_SLOT_HEIGHT + MCU_SLOT_GAP),
  width: Math.min(BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH, 470),
  height: MCU_SLOT_HEIGHT,
});

// Full drawing size including the off-board battery margin, label gutter, and
// any microcontroller slots below the board.
export const boardSize = (columns, mcuSlots = 0) => ({
  width: BOARD_MARGIN_LEFT + BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH + RIGHT_LABEL_MARGIN,
  height: TOTAL_ROWS * HOLE_PITCH
    + (mcuSlots > 0 ? MCU_MARGIN_TOP + mcuSlots * (MCU_SLOT_HEIGHT + MCU_SLOT_GAP) : 0),
});

// The plastic board body rectangle (excludes the battery margin).
export const boardBody = (columns) => ({
  x: BOARD_MARGIN_LEFT,
  y: HOLE_PITCH * 0.6,
  width: BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH,
  height: (TOTAL_ROWS - 1.2) * HOLE_PITCH,
});
