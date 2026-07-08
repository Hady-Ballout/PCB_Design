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

// --- reusable board-realism primitives ------------------------------------
// Flat Fritzing-style detail glyphs shared by the MCU board bodies (Uno now,
// Pi/ESP32 later). All are pure and positioned by their callers in fractions
// of the board box so they survive the slot-width variance.

const Silk = ({ x, y, text, size = 5, fill = '#eaf1f4', weight, anchor = 'middle' }) => (
  <text
    x={x}
    y={y}
    textAnchor={anchor}
    style={{ ...LABEL_STYLE, fontSize: size, fontWeight: weight, letterSpacing: 0.2 }}
    fill={fill}
    pointerEvents="none"
  >
    {text}
  </text>
);

const SilkLine = (props) => (
  <path fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={0.9} strokeLinecap="round" {...props} />
);

// Square gold header/GPIO pad centered on (x, y).
const GoldPad = ({ x, y, s = 4 }) => (
  <rect x={x - s / 2} y={y - s / 2} width={s} height={s} rx={0.6} fill="url(#rsGoldPad)" stroke="#8a6d14" strokeWidth={0.5} />
);

// Tiny SMD indicator LED with a subtle (not glossy) lens sheen.
const SmdLed = ({ cx, cy, color, w = 5, h = 3 }) => (
  <g>
    <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={0.8} fill={color} stroke="rgba(0,0,0,0.35)" strokeWidth={0.4} />
    <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={0.8} fill="url(#rsPartLens)" opacity={0.5} />
  </g>
);

// Silver tactile button: metal frame with a dark round plunger.
const TactButton = ({ x, y, s = 5 }) => (
  <g>
    <rect x={x} y={y} width={s} height={s} rx={0.8} fill="url(#rsPartTab)" stroke="#7c848b" strokeWidth={0.4} />
    <circle cx={x + s / 2} cy={y + s / 2} r={s * 0.28} fill="#15181c" />
  </g>
);

// Brushed-metal shielded connector (USB-B etc.) with a top seam and an optional
// front cavity notch.
const MetalConnector = ({ x, y, w, h, notch = false }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={1.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth={0.5} />
    <line x1={x + 1.5} y1={y + 2} x2={x + w - 1.5} y2={y + 2} stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
    {notch && <rect x={x + w * 0.22} y={y + h * 0.32} width={w * 0.56} height={h * 0.5} rx={1} fill="#20262b" />}
  </g>
);

// IC package (DIP/SoC) with a pin-1 dot and a silkscreen label.
const Chip = ({ x, y, w, h, label, sub }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={1.5} fill="url(#rsPartDip)" stroke="#000" strokeWidth={0.5} />
    <circle cx={x + 3.2} cy={y + 3.2} r={1.2} fill="#0e1114" stroke="#3c444c" strokeWidth={0.4} />
    {label && <Silk x={x + w / 2} y={y + h / 2 + 0.5} text={label} size={Math.min(5, h * 0.4)} fill="#d3d9de" weight={600} />}
    {sub && <Silk x={x + w / 2} y={y + h / 2 + 6} text={sub} size={4} fill="#9aa3ab" />}
  </g>
);

// Through-hole mounting hole: copper annular ring around a dark bore.
const MountHole = ({ cx, cy, r = 4 }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} fill="url(#rsCopperRing)" stroke="#7a5a2e" strokeWidth={0.4} />
    <circle cx={cx} cy={cy} r={r * 0.5} fill="#12161a" />
  </g>
);

// Small metal-can crystal (16 MHz on the Uno) — silver oval can.
const Crystal = ({ cx, cy, w = 18, h = 9 }) => (
  <g>
    <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth={0.5} />
    <ellipse cx={cx} cy={cy} rx={w / 2 - 2} ry={h / 2 - 1.6} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.4} />
    <Silk x={cx} y={cy + 1.6} text="16MHz" size={3.4} fill="#3c4640" />
  </g>
);

