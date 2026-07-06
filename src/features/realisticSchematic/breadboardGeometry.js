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

// Full drawing size including the off-board battery margin and label gutter.
export const boardSize = (columns) => ({
  width: BOARD_MARGIN_LEFT + BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH + RIGHT_LABEL_MARGIN,
  height: TOTAL_ROWS * HOLE_PITCH,
});

// The plastic board body rectangle (excludes the battery margin).
export const boardBody = (columns) => ({
  x: BOARD_MARGIN_LEFT,
  y: HOLE_PITCH * 0.6,
  width: BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH,
  height: (TOTAL_ROWS - 1.2) * HOLE_PITCH,
});
