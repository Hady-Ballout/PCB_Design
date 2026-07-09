// Realistic SVG renderers for breadboard parts and jumper wires. Each renderer
// receives the placement-model part and draws leads from its exact hole
// positions up onto a photo-style body.
import { HOLE_PITCH, MCU_PIN_SPACING, TRENCH_CENTER_Y, holeCenter } from './breadboardGeometry.js';
import { MCU_PINS } from './breadboardModel.js';
import { BAND_COLOR_HEX, capStyle, ledColor, resistorColorBands } from './partVisuals.js';
import { pinLabelsFor } from './selectionModel.js';

const LEAD_STROKE = { stroke: '#8f979e', strokeWidth: 1.7, strokeLinecap: 'round', fill: 'none' };
const LABEL_STYLE = { fontSize: 7.5, fontFamily: 'Inter, Arial, sans-serif', fill: '#3c4640' };

// Direction the body sits relative to its holes: above on the top strip,
// below on the bottom strip, so bodies lean away from the trench.
const bodyDir = (strip) => (strip === 'bottom' ? 1 : -1);

const RefLabel = ({ x, y, text, light = false }) => (
  <text x={x} y={y} textAnchor="middle" style={LABEL_STYLE} fill={light ? '#f0f0ea' : LABEL_STYLE.fill}>
    {text}
  </text>
);

const Lead = ({ from, to }) => (
  <path d={`M ${from.x} ${from.y} L ${from.x} ${to.y} L ${to.x} ${to.y}`} {...LEAD_STROKE} />
);

// --- two-lead bodies ------------------------------------------------------

function ResistorBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 15;
  const mid = (a.x + b.x) / 2;
  const span = Math.abs(b.x - a.x);
  const length = Math.min(Math.max(span - 14, 26), 56);
  const x0 = mid - length / 2;
  const code = resistorColorBands(part.value);
  return (
    <g>
      <Lead from={a} to={{ x: x0 + 2, y }} />
      <Lead from={b} to={{ x: x0 + length - 2, y }} />
      <rect x={x0} y={y - 6} width={length} height={12} rx={5.5} fill="url(#rsPartResistor)" stroke="#a8895f" strokeWidth="0.6" />
      {code
        ? code.bands.map((band, index) => (
            <rect
              key={index}
              x={x0 + length * [0.18, 0.32, 0.46, 0.74][index]}
              y={y - 6}
              width={length * 0.07}
              height={12}
              fill={BAND_COLOR_HEX[band]}
            />
          ))
        : <text x={mid} y={y + 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6.5 }}>{part.value}</text>}
      <RefLabel x={mid} y={y + dir * 13} text={part.ref} />
    </g>
  );
}

function CapacitorBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 16;
  const mid = (a.x + b.x) / 2;
  const style = capStyle(part.value);
  if (style.type === 'electrolytic') {
    // Radial can; pin 1 is positive, so the pale minus stripe hugs the pin-2 side.
    const width = 20;
    const stripeX = b.x > a.x ? mid + width / 2 - 5 : mid - width / 2;
    return (
      <g>
        <Lead from={a} to={{ x: mid - 4, y: y + 8 }} />
        <Lead from={b} to={{ x: mid + 4, y: y + 8 }} />
        <rect x={mid - width / 2} y={y - 12} width={width} height={24} rx={4} fill="url(#rsPartCan)" stroke="#1b2947" strokeWidth="0.6" />
        <rect x={stripeX} y={y - 12} width={5} height={24} rx={2} fill="#d8dde6" opacity="0.85" />
        <RefLabel x={mid} y={y - 17} text={`${part.ref} · ${part.value}`} />
      </g>
    );
  }
  return (
    <g>
      <Lead from={a} to={{ x: mid - 4, y: y + 5 }} />
      <Lead from={b} to={{ x: mid + 4, y: y + 5 }} />
      <circle cx={mid} cy={y - 2} r={9.5} fill="url(#rsPartCeramic)" stroke="#b28a2e" strokeWidth="0.6" />
      <text x={mid} y={y + 0.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5 }} fill="#4a3c14">{part.value}</text>
      <RefLabel x={mid} y={y - 15} text={part.ref} />
    </g>
  );
}

function LedBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 17;
  const mid = (a.x + b.x) / 2;
  const { fill } = ledColor(part.value);
  const flatX = b.x > a.x ? mid + 8 : mid - 8; // flat side marks the cathode (pin 2)
  return (
    <g>
      <Lead from={a} to={{ x: mid - 3.5, y: y + 9 }} />
      <Lead from={b} to={{ x: mid + 3.5, y: y + 9 }} />
      <circle cx={mid} cy={y} r={9} fill={fill} stroke="rgba(0,0,0,0.35)" strokeWidth="0.7" />
      <circle cx={mid} cy={y} r={9} fill="url(#rsPartLens)" />
      <line x1={flatX} y1={y - 6} x2={flatX} y2={y + 6} stroke="rgba(0,0,0,0.4)" strokeWidth="1.4" />
      <ellipse cx={mid - 3} cy={y - 3.5} rx={2.6} ry={1.8} fill="rgba(255,255,255,0.75)" />
      <RefLabel x={mid} y={y - 14} text={part.ref} />
    </g>
  );
}

function DiodeBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 13;
  const mid = (a.x + b.x) / 2;
  const length = 26;
  const bandX = b.x > a.x ? mid + length / 2 - 6 : mid - length / 2 + 2;
  return (
    <g>
      <Lead from={a} to={{ x: mid - length / 2 + 2, y }} />
      <Lead from={b} to={{ x: mid + length / 2 - 2, y }} />
      <rect x={mid - length / 2} y={y - 5} width={length} height={10} rx={4} fill="url(#rsPartDiode)" stroke="#111" strokeWidth="0.5" />
      <rect x={bandX} y={y - 5} width={4} height={10} fill="#cfd4da" />
      <RefLabel x={mid} y={y + dir * 12} text={part.ref} />
    </g>
  );
}

function InductorBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 15;
  const mid = (a.x + b.x) / 2;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 8, y: y + 7 }} />
      <Lead from={b} to={{ x: mid + 8, y: y + 7 }} />
      <ellipse cx={mid} cy={y} rx={13} ry={10} fill="url(#rsPartDrum)" stroke="#1e5c38" strokeWidth="0.7" />
      <text x={mid} y={y + 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6 }} fill="#dff2e6">{part.value}</text>
      <RefLabel x={mid} y={y - 14} text={part.ref} />
    </g>
  );
}

// Fallback labeled module for loads, signal sources, and unknown kinds.
function ModuleBody({ part, points }) {
  const dir = bodyDir(part.strip);
  const xs = points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const mid = (minX + maxX) / 2;
  const y = Math.min(...points.map((point) => point.y)) + dir * 17;
  const width = Math.max(maxX - minX + 18, 34);
  return (
    <g>
      {points.map((point, index) => (
        <Lead key={index} from={point} to={{ x: Math.min(Math.max(point.x, mid - width / 2 + 4), mid + width / 2 - 4), y: y + 9 }} />
      ))}
      <rect x={mid - width / 2} y={y - 9} width={width} height={18} rx={3.5} fill="url(#rsPartModule)" stroke="#4d565e" strokeWidth="0.6" />
      <text x={mid} y={y - 0.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6 }} fill="#e8ecef">{part.ref}</text>
      <text x={mid} y={y + 6.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5 }} fill="#aeb7bd">{part.value}</text>
    </g>
  );
}

// --- multi-pin packages ---------------------------------------------------

function To92Body({ part, points }) {
  const dir = bodyDir(part.strip);
  const mid = points[1].x;
  const y = Math.min(...points.map((point) => point.y)) + dir * 19;
  const flatY = y + 8; // flat face toward the holes
  return (
    <g>
      {points.map((point, index) => (
        <path key={index} d={`M ${point.x} ${point.y} L ${mid + (index - 1) * 5} ${flatY}`} {...LEAD_STROKE} />
      ))}
      <path
        d={`M ${mid - 11} ${flatY} A 11 11 0 1 1 ${mid + 11} ${flatY} Z`}
        fill="url(#rsPartTo92)"
        stroke="#000"
        strokeWidth="0.5"
      />
      <RefLabel x={mid} y={y - 12} text={`${part.ref} · ${part.value}`} />
    </g>
  );
}

