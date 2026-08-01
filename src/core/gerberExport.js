// RS-274X Gerber + Excellon drill fabrication package.
//
// Turns a finished, DRC-clean pcbLayout.js layout into the exact set of files a
// low-cost fab house (JLCPCB, PCBWay, Aisler…) expects to be handed in one zip:
// two copper layers, two solder-mask layers, two silkscreen layers, a board
// outline, a plated drill file, and a README describing the stack.
//
// THE EXPORT GATE. This is the one exporter in the pipeline that refuses. A
// .kicad_pcb of a half-routed board is still useful — you open it and finish the
// job. A Gerber package is an ORDER: somebody spends money and two weeks on it.
// So unless the layout says routing is complete, DRC passes and every net is a
// single island, `toGerberArchive` throws a PcbExportError carrying the full
// report rather than quietly shipping a board that cannot work.
//
// THE Y FLIP. The layout is millimetres, y-DOWN (screen convention). Gerber and
// Excellon are y-UP. So every coordinate is emitted as `boardHeight - y`. That
// flip happens in exactly ONE place — `gerberFile`'s `Y()` and `excellonHits`,
// both fed the same `board.height` — because a board mirrored on one layer and
// not another is the classic way this file goes wrong, and it is invisible until
// the panels arrive. Anything added here must go through those helpers; nothing
// may pre-flip its own coordinates. `gerberExport.test.js` pins an exact
// coordinate string on copper, mask, outline AND drill for the same pad so a
// second flip anywhere shows up as a test failure rather than a scrapped run.
//
// DETERMINISM. No timestamps, anywhere: no TF.CreationDate in the Gerber
// headers, and zipStore.js stamps a fixed DOS date. Two runs of the same design
// produce byte-identical archives, so an order can be checksummed against what
// was reviewed.
import { RULES } from './pcbDesignRules.js';
import { recordForPlacedComponent } from './pcbFootprints.js';
import { rotateOffset } from './pcbPlace.js';
import { zipStore } from './zipStore.js';

/** Thrown instead of exporting a board that is not fabricable. */
export class PcbExportError extends Error {
  /**
   * @param {{ failedNets: unknown[], violations: unknown[], incompleteNets: unknown[] }} report
   */
  constructor(report) {
    super(
      `PCB is not fabricable: ${report.failedNets.length} unrouted nets, `
      + `${report.violations.length} DRC violations, ${report.incompleteNets.length} split nets.`,
    );
    this.name = 'PcbExportError';
    this.report = report;
  }
}

/* ---------------------------------------------------------------- numbers -- */

// %FSLAX46Y46*% — 4 integer digits, 6 decimal digits, leading zeros suppressed.
// A coordinate is therefore the millimetre value scaled by 1e6 and rounded.
const COORD_SCALE = 1e6;
const coord = (mm) => String(Math.round(mm * COORD_SCALE) || 0);
/** Aperture/tool sizes are written with fixed precision so they never drift. */
const size6 = (mm) => mm.toFixed(6);
const size3 = (mm) => mm.toFixed(3);
/** Human-facing millimetres for the README (no trailing zeros). */
const human = (mm) => String(Math.round(mm * 1000) / 1000);

const GENERATION_SOFTWARE = '%TF.GenerationSoftware,PromptToPCB,pcb-pilot,dev*%';

/** Filesystem-safe slug, mirroring mcp/artifacts.ts so names agree everywhere. */
const slugify = (title, fallback = 'circuit') => {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
};

/* ------------------------------------------------------------ file writer -- */

/**
 * A single RS-274X file under construction.
 *
 * Apertures are registered on first use and declared in a block ahead of the
 * body, so a layer only ever carries apertures it actually draws with (the
 * neck-down ladder means a board can use four different trace widths, and a
 * dead aperture definition is the kind of thing a fab's DFM check flags).
 *
 * @param {{ layerComment: string, fileFunction: string, boardHeight: number,
 *   polarity?: 'Positive' | 'Negative' }} options
 */
