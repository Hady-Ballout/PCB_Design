// Interactive circuit simulation engine: modified nodal analysis with
// Newton-Raphson for the diode family and backward-Euler transient for
// capacitors/inductors. Pure JS, no dependencies, small dense matrices.

import { clearMatrix, makeMatrix, solveDense } from './linalg.js';
import { buildSimNetlist, GROUND } from './simNetlist.js';
import { evalBjt, evalDiode, evalMosfet, evalOpamp, junctionCriticalVoltage, limitDiode, limitJunction, THERMAL_VOLTAGE, variableOhms } from './simDevices.js';
import { AVR_CLOCK_HZ, createAvrRunner } from './avrRunner.js';
import { createPeripheral } from './avrPeripherals.js';
import { observablesFor } from './simObservables.js';

const GMIN = 1e-12;
const MAX_NR_ITERATIONS = 100;
const ABS_TOL = 1e-6;
const REL_TOL = 1e-3;
const MIN_H = 5e-6;
const MAX_H = 50e-6;
const DEFAULT_H = 20e-6;
const MAX_WALL_DT = 0.1;
const GMIN_STEPS = [1e-2, 1e-3, 1e-4, 1e-6, 1e-8, 1e-10];
const SOURCE_STEPS = [0.1, 0.2, 0.4, 0.6, 0.8, 1];

const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

const allFinite = (vector) => {
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) return false;
  }
  return true;
};

// Heuristic timestep: resolve the fastest source period and the smallest
// R·C / L/R time constant reachable from each reactive part's own nets.
const chooseTimestep = (devices) => {
  let h = DEFAULT_H;
  for (const device of devices) {
    if (device.type === 'vsource' && device.waveform.maxFrequency > 0) {
      h = Math.min(h, 1 / (20 * device.waveform.maxFrequency));
    }
  }
  const resistors = devices.filter((device) => device.type === 'resistor' || device.type === 'vres');
  const neighbourOhms = (n1, n2) => {
    let min = Infinity;
    for (const res of resistors) {
      const ohms = res.type === 'vres' ? variableOhms(res, {}) : res.ohms;
      if (res.n1 === n1 || res.n2 === n1 || res.n1 === n2 || res.n2 === n2) min = Math.min(min, ohms);
    }
    return min;
  };
  for (const device of devices) {
    if (device.type === 'capacitor') {
      const ohms = neighbourOhms(device.n1, device.n2);
      if (Number.isFinite(ohms)) h = Math.min(h, (ohms * device.farads) / 5);
    }
    if (device.type === 'inductor') {
      const ohms = neighbourOhms(device.n1, device.n2);
      if (Number.isFinite(ohms) && ohms > 0) h = Math.min(h, device.henries / ohms / 5);
    }
  }
  return Math.min(MAX_H, Math.max(MIN_H, h));
};

