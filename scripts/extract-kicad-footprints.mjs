// Extracts a curated set of through-hole footprints from the official KiCad 6
// footprint libraries into src/core/kicadFootprintLibrary.js so the PCB layout
// engine can place real pad geometry (positions, shapes, drills, silkscreen,
// courtyard) instead of a hand-rolled catalogue.
//
// Usage:
//   node scripts/extract-kicad-footprints.mjs <dir-with-.pretty-folders>
//
// The source libraries are not committed (they are several MB); download the
// individual files this script wants from
// https://gitlab.com/kicad/libraries/kicad-footprints (tag 6.0.11), e.g.:
//   curl -sLO --create-dirs -o Resistor_THT.pretty/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal.kicad_mod \
//     https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/6.0.11/Resistor_THT.pretty/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal.kicad_mod
// preserving the "<Lib>.pretty/<file>.kicad_mod" layout under <dir>.
//
// The KiCad footprint libraries are licensed CC-BY-SA 4.0 with the KiCad
// libraries exception; see https://www.kicad.org/libraries/license/
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// [prettyLibName, footprintFileName (no extension)]. The Inductor_THT entry
// is not the bare "L_Axial_L9.5mm_D4.0mm_P15.24mm_Horizontal" — that filename
// 404s at tag 6.0.11 (checked via the GitLab API tree listing); the only
// entry in Inductor_THT.pretty with those exact L/D/P dimensions carries a
// manufacturer suffix, so we vendor that file instead.
const WANTED = [
  ['Resistor_THT', 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal'],
  ['Capacitor_THT', 'C_Disc_D5.0mm_W2.5mm_P5.00mm'],
  ['Capacitor_THT', 'CP_Radial_D5.0mm_P2.50mm'],
  ['Inductor_THT', 'L_Axial_L9.5mm_D4.0mm_P15.24mm_Horizontal_Fastron_SMCC'],
  ['Diode_THT', 'D_DO-41_SOD81_P10.16mm_Horizontal'],
  ['LED_THT', 'LED_D5.0mm'],
  ['Package_TO_SOT_THT', 'TO-92_Inline'],
  ['Package_TO_SOT_THT', 'TO-220-3_Vertical'],
  ['Package_DIP', 'DIP-8_W7.62mm'],
  ['Package_DIP', 'DIP-14_W7.62mm'],
  ['Package_DIP', 'DIP-16_W7.62mm'],
  ['TerminalBlock', 'TerminalBlock_bornier-2_P5.08mm'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x02_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x03_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x04_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x05_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x06_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x07_P2.54mm_Vertical'],
  ['Connector_PinHeader_2.54mm', 'PinHeader_1x08_P2.54mm_Vertical'],
];

// --- Minimal s-expression parser (same approach as extract-kicad-symbols.mjs;
// enough for .kicad_mod files). ---
const tokenize = (text) => {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '(' || char === ')') {
      tokens.push(char);
      index += 1;
    } else if (char === '"') {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          value += text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ str: value });
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      let value = '';
      while (index < text.length && !/[\s()"]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ atom: value });
    }
  }
  return tokens;
};

const parse = (text) => {
  const tokens = tokenize(text);
  let index = 0;
  const walk = () => {
    const token = tokens[index];
    index += 1;
    if (token === '(') {
      const list = [];
      while (tokens[index] !== ')') list.push(walk());
      index += 1;
      return list;
    }
    return token;
  };
  return walk();
};

const isList = (node) => Array.isArray(node);
const head = (node) => (isList(node) && node[0]?.atom) || null;
const str = (node) => node?.str;
const num = (node) => Number(node?.atom ?? node?.str);
const find = (node, kind) => node.find((child) => head(child) === kind);

const fmt = (value) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

