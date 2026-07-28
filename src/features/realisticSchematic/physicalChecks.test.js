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

describe('rigid geometry', () => {
  it('flags a >2-pin rigid part with pins on both a power rail and a terminal strip (TC3 L298N)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U2', kind: 'motor_driver', body: 'dip', strip: 'bottom',
        pinNets: ['A', 'B', 'C', 'VMOT'],
        holes: [hole('bottom', 0, 5), hole('bottom', 0, 6), hole('bottom', 0, 7), hole('railTopPlus', 0, 9)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues.some((line) => line.startsWith('GEOMETRY:') && line.includes('U2') && line.includes('cannot reach'))).toBe(true);
  });

  it('flags a >2-pin part whose strip-hole columns have a gap', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U3', kind: 'ic', body: 'dip', strip: 'bottom',
        pinNets: ['A', 'B', 'C'],
        holes: [hole('bottom', 0, 5), hole('bottom', 0, 6), hole('bottom', 0, 8)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues.some((line) => line.startsWith('GEOMETRY:') && line.includes('U3') && line.includes('non-contiguous'))).toBe(true);
  });

  it('is silent for a clean 4-column DIP straddling top and bottom strips', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U4', kind: 'ic', body: 'dip', strip: 'bottom',
        pinNets: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
        holes: [
          hole('bottom', 0, 17), hole('bottom', 0, 18), hole('bottom', 0, 19), hole('bottom', 0, 20),
          hole('top', 0, 17), hole('top', 0, 18), hole('top', 0, 19), hole('top', 0, 20),
        ] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });

  it('is silent for an off-board module even with rail pins and a gap (meta.slot exempts it)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'U5', kind: 'module', body: 'flying', strip: 'bottom', meta: { slot: 'esp32' },
        pinNets: ['A', 'B', 'C', 'VCC'],
        holes: [hole('bottom', 0, 5), hole('bottom', 0, 6), hole('bottom', 0, 9), hole('railTopPlus', 0, 12)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });
});

describe('two-lead span', () => {
  it('flags a two-lead part spanning 6 columns (TC4 stretched electrolytic)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'C1', kind: 'electrolytic', body: 'twoLead', strip: 'top',
        pinNets: ['A', 'B'], holes: [hole('top', 0, 2), hole('top', 0, 8)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues.some((line) => line.startsWith('LEAD-SPAN:') && line.includes('C1'))).toBe(true);
  });

  it('is silent when a two-lead part spans 5 columns or fewer', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'C2', kind: 'electrolytic', body: 'twoLead', strip: 'top',
        pinNets: ['A', 'B'], holes: [hole('top', 0, 2), hole('top', 0, 7)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });

  it('is silent for a rail-connected two-lead part regardless of span (jumper-like)', () => {
    const issues = checkPhysicalModel({
      parts: [{ ref: 'C3', kind: 'electrolytic', body: 'twoLead', strip: 'top',
        pinNets: ['A', 'B'], holes: [hole('railTopPlus', 0, 2), hole('top', 0, 9)] }],
      jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });
});

describe('rail policy', () => {
  it('flags a power rail carrying a non-supply net (TC1 SIG on VBIAS rail)', () => {
    const issues = checkPhysicalModel({
      parts: [], jumpers: [], batteries: [],
      nets: [{ net: 'SIG', role: 'signal' }],
      rails: { railTopPlus: 'SIG' },
    });
    expect(issues.some((line) => line.startsWith('RAIL-POLICY:') && line.includes('railTopPlus') && line.includes('SIG'))).toBe(true);
  });

  it('is silent for a supply-role net on a rail', () => {
    const issues = checkPhysicalModel({
      parts: [], jumpers: [], batteries: [],
      nets: [{ net: 'VCC', role: 'supply' }],
      rails: { railTopPlus: 'VCC' },
    });
    expect(issues).toEqual([]);
  });

  it('is silent for ground on a rail', () => {
    const issues = checkPhysicalModel({
      parts: [], jumpers: [], batteries: [],
      nets: [],
      rails: { railBottomMinus: '0' },
    });
    expect(issues).toEqual([]);
  });
});

describe('board seams', () => {
  it('flags a 190-column layout with explicit seam columns and a rail-bridging instruction (TC1)', () => {
    const issues = checkPhysicalModel({
      board: { columns: 190 },
      parts: [], jumpers: [], batteries: [], nets: [], rails: {},
    });
    const seamIssues = issues.filter((line) => line.startsWith('SEAM:'));
    expect(seamIssues).toHaveLength(1);
    expect(seamIssues[0]).toContain('63');
    expect(seamIssues[0]).toContain('126');
    expect(seamIssues[0]).toContain('189');
    expect(seamIssues[0]).toContain('4 full-size boards');
    expect(seamIssues[0].toLowerCase()).toContain('bridged with a jumper');
  });

  it('is silent at exactly one full-size board (63 columns)', () => {
    const issues = checkPhysicalModel({
      board: { columns: 63 },
      parts: [], jumpers: [], batteries: [], nets: [], rails: {},
    });
    expect(issues).toEqual([]);
  });
});
