// Pure model for the manual board-routing editor: stroke drawing, the stored
// manualRouting value, ratsnest lines and the progress summary. Everything
// here is plain data in board millimetres (y-down) — the component owns
// pixels, pointers and React state.
//
// A "stroke" is one drawing gesture: lock a net on a pad, click waypoints,
// finish on a pad. It becomes ordinary pipeline traces (`{layer, net, from,
// to, width}`) tagged with a `stroke` id so the gesture stays deletable as a
// unit; the pipeline and exporters ignore the tag.
import { RULES } from '../../core/pcbDesignRules.js';
import { autoRouteLayout } from '../../core/pcbLayout.js';
import { spanningEdges } from '../../core/pcbRoute.js';

export const EMPTY_ROUTING = { placement: '', traces: [], vias: [] };

/** Every pad on the board, flattened, with its owner ref. */
export const boardPads = (layout) =>
  (layout?.components || []).flatMap((component) =>
    component.pads.map((pad) => ({ ...pad, ref: component.ref })));

/** Pads that belong to `net` (the highlight set once a net is locked). */
export const netPads = (layout, net) =>
  boardPads(layout).filter((pad) => pad.connected && pad.net === net);

/** Snap a board point to the routing grid. */
export const snapPoint = (point, pitch = RULES.gridPitch) => ({
  x: Math.round(point.x / pitch) * pitch,
  y: Math.round(point.y / pitch) * pitch,
});

/**
 * The waypoint a cursor position actually produces: the segment from `from`
 * is constrained to horizontal, vertical or 45° — whichever of the three the
 * cursor is closest to — then snapped to the grid along its free axis.
 */
export const routeCorner = (from, cursor, pitch = RULES.gridPitch) => {
  const dx = cursor.x - from.x;
  const dy = cursor.y - from.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX >= 2 * absY) return snapPoint({ x: cursor.x, y: from.y }, pitch);
  if (absY >= 2 * absX) return snapPoint({ x: from.x, y: cursor.y }, pitch);
  const run = Math.round(Math.min(absX, absY) / pitch) * pitch;
  return {
    x: from.x + Math.sign(dx) * run,
    y: from.y + Math.sign(dy) * run,
  };
};

/**
 * Start a stroke on a pad. Points carry the layer of the segment LEAVING
 * them; toggling layers mid-route records a via at the current end.
 */
export const beginStroke = (id, net, start, layer = 'top') => ({
  id,
  net,
  points: [{ x: start.x, y: start.y, layer }],
  vias: [],
});

export const strokeEnd = (stroke) => stroke.points[stroke.points.length - 1];

export const currentLayer = (stroke) => strokeEnd(stroke).layer;

/** Append a waypoint (same layer continues). Zero-length clicks are ignored. */
export const addWaypoint = (stroke, point) => {
  const end = strokeEnd(stroke);
  if (Math.hypot(point.x - end.x, point.y - end.y) < 1e-9) return stroke;
  return {
    ...stroke,
    points: [...stroke.points, { x: point.x, y: point.y, layer: end.layer }],
  };
};

/** Drop a via at the stroke's current end and continue on the other layer. */
export const toggleStrokeLayer = (stroke) => {
  const end = strokeEnd(stroke);
  const other = end.layer === 'top' ? 'bottom' : 'top';
  return {
    ...stroke,
    points: [...stroke.points.slice(0, -1), { ...end, layer: other }],
    vias: [...stroke.vias, { x: end.x, y: end.y }],
  };
};

/** Remove the last waypoint (Backspace). The start pad point always stays. */
export const dropLastWaypoint = (stroke) => (
  stroke.points.length > 1 ? { ...stroke, points: stroke.points.slice(0, -1) } : stroke
);

/**
 * Close the stroke on `end` (a pad centre of the locked net) and emit
 * pipeline traces + vias. Consecutive duplicate points collapse.
 */
