// Pure transform from the canonical `circuit` object into a breadboard
// placement model for the realistic-schematic view. No React imports so it
// stays unit-testable. Placement is a greedy, deterministic single pass over
// `circuit.components` in array order.

import { FIXED_PIN_NAMES } from '../../core/componentKinds.js';
import { DEFAULT_COLUMNS, FULL_SIZE_COLUMNS, MCU_SLOT_GAP, MCU_SLOT_HEIGHT, PERIPHERAL_SLOT_HEIGHT, STRIP_ROWS, boardSize, isRailStrip, slotRect, tieGroupKey } from './breadboardGeometry.js';
import { checkPhysicalModel } from './physicalChecks.js';

// A pin is unconnected when its net is a placeholder (NC_… or `${ref}_${pin}`).
// Duplicated here to keep this chunk from importing another feature chunk — the
// same trivial predicate is likewise duplicated across the core engine files.
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

export const GROUND_NET = '0';
const SUPPLY_NAME_PATTERN = /^(vcc|vdd|v\+|vin|vs|vsupply)$/i;

const GROUND_WIRE_COLOR = '#1f1f1f';
const SUPPLY_WIRE_COLOR = '#c0392b';
const SIGNAL_WIRE_COLORS = ['#e6b422', '#3a9e4c', '#e07020', '#4a7fe0', '#9a5fd0', '#7d7d7d'];

// Trench-straddling packages are described by a leg layout: for each strip,
// the canonical pin index carried by the leg at each column offset (null legs
// exist physically but carry no canonical pin). The DIP-8 layout with the
// REAL LM358/LM393 pinout for the canonical 5-pin [IN+, IN-, OUT, V+, V-]
// contract, using section A: DIP pins 1-4 (OUT1, IN1-, IN1+, GND) left-to-
// right on the bottom strip, pin 8 (V+) at top offset 0. Pins 5-7 are the
// unused second section (see the spare-section warning in placeStraddle).
const DIP_WIDTH_COLUMNS = 4;
const OPAMP_LEG_LAYOUT = { bottom: [2, 1, 0, 4], top: [3, null, null, null] };

// Identity DIP-8 layout for kinds whose canonical pin order is exactly the
// physical DIP pins 1-8 (555: [GND, TRIG, OUT, RESET, CTRL, THRES, DISCH,
// VCC]; uA741: [OFS1, IN-, IN+, V-, OFS2, OUT, V+, NC]): pins 1-4
// left-to-right on the bottom strip, pins 8-5 left-to-right on the top strip.
const DIP8_IDENTITY_LEG_LAYOUT = { bottom: [0, 1, 2, 3], top: [7, 6, 5, 4] };

