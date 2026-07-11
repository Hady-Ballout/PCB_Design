// circuit JSON → primitive simulation netlist. Mirrors the electrical
// treatment of toSpice() in pcbGenerator.js (same expansions, same model
// parameters, same leg-skipping rules for compound kinds) so the live sim and
// the ngspice waveform page tell the same story.

import { MCU_KINDS, WIRING_ONLY_KINDS, kindLabel } from '../componentKinds.js';
import {
  parseFarads,
  parseHenries,
  parseOhms,
  parseSourceWaveform,
  parseVolts,
  regulatorVolts,
  zenerVolts,
} from './simValues.js';

export const GROUND = -1;

const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;

// Diode junction parameters straight from the toSpice .model lines. Series
// resistance is expanded into a real resistor + internal node by this module,
// so the device solver only ever sees ideal junctions.
const DIODE_MODELS = {
  DGEN: { is: 1e-14, n: 1, rs: 1 },
  DRED: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DGRN: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DBLU: { is: 1e-20, n: 2, rs: 10, bv: 5, ibv: 10e-6 },
  DSCH: { is: 1e-8, n: 1.05, rs: 0.5, bv: 40, ibv: 1e-6 },
};

const SEVEN_SEGMENT_SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];

// Tier-1 kinds whose active models are deferred to a later milestone. They
// must not crash the engine: their pins simply float (global gmin).
const DEFERRED_KINDS = new Set(['bjt_npn', 'bjt_pnp', 'mosfet_n', 'mosfet_p', 'opamp', 'comparator', 'timer_555', 'optocoupler']);

const regulatorOutputNode = (nodes = []) => nodes.find((node) => /^v?out/i.test(node)) || nodes.at(-1) || 'VOUT';

