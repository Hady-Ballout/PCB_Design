// Device physics for the interactive simulator: variable-resistor laws for
// the user-controllable parts, and the diode junction model (exponential with
// SPICE-style pnjlim limiting) used by every diode-family kind.

export const THERMAL_VOLTAGE = 0.025852; // kT/q at ~27°C, matching SPICE

const CLOSED_OHMS = 0.05; // floor for "closed contact" resistances
const OPEN_OHMS = 10e6; // matches the 10Meg open switch in toSpice

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// Resolve a variable resistor's ohms from its control state. `state` is the
// per-part control-value object maintained by the engine, e.g. {pressed: 1}.
export const variableOhms = (device, state = {}) => {
  switch (device.model) {
    case 'pushbutton':
      return state.pressed ? CLOSED_OHMS : OPEN_OHMS;
    case 'switch_throw':
      return (state.position ?? 'A') === device.params.throw ? CLOSED_OHMS : OPEN_OHMS;
    case 'pot_upper': {
      const alpha = clamp(state.wiper ?? 0.5, 0.005, 0.995);
      return device.params.total * alpha;
    }
    case 'pot_lower': {
      const alpha = clamp(state.wiper ?? 0.5, 0.005, 0.995);
      return device.params.total * (1 - alpha);
    }
    case 'photoresistor': {
      // Dark ≈ 1 MΩ, bright sun ≈ 200 Ω, log-interpolated. Default 0.55 ≈ 10 kΩ.
      const light = clamp(state.light ?? 0.55, 0, 1);
      return 10 ** (Math.log10(1e6) + (Math.log10(200) - Math.log10(1e6)) * light);
    }
    case 'thermistor': {
      // NTC beta model around 25°C.
      const tempC = state.tempC ?? 25;
      const kelvin = tempC + 273.15;
      return device.params.r25 * Math.exp(3950 * (1 / kelvin - 1 / 298.15));
    }
    default:
      return OPEN_OHMS;
  }
};

// SPICE pnjlim: damp NR steps on an exponential junction so exp() never runs
// away. vte = n·VT for the junction.
export const limitJunction = (vnew, vold, vte, vcrit) => {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vte) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vte;
      return arg > 0 ? vold + vte * Math.log(arg) : vcrit;
    }
    return vte * Math.log(vnew / vte);
  }
  return vnew;
};

export const junctionCriticalVoltage = (is, vte) => vte * Math.log(vte / (Math.SQRT2 * is));

const GMIN_DEVICE = 1e-12;
const MAX_EXP_ARG = 80; // exp(80) ≈ 5.5e34 — huge but far from float64 overflow

const safeExp = (arg) => Math.exp(Math.min(arg, MAX_EXP_ARG));

// Evaluate the junction at voltage vd → {i, g} for the NR companion.
// Forward: exponential with emission coefficient n. Optional reverse
// breakdown (zener / LED BV) as a mirrored exponential at -bv.
export const evalDiode = (model, vd) => {
  const vte = model.n * THERMAL_VOLTAGE;
  const expTerm = safeExp(vd / vte);
  let i = model.is * (expTerm - 1) + GMIN_DEVICE * vd;
  let g = (model.is / vte) * expTerm + GMIN_DEVICE;
  if (model.bv) {
    const ibv = model.ibv ?? 1e-6;
    const revExp = safeExp(-(vd + model.bv) / THERMAL_VOLTAGE);
    i -= ibv * revExp;
    g += (ibv / THERMAL_VOLTAGE) * revExp;
  }
  return { i, g };
};

// Limit a diode's NR iterate. Forward conduction limits against vcrit; deep
// reverse (breakdown) limits the mirrored junction the same way.
export const limitDiode = (model, vnew, vold) => {
  const vte = model.n * THERMAL_VOLTAGE;
  const vcrit = junctionCriticalVoltage(model.is, vte);
  if (model.bv && vnew < -model.bv / 2 && vold < -model.bv / 2) {
    const znew = -(vnew + model.bv);
    const zold = -(vold + model.bv);
    const zcrit = junctionCriticalVoltage(model.ibv ?? 1e-6, THERMAL_VOLTAGE);
    return -limitJunction(znew, zold, THERMAL_VOLTAGE, zcrit) - model.bv;
  }
  return limitJunction(vnew, vold, vte, vcrit);
};