const gerberFile = ({ layerComment, fileFunction, boardHeight, polarity = 'Positive' }) => {
  /** @type {Map<string, number>} aperture definition body -> D-code */
  const apertures = new Map();
  /** @type {string[]} */
  const body = [];
  let selected = null;

  const apertureCode = (definition) => {
    if (!apertures.has(definition)) apertures.set(definition, 10 + apertures.size);
    return apertures.get(definition);
  };
  const select = (definition) => {
    const code = apertureCode(definition);
    if (code !== selected) {
      body.push(`D${code}*`);
      selected = code;
    }
  };

  // THE ONE Y FLIP. See the module header.
  const at = (x, y) => `X${coord(x)}Y${coord(boardHeight - y)}`;

  const file = {
    /** Straight-line polyline of `points` ([x, y] pairs) with a round pen. */
    stroke(points, width) {
      if (points.length < 2) return;
      select(`C,${size6(width)}`);
      body.push(`${at(points[0][0], points[0][1])}D02*`);
      for (let index = 1; index < points.length; index += 1) {
        body.push(`${at(points[index][0], points[index][1])}D01*`);
      }
    },
    /** Flashes a round aperture — the normal way a THT pad or via is drawn. */
    flashCircle(diameter, x, y) {
      select(`C,${size6(diameter)}`);
      body.push(`${at(x, y)}D03*`);
    },
    /**
     * Fills the closed polygon `points`. Kept generic rather than
     * rect-pad-specific: the ground pour lands on this same helper.
     */
    region(points) {
      if (points.length < 3) return;
      body.push('G36*');
      body.push(`${at(points[0][0], points[0][1])}D02*`);
      for (let index = 1; index < points.length; index += 1) {
        body.push(`${at(points[index][0], points[index][1])}D01*`);
      }
      body.push(`${at(points[0][0], points[0][1])}D01*`);
      body.push('G37*');
      // A region ignores the current aperture, and G37 leaves the D-code state
      // untouched, so `selected` stays valid.
    },
    render() {
      return [
        `G04 ${layerComment}*`,
        GENERATION_SOFTWARE,
        `%TF.FileFunction,${fileFunction}*%`,
        `%TF.FilePolarity,${polarity}*%`,
        '%FSLAX46Y46*%',
        '%MOMM*%',
        '%LPD*%',
        'G01*',
        ...[...apertures].map(([definition, code]) => `%ADD${code}${definition}*%`),
        ...body,
        'M02*',
        '',
      ].join('\n');
    },
  };
  return file;
};

/* ------------------------------------------------------------------- pads -- */

/**
 * Paints one pad, optionally grown by `grow` millimetres per side (0 on copper,
 * RULES.maskExpansion on solder mask).
 *
 * `pad.size` is BOARD SPACE: pcbPlace.js already swapped w/h for the placement
 * rotation and pcbLayout.js deliberately does not propagate a pad angle
 * downstream (see pcbDesignRules.js's `padCopperShape` note), so every pad here
 * is axis-aligned and nothing needs rotating.
 */
const paintPad = (file, pad, grow) => {
  const baseW = pad.size?.w ?? pad.diameter ?? 0;
  const baseH = pad.size?.h ?? pad.diameter ?? 0;
  const w = baseW + 2 * grow;
  const h = baseH + 2 * grow;
  if (w <= 0 || h <= 0) return;

  if (pad.shape === 'rect') {
    file.region([
      [pad.x - w / 2, pad.y - h / 2],
      [pad.x + w / 2, pad.y - h / 2],
      [pad.x + w / 2, pad.y + h / 2],
      [pad.x - w / 2, pad.y + h / 2],
    ]);
    return;
  }

  if (pad.shape === 'oval' && w !== h) {
    // A stadium is a round pen of the SHORT axis swept along the LONG one.
    const pen = Math.min(w, h);
    const reach = (Math.max(w, h) - pen) / 2;
    const points = w > h
      ? [[pad.x - reach, pad.y], [pad.x + reach, pad.y]]
      : [[pad.x, pad.y - reach], [pad.x, pad.y + reach]];
    file.stroke(points, pen);
    return;
  }

  file.flashCircle(Math.max(w, h), pad.x, pad.y);
};

