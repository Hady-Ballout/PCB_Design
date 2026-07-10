// KiCad 6 schematic (.kicad_sch) exporter.
//
// Converts a laid-out circuit diagram (the same structure the SVG canvas
// renders) into a real KiCad schematic file so it can be opened in KiCad or
// rendered in the browser by KiCanvas. Every component becomes its own
// embedded lib_symbol whose graphics are ported from the canvas symbol
// drawings, so pins land exactly where the layout engine routed the wires.
import { routeDiagramWire } from './schematicLayout.js';

// 20 canvas px = one 2.54mm KiCad grid step, so pins stay on-grid.
const SCALE = 0.127;
const MARGIN = 12.7;

const fmt = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const q = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Sheet space: same y-down orientation as the canvas.
const sx = (px) => fmt(px * SCALE + MARGIN);
const sy = (py) => fmt(py * SCALE + MARGIN);
// Symbol-local space: KiCad symbol definitions are y-up, so flip.
const lx = (dx) => fmt(dx * SCALE);
const ly = (dy) => fmt(-dy * SCALE);

// Deterministic uuid so the same diagram always serializes identically
// (stable for tests and for change detection in the viewer).
const uuidFrom = (seed) => {
  const text = String(seed);
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
    h3 = Math.imul(h3 ^ code, 2246822519);
    h4 = Math.imul(h4 ^ code, 3266489917);
  }
  const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');
  const raw = hex(h1) + hex(h2) + hex(h3) + hex(h4);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
};

const STROKE = '(stroke (width 0.1524) (type default) (color 0 0 0 0))';
const FILL_NONE = '(fill (type none))';
const FILL_BG = '(fill (type background))';
const FILL_SOLID = '(fill (type outline))';
const font = (size = 1.27) => `(effects (font (size ${size} ${size})))`;

const gPolyline = (points) =>
  `(polyline (pts ${points.map(([x, y]) => `(xy ${lx(x)} ${ly(y)})`).join(' ')}) ${STROKE} ${FILL_NONE})`;
const gLine = (x1, y1, x2, y2) => gPolyline([[x1, y1], [x2, y2]]);
const gPolygon = (points, fill = FILL_BG) => {
  const closed = [...points, points[0]];
  return `(polyline (pts ${closed.map(([x, y]) => `(xy ${lx(x)} ${ly(y)})`).join(' ')}) ${STROKE} ${fill})`;
};
const gRect = (x1, y1, x2, y2) =>
  `(rectangle (start ${lx(x1)} ${ly(y1)}) (end ${lx(x2)} ${ly(y2)}) ${STROKE} ${FILL_NONE})`;
const gCircle = (cx, cy, radius) =>
  `(circle (center ${lx(cx)} ${ly(cy)}) (radius ${fmt(radius * SCALE)}) ${STROKE} ${FILL_NONE})`;
const gArc = (x1, y1, mx, my, x2, y2) =>
  `(arc (start ${lx(x1)} ${ly(y1)}) (mid ${lx(mx)} ${ly(my)}) (end ${lx(x2)} ${ly(y2)}) ${STROKE} ${FILL_NONE})`;
const gText = (text, x, y, size = 1.27) => `(text ${q(text)} (at ${lx(x)} ${ly(y)} 0) ${font(size)})`;

