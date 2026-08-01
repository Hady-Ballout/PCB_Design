import { describe, expect, it } from 'vitest';
import { buildSimulationDeck, chooseWaveformNodes, parseWaveformData, runProcess } from './simulator.js';
import type { Circuit } from '../types.js';

const circuit: Partial<Circuit> = {
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'], footprint: '' },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'], footprint: '' },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'], footprint: '' },
    { ref: 'RLOAD', kind: 'load', value: '10k', nodes: ['VOUT', '0'], footprint: '' },
  ],
};

describe('ngspice simulator helpers', () => {
  it('chooses useful non-ground waveform nodes', () => {
    expect(chooseWaveformNodes(circuit as Circuit)).toEqual(['VIN', 'VOUT']);
  });

  it('adds batch control commands to a SPICE deck', () => {
    const deck = buildSimulationDeck('* test\nV1 VIN 0 DC 5\nR1 VIN VOUT 1k\n.end', ['VIN', 'VOUT']);

    expect(deck).toContain('tran 10us 20ms');
    expect(deck).toContain('wrdata waveform.dat v(VIN) v(VOUT)');
    expect(deck.trim().endsWith('.end')).toBe(true);
  });

  it('injects the built-in LM358 model into older op amp decks', () => {
    const opampCircuit: Partial<Circuit> = {
      components: [
        { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['0', 'N1', 'VOUT', 'VCC', 'VEE'], footprint: '' },
      ],
    };
    const deck = buildSimulationDeck(
      '* op amp\nXU1 0 N1 VOUT VCC VEE LM358\n.end',
      ['VOUT'],
      opampCircuit as Circuit,
    );

    expect(deck).toContain('.subckt LM358 INP INN OUT VCC VEE');
    expect(deck).toContain('.ends LM358');
  });

  it('injects the built-in UA741 model with its output clamp intact', () => {
    const ua741Circuit: Partial<Circuit> = {
      components: [
        { ref: 'XU1', kind: 'ua741', value: 'uA741', nodes: ['N1', 'VOUT', 'VIN', '0', 'N5', 'VOUT', 'VCC', 'N8'], footprint: '' },
      ],
    };
    const deck = buildSimulationDeck(
      '* ua741\nXU1 N1 VOUT VIN 0 N5 VOUT VCC N8 UA741\n.end',
      ['VOUT'],
      ua741Circuit as Circuit,
    );

    expect(deck).toContain('.subckt UA741 OFS1 INN INP VEE OFS2 OUT VCC NC');
    expect(deck).toContain('BOUT NCLAMP 0 V = max(min(V(NINT), V(VCC)-1.5), V(VEE)+1.5)');
    expect(deck).toContain('.ends UA741');
  });

  it('parses ngspice waveform data into series points', () => {
    const raw = 'time v(VIN) v(VOUT)\n0 5 0\n0.001 5 3.2\n';
    const series = parseWaveformData(raw, ['VIN', 'VOUT']);

    expect(series).toEqual([
      { name: 'VIN', points: [{ x: 0, y: 5 }, { x: 0.001, y: 5 }] },
      { name: 'VOUT', points: [{ x: 0, y: 0 }, { x: 0.001, y: 3.2 }] },
    ]);
  });
});

describe('runProcess timeout', () => {
  // Uses node itself as the child so the test is real (an actual spawned process
  // that outlives its deadline) without depending on ngspice or platform shells.
  const sleeper = (ms: number) => [process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]] as const;

  it('returns normally when the process finishes inside the deadline', async () => {
    const [command, args] = sleeper(10);

    const result = await runProcess(command, [...args], {}, 10_000);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('kills a process that outlives its deadline and says so', async () => {
    const [command, args] = sleeper(60_000);
    const startedAt = Date.now();

    const result = await runProcess(command, [...args], {}, 300);

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    // Proves the deadline fired rather than the child exiting on its own.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('reports the timeout in stderr so the caller can explain it', async () => {
    const [command, args] = sleeper(60_000);

    const result = await runProcess(command, [...args], {}, 300);

    expect(result.stderr).toMatch(/timed out/i);
  });
});