/* --------------------------------------------------------------- geometry -- */

/** Footprint-local point -> board space, honouring the placement rotation. */
const placedPoint = (local, component) => {
  const offset = rotateOffset(local, component.rotation);
  return [component.x + offset.x, component.y + offset.y];
};

const ARC_STEP = Math.PI / 16;

const arcPoints = (center, radius, from, sweep) => {
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / ARC_STEP));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = from + (sweep * index) / steps;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  });
};

/** Centre of the circle through three points; null when they are collinear. */
const circumcenter = (a, b, c) => {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sc = c.x * c.x + c.y * c.y;
  return {
    x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
    y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
  };
};

const TWO_PI = Math.PI * 2;
const normalize = (angle) => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * Footprint-local polyline for one silk/fab primitive. Circles and arcs are
 * tessellated rather than emitted as G02/G03: Gerber arcs need G75 plus
 * centre-offset (I/J) parameters whose sign conventions are a well-known source
 * of quietly-wrong output, and at 1/32 turn per chord the error on a 2.6mm
 * silkscreen circle is under 3 µm — far below any silkscreen process.
 */
const primitivePoints = (primitive) => {
  if (primitive.type === 'circle') {
    return arcPoints(primitive.center, primitive.radius, 0, TWO_PI);
  }
  if (primitive.type === 'arc') {
    const center = circumcenter(primitive.start, primitive.mid, primitive.end);
    if (!center) return [primitive.start, primitive.end];
    const radius = Math.hypot(primitive.start.x - center.x, primitive.start.y - center.y);
    const from = Math.atan2(primitive.start.y - center.y, primitive.start.x - center.x);
    const toEnd = normalize(Math.atan2(primitive.end.y - center.y, primitive.end.x - center.x) - from);
    const toMid = normalize(Math.atan2(primitive.mid.y - center.y, primitive.mid.x - center.x) - from);
    // Counter-clockwise unless the midpoint says the arc goes the other way.
    return arcPoints(center, radius, from, toMid <= toEnd ? toEnd : toEnd - TWO_PI);
  }
  return [primitive.start, primitive.end];
};

/** Board-space top edge (smallest y, i.e. highest on screen) of a courtyard. */
const courtyardTop = (component, record) => {
  const box = component.courtyard || record.courtyard;
  const corners = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ].map((corner) => rotateOffset(corner, component.rotation));
  return component.y + Math.min(...corners.map((corner) => corner.y));
};

/* ------------------------------------------------------------ stroke font -- */

