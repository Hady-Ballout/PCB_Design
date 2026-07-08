// Pure transform from the canonical `circuit` object into a breadboard
// placement model for the realistic-schematic view. No React imports so it
// stays unit-testable. Placement is a greedy, deterministic single pass over
// `circuit.components` in array order.

import { DEFAULT_COLUMNS, FULL_SIZE_COLUMNS, STRIP_ROWS, boardSize, isRailStrip, mcuSlotRect, tieGroupKey } from './breadboardGeometry.js';

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

export const GROUND_NET = '0';
const SUPPLY_NAME_PATTERN = /^(vcc|vdd|v\+|vin|vs|vsupply)$/i;

const TO92_KINDS = new Set(['bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p']);

const GROUND_WIRE_COLOR = '#1f1f1f';
const SUPPLY_WIRE_COLOR = '#c0392b';
const SIGNAL_WIRE_COLORS = ['#e6b422', '#3a9e4c', '#e07020', '#4a7fe0', '#9a5fd0', '#7d7d7d'];

// Trench-straddling packages are described by a leg layout: for each strip,
// the canonical pin index carried by the leg at each column offset (null legs
// exist physically but carry no canonical pin). The DIP-8 layout realizes the
// virtual 741-style pinout for the canonical 5-pin opamp [IN+, IN-, OUT, V+,
// V-]: DIP pins 1-4 on the bottom strip at row f, pins 5-8 on the top strip at
// row e.
const DIP_WIDTH_COLUMNS = 4;
const OPAMP_LEG_LAYOUT = { bottom: [null, 1, 0, 4], top: [null, 3, 2, null] };

// Canonical positional pin lists for the microcontroller boards. Order is the
// contract the AI is taught (server/ai/ollamaProvider.ts) and what the
// selection pin labels display; unused pins ride on NC_* placeholder nets.
export const MCU_PINS = {
  arduino_uno: ['5V', '3V3', 'GND', 'VIN', 'D2', 'D3', 'D5', 'D9', 'D13', 'A0', 'A1', 'A2'],
  raspberry_pi: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22'],
  esp32: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
};

// Arduino Uno and Raspberry Pi cannot plug into a breadboard; they sit in
// off-board slots below it with jumper wires up to the bottom strip/rails.
// The ESP32 DevKit module straddles the trench like a wide DIP.
const OFFBOARD_MCU_KINDS = new Set(['arduino_uno', 'raspberry_pi']);
const ESP32_WIDTH_COLUMNS = 6;
const ESP32_LEG_LAYOUT = { bottom: [0, 1, 4, 5, 6, 7], top: [2, 3, 11, 10, 9, 8] };

const LEAD_SPAN = 3; // default columns between a two-lead part's legs
const MAX_DIRECT_SPAN = 8; // widest a part stretches to plug straight into home groups
const MAX_REACH = 6; // how far back a leg reaches to reuse a home group
const PART_GAP = 2; // free columns kept between parts

