// export_netlist — SPICE deck, KiCad netlist, or KiCad schematic.
//
// Netlists are small enough to return inline, but they are also the thing you
// actually want on disk (a .cir you can run through ngspice, a .kicad_sch you
// can open), so every export is both returned and written as an artifact.

import { addMissingSpiceModels, toKiCadNetlist, toSpice } from '../../src/core/pcbGenerator.js';
import { toKiCadSchematic } from '../../src/core/kicadSchematic.js';
import { buildPcbLayout } from '../../src/core/pcbLayout.js';
import { toKiCadPcb } from '../../src/core/kicadPcb.js';
import { slugify } from '../artifacts.js';
import type { ArtifactSink } from '../artifactSink.js';
import type { ParsedCircuit } from '../schemas.js';
import { diagramFor } from './diagram.js';

export type NetlistFormat = 'spice' | 'kicad_netlist' | 'kicad_schematic' | 'kicad_pcb';

export interface ExportArgs {
  circuit: ParsedCircuit;
  format: NetlistFormat;
}

const EXTENSIONS: Record<NetlistFormat, string> = {
  spice: '.cir',
  kicad_netlist: '.net',
  kicad_schematic: '.kicad_sch',
  kicad_pcb: '.kicad_pcb',
};

export const exportNetlist = ({ circuit, format }: ExportArgs, sink: ArtifactSink) => {
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
  } else if (format === 'kicad_schematic') {
    content = toKiCadSchematic(circuit, diagramFor(circuit));
  } else {
    const layout = buildPcbLayout(circuit);
    if (!layout) {
      throw new Error('Cannot lay out a circuit with no components.');
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
