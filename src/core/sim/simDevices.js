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

// Ebers-Moll BJT (DC Gummel-Poon without Early effect — the toSpice models
// carry VAF but omitting it costs little accuracy at breadboard scale and
// keeps the Jacobian simpler). NPN voltage convention; PNP callers negate the
// junction voltages in and the terminal currents out (device `polarity`).
export const evalBjt = ({ is, bf, br }, vbe, vbc) => {
  const expBe = Math.exp(Math.min(vbe / THERMAL_VOLTAGE, MAX_EXP_ARG));
  const expBc = Math.exp(Math.min(vbc / THERMAL_VOLTAGE, MAX_EXP_ARG));
  const forward = is * (expBe - 1);
  const reverse = is * (expBc - 1);
  const gmf = (is / THERMAL_VOLTAGE) * expBe + GMIN_DEVICE;
  const gmr = (is / THERMAL_VOLTAGE) * expBc + GMIN_DEVICE;
  return {
    iF: forward,
    iR: reverse,
    ic: forward - reverse * (1 + 1 / br),
    ib: forward / bf + reverse / br,
    gmf,
    gmr,
    gpi: gmf / bf,
    gmu: gmr / br,
  };
};

// Level-1 MOSFET (Shichman-Hodges). Caller guarantees vds >= 0 (swap D/S for
// the reverse region — the device is symmetric) and handles PMOS polarity.
// lambda is a small deliberate channel-length modulation so the drain node's
// Jacobian never goes singular in saturation (toSpice's models carry none).
export const evalMosfet = ({ kp, vto, lambda }, vgs, vds) => {
  const vov = vgs - vto;
  if (vov <= 0) return { id: 0, gm: 0, gds: 0 };
  const clm = 1 + lambda * vds;
  if (vds < vov) {
    const id = kp * (vov * vds - (vds * vds) / 2) * clm;
    return {
      id,
      gm: kp * vds * clm,
      gds: kp * (vov - vds) * clm + (lambda * id) / clm,
    };
  }
  const idSat = (kp / 2) * vov * vov;
  return {
    id: idSat * clm,
    gm: kp * vov * clm,
    gds: lambda * idSat,
  };
};

// Behavioral opamp output law: a VCVS with smooth tanh saturation between the
// supply rails (LM358-ish headroom). vswing is floored so unpowered rails pin
// the output near 0 V instead of dividing by zero.
export const OPAMP_GAIN = 1e5;

export const evalOpamp = (vd, vhi, vlo) => {
  const vmid = (vhi + vlo) / 2;
  const vswing = Math.max((vhi - vlo) / 2, 0.05);
  const arg = (OPAMP_GAIN * vd) / vswing;
  const t = Math.tanh(Math.max(-30, Math.min(30, arg)));
  return {
    e: vmid + vswing * t,
    dEdVd: OPAMP_GAIN * (1 - t * t) + 1e-6, // floor keeps the branch row nonsingular deep in saturation
  };
};