// Symbol graphics in canvas-local px coordinates (relative to the component
// center, y-down like the SVG renderer they are ported from).
const symbolGraphics = (component) => {
  const { width, height, symbolType, orientation } = component;
  const left = -width / 2;
  const right = width / 2;
  const top = -height / 2;
  const bottom = height / 2;
  const pinAt = (pinIndex, fallback) => {
    const pin = component.pins?.find((item) => item.pinIndex === pinIndex);
    return pin ? { x: pin.x - component.x, y: pin.y - component.y } : fallback;
  };

  if (symbolType === 'ground') {
    return [gLine(0, top, 0, -7), gLine(-22, -7, 22, -7), gLine(-14, 3, 14, 3), gLine(-7, 13, 7, 13)];
  }
  if (orientation === 'vertical') {
    if (symbolType === 'resistor') {
      return [gPolyline([
        [0, top], [0, top + 18], [-18, top + 28], [18, top + 44],
        [-18, top + 60], [18, top + 76], [0, bottom - 18], [0, bottom],
      ])];
    }
    if (symbolType === 'capacitor') {
      return [
        gLine(0, top, 0, -14),
        gLine(-24, -14, 24, -14),
        gLine(-24, 14, 24, 14),
        gLine(0, 14, 0, bottom),
      ];
    }
    if (symbolType === 'diode' || symbolType === 'led') {
      const marks = symbolType === 'led' ? [gLine(18, -22, 34, -38), gLine(30, -16, 46, -32)] : [];
      return [
        gLine(0, top, 0, -20),
        gPolygon([[-18, -20], [18, -20], [0, 12]]),
        gLine(-20, 14, 20, 14),
        gLine(0, 14, 0, bottom),
        ...marks,
      ];
    }
    if (symbolType === 'voltage_source') {
      return [
        gLine(0, top, 0, -24),
        gCircle(0, 0, 24),
        gLine(0, 24, 0, bottom),
        gText('+', 0, -11),
        gText('-', 0, 12),
      ];
    }
  }
  if (symbolType === 'resistor') {
    const bodyWidth = Math.min(96, Math.max(70, width - 36));
    const bodyLeft = -bodyWidth / 2;
    const inset = bodyWidth / 6;
    return [
      gLine(left, 0, bodyLeft, 0),
      gPolyline([
        [bodyLeft, 0], [bodyLeft + inset, top + 16], [bodyLeft + inset * 2, bottom - 16],
        [bodyLeft + inset * 3, top + 16], [bodyLeft + inset * 4, bottom - 16],
        [bodyLeft + inset * 5, 0], [bodyWidth / 2, 0],
      ]),
      gLine(bodyWidth / 2, 0, right, 0),
    ];
  }
  if (symbolType === 'capacitor') {
    return [
      gLine(left, 0, -14, 0),
      gLine(-14, top + 9, -14, bottom - 9),
      gLine(14, top + 9, 14, bottom - 9),
      gLine(14, 0, right, 0),
    ];
  }
  if (symbolType === 'inductor') {
    const bumps = [left + 14, left + 38, left + 62];
    return [
      gLine(left, 0, left + 14, 0),
      ...bumps.map((start) => gArc(start, 0, start + 12, top + 8, start + 24, 0)),
      gLine(left + 86, 0, right, 0),
    ];
  }
  if (symbolType === 'diode' || symbolType === 'led') {
    const marks = symbolType === 'led' ? [gLine(18, top + 6, 34, top - 10), gLine(30, top + 12, 46, top - 4)] : [];
    return [
      gLine(left, 0, -20, 0),
      gPolygon([[-20, top + 10], [-20, bottom - 10], [12, 0]]),
      gLine(14, top + 8, 14, bottom - 8),
      gLine(14, 0, right, 0),
      ...marks,
    ];
  }
  if (symbolType === 'voltage_source') {
    return [
      gLine(left, 0, -24, 0),
      gCircle(0, 0, 24),
      gLine(24, 0, right, 0),
      gText('+', 0, -8),
      gText('-', 0, 12),
    ];
  }
  if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') {
    const collector = pinAt(1, { x: right, y: top + 18 });
    const base = pinAt(2, { x: left, y: 0 });
    const emitter = pinAt(3, { x: right, y: bottom - 18 });
    const radius = Math.min(width, height) / 2 - 12;
    const arrow = symbolType === 'bjt_npn'
      ? [[emitter.x - 21, emitter.y - 8], [emitter.x - 5, emitter.y], [emitter.x - 21, emitter.y + 8]]
      : [[emitter.x - 5, emitter.y - 8], [emitter.x - 21, emitter.y], [emitter.x - 5, emitter.y + 8]];
    return [
      gCircle(0, 0, radius),
      gLine(base.x, base.y, -16, base.y),
      gLine(-16, -28, -16, 28),
      gLine(-16, -18, 10, -22),
      gLine(10, -22, collector.x, collector.y),
      gLine(-16, 18, 10, 22),
      gLine(10, 22, emitter.x, emitter.y),
      gPolygon(arrow, FILL_SOLID),
      gText('C', collector.x - 10, collector.y - 11, 1),
      gText('B', base.x + 10, base.y - 11, 1),
      gText('E', emitter.x - 10, emitter.y + 15, 1),
    ];
  }
  if (symbolType === 'opamp') {
    const nonInverting = pinAt(1, { x: left, y: height * 0.22 });
    const inverting = pinAt(2, { x: left, y: -height * 0.22 });
    const output = pinAt(3, { x: right, y: 0 });
    const positive = pinAt(4, { x: 0, y: top });
    const negative = pinAt(5, { x: 0, y: bottom });
    const bodyLeft = left + 28;
    const bodyRight = right - 18;
    const bodyTop = top + 12;
    const bodyBottom = bottom - 12;
    return [
      gLine(nonInverting.x, nonInverting.y, bodyLeft, nonInverting.y),
      gLine(inverting.x, inverting.y, bodyLeft, inverting.y),
      gPolygon([[bodyLeft, bodyTop], [bodyLeft, bodyBottom], [bodyRight, 0]]),
      gLine(bodyRight, 0, output.x, output.y),
      gLine(positive.x, positive.y, positive.x, bodyTop + 12),
      gLine(negative.x, negative.y, negative.x, bodyBottom - 12),
      gText('+', bodyLeft + 18, nonInverting.y, 1),
      gText('-', bodyLeft + 18, inverting.y, 1),
      gText('V+', positive.x + 18, positive.y + 11, 1),
      gText('V-', negative.x + 18, negative.y - 9, 1),
    ];
  }
  return [
    gRect(left, top, right, bottom),
    gText(String(component.kind || '').replaceAll('_', ' '), 0, 2, 1.27),
  ];
};

