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
 * Minimum copper ring left around a hole, PER SIDE — the way a fab house quotes
 * it. The check is `narrowest copper diameter >= drill + 2 * ring`, measured on
 * the pad's INSCRIBED width (a ring is thinnest across the pad's short axis, so
 * measuring the circumscribing diameter of a non-square pad is a false PASS).
 *
 * Pads come from the vendored KiCad library and vias from RULES, so these are
 * acceptance checks rather than knobs.
 *
 * 0.13 mm is JLCPCB's stated minimum annular ring for a 2-layer THT board. The
 * KiCad 6.0.11 library footprints are drawn to be manufacturable at exactly
 * these dimensions and are fab-proven at them — TO-92_Inline puts 1.05 mm of
 * copper on a 0.75 mm drill, i.e. 0.15 mm per side — so the rule gives way to
 * the vendored geometry rather than the other way round. The via rule is
 * unchanged (0.2 mm per side on RULES.viaDrill/viaDiameter = 1.0 mm needed
 * against 1.2 mm supplied).
 */
export const PAD_ANNULAR_RING = 0.13;
export const VIA_ANNULAR_RING = 0.2;

/**
 * Clearance OVER-APPROXIMATION of a pad's copper: the radius of a circle that
 * is guaranteed to contain every square micron of it. Rect pads use their
 * circumscribing circle (Math.hypot(w,h)/2 — the distance to a rect corner),
 * other shapes max(w,h)/2. `size` is checked before `diameter` so a caller
 * that sets both (pcbLayout.js derives `diameter = max(size.w, size.h)` for
 * display) still gets the true circumscribing radius for rect pads instead of
 * the diameter-derived inscribed one.
 *
 * Because it never under-reports copper it is safe for keep-out work — router
 * obstacle stamping, and the cheap reject in front of the DRC clearance check.
 * It is NOT a containment test: a point inside this circle is not necessarily
 * on the pad (a 3x3 rect pad's circle reaches 0.62 mm past its own edge). Any
 * "is this point actually on pad copper?" question must use
 * `padCopperDistance`, which is shape-exact.
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

/**
 * A pad's EXACT copper outline, as a rounded rectangle: the axis-aligned core
 * rectangle of half-extents `hw`/`hh` centred on (`x`,`y`), turned by `angle`
 * radians, then inflated by `r` in every direction. Every pad shape the
 * pipeline produces is one of these:
 *
 *   rect   w x h  ->  hw = w/2, hh = h/2, r = 0            (a plain rectangle)
 *   oval   w x h  ->  r = min(w,h)/2, hw = w/2 - r, hh = h/2 - r   (a stadium)
 *   circle d      ->  hw = hh = 0, r = d/2                 (a degenerate core)
 *
 * Anything else — a shape the library does not ship today — is modelled as its
 * BOUNDING RECTANGLE. That is the conservative choice for the question this
 * function exists to answer: a bounding rectangle can only over-claim copper in
 * the corners of a shape already inside it, whereas the old fallback (a
 * max(w,h)/2 circle marked exact) would have reinstated the containment bug in
 * full — for a 4 x 1 mm pad it claims 2 mm of copper in every direction, 1.5 mm
 * of it fictional, and a terminal cell picked there would miss the pad entirely.
 *
 * Angle semantics — verified against the pad objects that actually flow
 * through the pipeline, not just the field name:
 *
 * * Every pad in the vendored KiCad library carries `angle: 0`.
 * * pcbPlace.js's `rotatePadShape` puts the placement rotation into `size`
 *   (w/h swap at 90/270) *and* into `angle` ((angle + rotation) % 180), which
 *   double-counts it — a 1.05 x 1.5 TO-92 pad turned 90 degrees comes out as
 *   size 1.5 x 1.05 *plus* angle 90, and honouring both would turn it back to
 *   1.05 x 1.5.
 * * pcbLayout.js (see the `pads` mapping) copies `shape`, `size`, `drill` and
 *   `diameter` onto the layout pad and deliberately does not copy `angle`.
 *
 * So the pads the router and the DRC measure carry board-space `size` and no
 * `angle` at all, and treating `size` as already-rotated is the correct
 * reading. `angle` stays in the contract as the pad's residual tilt *within*
 * that board-space frame — zero for everything we ship — so a future
 * non-orthogonal pad still measures correctly. `pcbDesignRules.test.js` pins
 * both halves of this ("reads a 90-degree-rotated TO-92 oval pad from its
 * board-space size alone").
 *
 * @param {{ x?: number, y?: number, diameter?: number, angle?: number,
 *   size?: { w: number, h: number }, shape?: string }} pad
 * @returns {{ x: number, y: number, hw: number, hh: number, r: number, angle: number }}
 */
