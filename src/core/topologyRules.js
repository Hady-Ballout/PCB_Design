// Functional/topology design-rule checker for AI-generated circuits.
//
// Net-continuity validation can pass while the circuit is functionally wrong:
// the canonical example is a buzzer wired straight onto an MCU GPIO net with a
// resistor divider to ground and no transistor driver — every net is formed
// correctly, yet the GPIO cannot switch the load. The rules here catch that
// class of "wiring passes, completeness fails" defects.
//
// The engine is pure and shared: the server runs it inside the generation
// retry loop (violations become corrective feedback to the AI), and the
// frontend renders surviving violations in the breadboard issues panel.
//
// Adding a rule = one entry in TOPOLOGY_RULES + one fixture pair in
// topologyRules.test.js. Rules must be conservative: a false positive burns a
// generation retry and erodes trust, so every rule skips ambiguous topologies.

import {
  COMPOUND_SPICE_KINDS,
  DEFAULT_PIN_COUNT_BY_KIND,
  FIXED_PIN_NAMES,
  MCU_KINDS,
  WIRING_ONLY_KINDS,
  kindLabel,
} from './componentKinds.js';
import { buckVolts, parseVolts } from './sim/simValues.js';

// ICs that need local supply decoupling: expected to have a bypass cap from
// their supply net to ground somewhere on the board.
const DECOUPLED_IC_KINDS = new Set(['opamp', 'ua741', 'comparator', 'timer_555', 'shift_register', 'adc_module']);
const RESISTIVE_KINDS = new Set(['resistor', 'load', 'photoresistor', 'thermistor', 'ir_phototransistor', 'potentiometer']);
const DRIVER_KINDS = new Set(['bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p']);
const HEAVY_LOAD_KINDS = new Set(['buzzer', 'dc_motor', 'vibration_motor']);
// Inductive motor loads that need a flyback diode when transistor-switched.
// Deliberately narrower than HEAVY_LOAD_KINDS: a buzzer never demands one.
const MOTOR_KINDS = new Set(['dc_motor', 'vibration_motor']);
// Driver-module breakouts whose named output pins switch a load the way a
// transistor channel does — a load on one of these nets is driven, not
// GPIO-powered.
const DRIVER_MODULE_OUTPUT_PINS = {
  motor_driver: new Set(['OUT1', 'OUT2', 'OUT3', 'OUT4']),
  stepper_driver: new Set(['OUTA', 'OUTB', 'OUTC', 'OUTD']),
};
// Isolator outputs switch a load like a transistor channel but have NO
// integrated flyback protection — consulted by hasDriverOutputOn only, never
// by the missing_flyback_diode skip.
const ISOLATOR_OUTPUT_PINS = {
  optocoupler: new Set(['E', 'C']),
};
const DIODE_KINDS = new Set(['diode', 'led', 'ir_led', 'zener', 'schottky']);
// Kinds that belong to a regulator's own filter, not to its load.
const SUPPLY_FILTER_KINDS = new Set(['capacitor', 'inductor', 'schottky', 'diode', 'resistor']);
const GPIO_PIN_PATTERN = /^(D\d+|A\d+|GPIO\d+)$/;
const MCU_LOGIC_VOLTS = { arduino_uno: 5, raspberry_pi: 3.3, esp32: 3.3 };
// 3.3V-only parts whose bare silicon is not 5V tolerant AND whose catalog
// entry already steers them to 3V3. Deliberately short: breakouts with onboard
// regulators/level circuitry (imu_sensor, oled_display, ...) stay out so the
// rule never false-positives on a tolerant module.
const MAX_INPUT_VOLTS = { raspberry_pi: 3.6, esp32: 3.6, rfid_reader: 3.6, mouse_sensor: 3.6 };
const SUPPLY_PIN_NAMES = new Set(['5V', '3V3', 'VIN', 'VCC', 'GND', 'VS', 'EN']);
// E24 standard resistor mantissas (5% series) — used to flag values that
// aren't purchasable off the shelf.
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];

// Canonical positional pin roles for kinds without a fixedPins contract.
// Exported so the component knowledge base (knowledge/components) can document
// one pin order per kind rather than keeping a second copy that drifts.
export const ROLE_PINS = {
  opamp: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  comparator: ['IN+', 'IN-', 'OUT', 'V+', 'V-'],
  bjt_npn: ['collector', 'base', 'emitter'],
  bjt_pnp: ['collector', 'base', 'emitter'],
  mosfet_n: ['drain', 'gate', 'source'],
  mosfet_p: ['drain', 'gate', 'source'],
  diode: ['anode', 'cathode'],
  led: ['anode', 'cathode'],
  ir_led: ['anode', 'cathode'],
  zener: ['anode', 'cathode'],
  schottky: ['anode', 'cathode'],
  vibration_motor: ['+', '−'],
  solar_panel: ['+', '−'],
  rgb_led: ['red', 'green', 'blue', 'common'],
  potentiometer: ['end A', 'wiper', 'end B'],
  switch_spdt: ['common', 'throw A', 'throw B'],
  pushbutton: ['terminal 1', 'terminal 2'],
};

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

export const parseResistance = (value) => {
  const text = String(value ?? '').trim().replace(/(?:Ω|ohms?)\s*$/i, '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(meg|k|m|g|r)?$/i);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = suffix === 'g' ? 1e9 : suffix === 'meg' || suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return Number(match[1]) * multiplier;
};

const parseMicrofarads = (value) => {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(u|µ|n|p|m)?F?$/i);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  const scale = suffix === 'm' ? 1e3 : suffix === 'n' ? 1e-3 : suffix === 'p' ? 1e-6 : suffix === '' ? 1e-6 : 1;
  return Number(match[1]) * scale;
};

const pinName = (part, pinIndex) =>
  FIXED_PIN_NAMES[part.kind]?.[pinIndex] || ROLE_PINS[part.kind]?.[pinIndex] || `pin ${pinIndex + 1}`;

// Which other leads current can reach when entering `part` at `fromIndex`.
// Options select the conduction model each rule needs; capacitors never cross
// (DC analysis) and MCUs/modules never cross (independent pins).
const crossings = (part, fromIndex, { crossResistors = true, crossDiodes = false, crossDrivers = false } = {}) => {
  const kind = part.kind;
  const others = part.nodes.map((_, index) => index).filter((index) => index !== fromIndex);
  if (RESISTIVE_KINDS.has(kind)) return crossResistors ? others : [];
  // A fuse is ~0Ω: it conducts even under crossResistors:false so it never
  // blocks series-loop detection (led_no_series_resistor and friends).
  if (kind === 'pushbutton' || kind === 'switch_spdt' || kind === 'inductor' || kind === 'fuse') return others;
  if (HEAVY_LOAD_KINDS.has(kind)) return others;
  if (DIODE_KINDS.has(kind) || kind === 'rgb_led' || kind === 'bridge_rectifier') return crossDiodes ? others : [];
  if (kind === 'optocoupler') {
    // Input LED (A<->K, pins 0/1) conducts like a diode; the output
    // phototransistor (E<->C, pins 2/3) like a driver channel. Never across
    // the isolation barrier.
    if (fromIndex === 0) return crossDiodes ? [1] : [];
    if (fromIndex === 1) return crossDiodes ? [0] : [];
    if (crossDrivers) return fromIndex === 2 ? [3] : [2];
    return [];
  }
  if (kind === 'current_sensor') {
    // Only the IP+ <-> IP- shunt path (pins 0/1) conducts; VCC/OUT/GND are
    // signal pins on the module header.
    if (fromIndex === 0) return [1];
    if (fromIndex === 1) return [0];
    return [];
  }
  if (DRIVER_KINDS.has(kind) && crossDrivers) {
    // Channel conduction only: collector<->emitter / drain<->source.
    if (fromIndex === 0) return [2];
    if (fromIndex === 2) return [0];
    return [];
  }
  return [];
};