// `overrides` is an optional persisted placement layer: { parts: { [ref]:
// { strip, column } } } pinning a part's leftmost column/strip (see the
// realistic-schematic editor). Absent/empty overrides must reproduce the pure
// auto-placement byte-for-byte — the two-phase pass below collapses to the
// original single greedy pass when nothing is pinned.
export function circuitToBreadboard(circuit, overrides = {}) {
  const components = circuit?.components ?? [];
  const overrideParts = overrides?.parts ?? {};
  let columns = DEFAULT_COLUMNS;
  const warnings = [];
  const rails = { railTopPlus: null, railTopMinus: null, railBottomPlus: null, railBottomMinus: null };
  const jumpers = [];
  const parts = [];
  const batteries = [];

  // --- tie groups: one 5-hole vertical group per (strip, column) ---
  const groups = new Map(); // "strip:col" -> { net, linked, rows: bool[] }
  const groupKey = (strip, column) => `${strip}:${column}`;
  const groupAt = (strip, column) => {
    const key = groupKey(strip, column);
    if (!groups.has(key)) {
      groups.set(key, { strip, column, net: null, linked: false, rows: new Array(STRIP_ROWS[strip]).fill(false) });
    }
    return groups.get(key);
  };
  const groupHasSpace = (key) => {
    const group = groups.get(key);
    return !group || group.rows.some((used) => !used);
  };
  const takeHole = (strip, column, preferredRow = null) => {
    const group = groupAt(strip, column);
    let row = preferredRow != null && !group.rows[preferredRow] ? preferredRow : group.rows.indexOf(false);
    if (row === -1) return null;
    group.rows[row] = true;
    return { strip, column, row };
  };
  const takeHoleByKey = (key) => {
    const [strip, columnText] = key.split(':');
    return takeHole(strip, Number(columnText));
  };

  // --- jumper wires ---
  let jumperSeq = 0;
  const netColors = new Map();
  const wireColor = (net) => {
    if (net === GROUND_NET) return GROUND_WIRE_COLOR;
    if (rails.railTopPlus === net || rails.railBottomPlus === net) return SUPPLY_WIRE_COLOR;
    if (!netColors.has(net)) netColors.set(net, SIGNAL_WIRE_COLORS[netColors.size % SIGNAL_WIRE_COLORS.length]);
    return netColors.get(net);
  };
  const pushJumper = (net, from, to) => {
    jumperSeq += 1;
    jumpers.push({ id: `j${jumperSeq}`, net, color: wireColor(net), from, to });
  };

  // --- power rails ---
  const railStripsFor = (net) => Object.keys(rails).filter((key) => rails[key] === net);
  const isRailNet = (net) => railStripsFor(net).length > 0;
  const assignRail = (railKey, net) => {
    const existing = railStripsFor(net);
    rails[railKey] = net;
    // The same net on two rails must be physically bridged; do it at the right edge.
    if (existing.length > 0) {
      pushJumper(net, { strip: existing[0], column: columns, row: 0 }, { strip: railKey, column: columns, row: 0 });
    }
  };
  const railHoleFor = (net, column, side) => {
    const keys = railStripsFor(net);
    const preferred = keys.find((key) => key.startsWith(side === 'bottom' ? 'railBottom' : 'railTop'));
    return { strip: preferred || keys[0], column, row: 0 };
  };

  const usesGround = components.some((component) => (component.nodes ?? []).includes(GROUND_NET));
  if (usesGround) assignRail('railTopMinus', GROUND_NET);

  // Voltage sources live off-board as battery packs feeding the rails.
  const sources = components.filter((component) => component.kind === 'voltage_source');
  sources.forEach((source, index) => {
    if (index >= 2) {
      warnings.push(`${source.ref}: only two supplies fit on the rails; this one is not drawn.`);
      return;
    }
    const [first, second] = source.nodes ?? [];
    const plusNet = first === GROUND_NET ? second : first;
    const minusNet = first === GROUND_NET ? first : second;
    const [plusKey, minusKey] = index === 0
      ? ['railTopPlus', 'railTopMinus']
      : ['railBottomPlus', 'railBottomMinus'];
    if (plusNet != null && !isRailNet(plusNet)) assignRail(plusKey, plusNet);
    if (minusNet != null && !isRailNet(minusNet)) assignRail(minusKey, minusNet);
    batteries.push({
      ref: source.ref,
      value: source.value,
      nets: [plusNet ?? null, minusNet ?? null],
      plusHole: plusNet != null ? railHoleFor(plusNet, 1 + index, index === 0 ? 'top' : 'bottom') : null,
      minusHole: minusNet != null ? railHoleFor(minusNet, 1 + index, index === 0 ? 'top' : 'bottom') : null,
    });
  });
  // No explicit source: still put a conventionally named supply net on the rail.
  if (rails.railTopPlus == null) {
    const named = (circuit?.nodes ?? []).find((net) => SUPPLY_NAME_PATTERN.test(String(net)));
    if (named) assignRail('railTopPlus', named);
  }
  // Microcontroller 5V/3V3 output pins power the rails when nothing else does,
  // so MCU-powered circuits (no battery at all) still tap clean rail wires
  // instead of stringing supply nets through signal tie groups.
  components.forEach((component) => {
    const pins = MCU_PINS[component.kind];
    if (!pins) return;
    pins.forEach((name, pinIndex) => {
      if (name !== '5V' && name !== '3V3') return;
      const net = component.nodes?.[pinIndex];
      if (net == null || isUnconnectedTerminal(net, component.ref, pinIndex + 1)) return;
      if (net === GROUND_NET || isRailNet(net)) return;
      const freeKey = ['railTopPlus', 'railBottomPlus'].find((key) => rails[key] == null);
      if (freeKey) assignRail(freeKey, net);
    });
  });

  // --- net home groups ---
  const netHome = new Map(); // net -> group key currently open for new taps
  const netGroupKeys = new Map(); // net -> every group key carrying the net
  // Only groups holding a two-lead part's leg accept direct plug-ins; groups
  // under a TO-92/TO-220/DIP footprint get taps via jumpers so bodies never
  // overlap. Filled by finalizePart.
  const sharableGroups = new Set();

  // Tie the group at (strip, column) into `net`'s wider network: rails get a
  // jumper to the rail, the net's first group becomes its home, later groups
  // get one jumper back to the home (or any group of the net with free holes).
  // Bottom-strip consumers get power from mirrored bottom rails instead of
  // arcing across the whole board to the top ones.
  const mirrorRailToBottom = (net) => {
    if (!railStripsFor(net).every((railKey) => railKey.startsWith('railTop'))) return;
    const mirrorKey = rails.railTopPlus === net ? 'railBottomPlus' : 'railBottomMinus';
    if (rails[mirrorKey] == null) assignRail(mirrorKey, net);
  };

  const ensureConnected = (net, strip, column) => {
    const key = groupKey(strip, column);
    const group = groupAt(strip, column);
    if (group.net === net && group.linked) return;
    group.net = net;
    group.linked = true;

    if (isRailNet(net)) {
      if (strip === 'bottom') mirrorRailToBottom(net);
      const hole = takeHole(strip, column);
      if (hole) pushJumper(net, hole, railHoleFor(net, column, strip));
      else warnings.push(`Net ${net}: tie group at column ${column} is full; rail jumper dropped.`);
      return;
    }

    const keys = netGroupKeys.get(net) ?? [];
    keys.push(key);
    netGroupKeys.set(net, keys);
    if (keys.length === 1) {
      netHome.set(net, key);
      return;
    }
    let targetKey = netHome.get(net);
    if (!groupHasSpace(targetKey)) {
      targetKey = keys.find((other) => other !== key && groupHasSpace(other)) ?? null;
    }
    const hole = takeHole(strip, column);
    const targetHole = targetKey ? takeHoleByKey(targetKey) : null;
    if (hole && targetHole) pushJumper(net, hole, targetHole);
    else warnings.push(`Net ${net}: no free holes left to join all of its tie groups.`);
    // Keep the home pointing at a group that can still accept taps.
    if (!groupHasSpace(netHome.get(net)) && groupHasSpace(key)) netHome.set(net, key);
  };

  // --- column allocation (top strip first, then bottom, then grow the board) ---
  // Columns pinned by Phase-1 (overridden) parts; the greedy Phase-2 allocator
  // steps over them. Empty when nothing is pinned, so allocation is identical
  // to the original single-pass placement.
  const reserved = new Set(); // "strip:column"
  const placedRefs = new Set();
  const spanFree = (strip, column, need) => {
    for (let offset = 0; offset < need; offset += 1) {
      if (reserved.has(`${strip}:${column + offset}`)) return false;
    }
    return true;
  };
  const reserveSpan = (strip, column, need) => {
    for (let offset = 0; offset < need; offset += 1) reserved.add(`${strip}:${column + offset}`);
  };

  const cursors = { top: 2, bottom: 2 };
  let warnedAboutGrowth = false;
  const growBoard = () => {
    columns += 10;
    if (columns > FULL_SIZE_COLUMNS && !warnedAboutGrowth) {
      warnedAboutGrowth = true;
      warnings.push(`Board grown past full size (${FULL_SIZE_COLUMNS} columns) to fit every part.`);
    }
  };
  // First free `need`-wide run at or past a strip's cursor that clears any
  // reserved columns, or null if none fits before the board edge.
  const freeRun = (strip, need) => {
    for (let column = cursors[strip]; column + need - 1 <= columns; column += 1) {
      if (spanFree(strip, column, need)) return column;
    }
    return null;
  };
  const allocSpan = (need) => {
    for (;;) {
      const top = freeRun('top', need);
      if (top != null) { cursors.top = top + need + PART_GAP; return { strip: 'top', column: top }; }
      const bottom = freeRun('bottom', need);
      if (bottom != null) { cursors.bottom = bottom + need + PART_GAP; return { strip: 'bottom', column: bottom }; }
      growBoard();
    }
  };
  // peekStrip only needs to know which strip allocSpan would land a part on, so
  // two-lead placement can reason about home groups on the same strip.
  const peekStrip = (need) => (freeRun('top', need) != null ? 'top' : freeRun('bottom', need) != null ? 'bottom' : (growBoard(), peekStrip(need)));
  const allocDipSpan = (need) => {
    for (;;) {
      for (let column = Math.max(cursors.top, cursors.bottom); column + need - 1 <= columns; column += 1) {
        if (spanFree('top', column, need) && spanFree('bottom', column, need)) {
          cursors.top = column + need + PART_GAP;
          cursors.bottom = column + need + PART_GAP;
          return column;
        }
      }
      growBoard();
    }
  };

  // --- per-part placement ---
  const finalizePart = (component, strip, columnsByPin, body, meta = {}) => {
    const holes = [];
    (component.nodes ?? []).forEach((net, index) => {
      const column = columnsByPin[index];
      holes.push(takeHole(strip, column));
      if (body === 'twoLead') sharableGroups.add(groupKey(strip, column));
      if (isUnconnectedTerminal(net, component.ref, index + 1)) return;
      ensureConnected(net, strip, column);
    });
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body,
      strip,
      holes,
      pinNets: [...(component.nodes ?? [])],
      meta,
    });
  };

  // Reusable home group for a net: same strip, still has free holes, not a
  // rail, and not buried under a multi-pin package footprint.
  const usableHome = (net, strip) => {
    if (net == null || isRailNet(net)) return null;
    const key = netHome.get(net);
    if (!key || !key.startsWith(`${strip}:`) || !groupHasSpace(key) || !sharableGroups.has(key)) return null;
    return { column: Number(key.split(':')[1]) };
  };

  const placeTwoLead = (component) => {
    const nets = component.nodes ?? [];
    const strip = peekStrip(LEAD_SPAN + 1);
    const homes = nets.map((net, index) =>
      isUnconnectedTerminal(net, component.ref, index + 1) ? null : usableHome(net, strip));
    // Both nets already live on this strip: plug straight in, no jumpers needed.
    if (homes[0] && homes[1]) {
      const span = Math.abs(homes[0].column - homes[1].column);
      if (span >= 2 && span <= MAX_DIRECT_SPAN) {
        return finalizePart(component, strip, [homes[0].column, homes[1].column], 'twoLead');
      }
    }
    // One nearby net: anchor that leg on its home group (natural series chains).
    const anchorIndex = homes.findIndex((home) => home && cursors[strip] - home.column <= MAX_REACH);
    if (anchorIndex !== -1) {
      const anchor = homes[anchorIndex].column;
      const fresh = Math.max(cursors[strip], anchor + 2);
      cursors[strip] = fresh + 1 + PART_GAP;
      const columnsByPin = anchorIndex === 0 ? [anchor, fresh] : [fresh, anchor];
      return finalizePart(component, strip, columnsByPin, 'twoLead');
    }
    const spot = allocSpan(LEAD_SPAN + 1);
    finalizePart(component, spot.strip, [spot.column, spot.column + LEAD_SPAN], 'twoLead');
  };

  const placeInline = (component, body) => {
    const pinCount = component.nodes?.length ?? 0;
    const spot = allocSpan(Math.max(pinCount, 1));
    const columnsByPin = (component.nodes ?? []).map((_, index) => spot.column + index);
    finalizePart(component, spot.strip, columnsByPin, body);
  };

  // Trench-straddling packages (DIP-8 opamps, the ESP32 DevKit module): legs
  // on rows e/f across a reserved column span, per the package's leg layout.
  // columnStart pins the left column (Phase-1 override); null auto-allocates.
  const placeStraddle = (component, widthColumns, legLayout, body, columnStart = null) => {
    const column = columnStart == null ? allocDipSpan(widthColumns) : columnStart;
    const nets = component.nodes ?? [];
    const holes = new Array(nets.length).fill(null);
    for (const [strip, legs] of Object.entries(legLayout)) {
      legs.forEach((pinIndex, offset) => {
        if (pinIndex == null || pinIndex >= nets.length) return;
        const pinColumn = column + offset;
        holes[pinIndex] = takeHole(strip, pinColumn, strip === 'bottom' ? 0 : STRIP_ROWS.top - 1);
        if (isUnconnectedTerminal(nets[pinIndex], component.ref, pinIndex + 1)) return;
        ensureConnected(nets[pinIndex], strip, pinColumn);
      });
    }
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body,
      strip: 'top',
      holes,
      pinNets: [...nets],
      meta: { columnStart: column, columnEnd: column + widthColumns - 1 },
    });
  };

  // Off-board MCU boards (Arduino Uno, Raspberry Pi) sit in slots below the
  // board. Pins are processed in positional (= header left-to-right) order and
  // each connected pin claims the next free bottom-strip column, so the wires
  // leave the header left-to-right and land left-to-right without crossing.
  let mcuSlotCount = 0;
  const placeOffboardMcu = (component) => {
    const slotIndex = mcuSlotCount;
    mcuSlotCount += 1;
    const nets = component.nodes ?? [];
    let column = cursors.bottom;
    const nextColumn = () => {
      while (column > columns) growBoard();
      column += 1;
      return column - 1;
    };
    const holes = nets.map((net, index) => {
      if (isUnconnectedTerminal(net, component.ref, index + 1)) return null;
      if (isRailNet(net)) {
        // Power pins wire straight into the nearest rail hole.
        mirrorRailToBottom(net);
        return railHoleFor(net, nextColumn(), 'bottom');
      }
      const home = usableHome(net, 'bottom');
      if (home) return takeHole('bottom', home.column);
      const freshColumn = nextColumn();
      const hole = takeHole('bottom', freshColumn);
      // The attachment group carries no body, so later two-lead parts may
      // chain straight into it.
      sharableGroups.add(groupKey('bottom', freshColumn));
      ensureConnected(net, 'bottom', freshColumn);
      return hole;
    });
    cursors.bottom = Math.max(cursors.bottom, column + PART_GAP);
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body: component.kind,
      strip: 'bottom',
      holes,
      pinNets: [...nets],
      meta: {
        slotIndex,
        pinColors: nets.map((net, index) =>
          isUnconnectedTerminal(net, component.ref, index + 1) ? null : wireColor(net)),
      },
    });
  };

  // Place an overridden part at its pinned leftmost column/strip, reserving the
  // columns it occupies so the greedy Phase-2 pass steps over it. Returns false
  // (leaving it for Phase 2) for packages that have no meaningful free column
  // anchor — off-board MCU boards live in fixed slots, not on the strips.
  const placeAnchored = (component, anchor) => {
    const pinCount = component.nodes?.length ?? 0;
    const strip = anchor?.strip === 'bottom' ? 'bottom' : 'top';
    let column = Math.max(2, Math.round(Number(anchor?.column)));
    if (!Number.isFinite(column)) return false;
    const fit = (need, strips) => {
      while (column + need - 1 > columns) growBoard();
      strips.forEach((s) => reserveSpan(s, column, need));
    };
    if (component.kind === 'opamp' && pinCount === 5) {
      fit(DIP_WIDTH_COLUMNS, ['top', 'bottom']);
      placeStraddle(component, DIP_WIDTH_COLUMNS, OPAMP_LEG_LAYOUT, 'dip', column);
    } else if (component.kind === 'esp32') {
      fit(ESP32_WIDTH_COLUMNS, ['top', 'bottom']);
      placeStraddle(component, ESP32_WIDTH_COLUMNS, ESP32_LEG_LAYOUT, 'esp32', column);
    } else if (OFFBOARD_MCU_KINDS.has(component.kind)) {
      return false;
    } else if (pinCount === 2) {
      fit(LEAD_SPAN + 1, [strip]);
      finalizePart(component, strip, [column, column + LEAD_SPAN], 'twoLead');
    } else {
      const need = Math.max(pinCount, 1);
      const body = TO92_KINDS.has(component.kind) ? 'to92' : component.kind === 'regulator' ? 'to220' : 'module';
      fit(need, [strip]);
      finalizePart(component, strip, (component.nodes ?? []).map((_, index) => column + index), body);
    }
    placedRefs.add(component.ref);
    return true;
  };

  // Phase 1: honor persisted placements. Phase 2: greedy-place everything else
  // (added parts, packages that can't be pinned) around the reserved columns.
  components.forEach((component) => {
    if (component.kind === 'voltage_source') return;
    const anchor = overrideParts[component.ref];
    if (anchor) placeAnchored(component, anchor);
  });
  components.forEach((component) => {
    if (component.kind === 'voltage_source') return; // handled in the rail pre-pass
    if (placedRefs.has(component.ref)) return; // pinned in Phase 1
    const pinCount = component.nodes?.length ?? 0;
    if (component.kind === 'opamp' && pinCount === 5) {
      return placeStraddle(component, DIP_WIDTH_COLUMNS, OPAMP_LEG_LAYOUT, 'dip');
    }
    if (component.kind === 'esp32') {
      return placeStraddle(component, ESP32_WIDTH_COLUMNS, ESP32_LEG_LAYOUT, 'esp32');
    }
    if (OFFBOARD_MCU_KINDS.has(component.kind)) return placeOffboardMcu(component);
    if (TO92_KINDS.has(component.kind)) return placeInline(component, 'to92');
    if (component.kind === 'regulator') return placeInline(component, 'to220');
    if (pinCount === 2) return placeTwoLead(component);
    placeInline(component, 'module');
  });

  // Slot rectangles use the final column count, so they are stamped only after
  // every part has placed (placement can still grow the board).
  parts.forEach((part) => {
    if (part.meta?.slotIndex == null) return;
    part.meta = { ...part.meta, slot: mcuSlotRect(part.meta.slotIndex, columns) };
  });

  // Tie groups per net, for highlight overlays.
  const netGroups = {};
  groups.forEach((group) => {
    if (group.net == null) return;
    (netGroups[group.net] ??= []).push({ strip: group.strip, column: group.column });
  });

  // Every real net with its wire color and role, first-seen order (rails first).
  const nets = [];
  const listed = new Set();
  const listNet = (net, role) => {
    if (net == null || listed.has(net)) return;
    listed.add(net);
    nets.push({ net, role, color: wireColor(net) });
  };
  listNet(rails.railTopPlus, 'supply');
  listNet(rails.railTopMinus, rails.railTopMinus === GROUND_NET ? 'ground' : 'supply');
  listNet(rails.railBottomPlus, 'supply');
  listNet(rails.railBottomMinus, rails.railBottomMinus === GROUND_NET ? 'ground' : 'supply');
  netGroupKeys.forEach((_, net) => listNet(net, 'signal'));

  const size = boardSize(columns, mcuSlotCount);
  return {
    board: { columns, width: size.width, height: size.height },
    rails,
    parts,
    batteries,
    jumpers,
    netGroups,
    nets,
    warnings,
  };
}

