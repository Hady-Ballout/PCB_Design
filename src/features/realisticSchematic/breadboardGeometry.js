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

// Off-board slot geometry for MCU boards (arduino_uno, raspberry_pi): each
// gets its own fixed-height strip stacked below the breadboard body.
export const MCU_SLOT_HEIGHT = 150;
export const MCU_SLOT_GAP = 14;
export const MCU_MARGIN_TOP = 20;
export const MCU_PIN_SPACING = HOLE_PITCH * 2;

const BASE_HEIGHT = TOTAL_ROWS * HOLE_PITCH;

export const columnX = (column) => BOARD_MARGIN_LEFT + BOARD_PAD_X + (column - 1) * HOLE_PITCH;

export const holeCenter = (hole) => ({
  x: columnX(hole.column),
  y: (STRIP_BASE_ROW[hole.strip] + (hole.row || 0)) * HOLE_PITCH,
});

// Full drawing size including the off-board battery margin and label gutter,
// plus room for any stacked MCU slots below the board.
export const boardSize = (columns, mcuSlots = 0) => ({
  width: BOARD_MARGIN_LEFT + BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH + RIGHT_LABEL_MARGIN,
  height: BASE_HEIGHT + (mcuSlots > 0 ? MCU_MARGIN_TOP + mcuSlots * (MCU_SLOT_HEIGHT + MCU_SLOT_GAP) : 0),
});

// Rect for the index-th (0-based) off-board MCU slot, stacked below the board.
export const mcuSlotRect = (index, columns) => ({
  x: BOARD_MARGIN_LEFT,
  y: BASE_HEIGHT + MCU_MARGIN_TOP + index * (MCU_SLOT_HEIGHT + MCU_SLOT_GAP),
  width: Math.min(BOARD_MARGIN_LEFT + BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH, 470),
  height: MCU_SLOT_HEIGHT,
});

// The plastic board body rectangle (excludes the battery margin).
export const boardBody = (columns) => ({
  x: BOARD_MARGIN_LEFT,
  y: HOLE_PITCH * 0.6,
  width: BOARD_PAD_X * 2 + (columns - 1) * HOLE_PITCH,
  height: (TOTAL_ROWS - 1.2) * HOLE_PITCH,
});