export const buildSimNetlist = (circuit) => {
  const components = circuit?.components ?? [];
  const devices = [];
  const controls = [];
  const warnings = [];
  const nodeIndex = new Map();
  let branchCount = 0;

  const warnOnce = (code, message) => {
    if (!warnings.some((entry) => entry.code === code && entry.message === message)) {
      warnings.push({ code, message });
    }
  };

  const indexOf = (net) => {
    const name = String(net);
    if (name === '0') return GROUND;
    if (!nodeIndex.has(name)) nodeIndex.set(name, nodeIndex.size);
    return nodeIndex.get(name);
  };

  // Internal nodes (diode series resistance) never correspond to a circuit
  // net; give them names that cannot collide with user nets.
  const internalNode = (id) => indexOf(`__int_${id}`);

  const addResistor = (id, owner, kind, n1, n2, ohms) => {
    devices.push({ type: 'resistor', id, owner, kind, n1, n2, ohms });
  };

  const addVariableResistor = (id, owner, kind, n1, n2, model, params) => {
    devices.push({ type: 'vres', id, owner, kind, n1, n2, model, params });
  };

  const addVsource = (id, owner, kind, np, nm, waveform) => {
    devices.push({ type: 'vsource', id, owner, kind, np, nm, branch: branchCount, waveform });
    branchCount += 1;
  };

  const addDiode = (id, owner, kind, anodeNet, cathodeNet, modelName, channel = null) => {
    const model = modelName.startsWith('DZEN')
      ? { is: 1e-14, n: 1, rs: 1, bv: zenerVolts(modelName.replace('DZEN:', '')), ibv: 5e-3 }
      : DIODE_MODELS[modelName];
    const anode = indexOf(anodeNet);
    const cathode = indexOf(cathodeNet);
    if (model.rs > 0) {
      const int = internalNode(id);
      addResistor(`${id}__rs`, owner, 'diode_rs', anode, int, model.rs);
      devices.push({ type: 'diode', id, owner, kind, anode: int, cathode, model, channel });
    } else {
      devices.push({ type: 'diode', id, owner, kind, anode, cathode, model, channel });
    }
  };

  for (const part of components) {
    const { ref, kind, value } = part;
    const nodes = part.nodes ?? [];
    const [a, b, c, d] = nodes;

    if (MCU_KINDS.has(kind)) {
      warnOnce('mcu_not_simulated', `${ref} (${kindLabel(kind)}) is not simulated — its pins float`);
      continue;
    }
    if (WIRING_ONLY_KINDS.has(kind)) {
      warnOnce('module_not_simulated', `${ref} (${kindLabel(kind)}) is a wiring-only module — not simulated`);
      continue;
    }
    if (DEFERRED_KINDS.has(kind)) {
      warnOnce('kind_not_simulated', `${ref} (${kindLabel(kind)}) is not yet simulated — its pins float`);
      continue;
    }

    switch (kind) {
      case 'resistor':
      case 'load':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 1e3));
        break;
      case 'buzzer':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 1e3));
        break;
      case 'dc_motor':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 10));
        break;
      case 'vibration_motor':
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 27));
        break;
      case 'fuse':
        // Ratings like "1A" don't parse as a resistance → 50 mΩ, like toSpice.
        addResistor(ref, ref, kind, indexOf(a), indexOf(b), parseOhms(value, 0.05));
        break;
      case 'capacitor':
        devices.push({ type: 'capacitor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), farads: parseFarads(value, 1e-6) });
        break;
      case 'crystal':
        devices.push({ type: 'capacitor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), farads: 20e-12 });
        break;
      case 'inductor':
        devices.push({ type: 'inductor', id: ref, owner: ref, n1: indexOf(a), n2: indexOf(b), henries: parseHenries(value, 1e-3) });
        break;
      case 'voltage_source':
      case 'solar_panel':
        addVsource(ref, ref, kind, indexOf(a), indexOf(b), parseSourceWaveform(`DC ${parseVolts(value, 5)}`));
        break;
      case 'signal_source': {
        const waveform = parseSourceWaveform(value);
        if (waveform.warning) warnOnce('source_value', `${ref}: ${waveform.warning} — treating as 0V`);
        addVsource(ref, ref, kind, indexOf(a), indexOf(b), waveform);
        break;
      }
      case 'regulator': {
        if (isUnconnectedTerminal(a, ref, 1)) {
          warnOnce('regulator_unpowered', `${ref} (${kindLabel(kind)}) has no input supply wired — output modeled as ideal anyway`);
        }
        addVsource(ref, ref, kind, indexOf(regulatorOutputNode(nodes)), GROUND, parseSourceWaveform(`DC ${regulatorVolts(value)}`));
        break;
      }
      case 'diode':
        addDiode(ref, ref, kind, a, b, 'DGEN');
        break;
      case 'led':
        addDiode(ref, ref, kind, a, b, 'DRED');
        break;
      case 'schottky':
        addDiode(ref, ref, kind, a, b, 'DSCH');
        break;
      case 'zener':
        addDiode(ref, ref, kind, a, b, `DZEN:${value ?? ''}`);
        break;
      case 'rgb_led': {
        const models = { R: 'DRED', G: 'DGRN', B: 'DBLU' };
        ['R', 'G', 'B'].forEach((channel, index) => {
          const anode = nodes[index];
          if (isUnconnectedTerminal(anode, ref, index + 1) || isUnconnectedTerminal(d, ref, 4)) return;
          addDiode(`${ref}_${channel}`, ref, kind, anode, d, models[channel], channel);
        });
        break;
      }
      case 'seven_segment': {
        const com = nodes[8];
        SEVEN_SEGMENT_SEGMENTS.forEach((segment, index) => {
          const anode = nodes[index];
          if (!anode || !com) return;
          if (isUnconnectedTerminal(anode, ref, index + 1) || isUnconnectedTerminal(com, ref, 9)) return;
          addDiode(`${ref}_${segment}`, ref, kind, anode, com, 'DRED', segment);
        });
        break;
      }
      case 'bridge_rectifier': {
        const legs = [['A', a, c, 1, 3], ['B', b, c, 2, 3], ['C', d, a, 4, 1], ['D', d, b, 4, 2]];
        legs.forEach(([suffix, anode, cathode, anodePin, cathodePin]) => {
          if (isUnconnectedTerminal(anode, ref, anodePin) || isUnconnectedTerminal(cathode, ref, cathodePin)) return;
          addDiode(`${ref}_${suffix}`, ref, kind, anode, cathode, 'DGEN');
        });
        break;
      }
      case 'current_sensor':
        if (!isUnconnectedTerminal(a, ref, 1) && !isUnconnectedTerminal(b, ref, 2)) {
          addResistor(`${ref}_S`, ref, kind, indexOf(a), indexOf(b), 0.0012);
        }
        break;
      case 'pushbutton':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'pushbutton', {});
        controls.push({ ref, kind, type: 'momentary', name: 'pressed', value: 0 });
        break;
      case 'switch_spdt': {
        // [A, COM, B]: pin 2 is the common, matching the SPICE image.
        const com = indexOf(b);
        addVariableResistor(`${ref}_A`, ref, kind, com, indexOf(a), 'switch_throw', { throw: 'A' });
        addVariableResistor(`${ref}_B`, ref, kind, com, indexOf(c), 'switch_throw', { throw: 'B' });
        controls.push({ ref, kind, type: 'toggle', name: 'position', value: 'A' });
        break;
      }
      case 'potentiometer': {
        const total = parseOhms(value, 10e3);
        addVariableResistor(`${ref}_A`, ref, kind, indexOf(a), indexOf(b), 'pot_upper', { total });
        addVariableResistor(`${ref}_B`, ref, kind, indexOf(b), indexOf(c), 'pot_lower', { total });
        controls.push({ ref, kind, type: 'slider', name: 'wiper', min: 0, max: 1, step: 0.01, value: 0.5, label: 'Wiper' });
        break;
      }
      case 'photoresistor':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'photoresistor', {});
        controls.push({ ref, kind, type: 'slider', name: 'light', min: 0, max: 1, step: 0.01, value: 0.55, label: 'Light' });
        break;
      case 'thermistor':
        addVariableResistor(ref, ref, kind, indexOf(a), indexOf(b), 'thermistor', { r25: parseOhms(value, 10e3) });
        controls.push({ ref, kind, type: 'slider', name: 'tempC', min: -20, max: 100, step: 1, value: 25, label: 'Temperature (°C)' });
        break;
      default:
        warnOnce('kind_not_simulated', `${ref} (${kindLabel(kind)}) is not yet simulated — its pins float`);
        break;
    }
  }

  if (devices.length === 0) {
    return { ok: false, error: { code: 'nothing_to_simulate', message: 'No simulatable components in this circuit' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount: 0, controls, warnings };
  }

  const touchesGround = components.some((part) =>
    !WIRING_ONLY_KINDS.has(part.kind) && !DEFERRED_KINDS.has(part.kind)
    && (part.nodes ?? []).some((node) => String(node) === '0'))
    || devices.some((device) => device.np === GROUND || device.nm === GROUND);
  if (!touchesGround) {
    return { ok: false, error: { code: 'no_ground', message: 'Connect the circuit to GND (net 0) to simulate' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }

  const sources = devices.filter((device) => device.type === 'vsource');
  if (sources.length === 0) {
    return { ok: false, error: { code: 'no_source', message: 'Add a power source (battery, supply, or signal source) to simulate' }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }
  const short = sources.find((device) => device.np === device.nm);
  if (short) {
    return { ok: false, error: { code: 'source_short', message: `${short.owner} is short-circuited — both terminals are on the same net` }, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
  }

  return { ok: true, error: null, devices, nodeIndex, nodeCount: nodeIndex.size, branchCount, controls, warnings };
};
