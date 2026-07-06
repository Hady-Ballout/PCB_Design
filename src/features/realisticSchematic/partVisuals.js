// Pure value-parsing heuristics that drive the realistic part artwork
// (resistor color bands, capacitor package style, LED lens color).
// No React imports so it stays unit-testable.

export const BAND_COLOR_HEX = {
  black: '#1c1c1c',
  brown: '#6b3f22',
  red: '#c0392b',
  orange: '#e67e22',
  yellow: '#f1c40f',
  green: '#2e8b57',
  blue: '#2465b0',
  violet: '#7d3fbf',
  gray: '#9aa0a6',
  white: '#f2f2f2',
  gold: '#c9a227',
  silver: '#c0c0c0',
};

const DIGIT_COLOR_NAMES = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray', 'white'];

const RESISTANCE_MULTIPLIERS = { r: 1, k: 1e3, m: 1e6, meg: 1e6, g: 1e9 };

// Accepts "220", "4.7k", "1M", "470R", "2k2"-style, optional trailing ohm/Ω.
export function parseResistance(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/(?:Ω|ohms?)\s*$/i, '')
    .trim();
  if (!text) return null;
  const infix = text.match(/^(\d+)(k|m|meg|g|r)(\d+)$/i);
  if (infix) {
    const number = Number(`${infix[1]}.${infix[3]}`);
    return number * RESISTANCE_MULTIPLIERS[infix[2].toLowerCase()];
  }
  const plain = text.match(/^(\d+(?:\.\d+)?)\s*(k|m|meg|g|r)?$/i);
  if (!plain) return null;
  const multiplier = plain[2] ? RESISTANCE_MULTIPLIERS[plain[2].toLowerCase()] : 1;
  return Number(plain[1]) * multiplier;
}

// 4-band code: two significant digits, a decade multiplier, and a gold
// tolerance band. Returns null when the value cannot be parsed so callers can
// fall back to a printed label.
export function resistorColorBands(value) {
  const ohms = parseResistance(value);
  if (!Number.isFinite(ohms) || ohms <= 0) return null;
  let exponent = Math.floor(Math.log10(ohms));
  let significand = Math.round(ohms / 10 ** (exponent - 1));
  if (significand >= 100) {
    significand = Math.round(significand / 10);
    exponent += 1;
  }
  const multiplierExponent = exponent - 1;
  const multiplier =
    multiplierExponent === -1 ? 'gold'
    : multiplierExponent === -2 ? 'silver'
    : DIGIT_COLOR_NAMES[multiplierExponent];
  if (!multiplier) return null;
  return {
    bands: [DIGIT_COLOR_NAMES[Math.floor(significand / 10)], DIGIT_COLOR_NAMES[significand % 10], multiplier, 'gold'],
    ohms,
  };
}

const CAPACITANCE_MULTIPLIERS = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3 };

// Accepts "100nF", "10u", "0.1uF", "4u7"-style. Values of 1µF and up render as
// electrolytic cans; smaller (or unparsable) values render as ceramic discs.
export function capStyle(value) {
  const text = String(value ?? '').trim().replace(/F\s*$/i, '');
  let farads = null;
  const infix = text.match(/^(\d+)(p|n|u|µ|m)(\d+)$/i);
  const plain = text.match(/^(\d+(?:\.\d+)?)\s*(p|n|u|µ|m)?$/i);
  if (infix) {
    farads = Number(`${infix[1]}.${infix[3]}`) * CAPACITANCE_MULTIPLIERS[infix[2].toLowerCase()];
  } else if (plain) {
    farads = Number(plain[1]) * (plain[2] ? CAPACITANCE_MULTIPLIERS[plain[2].toLowerCase()] : 1);
  }
  if (!Number.isFinite(farads)) return { type: 'ceramic', farads: null };
  return { type: farads >= 1e-6 ? 'electrolytic' : 'ceramic', farads };
}

const LED_COLORS = {
  red: '#e0453a',
  green: '#3dcc6d',
  blue: '#3f8fe8',
  yellow: '#f4d03f',
  white: '#f5f5ef',
  amber: '#f0a132',
  orange: '#ee7a2f',
};

export function ledColor(value) {
  const text = String(value ?? '').toLowerCase();
  const name = Object.keys(LED_COLORS).find((color) => text.includes(color)) || 'red';
  return { name, fill: LED_COLORS[name] };
}
