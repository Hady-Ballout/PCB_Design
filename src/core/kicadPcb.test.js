import { describe, expect, it } from 'vitest';
import { buildPcbLayout } from './pcbLayout.js';
import { toKiCadPcb } from './kicadPcb.js';

// A circuit small enough to place deterministically but rich enough to
// exercise a rotated footprint (C2 lands at rotation 90, R2 at rotation 180)
// and a mix of pad shapes (circle/oval/rect) and footprint families
// (TO-220, capacitor, resistor, LED).
const rotationCircuit = {
  title: 'KiCad PCB export test',
  components: [
    { ref: 'U1', kind: 'regulator', value: '7805', nodes: ['VIN', '0', 'VOUT'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['VOUT', 'A', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VOUT', 'A'] },
    { ref: 'R2', kind: 'resistor', value: '1k', nodes: ['A', '0'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VIN', '0'] },
    { ref: 'C2', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    { ref: 'D1', kind: 'led', value: 'red', nodes: ['A', '0'] },
  ],
};

const balancedParens = (text) => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
};

describe('toKiCadPcb', () => {
  const circuit = rotationCircuit;
  const layout = buildPcbLayout(circuit);
  const pcb = toKiCadPcb(layout, circuit);

  it('emits a balanced KiCad 6 s-expression document with the right header', () => {
    expect(pcb.startsWith('(kicad_pcb (version 20211014) (generator prompt_to_pcb)')).toBe(true);
    expect(balancedParens(pcb)).toBe(true);
    expect(pcb).toContain('(general\n    (thickness 1.6)\n  )');
    expect(pcb).toContain('(paper "A4")');
    expect(pcb).toContain('(pad_to_mask_clearance 0.05)');
  });

  it('emits the standard KiCad-6 layer table', () => {
    expect(pcb).toContain('(0 "F.Cu" signal)');
    expect(pcb).toContain('(31 "B.Cu" signal)');
    expect(pcb).toContain('(44 "Edge.Cuts" user)');
    expect(pcb).toContain('(49 "F.Fab" user)');
  });

  it('emits net 0 plus one net per layout net, sorted by name', () => {
    const netLines = [...pcb.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)];
    expect(netLines[0][1]).toBe('0');
    expect(netLines[0][2]).toBe('');
    const names = netLines.slice(1).map((match) => match[2]);
    expect(names).toEqual([...layout.nets].sort());
    expect(names.length).toBe(layout.nets.length);
  });

  it('emits one footprint per component, each with its libId and a tstamp', () => {
    for (const component of layout.components) {
      expect(pcb).toContain(`(footprint "${component.libId}" (layer "F.Cu")`);
    }
    const footprintCount = [...pcb.matchAll(/\(footprint "/g)].length;
    expect(footprintCount).toBe(layout.components.length);
  });

  it('binds a (net ...) node to every connected pad and none to unconnected pads', () => {
    const totalPads = layout.components.reduce((sum, component) => sum + component.pads.length, 0);
    const connectedPads = layout.components.reduce(
      (sum, component) => sum + component.pads.filter((pad) => pad.connected).length,
      0,
    );
    const padBlocks = [...pcb.matchAll(/\(pad "[^"]+" thru_hole [a-z]+[\s\S]*?\(tstamp [0-9a-f-]+\)\s*\)/g)];
    expect(padBlocks.length).toBe(totalPads);
    const padsWithNet = padBlocks.filter((match) => /\(net \d+ "/.test(match[0]));
    expect(padsWithNet.length).toBe(connectedPads);
  });

  it('emits one segment per trace and preserves each trace\'s own width', () => {
    const segmentLines = [...pcb.matchAll(/\(segment \(start[^)]*\) \(end[^)]*\) \(width ([\d.]+)\) \(layer "([^"]+)"\)/g)];
    expect(segmentLines.length).toBe(layout.traces.length);
    const widths = new Set(segmentLines.map((match) => match[1]));
    // The neck-down ladder means this fixture uses more than one trace width.
    expect(widths.size).toBeGreaterThan(1);
    for (const trace of layout.traces) {
      expect(pcb).toContain(`(width ${trace.width})`);
    }
  });

  it('maps trace layer names to KiCad copper layers', () => {
    expect(layout.traces.some((trace) => trace.layer === 'top')).toBe(true);
    expect(layout.traces.some((trace) => trace.layer === 'bottom')).toBe(true);
    expect(pcb).toContain('(layer "F.Cu")');
    expect(pcb).toContain('(layer "B.Cu")');
  });

  it('emits one via per layout via, on both copper layers', () => {
    const viaLines = [...pcb.matchAll(/\(via \(at[^)]*\)[\s\S]*?\(layers "F\.Cu" "B\.Cu"\)/g)];
    expect(viaLines.length).toBe(layout.vias.length);
  });

  it('emits 4 board-outline edges on Edge.Cuts', () => {
    const edgeLines = [...pcb.matchAll(/\(gr_line \(start[^)]*\) \(end[^)]*\) \(layer "Edge\.Cuts"\)/g)];
    expect(edgeLines.length).toBe(4);
  });

  it('is deterministic: two calls on the same layout are byte-identical', () => {
    expect(toKiCadPcb(layout, circuit)).toBe(toKiCadPcb(layout, circuit));
  });

  it('round-trips a 90-degree-rotated footprint back to its real absolute pad positions', () => {
    // KiCad's own RotatePoint(angle) is a CCW-visual rotation on a y-down
    // board (positive angle: the R hotkey's default rotate direction). This
    // is independent of pcbPlace.js's rotateOffset (which is CW-visual for
    // the same positive value) — see the report for the derivation.
    const kicadRotate = (point, angleDeg) => {
      const rad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      return { x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos };
    };

    const rotated = layout.components.find((component) => component.rotation === 90);
    expect(rotated).toBeTruthy();

    // Footprints can share a libId (two capacitors), so locate the block by
    // its unique reference designator, not by libId.
    const refIndex = pcb.indexOf(`(fp_text reference "${rotated.ref}"`);
    const blockStart = pcb.lastIndexOf('\n  (footprint "', refIndex);
    const blockEnd = pcb.indexOf('\n  (footprint "', refIndex);
    const footprintBlock = pcb.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
    const [, fx, fy, fangle] = footprintBlock.match(/\(at ([-\d.]+) ([-\d.]+) ([-\d.]+)\)/);
    expect(Number(fangle)).toBe(270); // (360 - 90) % 360

    for (const pad of rotated.pads) {
      const padMatch = footprintBlock.match(
        new RegExp(`\\(pad "${pad.padNumber}" thru_hole \\w+ \\(at ([-\\d.]+) ([-\\d.]+)\\)`),
      );
      const local = { x: Number(padMatch[1]), y: Number(padMatch[2]) };
      const absolute = kicadRotate(local, Number(fangle));
      // pcbLayout quantizes every board coordinate to 0.01mm; round the
      // reconstruction the same way before the exact comparison.
      const round2 = (value) => Math.round(value * 100) / 100;
      expect(round2(Number(fx) + absolute.x)).toBe(pad.x);
      expect(round2(Number(fy) + absolute.y)).toBe(pad.y);
    }
  });

  it('writes a board even when routing/DRC are not clean', () => {
    const dirtyLayout = { ...layout, routing: { complete: false, failedNets: [{ net: 'X' }] }, drc: { ok: false, violations: [{}] } };
    expect(() => toKiCadPcb(dirtyLayout, circuit)).not.toThrow();
    expect(toKiCadPcb(dirtyLayout, circuit).startsWith('(kicad_pcb')).toBe(true);
  });
});