// Canonical positional pin lists for the microcontroller boards. Order is the
// contract a circuit generator must follow and what the
// selection pin labels display; unused pins ride on NC_* placeholder nets.
export const MCU_PINS = {
  arduino_uno: ['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
  raspberry_pi: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22', 'GPIO8', 'GPIO9', 'GPIO10', 'GPIO11'],
  esp32: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
  // The bare S3 module's canonical order IS the engine's fixedPins contract
  // (datasheet pins 1-41), so reference it rather than duplicating 41 names.
  esp32_s3_wroom: FIXED_PIN_NAMES.esp32_s3_wroom,
};

// Parts that cannot plug into a breadboard — MCU boards (Arduino Uno,
// Raspberry Pi) and wired peripherals (servo, DC motor, relay breakout) —
// sit in off-board slots below it with jumper wires up to the bottom
// strip/rails. The map value is each part's slot height; MCU boards get the
// tall slot, peripherals a compact one. Header-pinned ESP32 boards (`esp32`
// DevKitC and the esp32_s3_wroom carrier) are absent: they straddle the
// trench like the real boards do (see ESP32_DEVKIT_LEGS / ESP32_S3_LEGS).
const OFFBOARD_SLOT_HEIGHTS = {
  arduino_uno: MCU_SLOT_HEIGHT,
  raspberry_pi: MCU_SLOT_HEIGHT,
  servo: PERIPHERAL_SLOT_HEIGHT,
  dc_motor: PERIPHERAL_SLOT_HEIGHT,
  relay_module: PERIPHERAL_SLOT_HEIGHT,
  lcd_display: PERIPHERAL_SLOT_HEIGHT,
  motor_driver: PERIPHERAL_SLOT_HEIGHT,
  stepper_motor: PERIPHERAL_SLOT_HEIGHT,
  stepper_driver: PERIPHERAL_SLOT_HEIGHT,
  led_strip: PERIPHERAL_SLOT_HEIGHT,
  keypad: PERIPHERAL_SLOT_HEIGHT,
  joystick: PERIPHERAL_SLOT_HEIGHT,
  rfid_reader: PERIPHERAL_SLOT_HEIGHT,
  mouse_sensor: PERIPHERAL_SLOT_HEIGHT,
  current_sensor: PERIPHERAL_SLOT_HEIGHT,
};
const OFFBOARD_MCU_KINDS = new Set(['arduino_uno', 'raspberry_pi']);

// ESP32-S3-WROOM-1 on a DevKitC-style carrier, plugged into the breadboard
// across the trench like an oversized DIP: 21 columns, canonical (datasheet
// CCW) pins 1-21 left-to-right along the bottom row (the module's left-side
// pads then the first bottom-edge pads), continuing up the right side and
// back right-to-left along the top row (pins 22-40), with the thermal EPAD
// (pin 41) broken out at the top-left header position. The top row's
// rightmost column carries no pin — that end of the carrier is the USB end.
export const ESP32_S3_LEGS = {
  bottom: Array.from({ length: 21 }, (_, offset) => offset),
  top: [40, ...Array.from({ length: 19 }, (_, offset) => 39 - offset), null],
};

// Classic ESP32 DevKitC plugged in across the trench like the real 15x2-pin
// board (module/antenna end left, USB end right). The 12-pin `esp32`
// abstraction maps its canonical pins [3V3, GND, VIN, EN, GPIO2, GPIO4,
// GPIO5, GPIO13, GPIO18, GPIO19, GPIO21, GPIO22] onto DevKitC-like
// positions — 3V3/EN at the module end, GND/VIN at the USB end, the GPIOs
// walking in from the USB end of the top row. The null columns are the real
// board's unmodelled pins: drawn, column-reserving, electrically inert.
export const ESP32_DEVKIT_LEGS = {
  bottom: [0, 3, null, null, null, null, null, null, null, null, null, null, null, 1, 2],
  top: [null, null, null, null, null, null, null, 11, 10, 9, 8, 7, 6, 5, 4],
};

// Kind-keyed placement tables shared by the greedy pass and placeAnchored so
// the two dispatch sites can never drift apart. `requirePins` guards kinds
// whose leg layout only makes sense for the canonical pin count (opamp and
// comparator share the virtual 5-pin [IN+, IN-, OUT, V+, V-] contract on a
// DIP-8; the comparator just wears LM393 silk).
const STRADDLE_PACKAGES = {
  opamp: { width: DIP_WIDTH_COLUMNS, legs: OPAMP_LEG_LAYOUT, body: 'dip', requirePins: 5 },
  comparator: { width: DIP_WIDTH_COLUMNS, legs: OPAMP_LEG_LAYOUT, body: 'dip', requirePins: 5 },
  timer_555: { width: DIP_WIDTH_COLUMNS, legs: DIP8_IDENTITY_LEG_LAYOUT, body: 'dip', requirePins: 8 },
  // Single uA741 in DIP-8: canonical order = physical order, identity legs.
  ua741: { width: DIP_WIDTH_COLUMNS, legs: DIP8_IDENTITY_LEG_LAYOUT, body: 'dip', requirePins: 8 },
  // Tactile pushbutton: both electrical pins land on the bottom strip (row f)
  // like a real 4-leg tact switch bridging the trench; the top-strip legs are
  // purely mechanical, so they reserve their columns but claim no holes.
  pushbutton: { width: 2, legs: { bottom: [0, 1], top: [null, null] }, body: 'pushbutton', requirePins: 2 },
  // 5161AS-style DIP-10, canonical pins [A,B,C,D,E,F,G,DP,COM]: physical pins
  // 1-5 left-to-right on the bottom row are E,D,COM,C,DP and pins 10-6
  // left-to-right on the top row are G,F,COM,A,B — the second COM leg is
  // internally tied to the first and stays decorative (null).
  seven_segment: { width: 5, legs: { bottom: [4, 3, 8, 2, 7], top: [6, 5, null, 0, 1] }, body: 'seven_segment', requirePins: 9 },
  // 74HC595 DIP-16: canonical pin order is the physical DIP order, so the leg
  // layout is the identity mapping — pins 1-8 left-to-right on the bottom row,
  // pins 16-9 left-to-right on the top row.
  shift_register: {
    width: 8,
    legs: { bottom: [0, 1, 2, 3, 4, 5, 6, 7], top: [15, 14, 13, 12, 11, 10, 9, 8] },
    body: 'dip',
    requirePins: 16,
  },
  // PC817 DIP-4: canonical order = physical DIP pins 1-4 (A, K on the bottom
  // row; C, E on the top row reading left-to-right), identity layout.
  optocoupler: {
    width: 2,
    legs: { bottom: [0, 1], top: [3, 2] },
    body: 'dip',
    requirePins: 4,
  },
  // MCP3008 DIP-16, same identity pattern as the 74HC595.
  adc_module: {
    width: 8,
    legs: { bottom: [0, 1, 2, 3, 4, 5, 6, 7], top: [15, 14, 13, 12, 11, 10, 9, 8] },
    body: 'dip',
    requirePins: 16,
  },
  // ESP32-S3-WROOM-1 on its DevKitC-style carrier, straddling the trench with
  // the module's full 41-pin contract split across the two header rows.
  esp32_s3_wroom: { width: 21, legs: ESP32_S3_LEGS, body: 'esp32_s3_wroom', requirePins: 41 },
  // Classic ESP32 DevKitC, same straddle treatment at the real board's
  // 15-column length. A wrong pin count falls back to a generic module with
  // an integrity error, like the S3.
  esp32: { width: 15, legs: ESP32_DEVKIT_LEGS, body: 'esp32', requirePins: 12 },
};

const straddleFor = (component) => {
  const spec = STRADDLE_PACKAGES[component.kind];
  if (!spec) return null;
  if (spec.requirePins != null && (component.nodes?.length ?? 0) !== spec.requirePins) return null;
  return spec;
};

// A straddle kind that failed requirePins falls back to a generic body whose
// positional pin->hole mapping no longer matches the real package — an
// integrity problem, not a cosmetic one.
const straddleFallbackIssue = (component) => {
  const spec = STRADDLE_PACKAGES[component.kind];
  if (!spec || straddleFor(component)) return null;
  return {
    severity: 'error',
    message: `${component.ref} (${component.kind}) lists ${component.nodes?.length ?? 0} nodes but the package needs ${spec.requirePins}; it is drawn as a generic part and its pin mapping is unreliable.`,
  };
};

// Inline package bodies keyed by kind (checked before the two-lead branch, so
// a 2-pin kind listed here keeps its package body). The TMP36-style
// temp_sensor shares the TO-92 can: VCC/OUT/GND left-to-right matches the
// flat-face pin order.
const INLINE_BODY_BY_KIND = {
  bjt_npn: 'to92',
  bjt_pnp: 'to92',
  mosfet_n: 'to92',
  mosfet_p: 'to92',
  temp_sensor: 'to92',
  ir_receiver: 'to92',
  hall_sensor: 'to92',
  regulator: 'to220',
  buck_converter: 'to220',
};

const LEAD_SPAN = 2; // default columns between a two-lead part's legs
const MAX_DIRECT_SPAN = 8; // widest a part stretches to plug straight into home groups
const MAX_REACH = 6; // how far back a leg reaches to reuse a home group
const PART_GAP = 1; // free columns kept between parts

// `overrides` is an optional persisted placement layer: { parts: { [ref]:
// { strip, column } } } pinning a part's leftmost column/strip (see the
// realistic-schematic editor). Absent/empty overrides must reproduce the pure
// auto-placement byte-for-byte — the two-phase pass below collapses to the
// original single greedy pass when nothing is pinned.
/**
 * Parts whose footprint places copper on the board surface instead of leads
 * through it. A breadboard seats leads in 2.54mm holes, so these cannot go on
 * one at all — an 0805 chip resistor is 2mm long and has no leads.
 */
const surfaceMountRefs = (components) => components
  .filter((component) => /_SMD:|:.*_(0402|0603|0805|1206)_|SOIC|SOT-23|QFN|QFP/i.test(String(component?.footprint || '')))
  .map((component) => component.ref);

export function circuitToBreadboard(circuit, overrides = {}) {
  const components = circuit?.components ?? [];
  const overrideParts = overrides?.parts ?? {};
  let columns = DEFAULT_COLUMNS;
  const warnings = [];
  // Electrical-integrity problems (a break or unreliable pin mapping on the
  // physical board), as {severity, message} — surfaced as errors in the UI,
  // unlike cosmetic `warnings`.
  const integrityIssues = [];
  const rails = { railTopPlus: null, railTopMinus: null, railBottomPlus: null, railBottomMinus: null };
  // Nets that are genuinely a power supply — battery/source positive terminals
  // and MCU 5V/3V3 output pins. Used with GROUND_NET and SUPPLY_NAME_PATTERN to
  // give railed nets a semantic role (below), so a busy SIGNAL net promoted to a
  // rail keeps role 'signal' and legitimately trips checkRailPolicy.
  const supplyNets = new Set();
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

  // Voltage sources live off-board as battery/solar packs feeding the rails.
  const sources = components.filter((component) => component.kind === 'voltage_source' || component.kind === 'solar_panel');
  sources.forEach((source, index) => {
    if (index >= 2) {
      integrityIssues.push({
        severity: 'error',
        message: `${source.ref}: only two supplies fit on the rails; this one is not drawn, so its connections are missing from the board.`,
      });
      return;
    }
    const [first, second] = source.nodes ?? [];
    const plusNet = first === GROUND_NET ? second : first;
    const minusNet = first === GROUND_NET ? first : second;
    const [plusKey, minusKey] = index === 0
      ? ['railTopPlus', 'railTopMinus']
      : ['railBottomPlus', 'railBottomMinus'];
    if (plusNet != null) supplyNets.add(plusNet);
    if (plusNet != null && !isRailNet(plusNet)) assignRail(plusKey, plusNet);
    if (minusNet != null && !isRailNet(minusNet)) assignRail(minusKey, minusNet);
    batteries.push({
      ref: source.ref,
      kind: source.kind,
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
      if (net === GROUND_NET) return;
      supplyNets.add(net);
      if (isRailNet(net)) return;
      const freeKey = ['railTopPlus', 'railBottomPlus'].find((key) => rails[key] == null);
      if (freeKey) assignRail(freeKey, net);
    });
  });

  // Rail promotion: a net tapped by five or more pins would exhaust its 5-hole
  // home tie group and start dropping connections, so give it a whole rail —
  // exactly what a human builder does with a busy net. A no-op for the common
  // small nets, keeping auto-placement byte-identical for existing circuits.
  const netTapCounts = new Map();
  components.forEach((component) => {
    (component.nodes ?? []).forEach((net, index) => {
      if (net == null || isUnconnectedTerminal(net, component.ref, index + 1)) return;
      netTapCounts.set(net, (netTapCounts.get(net) ?? 0) + 1);
    });
  });
  netTapCounts.forEach((count, net) => {
    if (count < 5 || isRailNet(net)) return;
    const freeKey = ['railTopPlus', 'railBottomPlus', 'railBottomMinus'].find((key) => rails[key] == null);
    if (freeKey) assignRail(freeKey, net);
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

  const groupFreeHoles = (key) => {
    const group = groups.get(key);
    return group ? group.rows.filter((used) => !used).length : STRIP_ROWS[key.split(':')[0]];
  };

  // Set by the column allocator below; ensureConnected uses it to open relay
  // groups, and it is defined before any part placement runs.
  let allocRelayColumn = null;

  // Open a fresh, empty tie group for `net`, bridged from `anchorKey` (which
  // must still have a free hole). Restores headroom on a nearly-saturated net
  // so connections are never silently dropped.
  const openRelayGroup = (net, anchorKey) => {
    const anchorHole = takeHoleByKey(anchorKey);
    if (!anchorHole || !allocRelayColumn) return null;
    const spot = allocRelayColumn();
    const relayKey = groupKey(spot.strip, spot.column);
    const relayGroup = groupAt(spot.strip, spot.column);
    relayGroup.net = net;
    relayGroup.linked = true;
    sharableGroups.add(relayKey);
    const relayHole = takeHole(spot.strip, spot.column);
    pushJumper(net, anchorHole, relayHole);
    const keys = netGroupKeys.get(net) ?? [];
    keys.push(relayKey);
    netGroupKeys.set(net, keys);
    netHome.set(net, relayKey);
    return relayKey;
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
      else {
        integrityIssues.push({
          severity: 'error',
          message: `Net ${net}: tie group at column ${column} is full, so its rail connection is missing on the board.`,
        });
      }
      return;
    }

    const keys = netGroupKeys.get(net) ?? [];
    keys.push(key);
    netGroupKeys.set(net, keys);
    if (keys.length === 1) {
      netHome.set(net, key);
      return;
    }
    // Prefer a target with at least two free holes (one for this jumper, one
    // spare for future chaining); when only a last-hole group remains, spend
    // that hole bridging to a fresh relay group first so the net never
    // saturates and connections are never dropped.
    let targetKey = [netHome.get(net), ...keys]
      .find((other) => other && other !== key && groupFreeHoles(other) >= 2)
      ?? keys.find((other) => other !== key && groupHasSpace(other))
      ?? null;
    if (targetKey && groupFreeHoles(targetKey) === 1) {
      targetKey = openRelayGroup(net, targetKey) ?? targetKey;
    }
    const hole = takeHole(strip, column);
    const targetHole = targetKey ? takeHoleByKey(targetKey) : null;
    if (hole && targetHole) pushJumper(net, hole, targetHole);
    else {
      integrityIssues.push({
        severity: 'error',
        message: `Net ${net}: no free holes left to join all of its tie groups — the board has a break in this net.`,
      });
    }
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
  allocRelayColumn = () => allocSpan(1);
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

  // Same, but on whichever strip the home lives — off-board MCU wires can fly
  // to either strip, so a pin should tap the net's existing group directly
  // instead of allocating a spare group plus a joining jumper.
  const anyUsableHome = (net) => {
    if (net == null || isRailNet(net)) return null;
    const key = netHome.get(net);
    if (!key || !groupHasSpace(key) || !sharableGroups.has(key)) return null;
    const [strip, columnText] = key.split(':');
    return { strip, column: Number(columnText) };
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

  // Trench-straddling packages (DIP-8 opamps, DIP-16 shift registers): legs
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
    if (component.kind === 'opamp' || component.kind === 'comparator') {
      warnings.push(`${component.ref} uses section A of a dual package — tie the spare section (jumper DIP pin 6 to pin 7, pin 5 to ground) so it cannot oscillate.`);
    }
  };

  // Off-board parts (MCU boards, servos, motors, relay breakouts) sit in slots
  // below the board. Pins are processed in positional (= header left-to-right)
  // order and each connected pin claims the next free bottom-strip column, so
  // the wires leave the header left-to-right and land left-to-right without
  // crossing.
  let offboardSlotCount = 0;
  const placeOffboard = (component) => {
    const slotIndex = offboardSlotCount;
    offboardSlotCount += 1;
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
      const home = anyUsableHome(net);
      if (home) return takeHole(home.strip, home.column);
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
    const fallbackIssue = straddleFallbackIssue(component);
    if (fallbackIssue) integrityIssues.push(fallbackIssue);
    const fit = (need, strips) => {
      while (column + need - 1 > columns) growBoard();
      strips.forEach((s) => reserveSpan(s, column, need));
    };
    const straddle = straddleFor(component);
    if (straddle) {
      fit(straddle.width, ['top', 'bottom']);
      placeStraddle(component, straddle.width, straddle.legs, straddle.body, column);
    } else if (OFFBOARD_SLOT_HEIGHTS[component.kind]) {
      return false;
    } else if (INLINE_BODY_BY_KIND[component.kind]) {
      const need = Math.max(pinCount, 1);
      fit(need, [strip]);
      finalizePart(component, strip, (component.nodes ?? []).map((_, index) => column + index), INLINE_BODY_BY_KIND[component.kind]);
    } else if (pinCount === 2) {
      fit(LEAD_SPAN + 1, [strip]);
      finalizePart(component, strip, [column, column + LEAD_SPAN], 'twoLead');
    } else {
      const need = Math.max(pinCount, 1);
      fit(need, [strip]);
      finalizePart(component, strip, (component.nodes ?? []).map((_, index) => column + index), 'module');
    }
    placedRefs.add(component.ref);
    return true;
  };

  // Phase 1: honor persisted placements. Phase 2: greedy-place everything else
  // (added parts, packages that can't be pinned) around the reserved columns.
  components.forEach((component) => {
    if (component.kind === 'voltage_source' || component.kind === 'solar_panel') return;
    const anchor = overrideParts[component.ref];
    if (anchor) placeAnchored(component, anchor);
  });
  // Off-board parts place after everything else: their jumper wires can fly to
  // any strip, so waiting lets each pin tap the tie group its net already
  // earned under a component lead instead of allocating a spare group.
  const deferredOffboard = [];
  components.forEach((component) => {
    if (component.kind === 'voltage_source' || component.kind === 'solar_panel') return; // handled in the rail pre-pass
    if (placedRefs.has(component.ref)) return; // pinned in Phase 1
    const pinCount = component.nodes?.length ?? 0;
    const straddle = straddleFor(component);
    const fallbackIssue = straddleFallbackIssue(component);
    if (fallbackIssue) integrityIssues.push(fallbackIssue);
    if (straddle) return placeStraddle(component, straddle.width, straddle.legs, straddle.body);
    if (OFFBOARD_SLOT_HEIGHTS[component.kind]) return deferredOffboard.push(component);
    if (INLINE_BODY_BY_KIND[component.kind]) return placeInline(component, INLINE_BODY_BY_KIND[component.kind]);
    if (pinCount === 2) return placeTwoLead(component);
    placeInline(component, 'module');
  });
  // MCU boards claim the first slots so adding a peripheral never reshuffles
  // an existing board's position (stable sort keeps circuit order per group).
  deferredOffboard
    .sort((a, b) => (OFFBOARD_MCU_KINDS.has(a.kind) ? 0 : 1) - (OFFBOARD_MCU_KINDS.has(b.kind) ? 0 : 1))
    .forEach(placeOffboard);

  // Slot rectangles use the final column count, so they are stamped only after
  // every part has placed (placement can still grow the board).
  const slotHeights = [];
  let slotOffsetY = 0;
  parts
    .filter((part) => part.meta?.slotIndex != null)
    .sort((a, b) => a.meta.slotIndex - b.meta.slotIndex)
    .forEach((part) => {
      const height = OFFBOARD_SLOT_HEIGHTS[part.kind] ?? MCU_SLOT_HEIGHT;
      part.meta = { ...part.meta, slot: slotRect(slotOffsetY, height, columns) };
      slotOffsetY += height + MCU_SLOT_GAP;
      slotHeights.push(height);
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
  // Derive a railed net's role semantically: ground, then any genuine supply
  // net (battery/source positive terminal or MCU supply pin, collected in
  // supplyNets, plus the conventional supply names), else 'signal'. A busy
  // signal net promoted to a rail by the >=5-tap pass therefore stays 'signal',
  // so checkRailPolicy legitimately flags it instead of being structurally inert.
  const roleForRail = (net) => {
    if (net === GROUND_NET) return 'ground';
    if (supplyNets.has(net) || SUPPLY_NAME_PATTERN.test(String(net))) return 'supply';
    return 'signal';
  };
  listNet(rails.railTopPlus, roleForRail(rails.railTopPlus));
  listNet(rails.railTopMinus, roleForRail(rails.railTopMinus));
  listNet(rails.railBottomPlus, roleForRail(rails.railBottomPlus));
  listNet(rails.railBottomMinus, roleForRail(rails.railBottomMinus));
  netGroupKeys.forEach((_, net) => listNet(net, 'signal'));

  const size = boardSize(columns, slotHeights);
  const model = {
    board: { columns, width: size.width, height: size.height },
    rails,
    parts,
    batteries,
    jumpers,
    netGroups,
    nets,
    warnings,
  };
  // Physical-realizability checks (occupancy, rigid geometry, lead spans, rail
  // policy, board seams) — surfaced as warnings alongside the growth notice
  // above, so every built model carries them without the debug report having
  // to run the check separately.
  // A breadboard cannot hold surface-mount parts. Say that once, plainly,
  // instead of emitting occupancy and rail warnings about an imaginary layout —
  // those describe where leads landed, and these parts have no leads.
  const smdRefs = surfaceMountRefs(components);
  if (smdRefs.length) {
    const listed = smdRefs.slice(0, 6).join(', ');
    const rest = smdRefs.length > 6 ? ` and ${smdRefs.length - 6} more` : '';
    model.warnings.push(
      `${smdRefs.length} surface-mount part${smdRefs.length === 1 ? '' : 's'} (${listed}${rest}) cannot be breadboarded — `
      + 'they solder flat to the board and have no leads for the holes. This view is approximate for them; '
      + 'the PCB, 3D and export views are unaffected.',
    );
  } else {
    model.warnings.push(...checkPhysicalModel(model));
  }
  // Runtime invariant: rebuild connectivity from the physical board and merge
  // any SPLIT/SHORT with the placement-time integrity problems, so an
  // electrically broken board is always visibly flagged, never silent.
  const verification = verifyBoardConnectivity(model);
  model.integrity = {
    ok: verification.ok && integrityIssues.length === 0,
    issues: [...integrityIssues, ...verification.issues],
  };
  return model;
}

// Reconstruct the board's electrical nodes (tie groups + rails unioned by
// jumpers) and diff them against the intended nets: a net landing on more
// than one node is a SPLIT (a break), a node carrying more than one net is a
// SHORT. This is the runtime guard the debug description also reports.
export function verifyBoardConnectivity(model) {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  const keyOf = (hole) =>
    hole.strip.startsWith('rail') ? `rail:${hole.strip}` : `${hole.strip}:${hole.column}`;
  (model.jumpers ?? []).forEach((jumper) => union(keyOf(jumper.from), keyOf(jumper.to)));

  const netToNodes = new Map();
  const nodeToNets = new Map();
  (model.parts ?? []).forEach((part) => {
    (part.pinNets ?? []).forEach((net, index) => {
      if (isUnconnectedTerminal(net, part.ref, index + 1)) return;
      const hole = part.holes?.[index];
      if (!hole) return;
      const node = find(keyOf(hole));
      if (!netToNodes.has(net)) netToNodes.set(net, new Set());
      netToNodes.get(net).add(node);
      if (!nodeToNets.has(node)) nodeToNets.set(node, new Set());
      nodeToNets.get(node).add(net);
    });
  });

  const issues = [];
  netToNodes.forEach((nodes, net) => {
    if (nodes.size > 1) {
      issues.push({
        severity: 'error',
        message: `SPLIT: net ${net === GROUND_NET ? '0 (GND)' : net} lands on ${nodes.size} unconnected nodes on the board.`,
      });
    }
  });
  nodeToNets.forEach((nets) => {
    if (nets.size > 1) {
      issues.push({
        severity: 'error',
        message: `SHORT: one board node carries multiple nets: ${[...nets].map((net) => (net === GROUND_NET ? '0 (GND)' : net)).join(', ')}.`,
      });
    }
  });
  return { ok: issues.length === 0, issues };
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