function To220Body({ part, points }) {
  const dir = bodyDir(part.strip);
  const mid = points[1].x;
  const y = Math.min(...points.map((point) => point.y)) + dir * 20;
  return (
    <g>
      {points.map((point, index) => (
        <path key={index} d={`M ${point.x} ${point.y} L ${mid + (index - 1) * 6} ${y + 10}`} {...LEAD_STROKE} />
      ))}
      <rect x={mid - 13} y={y - 16} width={26} height={7} rx={1} fill="url(#rsPartTab)" stroke="#7c848b" strokeWidth="0.4" />
      <circle cx={mid} cy={y - 12.5} r={2} fill="#e9edf0" stroke="#7c848b" strokeWidth="0.4" />
      <rect x={mid - 13} y={y - 10} width={26} height={20} rx={1.5} fill="url(#rsPartTo92)" stroke="#000" strokeWidth="0.5" />
      <text x={mid} y={y + 1} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5 }} fill="#cfd4d8">{part.value}</text>
      <RefLabel x={mid} y={y - 20} text={part.ref} />
    </g>
  );
}

function DipBody({ part }) {
  const left = holeCenter({ strip: 'top', column: part.meta.columnStart, row: 4 });
  const right = holeCenter({ strip: 'top', column: part.meta.columnEnd, row: 4 });
  const x0 = left.x - 5;
  const x1 = right.x + 5;
  const bodyTop = TRENCH_CENTER_Y - 13;
  const bodyBottom = TRENCH_CENTER_Y + 13;
  const legs = [];
  for (let column = part.meta.columnStart; column <= part.meta.columnEnd; column += 1) {
    const topHole = holeCenter({ strip: 'top', column, row: 4 });
    const bottomHole = holeCenter({ strip: 'bottom', column, row: 0 });
    legs.push(
      <rect key={`t${column}`} x={topHole.x - 1.6} y={topHole.y - 1} width={3.2} height={bodyTop - topHole.y + 2} fill="url(#rsPartTab)" />,
      <rect key={`b${column}`} x={bottomHole.x - 1.6} y={bodyBottom - 1} width={3.2} height={bottomHole.y - bodyBottom + 2} fill="url(#rsPartTab)" />,
    );
  }
  return (
    <g>
      {legs}
      <rect x={x0} y={bodyTop} width={x1 - x0} height={bodyBottom - bodyTop} rx={2} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.6" />
      {/* pin-1 notch on the left edge */}
      <path d={`M ${x0} ${TRENCH_CENTER_Y - 4} A 4 4 0 0 1 ${x0} ${TRENCH_CENTER_Y + 4}`} fill="#242a30" stroke="#000" strokeWidth="0.4" />
      <circle cx={x0 + 7} cy={bodyBottom - 5} r={1.6} fill="#151a1e" stroke="#3c444c" strokeWidth="0.5" />
      <text x={(x0 + x1) / 2 + 2} y={TRENCH_CENTER_Y - 1} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6.5, fontWeight: 600 }} fill="#f2f5f7">{part.ref}</text>
      <text x={(x0 + x1) / 2 + 2} y={TRENCH_CENTER_Y + 7} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5 }} fill="#c6ccd2">{part.value}</text>
    </g>
  );
}

// --- microcontroller boards ------------------------------------------------

// ESP32 is a wide DIP-style module straddling the trench, same construction
// as the opamp DIP-8 body just wider, plus a small "shield can" for the RF
// module and its own silkscreen label.
function Esp32Body({ part }) {
  const { columnStart, columnEnd } = part.meta;
  const left = holeCenter({ strip: 'top', column: columnStart, row: 4 });
  const right = holeCenter({ strip: 'top', column: columnEnd, row: 4 });
  const x0 = left.x - 5;
  const x1 = right.x + 5;
  const bodyTop = TRENCH_CENTER_Y - 16;
  const bodyBottom = TRENCH_CENTER_Y + 16;
  const legs = [];
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const topHole = holeCenter({ strip: 'top', column, row: 4 });
    const bottomHole = holeCenter({ strip: 'bottom', column, row: 0 });
    legs.push(
      <rect key={`t${column}`} x={topHole.x - 1.6} y={topHole.y - 1} width={3.2} height={bodyTop - topHole.y + 2} fill="url(#rsPartTab)" />,
      <rect key={`b${column}`} x={bottomHole.x - 1.6} y={bodyBottom - 1} width={3.2} height={bottomHole.y - bodyBottom + 2} fill="url(#rsPartTab)" />,
    );
  }
  return (
    <g>
      {legs}
      <rect x={x0} y={bodyTop} width={x1 - x0} height={bodyBottom - bodyTop} rx={2} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.6" />
      <rect x={(x0 + x1) / 2 - 12} y={TRENCH_CENTER_Y - 9} width={24} height={18} rx={1.5} fill="#7d868c" stroke="#000" strokeWidth="0.4" />
      <text x={(x0 + x1) / 2} y={TRENCH_CENTER_Y - 20} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6.5, fontWeight: 600 }} fill="#f2f5f7">{part.ref} · ESP32</text>
    </g>
  );
}

