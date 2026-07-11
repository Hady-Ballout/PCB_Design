import { describe, expect, it } from 'vitest';
import { formatSI, ledBrightness } from './simObservables.js';

describe('ledBrightness', () => {
  it('is 0 at or below 0.1 mA', () => {
    expect(ledBrightness(0)).toBe(0);
    expect(ledBrightness(1e-4)).toBe(0);
    expect(ledBrightness(-0.01)).toBe(0);
  });

  it('is 1 at or above 15 mA', () => {
    expect(ledBrightness(0.015)).toBeCloseTo(1, 9);
    expect(ledBrightness(0.05)).toBe(1);
  });

  it('is log-scaled between the endpoints', () => {
    const mid = ledBrightness(Math.sqrt(1e-4 * 0.015)); // log midpoint
    expect(mid).toBeCloseTo(0.5, 6);
    expect(ledBrightness(0.001)).toBeGreaterThan(0.4);
    expect(ledBrightness(0.001)).toBeLessThan(0.5);
  });
});

describe('formatSI', () => {
  it('formats with SI prefixes and sensible digits', () => {
    expect(formatSI(0.0025, 'A')).toBe('2.50mA');
    expect(formatSI(3.302, 'V')).toBe('3.30V');
    expect(formatSI(4700, 'Ω')).toBe('4.70kΩ');
    expect(formatSI(0.0000012, 'A')).toBe('1.20µA');
    expect(formatSI(120, 'V')).toBe('120V');
    expect(formatSI(-0.5, 'V')).toBe('-500mV');
  });

  it('handles zero and non-finite values', () => {
    expect(formatSI(0, 'V')).toBe('0V');
    expect(formatSI(Number.NaN, 'V')).toBe('—V');
  });
});
