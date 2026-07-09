import { describe, expect, it } from 'vitest';
import { FIRMWARE_TARGETS, firmwareTargetForCircuit } from './firmwareInfo.js';

const unoCircuit = {
  components: [
    { ref: 'U1', kind: 'arduino_uno', value: 'Uno R3', nodes: [] },
    { ref: 'RLED', kind: 'resistor', value: '330', nodes: [] },
  ],
};

describe('firmwareTargetForCircuit', () => {
  it('returns the board metadata for each supported kind', () => {
    expect(FIRMWARE_TARGETS.arduino_uno.filename).toBe('sketch.ino');
    expect(FIRMWARE_TARGETS.esp32.filename).toBe('sketch.ino');
    expect(FIRMWARE_TARGETS.raspberry_pi.filename).toBe('gpio_script.py');
  });

  it('finds the MCU board and merges its ref/kind with the static metadata', () => {
    expect(firmwareTargetForCircuit(unoCircuit)).toMatchObject({
      ref: 'U1',
      kind: 'arduino_uno',
      boardName: 'Arduino Uno',
      filename: 'sketch.ino',
    });
  });

  it('picks the first MCU board in array order when a circuit has two', () => {
    const twoMcus = {
      components: [
        { ref: 'U1', kind: 'esp32', value: 'DevKit V1', nodes: [] },
        { ref: 'U2', kind: 'raspberry_pi', value: 'Pi 5', nodes: [] },
      ],
    };
    expect(firmwareTargetForCircuit(twoMcus)).toMatchObject({ ref: 'U1', kind: 'esp32' });
  });

  it('returns null when the circuit has no microcontroller board, or is missing', () => {
    expect(firmwareTargetForCircuit({ components: [{ ref: 'R1', kind: 'resistor', nodes: [] }] })).toBeNull();
    expect(firmwareTargetForCircuit(null)).toBeNull();
    expect(firmwareTargetForCircuit(undefined)).toBeNull();
  });
});
