// KiCad 6 PCB (.kicad_pcb) exporter.
//
// Converts a finished pcbLayout.js layout (placed footprints, routed copper,
// vias, and the routing/DRC verdict) into a real KiCad board file, so it can
// be opened in KiCad or rendered in the browser by KiCanvas. Mirrors the
// house style of kicadSchematic.js (line-array assembly, `q()` quoting,
// `fmt()` number formatting, `uuidFrom` seeding).
//
// Rotation convention — this is the one subtlety in the whole file, so it is
// worth spelling out. pcbPlace.js's `rotateOffset(point, rotation)` (the
// function that produced every absolute pad coordinate in the layout) is a
// CLOCKWISE-on-screen rotation for a positive `rotation` value (screen = a
// y-down plane, same as this file). Real KiCad's own point rotation
// (pcbnew's RotatePoint, and therefore the angle stored in a footprint's
// `(at x y angle)`) is COUNTERCLOCKWISE-on-screen for a positive angle: the
// default "R" rotate hotkey turns a footprint CCW and increases its stored
// angle. The two conventions are mirror images of each other, so the angle
// this file must emit is the complement:
//
//     kicadAngle = (360 - layoutRotation) % 360
//
// Local pad geometry (position, size, shape) is pulled straight from the
// vendored footprint record (src/core/kicadFootprintLibrary.js) rather than
// reconstructed by inverse-rotating the layout's board-space pad data: every
// vendored/synthesized pad carries its own local `angle: 0`. Position is
// inherited from the parent footprint's `(at x y angle)` automatically, but
// a pad's OWN `(at x y angle)` angle is a separate, ABSOLUTE value in the
// .kicad_pcb format (KiCanvas's PadPainter — and pcbnew — cancel the parent
// footprint's rotation before applying the pad's own angle). So each pad
// must also carry the footprint's `kicadAngle` on its own `(at …)`, or a
// non-square pad (e.g. a TO-220's 2mm x 1.905mm pad) renders using its raw
// local (unrotated) size instead of the layout's board-space size. See
// kicadPcb.test.js's "round-trips a 90-degree-rotated footprint" test and
// the pad-angle/board-space-size test for worked numeric proofs, and the
// Phase D report for the derivation.
import { recordForPlacedComponent } from './pcbFootprints.js';
import { uuidFrom } from './deterministicUuid.js';

const fmt = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const q = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// KiCad's own rotation direction is the mirror image of pcbPlace.js's
// rotateOffset — see the module comment above.
const kicadAngle = (rotation) => (360 - (((rotation % 360) + 360) % 360)) % 360;

const LAYER_FOR_TRACE = { top: 'F.Cu', bottom: 'B.Cu' };

const KICAD6_LAYERS = [
  [0, 'F.Cu', 'signal'],
  [31, 'B.Cu', 'signal'],
  [32, 'B.Adhes', 'user', 'B.Adhesive'],
  [33, 'F.Adhes', 'user', 'F.Adhesive'],
  [34, 'B.Paste', 'user'],
  [35, 'F.Paste', 'user'],
  [36, 'B.SilkS', 'user', 'B.Silkscreen'],
  [37, 'F.SilkS', 'user', 'F.Silkscreen'],
  [38, 'B.Mask', 'user'],
  [39, 'F.Mask', 'user'],
  [40, 'Dwgs.User', 'user', 'User.Drawings'],
  [41, 'Cmts.User', 'user', 'User.Comments'],
  [42, 'Eco1.User', 'user', 'User.Eco1'],
  [43, 'Eco2.User', 'user', 'User.Eco2'],
  [44, 'Edge.Cuts', 'user'],
  [45, 'Margin', 'user'],
  [46, 'B.CrtYd', 'user', 'B.Courtyard'],
  [47, 'F.CrtYd', 'user', 'F.Courtyard'],
  [48, 'B.Fab', 'user'],
  [49, 'F.Fab', 'user'],
];

const COURTYARD_WIDTH = 0.05;

const shapeKeyword = (shape) => (shape === 'oval' || shape === 'rect' ? shape : 'circle');