export const createSimulation = (circuit, options = {}) => {
  // Firmware attaches to the first Uno in the circuit (single-Uno limit).
  const mcuRef = options.mcu
    ? (circuit?.components ?? []).find((part) => part.kind === 'arduino_uno')?.ref ?? null
    : null;
  const netlist = buildSimNetlist(circuit, { mcuRef });
  const { devices, nodeIndex, nodeCount, branchCount, controls, warnings } = netlist;

  const noop = {
    ok: false,
    error: netlist.error,
    warnings,
    controls,
    isDynamic: false,
    time: 0,
    h: DEFAULT_H,
    advance: () => ({ advanced: 0, speed: 0, converged: false }),
    solveDC: () => false,
    setControl: () => {},
    probe: () => ({ netVoltages: new Map([['0', 0]]), branchCurrents: new Map() }),
    observables: () => new Map(),
    status: () => ({ converged: false, lastSpeed: 0, iterations: 0 }),
  };
  if (!netlist.ok) return noop;

  const size = nodeCount + branchCount;
  const A = makeMatrix(size);
  const rhs = new Float64Array(size);
  let x = new Float64Array(size); // last committed solution

  // Merge per ref — parts can carry several controls (DHT temp + humidity).
  const controlState = new Map();
  for (const control of controls) {
    const state = controlState.get(control.ref) ?? {};
    state[control.name] = control.value;
    controlState.set(control.ref, state);
  }

  const NR_TYPES = new Set(['diode', 'bjt', 'mosfet', 'opamp']);
  const EVENT_TYPES = new Set(['comparator', 'timer_555', 'opto_out']);
  const nrDevices = devices.filter((device) => NR_TYPES.has(device.type));
  for (const device of nrDevices) {
    if (device.type === 'diode') {
      device.vdOld = 0;
      device.lastI = 0;
    } else if (device.type === 'bjt') {
      device.vbeOld = 0;
      device.vbcOld = 0;
      device.lastIc = 0;
      device.lastIb = 0;
    } else if (device.type === 'mosfet') {
      device.vgsOld = 0;
      device.vdsOld = 0;
      device.lastId = 0;
    } else {
      device.vdOld = 0; // opamp differential input
    }
  }
  const eventDevices = devices.filter((device) => EVENT_TYPES.has(device.type)
    || device.type === 'relay'
    || device.type === 'sensor_out'
    || device.type === 'sensor_source'
    || device.kind === 'fuse'
    || (device.type === 'vsource' && device.kind === 'regulator' && device.inNode != null));
  const diodeById = new Map(devices.filter((device) => device.type === 'diode').map((device) => [device.id, device]));
  for (const sensor of devices.filter((device) => device.type === 'sensor_out')) {
    sensor.shunt = devices.find((device) => device.id === sensor.shuntId) ?? null;
  }
  const buzzers = devices.filter((device) => device.kind === 'buzzer');
  for (const buzzer of buzzers) {
    buzzer.crossings = [];
    buzzer.lastV = 0;
  }
  const reactives = devices.filter((device) => device.type === 'capacitor' || device.type === 'inductor');
  for (const device of reactives) {
    device.vState = 0;
    device.iState = 0;
  }
  // LED-family diodes carry a persistence-of-vision current average so PWM
  // reads as dimming instead of 30 Hz-sampled flicker (τ = 30 ms).
  const ledDiodes = devices.filter((device) => device.type === 'diode'
    && (device.kind === 'led' || device.kind === 'rgb_led' || device.kind === 'seven_segment'));
  for (const led of ledDiodes) led.emaI = 0;

  // Firmware bridge: the avr8js runner steps in lockstep with the MNA
  // timestep; pin modes/levels are read before each solve and net voltages
  // fed back after it.
  const mcuPins = devices.filter((device) => device.type === 'mcu_pin');
  let mcuRunner = null;
  let serialBuffer = '';
  const peripheralsByOwner = new Map();
  if (mcuRef && mcuPins.length >= 0 && netlist.ok && options.mcu) {
    mcuRunner = createAvrRunner(options.mcu);
    mcuRunner.onSerialByte((byte) => {
      serialBuffer += String.fromCharCode(byte);
      if (serialBuffer.length > 4096) serialBuffer = serialBuffer.slice(-4096);
    });
    // Protocol modules attach at cycle resolution (listeners + clock events
    // fire inside mcuRunner.run() during the lockstep).
    for (const record of devices.filter((device) => device.type === 'avr_peripheral')) {
      const peripheral = createPeripheral(record, mcuRunner, controlState);
      if (peripheral) peripheralsByOwner.set(record.owner, peripheral);
    }
  }

  const isDynamic = reactives.length > 0
    || mcuRunner != null
    || devices.some((device) => device.type === 'vsource' && device.waveform.type !== 'dc');
  const h = chooseTimestep(devices);
  const mcuCyclesPerStep = Math.round(h * AVR_CLOCK_HZ);

  let time = 0;
  let dirty = true; // force an initial solve on the first advance()
  let lastConverged = false;
  let lastSpeed = 1;
  let lastIterations = 0;

  const stateFor = (device) => controlState.get(device.owner) ?? {};

  // True whenever the last stamp had to damp a junction voltage (pnjlim). NR
  // must not declare convergence then: node voltages can sit still for many
  // iterations while a diode's linearization point climbs toward conduction.
  let limitingActive = false;

  const stampAndSolve = (seed, { transient, gminExtra = 0, sourceScale = 1 }) => {
    limitingActive = false;
    clearMatrix(A);
    rhs.fill(0);
    for (let i = 0; i < nodeCount; i += 1) A[i][i] += GMIN + gminExtra;

    const stampConductance = (n1, n2, g) => {
      if (n1 !== GROUND) A[n1][n1] += g;
      if (n2 !== GROUND) A[n2][n2] += g;
      if (n1 !== GROUND && n2 !== GROUND) {
        A[n1][n2] -= g;
        A[n2][n1] -= g;
      }
    };
    const stampCurrent = (n1, n2, intoN1) => {
      if (n1 !== GROUND) rhs[n1] += intoN1;
      if (n2 !== GROUND) rhs[n2] -= intoN1;
    };
    // Voltage-controlled current source: g·(v(ctrlP) − v(ctrlM)) flows nOut→nIn.
    const stampVCCS = (nOut, nIn, ctrlP, ctrlM, g) => {
      if (nOut !== GROUND && ctrlP !== GROUND) A[nOut][ctrlP] += g;
      if (nOut !== GROUND && ctrlM !== GROUND) A[nOut][ctrlM] -= g;
      if (nIn !== GROUND && ctrlP !== GROUND) A[nIn][ctrlP] -= g;
      if (nIn !== GROUND && ctrlM !== GROUND) A[nIn][ctrlM] += g;
    };
    const at = (node) => (node === GROUND ? 0 : seed[node]);

    for (const device of devices) {
      switch (device.type) {
        case 'resistor': {
          // A blown fuse is an open circuit until the engine rebuilds
          // (Stop/Run or a circuit edit — the "replace the fuse" gesture).
          const ohms = device.state?.blown ? 1e9 : device.ohms;
          device.lastOhms = ohms;
          stampConductance(device.n1, device.n2, 1 / ohms);
          break;
        }
        case 'vres': {
          const ohms = variableOhms(device, stateFor(device));
          device.lastOhms = ohms;
          stampConductance(device.n1, device.n2, 1 / ohms);
          break;
        }
        case 'capacitor': {
          if (!transient) break; // open at DC (initial state builds from t=0)
          const g = device.farads / h;
          stampConductance(device.n1, device.n2, g);
          stampCurrent(device.n1, device.n2, g * device.vState);
          break;
        }
        case 'inductor': {
          if (!transient) {
            stampConductance(device.n1, device.n2, 1 / 1e-3); // DC short
            break;
          }
          const g = h / device.henries;
          stampConductance(device.n1, device.n2, g);
          stampCurrent(device.n1, device.n2, -device.iState);
          break;
        }
        case 'vsource': {
          const bi = nodeCount + device.branch;
          if (device.np !== GROUND) {
            A[device.np][bi] += 1;
            A[bi][device.np] += 1;
          }
          if (device.nm !== GROUND) {
            A[device.nm][bi] -= 1;
            A[bi][device.nm] -= 1;
          }
          // overrideVolts is the regulator-dropout event state.
          rhs[bi] = (device.overrideVolts ?? device.waveform.evaluate(time)) * sourceScale;
          break;
        }
        case 'bjt': {
          // Normalized NPN frame: PNP evaluates with negated junction voltages
          // and flips only the companion current sources (conductance and
          // VCCS stamps are polarity-invariant).
          const p = device.polarity;
          const vcrit = junctionCriticalVoltage(device.params.is, THERMAL_VOLTAGE);
          const rawVbe = p * (at(device.b) - at(device.e));
          const rawVbc = p * (at(device.b) - at(device.c));
          const vbe = limitJunction(rawVbe, device.vbeOld, THERMAL_VOLTAGE, vcrit);
          const vbc = limitJunction(rawVbc, device.vbcOld, THERMAL_VOLTAGE, vcrit);
          if (Math.abs(vbe - rawVbe) > 1e-9 || Math.abs(vbc - rawVbc) > 1e-9) limitingActive = true;
          device.vbeOld = vbe;
          device.vbcOld = vbc;
          const { iF, iR, ic, ib, gmf, gmr, gpi, gmu } = evalBjt(device.params, vbe, vbc);
          device.lastIc = p * ic;
          device.lastIb = p * ib;
          // Base-emitter junction: IF/bf flows b→e.
          const ibe = iF / device.params.bf;
          stampConductance(device.b, device.e, gpi);
          stampCurrent(device.b, device.e, -p * (ibe - gpi * vbe));
          // Base-collector junction: IR/br flows b→c.
          const ibc = iR / device.params.br;
          stampConductance(device.b, device.c, gmu);
          stampCurrent(device.b, device.c, -p * (ibc - gmu * vbc));
          // Transport current IF − IR flows c→e, controlled by vbe and vbc.
          const icc = iF - iR;
          stampVCCS(device.c, device.e, device.b, device.e, gmf);
          stampVCCS(device.c, device.e, device.b, device.c, -gmr);
          stampCurrent(device.c, device.e, -p * (icc - gmf * vbe + gmr * vbc));
          break;
        }
        case 'mosfet': {
          const p = device.polarity;
          // Symmetric device: operate on whichever terminal is the effective
          // source (normalized vds >= 0).
          let nd = device.d;
          let ns = device.s;
          if (p * (at(nd) - at(ns)) < 0) {
            nd = device.s;
            ns = device.d;
          }
          let vgs = p * (at(device.g) - at(ns));
          let vds = p * (at(nd) - at(ns));
          // No exponential to limit — just damp NR steps to stop region ping-pong.
          const dVgs = vgs - device.vgsOld;
          const dVds = vds - device.vdsOld;
          if (Math.abs(dVgs) > 2) {
            vgs = device.vgsOld + Math.sign(dVgs) * 2;
            limitingActive = true;
          }
          if (Math.abs(dVds) > 4) {
            vds = device.vdsOld + Math.sign(dVds) * 4;
            limitingActive = true;
          }
          device.vgsOld = vgs;
          device.vdsOld = vds;
          const { id, gm, gds } = evalMosfet(device.params, vgs, vds);
          device.lastId = p * (nd === device.d ? id : -id);
          stampVCCS(nd, ns, device.g, ns, gm);
          stampConductance(nd, ns, gds + GMIN);
          stampCurrent(nd, ns, -p * (id - gm * vgs - gds * vds));
          break;
        }
        case 'opamp': {
          const bi = nodeCount + device.branch;
          // Rails lag one iteration (near-constant, kept out of the Jacobian).
          const vhi = at(device.vcp) - 1.3;
          const vlo = at(device.vcm) + 0.1;
          const vswing = Math.max((vhi - vlo) / 2, 0.05);
          let vd = at(device.inp) - at(device.inn);
          const dVd = vd - device.vdOld;
          if (Math.abs(dVd) > vswing / 2) {
            vd = device.vdOld + Math.sign(dVd) * (vswing / 2);
            limitingActive = true;
          }
          device.vdOld = vd;
          const { e, dEdVd } = evalOpamp(vd, vhi, vlo);
          if (device.out !== GROUND) {
            A[device.out][bi] += 1;
            A[bi][device.out] += 1;
          }
          if (device.inp !== GROUND) A[bi][device.inp] -= dEdVd;
          if (device.inn !== GROUND) A[bi][device.inn] += dEdVd;
          rhs[bi] = e - dEdVd * vd;
          break;
        }
        case 'comparator':
          // Open-collector: 30 Ω to the V- pin when pulled low, 10 MΩ released.
          stampConductance(device.out, device.vcm, 1 / (device.state.low ? 30 : 10e6));
          break;
        case 'timer_555': {
          const bi = nodeCount + device.branch;
          const level = device.state.q ? Math.max(at(device.vcc) - 1.7, 0) : 0.1;
          if (device.out !== GROUND) {
            A[device.out][bi] += 1;
            A[bi][device.out] += 1;
          }
          if (device.gnd !== GROUND) {
            A[device.gnd][bi] -= 1;
            A[bi][device.gnd] -= 1;
          }
          rhs[bi] = level;
          stampConductance(device.disch, device.gnd, 1 / (device.state.q ? 10e6 : 25));
          break;
        }
        case 'opto_out':
          stampConductance(device.c, device.e, 1 / (device.state.on ? 30 : 10e6));
          break;
        case 'periph_pin': {
          // Display-only presence of a module-driven protocol pin (behind the
          // netlist's 1 kΩ resistor): tracks the peripheral's digital level.
          const bi = nodeCount + device.branch;
          const level = peripheralsByOwner.get(device.owner)?.level(device.pinName) ?? 0;
          if (device.int !== GROUND) {
            A[device.int][bi] += 1;
            A[bi][device.int] += 1;
          }
          rhs[bi] = level * 5;
          break;
        }
        case 'mcu_pin': {
          const bi = nodeCount + device.branch;
          if (device.mode === 'output') {
            // Branch drives the internal node (behind the 40 Ω __ro resistor)
            // at 0/5 V relative to global ground.
            if (device.int !== GROUND) {
              A[device.int][bi] += 1;
              A[bi][device.int] += 1;
            }
            rhs[bi] = device.level * 5;
          } else {
            // Input / pullup: pin floats — pin the unused branch variable to
            // zero current so allocation stays static and the matrix regular.
            A[bi][bi] = 1;
            rhs[bi] = 0;
            if (device.mode === 'pullup') {
              stampConductance(device.net, device.fiveV, 1 / 35e3);
            }
          }
          break;
        }
        case 'relay': {
          const energized = device.state.energized;
          stampConductance(device.com, device.no, 1 / (energized ? 0.05 : 10e6));
          stampConductance(device.com, device.nc, 1 / (energized ? 10e6 : 0.05));
          // Coil + module electronics load on the supply.
          stampConductance(device.vcc, device.gnd, 1 / (energized ? 70 : 10e3));
          break;
        }
        case 'sensor_out':
        case 'sensor_source': {
          const bi = nodeCount + device.branch;
          if (device.out !== GROUND) {
            A[device.out][bi] += 1;
            A[bi][device.out] += 1;
          }
          if (device.gnd !== GROUND) {
            A[device.gnd][bi] -= 1;
            A[bi][device.gnd] -= 1;
          }
          rhs[bi] = device.overrideVolts;
          break;
        }
        case 'diode': {
          const rawVd = at(device.anode) - at(device.cathode);
          const vd = limitDiode(device.model, rawVd, device.vdOld);
          if (Math.abs(vd - rawVd) > 1e-9) limitingActive = true;
          device.vdOld = vd;
          const { i, g } = evalDiode(device.model, vd);
          device.lastI = i;
          stampConductance(device.anode, device.cathode, g);
          stampCurrent(device.anode, device.cathode, -(i - g * vd));
          break;
        }
        default:
          break;
      }
    }
    const solution = solveDense(A, rhs.slice());
    return solution && allFinite(solution) ? solution : null;
  };

  // Newton-Raphson to convergence at the current `time`. Returns the solution
  // vector or null; mutates diode linearization state.
  const newtonSolve = (options) => {
    let iterate = x;
    const nonlinear = nrDevices.length > 0;
    for (let iteration = 1; iteration <= MAX_NR_ITERATIONS; iteration += 1) {
      const solution = stampAndSolve(iterate, options);
      if (!solution) return null;
      lastIterations = iteration;
      if (!nonlinear) return solution;
      let converged = !limitingActive;
      for (let i = 0; converged && i < size; i += 1) {
        if (Math.abs(solution[i] - iterate[i]) > ABS_TOL + REL_TOL * Math.abs(solution[i])) {
          converged = false;
        }
      }
      iterate = solution;
      if (converged && iteration > 1) return solution;
    }
    return null;
  };

  // DC solve with gmin stepping then source stepping as fallbacks.
  const robustSolve = (options) => {
    let solution = newtonSolve(options);
    if (solution) return solution;
    for (const gminExtra of GMIN_STEPS) {
      solution = newtonSolve({ ...options, gminExtra });
      if (solution) x = solution; // seed the next, tighter stage
    }
    solution = newtonSolve(options);
    if (solution) return solution;
    for (const sourceScale of SOURCE_STEPS) {
      const stepped = newtonSolve({ ...options, sourceScale });
      if (stepped) {
        x = stepped;
        solution = stepped;
      }
    }
    return solution && newtonSolve(options);
  };

  const commitReactiveStates = (solution) => {
    const at = (node) => (node === GROUND ? 0 : solution[node]);
    for (const device of reactives) {
      const v = at(device.n1) - at(device.n2);
      if (device.type === 'capacitor') device.vState = v;
      else device.iState += (h / device.henries) * v;
      device.lastV = v;
    }
  };

  const solveDCOnce = () => {
    const solution = robustSolve({ transient: false });
    if (solution) {
      x = solution;
      // No PWM at DC: the perceived brightness IS the instantaneous current.
      for (const led of ledDiodes) led.emaI = led.lastI;
      lastConverged = true;
    } else {
      lastConverged = false;
    }
    return lastConverged;
  };

  // Event devices (comparator, 555 latch, opto switch, regulator dropout)
  // update from the committed solution — between timesteps in transient, and
  // in a bounded settle loop for DC solves. Returns true when a state flipped.
  const atX = (node) => (node === GROUND ? 0 : x[node]);
  const updateEvents = (mode = 'transient') => {
    let changed = false;
    for (const device of eventDevices) {
      if (device.kind === 'fuse') {
        // i²t approximation: sustained current above 2× the rating opens the
        // fuse — instantly at DC (a steady overload would blow within the
        // window anyway), after 10 ms sustained in transient. One-way state.
        if (device.state.blown) continue;
        const amps = Math.abs((atX(device.n1) - atX(device.n2)) / device.lastOhms);
        if (amps > 2 * device.ratingAmps) {
          if (mode === 'dc') {
            device.state.blown = true;
            changed = true;
          } else {
            device.state.overSince ??= time;
            if (time - device.state.overSince > 0.01) {
              device.state.blown = true;
              changed = true;
            }
          }
        } else {
          device.state.overSince = null;
        }
      } else if (device.type === 'relay') {
        // Hysteresis (2.5 V on / 2.2 V off, supply 4 V / 3.5 V) stops chatter
        // when the relay's own contact feeds back into IN.
        const supply = atX(device.vcc) - atX(device.gnd);
        const drive = atX(device.in) - atX(device.gnd);
        const energized = device.state.energized
          ? supply > 3.5 && drive > 2.2
          : supply > 4 && drive > 2.5;
        if (energized !== device.state.energized) {
          device.state.energized = energized;
          changed = true;
        }
      } else if (device.type === 'sensor_out') {
        // ACS712: OUT = 2.5 V + 185 mV/A of shunt current.
        const shunt = device.shunt;
        const amps = shunt ? (atX(shunt.n1) - atX(shunt.n2)) / shunt.lastOhms : 0;
        const next = 2.5 + 0.185 * amps;
        if (Math.abs(device.overrideVolts - next) > 1e-3) {
          device.overrideVolts = next;
          changed = true;
        }
      } else if (device.type === 'sensor_source') {
        // Tier-2a stimulus-driven sensors: output law from the control value,
        // gated on the module being powered.
        const supply = atX(device.vcc) - atX(device.gnd);
        const powered = supply > 2.5;
        const stimulus = controlState.get(device.owner)?.[device.stimulusName] ?? 0;
        let next = 0;
        if (powered) {
          if (device.law === 'tmp36') next = 0.5 + 0.01 * stimulus;
          else if (device.law === 'pir') next = stimulus ? 3.3 : 0.05;
          else if (device.law === 'soil') next = 2.8 - 1.6 * stimulus;
          else if (device.law === 'module_ao') next = 0.4 + 3.6 * stimulus;
          else if (device.law === 'module_do') next = stimulus > 0.5 ? 0.1 : supply;
        }
        if (Math.abs(device.overrideVolts - next) > 1e-3) {
          device.overrideVolts = next;
          changed = true;
        }
      } else if (device.type === 'comparator') {
        // ±5 mV hysteresis prevents chatter at the trip point.
        const vd = atX(device.inp) - atX(device.inn);
        const low = device.state.low ? !(vd > 0.005) : vd < -0.005;
        if (low !== device.state.low) {
          device.state.low = low;
          changed = true;
        }
      } else if (device.type === 'timer_555') {
        const ctrl = atX(device.ctrl);
        let q = device.state.q;
        if (device.resetConnected && atX(device.reset) < 0.7) q = false;
        else if (atX(device.trig) < ctrl / 2) q = true; // trigger dominates
        else if (atX(device.thres) > ctrl) q = false;
        if (q !== device.state.q) {
          device.state.q = q;
          changed = true;
        }
      } else if (device.type === 'opto_out') {
        // PC817 SW hysteresis: VT=1.1 VH=0.15 on the LED junction voltage.
        const led = diodeById.get(device.ledId);
        const vd = led ? led.vdOld : 0;
        const on = device.state.on ? vd > 1.025 : vd > 1.175;
        if (on !== device.state.on) {
          device.state.on = on;
          changed = true;
        }
      } else {
        // Regulator dropout: output tracks min(vnom, vIN − 1.5), never negative.
        const next = Math.min(device.vnom, Math.max(0, atX(device.inNode) - 1.5));
        if (Math.abs((device.overrideVolts ?? device.vnom) - next) > 1e-3) {
          device.overrideVolts = next;
          changed = true;
        }
      }
    }
    return changed;
  };

  const solveDC = () => {
    let ok = solveDCOnce();
    // Settle event states; a genuine bistable that never settles keeps its
    // last consistent latch state (still a valid answer).
    for (let round = 0; round < 10 && updateEvents('dc'); round += 1) {
      ok = solveDCOnce();
    }
    return ok;
  };

  const stepOnce = () => {
    time += h;
    if (mcuRunner) {
      // Lockstep: run the firmware for this timestep's worth of cycles, then
      // latch each bridged pin's mode/level for the solve below.
      mcuRunner.run(mcuCyclesPerStep);
      for (const pin of mcuPins) {
        const state = mcuRunner.pinState(pin.unoPin);
        pin.mode = state.mode;
        pin.level = state.high ? 1 : 0;
      }
    }
    const solution = newtonSolve({ transient: true }) ?? robustSolve({ transient: true });
    if (solution) {
      x = solution;
      commitReactiveStates(solution);
      for (const led of ledDiodes) {
        led.emaI += (led.lastI - led.emaI) * (h / 0.03);
      }
      if (mcuRunner) {
        // Feed the solved net voltages back: digital reads and ADC channels
        // see the circuit one step later (the event-device pattern).
        for (const pin of mcuPins) {
          const volts = atX(pin.net);
          if (pin.mode !== 'output') mcuRunner.setDigitalInput(pin.unoPin, volts > 2.5);
          if (pin.adcChannel != null) {
            mcuRunner.setAnalogVolts(pin.adcChannel, Math.min(5, Math.max(0, volts)));
          }
        }
      }
      // Buzzer frequency detection: rising crossings of 1 V, sim-timestamped.
      for (const buzzer of buzzers) {
        const v = atX(buzzer.n1) - atX(buzzer.n2);
        if (buzzer.lastV <= 1 && v > 1) {
          buzzer.crossings.push(time);
          if (buzzer.crossings.length > 8) buzzer.crossings.shift();
        } else if (buzzer.crossings.length > 0 && time - buzzer.crossings.at(-1) > 0.05) {
          buzzer.crossings.length = 0; // tone stopped — drop the stale estimate
        }
        buzzer.lastV = v;
      }
      updateEvents(); // states take effect next step (≤ one h of lag)
      lastConverged = true;
    } else {
      lastConverged = false; // keep last good state, keep moving
    }
  };

  const advance = (wallDt, budgetMs = 4) => {
    if (!isDynamic) {
      if (dirty) {
        solveDC();
        dirty = false;
      }
      lastSpeed = 1;
      return { advanced: wallDt, speed: 1, converged: lastConverged };
    }
    if (dirty) dirty = false;
    const clampedDt = Math.min(Math.max(wallDt, 0), MAX_WALL_DT);
    const targetSteps = Math.floor(clampedDt / h);
    const start = now();
    let done = 0;
    while (done < targetSteps) {
      stepOnce();
      done += 1;
      if ((done & 15) === 0 && now() - start > budgetMs) break;
    }
    lastSpeed = targetSteps > 0 ? done / targetSteps : 1;
    return { advanced: done * h, speed: lastSpeed, converged: lastConverged };
  };

  const setControl = (ref, name, value) => {
    const state = controlState.get(ref);
    if (!state) return;
    state[name] = value;
    const control = controls.find((entry) => entry.ref === ref && entry.name === name);
    if (control) control.value = value;
    // Peripherals treat stepper/button controls as events (quadrature pulses,
    // switch presses), not persistent state.
    peripheralsByOwner.get(ref)?.onControl?.(name, value);
    dirty = true;
  };

  const probe = () => {
    const netVoltages = new Map([['0', 0]]);
    for (const [net, index] of nodeIndex) {
      if (!net.startsWith('__int_')) netVoltages.set(net, x[index]);
    }
    const at = (node) => (node === GROUND ? 0 : x[node]);
    const branchCurrents = new Map();
    for (const device of devices) {
      if (device.type === 'vsource') branchCurrents.set(device.id, x[nodeCount + device.branch]);
      else if (device.type === 'diode') branchCurrents.set(device.id, device.lastI);
      else if (device.type === 'resistor' || device.type === 'vres') {
        branchCurrents.set(device.id, (at(device.n1) - at(device.n2)) / device.lastOhms);
      } else if (device.type === 'inductor') branchCurrents.set(device.id, device.iState);
      else if (device.type === 'capacitor') branchCurrents.set(device.id, 0);
      else if (device.type === 'bjt') branchCurrents.set(device.id, device.lastIc);
      else if (device.type === 'mosfet') branchCurrents.set(device.id, device.lastId);
      else if (device.type === 'opamp' || device.type === 'timer_555') {
        branchCurrents.set(device.id, x[nodeCount + device.branch]);
      }
    }
    return { netVoltages, branchCurrents };
  };

  const engine = {
    ok: true,
    error: null,
    warnings,
    controls,
    isDynamic,
    h,
    get time() {
      return time;
    },
    advance,
    solveDC,
    setControl,
    probe,
    observables: () => {
      const observables = observablesFor(netlist, probe(), controlState);
      for (const [owner, peripheral] of peripheralsByOwner) {
        observables.set(owner, { ...(observables.get(owner) ?? {}), ...peripheral.observe() });
      }
      return observables;
    },
    status: () => ({ converged: lastConverged, lastSpeed, iterations: lastIterations }),
    mcuRunner,
    serialText: () => serialBuffer,
  };
  return engine;
};
