import { describe, expect, it } from 'vitest';
import { FIRMWARE_TARGETS, firmwareTargetForCircuit } from './firmwareInfo.js';

describe('firmwareTargetForCircuit', () => {
  it('maps each board kind to its language and download filename', () => {
    expect(FIRMWARE_TARGETS.arduino_uno).toMatchObject({ language: 'Arduino C++', filename: 'sketch.ino' });
    expect(FIRMWARE_TARGETS.esp32).toMatchObject({ language: 'Arduino C++', filename: 'sketch.ino' });
    expect(FIRMWARE_TARGETS.raspberry_pi).toMatchObject({
      language: 'Python (gpiozero)',
      filename: 'gpio_script.py',
      mime: 'text/x-python',
    });
  });

  it('finds the circuit MCU and carries its ref', () => {
    const target = firmwareTargetForCircuit({
      components: [
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', '0'] },
        { ref: 'U1', kind: 'esp32', value: 'DevKit V1', nodes: ['VCC3', '0', 'LED'] },
      ],
    });
    expect(target).toMatchObject({ ref: 'U1', kind: 'esp32', boardName: 'ESP32' });
  });

  it('picks the first board when a circuit has two', () => {
    const target = firmwareTargetForCircuit({
      components: [
        { ref: 'U1', kind: 'raspberry_pi', value: 'Pi 5', nodes: ['VCC3', '0'] },
        { ref: 'U2', kind: 'arduino_uno', value: 'Uno R3', nodes: ['VCC5', '0'] },
      ],
    });
    expect(target.kind).toBe('raspberry_pi');
  });

  it('returns null for circuits without a board', () => {
    expect(firmwareTargetForCircuit({ components: [{ ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', '0'] }] })).toBeNull();
    expect(firmwareTargetForCircuit(null)).toBeNull();
    expect(firmwareTargetForCircuit(undefined)).toBeNull();
  });
});