export const finishStroke = (stroke, end) => {
  const points = [...stroke.points];
  const last = points[points.length - 1];
  if (Math.hypot(end.x - last.x, end.y - last.y) >= 1e-9) {
    points.push({ x: end.x, y: end.y, layer: last.layer });
  }
  const traces = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    traces.push({
      stroke: stroke.id,
      layer: a.layer,
      net: stroke.net,
      from: { x: a.x, y: a.y },
      to: { x: b.x, y: b.y },
      width: RULES.traceWidth,
    });
  }
  const vias = stroke.vias.map((via) => ({
    stroke: stroke.id,
    x: via.x,
    y: via.y,
    net: stroke.net,
    diameter: RULES.viaDiameter,
    drill: RULES.viaDrill,
  }));
  return { traces, vias };
};

/** Commit a finished stroke into the stored manualRouting value. */
export const commitStroke = (routing, placement, finished) => ({
  placement,
  traces: [...(routing?.traces || []), ...finished.traces],
  vias: [...(routing?.vias || []), ...finished.vias],
});

/** Delete every trace and via a stroke id put on the board. */
export const deleteStroke = (routing, strokeId) => ({
  ...routing,
  traces: (routing?.traces || []).filter((trace) => trace.stroke !== strokeId),
  vias: (routing?.vias || []).filter((via) => via.stroke !== strokeId),
});

/**
 * The Auto-route button's result as a stored manualRouting value: every trace
 * and via tagged `auto:<net>`, so one click on any auto trace deletes that
 * net's auto copper and leaves it hand-routable.
 */
export const autoRoutedManual = (layout) => {
  const routed = autoRouteLayout(layout);
  return {
    placement: layout.placement,
    traces: routed.traces.map((trace) => ({ ...trace, stroke: `auto:${trace.net}` })),
    vias: routed.vias.map((via) => ({ ...via, stroke: `auto:${via.net}` })),
    failedNets: routed.failedNets,
  };
};

/**
 * Ghost lines for the copper still missing: spanning edges of every net the
 * connectivity checker reports incomplete. Pad-to-pad MST — not island-aware,
 * so a half-routed net shows its full skeleton until it closes; the lines are
 * guidance, the checker is the authority.
 */
export const ratsnestFor = (layout) => {
  if (!layout) return [];
  const incomplete = new Set((layout.connectivity?.incompleteNets || []).map((entry) => entry.net));
  const lines = [];
  for (const net of layout.nets || []) {
    if (!incomplete.has(net)) continue;
    const pads = netPads(layout, net);
    for (const edge of spanningEdges(pads)) {
      lines.push({
        net,
        from: { x: pads[edge.from].x, y: pads[edge.from].y },
        to: { x: pads[edge.to].x, y: pads[edge.to].y },
      });
    }
  }
  return lines;
};

/**
 * Client pixel → board millimetres, mirroring breadboardGeometry's
 * clientToViewBox: prefer the real screen CTM, fall back to rect proportions
 * (and to the viewBox itself when the rect has no size — jsdom).
 */
export const clientToBoard = (svg, clientX, clientY, viewBox) => {
  const ctm = svg?.getScreenCTM?.();
  if (ctm && typeof DOMPoint !== 'undefined') {
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }
  const rect = svg?.getBoundingClientRect?.();
  const width = rect?.width || viewBox.width;
  const height = rect?.height || viewBox.height;
  const left = rect?.left || 0;
  const top = rect?.top || 0;
  return {
    x: viewBox.x + ((clientX - left) / width) * viewBox.width,
    y: viewBox.y + ((clientY - top) / height) * viewBox.height,
  };
};

/** First stroke id not already on the board: m1, m2, … */
export const nextStrokeId = (routing) => {
  let highest = 0;
  for (const item of [...(routing?.traces || []), ...(routing?.vias || [])]) {
    const match = /^m(\d+)$/.exec(item.stroke || '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `m${highest + 1}`;
};

/** "7 of 12 nets connected · 1 DRC violation" — the editor's status line. */
export const progressSummary = (layout) => {
  if (!layout) return '';
  const multiPad = (layout.nets || []).filter((net) => netPads(layout, net).length >= 2);
  const incomplete = new Set((layout.connectivity?.incompleteNets || []).map((entry) => entry.net));
  const connected = multiPad.filter((net) => !incomplete.has(net));
  const violations = layout.drc?.violations?.length || 0;
  const parts = [`${connected.length} of ${multiPad.length} nets connected`];
  if (violations) parts.push(`${violations} DRC violation${violations === 1 ? '' : 's'}`);
  return parts.join(' · ');
};
