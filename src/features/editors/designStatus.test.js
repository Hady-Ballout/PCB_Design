import { describe, expect, it } from 'vitest';
import { designStatus } from './designStatus.js';

const cleanLayout = {
  routing: { complete: true, failedNets: [] },
  drc: { ok: true, violations: [] },
  connectivity: { ok: true, incompleteNets: [] },
};

describe('designStatus', () => {
  it('is null when there is no circuit to judge', () => {
    expect(designStatus({ hasCircuit: false, issues: [], pcbLayout: null })).toBeNull();
  });

  it('passes when there are no issues and the layout is fabricable', () => {
    expect(designStatus({ hasCircuit: true, issues: [], pcbLayout: cleanLayout }))
      .toEqual({ tone: 'ok', label: 'Checks pass' });
  });

  it('passes on issues alone when no layout has been built yet', () => {
    expect(designStatus({ hasCircuit: true, issues: [], pcbLayout: null }))
      .toEqual({ tone: 'ok', label: 'Checks pass' });
  });

  it('warns when the only findings are warnings', () => {
    const issues = [{ severity: 'warning', message: 'x' }];
    expect(designStatus({ hasCircuit: true, issues, pcbLayout: cleanLayout }))
      .toEqual({ tone: 'warn', label: '1 warning' });
    expect(designStatus({ hasCircuit: true, issues: [...issues, ...issues], pcbLayout: null }).label)
      .toBe('2 warnings');
  });

  it('reports errors ahead of warnings', () => {
    const issues = [{ severity: 'error', message: 'a' }, { severity: 'warning', message: 'b' }];
    expect(designStatus({ hasCircuit: true, issues, pcbLayout: cleanLayout }))
      .toEqual({ tone: 'error', label: '1 error' });
  });

  it('treats an unroutable or DRC-failing layout as an error', () => {
    const bad = { ...cleanLayout, drc: { ok: false, violations: [{}, {}] } };
    expect(designStatus({ hasCircuit: true, issues: [], pcbLayout: bad }))
      .toEqual({ tone: 'error', label: 'Layout incomplete' });
  });
});
