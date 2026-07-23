// Unified component-value parsing for the interactive simulator. The rest of
// the codebase has three partial parsers with conflicting suffix conventions
// (resistors treat a bare "m" as MEG, capacitors as milli); the engine owns
// one unambiguous module and imports nothing from feature chunks.

const firstNumber = (text) => {
  const match = String(text ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

// "2k2" / "4R7" / "1M5" infix style → "2.2k" / "4.7" / "1.5M".
const normalizeInfix = (text) => text.replace(/^(\d+)(r|k|m|g)(\d+)$/i, (_, whole, unit, frac) =>
  `${whole}.${frac}${unit.toLowerCase() === 'r' ? '' : unit}`);

// Resistor convention: bare "m"/"M" means MEG (nobody specs milliohm resistors
// by suffix), matching parseResistance in topologyRules.js and ngspice decks
// the app already emits.
export const parseOhms = (value, fallback = null) => {
  let text = String(value ?? '').trim().replace(/(?:Ω|ohms?)\s*$/i, '').trim();
  text = normalizeInfix(text.replace(/\s+/g, ''));
  const match = text.match(/^(\d+(?:\.\d+)?)(meg|k|m|g|r)?$/i);
  if (!match) return fallback;
  const magnitude = Number(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  const scale = suffix === 'g' ? 1e9 : suffix === 'meg' || suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return magnitude * scale;
};

// Capacitor convention: bare numbers are microfarads ("100" on an electrolytic
// means 100 µF), matching capStyle in partVisuals.js.
export const parseFarads = (value, fallback = null) => {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)(p|n|u|µ|m)?f?$/i);
  if (!match) return fallback;
  const magnitude = Number(match[1]);
  const suffix = (match[2] || 'u').toLowerCase();
  const scale = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3 }[suffix];
  return magnitude * scale;
};

export const parseHenries = (value, fallback = null) => {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)(p|n|u|µ|m)?h?$/i);
  if (!match) return fallback;
  const magnitude = Number(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  const scale = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, '': 1 }[suffix];
  return magnitude * scale;
};

export const parseVolts = (value, fallback = null) => {
  const number = firstNumber(String(value ?? '').replace(/v(?:olts?)?\s*$/i, ''));
  return number ?? fallback;
};

export const parseAmps = (value, fallback = null) => {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)(m|u|µ)?a?$/i);
  if (!match) return fallback;
  const magnitude = Number(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  const scale = { m: 1e-3, u: 1e-6, 'µ': 1e-6, '': 1 }[suffix];
  return magnitude * scale;
};

// Mirrors regulatorVoltage in pcbGenerator.js so the live sim and the SPICE
// deck agree on what a "7805" puts out.
export const regulatorVolts = (value) => {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('7805')) return 5;
  if (text.includes('7812')) return 12;
  if (text.includes('7905')) return -5;
  return firstNumber(text) ?? 5;
};

export const zenerVolts = (value) => firstNumber(value) ?? 5.1;

// Mirrors buckVoltage in pcbGenerator.js so the live sim and the SPICE deck
// agree on what an "LM2596-5.0" puts out. The part number is stripped first
// so its digits ("2596") never get mistaken for the output voltage.
export const buckVolts = (value) => {
  const text = String(value ?? '').toLowerCase().replace(/lm25\d\d[a-z]*/g, '');
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 5;
};

// SPICE numeric literal inside SINE(...)/PULSE(...) argument lists: standard
// SI suffixes where "m" IS milli (SPICE convention, unlike resistor values).
const parseSpiceNumber = (token) => {
  const match = String(token ?? '').trim().match(/^(-?\d+(?:\.\d+)?)(meg|g|k|m|u|µ|n|p|f)?[a-z]*$/i);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  const scale = { meg: 1e6, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, '': 1 }[suffix];
  return Number(match[1]) * scale;
};

const sineWaveform = (args) => {
  const [voff = 0, vamp = 5, freq = 1000, delay = 0, damping = 0] = args;
  return {
    type: 'sine',
    voff,
    vamp,
    freq,
    maxFrequency: freq,
    evaluate: (t) => {
      if (t < delay) return voff;
      const decay = damping > 0 ? Math.exp(-(t - delay) * damping) : 1;
      return voff + vamp * decay * Math.sin(2 * Math.PI * freq * (t - delay));
    },
  };
};

const pulseWaveform = (args) => {
  const [v1 = 0, v2 = 5, td = 0, trRaw = 0, tfRaw = 0, pwRaw = 0, perRaw = 0] = args;
  const tr = trRaw > 0 ? trRaw : 1e-9;
  const tf = tfRaw > 0 ? tfRaw : 1e-9;
  const pw = pwRaw > 0 ? pwRaw : 1e-3;
  const per = perRaw > 0 ? perRaw : tr + pw + tf + pw;
  return {
    type: 'pulse',
    v1,
    v2,
    td,
    tr,
    tf,
    pw,
    per,
    maxFrequency: 1 / per,
    evaluate: (t) => {
      if (t < td) return v1;
      const phase = (t - td) % per;
      if (phase < tr) return v1 + ((v2 - v1) * phase) / tr;
      if (phase < tr + pw) return v2;
      if (phase < tr + pw + tf) return v2 - ((v2 - v1) * (phase - tr - pw)) / tf;
      return v1;
    },
  };
};

const dcWaveform = (volts, warning = null) => ({
  type: 'dc',
  volts,
  maxFrequency: 0,
  evaluate: () => volts,
  ...(warning ? { warning } : {}),
});

// signal_source values pass to ngspice verbatim today ("SINE(0 5 1k)",
// "PULSE(0 5 0 1u 1u 1m 2m)", "DC 5", "5V"); accept the same grammar here.
export const parseSourceWaveform = (value) => {
  const text = String(value ?? '').trim();
  const call = text.match(/^(sine?|pulse)\s*\(([^)]*)\)/i);
  if (call) {
    const args = call[2].split(/[\s,]+/).filter(Boolean).map(parseSpiceNumber);
    if (args.some((arg) => arg === null)) {
      return dcWaveform(0, `Could not parse source value "${text}"`);
    }
    return /^pulse$/i.test(call[1]) ? pulseWaveform(args) : sineWaveform(args);
  }
  const dcMatch = text.match(/^(?:dc\s+)?(-?\d+(?:\.\d+)?)\s*v?$/i);
  if (dcMatch) return dcWaveform(Number(dcMatch[1]));
  const fallbackNumber = firstNumber(text);
  if (fallbackNumber !== null) return dcWaveform(fallbackNumber);
  return dcWaveform(0, `Could not parse source value "${text}"`);
};
