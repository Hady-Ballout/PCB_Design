// render_schematic — draws the circuit and writes it as an SVG artifact.
//
// The markup itself is never returned: an SVG of a modest circuit runs to tens
// of kilobytes and means nothing to a reader. What comes back is where the file
// is and what ended up on it.

import { toDiagramSvg } from '../../src/core/pcbGenerator.js';
import { slugify, writeArtifact } from '../artifacts.js';
import type { ParsedCircuit } from '../schemas.js';
import { diagramFor } from './diagram.js';

export interface RenderArgs {
  circuit: ParsedCircuit;
}

export const renderSchematic = ({ circuit }: RenderArgs, artifactDir: string) => {
  const diagram = diagramFor(circuit);
  const svg = toDiagramSvg(diagram);
  const file = writeArtifact(artifactDir, `${slugify(circuit.title)}.svg`, svg);

  return {
    path: file,
    width: diagram.width,
    height: diagram.height,
    components: diagram.components.length,
    nets: diagram.nets.length,
    placed: diagram.components.map((component) => component.ref),
  };
};
