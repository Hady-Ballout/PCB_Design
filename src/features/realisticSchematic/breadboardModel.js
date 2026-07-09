// Pure transform from the canonical `circuit` object into a breadboard
// placement model for the realistic-schematic view. No React imports so it
// stays unit-testable. Placement is a greedy, deterministic single pass over
// `circuit.components` in array order.

import { DEFAULT_COLUMNS, FULL_SIZE_COLUMNS, STRIP_ROWS, boardSize, mcuSlotRect } from './breadboardGeometry.js';

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

export const GROUND_NET = '0';
const SUPPLY_NAME_PATTERN = /^(vcc|vdd|v\+|vin|vs|vsupply)$/i;

const TO92_KINDS = new Set(['bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p']);

// Fixed, positional pin contracts for microcontroller boards — same order the
// AI is instructed to use in server/ai/ollamaProvider.ts. Duplicated here (per
// this feature's own convention of per-file pin-name tables) rather than
// imported, since this chunk stays self-contained and unit-testable.
export const MCU_PINS = {
  arduino_uno: ['5V', '3V3', 'GND', 'VIN', 'D2', 'D3', 'D5', 'D9', 'D13', 'A0', 'A1', 'A2'],
  raspberry_pi: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22'],
  esp32: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
};

// Uno/Pi are drawn off-board in a fixed slot below the breadboard, with their
// header pins fanned out to breadboard holes via colored wires. ESP32 is a
// DIP-style module that straddles the trench like the opamp DIP-8 package.
const OFFBOARD_MCU_KINDS = new Set(['arduino_uno', 'raspberry_pi']);
const ESP32_WIDTH_COLUMNS = 6;

const GROUND_WIRE_COLOR = '#1f1f1f';
const SUPPLY_WIRE_COLOR = '#c0392b';
const SIGNAL_WIRE_COLORS = ['#e6b422', '#3a9e4c', '#e07020', '#4a7fe0', '#9a5fd0', '#7d7d7d'];

// Virtual DIP-8 pinout for the canonical 5-pin opamp [IN+, IN-, OUT, V+, V-]
// (741-style). DIP pins 1-4 sit on the bottom strip left->right at row f;
// pins 5-8 on the top strip right->left at row e, straddling the trench.
const OPAMP_DIP_PINS = [3, 2, 6, 7, 4];
const DIP_WIDTH_COLUMNS = 4;

const LEAD_SPAN = 2; // default columns between a two-lead part's legs
const MAX_DIRECT_SPAN = 8; // widest a part stretches to plug straight into home groups
const MAX_REACH = 6; // how far back a leg reaches to reuse a home group
const PART_GAP = 1; // free columns kept between parts