// A single-stroke ("stick") vector font, just enough for reference designators.
// Each glyph is a list of polylines in a 0.6 x 1.0 em box with the ORIGIN ON THE
// BASELINE and y pointing UP, so rendering is `baseline - gy * height`. Data
// only — no per-character code anywhere.
const GLYPH_WIDTH = 0.6;
const GLYPH_GAP = 0.2;
const STROKE_FONT = {
  0: [[[0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15], [0, 0.85], [0.15, 1]], [[0.1, 0.2], [0.5, 0.8]]],
  1: [[[0.1, 0.8], [0.3, 1], [0.3, 0]], [[0.1, 0], [0.5, 0]]],
  2: [[[0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0, 0], [0.6, 0]]],
  3: [[[0, 1], [0.6, 1], [0.25, 0.55], [0.45, 0.55], [0.6, 0.4], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
  4: [[[0.45, 0], [0.45, 1], [0, 0.3], [0.6, 0.3]]],
  5: [[[0.6, 1], [0, 1], [0, 0.55], [0.45, 0.55], [0.6, 0.4], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
  6: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.35], [0.45, 0.5], [0.15, 0.5], [0, 0.35]]],
  7: [[[0, 1], [0.6, 1], [0.2, 0]]],
  8: [[[0.15, 0.5], [0, 0.65], [0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0.15, 0.5], [0, 0.35], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.35], [0.45, 0.5]]],
  9: [[[0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.65], [0.15, 0.5], [0.45, 0.5], [0.6, 0.65]]],
  A: [[[0, 0], [0.3, 1], [0.6, 0]], [[0.15, 0.5], [0.45, 0.5]]],
  B: [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]], [[0.45, 0.5], [0.6, 0.35], [0.6, 0.15], [0.45, 0], [0, 0]]],
  C: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15]]],
  D: [[[0, 0], [0, 1], [0.4, 1], [0.6, 0.8], [0.6, 0.2], [0.4, 0], [0, 0]]],
  E: [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
  F: [[[0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.45, 0.5]]],
  G: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.45], [0.3, 0.45]]],
  H: [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
  I: [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]], [[0, 0], [0.6, 0]]],
  J: [[[0.6, 1], [0.6, 0.2], [0.45, 0], [0.15, 0], [0, 0.2]]],
  K: [[[0, 0], [0, 1]], [[0.6, 1], [0, 0.45]], [[0.2, 0.6], [0.6, 0]]],
  L: [[[0, 1], [0, 0], [0.6, 0]]],
  M: [[[0, 0], [0, 1], [0.3, 0.5], [0.6, 1], [0.6, 0]]],
  N: [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
  O: [[[0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15], [0, 0.85], [0.15, 1]]],
  P: [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]]],
  Q: [[[0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15], [0, 0.85], [0.15, 1]], [[0.35, 0.25], [0.6, 0]]],
  R: [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]], [[0.3, 0.5], [0.6, 0]]],
  S: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.65], [0.15, 0.5], [0.45, 0.5], [0.6, 0.35], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
  T: [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
  U: [[[0, 1], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 1]]],
  V: [[[0, 1], [0.3, 0], [0.6, 1]]],
  W: [[[0, 1], [0.15, 0], [0.3, 0.6], [0.45, 0], [0.6, 1]]],
  X: [[[0, 0], [0.6, 1]], [[0, 1], [0.6, 0]]],
  Y: [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
  Z: [[[0, 1], [0.6, 1], [0, 0], [0.6, 0]]],
  '+': [[[0.1, 0.5], [0.5, 0.5]], [[0.3, 0.3], [0.3, 0.7]]],
  '-': [[[0.1, 0.5], [0.5, 0.5]]],
  '.': [[[0.25, 0], [0.35, 0]]],
};

/**
 * Board-space polylines for `label`, centred on `x` and sitting on `baselineY`.
 * A character with no glyph is skipped but still advances, so a designator with
 * an odd character stays legible instead of throwing or bunching up.
 */
const textStrokes = (label, { x, baselineY, height }) => {
  const characters = [...String(label ?? '').toUpperCase()];
  if (!characters.length) return [];
  const advance = (GLYPH_WIDTH + GLYPH_GAP) * height;
  const width = characters.length * advance - GLYPH_GAP * height;
  let cursor = x - width / 2;
  const strokes = [];
  for (const character of characters) {
    for (const polyline of STROKE_FONT[character] || []) {
      strokes.push(polyline.map(([gx, gy]) => [cursor + gx * height, baselineY - gy * height]));
    }
    cursor += advance;
  }
  return strokes;
};

const REF_TEXT_HEIGHT = 1.0;
const REF_TEXT_WIDTH = 0.15;
/** Gap between the courtyard's top edge and the designator's baseline. */
const REF_TEXT_GAP = 0.8;
const OUTLINE_WIDTH = 0.1;

/* ----------------------------------------------------------------- layers -- */

const LAYER_SIDE = { top: 'top', bottom: 'bottom' };

const copperLayer = (layout, side) => {
  const file = gerberFile({
    layerComment: `${side === 'top' ? 'Top' : 'Bottom'} copper`,
    fileFunction: side === 'top' ? 'Copper,L1,Top' : 'Copper,L2,Bot',
    boardHeight: layout.board.height,
  });
  // Through-hole pads and through vias are present on BOTH copper layers.
  for (const component of layout.components) {
    for (const pad of component.pads) paintPad(file, pad, 0);
  }
  for (const via of layout.vias) file.flashCircle(via.diameter, via.x, via.y);
  for (const trace of layout.traces) {
    if (LAYER_SIDE[trace.layer] !== side) continue;
    file.stroke([[trace.from.x, trace.from.y], [trace.to.x, trace.to.y]], trace.width);
  }
  return file.render();
};