// Off-board pin position for the index-th header pad of a slotted MCU part.
function mcuPadPoint(slot, index) {
  return { x: slot.x + 20 + index * MCU_PIN_SPACING, y: slot.y + 22 };
}

// Colored wires fanning from each header pad to the breadboard/rail hole it
// resolved to. Painted last (after the body/header) so they visibly
// terminate at the pads instead of being hidden under the opaque body.
function McuPinWires({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  return (
    <g className="rs-mcu-wires">
      {part.holes.map((hole, index) => {
        if (!hole) return null;
        const pad = mcuPadPoint(slot, index);
        const target = holeCenter(hole);
        const color = part.meta.pinColors?.[index] || '#7d7d7d';
        const lift = Math.min(60, 22 + (index % 3) * 8);
        const c1 = { x: pad.x, y: pad.y - lift };
        const c2 = { x: target.x, y: target.y + lift };
        return (
          <g key={index}>
            <path d={`M ${pad.x} ${pad.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}`} stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="round" />
            <circle cx={target.x} cy={target.y} r={2} fill="#20262b" />
            <circle cx={pad.x} cy={pad.y} r={2} fill="#20262b" />
          </g>
        );
      })}
    </g>
  );
}

function McuHeader({ part }) {
  const slot = part.meta.slot;
  const pins = MCU_PINS[part.kind] || [];
  const width = pins.length * MCU_PIN_SPACING + 12;
  return (
    <g>
      <rect x={slot.x + 8} y={slot.y + 10} width={width} height={22} rx={2} fill="#1a1a1a" stroke="#000" strokeWidth="0.5" />
      {pins.map((label, index) => {
        const pad = mcuPadPoint(slot, index);
        return (
          <g key={label}>
            <rect x={pad.x - 3} y={pad.y - 3} width={6} height={6} fill="url(#rsGoldPad)" stroke="#8a6d14" strokeWidth="0.4" />
            <text x={pad.x} y={slot.y + 40} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5 }}>{label}</text>
          </g>
        );
      })}
    </g>
  );
}

function ArduinoUnoBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  return (
    <g>
      <rect x={slot.x} y={slot.y + 46} width={slot.width} height={slot.height - 46} rx={4} fill="url(#rsPartUno)" stroke="#0d3b33" strokeWidth="0.8" />
      <text x={slot.x + slot.width / 2} y={slot.y + slot.height / 2 + 20} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 9, fontWeight: 600 }} fill="#eaf6f0">{part.ref} · {part.value}</text>
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

function RaspberryPiBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  return (
    <g>
      <rect x={slot.x} y={slot.y + 46} width={slot.width} height={slot.height - 46} rx={4} fill="url(#rsPartPi)" stroke="#123d1a" strokeWidth="0.8" />
      <text x={slot.x + slot.width / 2} y={slot.y + slot.height / 2 + 20} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 9, fontWeight: 600 }} fill="#eafbea">{part.ref} · {part.value}</text>
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// --- battery + jumpers ----------------------------------------------------