export const buildCircuitGraph = (circuit) => {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const byRef = new Map();
  const netPins = new Map();
  const gpioNets = new Map();
  const supplyNets = new Set();

  for (const part of components) {
    if (!part || !Array.isArray(part.nodes)) continue;
    byRef.set(part.ref, part);
    part.nodes.forEach((rawNet, pinIndex) => {
      const net = String(rawNet);
      if (isUnconnectedTerminal(net, part.ref, pinIndex + 1)) return;
      if (!netPins.has(net)) netPins.set(net, []);
      netPins.get(net).push({ ref: part.ref, kind: part.kind, pinIndex, pinName: pinName(part, pinIndex) });

      if (MCU_KINDS.has(part.kind)) {
        const name = FIXED_PIN_NAMES[part.kind]?.[pinIndex] || '';
        if (GPIO_PIN_PATTERN.test(name) && net !== '0') {
          if (!gpioNets.has(net)) gpioNets.set(net, []);
          gpioNets.get(net).push({ ref: part.ref, kind: part.kind, pinName: name });
        }
        if ((name === '5V' || name === '3V3' || name === 'VIN') && net !== '0') supplyNets.add(net);
      }
    });

    if ((part.kind === 'voltage_source' || part.kind === 'signal_source' || part.kind === 'solar_panel') && part.nodes[0] && String(part.nodes[0]) !== '0') {
      supplyNets.add(String(part.nodes[0]));
    }
    if (part.kind === 'regulator') {
      const out = part.nodes[2];
      if (out && String(out) !== '0') supplyNets.add(String(out));
    }
    if (part.kind === 'buck_converter') {
      // OUT (nodes[1]) is the switch node, not a true DC rail, but reach()
      // crosses inductors unconditionally (see `crossings`) so marking it as
      // a supply net is what lets supply reachability propagate through the
      // LC filter to the actual output rail for free — the same trick the
      // linear regulator's OUT pin above relies on.
      const sw = part.nodes[1];
      if (sw && String(sw) !== '0') supplyNets.add(String(sw));
    }
  }

  // BFS through conductive parts from a starting net. `skipRefs` excludes the
  // component under inspection so its own leads don't connect its two sides.
  const reach = (startNet, opts = {}) => {
    const skipRefs = new Set(opts.skipRefs || []);
    const nets = new Set();
    const parts = new Set();
    const queue = [String(startNet)];
    while (queue.length) {
      const net = queue.shift();
      if (nets.has(net)) continue;
      nets.add(net);
      for (const pin of netPins.get(net) || []) {
        if (skipRefs.has(pin.ref)) continue;
        const part = byRef.get(pin.ref);
        for (const exitIndex of crossings(part, pin.pinIndex, opts)) {
          const exitNet = String(part.nodes[exitIndex]);
          if (isUnconnectedTerminal(exitNet, part.ref, exitIndex + 1)) continue;
          parts.add(pin.ref);
          if (!nets.has(exitNet)) queue.push(exitNet);
        }
      }
    }
    return {
      nets,
      parts,
      hitsGround: nets.has('0'),
      hitsSupply: [...nets].some((net) => supplyNets.has(net)),
      hitsGpio: [...nets].some((net) => gpioNets.has(net)),
      gpioNetsHit: [...nets].filter((net) => gpioNets.has(net)),
    };
  };

  return { byRef, netPins, gpioNets, supplyNets, groundNet: '0', reach };
};

const pinsOn = (graph, net) => graph.netPins.get(String(net)) || [];

// Best-effort DC volts for nets that carry a known rail. Nets without a
// confident value are simply absent — consumers must treat missing as unknown.
const buildNetVolts = (graph, circuit) => {
  const volts = new Map();
  const claim = (net, value) => {
    if (!net || net === '0' || value == null) return;
    const existing = volts.get(net);
    if (existing == null || value > existing) volts.set(net, value);
  };
  for (const part of circuit.components) {
    const fixed = FIXED_PIN_NAMES[part.kind];
    if (MCU_KINDS.has(part.kind) && fixed) {
      if (fixed.indexOf('5V') >= 0) claim(String(part.nodes[fixed.indexOf('5V')] ?? ''), 5);
      if (fixed.indexOf('3V3') >= 0) claim(String(part.nodes[fixed.indexOf('3V3')] ?? ''), 3.3);
    }
    if (part.kind === 'voltage_source' || part.kind === 'solar_panel') claim(String(part.nodes[0] ?? ''), parseVolts(part.value, null));
    if (part.kind === 'regulator') claim(String(part.nodes[2] ?? ''), parseVolts(part.value, null));
    if (part.kind === 'buck_converter') claim(String(part.nodes[1] ?? ''), buckVolts(part.value));
  }
  return volts;
};

// A driver output (collector/emitter or drain/source) or relay switch
// terminal on one of these nets means the load is switched, not GPIO-driven.
const hasDriverOutputOn = (graph, nets) => {
  for (const net of nets) {
    for (const pin of pinsOn(graph, net)) {
      if (DRIVER_KINDS.has(pin.kind) && (pin.pinIndex === 0 || pin.pinIndex === 2)) return true;
      if (pin.kind === 'relay_module' && pin.pinIndex >= 3) return true;
      if (DRIVER_MODULE_OUTPUT_PINS[pin.kind]?.has(pin.pinName)) return true;
      if (ISOLATOR_OUTPUT_PINS[pin.kind]?.has(pin.pinName)) return true;
    }
  }
  return false;
};

// Driver-module outputs only (no transistors/relays). Loads on these nets are
// switched by a board that integrates its own protection diodes.
const hasDriverModuleOutputOn = (graph, nets) => {
  for (const net of nets) {
    for (const pin of pinsOn(graph, net)) {
      if (DRIVER_MODULE_OUTPUT_PINS[pin.kind]?.has(pin.pinName)) return true;
    }
  }
  return false;
};

const isHeavyLoad = (part) => {
  if (HEAVY_LOAD_KINDS.has(part.kind)) return true;
  if (part.kind === 'load') {
    const ohms = parseResistance(part.value);
    return ohms !== null && ohms < 200;
  }
  return false;
};

const gpioLabel = (graph, net) => {
  const pin = (graph.gpioNets.get(String(net)) || [])[0];
  return pin ? `${pin.pinName} of ${pin.ref}` : `net ${net}`;
};

const supplyNameNear = (graph, nets) => [...nets].find((net) => graph.supplyNets.has(net)) || 'the supply';

const driverFix = (graph, load, gpioNet) => {
  const supply = supplyNameNear(graph, graph.reach(load.nodes[0], { skipRefs: [] }).nets);
  const pin = gpioLabel(graph, gpioNet);
  return `Insert an NPN transistor (e.g. Q1 2N2222, nodes [collector, base, emitter]): ${pin} -> 1k resistor -> base; emitter -> 0; ${load.ref} between ${supply} and the collector. Remove any resistor tying the GPIO net to ground.`;
};

