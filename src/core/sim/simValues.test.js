import { describe, expect, it } from 'vitest';
import {
  parseAmps,
  parseFarads,
  parseHenries,
  parseOhms,
  parseSourceWaveform,
  parseVolts,
  buckVolts,
  regulatorVolts,
  zenerVolts,
} from './simValues.js';

describe('parseOhms', () => {
  it('parses plain and suffixed resistances', () => {
    expect(parseOhms('470')).toBe(470);
    expect(parseOhms('4.7k')).toBe(4700);
    expect(parseOhms('10K')).toBe(10000);
    expect(parseOhms('1meg')).toBe(1e6);
    expect(parseOhms('2G')).toBe(2e9);
  });

  it('treats bare m as MEG (resistor convention)', () => {
    expect(parseOhms('1m')).toBe(1e6);
    expect(parseOhms('10Meg')).toBe(1e7);
  });

  it('parses infix style and ohm suffixes', () => {
    expect(parseOhms('2k2')).toBe(2200);
    expect(parseOhms('4R7')).toBeCloseTo(4.7, 12);
    expect(parseOhms('330Ω')).toBe(330);
    expect(parseOhms('220 ohms')).toBe(220);
    expect(parseOhms('100R')).toBe(100);
  });

  it('falls back on garbage', () => {
    expect(parseOhms('red', 1000)).toBe(1000);
    expect(parseOhms('', null)).toBeNull();
    expect(parseOhms('5V active', 27)).toBe(27);
  });
});

describe('parseFarads', () => {
  it('parses suffixed capacitances', () => {
    expect(parseFarads('100nF')).toBeCloseTo(1e-7, 15);
    expect(parseFarads('4.7uF')).toBeCloseTo(4.7e-6, 15);
    expect(parseFarads('22p')).toBeCloseTo(22e-12, 18);
    expect(parseFarads('1mF')).toBeCloseTo(1e-3, 12);
    expect(parseFarads('10µF')).toBeCloseTo(1e-5, 12);
  });

  it('treats bare numbers as microfarads', () => {
    expect(parseFarads('100')).toBeCloseTo(1e-4, 12);
    expect(parseFarads('0.1')).toBeCloseTo(1e-7, 12);
  });

  it('falls back on garbage', () => {
    expect(parseFarads('electrolytic', 1e-6)).toBe(1e-6);
  });
});

describe('parseHenries', () => {
  it('parses inductances', () => {
    expect(parseHenries('10mH')).toBeCloseTo(0.01, 12);
    expect(parseHenries('100uH')).toBeCloseTo(1e-4, 12);
    expect(parseHenries('1')).toBe(1);
  });
});

describe('parseVolts / parseAmps', () => {
  it('parses voltages', () => {
    expect(parseVolts('9V')).toBe(9);
    expect(parseVolts('3.3')).toBe(3.3);
    expect(parseVolts('-5 volts')).toBe(-5);
    expect(parseVolts('battery', 5)).toBe(5);
  });

  it('parses currents', () => {
    expect(parseAmps('1A')).toBe(1);
    expect(parseAmps('500mA')).toBeCloseTo(0.5, 12);
    expect(parseAmps('fast blow', 1)).toBe(1);
  });
});

describe('regulatorVolts / zenerVolts', () => {
  it('maps known regulator part numbers', () => {
    expect(regulatorVolts('7805')).toBe(5);
    expect(regulatorVolts('LM7812')).toBe(12);
    expect(regulatorVolts('7905')).toBe(-5);
    expect(regulatorVolts('3.3V LDO')).toBe(3.3);
    expect(regulatorVolts('')).toBe(5);
  });

  it('extracts zener voltage', () => {
    expect(zenerVolts('5.1V')).toBe(5.1);
    expect(zenerVolts('unknown')).toBe(5.1);
    expect(zenerVolts('12V 1W')).toBe(12);
  });
});

describe('buckVolts', () => {
  it('strips the LM2596 part number before matching the output voltage', () => {
    expect(buckVolts('LM2596-5.0')).toBe(5);
    expect(buckVolts('LM2596-3.3')).toBe(3.3);
    expect(buckVolts('LM2596')).toBe(5);
    expect(buckVolts('5V')).toBe(5);
    expect(buckVolts('')).toBe(5);
  });
});

describe('parseSourceWaveform', () => {
  it('parses SINE with SPICE suffixes (m = milli here)', () => {
    const wave = parseSourceWaveform('SINE(0 5 1k)');
    expect(wave.type).toBe('sine');
    expect(wave.freq).toBe(1000);
    expect(wave.evaluate(0)).toBeCloseTo(0, 9);
    expect(wave.evaluate(0.00025)).toBeCloseTo(5, 6);
    expect(wave.evaluate(0.00075)).toBeCloseTo(-5, 6);
  });

  it('parses PULSE edges', () => {
    const wave = parseSourceWaveform('PULSE(0 5 0 1u 1u 1m 2m)');
    expect(wave.type).toBe('pulse');
    expect(wave.per).toBeCloseTo(0.002, 12);
    expect(wave.evaluate(0.0005)).toBeCloseTo(5, 6);
    expect(wave.evaluate(0.0015)).toBeCloseTo(0, 6);
    expect(wave.evaluate(0.0000005)).toBeCloseTo(2.5, 6);
  });

  it('parses DC forms', () => {
    expect(parseSourceWaveform('DC 5').evaluate(1)).toBe(5);
    expect(parseSourceWaveform('5V').evaluate(0)).toBe(5);
    expect(parseSourceWaveform('3.3').evaluate(2)).toBe(3.3);
  });

  it('falls back to DC 0 with a warning on garbage', () => {
    const wave = parseSourceWaveform('triangle-ish');
    expect(wave.type).toBe('dc');
    expect(wave.evaluate(0)).toBe(0);
    expect(wave.warning).toMatch(/Could not parse/);
  });
});