// --- Extraction ---
const collectPads = (footprint) =>
  footprint.filter((node) => head(node) === 'pad').map((node) => {
    const at = find(node, 'at');
    const size = find(node, 'size');
    const drill = find(node, 'drill');
    const shape = node[3]?.atom === 'roundrect' ? 'rect' : node[3]?.atom;
    return {
      number: str(node[1]),
      x: num(at?.[1]) || 0,
      y: num(at?.[2]) || 0,
      angle: num(at?.[3]) || 0,
      shape,
      size: { w: num(size?.[1]), h: num(size?.[2]) },
      drill: num(drill?.[1]),
    };
  });

// F.SilkS / F.Fab line/circle/arc primitives on a given layer.
const collectPrimitives = (footprint, layerName) => {
  const primitives = [];
  for (const node of footprint) {
    const kind = head(node);
    if (kind !== 'fp_line' && kind !== 'fp_circle' && kind !== 'fp_arc') continue;
    if (str(find(node, 'layer')?.[1]) !== layerName) continue;
    const width = num(find(node, 'width')?.[1]) || 0;
    if (kind === 'fp_line') {
      const start = find(node, 'start');
      const end = find(node, 'end');
      primitives.push({
        type: 'line',
        start: { x: num(start[1]), y: num(start[2]) },
        end: { x: num(end[1]), y: num(end[2]) },
        width,
      });
    } else if (kind === 'fp_circle') {
      const center = find(node, 'center');
      const end = find(node, 'end');
      const cx = num(center[1]);
      const cy = num(center[2]);
      primitives.push({
        type: 'circle',
        center: { x: cx, y: cy },
        radius: Math.hypot(num(end[1]) - cx, num(end[2]) - cy),
        width,
      });
    } else {
      const start = find(node, 'start');
      const mid = find(node, 'mid');
      const end = find(node, 'end');
      primitives.push({
        type: 'arc',
        start: { x: num(start[1]), y: num(start[2]) },
        mid: { x: num(mid[1]), y: num(mid[2]) },
        end: { x: num(end[1]), y: num(end[2]) },
        width,
      });
    }
  }
  return primitives;
};