const maskLayer = (layout, side) => {
  const file = gerberFile({
    layerComment: `${side === 'top' ? 'Top' : 'Bottom'} solder mask (openings)`,
    fileFunction: side === 'top' ? 'Soldermask,Top' : 'Soldermask,Bot',
    // Negative per the Gerber X2 convention for solder mask: what is drawn is
    // the ABSENCE of mask, i.e. the openings, not the mask itself.
    polarity: 'Negative',
    boardHeight: layout.board.height,
  });
  for (const component of layout.components) {
    for (const pad of component.pads) paintPad(file, pad, RULES.maskExpansion);
  }
  // Vias are deliberately absent: tenting them keeps solder off the barrels and
  // is what every low-cost vendor does by default.
  return file.render();
};

const silkLayer = (layout, side) => {
  const file = gerberFile({
    layerComment: `${side === 'top' ? 'Top' : 'Bottom'} silkscreen`,
    fileFunction: side === 'top' ? 'Legend,Top' : 'Legend,Bot',
    boardHeight: layout.board.height,
  });
  // Every part this pipeline places is through-hole and top-side, so the bottom
  // silkscreen is an empty (but structurally valid) file.
  if (side !== 'top') return file.render();

  const records = layout.components.map((component) => recordForPlacedComponent(component));
  layout.components.forEach((component, index) => {
    for (const primitive of records[index].silk || []) {
      const points = primitivePoints(primitive).map((point) => placedPoint(point, component));
      file.stroke(points, primitive.width || RULES.silkWidth);
    }
  });
  layout.components.forEach((component, index) => {
    const baselineY = courtyardTop(component, records[index]) - REF_TEXT_GAP;
    for (const stroke of textStrokes(component.ref, { x: component.x, baselineY, height: REF_TEXT_HEIGHT })) {
      file.stroke(stroke, REF_TEXT_WIDTH);
    }
  });
  return file.render();
};

const outlineLayer = (layout) => {
  const file = gerberFile({
    layerComment: 'Board outline',
    fileFunction: 'Profile,NP',
    boardHeight: layout.board.height,
  });
  const { x, y, width, height } = layout.board.outline;
  file.stroke([
    [x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y],
  ], OUTLINE_WIDTH);
  return file.render();
};

/* ------------------------------------------------------------------ drill -- */

/** Every plated hole on the board: one per through-hole pad, one per via. */
const drillHoles = (layout) => {
  const holes = [];
  for (const component of layout.components) {
    for (const pad of component.pads) {
      if (pad.drill > 0) holes.push({ diameter: pad.drill, x: pad.x, y: pad.y });
    }
  }
  for (const via of layout.vias) {
    if (via.drill > 0) holes.push({ diameter: via.drill, x: via.x, y: via.y });
  }
  return holes;
};

/**
 * Excellon, metric, explicit decimal points. Same y flip as every Gerber layer
 * (see the module header) so the holes land on the pads.
 */
const drillFile = (layout, holes) => {
  const byDiameter = new Map();
  for (const hole of holes) {
    const key = size3(hole.diameter);
    if (!byDiameter.has(key)) byDiameter.set(key, []);
    byDiameter.get(key).push(hole);
  }
  const diameters = [...byDiameter.keys()].sort((a, b) => Number(a) - Number(b));

  const lines = ['M48', 'FMAT,2', 'METRIC,TZ'];
  diameters.forEach((diameter, index) => lines.push(`T${index + 1}C${diameter}`));
  lines.push('%');
  lines.push('G90');
  lines.push('G05');
  diameters.forEach((diameter, index) => {
    lines.push(`T${index + 1}`);
    const hits = [...byDiameter.get(diameter)]
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const hit of hits) {
      lines.push(`X${size3(hit.x)}Y${size3(layout.board.height - hit.y)}`);
    }
  });
  lines.push('T0');
  lines.push('M30');
  lines.push('');
  return lines.join('\n');
};