export const padCopperShape = (pad) => {
  const angle = ((pad?.angle ?? 0) * Math.PI) / 180;
  const x = pad?.x ?? 0;
  const y = pad?.y ?? 0;
  if (pad?.size && Number.isFinite(pad.size.w) && Number.isFinite(pad.size.h)) {
    const halfW = pad.size.w / 2;
    const halfH = pad.size.h / 2;
    if (pad.shape === 'rect') return { x, y, hw: halfW, hh: halfH, r: 0, angle };
    if (pad.shape === 'oval') {
      const r = Math.min(halfW, halfH);
      return { x, y, hw: halfW - r, hh: halfH - r, r, angle };
    }
    // Every circular pad the library ships carries a square `size`; keep it a
    // disc rather than letting the bounding-rectangle fallback square it off.
    if (pad.shape === 'circle') return { x, y, hw: 0, hh: 0, r: Math.max(halfW, halfH), angle };
    return { x, y, hw: halfW, hh: halfH, r: 0, angle };
  }
  return { x, y, hw: 0, hh: 0, r: padCopperRadius(pad), angle };
};

/**
 * Signed distance from a point to a pad's true copper boundary: negative
 * inside the copper, zero on the edge, positive outside. This is the exact
 * containment predicate `padCopperRadius` is not — use it wherever the
 * question is "does this land on the pad?".
 *
 * @param {Parameters<typeof padCopperShape>[0]} pad
 * @param {number} x
 * @param {number} y
 * @returns {number} millimetres, <= 0 when (x,y) is on copper
 */
export const padCopperDistance = (pad, x, y) => {
  const shape = padCopperShape(pad);
  const dx = x - shape.x;
  const dy = y - shape.y;
  const cos = Math.cos(shape.angle);
  const sin = Math.sin(shape.angle);
  const localX = Math.abs(dx * cos + dy * sin) - shape.hw;
  const localY = Math.abs(dy * cos - dx * sin) - shape.hh;
  return Math.hypot(Math.max(localX, 0), Math.max(localY, 0))
    + Math.min(Math.max(localX, localY), 0)
    - shape.r;
};

/**
 * The corners of a pad's exact core rectangle, in board coordinates: four
 * points for a rect pad, two for a stadium (the core collapses to a segment),
 * one for a circle. Paired with `padCopperShape(pad).r` this is the pad's
 * copper as "convex hull inflated by r", which is what pcbDrc.js measures
 * against traces and other pads.
 *
 * @param {ReturnType<typeof padCopperShape>} shape
 * @returns {Array<[number, number]>}
 */
export const copperCorePoints = (shape) => {
  const cos = Math.cos(shape.angle);
  const sin = Math.sin(shape.angle);
  const at = (u, v) => [shape.x + u * cos - v * sin, shape.y + u * sin + v * cos];
  if (shape.hw > 0 && shape.hh > 0) {
    return [at(-shape.hw, -shape.hh), at(shape.hw, -shape.hh), at(shape.hw, shape.hh), at(-shape.hw, shape.hh)];
  }
  if (shape.hw > 0 || shape.hh > 0) return [at(-shape.hw, -shape.hh), at(shape.hw, shape.hh)];
  return [at(0, 0)];
};