const primitiveLines = (primitives, layer, seedPrefix) => primitives.map((primitive, index) => {
  const uuid = uuidFrom(`${seedPrefix}:${index}`);
  if (primitive.type === 'circle') {
    const end = { x: primitive.center.x + primitive.radius, y: primitive.center.y };
    return `      (fp_circle (center ${fmt(primitive.center.x)} ${fmt(primitive.center.y)}) (end ${fmt(end.x)} ${fmt(end.y)}) (layer ${q(layer)}) (width ${fmt(primitive.width)}) (fill none) (tstamp ${uuid}))`;
  }
  if (primitive.type === 'arc') {
    return `      (fp_arc (start ${fmt(primitive.start.x)} ${fmt(primitive.start.y)}) (mid ${fmt(primitive.mid.x)} ${fmt(primitive.mid.y)}) (end ${fmt(primitive.end.x)} ${fmt(primitive.end.y)}) (layer ${q(layer)}) (width ${fmt(primitive.width)}) (tstamp ${uuid}))`;
  }
  return `      (fp_line (start ${fmt(primitive.start.x)} ${fmt(primitive.start.y)}) (end ${fmt(primitive.end.x)} ${fmt(primitive.end.y)}) (layer ${q(layer)}) (width ${fmt(primitive.width)}) (tstamp ${uuid}))`;
});

const courtyardLines = (courtyard, seedPrefix) => {
  const { minX, minY, maxX, maxY } = courtyard;
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
  const lines = [];
  for (let index = 0; index < 4; index += 1) {
    const [ax, ay] = corners[index];
    const [bx, by] = corners[index + 1];
    const uuid = uuidFrom(`${seedPrefix}:${index}`);
    lines.push(`      (fp_line (start ${fmt(ax)} ${fmt(ay)}) (end ${fmt(bx)} ${fmt(by)}) (layer "F.CrtYd") (width ${COURTYARD_WIDTH}) (tstamp ${uuid}))`);
  }
  return lines;
};

const footprintBlock = (component, netNumberFor) => {
  const record = recordForPlacedComponent(component);
  const padsByNumber = new Map(record.pads.map((pad) => [pad.number, pad]));
  const angle = kicadAngle(component.rotation);
  const { minY, maxY } = record.courtyard;

  const padLines = component.pads.map((pad) => {
    const local = padsByNumber.get(pad.padNumber);
    if (!local) {
      throw new Error(`kicadPcb: no local footprint-record pad found for ${component.ref} pad ${pad.padNumber} (libId "${component.libId}")`);
    }
    const x = local.x;
    const y = local.y;
    const shape = shapeKeyword(local.shape);
    const w = local.size.w;
    const h = local.size.h;
    const netNode = pad.connected ? ` (net ${netNumberFor(pad.net)} ${q(pad.net)})` : '';
    const uuid = uuidFrom(`pcb:pad:${component.ref}:${pad.padNumber}`);
    // The pad's own (at x y angle) angle is ABSOLUTE in the .kicad_pcb
    // format (KiCanvas's PadPainter cancels the parent footprint's rotation
    // and then applies the pad's own angle) — it is not inherited from the
    // parent footprint automatically the way position is. Every vendored
    // pad's local `angle` is 0, so the pad's absolute angle must equal the
    // footprint's own kicadAngle for the pad to land at the correct
    // orientation; omitting it makes non-square pads (e.g. a TO-220's 2mm x
    // 1.905mm pad) render with their raw local size instead of the layout's
    // board-space size. See kicadPcb.test.js's pad-angle test.
    return `      (pad ${q(pad.padNumber)} thru_hole ${shape} (at ${fmt(x)} ${fmt(y)}${angle ? ` ${fmt(angle)}` : ''}) (size ${fmt(w)} ${fmt(h)}) (drill ${fmt(pad.drill)}) (layers "*.Cu" "*.Mask")${netNode} (tstamp ${uuid}))`;
  });

  const refUuid = uuidFrom(`pcb:fptext:${component.ref}:reference`);
  const valueUuid = uuidFrom(`pcb:fptext:${component.ref}:value`);
  const fpUuid = uuidFrom(`pcb:fp:${component.ref}`);

  const lines = [];
  lines.push(`  (footprint ${q(component.libId)} (layer "F.Cu") (tstamp ${fpUuid})`);
  lines.push(`    (at ${fmt(component.x)} ${fmt(component.y)} ${fmt(angle)})`);
  lines.push(`    (fp_text reference ${q(component.ref)} (at 0 ${fmt(minY - 1)}) (layer "F.SilkS")`);
  lines.push('      (effects (font (size 1 1) (thickness 0.15)))');
  lines.push(`      (tstamp ${refUuid})`);
  lines.push('    )');
  lines.push(`    (fp_text value ${q(component.value ?? '')} (at 0 ${fmt(maxY + 1)}) (layer "F.Fab")`);
  lines.push('      (effects (font (size 1 1) (thickness 0.15)))');
  lines.push(`      (tstamp ${valueUuid})`);
  lines.push('    )');
  lines.push(...primitiveLines(record.silk || [], 'F.SilkS', `pcb:silk:${component.ref}`));
  lines.push(...primitiveLines(record.fab || [], 'F.Fab', `pcb:fab:${component.ref}`));
  lines.push(...courtyardLines(record.courtyard, `pcb:crtyd:${component.ref}`));
  lines.push(...padLines);
  lines.push('  )');
  return lines.join('\n');
};

