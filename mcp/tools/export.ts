// export_netlist — SPICE deck, KiCad netlist, KiCad schematic/board, or a
// zipped Gerber fabrication package.
//
// Netlists are small enough to return inline, but they are also the thing you
// actually want on disk (a .cir you can run through ngspice, a .kicad_sch you
// can open), so every text export is both returned and written as an artifact.
// The Gerber package is binary and multi-file: it goes to the artifact only.

import { addMissingSpiceModels, toKiCadNetlist, toSpice } from '../../src/core/pcbGenerator.js';
import { toKiCadSchematic } from '../../src/core/kicadSchematic.js';
import { buildPcbLayout } from '../../src/core/pcbLayout.js';
import { toKiCadPcb } from '../../src/core/kicadPcb.js';
import { PcbExportError, toGerberArchive } from '../../src/core/gerberExport.js';
import { slugify } from '../artifacts.js';
import type { ArtifactRef, ArtifactSink } from '../artifactSink.js';
import type { ParsedCircuit } from '../schemas.js';
import { diagramFor } from './diagram.js';

export type NetlistFormat = 'spice' | 'kicad_netlist' | 'kicad_schematic' | 'kicad_pcb' | 'gerber';

export interface ExportArgs {
  circuit: ParsedCircuit;
  format: NetlistFormat;
}

interface TextExport {
  format: NetlistFormat;
  artifact: ArtifactRef;
  lines: number;
  content: string;
}

interface GerberExport {
  format: 'gerber';
  artifact: ArtifactRef;
  files: string[];
  summary: ReturnType<typeof toGerberArchive>['summary'];
}

const EXTENSIONS: Record<NetlistFormat, string> = {
  spice: '.cir',
  kicad_netlist: '.net',
  kicad_schematic: '.kicad_sch',
  kicad_pcb: '.kicad_pcb',
  gerber: '-gerbers.zip',
};

const NO_COMPONENTS = 'Cannot lay out a circuit with no components.';

/**
 * The fabrication package is the one export that can refuse. Flatten the
 * structured report into the message so `guarded()` in registerTools.ts hands
 * the model both the headline and every offending net verbatim — it is the
 * information needed to go back and fix the board.
 */
const exportGerbers = (circuit: ParsedCircuit, sink: ArtifactSink): GerberExport => {
  const layout = buildPcbLayout(circuit);
  if (!layout) throw new Error(NO_COMPONENTS);

  let archive: ReturnType<typeof toGerberArchive>;
  try {
    archive = toGerberArchive(layout, circuit);
  } catch (error) {
    if (!(error instanceof PcbExportError)) throw error;
    const { failedNets, violations, incompleteNets } = error.report;
    throw new Error(
      `Gerber export refused: ${failedNets.length} unrouted nets, ${violations.length} DRC violations, `
      + `${incompleteNets.length} split nets.\n${JSON.stringify(error.report, null, 2)}`,
    );
  }

  return {
    format: 'gerber',
    artifact: sink.put(`${slugify(circuit.title)}${EXTENSIONS.gerber}`, archive.zip),
    files: archive.files.map((file) => file.name),
    summary: archive.summary,
  };
};

export const exportNetlist = (
  { circuit, format }: ExportArgs,
  sink: ArtifactSink,
): TextExport | GerberExport => {
  const extension = EXTENSIONS[format];
  if (!extension) {
    throw new Error(
      `Unknown export format "${format}". Supported: ${Object.keys(EXTENSIONS).join(', ')}.`,
    );
  }

  if (format === 'gerber') return exportGerbers(circuit, sink);

  let content: string;
  if (format === 'spice') {
    content = addMissingSpiceModels(toSpice(circuit), circuit);
  } else if (format === 'kicad_netlist') {
    content = toKiCadNetlist(circuit);
  } else if (format === 'kicad_schematic') {
    content = toKiCadSchematic(circuit, diagramFor(circuit));
  } else {
    const layout = buildPcbLayout(circuit);
    if (!layout) {
      throw new Error(NO_COMPONENTS);
    }
    content = toKiCadPcb(layout, circuit);
  }

  const artifact = sink.put(`${slugify(circuit.title)}${extension}`, content);

  return {
    format,
    artifact,
    lines: content.split('\n').length,
    content,
  };
};
