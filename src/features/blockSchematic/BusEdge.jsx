import { BaseEdge, useStore } from '@xyflow/react';

// Horizontal gap between the blocks' right edge and the first bus lane, plus the
// spacing between adjacent lanes. Each net owns one lane so vertical runs never overlap.
const LANE_MARGIN = 40;
const LANE_GAP = 16;

// Read-only orthogonal edge: exit the source pin rightward into this net's dedicated
// vertical lane, drop to the target's row, then return left to the target pin.
export function BusEdge({ id, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }) {
  const laneIndex = data?.laneIndex ?? 0;
  const color = data?.color ?? '#94a3b5';
  // Anchor every lane to a single shared origin (the right edge of the widest
  // block) rather than this edge's own endpoints, so a net's segments stay in one
  // lane and distinct nets never share an x position.
  const globalRight = useStore((state) => {
    let max = -Infinity;
    for (const node of state.nodeLookup.values()) {
      const x = node.internals?.positionAbsolute?.x ?? node.position?.x ?? 0;
      const nodeWidth = node.measured?.width ?? node.width ?? 0;
      if (Number.isFinite(x + nodeWidth)) max = Math.max(max, x + nodeWidth);
    }
    return max;
  });
  const laneBase = Number.isFinite(globalRight) ? globalRight : Math.max(sourceX, targetX);
  const laneX = laneBase + LANE_MARGIN + laneIndex * LANE_GAP;

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
