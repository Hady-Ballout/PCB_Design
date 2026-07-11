// KiCad 6 schematic (.kicad_sch) exporter.
//
// Converts a laid-out circuit diagram (the same structure the SVG canvas
// renders) into a real KiCad schematic file so it can be opened in KiCad or
// rendered in the browser by KiCanvas. Components map to symbols vendored
// from the official KiCad symbol library (src/core/kicadSymbolLibrary.js);
// microcontroller boards and unknown kinds get a synthesized module box with
// visible, named pins. Wires keep the canvas routing and are extended with
// short orthogonal stubs onto the library symbols' real pin positions.
import { routeDiagramWire } from './schematicLayout.js';
import { KICAD_SYMBOLS } from './kicadSymbolLibrary.js';
import { MCU_BOARD_TITLES, MCU_PIN_NAMES } from './pcbGenerator.js';

// 20 canvas px = one 2.54mm KiCad grid step, so pins stay on-grid.
const SCALE = 0.127;
const MARGIN = 12.7;
const PIN_LENGTH = 2.54;

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

const font = (size = 1.27) => `(effects (font (size ${size} ${size})))`;

// Circuit kind → vendored library symbol. pinNumbers[i] is the symbol pin
// that carries nodes[i] (canvas pinIndex i+1); the orders differ because the
// circuit model uses SPICE node order while KiCad numbers physical pins.
const KIND_TO_SYMBOL = {
  resistor: { libId: 'Device:R', pinNumbers: ['1', '2'] },
  load: { libId: 'Device:R', pinNumbers: ['1', '2'] },
  capacitor: { libId: 'Device:C', pinNumbers: ['1', '2'] },
  inductor: { libId: 'Device:L', pinNumbers: ['1', '2'] },
  // SPICE diode order is (anode, cathode); Device:D pin 1 is the cathode.
  diode: { libId: 'Device:D', pinNumbers: ['2', '1'] },
  led: { libId: 'Device:LED', pinNumbers: ['2', '1'] },
  // SPICE BJT order is (C, B, E); Q_*_BCE pins are 1=B 2=C 3=E.
  bjt_npn: { libId: 'Device:Q_NPN_BCE', pinNumbers: ['2', '1', '3'] },
  bjt_pnp: { libId: 'Device:Q_PNP_BCE', pinNumbers: ['2', '1', '3'] },
  // SPICE MOSFET order is (D, G, S); Q_*_GDS pins are 1=G 2=D 3=S.
  mosfet_n: { libId: 'Device:Q_NMOS_GDS', pinNumbers: ['2', '1', '3'] },
  mosfet_p: { libId: 'Device:Q_PMOS_GDS', pinNumbers: ['2', '1', '3'] },
  // Circuit opamp order is (in+, in-, out, V+, V-).
  opamp: { libId: 'Amplifier_Operational:LM741', pinNumbers: ['3', '2', '6', '7', '4'] },
  voltage_source: { libId: 'pspice:VSOURCE', pinNumbers: ['1', '2'] },
  signal_source: { libId: 'pspice:VSOURCE', pinNumbers: ['1', '2'] },
  // Circuit regulator order is (input, ground, output) — matches L7805.
  regulator: { libId: 'Regulator_Linear:L7805', pinNumbers: ['1', '2', '3'] },
};

// Sheet offset (mm, y-down) of a symbol-local point (mm, y-up) for an
// instance with the given rotation (degrees CCW on screen) and optional
// KiCad mirror ((mirror x) flips vertically before rotating).
const placeLocal = (px, py, angle, mirror) => {
  let x = px;
  let y = -py;
  if (mirror === 'x') y = -y;
  switch (angle) {
    case 90: return { x: y, y: -x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: -y, y: x };
    default: return { x, y };
  }
};

// Where a symbol pin's connect point lands on the sheet, in mm.
const pinSheetPosition = (center, pin, angle, mirror) => {
  const offset = placeLocal(pin.x, pin.y, angle, mirror);
  return { x: fmt(center.x + offset.x), y: fmt(center.y + offset.y) };
};

// Axis ('h'|'v') along which a wire should arrive at the pin, from the pin's
// body direction after the instance transform.
const pinArrivalAxis = (pin, angle, mirror) => {
  const rad = (pin.angle * Math.PI) / 180;
  const direction = placeLocal(Math.cos(rad), Math.sin(rad), angle, mirror);
  return Math.abs(direction.x) >= Math.abs(direction.y) ? 'h' : 'v';
};

// Pick the rotation + mirror that brings the symbol's mapped pins closest to
// the canvas wire terminals, so connection stubs stay short and untangled.
// (mirror y) is redundant here: it equals (mirror x) plus a 180° rotation.
const bestOrientation = (component, mapping, symbol) => {
  const center = { x: sx(component.x), y: sy(component.y) };
  let best = null;
  for (const angle of [0, 90, 180, 270]) {
    for (const mirror of [null, 'x']) {
      let cost = 0;
      for (let index = 0; index < mapping.length; index += 1) {
        const pin = symbol.pins[mapping[index]];
        const terminal = component.pins?.find((item) => item.pinIndex === index + 1);
        if (!pin || !terminal) continue;
        const at = pinSheetPosition(center, pin, angle, mirror);
        cost += Math.hypot(at.x - sx(terminal.x), at.y - sy(terminal.y));
      }
      if (!best || cost < best.cost - 1e-9) best = { angle, mirror, cost };
    }
  }
  return best;
};

