// Interactive circuit simulation engine: modified nodal analysis with
// Newton-Raphson for the diode family and backward-Euler transient for
// capacitors/inductors. Pure JS, no dependencies, small dense matrices.

import { clearMatrix, makeMatrix, solveDense } from './linalg.js';
import { buildSimNetlist, GROUND } from './simNetlist.js';
import { evalDiode, limitDiode, variableOhms } from './simDevices.js';
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

export const createSimulation = (circuit) => {
  const netlist = buildSimNetlist(circuit);
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

  const controlState = new Map(controls.map((control) => [control.ref, { [control.name]: control.value }]));

  const diodes = devices.filter((device) => device.type === 'diode');
  for (const diode of diodes) {
    diode.vdOld = 0;
    diode.lastI = 0;
  }
  const reactives = devices.filter((device) => device.type === 'capacitor' || device.type === 'inductor');
  for (const device of reactives) {
    device.vState = 0;
    device.iState = 0;
  }
  const isDynamic = reactives.length > 0
    || devices.some((device) => device.type === 'vsource' && device.waveform.type !== 'dc');
  const h = chooseTimestep(devices);

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
    const at = (node) => (node === GROUND ? 0 : seed[node]);

    for (const device of devices) {
      switch (device.type) {
        case 'resistor':
          device.lastOhms = device.ohms;
          stampConductance(device.n1, device.n2, 1 / device.ohms);
          break;
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
          rhs[bi] = device.waveform.evaluate(time) * sourceScale;
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
    const nonlinear = diodes.length > 0;
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

  const solveDC = () => {
    const solution = robustSolve({ transient: false });
    if (solution) {
      x = solution;
      lastConverged = true;
    } else {
      lastConverged = false;
    }
    return lastConverged;
  };

  const stepOnce = () => {
    time += h;
    const solution = newtonSolve({ transient: true }) ?? robustSolve({ transient: true });
    if (solution) {
      x = solution;
      commitReactiveStates(solution);
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
    observables: () => observablesFor(netlist, probe(), controlState),
    status: () => ({ converged: lastConverged, lastSpeed, iterations: lastIterations }),
  };
  return engine;
};