export function BatteryPack({ battery, index }) {
  const x = 16;
  const y = 30 + index * 92;
  const width = 62;
  const height = 78;
  const plus = battery.plusHole ? holeCenter(battery.plusHole) : null;
  const minus = battery.minusHole ? holeCenter(battery.minusHole) : null;
  const terminalY = y + 6;
  return (
    <g>
      {plus && (
        <path
          d={`M ${x + width - 14} ${terminalY} C ${x + width + 30} ${terminalY - 18}, ${plus.x - 40} ${plus.y - 14}, ${plus.x} ${plus.y}`}
          stroke="#c0392b" strokeWidth="2.6" strokeLinecap="round" fill="none"
        />
      )}
      {minus && (
        <path
          d={`M ${x + 14} ${terminalY} C ${x + 50} ${terminalY - 6}, ${minus.x - 46} ${minus.y - 8}, ${minus.x} ${minus.y}`}
          stroke="#1f1f1f" strokeWidth="2.6" strokeLinecap="round" fill="none"
        />
      )}
      <rect x={x} y={y} width={width} height={height} rx={5} fill="url(#rsPartBattery)" stroke="#20262b" strokeWidth="0.8" />
      <rect x={x + width - 20} y={terminalY - 3.5} width={7} height={7} rx={1.5} fill="#d8b13a" stroke="#8a6d14" strokeWidth="0.5" />
      <circle cx={x + 17} cy={terminalY} r={4.4} fill="#d0d5d9" stroke="#6d757c" strokeWidth="0.6" />
      <text x={x + width / 2} y={y + height / 2 + 2} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 9 }} fill="#f0ede4" fontWeight="600">
        {battery.value || '?V'}
      </text>
      <text x={x + width / 2} y={y + height - 8} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6 }} fill="#c9c4b6">{battery.ref}</text>
      <text x={x + width - 16} y={terminalY - 7} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8 }} fill="#f0ede4">+</text>
      <text x={x + 17} y={terminalY - 8} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8 }} fill="#f0ede4">−</text>
    </g>
  );
}

const stripSide = (strip) => (strip === 'bottom' || strip.startsWith('railBottom') ? 'bottom' : 'top');

export function JumperWire({ jumper }) {
  const a = holeCenter(jumper.from);
  const b = holeCenter(jumper.to);
  const sides = [stripSide(jumper.from.strip), stripSide(jumper.to.strip)];
  const span = Math.abs(b.x - a.x);
  // Deterministic per-jumper stagger so parallel wires don't overlap exactly.
  const stagger = (Number(jumper.id.slice(1)) % 3) * 5;
  const lift = Math.min(46, 16 + span * 0.14 + Math.abs(b.y - a.y) * 0.18) + stagger;
  let c1;
  let c2;
  if (span < HOLE_PITCH) {
    // Same-column bridge: a straight-across curve would overshoot the rails
    // and strike through the net-name labels past the right edge. Bow
    // sideways instead, and pull each control point toward the opposite
    // endpoint's y so the curve never leaves the endpoints' vertical span.
    // Rail-to-rail bridges only occur at the rightmost column, so they bow
    // left (into the board); same-column rail-to-strip stubs bow right.
    const bow = sides[0] !== sides[1] ? -(16 + stagger) : 8 + stagger;
    c1 = { x: a.x + bow, y: a.y + (b.y - a.y) * 0.2 };
    c2 = { x: b.x + bow, y: b.y - (b.y - a.y) * 0.2 };
  } else {
    const direction1 = sides[0] === 'bottom' ? 1 : -1;
    const direction2 = sides[1] === 'bottom' ? 1 : -1;
    c1 = { x: a.x, y: a.y + direction1 * lift };
    c2 = { x: b.x, y: b.y + direction2 * lift };
  }
  const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
  return (
    <g>
      {/* invisible wide hit area — the visible 2.7px stroke is too thin to click */}
      <path d={d} stroke="transparent" strokeWidth="10" fill="none" pointerEvents="stroke" />
      <path d={d} stroke={jumper.color} strokeWidth="2.7" strokeLinecap="round" fill="none" />
      <circle cx={a.x} cy={a.y} r={2} fill="#20262b" />
      <circle cx={b.x} cy={b.y} r={2} fill="#20262b" />
    </g>
  );
}

// Small labels beside a selected part's holes (opamp IN+/OUT…, BJT C/B/E,
// LED A/K, …). Rendered above everything; never intercepts pointer events.
export function PinLabels({ part }) {
  const labels = pinLabelsFor(part);
  if (!labels) return null;
  return (
    <g pointerEvents="none">
      {part.holes.map((hole, index) => {
        if (!hole || labels[index] == null) return null;
        const point = holeCenter(hole);
        // Chips sit opposite the body: away from the trench for DIPs, toward
        // the trench for everything else.
        const chipDy = part.body === 'dip'
          ? (hole.strip === 'top' ? -11 : 11)
          : (hole.strip === 'bottom' ? -11 : 11);
        const y = point.y + chipDy;
        const width = Math.max(12, labels[index].length * 5 + 6);
        return (
          <g key={index}>
            <rect x={point.x - width / 2} y={y - 5} width={width} height={10} rx={3} fill="rgba(255,255,255,0.94)" stroke="#8a8f86" strokeWidth="0.5" />
            <text x={point.x} y={y + 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fontWeight: 600 }}>{labels[index]}</text>
          </g>
        );
      })}
    </g>
  );
}