export function circuitToBreadboard(circuit) {
  const components = circuit?.components ?? [];
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

  // A microcontroller's 5V/3V3 pin can power the whole circuit even with no
  // explicit voltage_source in the circuit — give it a rail too.
  components.forEach((component) => {
    const pins = MCU_PINS[component.kind];
    if (!pins) return;
    (component.nodes ?? []).forEach((net, index) => {
      if (isUnconnectedTerminal(net, component.ref, index + 1)) return;
      const pinName = pins[index];
      if (pinName !== '5V' && pinName !== '3V3') return;
      if (isRailNet(net)) return;
      if (rails.railTopPlus == null) assignRail('railTopPlus', net);
      else if (rails.railBottomPlus == null) assignRail('railBottomPlus', net);
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
  const ensureConnected = (net, strip, column) => {
    const key = groupKey(strip, column);
    const group = groupAt(strip, column);
    if (group.net === net && group.linked) return;
    group.net = net;
    group.linked = true;

    if (isRailNet(net)) {
      // Bottom-strip parts get power from mirrored bottom rails instead of
      // arcing across the whole board to the top ones.
      if (strip === 'bottom' && railStripsFor(net).every((railKey) => railKey.startsWith('railTop'))) {
        const mirrorKey = rails.railTopPlus === net ? 'railBottomPlus' : 'railBottomMinus';
        if (rails[mirrorKey] == null) assignRail(mirrorKey, net);
      }
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
  const cursors = { top: 2, bottom: 2 };
  let warnedAboutGrowth = false;
  const growBoard = () => {
    columns += 10;
    if (columns > FULL_SIZE_COLUMNS && !warnedAboutGrowth) {
      warnedAboutGrowth = true;
      warnings.push(`Board grown past full size (${FULL_SIZE_COLUMNS} columns) to fit every part.`);
    }
  };
  const peekStrip = (need) => {
    for (;;) {
      if (cursors.top + need - 1 <= columns) return 'top';
      if (cursors.bottom + need - 1 <= columns) return 'bottom';
      growBoard();
    }
  };
  const allocSpan = (need) => {
    const strip = peekStrip(need);
    const column = cursors[strip];
    cursors[strip] = column + need + PART_GAP;
    return { strip, column };
  };
  const allocDipSpan = (need) => {
    for (;;) {
      const column = Math.max(cursors.top, cursors.bottom);
      if (column + need - 1 <= columns) {
        cursors.top = column + need + PART_GAP;
        cursors.bottom = column + need + PART_GAP;
        return column;
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

  // Same as usableHome, but strip-agnostic — used for MCU header pins, which
  // can fly a wire to either strip rather than only the one they're placed on.
  const anyUsableHome = (net) => {
    if (net == null || isRailNet(net)) return null;
    const key = netHome.get(net);
    if (!key || !groupHasSpace(key) || !sharableGroups.has(key)) return null;
    const [strip, columnText] = key.split(':');
    return { strip, column: Number(columnText) };
  };

  // Claim the next free single-row hole on a rail strip (rails have one row
  // per column, so this just walks columns until one is unused).
  const takeFreeRailHole = (railKey) => {
    for (let column = 1; ; column += 1) {
      if (column > columns) growBoard();
      const hole = takeHole(railKey, column);
      if (hole) return hole;
    }
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

  const placeDip = (component) => {
    const column = allocDipSpan(DIP_WIDTH_COLUMNS);
    const holes = [];
    (component.nodes ?? []).forEach((net, index) => {
      const dipPin = OPAMP_DIP_PINS[index];
      const onBottom = dipPin <= 4;
      const strip = onBottom ? 'bottom' : 'top';
      const pinColumn = onBottom ? column + (dipPin - 1) : column + (8 - dipPin);
      holes.push(takeHole(strip, pinColumn, onBottom ? 0 : STRIP_ROWS.top - 1));
      if (isUnconnectedTerminal(net, component.ref, index + 1)) return;
      ensureConnected(net, strip, pinColumn);
    });
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body: 'dip',
      strip: 'top',
      holes,
      pinNets: [...(component.nodes ?? [])],
      meta: { columnStart: column, columnEnd: column + DIP_WIDTH_COLUMNS - 1 },
    });
  };

  // ESP32 is a wide DIP-style module straddling the trench: the first half of
  // its pins land on the bottom strip, the second half directly across on top.
  const placeEsp32 = (component) => {
    const column = allocDipSpan(ESP32_WIDTH_COLUMNS);
    const nets = component.nodes ?? [];
    const holes = new Array(nets.length).fill(null);
    for (let offset = 0; offset < ESP32_WIDTH_COLUMNS; offset += 1) {
      const bottomIndex = offset;
      const topIndex = ESP32_WIDTH_COLUMNS + offset;
      const pinColumn = column + offset;
      if (bottomIndex < nets.length) {
        holes[bottomIndex] = takeHole('bottom', pinColumn, 0);
        if (!isUnconnectedTerminal(nets[bottomIndex], component.ref, bottomIndex + 1)) {
          ensureConnected(nets[bottomIndex], 'bottom', pinColumn);
        }
      }
      if (topIndex < nets.length) {
        holes[topIndex] = takeHole('top', pinColumn, STRIP_ROWS.top - 1);
        if (!isUnconnectedTerminal(nets[topIndex], component.ref, topIndex + 1)) {
          ensureConnected(nets[topIndex], 'top', pinColumn);
        }
      }
    }
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body: 'esp32',
      strip: 'top',
      holes,
      pinNets: [...nets],
      meta: { columnStart: column, columnEnd: column + ESP32_WIDTH_COLUMNS - 1 },
    });
  };

  // Uno/Pi live off-board in a fixed slot; header pins fan out to breadboard
  // holes via colored wires (power to the rail, signals to a shared tie group
  // when one already exists for that net, else a fresh column).
  let mcuSlotCount = 0;
  const placeOffboardMcu = (component) => {
    const nets = component.nodes ?? [];
    const slotIndex = mcuSlotCount;
    mcuSlotCount += 1;
    const holes = [];
    const pinColors = [];
    nets.forEach((net, index) => {
      const pinNumber = index + 1;
      if (isUnconnectedTerminal(net, component.ref, pinNumber)) {
        holes.push(null);
        pinColors.push(null);
        return;
      }
      if (isRailNet(net)) {
        const railKey = railStripsFor(net)[0];
        holes.push(takeFreeRailHole(railKey));
        pinColors.push(wireColor(net));
        return;
      }
      const home = anyUsableHome(net);
      if (home) {
        holes.push(takeHole(home.strip, home.column));
        pinColors.push(wireColor(net));
        return;
      }
      const spot = allocSpan(1);
      holes.push(takeHole(spot.strip, spot.column));
      pinColors.push(wireColor(net));
      ensureConnected(net, spot.strip, spot.column);
    });
    parts.push({
      ref: component.ref,
      kind: component.kind,
      value: component.value,
      body: component.kind,
      strip: 'top',
      holes,
      pinNets: [...nets],
      meta: { slotIndex, pinColors },
    });
  };

  const deferredMcus = [];
  components.forEach((component) => {
    if (component.kind === 'voltage_source') return; // handled in the rail pre-pass
    if (OFFBOARD_MCU_KINDS.has(component.kind)) { deferredMcus.push(component); return; }
    if (component.kind === 'esp32') return placeEsp32(component);
    const pinCount = component.nodes?.length ?? 0;
    if (component.kind === 'opamp' && pinCount === 5) return placeDip(component);
    if (TO92_KINDS.has(component.kind)) return placeInline(component, 'to92');
    if (component.kind === 'regulator') return placeInline(component, 'to220');
    if (pinCount === 2) return placeTwoLead(component);
    placeInline(component, 'module');
  });
  // Off-board MCUs place last so their signal pins can reuse tie groups every
  // other component has already created for the same net.
  deferredMcus.forEach(placeOffboardMcu);

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

  // Resolve each MCU's pixel slot only now that the final column count (and
  // therefore board width) is known.
  parts.forEach((part) => {
    if (part.meta?.slotIndex != null) part.meta.slot = mcuSlotRect(part.meta.slotIndex, columns);
  });

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
