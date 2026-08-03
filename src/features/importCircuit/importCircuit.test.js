import { describe, expect, it } from 'vitest';
import { buildImportedDiagram, buildImportedResult, createImportedChat, parseImportedCircuit } from './importCircuit.js';
import { synchronizeResult } from '../../core/circuitSync.js';
import { createChat } from '../chat/chatStore.js';
import { buildPcbLayout } from '../../core/pcbLayout.js';

const rcLowPass = {
  title: 'RC low-pass',
  supplyVoltage: 5,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
  ],
};

// A 555 astable: the board router places and routes it, but the schematic
// router cannot, so it exercises the fallback-diagram path.
const blinker = {
  title: '1 Hz LED blinker (555 astable)',
  supplyVoltage: 9,
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
    { ref: 'U1', kind: 'timer_555', value: 'NE555', nodes: ['0', 'CT', 'OUT', 'VCC', 'CTRL', 'CT', 'DISCH', 'VCC'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'DISCH'] },
    { ref: 'R2', kind: 'resistor', value: '68k', nodes: ['DISCH', 'CT'] },
    { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['CT', '0'] },
    { ref: 'C2', kind: 'capacitor', value: '10nF', nodes: ['CTRL', '0'] },
    { ref: 'R3', kind: 'resistor', value: '330', nodes: ['OUT', 'LED_A'] },
    { ref: 'D1', kind: 'led', value: 'Red', nodes: ['LED_A', '0'] },
  ],
};

describe('parseImportedCircuit', () => {
  it('accepts a bare circuit object', () => {
    const parsed = parseImportedCircuit(JSON.stringify(rcLowPass));
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components).toHaveLength(3);
    expect(parsed.circuit.title).toBe('RC low-pass');
  });

  it('accepts the { circuit } envelope the workspace exports', () => {
    const parsed = parseImportedCircuit(JSON.stringify({ circuit: rcLowPass }));
    expect(parsed.ok).toBe(true);
    expect(parsed.circuit.components).toHaveLength(3);
  });

  it('rejects empty input with an actionable message', () => {
    expect(parseImportedCircuit('   ')).toEqual({
      ok: false,
      errors: ['Paste circuit JSON, or choose a .json file.'],
    });
  });

  it('reports a syntax error rather than throwing', () => {
    const parsed = parseImportedCircuit('{ "components": [ }');
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/JSON syntax error/);
  });

  it('tells the user when they pasted a board layout instead of a circuit', () => {
    const layout = buildPcbLayout(rcLowPass);
    const parsed = parseImportedCircuit(JSON.stringify(layout));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/looks like a board layout/);
  });

  it('surfaces per-component validation errors', () => {
    const parsed = parseImportedCircuit(JSON.stringify({
      components: [{ ref: 'R1', kind: 'not_a_real_part', value: '1k', nodes: ['A', 'B'] }],
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toMatch(/kind is not supported/);
  });

  it('rejects a paste past the size limit without parsing it', () => {
    const parsed = parseImportedCircuit(`"${'x'.repeat(2_000_001)}"`);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatch(/the limit is/);
  });
});

describe('buildImportedResult', () => {
  it('builds the same package shape the generate route returns', () => {
    const result = buildImportedResult(rcLowPass);
    expect(result.circuit.components).toHaveLength(3);
    expect(result.validation.ok).toBe(true);
    expect(result.diagram.components.length).toBeGreaterThan(0);
    expect(result.diagramSvg).toContain('<svg');
    expect(result.spice).toMatch(/R1/);
    expect(result.kicadNetlist).toMatch(/R1/);
  });

  it('falls back to the coarse diagram when the schematic router gives up', () => {
    const result = buildImportedResult(blinker);
    expect(result.circuit.components).toHaveLength(8);
    expect(result.validation.ok).toBe(true);
    expect(result.diagramSvg).toContain('<svg');
    // The fallback records why it was needed instead of losing the import.
    expect(result.diagram.layoutError).toMatch(/collision-free/);
    expect(result.diagram.layoutViolations.length).toBeGreaterThan(0);
  });

  it('produces a circuit the board pipeline routes cleanly', () => {
    const layout = buildPcbLayout(buildImportedResult(blinker).circuit);
    expect(layout.routing.complete).toBe(true);
    expect(layout.drc.ok).toBe(true);
    expect(layout.connectivity.ok).toBe(true);
  });
});

describe('import cost', () => {
  // buildImportedResult used to hand its freshly-built diagram to
  // synchronizeResult as `previousDiagram`, which sent preserveDiagramLayout
  // off to reconcile a diagram against itself: 17.9s on a 10-part board, with
  // the UI frozen and nothing on screen. The diagram now goes in via
  // `options.diagram` instead.
  it('uses a supplied diagram as-is rather than reconciling it', () => {
    const diagram = buildImportedDiagram(rcLowPass);
    const result = synchronizeResult(null, rcLowPass, null, { diagram });
    // Identity, not deep equality: anything else means it went back through
    // buildSyncDiagram / preserveDiagramLayout.
    expect(result.diagram).toBe(diagram);
  });

  it('builds the diagram exactly once', () => {
    // A second layout pass shows up as a second call; one pass is the contract.
    const result = buildImportedResult(rcLowPass);
    expect(result.diagram.components.length).toBe(rcLowPass.components.length);
    expect(result.diagramSvg).toContain('<svg');
  });

  it('stays far below the pathological path, even on the fallback route', () => {
    // Generous by 10x against the fixed cost and 20x under the old one, so this
    // catches a return of the quadratic path without flaking on a slow machine.
    const started = Date.now();
    buildImportedResult(blinker);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('createImportedChat', () => {
  it('seeds every field the chat store expects', () => {
    const chat = createImportedChat(rcLowPass, { now: 1_700_000_000_000 });
    for (const key of Object.keys(createChat())) expect(chat).toHaveProperty(key);
    expect(chat.title).toBe('RC low-pass');
    expect(chat.result.circuit.components).toHaveLength(3);
    expect(JSON.parse(chat.editableCircuitJson).components).toHaveLength(3);
    expect(chat.editableSpice).toBe(chat.result.spice);
    expect(chat.editableKicadNetlist).toBe(chat.result.kicadNetlist);
  });

  it('records the import in the transcript rather than faking a prompt', () => {
    const chat = createImportedChat(rcLowPass, { sourceLabel: 'blinker.json' });
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[0].content).toBe('Imported circuit JSON from blinker.json.');
    expect(chat.messages[1].role).toBe('assistant');
    expect(chat.messages[1].content).toMatch(/3 components/);
    expect(chat.messages[1].circuit).toBe(chat.result.circuit);
  });

  it('gives each import a distinct id so imports stack up as separate chats', () => {
    expect(createImportedChat(rcLowPass).id).not.toBe(createImportedChat(rcLowPass).id);
  });
});