const PIN_NAME_TYPES = new Set(['5V', '3V3', 'GND', 'VIN', 'VCC', 'VDD', 'VEE', 'VSS']);

// Synthesized KiCad-style module box (microcontroller boards and any kind
// without a curated library symbol): body rectangle with real 2.54mm pins at
// the exact canvas pin positions, so wires connect with no stubs at all.
const synthesizedSymbol = (component) => {
  const libId = `PROMPT:${component.ref}`;
  const mcuNames = MCU_PIN_NAMES[component.kind];
  const pins = (component.pins || []).map((pin) => {
    const dx = pin.x - component.x;
    const dy = pin.y - component.y;
    const horizontal = Math.abs(dx) / (component.width / 2 || 1) >= Math.abs(dy) / (component.height / 2 || 1);
    const side = horizontal ? (dx <= 0 ? 'left' : 'right') : (dy <= 0 ? 'top' : 'bottom');
    const angle = { left: 0, right: 180, top: 270, bottom: 90 }[side];
    const node = String(pin.node ?? '');
    const name = mcuNames?.[pin.pinIndex - 1]
      || (/^NC_/i.test(node) ? 'NC' : node || String(pin.pinIndex));
    const type = PIN_NAME_TYPES.has(name) ? 'power_in' : 'bidirectional';
    return { ...pin, dx, dy, side, angle, name, type };
  });
  const inset = (side) => (pins.some((pin) => pin.side === side) ? PIN_LENGTH : 0);
  const body = {
    left: fmt(lx(-component.width / 2) + inset('left')),
    right: fmt(lx(component.width / 2) - inset('right')),
    top: fmt(ly(-component.height / 2) - inset('top')),
    bottom: fmt(ly(component.height / 2) + inset('bottom')),
  };
  const pinLines = pins.map((pin) => `        (pin ${pin.type} line (at ${lx(pin.dx)} ${ly(pin.dy)} ${pin.angle}) (length ${PIN_LENGTH})
          (name ${q(pin.name)} ${font(1.016)})
          (number ${q(String(pin.pinIndex))} ${font(1.016)})
        )`);
  const def = `    (symbol ${q(libId)} (pin_names (offset 0.508)) (pin_numbers hide) (in_bom yes) (on_board yes)
      (property "Reference" ${q(component.ref)} (id 0) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" ${q(component.value ?? '')} (id 1) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol ${q(`${component.ref}_0_1`)}
        (rectangle (start ${body.left} ${body.top}) (end ${body.right} ${body.bottom})
          (stroke (width 0.254) (type default) (color 0 0 0 0)) (fill (type background)))
      )
      (symbol ${q(`${component.ref}_1_1`)}
${pinLines.join('\n')}
      )
    )`;
  return {
    libId,
    def,
    // Synthesized pins already sit at the canvas terminals: no stubs needed.
    pins: Object.fromEntries(pins.map((pin) => [String(pin.pinIndex), {
      number: String(pin.pinIndex),
      x: lx(pin.dx),
      y: ly(pin.dy),
      angle: pin.angle,
      length: PIN_LENGTH,
    }])),
    pinNumbers: pins.map((pin) => String(pin.pinIndex)),
  };
};

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
  const usedLibIds = new Map();
  const instances = [];
  // `${ref}:${pinIndex}` → stub descriptor for wires that must be re-anchored
  // from the canvas terminal onto the library symbol's real pin position.
  const pinAnchors = new Map();

  const registerLib = (libId, def) => {
    if (!usedLibIds.has(libId)) usedLibIds.set(libId, def);
  };

  const gndSymbol = KICAD_SYMBOLS['power:GND'];
  const emitGround = (point, seed) => {
    registerLib('power:GND', gndSymbol.def);
    const unitUuid = uuidFrom(seed);
    const index = symbolInstances.length + 1;
    symbolInstances.push(`    (path ${q(`/${unitUuid}`)}
      (reference ${q(`#PWR0${index}`)}) (unit 1) (value "GND") (footprint "")
    )`);
    return `  (symbol (lib_id "power:GND") (at ${point.x} ${point.y} 0) (unit 1)
    (in_bom no) (on_board yes)
    (uuid ${unitUuid})
    (property "Reference" ${q(`#PWR0${index}`)} (id 0) (at ${point.x} ${point.y} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (id 1) (at ${point.x} ${fmt(point.y + 4)} 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid ${uuidFrom(`${seed}:pin`)}))
  )`;
  };

  const groundInstances = [];
  diagram.components.forEach((component, index) => {
    // Canvas ground symbols become real power:GND symbols anchored on the pin.
    if (component.symbolType === 'ground') {
      const terminal = component.pins?.[0] || component;
      groundInstances.push(emitGround(
        { x: sx(terminal.x), y: sy(terminal.y) },
        `gndsym:${component.ref || index}`,
      ));
      return;
    }

    const curated = KIND_TO_SYMBOL[component.kind];
    const symbol = curated ? KICAD_SYMBOLS[curated.libId] : null;
    const entry = symbol
      ? { libId: curated.libId, def: symbol.def, pins: symbol.pins, pinNumbers: curated.pinNumbers }
      : synthesizedSymbol(component);
    registerLib(entry.libId, entry.def);

    const center = { x: sx(component.x), y: sy(component.y) };
    const orientation = symbol
      ? bestOrientation(component, entry.pinNumbers, symbol)
      : { angle: 0, mirror: null };

    // Record where each connected pin actually sits so wires can be extended
    // from the canvas terminal onto the symbol pin.
    for (const terminal of component.pins || []) {
      const number = entry.pinNumbers[terminal.pinIndex - 1];
      const pin = entry.pins[number];
      if (!pin) continue;
      pinAnchors.set(`${component.ref}:${terminal.pinIndex}`, {
        end: pinSheetPosition(center, pin, orientation.angle, orientation.mirror),
        axis: pinArrivalAxis(pin, orientation.angle, orientation.mirror),
      });
    }

    const unitUuid = uuidFrom(`symbol:${component.ref}:${index}`);
    const refLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'ref');
    const valueLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'value');
    const refAt = refLabel
      ? { x: sx(refLabel.x), y: sy(refLabel.y) }
      : { x: center.x, y: sy(component.y - component.height / 2 - 12) };
    const valueAt = valueLabel
      ? { x: sx(valueLabel.x), y: sy(valueLabel.y) }
      : { x: center.x, y: sy(component.y + component.height / 2 + 20) };
    const value = component.value || MCU_BOARD_TITLES[component.kind] || '';
    const mirror = orientation.mirror ? ` (mirror ${orientation.mirror})` : '';
    const pinRefs = Object.keys(entry.pins)
      .map((number) => `    (pin ${q(number)} (uuid ${uuidFrom(`pin:${component.ref}:${number}`)}))`)
      .join('\n');
    instances.push(`  (symbol (lib_id ${q(entry.libId)}) (at ${center.x} ${center.y} ${orientation.angle})${mirror} (unit 1)
    (in_bom yes) (on_board yes)
    (uuid ${unitUuid})
    (property "Reference" ${q(component.ref)} (id 0) (at ${refAt.x} ${refAt.y} 0) (effects (font (size 1.4 1.4) bold)))
    (property "Value" ${q(value)} (id 1) (at ${valueAt.x} ${valueAt.y} 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" ${q(component.footprint || '')} (id 2) (at ${center.x} ${center.y} 0) (effects (font (size 1.27 1.27)) hide))
${pinRefs}
  )`);
    symbolInstances.push(`    (path ${q(`/${unitUuid}`)}
      (reference ${q(component.ref)}) (unit 1) (value ${q(value)}) (footprint "")
    )`);
  });

  // Wires: one KiCad wire per orthogonal segment of each routed polyline,
  // plus a short stub from the canvas terminal onto the symbol's real pin.
  const wireLines = [];
  const pushWire = (from, to, seed) => {
    if (fmt(from.x) === fmt(to.x) && fmt(from.y) === fmt(to.y)) return;
    wireLines.push(`  (wire (pts (xy ${fmt(from.x)} ${fmt(from.y)}) (xy ${fmt(to.x)} ${fmt(to.y)}))
    (stroke (width 0) (type default) (color 0 0 0 0))
    (uuid ${uuidFrom(seed)})
  )`);
  };
  for (const wire of diagram.wires || []) {
    const points = diagramWirePoints(diagram, wire);
    const wireId = wire.id || `${wire.ref}-${wire.pin}-${wire.node}`;
    for (let index = 1; index < points.length; index += 1) {
      pushWire(
        { x: sx(points[index - 1].x), y: sy(points[index - 1].y) },
        { x: sx(points[index].x), y: sy(points[index].y) },
        `wire:${wireId}:${index}`,
      );
    }
    // The route starts at the canvas pin terminal; extend it onto the real pin.
    const anchor = pinAnchors.get(`${wire.ref}:${wire.pin}`);
    const start = points[0];
    if (anchor && start) {
      const terminal = { x: sx(start.x), y: sy(start.y) };
      const { end, axis } = anchor;
      const corner = axis === 'h' ? { x: terminal.x, y: end.y } : { x: end.x, y: terminal.y };
      pushWire(terminal, corner, `stub:${wireId}:1`);
      pushWire(corner, end, `stub:${wireId}:2`);
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
  for (const point of groundPoints.values()) {
    groundInstances.push(emitGround(
      { x: sx(point.x), y: sy(point.y) },
      `gnd:${point.x}:${point.y}`,
    ));
  }

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
  lines.push([...usedLibIds.values()].join('\n'));
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
