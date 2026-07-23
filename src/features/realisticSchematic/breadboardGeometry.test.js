import { describe, expect, it } from 'vitest';
import {
  HOLE_PITCH,
  columnAt,
  columnX,
  holeAt,
  holeCenter,
  tieGroupKey,
} from './breadboardGeometry.js';
import { circuitToBreadboard, netAtHole, GROUND_NET } from './breadboardModel.js';

const dividerCircuit = {
  title: 'Voltage divider',
  nodes: ['VCC', 'VOUT', '0'],
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'VOUT'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['VOUT', '0'] },
  ],
};

describe('columnAt', () => {
  it('inverts columnX for every column', () => {
    for (let column = 1; column <= 40; column += 1) {
      expect(columnAt(columnX(column))).toBe(column);
    }
  });

  it('snaps to the nearest column within half a pitch', () => {
    expect(columnAt(columnX(5) + HOLE_PITCH * 0.4)).toBe(5);
    expect(columnAt(columnX(5) + HOLE_PITCH * 0.6)).toBe(6);
  });
});

describe('holeAt', () => {
  const columns = 30;

  it('round-trips the center of every strip/row to its own address', () => {
    const strips = [['railTopPlus', 1], ['top', 5], ['bottom', 5], ['railBottomMinus', 1]];
    for (const [strip, rows] of strips) {
      for (let row = 0; row < rows; row += 1) {
        const hole = { strip, column: 7, row };
        expect(holeAt(holeCenter(hole), columns)).toEqual(hole);
      }
    }
  });

  it('returns null over the DIP trench (a gap with no hole row)', () => {
    // Trench sits between the top strip (last row) and bottom strip (first row).
    const between = {
      x: columnX(10),
      y: (holeCenter({ strip: 'top', column: 10, row: 4 }).y + holeCenter({ strip: 'bottom', column: 10, row: 0 }).y) / 2,
    };
    expect(holeAt(between, columns)).toBeNull();
  });

  it('returns null well past the board edges and clamps near-edge points', () => {
    const y = holeCenter({ strip: 'top', column: 1, row: 0 }).y;
    // Far right / far left of the column grid: no column is within tolerance.
    expect(holeAt({ x: columnX(columns) + HOLE_PITCH * 2, y }, columns)).toBeNull();
    expect(holeAt({ x: columnX(1) - HOLE_PITCH * 2, y }, columns)).toBeNull();
    // A point just past the last column snaps back to it, never beyond.
    expect(holeAt({ x: columnX(columns) + HOLE_PITCH * 0.3, y }, columns).column).toBe(columns);
  });
});

describe('tieGroupKey', () => {
  it('keys rail rows by strip and terminal columns by strip:column', () => {
    expect(tieGroupKey({ strip: 'railTopMinus', column: 4, row: 0 })).toBe('railTopMinus');
    expect(tieGroupKey({ strip: 'top', column: 4, row: 2 })).toBe('top:4');
  });
});

describe('netAtHole', () => {
  const model = circuitToBreadboard(dividerCircuit);

  it('reports the net on a terminal tie group holding a part pin', () => {
    const r1 = model.parts.find((part) => part.ref === 'R1');
    const hole = r1.holes.find(Boolean);
    expect(netAtHole(model, hole)).toBe(r1.pinNets[r1.holes.indexOf(hole)]);
  });

  it('reads a rail net straight off model.rails', () => {
    const railStrip = Object.keys(model.rails).find((strip) => model.rails[strip] === GROUND_NET);
    expect(netAtHole(model, { strip: railStrip, column: 3, row: 0 })).toBe(GROUND_NET);
  });

  it('returns null for an empty hole', () => {
    expect(netAtHole(model, { strip: 'top', column: 28, row: 4 })).toBeNull();
  });
});