// Shared gradients used by the part bodies; render once inside the SVG <defs>.
export function PartDefs() {
  return (
    <defs>
      <linearGradient id="rsPartResistor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e8cfa4" />
        <stop offset="0.5" stopColor="#d8b787" />
        <stop offset="1" stopColor="#b99764" />
      </linearGradient>
      <linearGradient id="rsPartCan" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#3d5a94" />
        <stop offset="0.5" stopColor="#22355c" />
        <stop offset="1" stopColor="#16243f" />
      </linearGradient>
      <radialGradient id="rsPartCeramic" cx="0.35" cy="0.35" r="0.9">
        <stop offset="0" stopColor="#f2cf6e" />
        <stop offset="1" stopColor="#d9a93a" />
      </radialGradient>
      <radialGradient id="rsPartLens" cx="0.35" cy="0.3" r="1">
        <stop offset="0" stopColor="rgba(255,255,255,0.5)" />
        <stop offset="0.55" stopColor="rgba(255,255,255,0.08)" />
        <stop offset="1" stopColor="rgba(0,0,0,0.25)" />
      </radialGradient>
      <linearGradient id="rsPartDiode" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#3a3f45" />
        <stop offset="0.5" stopColor="#17191c" />
        <stop offset="1" stopColor="#0b0c0e" />
      </linearGradient>
      <radialGradient id="rsPartDrum" cx="0.4" cy="0.35" r="0.95">
        <stop offset="0" stopColor="#4fa872" />
        <stop offset="1" stopColor="#2a6b45" />
      </radialGradient>
      <linearGradient id="rsPartModule" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#5d666e" />
        <stop offset="1" stopColor="#39424a" />
      </linearGradient>
      <linearGradient id="rsPartTo92" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#3a4046" />
        <stop offset="0.5" stopColor="#1c2125" />
        <stop offset="1" stopColor="#101316" />
      </linearGradient>
      <linearGradient id="rsPartDip" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#383f46" />
        <stop offset="0.5" stopColor="#1f2429" />
        <stop offset="1" stopColor="#14171b" />
      </linearGradient>
      <linearGradient id="rsPartTab" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#d7dde2" />
        <stop offset="1" stopColor="#9aa3ab" />
      </linearGradient>
      <linearGradient id="rsPartBattery" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2f3a42" />
        <stop offset="0.12" stopColor="#22292f" />
        <stop offset="1" stopColor="#161b1f" />
      </linearGradient>
      <linearGradient id="rsPartUno" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#1a7a63" />
        <stop offset="1" stopColor="#0f4a3c" />
      </linearGradient>
      <linearGradient id="rsPartPi" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2f9e44" />
        <stop offset="1" stopColor="#1c5e29" />
      </linearGradient>
      <radialGradient id="rsGoldPad" cx="0.35" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#f2d375" />
        <stop offset="1" stopColor="#c79a2e" />
      </radialGradient>
    </defs>
  );
}

const BODY_RENDERERS = {
  resistor: ResistorBody,
  capacitor: CapacitorBody,
  led: LedBody,
  diode: DiodeBody,
  inductor: InductorBody,
};

export function RealisticPart({ part }) {
  // Off-board MCU boards draw their body/header regardless of whether any
  // pin is actually wired, so check them before the zero-pins bail-out.
  if (part.body === 'arduino_uno') return <ArduinoUnoBody part={part} />;
  if (part.body === 'raspberry_pi') return <RaspberryPiBody part={part} />;
  const points = part.holes.map((hole) => (hole ? holeCenter(hole) : null)).filter(Boolean);
  if (points.length === 0) return null;
  if (part.body === 'esp32') return <Esp32Body part={part} />;
  if (part.body === 'dip') return <DipBody part={part} />;
  if (part.body === 'to92') return <To92Body part={part} points={points} />;
  if (part.body === 'to220') return <To220Body part={part} points={points} />;
  const Renderer = (part.body === 'twoLead' && BODY_RENDERERS[part.kind]) || ModuleBody;
  return <Renderer part={part} points={points} />;
}
