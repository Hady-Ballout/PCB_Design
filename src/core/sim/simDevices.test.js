import { describe, expect, it } from 'vitest';
import { HALF_STEP_MASKS, stepperStepDelta } from './simDevices.js';

describe('stepperStepDelta — 28BYJ-48 half-step ring', () => {
  it('walks CW half steps as +1 per pattern', () => {
    let index = 0;
    for (let i = 1; i < 8; i += 1) {
      const result = stepperStepDelta(index, HALF_STEP_MASKS[i]);
      expect(result.delta).toBe(1);
      index = result.index;
    }
    // Ring wrap: index 7 → 0 is still +1.
    expect(stepperStepDelta(7, HALF_STEP_MASKS[0]).delta).toBe(1);
  });

  it('walks CCW half steps as -1 including the wrap', () => {
    expect(stepperStepDelta(0, HALF_STEP_MASKS[7]).delta).toBe(-1);
    expect(stepperStepDelta(3, HALF_STEP_MASKS[2]).delta).toBe(-1);
  });

  it('treats the Stepper.h full-step sequence as ±2', () => {
    // AB → BC → CD → DA (two-coil masks at odd ring indexes).
    expect(stepperStepDelta(1, 0b0110).delta).toBe(2);
    expect(stepperStepDelta(3, 0b1100).delta).toBe(2);
    expect(stepperStepDelta(7, 0b0011).delta).toBe(2); // DA → AB wraps
    expect(stepperStepDelta(3, 0b0011).delta).toBe(-2);
  });

  it('holds position on all-off and unknown masks', () => {
    expect(stepperStepDelta(2, 0b0000)).toEqual({ index: 2, delta: 0 });
    expect(stepperStepDelta(2, 0b0111)).toEqual({ index: 2, delta: 0 });
  });

  it('rejects jumps beyond a full step as sampling glitches', () => {
    // 0 → 4 is ambiguous (opposite ring point): re-anchor without rotating.
    expect(stepperStepDelta(0, HALF_STEP_MASKS[4])).toEqual({ index: 4, delta: 0 });
    expect(stepperStepDelta(0, HALF_STEP_MASKS[3])).toEqual({ index: 3, delta: 0 });
  });

  it('anchors without rotating on the first sample', () => {
    expect(stepperStepDelta(null, HALF_STEP_MASKS[5])).toEqual({ index: 5, delta: 0 });
  });
});