// 2xN ICSP-style pin block (black plastic base + square gold pads).
const IcspHeader = ({ x, y, cols = 3, rows = 2, pitch = 4.4 }) => (
  <g>
    <rect x={x - 1.5} y={y - 1.5} width={(cols - 1) * pitch + 3} height={(rows - 1) * pitch + 3} rx={0.8} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth={0.3} />
    {Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => <GoldPad key={`${r}-${c}`} x={x + c * pitch} y={y + r * pitch} s={2.6} />),
    )}
  </g>
);

// Black electrolytic capacitor can, top view: silver top + polarity notch.
const ElectroCap = ({ cx, cy, r = 9 }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} fill="#111417" stroke="#000" strokeWidth={0.5} />
    <circle cx={cx} cy={cy} r={r - 1.6} fill="url(#rsBrushedShield)" opacity={0.85} />
    <path d={`M ${cx} ${cy} L ${cx - r + 1.6} ${cy}`} stroke="#3c4147" strokeWidth={0.6} />
    <path d={`M ${cx} ${cy} L ${cx + (r - 1.6) * 0.5} ${cy - (r - 1.6) * 0.86}`} stroke="#3c4147" strokeWidth={0.6} />
  </g>
);

// Arduino infinity mark: two ribbon loops with a + over the right, − over the left.
const ArduinoLogo = ({ cx, cy, r = 5 }) => (
  <g stroke="#eef6f6" strokeWidth={1.4} fill="none" strokeLinecap="round" pointerEvents="none">
    <circle cx={cx - r - 1} cy={cy} r={r} />
    <circle cx={cx + r + 1} cy={cy} r={r} />
    <line x1={cx - r - 1 - 2} y1={cy} x2={cx - r - 1 + 2} y2={cy} />
    <line x1={cx + r + 1 - 2} y1={cy} x2={cx + r + 1 + 2} y2={cy} />
    <line x1={cx + r + 1} y1={cy - 2} x2={cx + r + 1} y2={cy + 2} />
  </g>
);

// Stylized Raspberry Pi mark: a cluster of berry dots under two leaves.
const RaspberryLogo = ({ cx, cy, r = 2 }) => {
  const berries = [
    [0, 1.6], [-1.5, 0.6], [1.5, 0.6], [-0.8, -0.7], [0.8, -0.7], [0, -0.1],
  ];
  return (
    <g fill="#eef6f6" pointerEvents="none">
      {/* two leaves */}
      <ellipse cx={cx - 1.6 * r} cy={cy - 3.2 * r} rx={r * 1.5} ry={r * 0.8} transform={`rotate(-35 ${cx - 1.6 * r} ${cy - 3.2 * r})`} />
      <ellipse cx={cx + 1.6 * r} cy={cy - 3.2 * r} rx={r * 1.5} ry={r * 0.8} transform={`rotate(35 ${cx + 1.6 * r} ${cy - 3.2 * r})`} />
      {berries.map(([dx, dy], i) => <circle key={i} cx={cx + dx * r} cy={cy + dy * r} r={r * 0.72} />)}
    </g>
  );
};

// Flat-flex ribbon connector (DISPLAY / CAMERA): dark base + a silver latch bar.
const FpcConnector = ({ x, y, w, h }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={0.8} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth={0.4} />
    <rect x={x + 0.8} y={y + 0.8} width={w - 1.6} height={h * 0.32} rx={0.5} fill="url(#rsPartTab)" opacity={0.9} />
  </g>
);

