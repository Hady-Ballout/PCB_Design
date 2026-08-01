import { describe, expect, it } from 'vitest';
import { listComponentKinds } from './componentKinds.js';
import { ALLOWED_KINDS } from '../../src/core/componentKinds.js';

describe('listComponentKinds', () => {
  it('lists every kind in the registry with its SPICE prefix and pin count', () => {
    const result = listComponentKinds({});

    expect(result.kinds).toHaveLength(ALLOWED_KINDS.length);
    const resistor = result.kinds.find((entry) => entry.kind === 'resistor');
    expect(resistor).toMatchObject({ kind: 'resistor', pins: 2, spicePrefix: 'R', label: 'Resistor' });
  });

  it('omits the pin-name tables from the unfiltered listing but flags who has one', () => {
    const result = listComponentKinds({});

    const ua741 = result.kinds.find((entry) => entry.kind === 'ua741');
    expect(ua741?.fixedPinOrder).toBeUndefined();
    expect(ua741?.hasFixedPinOrder).toBe(true);

    const resistor = result.kinds.find((entry) => entry.kind === 'resistor');
    expect(resistor?.hasFixedPinOrder).toBeUndefined();
  });

  it('returns the full positional pin contract when a single kind is requested', () => {
    const result = listComponentKinds({ kind: 'ua741' });

    expect(result.kinds).toHaveLength(1);
    expect(result.kinds[0].fixedPinOrder).toEqual(['OFS1', 'IN-', 'IN+', 'V-', 'OFS2', 'OUT', 'V+', 'NC']);
  });

  it('marks MCU boards, which carry firmware and never reach the SPICE deck', () => {
    const result = listComponentKinds({ kind: 'arduino_uno' });

    expect(result.kinds[0].mcu).toBe(true);
    expect(result.kinds[0].wiringOnly).toBe(true);
  });

  it('can return every pin table at once when asked', () => {
    const result = listComponentKinds({ includePinOrders: true });

    const ua741 = result.kinds.find((entry) => entry.kind === 'ua741');
    expect(ua741?.fixedPinOrder?.[0]).toBe('OFS1');
  });

  it('reports an unknown kind as an error rather than an empty list', () => {
    expect(() => listComponentKinds({ kind: 'flux_capacitor' })).toThrow(/flux_capacitor/);
  });

  it('describes the circuit JSON envelope the other tools expect', () => {
    const result = listComponentKinds({});

    expect(result.circuitShape.groundNode).toBe('0');
    expect(result.circuitShape.required).toContain('components');
  });
});
