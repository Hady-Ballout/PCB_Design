import { describe, expect, it } from 'vitest';
import { footprintRecordFor } from './pcbFootprints.js';
import {
  BOARD_MARGIN,
  PLACEMENT_GAP,
  placeComponents,
  placementBounds,
  placementPads,
} from './pcbPlace.js';

// A voltage divider feeding a unity-ish op-amp stage: several nets with two to
// four pads each, mixed footprint sizes.
const dividerParts = [
  { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
  { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VIN', 'VMID'] },
  { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VMID', '0'] },
  { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VMID', '0'] },
  { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['VMID', 'FB', 'OUT', 'VIN', '0'] },
  { ref: 'R3', kind: 'resistor', value: '22k', nodes: ['OUT', 'FB'] },
];

const inflate = (box, amount) => ({
  minX: box.minX - amount,
  minY: box.minY - amount,
  maxX: box.maxX + amount,
  maxY: box.maxY + amount,
});

const overlaps = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

// Prim MST over Manhattan distances — the same wirelength measure the router
// ends up paying for a net.
const netTreeLength = (pads) => {
  if (pads.length < 2) return 0;
  const inTree = [pads[0]];
  const remaining = pads.slice(1);
  let total = 0;
  while (remaining.length) {
    let best = null;
    for (const candidate of remaining) {
      for (const anchor of inTree) {
        const cost = Math.abs(candidate.x - anchor.x) + Math.abs(candidate.y - anchor.y);
        if (!best || cost < best.cost) best = { candidate, cost };
      }
    }
    total += best.cost;
    inTree.push(best.candidate);
    remaining.splice(remaining.indexOf(best.candidate), 1);
  }
  return total;
};

const wirelength = (pads) => {
  const byNet = new Map();
  for (const pad of pads) {
    if (!byNet.has(pad.net)) byNet.set(pad.net, []);
    byNet.get(pad.net).push(pad);
  }
  return [...byNet.values()].reduce((sum, netPads) => sum + netTreeLength(netPads), 0);
};

// The placement this module replaces: pack cells left to right into rows
// aiming at a 4:3 board, ignoring the netlist entirely.
const rowPackedPads = (parts) => {
  const gap = 5;
  const margin = 4;
  const items = parts.map((part) => {
    const { record, padOrder } = footprintRecordFor(part);
    const width = record.courtyard.maxX - record.courtyard.minX;
    const height = record.courtyard.maxY - record.courtyard.minY;
    return { part, record, padOrder, cellWidth: width + gap, cellHeight: height + gap };
  });
  const totalArea = items.reduce((sum, item) => sum + item.cellWidth * item.cellHeight, 0);
  const targetWidth = Math.max(
    Math.sqrt(totalArea * (4 / 3)),
    Math.max(...items.map((item) => item.cellWidth)),
  );
  const pads = [];
  let cursorX = margin;
  let cursorY = margin;
  let rowHeight = 0;
  for (const item of items) {
    if (cursorX > margin && cursorX + item.cellWidth > targetWidth + margin) {
      cursorX = margin;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    const x = cursorX + item.cellWidth / 2;
    const y = cursorY + item.cellHeight / 2;
    const byNumber = new Map(item.record.pads.map((pad) => [pad.number, pad]));
    item.part.nodes.forEach((node, index) => {
      const pad = byNumber.get(item.padOrder[index]);
      pads.push({ net: node, x: x + pad.x, y: y + pad.y });
    });
    cursorX += item.cellWidth;
    rowHeight = Math.max(rowHeight, item.cellHeight);
  }
  return pads;
};

describe('placeComponents', () => {
  const { placements, board } = placeComponents(dividerParts);

  it('places every part exactly once', () => {
    expect(placements.map((placement) => placement.part.ref).sort())
      .toEqual(dividerParts.map((part) => part.ref).sort());
  });

  it('keeps every courtyard inside the board outline, clear of the margin', () => {
    for (const placement of placements) {
      const bounds = placementBounds(placement);
      expect(bounds.minX).toBeGreaterThanOrEqual(BOARD_MARGIN - 0.01);
      expect(bounds.minY).toBeGreaterThanOrEqual(BOARD_MARGIN - 0.01);
      expect(bounds.maxX).toBeLessThanOrEqual(board.width - BOARD_MARGIN + 0.01);
      expect(bounds.maxY).toBeLessThanOrEqual(board.height - BOARD_MARGIN + 0.01);
    }
    expect(board.width).toBe(Math.ceil(board.width));
    expect(board.height).toBe(Math.ceil(board.height));
  });

  it('keeps a placement gap between every pair of courtyards', () => {
    for (let a = 0; a < placements.length; a += 1) {
      for (let b = a + 1; b < placements.length; b += 1) {
        const boxA = inflate(placementBounds(placements[a]), PLACEMENT_GAP / 2);
        const boxB = inflate(placementBounds(placements[b]), PLACEMENT_GAP / 2);
        expect(overlaps(boxA, boxB)).toBe(false);
      }
    }
  });

  it('is deterministic across runs', () => {
    const first = placeComponents(dividerParts);
    const second = placeComponents(dividerParts);
    expect(first).toEqual(second);
  });

  it('puts each pad on its node, rotated with the footprint', () => {
    for (const placement of placements) {
      const pads = placementPads(placement);
      expect(pads.map((pad) => pad.net)).toEqual(placement.part.nodes);
      for (const pad of pads) {
        const bounds = placementBounds(placement);
        expect(pad.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(pad.x).toBeLessThanOrEqual(bounds.maxX);
        expect(pad.y).toBeGreaterThanOrEqual(bounds.minY);
        expect(pad.y).toBeLessThanOrEqual(bounds.maxY);
      }
    }
  });

  it('shortens total net wirelength versus naive row packing', () => {
    const placed = placements.flatMap((placement) => placementPads(placement));
    expect(wirelength(placed)).toBeLessThan(wirelength(rowPackedPads(dividerParts)));
  });

  it('assigns parts to positions better than a net-blind reshuffle', () => {
    // Same slots (centre + rotation), parts rotated between them: if the placer
    // were only packing tightly and ignoring the netlist, some reshuffle would
    // do at least as well as the assignment it chose.
    const own = wirelength(placements.flatMap((placement) => placementPads(placement)));
    for (let shift = 1; shift < placements.length; shift += 1) {
      const shuffled = placements.map((placement, index) => {
        const donor = placements[(index + shift) % placements.length];
        return { ...placement, part: donor.part, footprint: donor.footprint, padOrder: donor.padOrder };
      });
      expect(own).toBeLessThan(wirelength(shuffled.flatMap((placement) => placementPads(placement))));
    }
  });

  it('keeps parts that share nets closer than parts that do not', () => {
    // Two independent triangles: A1-A2-A3 share nets, B1-B2-B3 share nets, and
    // nothing crosses between the groups.
    const groups = [
      { ref: 'A1', kind: 'resistor', nodes: ['NA1', 'NA2'] },
      { ref: 'A2', kind: 'resistor', nodes: ['NA2', 'NA3'] },
      { ref: 'A3', kind: 'resistor', nodes: ['NA3', 'NA1'] },
      { ref: 'B1', kind: 'resistor', nodes: ['NB1', 'NB2'] },
      { ref: 'B2', kind: 'resistor', nodes: ['NB2', 'NB3'] },
      { ref: 'B3', kind: 'resistor', nodes: ['NB3', 'NB1'] },
    ];
    const result = placeComponents(groups);
    const distances = { same: [], cross: [] };
    for (let a = 0; a < result.placements.length; a += 1) {
      for (let b = a + 1; b < result.placements.length; b += 1) {
        const left = result.placements[a];
        const right = result.placements[b];
        const distance = Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
        const bucket = left.part.ref[0] === right.part.ref[0] ? 'same' : 'cross';
        distances[bucket].push(distance);
      }
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(distances.same)).toBeLessThan(mean(distances.cross));
  });

  it('rotates a part when the orientation shortens its connections', () => {
    // A 1x08 header is tall and narrow with its pads stacked vertically; a
    // resistor bridging two adjacent header pins only fits alongside the
    // header, where a vertical resistor reaches both pins far more directly
    // than a horizontal one.
    const parts = [
      { ref: 'J1', kind: 'keypad', nodes: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] },
      { ref: 'R1', kind: 'resistor', nodes: ['P1', 'P2'] },
    ];
    const result = placeComponents(parts);
    const resistor = result.placements.find((placement) => placement.part.ref === 'R1');
    expect([90, 270]).toContain(resistor.rotation);
  });

  it('spreads the board out for a larger expandFactor', () => {
    const expanded = placeComponents(dividerParts, { expandFactor: 1.35 });
    expect(expanded.board.width * expanded.board.height)
      .toBeGreaterThan(board.width * board.height);
    expect(expanded.board.width).toBeGreaterThanOrEqual(board.width);
    expect(expanded.board.height).toBeGreaterThanOrEqual(board.height);
    for (let a = 0; a < expanded.placements.length; a += 1) {
      for (let b = a + 1; b < expanded.placements.length; b += 1) {
        const boxA = inflate(placementBounds(expanded.placements[a]), PLACEMENT_GAP / 2);
        const boxB = inflate(placementBounds(expanded.placements[b]), PLACEMENT_GAP / 2);
        expect(overlaps(boxA, boxB)).toBe(false);
      }
    }
  });

  it('returns an empty placement for an empty part list', () => {
    const empty = placeComponents([]);
    expect(empty.placements).toEqual([]);
    expect(empty.board.width).toBeGreaterThan(0);
  });

  it('swaps rotated pad size and folds angle for a 90/270-rotated non-square pad', () => {
    // TO-92_Inline pads are 1.05 (w) x 1.5 (h) rectangles/ovals — at 90/270
    // the footprint-local w/h axes swap in board space, so the emitted pad
    // geometry must swap too or the Gerber output will be misoriented.
    const part = { ref: 'Q1', kind: 'bjt_npn', nodes: ['C', 'B', 'E'] };
    const { libId, record, padOrder } = footprintRecordFor(part);
    const unrotatedPad = record.pads.find((pad) => pad.number === padOrder[0]);

    for (const rotation of [90, 270]) {
      const placement = { part, footprint: record, libId, padOrder, x: 0, y: 0, rotation };
      const [pad] = placementPads(placement);
      expect(pad.pad.size).toEqual({ w: unrotatedPad.size.h, h: unrotatedPad.size.w });
      expect(pad.pad.angle).toBe(((unrotatedPad.angle ?? 0) + rotation) % 180);
      expect(pad.pad.shape).toBe(unrotatedPad.shape);
    }

    for (const rotation of [0, 180]) {
      const placement = { part, footprint: record, libId, padOrder, x: 0, y: 0, rotation };
      const [pad] = placementPads(placement);
      expect(pad.pad.size).toEqual(unrotatedPad.size);
      expect(pad.pad.angle).toBe(((unrotatedPad.angle ?? 0) + rotation) % 180);
    }
  });
});