const pinAngle = (dx, dy) => {
  if (Math.abs(dx) >= Math.abs(dy)) return dx <= 0 ? 0 : 180;
  return dy <= 0 ? 270 : 90;
};

const symbolPins = (component) =>
  (component.pins || []).map((pin) => {
    const dx = pin.x - component.x;
    const dy = pin.y - component.y;
    return `(pin passive line (at ${lx(dx)} ${ly(dy)} ${pinAngle(dx, dy)}) (length 0)
          (name ${q(String(pin.pinIndex))} ${font()})
          (number ${q(String(pin.pinIndex))} ${font()})
        )`;
  });

const libSymbol = (libName, component) => {
  const graphics = symbolGraphics(component).join('\n        ');
  const pins = symbolPins(component).join('\n        ');
  return `    (symbol ${q(libName)} (pin_numbers hide) (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
      (property "Reference" ${q(component.ref)} (id 0) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" ${q(component.value ?? '')} (id 1) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol ${q(`${component.ref}_0_1`)}
        ${graphics}
      )
      (symbol ${q(`${component.ref}_1_1`)}
        ${pins}
      )
    )`;
};

// The GND power symbol used for net-label grounds (ported from renderGroundSvg).
const GND_LIB = `    (symbol "PROMPT:GND" (power) (pin_numbers hide) (pin_names (offset 0) hide) (in_bom no) (on_board no)
      (property "Reference" "#PWR" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" "GND" (id 1) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "GND_0_1"
        ${[gLine(0, 0, 0, 16), gLine(-18, 16, 18, 16), gLine(-12, 22, 12, 22), gLine(-6, 28, 6, 28)].join('\n        ')}
      )
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0)
          (name "GND" ${font()})
          (number "1" ${font()})
        )
      )
    )`;