const bboxOf = (primitives) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const primitive of primitives) {
    if (primitive.type === 'circle') {
      extend(primitive.center.x - primitive.radius, primitive.center.y - primitive.radius);
      extend(primitive.center.x + primitive.radius, primitive.center.y + primitive.radius);
    } else if (primitive.type === 'arc') {
      extend(primitive.start.x, primitive.start.y);
      extend(primitive.mid.x, primitive.mid.y);
      extend(primitive.end.x, primitive.end.y);
    } else {
      extend(primitive.start.x, primitive.start.y);
      extend(primitive.end.x, primitive.end.y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
};

// Translates every coordinate in a primitive list by (dx, dy).
const shiftPrimitives = (primitives, dx, dy) => primitives.map((primitive) => {
  if (primitive.type === 'circle') {
    return { ...primitive, center: { x: fmt(primitive.center.x + dx), y: fmt(primitive.center.y + dy) } };
  }
  if (primitive.type === 'arc') {
    return {
      ...primitive,
      start: { x: fmt(primitive.start.x + dx), y: fmt(primitive.start.y + dy) },
      mid: { x: fmt(primitive.mid.x + dx), y: fmt(primitive.mid.y + dy) },
      end: { x: fmt(primitive.end.x + dx), y: fmt(primitive.end.y + dy) },
    };
  }
  return {
    ...primitive,
    start: { x: fmt(primitive.start.x + dx), y: fmt(primitive.start.y + dy) },
    end: { x: fmt(primitive.end.x + dx), y: fmt(primitive.end.y + dy) },
  };
});

const parseFootprintFile = (source, libName) => {
  const root = parse(source);
  const name = str(root[1]);
  const libId = `${libName}:${name}`;
  const body = root.slice(2);

  const pads = collectPads(body);
  const silk = collectPrimitives(body, 'F.SilkS');
  const fab = collectPrimitives(body, 'F.Fab');
  const crtYd = collectPrimitives(body, 'F.CrtYd');

  // Courtyard bbox: prefer the real F.CrtYd outline; fall back to the silk
  // bbox padded by 0.25mm (KiCad's own convention for a default courtyard
  // clearance) if a footprint has none.
  let courtyard = bboxOf(crtYd);
  if (!courtyard) {
    const silkBbox = bboxOf(silk);
    if (!silkBbox) throw new Error(`${libId}: no F.CrtYd or F.SilkS geometry to derive a courtyard from`);
    courtyard = {
      minX: silkBbox.minX - 0.25, minY: silkBbox.minY - 0.25,
      maxX: silkBbox.maxX + 0.25, maxY: silkBbox.maxY + 0.25,
    };
  }

  // KiCad footprint origins are authored around pin 1, not the geometric
  // center — recenter everything on the courtyard's midpoint so
  // `component center + pad offset` (the layout engine's convention) lands
  // pads symmetrically around the placed component, matching the old
  // synthesized catalogue's convention.
  const dx = -(courtyard.minX + courtyard.maxX) / 2;
  const dy = -(courtyard.minY + courtyard.maxY) / 2;

  return {
    libId,
    record: {
      libId,
      pads: pads.map((pad) => ({
        number: pad.number,
        x: fmt(pad.x + dx),
        y: fmt(pad.y + dy),
        shape: pad.shape,
        size: pad.size,
        drill: pad.drill,
        angle: pad.angle,
      })),
      silk: shiftPrimitives(silk, dx, dy),
      fab: shiftPrimitives(fab, dx, dy),
      courtyard: {
        minX: fmt(courtyard.minX + dx),
        minY: fmt(courtyard.minY + dy),
        maxX: fmt(courtyard.maxX + dx),
        maxY: fmt(courtyard.maxY + dy),
      },
    },
  };
};

const main = () => {
  const libDir = process.argv[2];
  if (!libDir) {
    console.error('Usage: node scripts/extract-kicad-footprints.mjs <dir-with-.pretty-folders>');
    process.exit(1);
  }

  const entries = {};
  for (const [libName, fileName] of WANTED) {
    const file = path.join(libDir, `${libName}.pretty`, `${fileName}.kicad_mod`);
    const source = fs.readFileSync(file, 'utf8');
    const { libId, record } = parseFootprintFile(source, libName);
    if (entries[libId]) throw new Error(`Duplicate libId ${libId}`);
    entries[libId] = record;
  }

  const out = [];
  out.push('// Generated by scripts/extract-kicad-footprints.mjs — do not edit by hand.');
  out.push('//');
  out.push('// Through-hole footprints from the official KiCad 6 footprint libraries');
  out.push('// (tag 6.0.11), https://gitlab.com/kicad/libraries/kicad-footprints');
  out.push('// Licensed CC-BY-SA 4.0 with the KiCad libraries exception:');
  out.push('// https://www.kicad.org/libraries/license/');
  out.push('//');
  out.push('// Each record (mm, y-down, recentered on the courtyard midpoint):');
  out.push('//   pads      — [{ number, x, y, shape, size:{w,h}, drill, angle }]');
  out.push('//   silk      — F.SilkS primitives [{ type: "line"|"circle"|"arc", ... , width }]');
  out.push('//   fab       — F.Fab primitives, same shape as silk');
  out.push('//   courtyard — bounding box { minX, minY, maxX, maxY }');
  out.push('export const KICAD_FOOTPRINTS = {');
  for (const [libId, record] of Object.entries(entries)) {
    out.push(`  ${JSON.stringify(libId)}: ${JSON.stringify(record)},`);
  }
  out.push('};');
  out.push('');
  const target = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'core', 'kicadFootprintLibrary.js')
    .replace(/^[/\\]([A-Za-z]:)/, '$1');
  fs.writeFileSync(target, out.join('\n'));
  console.log(`Wrote ${target} with ${Object.keys(entries).length} footprints`);
};

main();