// Metal port with a colored plastic tongue (USB-3 blue, micro-HDMI orange…).
const PortWithTongue = ({ x, y, w, h, tongue }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={1.2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth={0.5} />
    <rect x={x + w * 0.18} y={y + h * 0.34} width={w * 0.64} height={h * 0.42} rx={0.6} fill={tongue} />
  </g>
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

function Esp32Body({ part }) {
  const left = holeCenter({ strip: 'top', column: part.meta.columnStart, row: 4 });
  const right = holeCenter({ strip: 'top', column: part.meta.columnEnd, row: 4 });
  const x0 = left.x - 10;
  const x1 = right.x + 10;
  const bodyTop = TRENCH_CENTER_Y - 24;
  const bodyBottom = TRENCH_CENTER_Y + 24;
  const mw = x1 - x0;
  const mh = bodyBottom - bodyTop;
  const ex = (f) => x0 + mw * f;
  const ey = (f) => bodyTop + mh * f;
  const shieldX0 = ex(0.13);
  const shieldX1 = ex(0.52);
  // gold castellated header pads where each pin column meets the long edges
  const pads = [];
  for (let column = part.meta.columnStart; column <= part.meta.columnEnd; column += 1) {
    const cx = holeCenter({ strip: 'top', column, row: 4 }).x;
    pads.push(
      <GoldPad key={`pt${column}`} x={cx} y={bodyTop + 2.6} s={3} />,
      <GoldPad key={`pb${column}`} x={cx} y={bodyBottom - 2.6} s={3} />,
    );
  }
  return (
    <g>
      {/* matte-black ESP32 DevKit PCB with a flat inset bevel */}
      <rect x={x0} y={bodyTop} width={mw} height={mh} rx={3} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.6" />
      <rect x={x0 + 1.4} y={bodyTop + 1.4} width={mw - 2.8} height={mh - 2.8} rx={2.4} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.6" />
      {pads}
      {/* gold PCB antenna meander at the far-left end */}
      <path
        d={`M ${ex(0.03)} ${ey(0.28)} v ${mh * 0.44} h ${mw * 0.028} v ${-mh * 0.44} h ${mw * 0.028} v ${mh * 0.44} h ${mw * 0.028} v ${-mh * 0.44}`}
        stroke="#c8a23a" strokeWidth="1.1" fill="none"
      />
      {/* ESP-WROOM-32 RF shield can (brushed metal) with a seam + silk */}
      <rect x={shieldX0} y={ey(0.14)} width={shieldX1 - shieldX0} height={mh * 0.72} rx={1.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <line x1={shieldX0 + 1.5} y1={ey(0.23)} x2={shieldX1 - 1.5} y2={ey(0.23)} stroke="rgba(255,255,255,0.5)" strokeWidth="0.4" />
      <Silk x={(shieldX0 + shieldX1) / 2} y={ey(0.54)} text="ESP32" size={5} weight={700} fill="#3c4640" />
      <Silk x={(shieldX0 + shieldX1) / 2} y={ey(0.72)} text="WROOM-32" size={2.8} fill="#5a636b" />
      {/* carrier: CP2102 USB-UART + AMS1117 regulator (tab up) */}
      <Chip x={ex(0.58)} y={ey(0.4)} w={mw * 0.1} h={mh * 0.26} />
      <rect x={ex(0.72)} y={ey(0.22)} width={mw * 0.07} height={mh * 0.16} rx={0.6} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.4" />
      <rect x={ex(0.72)} y={ey(0.22) - 2} width={mw * 0.07} height={2} fill="url(#rsPartTab)" />
      {/* EN + BOOT tactile buttons */}
      <TactButton x={ex(0.56)} y={ey(0.12)} s={4.4} />
      <TactButton x={ex(0.56)} y={ey(0.74)} s={4.4} />
      {/* power (red) + user (blue) LEDs */}
      <SmdLed cx={ex(0.85)} cy={ey(0.3)} color="#e0453a" w={3.4} h={2.2} />
      <SmdLed cx={ex(0.85)} cy={ey(0.68)} color="#3f8fe8" w={3.4} h={2.2} />
      {/* micro-USB at the right end */}
      <MetalConnector x={x1 - 15} y={ey(0.36)} w={17} h={mh * 0.28} notch />
      <Silk x={ex(0.85)} y={ey(0.52)} text={part.ref} size={3.4} fill="#cfe4e6" />
    </g>
  );
}

// --- off-board MCU boards ---------------------------------------------------
// Arduino Uno and Raspberry Pi sit in fixed slots below the breadboard
// (part.meta.slot); their header pads along the board's top edge fan wires
// upward to the placement holes.

const mcuPadPoint = (slot, index) => ({ x: slot.x + 24 + index * MCU_PIN_SPACING, y: slot.y + 18 });

function McuPinWires({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  return (
    <g className="rs-mcu-wires">
      {part.holes.map((hole, index) => {
        if (!hole) return null;
        const pad = mcuPadPoint(slot, index);
        const target = holeCenter(hole);
        // Same visual family as JumperWire: cubic curve with a small
        // deterministic per-pin stagger so neighbouring wires don't overlap.
        const lift = 22 + (index % 3) * 5;
        const d = `M ${pad.x} ${pad.y} C ${pad.x} ${pad.y - lift}, ${target.x} ${target.y + lift}, ${target.x} ${target.y}`;
        return (
          <g key={index}>
            <path d={d} stroke={part.meta.pinColors?.[index] || '#7d7d7d'} strokeWidth="2.7" strokeLinecap="round" fill="none" />
            <circle cx={pad.x} cy={pad.y} r={2} fill="#20262b" />
            <circle cx={target.x} cy={target.y} r={2} fill="#20262b" />
          </g>
        );
      })}
    </g>
  );
}

function McuHeader({ part, light = false }) {
  const slot = part.meta.slot;
  const names = MCU_PINS[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  if (pinCount === 0) return null;
  const first = mcuPadPoint(slot, 0);
  const last = mcuPadPoint(slot, pinCount - 1);
  return (
    <g>
      {/* black plastic pin-header strip with a top highlight edge */}
      <rect x={first.x - 9} y={first.y - 5} width={last.x - first.x + 18} height={10} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      <line x1={first.x - 8} y1={first.y - 4} x2={last.x + 8} y2={first.y - 4} stroke="rgba(255,255,255,0.16)" strokeWidth="0.5" />
      {Array.from({ length: pinCount }, (_, index) => {
        const pad = mcuPadPoint(slot, index);
        return (
          <g key={index}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y + 13.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 4.6 }} fill={light ? '#e9ede8' : '#f0f0ea'}>
              {names[index] ?? index + 1}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ArduinoUnoBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const names = MCU_PINS[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  // The board is sized to contain its functional top header at a true Uno
  // aspect ratio (~1.285:1), left-anchored under the header pads. All detail is
  // placed in board-fraction coordinates so it survives the slot-width variance.
  const bx0 = slot.x;
  const by0 = slot.y + 3;
  const bw = mcuPadPoint(slot, Math.max(pinCount - 1, 1)).x + 24 - bx0;
  const bh = Math.min(bw / 1.285, slot.height - 10);
  const fx = (f) => bx0 + bw * f;
  const fy = (f) => by0 + bh * f;
  // ATmega328P DIP-28 (horizontal, in a socket) center-right.
  const chipX = fx(0.5);
  const chipY = fy(0.44);
  const chipW = bw * 0.34;
  const chipH = bh * 0.26;
  const legPitch = chipW / 14;
  return (
    <g>
      {/* teal soldermask board with a flat inset bevel (no shadow / gloss) */}
      <rect x={bx0} y={by0} width={bw} height={bh} rx={8} fill="url(#rsPartUno)" stroke="#014449" strokeWidth="0.9" />
      <rect x={bx0 + 1.6} y={by0 + 1.6} width={bw - 3.2} height={bh - 3.2} rx={7} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="0.7" />

      {/* mounting holes (Uno's asymmetric positions) */}
      <MountHole cx={fx(0.045)} cy={fy(0.13)} r={3.6} />
      <MountHole cx={fx(0.045)} cy={fy(0.9)} r={3.6} />
      <MountHole cx={fx(0.9)} cy={fy(0.12)} r={3.6} />
      <MountHole cx={fx(0.96)} cy={fy(0.9)} r={3.6} />

      {/* USB-B (metal, notched) and DC barrel jack overhang the left edge */}
      <MetalConnector x={bx0 - 10} y={fy(0.1)} w={40} h={bh * 0.22} notch />
      <g>
        <rect x={bx0 - 10} y={fy(0.62)} width={30} height={bh * 0.22} rx={4} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.5" />
        <circle cx={bx0 - 10 + 9} cy={fy(0.62) + bh * 0.11} r={4.5} fill="#0b0d0f" stroke="#2a2f34" strokeWidth="0.6" />
      </g>

      {/* voltage regulator (SOT-223: black body + silver tab), near the barrel jack */}
      <rect x={fx(0.15)} y={fy(0.67) - 3} width={bw * 0.05} height={3} rx={0.6} fill="url(#rsPartTab)" />
      <rect x={fx(0.15)} y={fy(0.67)} width={bw * 0.05} height={bh * 0.07} rx={0.6} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.4" />

      {/* 16 MHz crystal + two electrolytic capacitors near the lower-left */}
      <Crystal cx={fx(0.27)} cy={fy(0.66)} />
      <ElectroCap cx={fx(0.4)} cy={fy(0.78)} r={bh * 0.05} />
      <ElectroCap cx={fx(0.49)} cy={fy(0.78)} r={bh * 0.05} />

      {/* ATmega16U2 USB controller (small QFP) + its ICSP header, by the USB */}
      <Chip x={fx(0.14)} y={fy(0.4)} w={bw * 0.05} h={bh * 0.09} />
      <IcspHeader x={fx(0.16)} y={fy(0.2)} />

      {/* ATmega328P DIP-28 in a socket, with legs + pin-1 notch + its ICSP */}
      <rect x={chipX - 2} y={chipY - 2} width={chipW + 4} height={chipH + 4} rx={1.5} fill="#0c0f12" opacity="0.6" />
      {Array.from({ length: 14 }, (_, i) => (
        <g key={i}>
          <rect x={chipX + i * legPitch + legPitch * 0.2} y={chipY - 3.5} width={legPitch * 0.5} height={3.5} fill="url(#rsPartTab)" />
          <rect x={chipX + i * legPitch + legPitch * 0.2} y={chipY + chipH} width={legPitch * 0.5} height={3.5} fill="url(#rsPartTab)" />
        </g>
      ))}
      <Chip x={chipX} y={chipY} w={chipW} h={chipH} label="ATMEGA328P" />
      <path d={`M ${chipX + chipW / 2 - 3} ${chipY} A 3 3 0 0 1 ${chipX + chipW / 2 + 3} ${chipY}`} fill="#0c0f12" />
      <IcspHeader x={fx(0.9)} y={fy(0.44)} />

      {/* reset button near the top-left, below the digital header */}
      <TactButton x={fx(0.18)} y={fy(0.13)} s={7} />
      <Silk x={fx(0.18) + 3.5} y={fy(0.13) - 2} text="RESET" size={3} fill="#bcdedf" />

      {/* status LEDs: L + ON by the logo, TX/RX by the USB */}
      <SmdLed cx={fx(0.62)} cy={fy(0.26)} color="#3dcc6d" />
      <Silk x={fx(0.62)} y={fy(0.26) - 4} text="ON" size={3.4} fill="#cfe4e6" />
      <SmdLed cx={fx(0.5)} cy={fy(0.24)} color="#f4d03f" />
      <Silk x={fx(0.5)} y={fy(0.24) - 4} text="L" size={3.4} fill="#cfe4e6" />
      <SmdLed cx={fx(0.28)} cy={fy(0.44)} color="#f4d03f" />
      <Silk x={fx(0.28) - 8} y={fy(0.44) + 1.4} text="TX" size={3.4} fill="#cfe4e6" anchor="end" />
      <SmdLed cx={fx(0.28)} cy={fy(0.5)} color="#f4d03f" />
      <Silk x={fx(0.28) - 8} y={fy(0.5) + 1.4} text="RX" size={3.4} fill="#cfe4e6" anchor="end" />

      {/* silkscreen: logo + wordmarks + section labels */}
      <ArduinoLogo cx={fx(0.44)} cy={fy(0.36)} r={5} />
      <Silk x={fx(0.44)} y={fy(0.36) + 12} text="ARDUINO" size={7} weight={700} fill="#eef6f6" />
      <text x={fx(0.62)} y={fy(0.4)} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 13, fontWeight: 800 }} fill="none" stroke="#eef6f6" strokeWidth="0.7">UNO</text>
      <Silk x={fx(0.5)} y={fy(0.17)} text="DIGITAL (PWM~)" size={4} fill="#cfe4e6" />
      <Silk x={fx(0.3)} y={fy(0.95)} text="POWER" size={4} fill="#cfe4e6" />
      <Silk x={fx(0.72)} y={fy(0.95)} text="ANALOG IN" size={4} fill="#cfe4e6" />
      <Silk x={fx(0.82)} y={fy(0.58)} text="WWW.ARDUINO.CC" size={3.2} fill="#bcdedf" />

      {/* decorative bottom power + analog headers (top header is the functional one) */}
      <g>
        <rect x={fx(0.14)} y={fy(0.86)} width={bw * 0.3} height={7} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
        <rect x={fx(0.56)} y={fy(0.86)} width={bw * 0.26} height={7} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
        {Array.from({ length: 8 }, (_, i) => <GoldPad key={`p${i}`} x={fx(0.16) + i * (bw * 0.037)} y={fy(0.86) + 3.5} s={3.4} />)}
        {Array.from({ length: 6 }, (_, i) => <GoldPad key={`a${i}`} x={fx(0.58) + i * (bw * 0.037)} y={fy(0.86) + 3.5} s={3.4} />)}
      </g>

      {/* functional top digital header (where wires attach) */}
      <McuHeader part={part} />
      <Silk x={fx(0.85)} y={fy(0.3)} text={`${part.ref}${part.value ? ` · ${part.value}` : ''}`} size={4} fill="#bce0e2" />
      {/* pin wires last so they visibly terminate on the header pads instead
          of vanishing under the opaque board body */}
      <McuPinWires part={part} />
    </g>
  );
}

function RaspberryPiBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const names = MCU_PINS[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  // Faithful Pi 4 Model B: a landscape ~1.5:1 board filling the tall slot,
  // left-anchored under the functional GPIO header. Board-fraction coordinates.
  const bx0 = slot.x;
  const by0 = slot.y + 3;
  const bh = slot.height - 16;
  const bw = bh * 1.5;
  const fx = (f) => bx0 + bw * f;
  const fy = (f) => by0 + bh * f;
  const first = mcuPadPoint(slot, 0);
  const last = mcuPadPoint(slot, Math.max(pinCount - 1, 1));
  return (
    <g>
      {/* green soldermask board with a flat inset bevel */}
      <rect x={bx0} y={by0} width={bw} height={bh} rx={9} fill="url(#rsPartPi)" stroke="#0f4a29" strokeWidth="0.9" />
      <rect x={bx0 + 1.6} y={by0 + 1.6} width={bw - 3.2} height={bh - 3.2} rx={8} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.7" />

      {/* mounting holes (58x49 rectangle, inboard of the port overhangs) */}
      <MountHole cx={fx(0.04)} cy={fy(0.11)} r={3.6} />
      <MountHole cx={fx(0.04)} cy={fy(0.9)} r={3.6} />
      <MountHole cx={fx(0.63)} cy={fy(0.11)} r={3.6} />
      <MountHole cx={fx(0.63)} cy={fy(0.9)} r={3.6} />

      {/* 2-row GPIO header backing behind the functional row */}
      <rect x={first.x - 9} y={first.y - 6} width={last.x - first.x + 18} height={15} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      {Array.from({ length: pinCount }, (_, i) => <GoldPad key={`g${i}`} x={mcuPadPoint(slot, i).x} y={first.y + 4.5} s={4.4} />)}
      <Silk x={fx(0.03)} y={first.y + 1} text="GPIO" size={4} fill="#cdecd8" anchor="start" />

      {/* WiFi/BT RF shield can (top-left) */}
      <rect x={fx(0.05)} y={fy(0.2)} width={bw * 0.14} height={bh * 0.17} rx={1.5} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.5" />
      <rect x={fx(0.05) + 1.5} y={fy(0.2) + 1.5} width={bw * 0.14 - 3} height={bh * 0.17 - 3} rx={1} fill="url(#rsBrushedShield)" opacity="0.5" stroke="#7c848b" strokeWidth="0.3" />

      {/* Gigabit Ethernet + PoE header (top-right, overhangs right edge) */}
      <IcspHeader x={fx(0.72)} y={fy(0.1)} cols={2} rows={2} />
      <MetalConnector x={bx0 + bw - 30} y={fy(0.07)} w={42} h={bh * 0.22} />
      <SmdLed cx={bx0 + bw - 24} cy={fy(0.07) + 2} color="#f4d03f" w={3.4} h={2.4} />
      <SmdLed cx={bx0 + bw - 6} cy={fy(0.07) + 2} color="#3dcc6d" w={3.4} h={2.4} />

      {/* dual USB-3 (blue) + USB-2 (dark) stacks, overhang the right edge */}
      <g>
        <rect x={bx0 + bw - 34} y={fy(0.36)} width={46} height={bh * 0.2} rx={1.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
        <PortWithTongue x={bx0 + bw - 30} y={fy(0.36) + 3} w={30} h={bh * 0.075} tongue="#2f6fd0" />
        <PortWithTongue x={bx0 + bw - 30} y={fy(0.36) + bh * 0.105} w={30} h={bh * 0.075} tongue="#2f6fd0" />
      </g>
      <g>
        <rect x={bx0 + bw - 34} y={fy(0.62)} width={46} height={bh * 0.2} rx={1.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
        <PortWithTongue x={bx0 + bw - 30} y={fy(0.62) + 3} w={30} h={bh * 0.075} tongue="#20262b" />
        <PortWithTongue x={bx0 + bw - 30} y={fy(0.62) + bh * 0.105} w={30} h={bh * 0.075} tongue="#20262b" />
      </g>

      {/* BCM2711 SoC (metal lid) + LPDDR4 RAM + VL805 USB controller + Ethernet PHY */}
      <rect x={fx(0.32)} y={fy(0.4)} width={bw * 0.16} height={bh * 0.22} rx={2} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.5" />
      <rect x={fx(0.32) + 2} y={fy(0.4) + 2} width={bw * 0.16 - 4} height={bh * 0.22 - 4} rx={1.5} fill="url(#rsBrushedShield)" stroke="#8f98a1" strokeWidth="0.4" />
      <Silk x={fx(0.32) + bw * 0.08} y={fy(0.4) + bh * 0.12} text="BCM2711" size={4} fill="#3c4640" weight={600} />
      <Chip x={fx(0.5)} y={fy(0.42)} w={bw * 0.1} h={bh * 0.17} label="LPDDR4" />
      <Chip x={fx(0.64)} y={fy(0.56)} w={bw * 0.07} h={bh * 0.1} />
      <Chip x={fx(0.66)} y={fy(0.4)} w={bw * 0.05} h={bh * 0.08} />

      {/* DISPLAY + CAMERA flat-flex connectors */}
      <FpcConnector x={fx(0.015)} y={fy(0.42)} w={bw * 0.028} h={bh * 0.22} />
      <Silk x={fx(0.06)} y={fy(0.53)} text="DISPLAY" size={3.2} fill="#bfe0ca" anchor="start" />
      <FpcConnector x={fx(0.55)} y={fy(0.66)} w={bw * 0.028} h={bh * 0.2} />
      <Silk x={fx(0.6)} y={fy(0.76)} text="CAMERA" size={3.2} fill="#bfe0ca" anchor="start" />

      {/* bottom edge: USB-C power, 2x micro-HDMI, AV jack (overhang bottom) */}
      <rect x={fx(0.1)} y={by0 + bh - 6} width={18} height={13} rx={3} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      <Silk x={fx(0.1) + 9} y={by0 + bh - 8} text="PWR" size={3} fill="#bfe0ca" />
      <PortWithTongue x={fx(0.26)} y={by0 + bh - 6} w={20} h={13} tongue="#e08a2f" />
      <PortWithTongue x={fx(0.4)} y={by0 + bh - 6} w={20} h={13} tongue="#e08a2f" />
      <Silk x={fx(0.29)} y={by0 + bh - 8} text="HDMI" size={3} fill="#bfe0ca" />
      <circle cx={fx(0.56)} cy={by0 + bh + 1} r={6} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />

      {/* status LEDs (bottom-left) */}
      <SmdLed cx={fx(0.05)} cy={fy(0.72)} color="#e0453a" />
      <Silk x={fx(0.05) + 8} y={fy(0.72) + 1.4} text="PWR" size={3.2} fill="#bfe0ca" anchor="start" />
      <SmdLed cx={fx(0.05)} cy={fy(0.79)} color="#3dcc6d" />
      <Silk x={fx(0.05) + 8} y={fy(0.79) + 1.4} text="ACT" size={3.2} fill="#bfe0ca" anchor="start" />

      {/* scattered SMD passives so the copper field doesn't read as empty */}
      {[
        [0.55, 0.36], [0.6, 0.64], [0.7, 0.5], [0.74, 0.64], [0.78, 0.4],
        [0.82, 0.56], [0.5, 0.68], [0.3, 0.72], [0.28, 0.37], [0.46, 0.58],
        [0.6, 0.44], [0.72, 0.72], [0.5, 0.34], [0.66, 0.66],
      ].map(([px, py], i) => (
        <rect
          key={i}
          x={fx(px)}
          y={fy(py)}
          width={bw * 0.02}
          height={bh * 0.022}
          rx={0.4}
          fill={i % 2 ? '#c8a27a' : '#20262b'}
          opacity={0.9}
        />
      ))}

      {/* silkscreen: raspberry logo + wordmark + copyright + ref */}
      <RaspberryLogo cx={fx(0.2)} cy={fy(0.64)} r={3.2} />
      <Silk x={fx(0.4)} y={fy(0.26)} text="Raspberry Pi 4 Model B" size={6} weight={700} fill="#eef6f6" />
      <Silk x={fx(0.4)} y={fy(0.32)} text="© Raspberry Pi 2018" size={3.4} fill="#bfe0ca" />
      <Silk x={fx(0.34)} y={fy(0.7)} text={`${part.ref}${part.value ? ` · ${part.value}` : ''}`} size={4} fill="#cdecd8" />

      {/* functional GPIO header row (where wires attach) */}
      <McuHeader part={part} light />
      {/* pin wires last so they visibly terminate on the header pads instead
          of vanishing under the opaque board body */}
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
    // Same-column jumpers can't lift vertically (identical control x renders a
    // straight line overshooting the rails). Bow sideways instead: rail-to-rail
    // bridges bow LEFT into the board — they only occur at the right edge
    // (assignRail bridges at the last column), where a right bow would sweep
    // over the rail net labels — while short rail-to-strip stubs bow gently
    // right. The ±0.2·dy pull keeps the curve inside its vertical range.
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
        // Chips sit opposite the body: away from the trench for
        // trench-straddling packages, toward the trench for everything else.
        const chipDy = part.body === 'dip' || part.body === 'esp32'
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
        <stop offset="0" stopColor="#00a2a6" />
        <stop offset="0.5" stopColor="#008184" />
        <stop offset="1" stopColor="#016367" />
      </linearGradient>
      {/* shared board-realism materials (Uno now; Pi/ESP32 reuse later) */}
      <linearGradient id="rsGoldPad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f3d879" />
        <stop offset="0.5" stopColor="#caa233" />
        <stop offset="1" stopColor="#9c7c1e" />
      </linearGradient>
      <linearGradient id="rsBlackPlastic" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2a2f34" />
        <stop offset="0.5" stopColor="#141619" />
        <stop offset="1" stopColor="#0b0d0f" />
      </linearGradient>
      <linearGradient id="rsBrushedShield" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e4e9ee" />
        <stop offset="0.5" stopColor="#b7bfc7" />
        <stop offset="1" stopColor="#8f98a1" />
      </linearGradient>
      <radialGradient id="rsCopperRing" cx="0.4" cy="0.35" r="0.9">
        <stop offset="0" stopColor="#d8a460" />
        <stop offset="1" stopColor="#a6763a" />
      </radialGradient>
      <linearGradient id="rsPartPi" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2f9455" />
        <stop offset="0.5" stopColor="#1f7a41" />
        <stop offset="1" stopColor="#145c30" />
      </linearGradient>
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
  // Off-board boards draw in their slot even when no pin is wired up yet.
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
