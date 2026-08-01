import { describe, expect, it } from 'vitest';
import { RULES } from './pcbDesignRules.js';

describe('RULES', () => {
  it('publishes the fabrication design rules the pipeline is built around', () => {
    expect(RULES).toMatchObject({
      gridPitch: 0.635,
      traceWidth: 0.8,
      clearance: 0.3,
      viaDiameter: 1.2,
      viaDrill: 0.6,
      edgeClearance: 0.5,
      boardMargin: 4,
      placementGap: 2.0,
      maskExpansion: 0.05,
      silkWidth: 0.15,
      boardThickness: 1.6,
    });
  });

  it('uses a routing grid that divides the 2.54 mm through-hole pitch', () => {
    const steps = 2.54 / RULES.gridPitch;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('keeps a via drillable inside its own annular ring', () => {
    expect(RULES.viaDiameter).toBeGreaterThanOrEqual(RULES.viaDrill + 0.4);
  });
});