const violation = (id, severity, refs, nets, message, fix) => ({
  id, severity, refs, nets, message, fix, autoFixed: false,
});

const TOPOLOGY_RULES = [
  {
    // The named buzzer-bug pattern: GPIO + load terminal share a net, the
    // load's far side sits on a supply, and a resistor "divider" runs from the
    // GPIO net to ground with no switching element anywhere.
    id: 'divider_powered_load',
    severity: 'error',
    supersedes: 'gpio_direct_load',
    check: (graph) => {
      const found = [];
      for (const [net, pins] of graph.netPins) {
        if (!graph.gpioNets.has(net)) continue;
        if (hasDriverOutputOn(graph, [net])) continue;
        const loadPin = pins.find((pin) => isHeavyLoad(graph.byRef.get(pin.ref)));
        if (!loadPin) continue;
        const load = graph.byRef.get(loadPin.ref);
        const farNet = String(load.nodes[loadPin.pinIndex === 0 ? 1 : 0]);
        const farSide = graph.reach(farNet, { skipRefs: [load.ref] });
        if (!farSide.hitsSupply && !graph.supplyNets.has(farNet)) continue;
        const divider = pins.find((pin) => {
          if (pin.kind !== 'resistor') return false;
          const resistor = graph.byRef.get(pin.ref);
          const otherNet = String(resistor.nodes[pin.pinIndex === 0 ? 1 : 0]);
          return otherNet === '0' || graph.reach(otherNet, { skipRefs: [resistor.ref] }).hitsGround;
        });
        if (!divider) continue;
        found.push(violation(
          'divider_powered_load', 'error',
          [divider.ref, load.ref, (graph.gpioNets.get(net) || [])[0]?.ref].filter(Boolean),
          [net],
          `${divider.ref} forms a fixed divider to ground on the net driven by ${gpioLabel(graph, net)}, while ${kindLabel(load.kind).toLowerCase()} ${load.ref} is fed from the supply — the GPIO cannot switch the load and current flows continuously.`,
          driverFix(graph, load, net),
        ));
      }
      return found;
    },
  },
  {
    // A heavy load (buzzer, motor, low-ohm load) conducting on the same
    // passive island as a GPIO pin, with the island completing a circuit to
    // supply or ground and no transistor/relay switching it.
    id: 'gpio_direct_load',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!isHeavyLoad(part)) continue;
        const island = graph.reach(part.nodes[0], { crossDiodes: true });
        if (!island.hitsGpio) continue;
        if (!island.hitsSupply && !island.hitsGround) continue;
        if (hasDriverOutputOn(graph, island.nets)) continue;
        const gpioNet = island.gpioNetsHit[0];
        found.push(violation(
          'gpio_direct_load', 'error',
          [part.ref, (graph.gpioNets.get(gpioNet) || [])[0]?.ref].filter(Boolean),
          [gpioNet],
          `${gpioLabel(graph, gpioNet)} drives ${kindLabel(part.kind).toLowerCase()} ${part.ref} directly with no transistor driver — a GPIO pin can only source/sink a few milliamps.`,
          driverFix(graph, part, gpioNet),
        ));
      }
      return found;
    },
  },
  {
    // A 28BYJ-48's coils draw well over 100 mA each and the motor can't run
    // without its ULN2003 board: every connected coil pin must land on a
    // driver-module output, never on a GPIO net.
    id: 'stepper_missing_driver',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'stepper_motor') continue;
        const coilPins = (part.nodes ?? []).slice(0, 4)
          .map((node, index) => ({ net: String(node), name: pinName(part, index) }))
          .filter(({ net }, index) => net && !isUnconnectedTerminal(net, part.ref, index + 1));
        if (coilPins.length === 0) continue; // fresh library part, all coils NC
        const stepperFix = `Add a stepper_driver (ULN2003), nodes [IN1, IN2, IN3, IN4, VCC, GND, OUTA, OUTB, OUTC, OUTD]: MCU GPIOs -> IN1-IN4, VCC -> 5V, GND -> 0, OUTA-OUTD -> ${part.ref}'s A-D coil pins, ${part.ref} COM -> 5V.`;
        const onGpio = coilPins.find(({ net }) => graph.gpioNets.has(net));
        if (onGpio) {
          found.push(violation(
            'stepper_missing_driver', 'error',
            [part.ref, (graph.gpioNets.get(onGpio.net) || [])[0]?.ref].filter(Boolean),
            [onGpio.net],
            `${gpioLabel(graph, onGpio.net)} is wired directly to coil pin ${onGpio.name} of ${part.ref} (28BYJ-48) — a GPIO cannot drive stepper coils; each coil draws well over 100 mA.`,
            stepperFix,
          ));
          continue;
        }
        const driven = coilPins.some(({ net }) =>
          pinsOn(graph, net).some((pin) => DRIVER_MODULE_OUTPUT_PINS[pin.kind]?.has(pin.pinName)));
        if (!driven) {
          found.push(violation(
            'stepper_missing_driver', 'error',
            [part.ref],
            coilPins.map(({ net }) => net),
            `${part.ref} (28BYJ-48 stepper) has no driver board connected to its coil pins — the coils must be switched by a ULN2003 driver, not wired directly.`,
            stepperFix,
          ));
        }
      }
      return found;
    },
  },
  {
    // WS2812 pixels draw up to 60 mA each, so the strip's VCC must come from
    // the 5V supply. DIN on a GPIO is the correct data wiring and stays
    // silent; only the power pin is checked (a per-pin check where the
    // island heuristic in gpio_direct_load would flag the data pin too).
    id: 'led_strip_power_from_gpio',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'led_strip') continue;
        const vccNet = String(part.nodes?.[0] ?? '');
        if (!vccNet || isUnconnectedTerminal(vccNet, part.ref, 1)) continue;
        if (!graph.gpioNets.has(vccNet)) continue;
        found.push(violation(
          'led_strip_power_from_gpio', 'error',
          [part.ref, (graph.gpioNets.get(vccNet) || [])[0]?.ref].filter(Boolean),
          [vccNet],
          `${part.ref} (WS2812 strip) takes its power from ${gpioLabel(graph, vccNet)} — each pixel draws up to 60 mA; the strip must be powered from the 5V supply.`,
          `Wire ${part.ref}'s VCC to the 5V supply net and GND to 0; only DIN connects to a GPIO pin.`,
        ));
      }
      return found;
    },
  },
  {
    // LED conducting from a source to ground with no resistor anywhere in the
    // loop. Traversal crosses switches, other diodes, and driver channels but
    // stops at resistors (their presence protects the loop).
    id: 'led_no_series_resistor',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      const noResistor = { crossResistors: false, crossDiodes: true, crossDrivers: true };
      for (const part of circuit.components) {
        const legs = part.kind === 'led' || part.kind === 'ir_led' ? [[0, 1]]
          : part.kind === 'rgb_led' ? [[0, 3], [1, 3], [2, 3]]
            // The optocoupler's input LED (A pin 1, K pin 2) needs a series
            // resistor exactly like a discrete LED.
            : part.kind === 'optocoupler' ? [[0, 1]]
              : [];
        for (const [anodeIndex, cathodeIndex] of legs) {
          const anodeNet = String(part.nodes[anodeIndex]);
          const cathodeNet = String(part.nodes[cathodeIndex]);
          if (isUnconnectedTerminal(anodeNet, part.ref, anodeIndex + 1)) continue;
          if (isUnconnectedTerminal(cathodeNet, part.ref, cathodeIndex + 1)) continue;
          const anodeSide = graph.reach(anodeNet, { ...noResistor, skipRefs: [part.ref] });
          const cathodeSide = graph.reach(cathodeNet, { ...noResistor, skipRefs: [part.ref] });
          const sourced = anodeSide.hitsSupply || anodeSide.hitsGpio || graph.supplyNets.has(anodeNet) || graph.gpioNets.has(anodeNet);
          const grounded = cathodeSide.hitsGround || cathodeNet === '0';
          if (sourced && grounded) {
            found.push(violation(
              'led_no_series_resistor', 'error', [part.ref], [anodeNet, cathodeNet],
              `${part.ref} (${kindLabel(part.kind)}) conducts from ${anodeNet} to ground with no series current-limiting resistor in the loop.`,
              `Add a series resistor (220-1k) between the source and ${part.ref}'s anode, sized for ~5-10 mA.`,
            ));
            break;
          }
        }
      }
      return found;
    },
  },
  {
    // Reversed LED/diode: only flagged when unambiguous — the anode side
    // reaches ground only and the cathode side reaches supply only. Zeners are
    // excluded (normally reverse-biased) and GPIO-facing sides are skipped.
    id: 'led_polarity',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        // Zener stays excluded (normally reverse-biased); a schottky is a
        // normal forward rectifier and gets the same polarity check.
        if (part.kind !== 'led' && part.kind !== 'ir_led' && part.kind !== 'diode' && part.kind !== 'schottky') continue;
        const [anodeNet, cathodeNet] = part.nodes.map(String);
        const anodeSide = graph.reach(anodeNet, { skipRefs: [part.ref] });
        const cathodeSide = graph.reach(cathodeNet, { skipRefs: [part.ref] });
        if (anodeSide.hitsGpio || cathodeSide.hitsGpio) continue;
        const anodeGroundOnly = (anodeSide.hitsGround || anodeNet === '0') && !anodeSide.hitsSupply;
        const cathodeSupplyOnly = (cathodeSide.hitsSupply || graph.supplyNets.has(cathodeNet)) && !cathodeSide.hitsGround && cathodeNet !== '0';
        if (anodeGroundOnly && cathodeSupplyOnly) {
          // A correctly wired buck-converter catch (freewheeling) schottky is
          // ["0", SW]: anode on ground, cathode on the switch node. SW is
          // marked a supply net (see buildCircuitGraph) so reach() can
          // propagate supply reachability through the inductor to the actual
          // output rail — but that same marking makes this diode's cathode
          // look "supply-only" to the check above, tripping a false reversed-
          // diode positive. Skip whenever the cathode net carries a
          // buck_converter OUT pin (pinIndex 1) AND the part under test is a
          // rectifier kind (diode/schottky). This exemption is deliberately
          // NOT extended to led/ir_led: an LED wired the same way is a real
          // miswire (LEDs aren't catch diodes) and must still be flagged.
          const isRectifierKind = part.kind === 'diode' || part.kind === 'schottky';
          const cathodeIsBuckSwitchNode = isRectifierKind && pinsOn(graph, cathodeNet)
            .some((pin) => pin.kind === 'buck_converter' && pin.pinIndex === 1);
          if (cathodeIsBuckSwitchNode) continue;
          found.push(violation(
            'led_polarity', 'error', [part.ref], [anodeNet, cathodeNet],
            `${part.ref} (${kindLabel(part.kind)}) is reversed: its anode faces ground and its cathode faces the supply, so it will never conduct.`,
            `Swap ${part.ref}'s nodes so the anode faces the supply side: ["${cathodeNet}", "${anodeNet}"].`,
          ));
        }
      }
      return found;
    },
  },
  {
    id: 'i2c_missing_pullups',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        const fixed = FIXED_PIN_NAMES[part.kind];
        if (!fixed) continue;
        const missing = [];
        for (const signal of ['SDA', 'SCL']) {
          const index = fixed.indexOf(signal);
          if (index === -1) continue;
          const net = String(part.nodes[index] ?? '');
          if (!net || isUnconnectedTerminal(net, part.ref, index + 1)) continue;
          const hasPullup = pinsOn(graph, net).some((pin) => {
            if (pin.kind !== 'resistor') return false;
            const resistor = graph.byRef.get(pin.ref);
            return graph.supplyNets.has(String(resistor.nodes[pin.pinIndex === 0 ? 1 : 0]));
          });
          if (!hasPullup) missing.push(`${signal} (net ${net})`);
        }
        if (missing.length) {
          found.push(violation(
            'i2c_missing_pullups', 'warning', [part.ref], [],
            `${part.ref} (${kindLabel(part.kind)}) has no pull-up resistor on ${missing.join(' and ')}.`,
            'Add 4.7k resistors from SDA and SCL to the logic supply, or note that the MCU internal pull-ups / module onboard pull-ups are being relied on.',
          ));
        }
      }
      return found;
    },
  },
  {
    id: 'pushbutton_no_pull',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'pushbutton') continue;
        const gpioNet = part.nodes.map(String).find((net) => graph.gpioNets.has(net));
        if (!gpioNet) continue;
        const hasPull = pinsOn(graph, gpioNet).some((pin) => pin.kind === 'resistor');
        if (!hasPull) {
          found.push(violation(
            'pushbutton_no_pull', 'warning', [part.ref], [gpioNet],
            `${part.ref} feeds ${gpioLabel(graph, gpioNet)} with no pull resistor, so the input floats when the button is open.`,
            'Add a 10k pull-up from the GPIO net to the logic supply (button to ground), or use pinMode(pin, INPUT_PULLUP) in firmware and note it.',
          ));
        }
      }
      return found;
    },
  },
  {
    // Floating BJT base / MOSFET gate: the control node connects to nothing
    // else, so the transistor state is undefined.
    id: 'driver_control_floating',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!DRIVER_KINDS.has(part.kind)) continue;
        const controlName = part.kind.startsWith('bjt') ? 'base' : 'gate';
        const net = String(part.nodes[1] ?? '');
        const floating = !net || isUnconnectedTerminal(net, part.ref, 2) || pinsOn(graph, net).length < 2;
        if (floating) {
          found.push(violation(
            'driver_control_floating', 'error', [part.ref], net ? [net] : [],
            `${part.ref} (${kindLabel(part.kind)}) has a floating ${controlName} — nothing drives it, so its state is undefined.`,
            `Connect the ${controlName} to the controlling signal${part.kind.startsWith('bjt') ? ' through a 1k base resistor' : ''}, and add a pull resistor to the off-state rail.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // BJT base tied straight onto a GPIO net (no series base resistor) is an
    // error; an N-MOSFET gate with no pull-down is only a warning.
    id: 'driver_missing_base_resistor',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!DRIVER_KINDS.has(part.kind)) continue;
        const net = String(part.nodes[1] ?? '');
        if (!net || isUnconnectedTerminal(net, part.ref, 2)) continue;
        if (part.kind.startsWith('bjt')) {
          if (graph.gpioNets.has(net)) {
            found.push(violation(
              'driver_missing_base_resistor', 'error', [part.ref], [net],
              `${part.ref}'s base is tied directly to ${gpioLabel(graph, net)} with no series base resistor — the GPIO will dump uncontrolled current into the base-emitter junction.`,
              `Insert a 1k resistor between ${gpioLabel(graph, net)} and ${part.ref}'s base (give the base its own net).`,
            ));
          }
        } else {
          const hasPulldown = pinsOn(graph, net).some((pin) => {
            if (pin.kind !== 'resistor') return false;
            const resistor = graph.byRef.get(pin.ref);
            return String(resistor.nodes[pin.pinIndex === 0 ? 1 : 0]) === '0';
          });
          if (!hasPulldown) {
            found.push(violation(
              'mosfet_gate_no_pulldown', 'warning', [part.ref], [net],
              `${part.ref}'s gate has no pull-down resistor, so the MOSFET state is undefined while the MCU pin is high-impedance (reset/boot).`,
              `Add a 100k resistor from ${part.ref}'s gate net (${net}) to ground.`,
            ));
          }
        }
      }
      return found;
    },
  },
  {
    // Inductive load (motor) switched by a transistor with no flyback diode
    // across it: the switch-off voltage spike kills the transistor.
    id: 'missing_flyback_diode',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!MOTOR_KINDS.has(part.kind)) continue;
        const motorNets = new Set(part.nodes.map(String));
        // H-bridge/driver boards integrate their own protection diodes, and a
        // motor across two bridge outputs can't take a simple parallel diode.
        if (hasDriverModuleOutputOn(graph, motorNets)) continue;
        const switched = hasDriverOutputOn(graph, motorNets);
        if (!switched) continue;
        const hasFlyback = circuit.components.some((other) =>
          DIODE_KINDS.has(other.kind) && other.kind !== 'led' && other.kind !== 'ir_led'
          && other.nodes.length === 2
          && motorNets.has(String(other.nodes[0])) && motorNets.has(String(other.nodes[1])));
        if (!hasFlyback) {
          found.push(violation(
            'missing_flyback_diode', 'error', [part.ref], [...motorNets],
            `${part.ref} (${kindLabel(part.kind)}) is switched by a transistor but has no flyback diode across it — the inductive kick at switch-off will destroy the transistor.`,
            `Add a diode (1N4007) across ${part.ref}, cathode to the supply side: nodes ["${part.nodes[1]}", "${part.nodes[0]}"] reversed relative to current flow.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // Estimate per-GPIO current along simple linear branches. Warns past a
    // safe per-pin budget, errors at destructive levels.
    id: 'gpio_current_budget',
    severity: 'warning',
    check: (graph) => {
      const found = [];
      for (const [net, gpioPins] of graph.gpioNets) {
        const logicVolts = MCU_LOGIC_VOLTS[gpioPins[0].kind] || 3.3;
        let totalMa = 0;
        const branchRefs = [];
        for (const pin of pinsOn(graph, net)) {
          const branch = traceLinearBranch(graph, pin, net);
          if (!branch || branch.ohms <= 0) continue;
          const volts = Math.max(0, (branch.endsAtSupply ? Math.max(logicVolts, branch.supplyVolts || logicVolts) : logicVolts) - branch.ledCount * 2);
          const ma = (volts / branch.ohms) * 1000;
          if (ma > 0.5) {
            totalMa += ma;
            branchRefs.push(...branch.refs);
          }
        }
        if (totalMa > 12) {
          found.push(violation(
            'gpio_current_budget', totalMa > 40 ? 'error' : 'warning',
            [...new Set(branchRefs)], [net],
            `${gpioLabel(graph, net)} sources/sinks an estimated ${Math.round(totalMa)} mA through ${[...new Set(branchRefs)].join(', ')} — beyond the ~12 mA safe per-pin budget${totalMa > 40 ? ' and likely destructive' : ''}.`,
            'Raise the series resistance, or switch the load with a transistor driver instead of the GPIO pin.',
          ));
        }
      }
      return found;
    },
  },
  {
    // Wrong node count on any fixed-pin or positional multi-pin part: the
    // breadboard and SPICE map pins by index, so a short array wires the
    // wrong physical pins.
    id: 'fixed_pin_node_count',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        const expected = POSITIONAL_KINDS.has(part.kind) ? DEFAULT_PIN_COUNT_BY_KIND[part.kind] : null;
        if (!expected || part.nodes.length === expected) continue;
        const order = FIXED_PIN_NAMES[part.kind] || ROLE_PINS[part.kind];
        found.push(violation(
          'fixed_pin_node_count', 'error', [part.ref], [],
          `${part.ref} (${kindLabel(part.kind)}) lists ${part.nodes.length} nodes but must list exactly ${expected}.`,
          `Use the positional order [${order.join(', ')}], with NC_${part.ref}_<pinNumber> for unused pins.`,
        ));
      }
      return found;
    },
  },
  {
    // Migrated from the server's floatingOpampInputCorrection: an op-amp
    // input on a node no other component uses -> singular matrix in SPICE and
    // a meaningless circuit. Deliberately narrow.
    id: 'opamp_input_floating',
    severity: 'error',
    check: (graph, circuit) => {
      const nodeUse = new Map();
      for (const part of circuit.components) {
        for (const node of part.nodes || []) nodeUse.set(String(node), (nodeUse.get(String(node)) || 0) + 1);
      }
      const found = [];
      // Input node indices per kind: opamp is [IN+, IN-, ...]; ua741 follows
      // the physical DIP-8 order [OFS1, IN-, IN+, ...].
      const inputIndices = { opamp: [0, 1], ua741: [2, 1] };
      for (const part of circuit.components) {
        const indices = inputIndices[part.kind];
        if (!indices) continue;
        const nodes = (part.nodes || []).map(String);
        const [plus, minus] = indices.map((index) => nodes[index]);
        for (const [label, node] of [['non-inverting (+)', plus], ['inverting (-)', minus]]) {
          if (!node || node === '0') continue;
          if ((nodeUse.get(node) || 0) < 2) {
            found.push(violation(
              'opamp_input_floating', 'error', [part.ref], [node],
              `${part.ref}'s ${label} input (node "${node}") connects to no other component — a floating high-impedance input.`,
              'Join the inverting input to the feedback/summing network and the non-inverting input to a reference node (ground "0" or a mid-rail bias divider), reusing the existing node name.',
            ));
          }
        }
      }
      return found;
    },
  },
  {
    // Electrolytic capacitor apparently mounted backwards. Hint only, and only
    // when the orientation is unambiguous.
    id: 'electrolytic_cap_polarity',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'capacitor') continue;
        if (!/CP_|Polar/i.test(String(part.footprint || ''))) continue;
        const uf = parseMicrofarads(part.value);
        if (uf === null || uf < 1) continue;
        const [plusNet, minusNet] = part.nodes.map(String);
        const plusSide = graph.reach(plusNet, { skipRefs: [part.ref] });
        const minusSide = graph.reach(minusNet, { skipRefs: [part.ref] });
        const plusGroundOnly = (plusSide.hitsGround || plusNet === '0') && !plusSide.hitsSupply;
        const minusSupplyOnly = (minusSide.hitsSupply || graph.supplyNets.has(minusNet)) && !minusSide.hitsGround && minusNet !== '0';
        if (plusGroundOnly && minusSupplyOnly) {
          found.push(violation(
            'electrolytic_cap_polarity', 'warning', [part.ref], [plusNet, minusNet],
            `${part.ref} (electrolytic capacitor) looks reversed: its first node faces ground while its second faces the supply.`,
            `Swap ${part.ref}'s nodes so the positive terminal (first node) faces the higher potential.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // A buck converter's OUT (switch) pin is an ideal DC source in the SPICE
    // image, but physically it needs an external LC filter to become a real
    // DC rail: no inductor on OUT means nothing turns the switching
    // waveform into DC.
    id: 'buck_missing_inductor',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const outNet = String(part.nodes[1] ?? '');
        if (!outNet || isUnconnectedTerminal(outNet, part.ref, 2)) continue;
        const hasInductor = pinsOn(graph, outNet).some((pin) => pin.kind === 'inductor');
        if (hasInductor) continue;
        found.push(violation(
          'buck_missing_inductor', 'error', [part.ref], [outNet],
          `${part.ref} (${kindLabel(part.kind)}) has no inductor on its OUT (switch) net — a buck converter needs an external LC filter to turn the switched node into a DC rail.`,
          `Wire an inductor (e.g. 33uH) from ${part.ref}'s OUT to the output rail, plus a schottky diode from 0 to the OUT net (cathode at OUT) and an output capacitor.`,
        ));
      }
      return found;
    },
  },
  {
    // With the LC inductor present, the switch node also needs a catch
    // (freewheeling) diode: without one, inductor current has nowhere to go
    // the instant the internal switch turns off.
    id: 'buck_missing_catch_diode',
    severity: 'error',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const outNet = String(part.nodes[1] ?? '');
        if (!outNet || isUnconnectedTerminal(outNet, part.ref, 2)) continue;
        const hasInductor = pinsOn(graph, outNet).some((pin) => pin.kind === 'inductor');
        if (!hasInductor) continue; // buck_missing_inductor already covers this circuit
        const hasCatchDiode = pinsOn(graph, outNet).some((pin) =>
          (pin.kind === 'schottky' || pin.kind === 'diode') && pin.pinIndex === 1);
        if (hasCatchDiode) continue;
        found.push(violation(
          'buck_missing_catch_diode', 'error', [part.ref], [outNet],
          `${part.ref} (${kindLabel(part.kind)}) has an inductor on OUT but no catch diode — when the internal switch turns off, the inductor current has no freewheel path.`,
          `Add a schottky diode with nodes ["0", "${outNet}"] (cathode at ${outNet}).`,
        ));
      }
      return found;
    },
  },
  {
    // FB unconnected or shorted straight to the raw switch node are the only
    // two unambiguous misroutes worth flagging — verifying FB actually
    // reaches the filtered output rail would require modeling the resistive
    // feedback divider, which is out of scope here.
    id: 'buck_fb_misrouted',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const outNet = String(part.nodes[1] ?? '');
        const fbNet = String(part.nodes[3] ?? '');
        const fbUnconnected = !fbNet || isUnconnectedTerminal(fbNet, part.ref, 4);
        const outConnected = outNet && !isUnconnectedTerminal(outNet, part.ref, 2);
        const fbOnSwitchNode = !fbUnconnected && outConnected && fbNet === outNet;
        if (!fbUnconnected && !fbOnSwitchNode) continue;
        found.push(violation(
          'buck_fb_misrouted', 'warning', [part.ref], fbUnconnected ? [] : [fbNet],
          fbUnconnected
            ? `${part.ref} (${kindLabel(part.kind)}) has its FB pin unconnected — the regulator has no feedback and cannot regulate its output.`
            : `${part.ref} (${kindLabel(part.kind)}) has FB tied to the raw switch node (OUT) instead of the filtered output rail — it will sense the unfiltered switching waveform, not the regulated voltage.`,
          `Wire ${part.ref}'s FB pin to the output rail on the far side of the inductor (after the LC filter), not to OUT directly.`,
        ));
      }
      return found;
    },
  },
  {
    // A buck converter needs at least ~2V of headroom between VIN and the
    // regulated output to stay in regulation; warn (never error, since the
    // datasheet dropout varies) when every source reachable from VIN falls
    // short.
    id: 'buck_insufficient_headroom',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const vinNet = String(part.nodes[0] ?? '');
        if (!vinNet || isUnconnectedTerminal(vinNet, part.ref, 1)) continue;
        const vinReach = graph.reach(vinNet, { skipRefs: [part.ref] });
        let maxVolts = null;
        const sourceRefs = [];
        for (const other of circuit.components) {
          if (other.kind !== 'voltage_source' && other.kind !== 'solar_panel') continue;
          const posNet = String(other.nodes?.[0] ?? '');
          if (!posNet || !vinReach.nets.has(posNet)) continue;
          const volts = parseVolts(other.value, null);
          if (volts === null) continue;
          sourceRefs.push(other.ref);
          if (maxVolts === null || volts > maxVolts) maxVolts = volts;
        }
        if (maxVolts === null) continue; // no source found on VIN: skip entirely
        const outVolts = buckVolts(part.value);
        const needed = outVolts + 2;
        if (maxVolts < needed) {
          found.push(violation(
            'buck_insufficient_headroom', 'warning', [part.ref, ...sourceRefs], [vinNet],
            `${part.ref} (${kindLabel(part.kind)}) regulates to ${outVolts}V but the highest source reaching its VIN is only ${maxVolts}V — a buck converter needs at least 2V of input headroom above its output.`,
            `Supply at least ${needed}V to ${part.ref}'s VIN, or use a lower-output buck variant.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // A push-pull 5V MCU output sharing a net with a pin of a 3.3V-only part:
    // first transition puts 5V on the pad. TC7 (Uno TX -> Pi GPIO) and TC2
    // (Uno SPI -> RC522) both die here.
    id: 'voltage_domain_overdrive',
    severity: 'error',
    check: (graph) => {
      const found = [];
      for (const [net, pins] of graph.netPins) {
        const driver = (graph.gpioNets.get(net) || [])
          .map((pin) => ({ ...pin, volts: MCU_LOGIC_VOLTS[pin.kind] || 3.3 }))
          .sort((a, b) => b.volts - a.volts)[0];
        if (!driver) continue;
        for (const pin of pins) {
          const max = MAX_INPUT_VOLTS[pin.kind];
          if (max == null || driver.volts <= max) continue;
          if (pin.ref === driver.ref || SUPPLY_PIN_NAMES.has(pin.pinName)) continue;
          found.push(violation(
            'voltage_domain_overdrive', 'error', [driver.ref, pin.ref], [net],
            `${driver.pinName} of ${driver.ref} drives ${driver.volts}V into ${pin.pinName} of ${pin.ref} (${kindLabel(pin.kind)}), which tolerates at most ${max}V — this can destroy the part.`,
            `Put a level shifter (or series resistor + divider) between ${driver.ref} ${driver.pinName} and ${pin.ref} ${pin.pinName}, or drive it from a 3.3V MCU pin.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // A pull-up referencing a rail above the weakest device's input rating on
    // that net: the line idles at the destructive voltage even with every
    // driver tri-stated (TC7's RPU1 to 5V on a Pi net).
    id: 'pullup_exceeds_domain',
    severity: 'error',
    check: (graph, circuit) => {
      const netVolts = buildNetVolts(graph, circuit);
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor' || (part.nodes ?? []).length !== 2) continue;
        const [a, b] = part.nodes.map(String);
        for (const [signalNet, railNet] of [[a, b], [b, a]]) {
          const rail = netVolts.get(railNet);
          if (rail == null) continue;
          for (const pin of pinsOn(graph, signalNet)) {
            const max = MAX_INPUT_VOLTS[pin.kind];
            if (max == null || rail <= max || SUPPLY_PIN_NAMES.has(pin.pinName)) continue;
            found.push(violation(
              'pullup_exceeds_domain', 'error', [part.ref, pin.ref], [signalNet],
              `${part.ref} pulls net "${signalNet}" up to ${rail}V, but ${pin.pinName} of ${pin.ref} (${kindLabel(pin.kind)}) tolerates at most ${max}V — the line idles at a destructive level.`,
              `Reference the pull-up to the ${max >= 3.3 ? '3.3V' : 'lower'} rail instead of "${railNet}", or remove it if both ends are push-pull.`,
            ));
          }
        }
      }
      return found;
    },
  },
  {
    // A net with exactly one member pin carries no current: either a missing
    // connection or a pin that should have been NC_<ref>_<n>. TC2's VCC5
    // claimed an entire power rail for a one-pin net.
    id: 'single_pin_net',
    severity: 'warning',
    check: (graph) => {
      const found = [];
      for (const [net, pins] of graph.netPins) {
        if (net === '0' || pins.length >= 2) continue;
        const pin = pins[0];
        found.push(violation(
          'single_pin_net', 'warning', [pin.ref], [net],
          `Net "${net}" connects only ${pin.pinName} of ${pin.ref} — a one-pin net is either a missing connection or a pin that should be marked unused.`,
          `Connect net "${net}" to its intended destination, or rename the node to NC_${pin.ref}_${pin.pinIndex + 1}.`,
        ));
      }
      return found;
    },
  },
  {
    // A complete regulator subcircuit whose output feeds nothing but its own
    // filter passives (TC4's dead LM2596). Conservative: any non-filter pin
    // downstream silences it.
    id: 'orphan_supply',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'regulator' && part.kind !== 'buck_converter') continue;
        const outIndex = part.kind === 'regulator' ? 2 : 1;
        const outNet = String(part.nodes[outIndex] ?? '');
        if (!outNet || isUnconnectedTerminal(outNet, part.ref, outIndex + 1)) continue;
        const island = graph.reach(outNet, { skipRefs: [part.ref] });
        const consumer = [...island.nets]
          .flatMap((net) => pinsOn(graph, net))
          .find((pin) => pin.ref !== part.ref && !SUPPLY_FILTER_KINDS.has(pin.kind));
        if (!consumer) {
          found.push(violation(
            'orphan_supply', 'warning', [part.ref], [outNet],
            `${part.ref} (${kindLabel(part.kind)}) regulates net "${outNet}" but nothing consumes it — only its own filter parts sit downstream.`,
            `Feed a load from "${outNet}" (for example the MCU's supply input), or remove ${part.ref} and its filter parts.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // An MCU or wiring-only module whose only live connections are power and
    // ground: it participates in nothing (TC7's ESP32, TC1's Arduino).
    id: 'dead_active_device',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (!MCU_KINDS.has(part.kind) && !WIRING_ONLY_KINDS.has(part.kind)) continue;
        const live = (part.nodes ?? [])
          .map((node, index) => ({ net: String(node), index }))
          .filter(({ net, index }) => net && !isUnconnectedTerminal(net, part.ref, index + 1));
        if (!live.length) continue; // fresh library part: stay silent
        const signals = live.filter(({ net }) => net !== '0' && !graph.supplyNets.has(net));
        if (!signals.length) {
          found.push(violation(
            'dead_active_device', 'warning', [part.ref], live.map(({ net }) => net),
            `${part.ref} (${kindLabel(part.kind)}) connects only to power and ground — no signal pin participates, so it does nothing in this circuit.`,
            `Wire ${part.ref}'s data/control pins into the circuit, or remove it.`,
          ));
        }
      }
      return found;
    },
  },
  {
    // Values the breadboard itself swamps: below contact resistance the board
    // IS the resistor; near insulation leakage the board bypasses it (TC6).
    id: 'resistor_extreme_value',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor' && part.kind !== 'load') continue;
        const ohms = parseResistance(part.value);
        if (ohms === null) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} has an unparseable resistance value "${part.value}".`,
            'Use a plain value such as "330", "4.7k", or "1Meg".'));
        } else if (ohms < 1) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} is below breadboard contact resistance (~0.05–0.1Ω per contact) — the board dominates the value; milliohm parts need Kelvin connections.`,
            'Use ≥1Ω, or move the shunt off-board (the current_sensor kind models a proper shunt).'));
        } else if (ohms > 1e8) {
          found.push(violation('resistor_extreme_value', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} approaches breadboard insulation leakage (~1e9Ω) — the board leaks more than the part conducts.`,
            'Keep resistances ≤100MΩ on a solderless board, or mount the part off-board with guarding.'));
        }
      }
      return found;
    },
  },
  {
    // Not purchasable: a value off the E24 grid (TC1's 250Ω). Warning only —
    // exact values are sometimes intentional.
    id: 'non_standard_resistor',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'resistor') continue;
        const ohms = parseResistance(part.value);
        if (ohms === null || ohms < 1 || ohms > 1e8) continue; // resistor_extreme_value owns those
        const decade = 10 ** Math.floor(Math.log10(ohms));
        const mantissa = ohms / decade;
        const nearest = E24.reduce((best, step) => (Math.abs(step - mantissa) < Math.abs(best - mantissa) ? step : best), E24[0]);
        if (Math.abs(nearest - mantissa) / nearest > 0.02) {
          found.push(violation('non_standard_resistor', 'warning', [part.ref], [],
            `${part.ref} = ${part.value} is not an E24 standard value (nearest: ${nearest * decade}).`,
            `Use ${nearest * decade} unless the exact value is intentional.`));
        }
      }
      return found;
    },
  },
  {
    // Only fixed LM2596 variants exist (3.3, 5.0, 12); anything else is the
    // ADJ part, which needs a feedback divider this model doesn't carry (TC4
    // generated an "LM2596-4.0").
    id: 'buck_unreal_part_number',
    severity: 'warning',
    check: (graph, circuit) => {
      const found = [];
      for (const part of circuit.components) {
        if (part.kind !== 'buck_converter') continue;
        const volts = buckVolts(part.value);
        if (volts === 3.3 || volts === 5 || volts === 12) continue;
        found.push(violation('buck_unreal_part_number', 'warning', [part.ref], [],
          `${part.ref} is "${part.value}" — LM2596 fixed-output variants are only -3.3, -5.0 and -12; a ${volts}V version is not a real part.`,
          'Pick LM2596-3.3, LM2596-5.0 or LM2596-12, or restate the requirement so a real fixed variant fits.'));
      }
      return found;
    },
  },
  {
    // Two or more ICs sharing a rail with not one capacitor from any supply
    // net to ground (TC1: ten op amps, zero decoupling). One warning for the
    // whole board, not one per IC.
    id: 'missing_supply_decoupling',
    severity: 'warning',
    check: (graph, circuit) => {
      const ics = circuit.components.filter((part) => DECOUPLED_IC_KINDS.has(part.kind));
      if (ics.length < 2) return [];
      const decoupled = circuit.components.some((part) => {
        if (part.kind !== 'capacitor' || (part.nodes ?? []).length !== 2) return false;
        const [a, b] = part.nodes.map(String);
        const railSide = a === '0' ? b : b === '0' ? a : null;
        return railSide !== null && graph.supplyNets.has(railSide);
      });
      if (decoupled) return [];
      return [violation('missing_supply_decoupling', 'warning', ics.map((part) => part.ref), [],
        `${ics.length} ICs (${ics.map((part) => part.ref).join(', ')}) share the supply with no decoupling capacitor anywhere from a supply net to ground.`,
        "Add a 100nF capacitor across each IC's supply and ground pins, plus one 10µF bulk capacitor on the rail.")];
    },
  },
];

// Kinds whose pin meaning is positional; a wrong node count silently maps the
// wrong physical pins downstream.
const POSITIONAL_KINDS = new Set([
  ...Object.keys(FIXED_PIN_NAMES),
  ...COMPOUND_SPICE_KINDS,
  'opamp', 'comparator', 'pushbutton', 'bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p',
]);

// Follow a simple series chain (2-pin components across 2-pin nets) from a
// GPIO net until it lands on ground or a supply. Bails (returns null) on any
// branching or non-passive part, so estimates never guess at topology.
const traceLinearBranch = (graph, startPin, gpioNet) => {
  let ohms = 0;
  let ledCount = 0;
  const refs = [];
  let pin = startPin;
  let fromNet = String(gpioNet);
  for (let hops = 0; hops < 8; hops += 1) {
    const part = graph.byRef.get(pin.ref);
    if (!part || part.nodes.length !== 2) return null;
    if (RESISTIVE_KINDS.has(part.kind) || HEAVY_LOAD_KINDS.has(part.kind)) {
      const value = parseResistance(part.value);
      if (value === null) return null;
      ohms += value;
    } else if (part.kind === 'led' || part.kind === 'ir_led') {
      // The 2 V-per-LED drop assumed by the caller slightly under-estimates
      // current for an IR LED (Vf ≈ 1.3 V) — conservative for an advisory rule.
      ledCount += 1;
    } else if (part.kind !== 'diode' && part.kind !== 'pushbutton' && part.kind !== 'inductor') {
      return null;
    }
    refs.push(part.ref);
    const nextNet = String(part.nodes[String(part.nodes[0]) === fromNet ? 1 : 0]);
    if (nextNet === '0') return { ohms, ledCount, refs, endsAtSupply: false };
    if (graph.supplyNets.has(nextNet)) return { ohms, ledCount, refs, endsAtSupply: true, supplyVolts: null };
    const nextPins = pinsOn(graph, nextNet).filter((candidate) => candidate.ref !== part.ref);
    if (nextPins.length !== 1) return null;
    pin = nextPins[0];
    fromNet = nextNet;
  }
  return null;
};

export const checkCircuitTopology = (circuit) => {
  const graph = buildCircuitGraph(circuit);
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  if (!components.length) return { ok: true, violations: [] };
  let violations = [];
  for (const rule of TOPOLOGY_RULES) {
    try {
      violations.push(...rule.check(graph, { ...circuit, components }));
    } catch {
      // A rule crash must never take down generation; skip the rule.
    }
  }
  // A more specific rule can supersede a general one for the same refs.
  for (const rule of TOPOLOGY_RULES) {
    if (!rule.supersedes) continue;
    const specific = violations.filter((entry) => entry.id === rule.id);
    if (!specific.length) continue;
    const covered = new Set(specific.flatMap((entry) => entry.refs));
    violations = violations.filter((entry) =>
      entry.id !== rule.supersedes || !entry.refs.some((ref) => covered.has(ref)));
  }
  return { ok: !violations.some((entry) => entry.severity === 'error'), violations };
};

const RESISTOR_FOOTPRINT = 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal';
const DIODE_FOOTPRINT = 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal';

const nextRef = (circuit, prefix) => {
  const taken = new Set(circuit.components.map((part) => String(part.ref).toUpperCase()));
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
};

// Deterministic repairs for violations that can be fixed by ADDING a part
// without changing the circuit's behavior when it was already correct:
// a MOSFET gate pull-down and a flyback diode across a switched motor.
// Anything that would rearrange existing parts (inserting a driver stage,
// moving a resistor) stays a surfaced violation for the user/AI to resolve.
// Returns { circuit, violations, applied }; fixed violations are marked
// autoFixed so the UI can show them green.
export const applySafeAutoFixes = (circuit, violations) => {
  const components = Array.isArray(circuit?.components) ? [...circuit.components] : [];
  if (!components.length) return { circuit, violations, applied: false };
  const fixed = { ...circuit, components };
  const graph = buildCircuitGraph(circuit);
  const notes = [...(fixed.notes || [])];
  let applied = false;

  const updated = violations.map((entry) => {
    if (entry.id === 'mosfet_gate_no_pulldown') {
      const mosfet = graph.byRef.get(entry.refs[0]);
      const gateNet = mosfet && String(mosfet.nodes[1] ?? '');
      if (!gateNet) return entry;
      const ref = nextRef(fixed, 'RPD');
      components.push({ ref, kind: 'resistor', value: '100k', nodes: [gateNet, '0'], footprint: RESISTOR_FOOTPRINT });
      notes.push(`Auto-added ${ref} (100k gate pull-down) so ${entry.refs[0]} stays off while the control pin is high-impedance.`);
      applied = true;
      return { ...entry, autoFixed: true };
    }
    if (entry.id === 'missing_flyback_diode') {
      const load = graph.byRef.get(entry.refs[0]);
      if (!load || load.nodes.length !== 2) return entry;
      const [netA, netB] = load.nodes.map(String);
      // Cathode faces the supply side so the diode only conducts the
      // inductive kick, never the supply.
      const aIsSupply = graph.supplyNets.has(netA)
        || graph.reach(netA, { skipRefs: [load.ref] }).hitsSupply;
      const [anodeNet, cathodeNet] = aIsSupply ? [netB, netA] : [netA, netB];
      const ref = nextRef(fixed, 'DFB');
      components.push({ ref, kind: 'diode', value: '1N4007', nodes: [anodeNet, cathodeNet], footprint: DIODE_FOOTPRINT });
      notes.push(`Auto-added ${ref} (1N4007 flyback diode) across ${entry.refs[0]} to clamp the switch-off voltage spike.`);
      applied = true;
      return { ...entry, autoFixed: true };
    }
    return entry;
  });

  if (!applied) return { circuit, violations, applied: false };
  fixed.notes = notes;
  return { circuit: fixed, violations: updated, applied: true };
};

export const composeTopologyCorrection = (violations) => {
  const errors = violations.filter((entry) => entry.severity === 'error').slice(0, 3);
  if (!errors.length) return '';
  const lines = errors.map((entry, index) => `${index + 1}. [${entry.id}] ${entry.message} Fix: ${entry.fix}`);
  return `Your circuit has functional design errors:\n${lines.join('\n')}\nReturn the corrected full circuit JSON and matching SPICE. Keep every unrelated component unchanged.`;
};

export { TOPOLOGY_RULES };
