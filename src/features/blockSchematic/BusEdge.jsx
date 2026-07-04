import { BaseEdge } from '@xyflow/react';

// Horizontal gap between the blocks' right edge and the first bus lane, plus the
// spacing between adjacent lanes. Each net owns one lane so vertical runs never overlap.
const LANE_MARGIN = 40;
const LANE_GAP = 16;

// Read-only orthogonal edge: exit the source pin rightward into this net's dedicated
// vertical lane, drop to the target's row, then return left to the target pin.
export function BusEdge({ id, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }) {
  const laneIndex = data?.laneIndex ?? 0;
  const color = data?.color ?? '#94a3b5';
  const laneX = Math.max(sourceX, targetX) + LANE_MARGIN + laneIndex * LANE_GAP;

  const path = `M ${sourceX} ${sourceY} L ${laneX} ${sourceY} L ${laneX} ${targetY} L ${targetX} ${targetY}`;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{ stroke: color, strokeWidth: selected ? 3 : 1.6 }}
    />
  );
}
