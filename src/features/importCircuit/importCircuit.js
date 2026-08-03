// Importing a circuit straight into the workspace.
//
// Circuit generation has been removed, so this is currently the only way a
// circuit enters the app. It builds the complete result package in the browser
// from pasted or uploaded JSON — schematic, breadboard, board editor, 3D view,
// SPICE, Gerber and KiCad export all read what this produces. Whatever
// generates circuits next should produce the same package.
import { parseCircuitJson, synchronizeResult } from '../../core/circuitSync.js';
import {
  DiagramLayoutError,
  buildCircuitDiagram,
  buildFallbackCircuitDiagram,
} from '../../core/pcbGenerator.js';
import { messageId } from '../chat/chatFormat.js';
import { createChat } from '../chat/chatStore.js';

/** Refuse implausibly large pastes/files before JSON.parse walks them. */
export const IMPORT_SIZE_LIMIT = 2_000_000;

/**
 * The schematic router can fail on a circuit the board router handles fine (a
 * 555 astable with a CTRL decoupling cap is one), so a layout failure must not
 * cost the user the import: fall back to the coarse diagram and carry the
 * violations along so the schematic view can report them.
 *
 * @param {object} circuit
 * @returns {object} diagram, possibly carrying `layoutError`/`layoutViolations`
 */
export const buildImportedDiagram = (circuit) => {
  try {
    return buildCircuitDiagram(circuit);
  } catch (error) {
    if (!(error instanceof DiagramLayoutError)) throw error;
    return {
      ...buildFallbackCircuitDiagram(circuit),
      layoutError: error.message,
      layoutViolations: error.violations || [],
    };
  }
};

/**
 * Validate pasted text as a circuit. Accepts either a bare circuit object or
 * the `{ circuit: {...} }` envelope the workspace exports, and rejects a board
 * layout (`buildPcbLayout` output) with a pointed message rather than the
 * generic "components array" complaint — pasting the wrong one of the two is
 * the easiest mistake to make.
 *
 * @param {string} source
 * @returns {{ ok: true, circuit: object } | { ok: false, errors: string[] }}
 */
export const parseImportedCircuit = (source) => {
  const text = String(source || '').trim();
  if (!text) return { ok: false, errors: ['Paste circuit JSON, or choose a .json file.'] };
  if (text.length > IMPORT_SIZE_LIMIT) {
    return { ok: false, errors: [`That is ${Math.round(text.length / 1000)} kB; the limit is ${IMPORT_SIZE_LIMIT / 1000} kB.`] };
  }

  let probe;
  try {
    probe = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`JSON syntax error: ${error.message}`] };
  }
  if (probe && typeof probe === 'object' && !Array.isArray(probe) && Array.isArray(probe.traces) && probe.board) {
    return {
      ok: false,
      errors: ['That looks like a board layout, not a circuit. Import the circuit (components with ref/kind/value/nodes) — the board is generated from it.'],
    };
  }

  const parsed = parseCircuitJson(text, null);
  return parsed.ok ? { ok: true, circuit: parsed.circuit } : { ok: false, errors: parsed.errors };
};

/**
 * Full result package for an imported circuit: validation, simulation,
 * schematic diagram + SVG, SPICE deck and KiCad netlist.
 *
 * @param {object} circuit
 * @returns {object} the same shape the generate route returns
 */
export const buildImportedResult = (circuit) =>
  synchronizeResult(null, circuit, buildImportedDiagram(circuit));

/**
 * A chat carrying an imported circuit, seeded so the workspace opens on it the
 * way it would after a generation. The transcript records the import rather
 * than faking a prompt, so the conversation stays honest about where the
 * circuit came from.
 *
 * @param {object} circuit
 * @param {{ now?: number, id?: string, sourceLabel?: string }} [options]
 * @returns {object} a chat ready to push into the chat store
 */
export const createImportedChat = (circuit, options = {}) => {
  const now = options.now ?? Date.now();
  const result = buildImportedResult(circuit);
  const from = options.sourceLabel ? ` from ${options.sourceLabel}` : '';
  const componentCount = circuit.components.length;

  return {
    ...createChat({ ...(options.id ? { id: options.id } : {}), now }),
    title: circuit.title || 'Imported circuit',
    messages: [
      {
        id: messageId(),
        role: 'user',
        content: `Imported circuit JSON${from}.`,
        createdAt: now,
      },
      {
        id: messageId(),
        role: 'assistant',
        content: `Imported ${circuit.title || 'circuit'} with ${componentCount} component${componentCount === 1 ? '' : 's'}. `
          + 'The circuit package is open in the workspace.',
        circuit,
        issues: [],
        createdAt: now,
      },
    ],
    result,
    editableSpice: result.spice || '',
    editableKicadNetlist: result.kicadNetlist || '',
    editableCircuitJson: JSON.stringify(circuit, null, 2),
  };
};
