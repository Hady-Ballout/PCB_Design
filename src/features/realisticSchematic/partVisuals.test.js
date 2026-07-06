import { describe, expect, it } from 'vitest';
import { capStyle, ledColor, parseResistance, resistorColorBands } from './partVisuals.js';

describe('resistorColorBands', () => {
  it('computes standard 4-band codes', () => {
    expect(resistorColorBands('220').bands).toEqual(['red', 'red', 'brown', 'gold']);
    expect(resistorColorBands('1k').bands).toEqual(['brown', 'black', 'red', 'gold']);
    expect(resistorColorBands('4.7k').bands).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect(resistorColorBands('1M').bands).toEqual(['brown', 'black', 'green', 'gold']);
  });

  it('accepts infix-multiplier and ohm-suffixed spellings', () => {
    expect(resistorColorBands('4k7').bands).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect(resistorColorBands('220Ω').bands).toEqual(['red', 'red', 'brown', 'gold']);
    expect(parseResistance('470R')).toBe(470);
  });

  it('uses gold and silver multipliers below 10 ohms', () => {
    expect(resistorColorBands('4.7').bands).toEqual(['yellow', 'violet', 'gold', 'gold']);
    expect(resistorColorBands('0.47').bands).toEqual(['yellow', 'violet', 'silver', 'gold']);
  });

  it('returns null for unparsable values', () => {
    expect(resistorColorBands('varies')).toBeNull();
    expect(resistorColorBands('')).toBeNull();
    expect(resistorColorBands(null)).toBeNull();
  });
});

describe('capStyle', () => {
  it('renders 1uF and up as electrolytic, smaller as ceramic', () => {
    expect(capStyle('10u').type).toBe('electrolytic');
    expect(capStyle('10µF').type).toBe('electrolytic');
    expect(capStyle('100nF').type).toBe('ceramic');
    expect(capStyle('22p').type).toBe('ceramic');
    expect(capStyle('0.1uF').type).toBe('ceramic');
    expect(capStyle('4u7').type).toBe('electrolytic');
  });

  it('falls back to ceramic with no parsed value on free text', () => {
    expect(capStyle('film cap')).toEqual({ type: 'ceramic', farads: null });
  });
});

describe('ledColor', () => {
  it('matches color names anywhere in the value', () => {
    expect(ledColor('green').name).toBe('green');
    expect(ledColor('Blue 5mm').name).toBe('blue');
  });

  it('defaults to red', () => {
    expect(ledColor('generic').name).toBe('red');
    expect(ledColor(undefined).name).toBe('red');
  });
});
