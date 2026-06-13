import { describe, expect, it } from 'vitest';
import { buildSimulationDeck, chooseWaveformNodes, parseWaveformData } from './simulator.js';

const circuit = {
  components: [
    { ref: 'V1', nodes: ['VIN', '0'] },
    { ref: 'R1', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', nodes: ['VOUT', '0'] },
    { ref: 'RLOAD', nodes: ['VOUT', '0'] },
  ],
};

describe('ngspice simulator helpers', () => {
  it('chooses useful non-ground waveform nodes', () => {
    expect(chooseWaveformNodes(circuit)).toEqual(['VIN', 'VOUT']);
  });

  it('adds batch control commands to a SPICE deck', () => {
    const deck = buildSimulationDeck('* test\nV1 VIN 0 DC 5\nR1 VIN VOUT 1k\n.end', ['VIN', 'VOUT']);

    expect(deck).toContain('tran 10us 20ms');
    expect(deck).toContain('wrdata waveform.dat v(VIN) v(VOUT)');
    expect(deck.trim().endsWith('.end')).toBe(true);
  });

  it('injects the built-in LM358 model into older op amp decks', () => {
    const opampCircuit = {
      components: [
        { ref: 'XU1', kind: 'opamp', nodes: ['0', 'N1', 'VOUT', 'VCC', 'VEE'] },
      ],
    };
    const deck = buildSimulationDeck(
      '* op amp\nXU1 0 N1 VOUT VCC VEE LM358\n.end',
      ['VOUT'],
      opampCircuit,
    );

    expect(deck).toContain('.subckt LM358 INP INN OUT VCC VEE');
    expect(deck).toContain('.ends LM358');
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
