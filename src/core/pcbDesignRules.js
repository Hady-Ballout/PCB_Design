// Fabrication design rules for the procedural PCB pipeline.
//
// One place for every number a fab house would care about, shared by the
// placer (pcbPlace.js), the maze router (pcbRoute.js), the independent design
// rule checker (pcbDrc.js) and the layout orchestrator (pcbLayout.js). All
// dimensions are millimetres.
//
// The values below describe a comfortable 2-layer through-hole process:
// 0.8 mm traces with 0.3 mm clearance is well inside every low-cost vendor's
// 6/6 mil capability, and the 0.635 mm routing grid is 2.54 / 4, so every
// DIP/header pad centre lands a whole number of grid steps from its
// neighbours.

/**
 * @typedef {{ gridPitch: number, traceWidth: number, clearance: number,
 *   viaDiameter: number, viaDrill: number, edgeClearance: number,
 *   boardMargin: number, placementGap: number, maskExpansion: number,
 *   silkWidth: number, boardThickness: number }} DesignRules
 */

/** @type {DesignRules} */
export const RULES = {
  /** Routing grid pitch — 2.54/4, so THT pads sit on grid multiples. */
  gridPitch: 0.635,
  /** Signal trace width. */
  traceWidth: 0.8,
  /** Copper-to-copper clearance between different nets. */
  clearance: 0.3,
  /** Through-via finished outer diameter / drill. */
  viaDiameter: 1.2,
  viaDrill: 0.6,
  /** Copper to board edge. */
  edgeClearance: 0.5,
  /** Outermost courtyard to board edge (used by the placer). */
  boardMargin: 4,
  /** Courtyard-to-courtyard clearance between neighbouring parts. */
  placementGap: 2.0,
  /** Solder mask opening grown past the pad on each side. */
  maskExpansion: 0.05,
  /** Silkscreen line width. */
  silkWidth: 0.15,
  /** Finished board thickness. */
  boardThickness: 1.6,
};

/**
 * Minimum copper ring left around a hole. Pads come from the vendored KiCad
 * library and vias from RULES, so these are acceptance checks rather than
 * knobs: a pad must be at least `drill + PAD_ANNULAR_RING`, a via at least
 * `drill + VIA_ANNULAR_RING`.
 */
export const PAD_ANNULAR_RING = 0.6;
export const VIA_ANNULAR_RING = 0.4;

/**
 * Conservative copper radius of a pad. Rect pads are modelled as their
 * circumscribing circle (Math.hypot(w,h)/2 — the distance to a rect corner),
 * which never under-reports copper, so clearance checks stay on the safe
 * side; other shapes use max(w,h)/2. `size` is checked before `diameter` so a
 * caller that sets both (pcbLayout.js derives `diameter = max(size.w,
 * size.h)` for display) still gets the true circumscribing radius for rect
 * pads instead of the diameter-derived inscribed one.
 *
 * @param {{ diameter?: number, size?: { w: number, h: number }, shape?: string }} pad
 */
export const padCopperRadius = (pad) => {
  if (pad?.size) return pad.shape === 'rect'
    ? Math.hypot(pad.size.w, pad.size.h) / 2
    : Math.max(pad.size.w, pad.size.h) / 2;
  if (Number.isFinite(pad?.diameter)) return pad.diameter / 2;
  return 0;
};
