// Maps raw engine probe data to per-part visual observables the breadboard
// renderers consume (LED brightness, segment lighting, live volts/amps).

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Perceptual LED brightness: 0 below 0.1 mA, 1 at 15 mA, log-scaled between.
export const ledBrightness = (amps) => {
  if (!(amps > 1e-4)) return 0;
  return clamp01(Math.log10(amps / 1e-4) / Math.log10(0.015 / 1e-4));
};

const SI_STEPS = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

export const formatSI = (value, unit) => {
  if (!Number.isFinite(value)) return `—${unit}`;
  const magnitude = Math.abs(value);
  if (magnitude < 1e-13) return `0${unit}`;
  const [scale, prefix] = SI_STEPS.find(([step]) => magnitude >= step) ?? SI_STEPS.at(-1);
  const scaled = value / scale;
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}${prefix}${unit}`;
};

const RESISTIVE_KINDS = new Set([
  'resistor', 'load', 'buzzer', 'dc_motor', 'vibration_motor', 'fuse',
  'photoresistor', 'thermistor', 'current_sensor',
]);

export const observablesFor = (netlist, probe, controlState = new Map()) => {
  const { devices } = netlist;
  const { netVoltages, branchCurrents } = probe;
  const observables = new Map();
  const voltageAt = (index) => {
    if (index === -1) return 0;
    for (const [net, nodeIdx] of netlist.nodeIndex) {
      if (nodeIdx === index) return netVoltages.get(net) ?? 0;
    }
    return 0;
  };

  const entryFor = (owner) => {
    if (!observables.has(owner)) observables.set(owner, {});
    return observables.get(owner);
  };

  for (const device of devices) {
    if (device.kind === 'diode_rs') continue;
    const entry = entryFor(device.owner);
    switch (device.type) {
      case 'diode': {
        const amps = branchCurrents.get(device.id) ?? 0;
        if (device.kind === 'rgb_led') {
          entry.channels = entry.channels ?? {};
          entry.channels[device.channel] = { amps, brightness: ledBrightness(amps) };
        } else if (device.kind === 'seven_segment') {
          entry.segments = entry.segments ?? {};
          entry.segments[device.channel] = { amps, brightness: ledBrightness(amps) };
        } else {
          entry.amps = amps;
          if (device.kind === 'led') entry.brightness = ledBrightness(amps);
        }
        break;
      }
      case 'resistor':
      case 'vres': {
        if (!RESISTIVE_KINDS.has(device.kind) && device.kind !== 'potentiometer' && device.kind !== 'pushbutton' && device.kind !== 'switch_spdt') break;
        const amps = branchCurrents.get(device.id) ?? 0;
        const volts = amps * (device.lastOhms ?? 0);
        // Compound kinds (pot halves, switch throws) keep the largest-signal leg.
        if (entry.amps === undefined || Math.abs(amps) > Math.abs(entry.amps)) {
          entry.amps = amps;
          entry.volts = volts;
          entry.ohms = device.lastOhms;
        }
        if (device.kind === 'buzzer') {
          const crossings = device.crossings ?? [];
          entry.freqHz = crossings.length >= 3
            ? (crossings.length - 1) / (crossings.at(-1) - crossings[0])
            : null;
        }
        if (device.kind === 'dc_motor' || device.kind === 'vibration_motor') {
          // Rated voltage by convention (the value field carries winding ohms).
          const rated = device.kind === 'dc_motor' ? 6 : 3;
          entry.speed01 = clamp01(Math.abs(volts) / rated);
        }
        break;
      }
      case 'bjt':
        entry.amps = branchCurrents.get(device.id) ?? 0; // collector current
        break;
      case 'mosfet':
        entry.amps = branchCurrents.get(device.id) ?? 0; // drain current
        break;
      case 'opamp':
        entry.volts = voltageAt(device.out);
        entry.amps = branchCurrents.get(device.id) ?? 0;
        break;
      case 'comparator':
        entry.volts = voltageAt(device.out);
        entry.low = device.state?.low ?? false;
        break;
      case 'timer_555':
        entry.volts = voltageAt(device.out);
        entry.outHigh = device.state?.q ?? false;
        break;
      case 'opto_out':
        entry.on = device.state?.on ?? false;
        break;
      case 'vsource': {
        const branchAmps = branchCurrents.get(device.id) ?? 0;
        entry.amps = -branchAmps; // positive = delivering current
        entry.volts = voltageAt(device.np) - voltageAt(device.nm);
        break;
      }
      case 'capacitor':
        entry.volts = device.vState ?? 0;
        break;
      case 'inductor':
        entry.amps = device.iState ?? 0;
        break;
      default:
        break;
    }
  }

  // Echo interactive control state so renderers can draw pressed/thrown/wiper.
  for (const [ref, state] of controlState) {
    Object.assign(entryFor(ref), state);
  }

  return observables;
};