/**
 * Serializes a pcbLayout.js layout to a KiCad 6 `.kicad_pcb` document.
 * Writes even when `routing.complete === false` or `drc.ok === false` — a
 * partial board is still viewable; refusing to export a non-manufacturable
 * board is the Gerber export's job, not this one's.
 *
 * @param {ReturnType<typeof import('./pcbLayout.js').buildPcbLayout>} layout
 * @param {object} [circuit]
 * @returns {string}
 */
export const toKiCadPcb = (layout, circuit) => {
  const lines = [];
  lines.push('(kicad_pcb (version 20211014) (generator prompt_to_pcb)');
  lines.push('');
  lines.push('  (general');
  lines.push(`    (thickness ${fmt(layout.board.thickness)})`);
  lines.push('  )');
  lines.push('');
  lines.push('  (paper "A4")');
  lines.push('');
  lines.push('  (layers');
  lines.push(KICAD6_LAYERS.map(([number, name, type, altName]) =>
    `    (${number} ${q(name)} ${type}${altName ? ` ${q(altName)}` : ''})`).join('\n'));
  lines.push('  )');
  lines.push('');
  lines.push('  (setup');
  lines.push('    (pad_to_mask_clearance 0.05)');
  lines.push('  )');
  lines.push('');

  const sortedNets = [...layout.nets].sort();
  const netNumber = new Map(sortedNets.map((name, index) => [name, index + 1]));
  const netNumberFor = (name) => netNumber.get(name) ?? 0;
  lines.push('  (net 0 "")');
  for (const name of sortedNets) lines.push(`  (net ${netNumber.get(name)} ${q(name)})`);
  lines.push('');

  for (const component of layout.components) {
    lines.push(footprintBlock(component, netNumberFor));
    lines.push('');
  }

  const { outline } = layout.board;
  const corners = [
    [outline.x, outline.y],
    [outline.x + outline.width, outline.y],
    [outline.x + outline.width, outline.y + outline.height],
    [outline.x, outline.y + outline.height],
    [outline.x, outline.y],
  ];
  for (let index = 0; index < 4; index += 1) {
    const [ax, ay] = corners[index];
    const [bx, by] = corners[index + 1];
    const uuid = uuidFrom(`pcb:edge:${index}`);
    lines.push(`  (gr_line (start ${fmt(ax)} ${fmt(ay)}) (end ${fmt(bx)} ${fmt(by)}) (layer "Edge.Cuts") (width 0.1) (tstamp ${uuid}))`);
  }
  lines.push('');

  layout.traces.forEach((trace, index) => {
    const uuid = uuidFrom(`pcb:seg:${trace.net}:${index}`);
    lines.push(`  (segment (start ${fmt(trace.from.x)} ${fmt(trace.from.y)}) (end ${fmt(trace.to.x)} ${fmt(trace.to.y)}) (width ${fmt(trace.width)}) (layer ${q(LAYER_FOR_TRACE[trace.layer] ?? trace.layer)}) (net ${netNumberFor(trace.net)}) (tstamp ${uuid}))`);
  });
  if (layout.traces.length) lines.push('');

  layout.vias.forEach((via, index) => {
    const uuid = uuidFrom(`pcb:via:${via.net}:${index}`);
    lines.push(`  (via (at ${fmt(via.x)} ${fmt(via.y)}) (size ${fmt(via.diameter)}) (drill ${fmt(via.drill)}) (layers "F.Cu" "B.Cu") (net ${netNumberFor(via.net)}) (tstamp ${uuid}))`);
  });
  if (layout.vias.length) lines.push('');

  lines.push(')');
  return lines.join('\n');
};
