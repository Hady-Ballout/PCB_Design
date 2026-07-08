// The solderless-breadboard base artwork: plastic body, hole grid, power-rail
// stripes, and row/column labels. Purely presentational. Memoized so the
// ~400-circle hole grid doesn't re-render on every selection change.
import { memo } from 'react';
import {
  BOTTOM_STRIP_ROW_LETTERS,
  HOLE_PITCH,
  STRIP_BASE_ROW,
  STRIP_ROWS,
  TOP_STRIP_ROW_LETTERS,
  TRENCH_CENTER_Y,
  TRENCH_HALF_HEIGHT,
  boardBody,
  columnX,
  holeCenter,
} from './breadboardGeometry.js';

const RAIL_LABELS = [
  { strip: 'railTopPlus', sign: '+', color: '#c0392b', stripeOffset: -0.55 },
  { strip: 'railTopMinus', sign: '−', color: '#2465b0', stripeOffset: 0.55 },
  { strip: 'railBottomPlus', sign: '+', color: '#c0392b', stripeOffset: -0.55 },
  { strip: 'railBottomMinus', sign: '−', color: '#2465b0', stripeOffset: 0.55 },
];

function Holes({ columns }) {
  const holes = [];
  const strips = [
    ['railTopPlus', 1],
    ['railTopMinus', 1],
    ['top', 5],
    ['bottom', 5],
    ['railBottomPlus', 1],
    ['railBottomMinus', 1],
  ];
  strips.forEach(([strip, rows]) => {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 1; column <= columns; column += 1) {
        const { x, y } = holeCenter({ strip, column, row });
        holes.push(<circle key={`${strip}-${row}-${column}`} cx={x} cy={y} r={2.5} fill="url(#rsHole)" />);
      }
    }
  });
  return <g>{holes}</g>;
}

// Translucent glow over the tie-group columns and rail rows carrying the
// highlighted nets, tinted with each net's legend color (yellow fallback).
// Rendered between the board and the parts; never intercepts pointer events.
export function HighlightOverlay({ board, highlight, nets = [] }) {
  if (!highlight.active) return null;
  // Near-black ground reads as a shadow when tinted; use the − rail blue.
  const colorOf = (net) => {
    const entry = nets.find((candidate) => candidate.net === net);
    if (!entry) return '#ffc400';
    return entry.role === 'ground' ? '#2465b0' : entry.color;
  };
  const rects = [];
  highlight.groupKeys.forEach((key) => {
    const [strip, columnText] = key.split(':');
    const column = Number(columnText);
    const x = columnX(column);
    const top = STRIP_BASE_ROW[strip] * HOLE_PITCH;
    rects.push(
      <rect
        key={key}
        x={x - 6}
        y={top - 7}
        width={12}
        height={(STRIP_ROWS[strip] - 1) * HOLE_PITCH + 14}
        rx={6}
        fill={colorOf(highlight.groupKeyNets?.get(key))}
        opacity={0.3}
      />,
    );
  });
  highlight.railStrips.forEach((strip) => {
    const y = STRIP_BASE_ROW[strip] * HOLE_PITCH;
    rects.push(
      <rect
        key={strip}
        x={columnX(1) - 8}
        y={y - 7}
        width={columnX(board.columns) - columnX(1) + 16}
        height={14}
        rx={6}
        fill={colorOf(highlight.railStripNets?.get(strip))}
        opacity={0.3}
      />,
    );
  });
  return <g pointerEvents="none">{rects}</g>;
}

export const Breadboard = memo(function Breadboard({ board, rails }) {
  const body = boardBody(board.columns);
  const firstX = columnX(1);
  const lastX = columnX(board.columns);
  return (
    <g>
      <defs>
        <linearGradient id="rsBoard" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2ecdd" />
          <stop offset="0.5" stopColor="#eae3d1" />
          <stop offset="1" stopColor="#ddd5c0" />
        </linearGradient>
        <radialGradient id="rsHole" cx="0.4" cy="0.35" r="0.9">
          <stop offset="0" stopColor="#4c5258" />
          <stop offset="0.6" stopColor="#23272b" />
          <stop offset="1" stopColor="#101214" />
        </radialGradient>
      </defs>
      {/* body with a soft drop shadow */}
      <rect x={body.x + 3} y={body.y + 4} width={body.width} height={body.height} rx={8} fill="rgba(30,35,30,0.18)" />
      <rect x={body.x} y={body.y} width={body.width} height={body.height} rx={8} fill="url(#rsBoard)" stroke="#c4bca6" strokeWidth="1" />
      {/* center trench for DIP packages */}
      <rect
        x={body.x + 3}
        y={TRENCH_CENTER_Y - TRENCH_HALF_HEIGHT}
        width={body.width - 6}
        height={TRENCH_HALF_HEIGHT * 2}
        fill="#d3cab2"
        stroke="#bfb69d"
        strokeWidth="0.6"
      />
      {/* rail stripes with their net assignments */}
      {RAIL_LABELS.map(({ strip, sign, color, stripeOffset }) => {
        const y = STRIP_BASE_ROW[strip] * HOLE_PITCH;
        const net = rails[strip];
        return (
          <g key={strip}>
            <line x1={firstX - 8} y1={y + stripeOffset * HOLE_PITCH} x2={lastX + 8} y2={y + stripeOffset * HOLE_PITCH} stroke={color} strokeWidth="1.6" opacity="0.85" />
            <text x={body.x + 7} y={y + 2.5} fontSize="8" fontFamily="Inter, Arial, sans-serif" fill={color} fontWeight="700">{sign}</text>
            {net != null && (
              <text x={lastX + 12} y={y + 2.5} fontSize="6.5" fontFamily="Inter, Arial, sans-serif" fill={color}>
                {net === '0' ? 'GND' : net}
              </text>
            )}
          </g>
        );
      })}
      {/* row letters */}
      {TOP_STRIP_ROW_LETTERS.map((letter, row) => (
        <text key={letter} x={body.x + 7} y={(STRIP_BASE_ROW.top + row) * HOLE_PITCH + 2.5} fontSize="6.5" fontFamily="Inter, Arial, sans-serif" fill="#a49b83">{letter}</text>
      ))}
      {BOTTOM_STRIP_ROW_LETTERS.map((letter, row) => (
        <text key={letter} x={body.x + 7} y={(STRIP_BASE_ROW.bottom + row) * HOLE_PITCH + 2.5} fontSize="6.5" fontFamily="Inter, Arial, sans-serif" fill="#a49b83">{letter}</text>
      ))}
      {/* column numbers every 5 */}
      {Array.from({ length: Math.floor(board.columns / 5) }, (_, index) => (index + 1) * 5).map((column) => (
        <text
          key={column}
          x={columnX(column)}
          y={(STRIP_BASE_ROW.top - 0.75) * HOLE_PITCH}
          fontSize="6"
          fontFamily="Inter, Arial, sans-serif"
          fill="#a49b83"
          textAnchor="middle"
        >
          {column}
        </text>
      ))}
      <Holes columns={board.columns} />
    </g>
  );
});
