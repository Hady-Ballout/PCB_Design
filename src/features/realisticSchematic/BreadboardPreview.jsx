// Static, non-interactive render of the realistic breadboard. It runs the exact
// same `circuitToBreadboard` transform and part artwork the interactive
// RealisticSchematic uses, but with no pan/zoom, selection, or editing — so a
// landing page or thumbnail can show the *real* generated board rather than a
// hand-drawn stand-in. The SVG fits its box via the viewBox + meet, matching
// the "Fit" state of the live view.
import { useMemo } from 'react';
import { circuitToBreadboard } from './breadboardModel.js';
import { Breadboard } from './Breadboard.jsx';
import { BatteryPack, JumperWire, PartDefs, RealisticPart } from './parts.jsx';

export function BreadboardPreview({ circuit, className = '', ariaLabel }) {
  const model = useMemo(() => circuitToBreadboard(circuit, {}), [circuit]);

  return (
    <svg
      className={`breadboard-preview ${className}`.trim()}
      viewBox={`0 0 ${model.board.width} ${model.board.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel ?? 'Realistic breadboard schematic'}
    >
      <PartDefs />
      <Breadboard board={model.board} rails={model.rails} />
      {model.parts.map((part) => (
        <RealisticPart key={part.ref} part={part} />
      ))}
      {model.batteries.map((battery, index) => (
        <BatteryPack key={battery.ref} battery={battery} index={index} />
      ))}
      {model.jumpers.map((jumper) => (
        <JumperWire key={jumper.id} jumper={jumper} />
      ))}
    </svg>
  );
}