/* ----------------------------------------------------------------- readme -- */

const readmeFile = (layout, circuit, holes, names) => [
  `PCB Pilot fabrication package - ${circuit?.title || 'circuit'}`,
  '',
  `Board:      ${human(layout.board.width)} x ${human(layout.board.height)} mm`,
  `Stack:      2-layer FR-4, ${human(layout.board.thickness)} mm finished thickness, 1 oz copper`,
  '            L1 = top copper, L2 = bottom copper. All holes plated (PTH).',
  '',
  'Files:',
  ...names.map((name) => `  ${name}`),
  '',
  'Design rules used (mm):',
  `  Trace width:        ${human(RULES.traceWidth)} nominal, ${human(RULES.minTraceWidth)} minimum (neck-down)`,
  `  Clearance:          ${human(RULES.clearance)}`,
  `  Via:                ${human(RULES.viaDiameter)} pad / ${human(RULES.viaDrill)} drill`,
  `  Solder mask expansion: ${human(RULES.maskExpansion)} per side`,
  `  Silkscreen width:   ${human(RULES.silkWidth)}`,
  `  Copper to edge:     ${human(RULES.edgeClearance)}`,
  '',
  `Nets: ${layout.nets.length}`,
  `Components: ${layout.components.length}`,
  `Drilled holes: ${holes.length}`,
  '',
  'Notes:',
  '  - Gerbers are RS-274X, millimetres, 4.6 format, positive polarity.',
  '  - Solder mask files contain the OPENINGS; vias tented (no mask opening).',
  '  - Electrolytic capacitor and diode polarity per silkscreen.',
  '',
].join('\n');

/* ---------------------------------------------------------------- archive -- */

/**
 * Builds the fabrication archive for a finished layout.
 *
 * @param {ReturnType<typeof import('./pcbLayout.js').buildPcbLayout>} layout
 * @param {{ title?: string }} [circuit]
 * @returns {{ files: Array<{ name: string, data: string }>, zip: Uint8Array,
 *   summary: { boardWidth: number, boardHeight: number, layerFiles: string[],
 *     drillCount: number, netCount: number, componentCount: number } }}
 * @throws {PcbExportError} when the board is not fabricable.
 */
export const toGerberArchive = (layout, circuit) => {
  const report = {
    failedNets: layout?.routing?.failedNets ?? [],
    violations: layout?.drc?.violations ?? [],
    incompleteNets: layout?.connectivity?.incompleteNets ?? [],
  };
  if (!layout?.routing?.complete || !layout?.drc?.ok || !layout?.connectivity?.ok) {
    throw new PcbExportError(report);
  }

  const slug = slugify(circuit?.title);
  const holes = drillHoles(layout);
  const names = [
    `${slug}.GTL`, `${slug}.GBL`, `${slug}.GTS`, `${slug}.GBS`,
    `${slug}.GTO`, `${slug}.GBO`, `${slug}.GKO`, `${slug}.DRL`, 'PCB-README.txt',
  ];

  const files = [
    { name: names[0], data: copperLayer(layout, 'top') },
    { name: names[1], data: copperLayer(layout, 'bottom') },
    { name: names[2], data: maskLayer(layout, 'top') },
    { name: names[3], data: maskLayer(layout, 'bottom') },
    { name: names[4], data: silkLayer(layout, 'top') },
    { name: names[5], data: silkLayer(layout, 'bottom') },
    { name: names[6], data: outlineLayer(layout) },
    { name: names[7], data: drillFile(layout, holes) },
    { name: names[8], data: readmeFile(layout, circuit, holes, names) },
  ];

  return {
    files,
    zip: zipStore(files),
    summary: {
      boardWidth: layout.board.width,
      boardHeight: layout.board.height,
      layerFiles: names,
      drillCount: holes.length,
      netCount: layout.nets.length,
      componentCount: layout.components.length,
    },
  };
};