// Drop persisted placement anchors whose part no longer exists in the circuit
// (parts removed by a later AI revision or netlist edit) so stored layout stays
// clean. Added parts simply have no anchor and fall to greedy placement.
// Returns the same object when nothing changed, so callers can skip writes.
export function reconcileOverrides(overrides, circuit) {
  const parts = overrides?.parts;
  if (!parts) return overrides ?? null;
  const liveRefs = new Set((circuit?.components ?? []).map((component) => component.ref));
  const kept = {};
  let dropped = false;
  for (const [ref, anchor] of Object.entries(parts)) {
    if (liveRefs.has(ref)) kept[ref] = anchor;
    else dropped = true;
  }
  if (!dropped) return overrides;
  return { ...overrides, version: overrides.version ?? 1, parts: kept };
}

// The net currently carried by the tie group at `hole`, or null if that group
// is empty (an unused hole). Rail rows read straight off `model.rails`; terminal
// columns invert `model.netGroups` ("strip:column" -> net). Used by the editor
// to resolve what a dragged pin lands on. `hole` is a {strip,column,row}
// address as produced by holeAt.
export function netAtHole(model, hole) {
  if (!model || !hole) return null;
  if (isRailStrip(hole.strip)) return model.rails?.[hole.strip] ?? null;
  const key = tieGroupKey(hole);
  for (const [net, cells] of Object.entries(model.netGroups ?? {})) {
    if (cells.some((cell) => `${cell.strip}:${cell.column}` === key)) return net;
  }
  return null;
}
