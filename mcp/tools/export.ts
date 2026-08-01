// export_netlist — SPICE deck, KiCad netlist, or KiCad schematic.
//
// Netlists are small enough to return inline, but they are also the thing you
// actually want on disk (a .cir you can run through ngspice, a .kicad_sch you
// can open), so every export is both returned and written as an artifact.

import { addMissingSpiceModels, toKiCadNetlist, toSpice } from '../../src/core/pcbGenerator.js';
import { toKiCadSchematic } from '../../src/core/kicadSchematic.js';
import { slugify, writeArtifact } from '../artifacts.js';
import type { ParsedCircuit } from '../schemas.js';
import { diagramFor } from './diagram.js';

export type NetlistFormat = 'spice' | 'kicad_netlist' | 'kicad_schematic';

export interface ExportArgs {
  circuit: ParsedCircuit;
  format: NetlistFormat;
}

const EXTENSIONS: Record<NetlistFormat, string> = {
  spice: '.cir',
  kicad_netlist: '.net',
  kicad_schematic: '.kicad_sch',
};

export const exportNetlist = ({ circuit, format }: ExportArgs, artifactDir: string) => {
  const extension = EXTENSIONS[format];
  if (!extension) {
    throw new Error(
      `Unknown export format "${format}". Supported: ${Object.keys(EXTENSIONS).join(', ')}.`,
    );
  }

  let content: string;
  if (format === 'spice') {
    content = addMissingSpiceModels(toSpice(circuit), circuit);
  } else if (format === 'kicad_netlist') {
    content = toKiCadNetlist(circuit);
  } else {
    content = toKiCadSchematic(circuit, diagramFor(circuit));
  }

  const file = writeArtifact(artifactDir, `${slugify(circuit.title)}${extension}`, content);

  return {
    format,
    path: file,
    lines: content.split('\n').length,
    content,
  };
};
