import { describe, expect, it } from 'vitest';
import { checkPhysicalModel } from './physicalChecks.js';

const hole = (strip, row, column) => ({ strip, row, column });

describe('occupancy', () => {
  it('flags two conductors in one hole even on the same net (TC3)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U2', kind: 'motor_driver', body: 'dip', strip: 'bottom',
        pinNets: ['VMOT'], holes: [hole('railTopPlus', 0, 9)] }],
      jumpers: [{ net: 'VMOT', from: hole('top', 1, 9), to: hole('railTopPlus', 0, 9) }],
      batteries: [], nets: [], rails: {},
    });
    expect(issues.some((line) => line.startsWith('OCCUPANCY:') && line.includes('U2.pin1'))).toBe(true);
  });
  it('is silent when every hole has one conductor', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'R1', kind: 'resistor', body: 'twoLead', strip: 'top',
        pinNets: ['A', 'B'], holes: [hole('top', 0, 2), hole('top', 0, 4)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });
});
