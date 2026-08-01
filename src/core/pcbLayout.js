// Procedural PCB layout: the orchestrator that turns a circuit into a
// manufacturable two-layer board, with no KiCad install required.
//
// The pipeline is four independent stages:
//   1. pcbFootprints.js — real vendored KiCad footprint geometry per part
//   2. pcbPlace.js      — netlist-aware placement with courtyard clearance
//   3. pcbRoute.js      — clearance-aware two-layer A* maze routing
//   4. pcbDrc.js        — an independent measurement of the finished copper
//
// If routing leaves nets unfinished, the board is re-placed on a roomier
// outline (the expansion ladder below) and routed again from scratch, mirroring
// routeWithExpansion in schematicLayout.js. What comes back always carries the
// verdict with it: `routing`, `drc` and `connectivity` say whether the board is
// actually fabricable, so a caller never has to guess.
//
// All dimensions are millimetres, y-down.
import { RULES } from './pcbDesignRules.js';
import { checkConnectivity, runDrc } from './pcbDrc.js';
import { bodyKindFor } from './pcbFootprints.js';
import {
  isUnconnectedTerminal,
  placeComponents,
  placementBounds,
  placementPads,
} from './pcbPlace.js';
import { routeBoard } from './pcbRoute.js';

export const BOARD_THICKNESS = RULES.boardThickness;
export const TRACE_WIDTH = RULES.traceWidth;
export const VIA_DIAMETER = RULES.viaDiameter;
// Fallback pad diameter for callers that don't read a pad's own `diameter`.
export const PAD_DIAMETER = 1.8;

/**
 * How much extra room each routing attempt gets. The first pass is the tight
 * placement; each retry re-places from scratch (rotations and relative order
 * are preserved, distances grow) and re-routes.
 */
const EXPANSION_LADDER = [1, 1.15, 1.35, 1.6];

const round = (value) => Math.round(value * 100) / 100;

/** One placement + routing pass at a given expansion factor. */
const layoutAttempt = (parts, expandFactor) => {
  const { placements, board } = placeComponents(parts, { expandFactor });

  const components = placements.map((placement) => {
    const { part } = placement;
    // Extents of the placed (rotated) courtyard, so width/height stay the
    // on-board footprint size. `courtyard` itself remains footprint-local and
    // unrotated — pair it with `rotation` to rebuild the placed outline.
    const bounds = placementBounds(placement);
    return {
      ref: part.ref,
      kind: part.kind,
      value: part.value,
      body: bodyKindFor(placement.libId, part),
      rotation: placement.rotation,
      libId: placement.libId,
      courtyard: placement.footprint.courtyard,
      x: placement.x,
      y: placement.y,
      width: round(bounds.maxX - bounds.minX),
      height: round(bounds.maxY - bounds.minY),
      pads: placementPads(placement).map((placedPad) => ({
        x: round(placedPad.x),
        y: round(placedPad.y),
        net: placedPad.net,
        pinIndex: placedPad.index + 1,
        connected: !isUnconnectedTerminal(placedPad.net, part.ref, placedPad.index + 1),
        padNumber: placedPad.padNumber,
        drill: placedPad.pad.drill,
        diameter: Math.max(placedPad.pad.size.w, placedPad.pad.size.h),
        shape: placedPad.pad.shape,
        size: placedPad.pad.size,
      })),
    };
  });

  // Nets, in pad order, so the list reads the way the circuit does.
  const netPads = new Map();
  for (const component of components) {
    for (const pad of component.pads) {
      if (!pad.connected) continue;
      if (!netPads.has(pad.net)) netPads.set(pad.net, []);
      netPads.get(pad.net).push(pad);
    }
  }

  const routed = routeBoard({ components, board });

  const layout = {
    board: {
      width: board.width,
      height: board.height,
      thickness: BOARD_THICKNESS,
      outline: { x: 0, y: 0, width: board.width, height: board.height },
    },
    components,
    traces: routed.traces,
    vias: routed.vias,
    nets: [...netPads.keys()],
    routing: { complete: routed.failedNets.length === 0, failedNets: routed.failedNets },
  };
  layout.drc = runDrc(layout);
  layout.connectivity = checkConnectivity(layout);
  return layout;
};

/**
 * Places and routes a circuit onto a single two-layer board.
 *
 * @param {object} circuit
 * @param {{ expandFactor?: number }} [options] `expandFactor > 1` spreads the
 *   parts apart before the first attempt; the retry ladder is applied on top
 *   of it.
 * @returns {null | { board: object, components: Array<object>, traces: Array<object>,
 *   vias: Array<object>, nets: string[],
 *   routing: { complete: boolean, failedNets: Array<object> },
 *   drc: { ok: boolean, violations: Array<object> },
 *   connectivity: { ok: boolean, incompleteNets: Array<object> } }}
 */
export const buildPcbLayout = (circuit, options = {}) => {
  const parts = (circuit?.components || []).filter((part) => part.kind !== 'ground');
  if (!parts.length) return null;

  const base = options.expandFactor ?? 1;
  let best = null;
  for (const factor of EXPANSION_LADDER) {
    const attempt = layoutAttempt(parts, base * factor);
    const better = !best
      || attempt.routing.failedNets.length < best.routing.failedNets.length
      || (attempt.routing.failedNets.length === best.routing.failedNets.length
        && attempt.drc.violations.length < best.drc.violations.length);
    if (better) best = attempt;
    if (best.routing.complete && best.drc.ok && best.connectivity.ok) break;
  }
  return best;
};