const paperFor = (diagram) => {
  const width = diagram.width * SCALE + MARGIN * 2;
  const height = diagram.height * SCALE + MARGIN * 2;
  const sizes = [
    ['A4', 297, 210],
    ['A3', 420, 297],
    ['A2', 594, 420],
    ['A1', 841, 594],
    ['A0', 1189, 841],
  ];
  const fit = sizes.find(([, w, h]) => width <= w && height <= h);
  return (fit || sizes.at(-1))[0];
};

const diagramWirePoints = (diagram, wire) => {
  if (wire.points?.length) return wire.points;
  return routeDiagramWire(diagram, wire) || [];
};

export const toKiCadSchematic = (circuit, diagram) => {
  if (!diagram) return '';
  const lines = [];
  const symbolInstances = [];

  // Embedded symbol library: one entry per component (unique geometry each).
  const libEntries = [GND_LIB];
  const instances = [];
  diagram.components.forEach((component, index) => {
    const libName = `PROMPT:${component.ref || `PART${index}`}`;
    libEntries.push(libSymbol(libName, component));

    const unitUuid = uuidFrom(`symbol:${component.ref}:${index}`);
    const isGround = component.symbolType === 'ground';
    const refLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'ref');
    const valueLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'value');
    const refAt = refLabel
      ? { x: sx(refLabel.x), y: sy(refLabel.y) }
      : { x: sx(component.x), y: sy(component.y - component.height / 2 - 12) };
    const valueAt = valueLabel
      ? { x: sx(valueLabel.x), y: sy(valueLabel.y) }
      : { x: sx(component.x), y: sy(component.y + component.height / 2 + 20) };
    const hide = isGround ? ' hide' : '';
    const pinRefs = (component.pins || [])
      .map((pin) => `    (pin ${q(String(pin.pinIndex))} (uuid ${uuidFrom(`pin:${component.ref}:${pin.pinIndex}`)}))`)
      .join('\n');
    instances.push(`  (symbol (lib_id ${q(libName)}) (at ${sx(component.x)} ${sy(component.y)} 0) (unit 1)
    (in_bom ${isGround ? 'no' : 'yes'}) (on_board yes)
    (uuid ${unitUuid})
    (property "Reference" ${q(component.ref)} (id 0) (at ${refAt.x} ${refAt.y} 0) (effects (font (size 1.4 1.4) bold)${hide}))
    (property "Value" ${q(component.value ?? '')} (id 1) (at ${valueAt.x} ${valueAt.y} 0) (effects (font (size 1.27 1.27))${hide}))
    (property "Footprint" ${q(component.footprint || '')} (id 2) (at ${sx(component.x)} ${sy(component.y)} 0) (effects (font (size 1.27 1.27)) hide))
${pinRefs}
  )`);
    symbolInstances.push(`    (path ${q(`/${unitUuid}`)}
      (reference ${q(isGround ? `#GND${index}` : component.ref)}) (unit 1) (value ${q(component.value ?? '')}) (footprint "")
    )`);
  });

  // Wires: one KiCad wire per orthogonal segment of each routed polyline.
  const wireLines = [];
  for (const wire of diagram.wires || []) {
    const points = diagramWirePoints(diagram, wire);
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      if (from.x === to.x && from.y === to.y) continue;
      wireLines.push(`  (wire (pts (xy ${sx(from.x)} ${sy(from.y)}) (xy ${sx(to.x)} ${sy(to.y)}))
    (stroke (width 0) (type default) (color 0 0 0 0))
    (uuid ${uuidFrom(`wire:${wire.id || `${wire.ref}-${wire.pin}-${wire.node}`}:${index}`)})
  )`);
    }
  }

  const junctionLines = (diagram.junctions || []).map((junction) =>
    `  (junction (at ${sx(junction.x)} ${sy(junction.y)}) (diameter 0) (color 0 0 0 0)
    (uuid ${uuidFrom(`junction:${junction.id || `${junction.x}:${junction.y}`}`)})
  )`);

  // Net labels: named nets become labels, ground pills become GND power symbols.
  const labelLines = [];
  const groundPoints = new Map();
  for (const label of diagram.netLabels || []) {
    if (label.name === '0') {
      groundPoints.set(`${label.x}:${label.y}`, { x: label.x, y: label.y });
      continue;
    }
    labelLines.push(`  (label ${q(label.name)} (at ${sx(label.x)} ${sy(label.y)} 0)
    (effects (font (size 1.27 1.27)) (justify left bottom))
    (uuid ${uuidFrom(`label:${label.id || label.name}`)})
  )`);
  }
  // Ground wire terminals that have no explicit "0" pill (mirrors toDiagramSvg).
  for (const wire of diagram.wires || []) {
    if (wire.manual || wire.node !== '0') continue;
    if ((diagram.netLabels || []).some((label) => label.id === wire.labelId && label.name === '0')) continue;
    const end = diagramWirePoints(diagram, wire).at(-1);
    if (end) groundPoints.set(`${end.x}:${end.y}`, end);
  }
  let groundIndex = 0;
  const groundInstances = [...groundPoints.values()].map((point) => {
    groundIndex += 1;
    const unitUuid = uuidFrom(`gnd:${point.x}:${point.y}`);
    symbolInstances.push(`    (path ${q(`/${unitUuid}`)}
      (reference ${q(`#PWR0${groundIndex}`)}) (unit 1) (value "GND") (footprint "")
    )`);
    return `  (symbol (lib_id "PROMPT:GND") (at ${sx(point.x)} ${sy(point.y)} 0) (unit 1)
    (in_bom no) (on_board yes)
    (uuid ${unitUuid})
    (property "Reference" ${q(`#PWR0${groundIndex}`)} (id 0) (at ${sx(point.x)} ${sy(point.y)} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (id 1) (at ${sx(point.x)} ${sy(point.y + 34)} 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid ${uuidFrom(`gndpin:${point.x}:${point.y}`)}))
  )`;
  });

  // External connectors become global labels.
  const globalLabelLines = (diagram.ports || []).map((port) =>
    `  (global_label ${q(port.label)} (shape input) (at ${sx(port.x)} ${sy(port.y)} ${port.side === 'left' ? 180 : 0})
    (effects (font (size 1.27 1.27)) (justify ${port.side === 'left' ? 'right' : 'left'}))
    (uuid ${uuidFrom(`port:${port.label}:${port.x}:${port.y}`)})
  )`);

  const title = circuit?.title || diagram.title || 'Generated circuit';
  lines.push('(kicad_sch (version 20211123) (generator prompt_to_pcb)');
  lines.push('');
  lines.push(`  (uuid ${uuidFrom(`sheet:${title}`)})`);
  lines.push('');
  lines.push(`  (paper ${q(paperFor(diagram))})`);
  lines.push('');
  lines.push(`  (title_block (title ${q(title)}) (comment 1 "Generated by Prompt-to-PCB"))`);
  lines.push('');
  lines.push('  (lib_symbols');
  lines.push(libEntries.join('\n'));
  lines.push('  )');
  lines.push('');
  if (junctionLines.length) lines.push(junctionLines.join('\n'), '');
  if (wireLines.length) lines.push(wireLines.join('\n'), '');
  if (labelLines.length) lines.push(labelLines.join('\n'), '');
  if (globalLabelLines.length) lines.push(globalLabelLines.join('\n'), '');
  if (instances.length) lines.push(instances.join('\n'), '');
  if (groundInstances.length) lines.push(groundInstances.join('\n'), '');
  lines.push('  (sheet_instances (path "/" (page "1")))');
  lines.push('');
  lines.push('  (symbol_instances');
  lines.push(symbolInstances.join('\n'));
  lines.push('  )');
  lines.push(')');
  return lines.join('\n');
};
