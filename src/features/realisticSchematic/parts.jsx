// Realistic SVG renderers for breadboard parts and jumper wires. Each renderer
// receives the placement-model part and draws leads from its exact hole
// positions up onto a photo-style body.
import { useMemo } from 'react';
import { FIXED_PIN_NAMES } from '../../core/componentKinds.js';
import { HOLE_PITCH, MCU_PIN_SPACING, TRENCH_CENTER_Y, holeCenter } from './breadboardGeometry.js';
import { MCU_PINS } from './breadboardModel.js';
import { BAND_COLOR_HEX, capStyle, ledColor, resistorColorBands } from './partVisuals.js';
import { pinLabelsFor } from './selectionModel.js';

const LEAD_STROKE = { stroke: '#8f979e', strokeWidth: 1.7, strokeLinecap: 'round', fill: 'none' };
const LABEL_STYLE = { fontSize: 7.5, fontFamily: 'Inter, Arial, sans-serif', fill: '#3c4640' };
// Halo behind labels drawn over the board so crossing jumper wires don't
// strike through the text. Board-colored for dark text, dark for light text.
const HALO = { paintOrder: 'stroke', stroke: 'rgba(244,241,232,0.9)', strokeWidth: 2.4, strokeLinejoin: 'round' };
const DARK_HALO = { ...HALO, stroke: 'rgba(20,26,30,0.75)' };

// Direction the body sits relative to its holes: above on the top strip,
// below on the bottom strip, so bodies lean away from the trench.
const bodyDir = (strip) => (strip === 'bottom' ? 1 : -1);

// NOTE (here and throughout): a light color must ride inside the style object,
// not the `fill` attribute — LABEL_STYLE carries its own fill, and an inline
// style always beats a presentation attribute.
const RefLabel = ({ x, y, text, light = false }) => (
  <text x={x} y={y} textAnchor="middle" style={{ ...LABEL_STYLE, ...(light ? DARK_HALO : HALO), fill: light ? '#f0f0ea' : LABEL_STYLE.fill }}>
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
    style={{ ...LABEL_STYLE, fontSize: size, fontWeight: weight, letterSpacing: 0.2, fill }}
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
const Crystal = ({ cx, cy, w = 18, h = 9, label = '16MHz' }) => (
  <g>
    <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth={0.5} />
    <ellipse cx={cx} cy={cy} rx={w / 2 - 2} ry={h / 2 - 1.6} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.4} />
    <Silk x={cx} y={cy + 1.6} text={label} size={3.4} fill="#3c4640" />
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
        : <text x={mid} y={y + 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, ...HALO, fontSize: 6.5 }}>{part.value}</text>}
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
    const minusOnRight = b.x > a.x;
    const stripeX = minusOnRight ? mid + width / 2 - 5 : mid - width / 2;
    const plusX = minusOnRight ? mid - width / 2 + 4 : mid + width / 2 - 4;
    return (
      <g>
        <Lead from={a} to={{ x: mid - 4, y: y + 8 }} />
        <Lead from={b} to={{ x: mid + 4, y: y + 8 }} />
        <rect x={mid - width / 2} y={y - 12} width={width} height={24} rx={4} fill="url(#rsPartCan)" stroke="#1b2947" strokeWidth="0.6" />
        <rect x={stripeX} y={y - 12} width={5} height={24} rx={2} fill="#d8dde6" opacity="0.85" />
        <text x={stripeX + 2.5} y={y + 2} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fontWeight: 700, fill: '#2b3550' }}>−</text>
        <text x={plusX} y={y - 4.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fontWeight: 700, fill: '#e8ecf4' }}>+</text>
        <RefLabel x={mid} y={y - 17} text={`${part.ref} · ${part.value}`} />
      </g>
    );
  }
  return (
    <g>
      <Lead from={a} to={{ x: mid - 4, y: y + 5 }} />
      <Lead from={b} to={{ x: mid + 4, y: y + 5 }} />
      <circle cx={mid} cy={y - 2} r={9.5} fill="url(#rsPartCeramic)" stroke="#b28a2e" strokeWidth="0.6" />
      <text x={mid} y={y + 0.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5, fill: '#4a3c14' }}>{part.value}</text>
      <RefLabel x={mid} y={y - 15} text={part.ref} />
    </g>
  );
}

function LedBody({ part, points, sim }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 17;
  const mid = (a.x + b.x) / 2;
  const { fill } = ledColor(part.value);
  // Flat-sided lens silhouette: the vertical chord marks the cathode (pin 2),
  // like the flattened rim of a real 5mm LED.
  const flat = b.x > a.x ? 6 : -6;
  const chordY = Math.sqrt(9 * 9 - flat * flat);
  const sweep = flat > 0 ? 0 : 1;
  const lens = `M ${mid + flat} ${y - chordY} A 9 9 0 1 ${sweep} ${mid + flat} ${y + chordY} Z`;
  const brightness = sim?.brightness ?? 0;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 3.5, y: y + 9 }} />
      <Lead from={b} to={{ x: mid + 3.5, y: y + 9 }} />
      {brightness > 0 && (
        <circle cx={mid} cy={y} r={10 + 8 * brightness} fill={fill} opacity={0.25 + 0.6 * brightness} filter="url(#rsGlow)" />
      )}
      <path d={lens} fill={fill} stroke="rgba(0,0,0,0.35)" strokeWidth="0.7" />
      <path d={lens} fill="url(#rsPartLens)" />
      {brightness > 0 && <path d={lens} fill="#fff" opacity={0.5 * brightness} />}
      <line x1={mid + flat} y1={y - chordY + 1} x2={mid + flat} y2={y + chordY - 1} stroke="rgba(0,0,0,0.4)" strokeWidth="1.4" />
      <ellipse cx={mid - 3} cy={y - 3.5} rx={2.6} ry={1.8} fill="rgba(255,255,255,0.75)" />
      <RefLabel x={mid} y={y - 14} text={part.ref} />
    </g>
  );
}

function DiodeBody({ part, points, bodyFill = 'url(#rsPartDiode)', bodyStroke = '#111' }) {
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
      <rect x={mid - length / 2} y={y - 5} width={length} height={10} rx={4} fill={bodyFill} stroke={bodyStroke} strokeWidth="0.5" />
      <rect x={bandX} y={y - 5} width={4} height={10} fill="#cfd4da" />
      <RefLabel x={mid} y={y + dir * 12} text={part.ref} />
    </g>
  );
}

// Zener: same axial glass package as the rectifier diode, but with the blue
// tint of a real BZX-style body. Breakdown voltage rides in `part.value`.
const ZenerBody = (props) => <DiodeBody {...props} bodyFill="url(#rsPartZener)" bodyStroke="#122036" />;

// Schottky: same axial package with the bronze tint of a 1N58xx body.
const SchottkyBody = (props) => <DiodeBody {...props} bodyFill="url(#rsPartSchottky)" bodyStroke="#2a2018" />;

// Glass cartridge fuse: translucent tube, brushed-metal end caps, and the
// thin element wire visible through the glass.
function FuseBody({ part, points, sim }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 13;
  const mid = (a.x + b.x) / 2;
  const length = 28;
  const blown = Boolean(sim?.blown);
  return (
    <g>
      <Lead from={a} to={{ x: mid - length / 2 + 2, y }} />
      <Lead from={b} to={{ x: mid + length / 2 - 2, y }} />
      <rect x={mid - length / 2} y={y - 5} width={length} height={10} rx={4.5} fill="rgba(210,220,230,0.5)" stroke="#8a929a" strokeWidth="0.5" />
      {blown ? (
        <>
          {/* Broken element: two stubs and a curled fragment, smoked glass. */}
          <line x1={mid - length / 2 + 6} y1={y} x2={mid - 3.5} y2={y} stroke="#5a636b" strokeWidth="0.9" />
          <line x1={mid + 3.5} y1={y} x2={mid + length / 2 - 6} y2={y} stroke="#5a636b" strokeWidth="0.9" />
          <path d={`M ${mid - 3.5} ${y} q 1.5 -2.6 3 -1`} fill="none" stroke="#5a636b" strokeWidth="0.8" />
          <rect x={mid - length / 2} y={y - 5} width={length} height={10} rx={4.5} fill="rgba(90,90,90,0.35)" />
        </>
      ) : (
        <line x1={mid - length / 2 + 6} y1={y} x2={mid + length / 2 - 6} y2={y} stroke="#5a636b" strokeWidth="0.9" />
      )}
      <rect x={mid - length / 2} y={y - 5} width={6} height={10} rx={2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <rect x={mid + length / 2 - 6} y={y - 5} width={6} height={10} rx={2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <ellipse cx={mid - 3} cy={y - 2.6} rx={5} ry={1.4} fill="rgba(255,255,255,0.5)" />
      <RefLabel x={mid} y={y + dir * 12} text={`${part.ref}${part.value ? ` · ${part.value}` : ''}${blown ? ' · blown' : ''}`} />
    </g>
  );
}

// Pancake vibration motor: flat brushed-metal coin with the dark
// eccentric-weight arc peeking under the top face.
function VibrationMotorBody({ part, points, sim }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 16;
  const mid = (a.x + b.x) / 2;
  const shaking = (sim?.speed01 ?? 0) > 0.05;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 8, y: y + 8 }} />
      <Lead from={b} to={{ x: mid + 8, y: y + 8 }} />
      <g className={shaking ? 'rs-motor-shake' : undefined}>
        <circle cx={mid} cy={y} r={11} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.7" />
        <path d={`M ${mid - 9.5} ${y + 3} A 10 10 0 0 0 ${mid + 6} ${y + 8.4}`} fill="none" stroke="#3a4147" strokeWidth="3" strokeLinecap="round" />
        <circle cx={mid} cy={y} r={2.4} fill="#20262b" stroke="#000" strokeWidth="0.4" />
        <ellipse cx={mid - 4} cy={y - 4.5} rx={4} ry={2.4} fill="rgba(255,255,255,0.55)" />
      </g>
      <RefLabel x={mid} y={y - 15} text={part.ref} />
    </g>
  );
}

// Bridge rectifier: square black module with the ~ ~ + − corner markings of a
// DB107-style package. Canonical pins [AC1, AC2, V+, V-].
function BridgeRectifierBody({ part, points }) {
  const { mid, cy, edgeY } = moduleFrame(part, points);
  const marks = ['~', '~', '+', '−'];
  return (
    <g>
      <rect x={mid - 16} y={cy - 15} width={32} height={30} rx={2.5} fill="url(#rsPartDiode)" stroke="#000" strokeWidth="0.6" />
      <rect x={mid - 14.4} y={cy - 13.4} width={28.8} height={26.8} rx={2} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      <circle cx={mid} cy={cy - 1} r={3.2} fill="none" stroke="#3a4147" strokeWidth="0.8" />
      {points.map((point, index) => (
        <text key={index} x={point.x} y={cy + 11.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.4, fontWeight: 700, fill: '#e8ecef' }}>
          {marks[index] ?? ''}
        </text>
      ))}
      <Silk x={mid} y={cy - 8} text={part.value || 'DB107'} size={3.8} fill="#c6ccd2" />
      <ModulePins points={points} edgeY={edgeY} />
      <RefLabel x={mid} y={cy - 19} text={part.ref} />
    </g>
  );
}

// Photoresistor (LDR): pale ceramic disc with the characteristic dark-red
// serpentine track combed across the face. Nonpolar.
function LdrBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 16;
  const mid = (a.x + b.x) / 2;
  const r = 10;
  const cy = y - 2;
  const track = [-5, -2.5, 0, 2.5, 5]
    .map((dy, index) => {
      const half = Math.sqrt(r * r - dy * dy) - 2.6;
      const from = index % 2 === 0 ? mid - half : mid + half;
      const to = index % 2 === 0 ? mid + half : mid - half;
      return `${index === 0 ? 'M' : 'L'} ${from} ${cy + dy} L ${to} ${cy + dy}`;
    })
    .join(' ');
  return (
    <g>
      <Lead from={a} to={{ x: mid - 4, y: y + 6 }} />
      <Lead from={b} to={{ x: mid + 4, y: y + 6 }} />
      <circle cx={mid} cy={cy} r={r} fill="url(#rsPartLdr)" stroke="#8a6b42" strokeWidth="0.7" />
      <path d={track} stroke="#a3402c" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <RefLabel x={mid} y={y - 16} text={part.ref} />
    </g>
  );
}

// Thermistor: small near-black epoxy drop, value printed on the face like a
// real 10k NTC bead.
function ThermistorBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 15;
  const mid = (a.x + b.x) / 2;
  const cy = y - 2;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 3.5, y: y + 5 }} />
      <Lead from={b} to={{ x: mid + 3.5, y: y + 5 }} />
      <circle cx={mid} cy={cy} r={8} fill="url(#rsPartThermistor)" stroke="#050607" strokeWidth="0.6" />
      {/* fill lives in the style: LABEL_STYLE carries its own fill, and the
          inline style would override a fill attribute */}
      <text x={mid} y={cy - 0.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 4.5, fill: '#e8ecef' }}>{part.value}</text>
      <text x={mid} y={cy + 4.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 3.6, fill: '#9aa3ab' }}>NTC</text>
      <RefLabel x={mid} y={y - 14} text={part.ref} />
    </g>
  );
}

// Buzzer, top view: black cylinder with an inset ring, a center sound hole,
// and a white "+" over the positive (pin 1) side.
function BuzzerBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 17;
  const mid = (a.x + b.x) / 2;
  const cy = y - 1;
  const r = 11;
  const plusX = mid + (a.x < b.x ? -1 : 1) * 5.5;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 4.5, y: y + 8 }} />
      <Lead from={b} to={{ x: mid + 4.5, y: y + 8 }} />
      <circle cx={mid} cy={cy} r={r} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      <circle cx={mid} cy={cy} r={r - 2.4} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.8" />
      <circle cx={mid} cy={cy} r={2.4} fill="#000" stroke="#2c3237" strokeWidth="0.5" />
      <text x={plusX} y={cy - 4.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fontWeight: 700, fill: '#e8ecef' }}>+</text>
      <RefLabel x={mid} y={y - 16} text={part.ref} />
    </g>
  );
}

// Discrete HC-49 crystal: reuses the silver-can glyph from the Uno board art,
// printing the part's own frequency on the can.
function CrystalBody({ part, points }) {
  const [a, b] = points;
  const dir = bodyDir(part.strip);
  const y = Math.min(a.y, b.y) + dir * 14;
  const mid = (a.x + b.x) / 2;
  return (
    <g>
      <Lead from={a} to={{ x: mid - 6, y: y + 4 }} />
      <Lead from={b} to={{ x: mid + 6, y: y + 4 }} />
      <Crystal cx={mid} cy={y - 1} w={22} h={11} label={part.value || 'XTAL'} />
      <RefLabel x={mid} y={y - 12} text={part.ref} />
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
      <text x={mid} y={y + 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fill: '#dff2e6' }}>{part.value}</text>
      <RefLabel x={mid} y={y - 14} text={part.ref} />
    </g>
  );
}

// Trimmer potentiometer: blue square body with a white adjustment screw
// (cross slot) on top. Canonical pins [A, W, B] — the wiper is the center leg,
// matching the compound SPICE image's two half-value resistors.
function PotentiometerBody({ part, points, sim }) {
  const dir = bodyDir(part.strip);
  const mid = points[1].x;
  const y = Math.min(...points.map((point) => point.y)) + dir * 20;
  const edgeY = y - dir * 11; // body edge nearest the holes
  // In run mode the cross slot rotates with the wiper: 0 → −135°, 1 → +135°.
  const rotation = sim?.wiper === undefined ? 0 : (sim.wiper - 0.5) * 270;
  return (
    <g>
      {points.map((point, index) => (
        <path key={index} d={`M ${point.x} ${point.y} L ${mid + (index - 1) * 7} ${edgeY}`} {...LEAD_STROKE} />
      ))}
      <rect x={mid - 12} y={y - 11} width={24} height={22} rx={2} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.6" />
      <circle cx={mid} cy={y - 2.5} r={5.5} fill="#e9edf0" stroke="#7c848b" strokeWidth="0.6" />
      <g transform={rotation ? `rotate(${rotation} ${mid} ${y - 2.5})` : undefined}>
        <line x1={mid - 3.6} y1={y - 2.5} x2={mid + 3.6} y2={y - 2.5} stroke="#8a929a" strokeWidth="1.1" />
        <line x1={mid} y1={y - 6.1} x2={mid} y2={y + 1.1} stroke="#8a929a" strokeWidth="1.1" />
        {sim?.wiper !== undefined && <circle cx={mid} cy={y - 6.1} r={0.9} fill="#c8501e" />}
      </g>
      <text x={mid} y={y + 8.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 4.2, fill: '#d7e2f4' }}>{part.value}</text>
      <RefLabel x={mid} y={y - 16} text={part.ref} />
    </g>
  );
}

// SPDT slide switch: brushed-metal case with the black knob thrown toward
// pin 1 — throw A, the position the compound SPICE image simulates as closed.
function SlideSwitchBody({ part, points, sim }) {
  const dir = bodyDir(part.strip);
  const mid = points[1].x;
  const y = Math.min(...points.map((point) => point.y)) + dir * 16;
  const edgeY = y - dir * 6.5;
  // Knob sits toward the closed throw: pin 1 (A) by default, flipped to pin 3
  // when the live simulation has the switch thrown to B.
  const towardA = points[0].x < mid ? -1 : 1;
  const throwSign = (sim?.position ?? 'A') === 'B' ? -towardA : towardA;
  return (
    <g>
      {points.map((point, index) => (
        <path key={index} d={`M ${point.x} ${point.y} L ${mid + (index - 1) * 7} ${edgeY}`} {...LEAD_STROKE} />
      ))}
      <rect x={mid - 18} y={y - 6.5} width={36} height={13} rx={1.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <line x1={mid - 16.5} y1={y - 4.5} x2={mid + 16.5} y2={y - 4.5} stroke="rgba(255,255,255,0.6)" strokeWidth="0.5" />
      <rect x={mid - 13} y={y - 3} width={26} height={6} rx={1} fill="#20262b" />
      <rect x={mid + throwSign * 8 - 3.5} y={y - 4.5} width={7} height={9} rx={1} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      <RefLabel x={mid} y={y - 12} text={part.ref} />
    </g>
  );
}

// RGB LED: oversized clear lens holding three tiny R/G/B dies. Canonical pins
// [R, G, B, K] — the flat chord marks the common-cathode (pin 4) side.
function RgbLedBody({ part, points, sim }) {
  const dir = bodyDir(part.strip);
  const y = Math.min(...points.map((point) => point.y)) + dir * 17;
  const first = points[0];
  const last = points[points.length - 1];
  const mid = (first.x + last.x) / 2;
  const flat = last.x > first.x ? 7 : -7;
  const chordY = Math.sqrt(11 * 11 - flat * flat);
  const sweep = flat > 0 ? 0 : 1;
  const lens = `M ${mid + flat} ${y - chordY} A 11 11 0 1 ${sweep} ${mid + flat} ${y + chordY} Z`;
  const dies = ['#e0453a', '#3fae5a', '#3f8fe8'];
  // Live simulation: blend the lens glow from the per-channel brightnesses.
  const channels = sim?.channels ?? {};
  const [rB, gB, bB] = [channels.R?.brightness ?? 0, channels.G?.brightness ?? 0, channels.B?.brightness ?? 0];
  const glow = Math.max(rB, gB, bB);
  const glowColor = glow > 0
    ? `rgb(${Math.round(80 + 175 * (rB / glow))} ${Math.round(80 + 175 * (gB / glow))} ${Math.round(80 + 175 * (bB / glow))})`
    : null;
  return (
    <g>
      {points.map((point, index) => (
        <Lead key={index} from={point} to={{ x: mid + (index - 1.5) * 4.5, y: y + 10 }} />
      ))}
      {glow > 0 && (
        <circle cx={mid} cy={y} r={12 + 8 * glow} fill={glowColor} opacity={0.25 + 0.6 * glow} filter="url(#rsGlow)" />
      )}
      <path d={lens} fill="#f2f2ee" fillOpacity="0.85" stroke="rgba(0,0,0,0.35)" strokeWidth="0.7" />
      {dies.map((color, index) => {
        const channelBrightness = [rB, gB, bB][index];
        return (
          <g key={color}>
            <rect x={mid - 6.2 + index * 4.4} y={y - 1.5} width={3.2} height={3.2} rx={0.6} fill={color} />
            {channelBrightness > 0 && (
              <rect x={mid - 6.2 + index * 4.4} y={y - 1.5} width={3.2} height={3.2} rx={0.6} fill="#fff" opacity={0.7 * channelBrightness} />
            )}
          </g>
        );
      })}
      <path d={lens} fill="url(#rsPartLens)" />
      {glow > 0 && <path d={lens} fill={glowColor} opacity={0.35 * glow} />}
      <line x1={mid + flat} y1={y - chordY + 1} x2={mid + flat} y2={y + chordY - 1} stroke="rgba(0,0,0,0.4)" strokeWidth="1.4" />
      <ellipse cx={mid - 3.5} cy={y - 4.5} rx={3} ry={2} fill="rgba(255,255,255,0.75)" />
      <RefLabel x={mid} y={y - 17} text={part.ref} />
    </g>
  );
}

// Shared frame for the on-board sensor modules: leads from the holes to the
// PCB edge nearest them, gold header pads where they land, and the body
// geometry every module builds on. Bodies stay under ~34px tall so they clear
// the power rails above/below the strip.
const moduleFrame = (part, points) => {
  const dir = bodyDir(part.strip);
  const xs = points.map((point) => point.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = Math.min(...points.map((point) => point.y)) + dir * 21;
  const edgeY = cy - dir * 15; // PCB edge nearest the holes
  return { dir, mid, cy, edgeY, span: Math.max(...xs) - Math.min(...xs) };
};

const ModulePins = ({ points, edgeY }) => (
  <g>
    {points.map((point, index) => (
      <g key={index}>
        <Lead from={point} to={{ x: point.x, y: edgeY }} />
        <GoldPad x={point.x} y={edgeY} s={3.4} />
      </g>
    ))}
  </g>
);

// HC-SR04 ultrasonic ranger: blue PCB with two silver transducer cans (dark
// mesh centers), a small crystal can between them.
function UltrasonicBody({ part, points }) {
  const { mid, cy, edgeY, span } = moduleFrame(part, points);
  const width = span + 22;
  return (
    <g>
      <rect x={mid - width / 2} y={cy - 15} width={width} height={30} rx={2} fill="url(#rsPcbBlue)" stroke="#123a63" strokeWidth="0.6" />
      {[-1, 1].map((side) => (
        <g key={side}>
          <circle cx={mid + side * 16} cy={cy - 2} r={9.5} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
          <circle cx={mid + side * 16} cy={cy - 2} r={6.6} fill="#20262b" />
          <circle cx={mid + side * 16} cy={cy - 2} r={4.2} fill="none" stroke="#3a4147" strokeWidth="0.7" />
          <circle cx={mid + side * 16} cy={cy - 2} r={2} fill="none" stroke="#3a4147" strokeWidth="0.7" />
        </g>
      ))}
      <ellipse cx={mid} cy={cy + 6} rx={4.5} ry={2.2} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.4" />
      <Silk x={mid - width / 2 + 3} y={cy - 10.5} text={part.ref} size={3.8} fill="#dbe7f2" anchor="start" />
      <Silk x={mid} y={cy + 13} text="HC-SR04" size={3.6} fill="#dbe7f2" />
      <ModulePins points={points} edgeY={edgeY} />
    </g>
  );
}

// DHT temperature/humidity sensor: matte-blue cuboid with the vent lattice.
function DhtBody({ part, points }) {
  const { mid, cy, edgeY } = moduleFrame(part, points);
  return (
    <g>
      <rect x={mid - 13} y={cy - 17} width={26} height={34} rx={2} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.7" />
      <rect x={mid - 11.5} y={cy - 15.5} width={23} height={31} rx={1.6} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.5" />
      {Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 3 }, (_, col) => (
          <rect key={`${row}-${col}`} x={mid - 8 + col * 5.5} y={cy - 13 + row * 4.6} width={3.4} height={3.2} rx={0.5} fill="#132a52" />
        )),
      )}
      <Silk x={mid} y={cy + 8.5} text={part.ref} size={4} fill="#d7e2f4" />
      <Silk x={mid} y={cy + 13.5} text={part.value || 'DHT11'} size={3.4} fill="#a9bcdc" />
      <ModulePins points={points} edgeY={edgeY} />
    </g>
  );
}

// Render a 128×64 SSD1306 framebuffer to a data URL for the live OLED glass.
// First canvas use in the codebase; jsdom has no 2D context, so any failure
// returns null and the static artwork stays.
const fbToDataUrl = (fb, on, invert) => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(128, 64);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        let lit = (fb[(y >> 3) * 128 + x] >> (y & 7)) & 1;
        if (invert) lit = lit ^ 1;
        if (!on) lit = 0;
        const offset = (y * 128 + x) * 4;
        const value = lit ? 235 : 10;
        image.data[offset] = value;
        image.data[offset + 1] = value + (lit ? 15 : 2);
        image.data[offset + 2] = value + (lit ? 20 : 6);
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
};

// I2C OLED breakout: dark PCB with the near-black glass panel. When firmware
// drives it, the glass shows the live SSD1306 framebuffer.
function OledBody({ part, points, sim }) {
  const { mid, cy, edgeY, span } = moduleFrame(part, points);
  const width = span + 22;
  const dataUrl = useMemo(
    () => (sim?.fb ? fbToDataUrl(sim.fb, sim.on, sim.invert) : null),
    [sim?.fb, sim?.fbVersion, sim?.on, sim?.invert],
  );
  return (
    <g>
      <rect x={mid - width / 2} y={cy - 15} width={width} height={30} rx={2} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.6" />
      <rect x={mid - width / 2 + 4} y={cy - 8} width={width - 8} height={19} rx={1.2} fill="#0a0c10" stroke="#1d232a" strokeWidth="0.5" />
      {dataUrl ? (
        <image
          x={mid - width / 2 + 4}
          y={cy - 8}
          width={width - 8}
          height={19}
          href={dataUrl}
          preserveAspectRatio="none"
          style={{ imageRendering: 'pixelated' }}
        />
      ) : (
        <rect x={mid - width / 2 + 6} y={cy - 6} width={width - 12} height={2.4} rx={0.8} fill="#59e3f2" opacity="0.85" />
      )}
      <rect x={mid - width / 2 + 4} y={cy - 8} width={width - 8} height={19} rx={1.2} fill="url(#rsPartLens)" opacity="0.25" />
      <Silk x={mid} y={cy - 10.5} text={[part.ref, part.value || 'SSD1306'].filter(Boolean).join(' · ')} size={3.6} fill="#c8d2da" />
      <ModulePins points={points} edgeY={edgeY} />
    </g>
  );
}

// HC-SR501 PIR motion sensor: green PCB dominated by the white Fresnel dome,
// with the two orange trimmers peeking out beneath.
function PirBody({ part, points, sim }) {
  const { mid, cy, edgeY } = moduleFrame(part, points);
  const width = 44;
  const triggered = Boolean(sim?.motion);
  return (
    <g>
      <rect x={mid - width / 2} y={cy - 15} width={width} height={30} rx={2} fill="url(#rsPartPi)" stroke="#0f4423" strokeWidth="0.6" />
      {[-1, 1].map((side) => (
        <rect key={side} x={mid + side * 15 - 2.2} y={cy + 9.5} width={4.4} height={4.4} rx={0.6} fill="#e07020" stroke="#8a4310" strokeWidth="0.4" />
      ))}
      <circle cx={mid} cy={cy - 1} r={12.5} fill="url(#rsPirDome)" stroke="#c9c9ba" strokeWidth="0.6" />
      {triggered && <circle cx={mid} cy={cy - 1} r={12.5} fill="#ffb347" opacity="0.35" />}
      <circle cx={mid} cy={cy - 1} r={8.4} fill="none" stroke="#d8d8ca" strokeWidth="0.6" />
      <circle cx={mid} cy={cy - 1} r={4.4} fill="none" stroke="#d8d8ca" strokeWidth="0.6" />
      <path d={`M ${mid - 12.5} ${cy - 1} H ${mid + 12.5} M ${mid} ${cy - 13.5} V ${cy + 11.5}`} stroke="#d8d8ca" strokeWidth="0.6" fill="none" />
      <Silk x={mid} y={cy + 13.8} text={part.ref} size={3.8} fill="#dff2e6" />
      <ModulePins points={points} edgeY={edgeY} />
    </g>
  );
}

// KY-040 rotary encoder breakout: dark PCB with the knurled metal shaft and
// the D-slot knob face.
function RotaryEncoderBody({ part, points }) {
  const { mid, cy, edgeY } = moduleFrame(part, points);
  return (
    <g>
      <rect x={mid - 20} y={cy - 15} width={40} height={30} rx={2} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.6" />
      <circle cx={mid} cy={cy - 1} r={11} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.6" />
      {Array.from({ length: 12 }, (_, index) => {
        const angle = (index / 12) * Math.PI * 2;
        return (
          <line
            key={index}
            x1={mid + Math.cos(angle) * 9.2} y1={cy - 1 + Math.sin(angle) * 9.2}
            x2={mid + Math.cos(angle) * 11} y2={cy - 1 + Math.sin(angle) * 11}
            stroke="#6b737b" strokeWidth="0.8"
          />
        );
      })}
      <circle cx={mid} cy={cy - 1} r={5.4} fill="#20262b" stroke="#000" strokeWidth="0.4" />
      <line x1={mid - 3.4} y1={cy + 1.8} x2={mid + 3.4} y2={cy + 1.8} stroke="#4d565e" strokeWidth="1.1" />
      <Silk x={mid} y={cy + 13.5} text={[part.ref, part.value || 'KY-040'].filter(Boolean).join(' · ')} size={3.6} fill="#c8d2da" />
      <ModulePins points={points} edgeY={edgeY} />
    </g>
  );
}

// GY-521 IMU breakout: purple PCB carrying the black MPU-6050 die.
function ImuBody({ part, points }) {
  const { mid, cy, edgeY, span } = moduleFrame(part, points);
  const width = span + 22;
  return (
    <g>
      <rect x={mid - width / 2} y={cy - 15} width={width} height={30} rx={2} fill="#4a2f7d" stroke="#2c1a4e" strokeWidth="0.6" />
      <rect x={mid - width / 2 + 1.6} y={cy - 13.4} width={width - 3.2} height={26.8} rx={1.6} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      <MountHole cx={mid - width / 2 + 5} cy={cy + 9} r={2.4} />
      <MountHole cx={mid + width / 2 - 5} cy={cy + 9} r={2.4} />
      <rect x={mid - 7} y={cy - 9} width={14} height={14} rx={1} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.5" />
      <circle cx={mid - 4.6} cy={cy - 6.6} r={0.9} fill="#3a4147" />
      <Silk x={mid} y={cy + 12.8} text={[part.ref, part.value || 'MPU-6050'].filter(Boolean).join(' · ')} size={3.6} fill="#d9d2ec" />
      <ModulePins points={points} edgeY={edgeY} />
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
      <text x={mid} y={y - 0.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fill: '#e8ecef' }}>{part.ref}</text>
      <text x={mid} y={y + 6.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5, fill: '#aeb7bd' }}>{part.value}</text>
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
      <text x={mid} y={y + 1} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5, fill: '#cfd4d8' }}>{part.value}</text>
      <RefLabel x={mid} y={y - 20} text={part.ref} />
    </g>
  );
}

// Part-number silk when a DIP part carries no explicit value.
const DIP_DEFAULT_SILK = { comparator: 'LM393', timer_555: 'NE555', shift_register: '74HC595', optocoupler: 'PC817', adc_module: 'MCP3008' };

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
      <text x={(x0 + x1) / 2 + 2} y={TRENCH_CENTER_Y - 1} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6.5, fontWeight: 600, fill: '#f2f5f7' }}>{part.ref}</text>
      <text x={(x0 + x1) / 2 + 2} y={TRENCH_CENTER_Y + 7} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5.5, fill: '#c6ccd2' }}>{part.value || DIP_DEFAULT_SILK[part.kind]}</text>
    </g>
  );
}

// Tactile pushbutton bridging the trench: black base, silver top plate, round
// plunger. The two electrical legs sit on the bottom strip; the top-strip leg
// stubs are decorative (their columns are reserved but hold no pins), drawn
// from the package meta rather than part.holes.
function PushbuttonBody({ part, sim }) {
  const pressed = Boolean(sim?.pressed);
  const { columnStart, columnEnd } = part.meta;
  const bodyTop = TRENCH_CENTER_Y - 13;
  const bodyBottom = TRENCH_CENTER_Y + 13;
  const legs = [];
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const topHole = holeCenter({ strip: 'top', column, row: 4 });
    const bottomHole = holeCenter({ strip: 'bottom', column, row: 0 });
    legs.push(
      <rect key={`t${column}`} x={topHole.x - 1.4} y={topHole.y - 1} width={2.8} height={bodyTop - topHole.y + 2} fill="url(#rsPartTab)" />,
      <rect key={`b${column}`} x={bottomHole.x - 1.4} y={bodyBottom - 1} width={2.8} height={bottomHole.y - bodyBottom + 2} fill="url(#rsPartTab)" />,
    );
  }
  const left = holeCenter({ strip: 'bottom', column: columnStart, row: 0 });
  const right = holeCenter({ strip: 'bottom', column: columnEnd, row: 0 });
  const x0 = left.x - 6;
  const x1 = right.x + 6;
  const mid = (x0 + x1) / 2;
  return (
    <g>
      {legs}
      <rect x={x0} y={bodyTop} width={x1 - x0} height={bodyBottom - bodyTop} rx={2.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      <rect x={x0 + 2.5} y={bodyTop + 2.5} width={x1 - x0 - 5} height={bodyBottom - bodyTop - 5} rx={2} fill="url(#rsPartTab)" stroke="#7c848b" strokeWidth="0.4" />
      <circle cx={mid} cy={TRENCH_CENTER_Y + (pressed ? 0.8 : 0)} r={pressed ? 5.9 : 6.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.5" />
      {pressed && <circle cx={mid} cy={TRENCH_CENTER_Y + 0.8} r={5.9} fill="rgba(0,0,0,0.35)" />}
      <circle cx={mid - 2} cy={TRENCH_CENTER_Y - 2 + (pressed ? 0.8 : 0)} r={1.6} fill="rgba(255,255,255,0.14)" />
      <RefLabel x={mid} y={bodyTop - 5} text={part.ref} />
    </g>
  );
}

// 7-segment display (5161AS-style DIP-10) bridging the trench: black face with
// the unlit "8" figure-eight, a decimal point, and ten silver leg stubs (the
// decorative second COM leg included).
function SevenSegmentBody({ part, sim }) {
  const { columnStart, columnEnd } = part.meta;
  const faceTop = TRENCH_CENTER_Y - 22;
  const faceBottom = TRENCH_CENTER_Y + 22;
  const legs = [];
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const topHole = holeCenter({ strip: 'top', column, row: 4 });
    const bottomHole = holeCenter({ strip: 'bottom', column, row: 0 });
    legs.push(
      <rect key={`t${column}`} x={topHole.x - 1.4} y={topHole.y - 1} width={2.8} height={faceTop - topHole.y + 2} fill="url(#rsPartTab)" />,
      <rect key={`b${column}`} x={bottomHole.x - 1.4} y={faceBottom - 1} width={2.8} height={bottomHole.y - faceBottom + 2} fill="url(#rsPartTab)" />,
    );
  }
  const left = holeCenter({ strip: 'top', column: columnStart, row: 4 });
  const right = holeCenter({ strip: 'top', column: columnEnd, row: 4 });
  const x0 = left.x - 6;
  const x1 = right.x + 6;
  const cx = (x0 + x1) / 2;
  const cy = TRENCH_CENTER_Y;
  // Unlit segments on the dark face; the slight skew gives the classic italic
  // digit. Horizontal A/G/D bars plus vertical F/B/E/C bars. When the live
  // simulation drives a segment, it lights the classic 5161AS red.
  const lit = (name) => sim?.segments?.[name]?.brightness ?? 0;
  const segFill = (name) => {
    const brightness = lit(name);
    return brightness > 0 ? `rgba(255, 68, 51, ${0.55 + 0.45 * brightness})` : '#565b52';
  };
  const seg = { rx: 1.2 };
  const segments = (
    <g transform={`translate(${cx} ${cy}) skewX(-6)`}>
      <rect x={-6.5} y={-16.5} width={13} height={3} {...seg} fill={segFill('A')} />
      <rect x={-6.5} y={-1.5} width={13} height={3} {...seg} fill={segFill('G')} />
      <rect x={-6.5} y={13.5} width={13} height={3} {...seg} fill={segFill('D')} />
      <rect x={-9.5} y={-13} width={3} height={11} {...seg} fill={segFill('F')} />
      <rect x={6.5} y={-13} width={3} height={11} {...seg} fill={segFill('B')} />
      <rect x={-9.5} y={2} width={3} height={11} {...seg} fill={segFill('E')} />
      <rect x={6.5} y={2} width={3} height={11} {...seg} fill={segFill('C')} />
    </g>
  );
  return (
    <g>
      {legs}
      <rect x={x0} y={faceTop} width={x1 - x0} height={faceBottom - faceTop} rx={2.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      <rect x={x0 + 1.4} y={faceTop + 1.4} width={x1 - x0 - 2.8} height={faceBottom - faceTop - 2.8} rx={2} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.6" />
      {segments}
      <circle cx={cx + 12} cy={cy + 15.5} r={1.8} fill={segFill('DP')} />
      <Silk x={x0 + 4} y={faceTop + 6.5} text={part.ref} size={4} fill="#8a9096" anchor="start" />
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

// Pin-group breaks per MCU kind (indexes a group starts at, first group
// implicit): the Uno's canonical pins split power | digital | analog, mirrored
// as physical gaps in the header strip like the real board's 8/10-pin blocks.
const MCU_PIN_GROUPS = { arduino_uno: [4, 18] };
const MCU_GROUP_GAP = 10;

// Secondary silk annotations printed under specific header pads (by pin index),
// like the real board's alternate-function marks. The Uno's D0/D1 double as the
// serial RX/TX lines; the functional pin name stays D0/D1 so the firmware/AI
// D<n>→pin-number contract is unaffected.
const MCU_PIN_ALIASES = { arduino_uno: { 4: 'RX', 5: 'TX' } };

// Off-board peripherals anchor their pads on the part's *real* terminals (motor
// solder tabs, servo connector, relay input header + screw block) instead of a
// floating strip at the top of the slot. Coordinates are expressed off each
// body's own origin (see the body components below) so artwork and the
// connect-to-board wires share one source of truth. MCU boards are absent here
// and keep the collinear `slot.y + 18` default their body rects are drawn around.
const PERIPHERAL_PAD_LAYOUTS = {
  dc_motor: (slot, i) => {
    const cx = slot.x + 88;
    const cy = slot.y + 74; // DcMotorBody can center
    return { x: cx + 46, y: cy + (i === 0 ? -10.5 : 10.5) }; // the two end-bell tabs
  },
  servo: (slot, i) => ({ x: slot.x + 74 + i * 11, y: slot.y + 58 }), // top-edge 3-pin connector
  relay_module: (slot, i) => (i < 3
    ? { x: slot.x + 26 + i * 12, y: slot.y + 40 } // VCC/GND/IN input header on the PCB edge
    : { x: slot.x + 162, y: slot.y + 58 + (i - 3) * 15 }), // COM/NO/NC screw terminals
  motor_driver: (slot, i) => (i < 8
    ? { x: slot.x + 40 + i * 16, y: slot.y + 40 } // VS/GND/ENA/IN1/IN2/ENB/IN3/IN4 header on the PCB edge
    : i < 10
      ? { x: slot.x + 18, y: slot.y + 62 + (i - 8) * 16 } // OUT1/OUT2 left screw block
      : { x: slot.x + 218, y: slot.y + 62 + (i - 10) * 16 }), // OUT3/OUT4 right screw block
  stepper_motor: (slot, i) => ({ x: slot.x + 150 + i * 11, y: slot.y + 58 }), // 5-pin JST lead connector
};

export const mcuPadPoint = (slot, index, kind) => {
  const layout = PERIPHERAL_PAD_LAYOUTS[kind];
  if (layout) return layout(slot, index);
  const breaks = MCU_PIN_GROUPS[kind] ?? [];
  const gaps = breaks.filter((breakIndex) => index >= breakIndex).length;
  return { x: slot.x + 24 + index * MCU_PIN_SPACING + gaps * MCU_GROUP_GAP, y: slot.y + 18 };
};

function McuPinWires({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  return (
    <g className="rs-mcu-wires">
      {part.holes.map((hole, index) => {
        if (!hole) return null;
        const pad = mcuPadPoint(slot, index, part.kind);
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

// Pad names for off-board kinds without a fixedPins registry contract.
const OFFBOARD_PIN_NAMES = { dc_motor: ['+', '−'] };

function McuHeader({ part, light = false }) {
  const slot = part.meta.slot;
  const names = FIXED_PIN_NAMES[part.kind] ?? OFFBOARD_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  if (pinCount === 0) return null;
  // One plastic strip per pin group (power | digital | analog on the Uno),
  // mirroring the physical gaps between the real board's header blocks.
  const breaks = MCU_PIN_GROUPS[part.kind] ?? [];
  const groups = [0, ...breaks.filter((breakIndex) => breakIndex < pinCount), pinCount]
    .slice(0, -1)
    .map((start, groupIndex, starts) => [start, (starts[groupIndex + 1] ?? pinCount) - 1]);
  return (
    <g>
      {groups.map(([startPin, endPin]) => {
        const first = mcuPadPoint(slot, startPin, part.kind);
        const last = mcuPadPoint(slot, endPin, part.kind);
        return (
          <g key={startPin}>
            {/* black plastic pin-header strip with a top highlight edge */}
            <rect x={first.x - 9} y={first.y - 5} width={last.x - first.x + 18} height={10} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
            <line x1={first.x - 8} y1={first.y - 4} x2={last.x + 8} y2={first.y - 4} stroke="rgba(255,255,255,0.16)" strokeWidth="0.5" />
          </g>
        );
      })}
      {Array.from({ length: pinCount }, (_, index) => {
        const pad = mcuPadPoint(slot, index, part.kind);
        const alias = MCU_PIN_ALIASES[part.kind]?.[index];
        return (
          <g key={index}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y + 14} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 6, fill: light ? '#e9ede8' : '#f0f0ea' }}>
              {names[index] ?? index + 1}
            </text>
            {alias && (
              <text x={pad.x} y={pad.y + 20.5} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4, fill: light ? '#bcd7d9' : '#bcdedf' }}>
                {alias}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// SG90 micro servo in a compact off-board slot: blue body with mounting ears,
// the output hub, and a white two-arm cross horn.
function ServoBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 16;
  const bodyY = slot.y + 58;
  const bodyW = 104;
  const bodyH = 50;
  const hubX = x0 + 26;
  const names = FIXED_PIN_NAMES[part.kind] ?? OFFBOARD_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  // Live simulation: the horn tracks the decoded PWM angle (90° = neutral).
  const hornAngle = (sim?.angle ?? 90) - 90;
  return (
    <g>
      <rect x={x0 - 12} y={bodyY + 17} width={14} height={16} rx={2} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.5" />
      <rect x={x0 + bodyW - 2} y={bodyY + 17} width={14} height={16} rx={2} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.5" />
      <MountHole cx={x0 - 5} cy={bodyY + 25} r={3.2} />
      <MountHole cx={x0 + bodyW + 5} cy={bodyY + 25} r={3.2} />
      <rect x={x0} y={bodyY} width={bodyW} height={bodyH} rx={4} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.7" />
      <rect x={x0 + 1.6} y={bodyY + 1.6} width={bodyW - 3.2} height={bodyH - 3.2} rx={3.2} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.6" />
      {/* output hub + white cross horn */}
      <circle cx={hubX} cy={bodyY} r={10} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.7" />
      <g transform={hornAngle ? `rotate(${hornAngle} ${hubX} ${bodyY})` : undefined}>
        <rect x={hubX - 21} y={bodyY - 2.5} width={42} height={5} rx={2.5} fill="#f0f0ea" stroke="#c9c9bd" strokeWidth="0.5" />
        <rect x={hubX - 2.5} y={bodyY - 17} width={5} height={17} rx={2.5} fill="#f0f0ea" stroke="#c9c9bd" strokeWidth="0.5" />
      </g>
      <circle cx={hubX} cy={bodyY} r={2.8} fill="#f0f0ea" stroke="#c9c9bd" strokeWidth="0.5" />
      <Silk x={x0 + bodyW * 0.66} y={bodyY + 24} text={part.value || 'SG90'} size={6} weight={700} fill="#eaf1f4" />
      <Silk x={x0 + bodyW * 0.66} y={bodyY + 33} text="Micro Servo" size={3.8} fill="#cdd8ea" />
      <Silk x={x0 + bodyW * 0.66} y={bodyY + 43} text={part.ref} size={4.6} fill="#eaf1f4" />
      {/* Integrated 3-pin servo lead connector on the top edge (VCC/GND/SIG). */}
      <rect x={x0 + 52} y={bodyY - 6} width={39} height={12} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      <line x1={x0 + 53} y1={bodyY - 5} x2={x0 + 90} y2={bodyY - 5} stroke="rgba(255,255,255,0.16)" strokeWidth="0.5" />
      {Array.from({ length: pinCount }, (_, index) => {
        const pad = mcuPadPoint(slot, index, part.kind);
        return (
          <g key={index}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y + 12} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 5, fill: '#f0f0ea' }}>
              {names[index] ?? index + 1}
            </text>
          </g>
        );
      })}
      <McuPinWires part={part} />
    </g>
  );
}

// Brushed DC motor: silver can with a black end bell, two solder tabs, and the
// gold shaft stub.
function DcMotorBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const cx = slot.x + 88;
  const cy = slot.y + 74;
  const speed = sim?.speed01 ?? 0;
  const shaftX = cx - 45 - 12;
  return (
    <g>
      {/* shaft; in run mode a cross-mark spins at drive speed */}
      <rect x={cx - 45 - 15} y={cy - 2.5} width={16} height={5} rx={1.5} fill="url(#rsPartTab)" stroke="#7c848b" strokeWidth="0.4" />
      {speed > 0.03 && (
        <g className="rs-motor-spin" style={{ animationDuration: `${(1.4 - speed).toFixed(2)}s` }}>
          <line x1={shaftX - 4} y1={cy} x2={shaftX + 4} y2={cy} stroke="#3a4147" strokeWidth="1.6" strokeLinecap="round" />
          <line x1={shaftX} y1={cy - 4} x2={shaftX} y2={cy + 4} stroke="#3a4147" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}
      {/* can */}
      <rect x={cx - 45} y={cy - 22} width={90} height={44} rx={21} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.6" />
      <line x1={cx - 38} y1={cy - 17} x2={cx + 30} y2={cy - 17} stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
      {/* end bell with the two solder tabs */}
      <path d={`M ${cx + 31} ${cy - 22} h 6 a 8 8 0 0 1 8 8 v 28 a 8 8 0 0 1 -8 8 h -6 Z`} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.5" />
      <rect x={cx + 43} y={cy - 13} width={6} height={5} rx={1} fill="url(#rsGoldPad)" stroke="#8a6d14" strokeWidth="0.4" />
      <rect x={cx + 43} y={cy + 8} width={6} height={5} rx={1} fill="url(#rsGoldPad)" stroke="#8a6d14" strokeWidth="0.4" />
      <Silk x={cx - 6} y={cy + 2} text={part.ref} size={5} fill="#3c4640" />
      {part.value && <Silk x={cx - 6} y={cy + 9} text={part.value} size={3.8} fill="#5a636b" />}
      {/* The two end-bell tabs above are the actual terminals; label their polarity. */}
      <Silk x={cx + 39} y={cy - 8.5} text="+" size={5} weight={700} fill="#f0f0ea" />
      <Silk x={cx + 39} y={cy + 12.5} text="−" size={5} weight={700} fill="#f0f0ea" />
      <McuPinWires part={part} />
    </g>
  );
}

// Single-channel relay breakout: green PCB carrying the blue relay cube, a
// screw-terminal block on the COM/NO/NC side, and an indicator LED by the
// input header.
function RelayModuleBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 40;
  const w = 176;
  const h = 66;
  const names = FIXED_PIN_NAMES[part.kind] ?? OFFBOARD_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  const energized = Boolean(sim?.energized);
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="url(#rsPartPi)" stroke="#0f4423" strokeWidth="0.7" />
      <MountHole cx={x0 + 6} cy={y0 + h - 6} r={2.6} />
      <MountHole cx={x0 + w - 6} cy={y0 + h - 6} r={2.6} />
      {/* input side: indicator LED (lit while the coil is energized) + driver */}
      {energized && <circle cx={x0 + 14} cy={y0 + 12} r={6} fill="#ff5148" opacity={0.75} filter="url(#rsGlow)" />}
      <SmdLed cx={x0 + 14} cy={y0 + 12} color={energized ? '#ff6b5e' : '#e0453a'} w={5} h={3} />
      {energized && <rect x={x0 + 11.5} y={y0 + 10.5} width={5} height={3} rx={0.6} fill="#fff" opacity={0.55} />}
      <rect x={x0 + 8} y={y0 + 22} width={13} height={9} rx={1} fill="url(#rsPartDip)" stroke="#000" strokeWidth="0.4" />
      {/* the blue Songle cube */}
      <rect x={x0 + 54} y={y0 + 8} width={64} height={50} rx={2} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.7" />
      <rect x={x0 + 55.6} y={y0 + 9.6} width={60.8} height={46.8} rx={1.6} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.6" />
      <Silk x={x0 + 86} y={y0 + 26} text="SONGLE" size={5} weight={700} fill="#eaf1f4" />
      <Silk x={x0 + 86} y={y0 + 36} text={part.value || 'SRD-05VDC-SL-C'} size={3.2} fill="#cdd8ea" />
      {/* screw terminal block, COM/NO/NC side */}
      <rect x={x0 + w - 40} y={y0 + 9} width={32} height={48} rx={2} fill="#1f4d33" stroke="#0f2f1e" strokeWidth="0.6" />
      {[0, 1, 2].map((index) => (
        <g key={index}>
          <circle cx={x0 + w - 24} cy={y0 + 18 + index * 15} r={4.6} fill="url(#rsBrushedShield)" stroke="#5f6870" strokeWidth="0.5" />
          <line x1={x0 + w - 27} y1={y0 + 18 + index * 15} x2={x0 + w - 21} y2={y0 + 18 + index * 15} stroke="#565e66" strokeWidth="1" />
        </g>
      ))}
      <Silk x={x0 + 8} y={y0 + h - 5} text={part.ref} size={4.6} fill="#dff2e6" anchor="start" />
      {/* Integrated 3-pin input header (VCC/GND/IN) on the PCB's top edge. */}
      <rect x={x0 + 10} y={y0 - 5} width={46} height={10} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      {Array.from({ length: Math.min(3, pinCount) }, (_, index) => {
        const pad = mcuPadPoint(slot, index, part.kind);
        return (
          <g key={`in${index}`}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y - 7} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4.6, fill: '#f0f0ea' }}>
              {names[index] ?? index + 1}
            </text>
          </g>
        );
      })}
      {/* COM/NO/NC names beside the screw-terminal circles drawn above. */}
      {Array.from({ length: Math.max(0, pinCount - 3) }, (_, k) => {
        const index = k + 3;
        const pad = mcuPadPoint(slot, index, part.kind);
        return (
          <text key={`sc${index}`} x={x0 + w - 34} y={pad.y + 1.6} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4, fill: '#f0f0ea' }}>
            {names[index] ?? index + 1}
          </text>
        );
      })}
      <McuPinWires part={part} />
    </g>
  );
}

// Default silk for off-board breakouts drawn by the shared OffboardModuleBody.
const OFFBOARD_SILK = {
  stepper_driver: ['ULN2003', 'Stepper driver'],
  led_strip: ['WS2812', 'NeoPixel strip'],
  rfid_reader: ['RC522', 'RFID reader'],
  mouse_sensor: ['PMW3360', 'Mouse sensor'],
  current_sensor: ['ACS712', 'Current sensor'],
};

// Generic off-board breakout: a PCB sized to its header strip with silk
// labels. Base look for slot peripherals without bespoke artwork yet.
// pinNets is absent in library thumbnails (slotThumb), so fall back to the
// pad-name list for the pin count.
function OffboardModuleBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const names = FIXED_PIN_NAMES[part.kind] ?? OFFBOARD_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  const lastPad = mcuPadPoint(slot, Math.max(pinCount - 1, 0), part.kind);
  const x0 = slot.x + 10;
  const w = Math.max(lastPad.x + 24 - x0, 120);
  const y0 = slot.y + 24;
  const h = 80;
  const [title, subtitle] = OFFBOARD_SILK[part.kind] ?? [part.value || '', ''];
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="url(#rsPcbBlue)" stroke="#123a63" strokeWidth="0.7" />
      <MountHole cx={x0 + 6} cy={y0 + h - 6} r={2.6} />
      <MountHole cx={x0 + w - 6} cy={y0 + h - 6} r={2.6} />
      <Silk x={x0 + w / 2} y={y0 + h / 2 + 2} text={part.value || title} size={7} weight={700} fill="#dbe7f2" />
      {subtitle && <Silk x={x0 + w / 2} y={y0 + h / 2 + 12} text={subtitle} size={4} fill="#a9c3dc" />}
      <Silk x={x0 + 8} y={y0 + h - 5} text={part.ref} size={4.6} fill="#dbe7f2" anchor="start" />
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// RC522 breakout: the generic slot PCB, plus a white card hovering over the
// antenna (with its UID) while the sim's tap-card stimulus is active.
function RfidReaderBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 24;
  return (
    <g>
      <OffboardModuleBody part={part} />
      {sim?.cardPresent && (
        <g transform={`rotate(-8 ${x0 + 118} ${y0 + 30})`}>
          <rect x={x0 + 92} y={y0 + 12} width={52} height={34} rx={4} fill="#f5f7f9" stroke="#b9c2cc" strokeWidth="0.8" />
          <rect x={x0 + 96} y={y0 + 18} width={10} height={8} rx={1.5} fill="#d9b64c" stroke="#b28f37" strokeWidth="0.4" />
          <text x={x0 + 118} y={y0 + 38} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 4.4, fill: '#4a5560' }}>
            {sim.uid}
          </text>
        </g>
      )}
    </g>
  );
}

// PMW3360 breakout: the generic slot PCB plus the sensor lens. During sim it
// doubles as a trackpad — drag on it to feed motion counts — showing a live
// X/Y readout; the lens glows while unread motion is pending in the sensor.
function MouseSensorBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 24;
  return (
    <g>
      <OffboardModuleBody part={part} />
      <circle cx={x0 + 24} cy={y0 + 26} r={9} fill="#0b1520" stroke="#123a63" strokeWidth="0.8" />
      <circle cx={x0 + 24} cy={y0 + 26} r={4.5} fill="#1d3247" />
      {sim?.pending && (
        <circle cx={x0 + 24} cy={y0 + 26} r={11} fill="#d64545" opacity={0.55} filter="url(#rsGlow)" />
      )}
      {sim && (
        <text x={x0 + 24} y={y0 + 44} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 4.4, fill: '#a9c3dc' }}>
          {`X ${sim.x ?? 0}  Y ${sim.y ?? 0}`}
        </text>
      )}
    </g>
  );
}

// WS2812 NeoPixel strip: the generic slot PCB plus a row of pixel windows.
// With firmware running, each dot shows the decoded strip color live.
function LedStripBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const names = FIXED_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  const lastPad = mcuPadPoint(slot, Math.max(pinCount - 1, 0), part.kind);
  const x0 = slot.x + 10;
  const w = Math.max(lastPad.x + 24 - x0, 168);
  const y0 = slot.y + 24;
  const h = 80;
  const pixels = sim?.pixels ?? [];
  const dotCount = Math.max(Math.floor((w - 24) / 14), 8);
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="url(#rsPcbBlue)" stroke="#123a63" strokeWidth="0.7" />
      <MountHole cx={x0 + 6} cy={y0 + h - 6} r={2.6} />
      <MountHole cx={x0 + w - 6} cy={y0 + h - 6} r={2.6} />
      <Silk x={x0 + w / 2} y={y0 + 18} text={part.value || 'WS2812'} size={6} weight={700} fill="#dbe7f2" />
      <Silk x={x0 + w / 2} y={y0 + 27} text="NeoPixel strip" size={4} fill="#a9c3dc" />
      {Array.from({ length: dotCount }, (_, index) => {
        const [r, g, b] = pixels[index] ?? [0, 0, 0];
        const lit = r + g + b > 20;
        const cx = x0 + 18 + index * 14;
        return (
          <g key={index}>
            <rect x={cx - 6} y={y0 + 36} width={12} height={12} rx={1.5} fill="#f5f7f4" stroke="#c3ccc4" strokeWidth="0.5" />
            {lit && <circle cx={cx} cy={y0 + 42} r={8} fill={`rgb(${r} ${g} ${b})`} opacity="0.6" filter="url(#rsGlow)" />}
            <circle cx={cx} cy={y0 + 42} r={3.4} fill={lit ? `rgb(${r} ${g} ${b})` : '#20262b'} stroke="#565e56" strokeWidth="0.4" />
          </g>
        );
      })}
      <Silk x={x0 + 8} y={y0 + h - 5} text={part.ref} size={4.6} fill="#dbe7f2" anchor="start" />
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// 4x4 membrane keypad: matte-black pad with the standard 1-9/*0#/A-D legend,
// 8-pin ribbon header (R1-R4, C1-C4) on the top edge.
const KEYPAD_LEGEND = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
];

function KeypadBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 26;
  const w = 168;
  const h = 82;
  const cellW = (w - 20) / 4;
  const cellH = (h - 18) / 4;
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={4} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.7" />
      <rect x={x0 + 2} y={y0 + 2} width={w - 4} height={h - 4} rx={3} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
      {KEYPAD_LEGEND.map((row, rowIndex) =>
        row.map((digit, colIndex) => {
          const bx = x0 + 10 + colIndex * cellW;
          const by = y0 + 9 + rowIndex * cellH;
          const pressed = sim?.pressed?.includes?.(digit);
          return (
            <g key={digit}>
              <rect
                x={bx + 1.5}
                y={by + 1.5}
                width={cellW - 5}
                height={cellH - 5}
                rx={2.5}
                fill={pressed ? '#12161a' : '#2c3238'}
                stroke="#12161a"
                strokeWidth="0.5"
                data-keypad-key={digit}
                pointerEvents="all"
              />
              {!pressed && <line x1={bx + 3} y1={by + 3} x2={bx + cellW - 6} y2={by + 3} stroke="rgba(255,255,255,0.14)" strokeWidth="0.5" pointerEvents="none" />}
              <text x={bx + cellW / 2 - 1.5} y={by + cellH / 2 + 1} textAnchor="middle" pointerEvents="none" style={{ ...LABEL_STYLE, fontSize: 6, fontWeight: 700, fill: pressed ? '#9aa4ac' : '#e8ecef' }}>
                {digit}
              </text>
            </g>
          );
        }))}
      <Silk x={x0 + w - 6} y={y0 + h - 5} text={part.ref} size={4.6} fill="#c8d2da" anchor="end" />
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// KY-023 thumb-stick module: red PCB with the black stick tower and cap.
function JoystickBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 30;
  const w = 132;
  const h = 78;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2 + 4;
  // Live stick deflection: full axis throw moves the cap ±8 px inside the
  // fixed gimbal ring (the drag gesture / panel sliders feed sim.x/sim.y).
  const capDx = ((sim?.x ?? 0.5) - 0.5) * 16;
  const capDy = ((sim?.y ?? 0.5) - 0.5) * 16;
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="#b3363c" stroke="#6e1c22" strokeWidth="0.7" />
      <rect x={x0 + 1.6} y={y0 + 1.6} width={w - 3.2} height={h - 3.2} rx={2.4} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      {[[6, 6], [w - 6, 6], [6, h - 6], [w - 6, h - 6]].map(([dx, dy]) => (
        <MountHole key={`${dx}-${dy}`} cx={x0 + dx} cy={y0 + dy} r={2.6} />
      ))}
      {/* gimbal base + stick cap */}
      <rect x={cx - 22} y={cy - 22} width={44} height={44} rx={4} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      <circle cx={cx} cy={cy} r={17} fill="#20262b" stroke="#000" strokeWidth="0.5" />
      <g transform={`translate(${capDx} ${capDy})`}>
        <circle cx={cx} cy={cy} r={12.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
        <ellipse cx={cx - 4} cy={cy - 5} rx={4.5} ry={3} fill="rgba(255,255,255,0.16)" />
      </g>
      <Silk x={x0 + 8} y={y0 + h - 5} text={part.ref} size={4.6} fill="#f3dede" anchor="start" />
      <Silk x={x0 + w - 6} y={y0 + h - 5} text={part.value || 'KY-023'} size={4} fill="#f3dede" anchor="end" />
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// 16x2 character LCD on a PCF8574 I2C backpack: green PCB, black bezel, blue
// glass with the 16x2 character-cell grid, 4-pin header on the top edge.
// With live firmware, the cells show the actual HD44780 DDRAM text.
function LcdDisplayBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 24;
  const w = 264;
  const h = 84;
  const cellW = (w - 56) / 16;
  const cellH = (h - 48) / 2;
  const live = Array.isArray(sim?.lines);
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="url(#rsPartPi)" stroke="#0f4423" strokeWidth="0.7" />
      {[[6, 6], [w - 6, 6], [6, h - 6], [w - 6, h - 6]].map(([dx, dy]) => (
        <MountHole key={`${dx}-${dy}`} cx={x0 + dx} cy={y0 + dy} r={2.8} />
      ))}
      <rect x={x0 + 16} y={y0 + 14} width={w - 32} height={h - 28} rx={2} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      <rect x={x0 + 24} y={y0 + 20} width={w - 48} height={h - 40} rx={1.5} fill="#1d3f96" />
      {Array.from({ length: 2 }, (_, row) =>
        Array.from({ length: 16 }, (_, col) => (
          <rect
            key={`${row}-${col}`}
            x={x0 + 28 + col * cellW} y={y0 + 24 + row * cellH}
            width={cellW - 2.5} height={cellH - 4} rx={0.8} fill="#2c55c0"
          />
        )))}
      {live && sim.displayOn && sim.lines.map((line, row) =>
        Array.from(line).slice(0, 16).map((char, col) => (char === ' ' ? null : (
          <text
            key={`t${row}-${col}`}
            x={x0 + 28 + col * cellW + (cellW - 2.5) / 2}
            y={y0 + 24 + row * cellH + cellH * 0.68}
            textAnchor="middle"
            style={{ fontSize: cellH * 0.78, fontFamily: 'ui-monospace, Consolas, monospace', fill: '#eaf2ff', fontWeight: 600 }}
          >
            {char}
          </text>
        ))))}
      {live && sim.backlight === false && (
        <rect x={x0 + 24} y={y0 + 20} width={w - 48} height={h - 40} rx={1.5} fill="rgba(0,0,0,0.45)" />
      )}
      <Silk x={x0 + w - 8} y={y0 + h - 5} text={part.value || 'LCD1602 I2C'} size={4} fill="#dff2e6" anchor="end" />
      <Silk x={x0 + 8} y={y0 + h - 5} text={part.ref} size={4.6} fill="#dff2e6" anchor="start" />
      <McuHeader part={part} />
      <McuPinWires part={part} />
    </g>
  );
}

// L298N dual H-bridge: red PCB with the finned heatsink, control header on
// the top edge, and OUT1/OUT2 + OUT3/OUT4 screw blocks on the sides.
function MotorDriverBody({ part }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const x0 = slot.x + 10;
  const y0 = slot.y + 40;
  const w = 216;
  const h = 68;
  const names = FIXED_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} rx={3} fill="#b3363c" stroke="#6e1c22" strokeWidth="0.7" />
      <rect x={x0 + 1.6} y={y0 + 1.6} width={w - 3.2} height={h - 3.2} rx={2.4} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      <MountHole cx={x0 + 6} cy={y0 + h - 6} r={2.6} />
      <MountHole cx={x0 + w - 6} cy={y0 + h - 6} r={2.6} />
      {/* finned aluminum heatsink */}
      <rect x={x0 + 128} y={y0 + 12} width={56} height={48} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.6" />
      {Array.from({ length: 6 }, (_, index) => (
        <line key={index} x1={x0 + 133 + index * 9} y1={y0 + 14} x2={x0 + 133 + index * 9} y2={y0 + 58} stroke="#3a4147" strokeWidth="2" />
      ))}
      {/* screw blocks left (OUT1/OUT2) and right (OUT3/OUT4) */}
      {[[0, 8], [w - 24, 10]].map(([blockX, firstIndex]) => (
        <g key={blockX}>
          <rect x={x0 + blockX} y={y0 + 14} width={24} height={40} rx={2} fill="#1f6ea0" stroke="#0f3d5c" strokeWidth="0.6" />
          {[0, 1].map((k) => {
            const index = firstIndex + k;
            if (index >= pinCount) return null;
            const pad = mcuPadPoint(slot, index, part.kind);
            return (
              <g key={index}>
                <circle cx={pad.x} cy={pad.y} r={4.6} fill="url(#rsBrushedShield)" stroke="#5f6870" strokeWidth="0.5" />
                <line x1={pad.x - 3} y1={pad.y} x2={pad.x + 3} y2={pad.y} stroke="#565e66" strokeWidth="1" />
                <text x={pad.x + (blockX === 0 ? 9 : -9)} y={pad.y + 1.6} textAnchor={blockX === 0 ? 'start' : 'end'} style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4, fill: '#f0f0ea' }}>
                  {names[index] ?? index + 1}
                </text>
              </g>
            );
          })}
        </g>
      ))}
      <Silk x={x0 + 64} y={y0 + h - 8} text={part.value || 'L298N'} size={6} weight={700} fill="#f3dede" />
      <Silk x={x0 + 8} y={y0 + 10} text={part.ref} size={4.6} fill="#f3dede" anchor="start" />
      {/* control header (VS/GND/ENA/IN1/IN2/ENB/IN3/IN4) on the PCB top edge */}
      <rect x={x0 + 22} y={y0 - 5} width={128} height={10} rx={1.5} fill="url(#rsBlackPlastic)" stroke="#000" strokeWidth="0.4" />
      {Array.from({ length: Math.min(8, pinCount) }, (_, index) => {
        const pad = mcuPadPoint(slot, index, part.kind);
        return (
          <g key={`ctl${index}`}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y - 7} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4.2, fill: '#f0f0ea' }}>
              {names[index] ?? index + 1}
            </text>
          </g>
        );
      })}
      <McuPinWires part={part} />
    </g>
  );
}

// 28BYJ-48 stepper: blue can with mounting ears, the offset shaft boss, and
// the 5-wire lead into a white JST connector whose pads face the board.
function StepperMotorBody({ part, sim }) {
  const slot = part.meta.slot;
  if (!slot) return null;
  const cx = slot.x + 78;
  const cy = slot.y + 74;
  const r = 30;
  // Live shaft angle from the sim tracker (the servo-horn pattern).
  const shaftAngle = sim?.angle ?? 0;
  const names = FIXED_PIN_NAMES[part.kind] ?? [];
  const pinCount = part.pinNets?.length ?? names.length;
  const firstPad = mcuPadPoint(slot, 0, part.kind);
  return (
    <g>
      {/* mounting ears */}
      <rect x={cx - r - 14} y={cy - 5} width={16} height={10} rx={3} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <rect x={cx + r - 2} y={cy - 5} width={16} height={10} rx={3} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <MountHole cx={cx - r - 7} cy={cy} r={2.6} />
      <MountHole cx={cx + r + 7} cy={cy} r={2.6} />
      {/* blue can with the offset shaft boss */}
      <circle cx={cx} cy={cy} r={r} fill="url(#rsBluePlastic)" stroke="#173a75" strokeWidth="0.8" />
      <circle cx={cx} cy={cy} r={r - 2.4} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.7" />
      <circle cx={cx} cy={cy - 11} r={6} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.5" />
      <g transform={`rotate(${shaftAngle} ${cx} ${cy - 11})`}>
        <circle cx={cx} cy={cy - 11} r={2.6} fill="#e9edf0" stroke="#7c848b" strokeWidth="0.5" />
        <line x1={cx - 2.6} y1={cy - 13.2} x2={cx + 2.6} y2={cy - 13.2} stroke="#8a929a" strokeWidth="1" />
      </g>
      <Silk x={cx} y={cy + 8} text={part.value || '28BYJ-48'} size={4.6} weight={700} fill="#eaf1f4" />
      <Silk x={cx} y={cy + 15} text={part.ref} size={4.2} fill="#cdd8ea" />
      {/* wire harness into the JST lead connector */}
      <path d={`M ${cx + r - 6} ${cy + 10} C ${cx + r + 22} ${cy + 16}, ${firstPad.x - 26} ${firstPad.y + 16}, ${firstPad.x - 10} ${firstPad.y + 4}`} stroke="#3a4147" strokeWidth="6" fill="none" strokeLinecap="round" />
      <rect x={firstPad.x - 6} y={firstPad.y - 6} width={(Math.max(pinCount, 1) - 1) * 11 + 12} height={12} rx={2} fill="#f0f0ea" stroke="#c9c9bd" strokeWidth="0.5" />
      {Array.from({ length: pinCount }, (_, index) => {
        const pad = mcuPadPoint(slot, index, part.kind);
        return (
          <g key={index}>
            <GoldPad x={pad.x} y={pad.y} s={4.4} />
            <text x={pad.x} y={pad.y + 13} textAnchor="middle" style={{ ...LABEL_STYLE, ...DARK_HALO, fontSize: 4.6, fill: '#f0f0ea' }}>
              {names[index] ?? index + 1}
            </text>
          </g>
        );
      })}
      <McuPinWires part={part} />
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
  const bw = mcuPadPoint(slot, Math.max(pinCount - 1, 1), part.kind).x + 24 - bx0;
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
      <text x={fx(0.62)} y={fy(0.4)} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 13, fontWeight: 800, fill: 'none' }} stroke="#eef6f6" strokeWidth="0.7">UNO</text>
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
  const first = mcuPadPoint(slot, 0, part.kind);
  const last = mcuPadPoint(slot, Math.max(pinCount - 1, 1), part.kind);
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
      {Array.from({ length: pinCount }, (_, i) => <GoldPad key={`g${i}`} x={mcuPadPoint(slot, i, part.kind).x} y={first.y + 4.5} s={4.4} />)}
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

// Photovoltaic panel variant of the battery pack: identical slot geometry and
// terminal coordinates (so the rail wires and thumbnail viewBox are shared),
// but the body is a framed cell grid instead of a 9V can.
function SolarPanelPack({ battery, index }) {
  const x = 16;
  const y = 30 + index * 92;
  const width = 62;
  const height = 78;
  const plus = battery.plusHole ? holeCenter(battery.plusHole) : null;
  const minus = battery.minusHole ? holeCenter(battery.minusHole) : null;
  const terminalY = y + 6;
  const cellW = (width - 14) / 2;
  const cellH = (height - 34) / 3;
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
      {/* aluminum frame + panel face */}
      <rect x={x} y={y} width={width} height={height} rx={3} fill="url(#rsBrushedShield)" stroke="#7c848b" strokeWidth="0.8" />
      <rect x={x + 3} y={y + 12} width={width - 6} height={height - 16} rx={1.5} fill="url(#rsPartSolar)" stroke="#0a1425" strokeWidth="0.6" />
      {Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 2 }, (_, col) => (
          <rect
            key={`${row}-${col}`}
            x={x + 6 + col * (cellW + 2)} y={y + 15 + row * (cellH + 2)}
            width={cellW} height={cellH} rx={1} fill="#274a86" stroke="#3f66a8" strokeWidth="0.5"
          />
        )))}
      <line x1={x + 6 + cellW + 1} y1={y + 14} x2={x + 6 + cellW + 1} y2={y + height - 6} stroke="#c9d2da" strokeWidth="0.8" />
      <text x={x + width / 2} y={y + height - 9} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 7, fill: '#dbe7f2' }} fontWeight="600">
        {battery.value || '?V'}
      </text>
      <text x={x + width / 2} y={y + height - 2.5} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 5, fill: '#a9c3dc' }}>{battery.ref}</text>
      <circle cx={x + 17} cy={terminalY} r={5} fill="url(#rsBrushedShield)" stroke="#565e66" strokeWidth="0.7" />
      <circle cx={x + 17} cy={terminalY} r={2.6} fill="#22262a" />
      <circle cx={x + width - 17} cy={terminalY} r={3.4} fill="url(#rsBrushedShield)" stroke="#565e66" strokeWidth="0.7" />
      <text x={x + width - 17} y={terminalY + 12} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8, fontWeight: 700, fill: '#20262b' }}>+</text>
      <text x={x + 17} y={terminalY + 12} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8, fontWeight: 700, fill: '#20262b' }}>−</text>
    </g>
  );
}

export function BatteryPack({ battery, index }) {
  if (battery.kind === 'solar_panel') return <SolarPanelPack battery={battery} index={index} />;
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
      {/* 9V snap top: metal cap band, female − snap (ring) and male + stud */}
      <rect x={x} y={y} width={width} height={13} rx={5} fill="url(#rsPartTab)" stroke="#20262b" strokeWidth="0.7" />
      <rect x={x} y={y + 9} width={width} height={4} fill="url(#rsPartBattery)" />
      <circle cx={x + 17} cy={terminalY} r={5} fill="url(#rsBrushedShield)" stroke="#565e66" strokeWidth="0.7" />
      <circle cx={x + 17} cy={terminalY} r={2.6} fill="#22262a" />
      <circle cx={x + width - 17} cy={terminalY} r={3.4} fill="url(#rsBrushedShield)" stroke="#565e66" strokeWidth="0.7" />
      <circle cx={x + width - 18} cy={terminalY - 1} r={1.2} fill="rgba(255,255,255,0.55)" />
      <text x={x + width / 2} y={y + height / 2 + 6} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 9, fill: '#f0ede4' }} fontWeight="600">
        {battery.value || '?V'}
      </text>
      <text x={x + width / 2} y={y + height - 8} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 6, fill: '#c9c4b6' }}>{battery.ref}</text>
      <text x={x + width - 17} y={terminalY + 12} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8, fontWeight: 700, fill: '#f0ede4' }}>+</text>
      <text x={x + 17} y={terminalY + 12} textAnchor="middle" style={{ ...LABEL_STYLE, fontSize: 8, fontWeight: 700, fill: '#f0ede4' }}>−</text>
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
        const chipDy = part.meta?.columnStart != null
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
      <linearGradient id="rsPartZener" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#4a6da8" />
        <stop offset="0.5" stopColor="#27406e" />
        <stop offset="1" stopColor="#182a4c" />
      </linearGradient>
      <linearGradient id="rsPartSchottky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6b5a3e" />
        <stop offset="0.5" stopColor="#3a3020" />
        <stop offset="1" stopColor="#1e1810" />
      </linearGradient>
      <radialGradient id="rsPartLdr" cx="0.35" cy="0.35" r="0.95">
        <stop offset="0" stopColor="#f0dcb8" />
        <stop offset="1" stopColor="#d9ae74" />
      </radialGradient>
      <radialGradient id="rsPartThermistor" cx="0.35" cy="0.3" r="0.95">
        <stop offset="0" stopColor="#333a41" />
        <stop offset="1" stopColor="#101316" />
      </radialGradient>
      <linearGradient id="rsBluePlastic" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2f6fd0" />
        <stop offset="0.5" stopColor="#255bb0" />
        <stop offset="1" stopColor="#1d4c9a" />
      </linearGradient>
      <linearGradient id="rsPcbBlue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2b6fb0" />
        <stop offset="0.5" stopColor="#245c94" />
        <stop offset="1" stopColor="#1c4a80" />
      </linearGradient>
      <radialGradient id="rsPirDome" cx="0.38" cy="0.32" r="0.95">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.6" stopColor="#f0f0e6" />
        <stop offset="1" stopColor="#d8d8cc" />
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
      <linearGradient id="rsPartSolar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#16305e" />
        <stop offset="1" stopColor="#0c1c38" />
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
      {/* live-simulation LED halo: applied to a dedicated glow shape drawn
          behind the lens, so blur-only (no merge) is what we want */}
      <filter id="rsGlow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
      </filter>
    </defs>
  );
}

// Kind-specific artwork for parts whose placement body is the generic
// 'twoLead'/'module'; anything not listed falls back to the labeled gray
// ModuleBody box.
const KIND_RENDERERS = {
  resistor: ResistorBody,
  capacitor: CapacitorBody,
  led: LedBody,
  diode: DiodeBody,
  inductor: InductorBody,
  zener: ZenerBody,
  schottky: SchottkyBody,
  fuse: FuseBody,
  vibration_motor: VibrationMotorBody,
  bridge_rectifier: BridgeRectifierBody,
  photoresistor: LdrBody,
  thermistor: ThermistorBody,
  buzzer: BuzzerBody,
  crystal: CrystalBody,
  potentiometer: PotentiometerBody,
  switch_spdt: SlideSwitchBody,
  rgb_led: RgbLedBody,
  ultrasonic_sensor: UltrasonicBody,
  dht_sensor: DhtBody,
  oled_display: OledBody,
  pir_sensor: PirBody,
  rotary_encoder: RotaryEncoderBody,
  imu_sensor: ImuBody,
};

export function RealisticPart({ part, sim }) {
  // Off-board parts draw in their slot even when no pin is wired up yet.
  if (part.body === 'arduino_uno') return <ArduinoUnoBody part={part} />;
  if (part.body === 'raspberry_pi') return <RaspberryPiBody part={part} />;
  if (part.body === 'servo') return <ServoBody part={part} sim={sim} />;
  if (part.body === 'dc_motor') return <DcMotorBody part={part} sim={sim} />;
  if (part.body === 'relay_module') return <RelayModuleBody part={part} sim={sim} />;
  if (part.body === 'lcd_display') return <LcdDisplayBody part={part} sim={sim} />;
  if (part.body === 'motor_driver') return <MotorDriverBody part={part} />;
  if (part.body === 'stepper_motor') return <StepperMotorBody part={part} sim={sim} />;
  if (part.body === 'keypad') return <KeypadBody part={part} sim={sim} />;
  if (part.body === 'joystick') return <JoystickBody part={part} sim={sim} />;
  if (part.body === 'led_strip') return <LedStripBody part={part} sim={sim} />;
  if (part.body === 'rfid_reader') return <RfidReaderBody part={part} sim={sim} />;
  if (part.body === 'mouse_sensor') return <MouseSensorBody part={part} sim={sim} />;
  if (part.body === 'stepper_driver' || part.body === 'current_sensor') return <OffboardModuleBody part={part} />;
  const points = part.holes.map((hole) => (hole ? holeCenter(hole) : null)).filter(Boolean);
  if (points.length === 0) return null;
  if (part.body === 'esp32') return <Esp32Body part={part} />;
  if (part.body === 'dip') return <DipBody part={part} />;
  if (part.body === 'pushbutton') return <PushbuttonBody part={part} sim={sim} />;
  if (part.body === 'seven_segment') return <SevenSegmentBody part={part} sim={sim} />;
  if (part.body === 'to92') return <To92Body part={part} points={points} />;
  if (part.body === 'to220') return <To220Body part={part} points={points} />;
  const Renderer = ((part.body === 'twoLead' || part.body === 'module') && KIND_RENDERERS[part.kind]) || ModuleBody;
  return <Renderer part={part} points={points} sim={sim} />;
}

// --- component-library thumbnails ------------------------------------------
// Renders a kind's real breadboard artwork into a small standalone SVG for the
// library popover. Each spec fabricates the minimal synthetic part its
// renderer needs — top-strip holes for point-driven bodies, package meta for
// straddle/DIP bodies (plus one dummy hole to pass RealisticPart's empty-holes
// guard; those bodies draw purely from meta), a fake slot rect for off-board
// bodies — and a viewBox cropping the board-space region where that body
// draws (top-strip holes sit at y=84, the trench at y=161, slots at y=0).
// Every thumbnail embeds its own <PartDefs/>; duplicate gradient ids across
// sibling SVGs are benign since the definitions are identical and url(#…)
// resolves to the first one in the document.

const thumbHoles = (columns) => columns.map((column) => ({ strip: 'top', column, row: 0 }));
const DUMMY_THUMB_HOLES = [{ strip: 'bottom', column: 3, row: 0 }];

const thumbPart = (kind, body, columns, value = '', meta = {}) => ({
  kind, body, strip: 'top', ref: '', value, holes: thumbHoles(columns), pinNets: [], meta,
});
const dipThumb = (kind, value = '') => ({
  part: { kind, body: 'dip', strip: 'top', ref: '', value, holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 6 } },
  viewBox: '170 132 60 56',
});
// No pinNets on purpose: the slot bodies fall back to their pad-name list for
// the pin count (an empty pinNets array would collapse the Uno/Pi board width
// to a single pad).
const slotThumb = (kind, height, viewBox, value = '') => ({
  part: { kind, body: kind, strip: 'bottom', ref: '', value, holes: [], meta: { slot: { x: 0, y: 0, width: 448, height } } },
  viewBox,
});
const batteryThumb = (value) => ({
  render: () => <BatteryPack battery={{ ref: '', value }} index={0} />,
  viewBox: '12 26 70 86',
});

const TWO_LEAD_VIEWBOX = '168 50 64 40';
const MODULE3_VIEWBOX = '157 42 72 46';
const MODULE4_VIEWBOX = '160 40 80 50';
const MODULE5_VIEWBOX = '155 36 96 56';
const MODULE6_VIEWBOX = '150 32 106 62';

const THUMBNAIL_SPECS = {
  resistor: { part: thumbPart('resistor', 'twoLead', [3, 6], '1k'), viewBox: TWO_LEAD_VIEWBOX },
  capacitor: { part: thumbPart('capacitor', 'twoLead', [3, 6], '100nF'), viewBox: TWO_LEAD_VIEWBOX },
  inductor: { part: thumbPart('inductor', 'twoLead', [3, 6], '10uH'), viewBox: TWO_LEAD_VIEWBOX },
  diode: { part: thumbPart('diode', 'twoLead', [3, 6]), viewBox: TWO_LEAD_VIEWBOX },
  led: { part: thumbPart('led', 'twoLead', [3, 6], 'red'), viewBox: TWO_LEAD_VIEWBOX },
  zener: { part: thumbPart('zener', 'twoLead', [3, 6]), viewBox: TWO_LEAD_VIEWBOX },
  photoresistor: { part: thumbPart('photoresistor', 'twoLead', [3, 6]), viewBox: TWO_LEAD_VIEWBOX },
  thermistor: { part: thumbPart('thermistor', 'twoLead', [3, 6], '10k'), viewBox: TWO_LEAD_VIEWBOX },
  buzzer: { part: thumbPart('buzzer', 'twoLead', [3, 6]), viewBox: TWO_LEAD_VIEWBOX },
  crystal: { part: thumbPart('crystal', 'twoLead', [3, 6], '16MHz'), viewBox: TWO_LEAD_VIEWBOX },
  load: { part: thumbPart('load', 'twoLead', [3, 6], 'load'), viewBox: TWO_LEAD_VIEWBOX },
  bjt_npn: { part: thumbPart('bjt_npn', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  bjt_pnp: { part: thumbPart('bjt_pnp', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  mosfet_n: { part: thumbPart('mosfet_n', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  mosfet_p: { part: thumbPart('mosfet_p', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  temp_sensor: { part: thumbPart('temp_sensor', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  regulator: { part: thumbPart('regulator', 'to220', [3, 4, 5], '7805'), viewBox: '162 44 62 44' },
  opamp: dipThumb('opamp', 'LM358'),
  comparator: dipThumb('comparator'),
  timer_555: dipThumb('timer_555'),
  pushbutton: {
    part: { kind: 'pushbutton', body: 'pushbutton', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 4 } },
    viewBox: '158 134 56 54',
  },
  seven_segment: {
    part: { kind: 'seven_segment', body: 'seven_segment', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 7 } },
    viewBox: '167 130 80 62',
  },
  esp32: {
    part: { kind: 'esp32', body: 'esp32', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 2, columnEnd: 7 } },
    viewBox: '150 130 100 62',
  },
  potentiometer: { part: thumbPart('potentiometer', 'module', [3, 4, 5], '10k'), viewBox: MODULE3_VIEWBOX },
  switch_spdt: { part: thumbPart('switch_spdt', 'module', [3, 4, 5]), viewBox: MODULE3_VIEWBOX },
  rgb_led: { part: thumbPart('rgb_led', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  ultrasonic_sensor: { part: thumbPart('ultrasonic_sensor', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  dht_sensor: { part: thumbPart('dht_sensor', 'module', [3, 4, 5]), viewBox: MODULE3_VIEWBOX },
  oled_display: { part: thumbPart('oled_display', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  pir_sensor: { part: thumbPart('pir_sensor', 'module', [3, 4, 5]), viewBox: MODULE3_VIEWBOX },
  voltage_source: batteryThumb('9V'),
  signal_source: batteryThumb('∿'),
  servo: slotThumb('servo', 120, '0 36 142 80'),
  dc_motor: slotThumb('dc_motor', 120, '22 46 132 56'),
  relay_module: slotThumb('relay_module', 120, '4 34 188 78'),
  arduino_uno: slotThumb('arduino_uno', 292, '0 0 380 290'),
  raspberry_pi: slotThumb('raspberry_pi', 292, '0 0 420 285'),
  // DIP-16 needs a wider window than dipThumb's fixed 4-column package.
  shift_register: {
    part: { kind: 'shift_register', body: 'dip', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 10 } },
    viewBox: '170 132 116 56',
  },
  ir_receiver: { part: thumbPart('ir_receiver', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  rotary_encoder: { part: thumbPart('rotary_encoder', 'module', [3, 4, 5, 6, 7]), viewBox: MODULE5_VIEWBOX },
  imu_sensor: { part: thumbPart('imu_sensor', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  lcd_display: slotThumb('lcd_display', 120, '0 6 290 112'),
  motor_driver: slotThumb('motor_driver', 120, '0 26 240 90'),
  stepper_motor: slotThumb('stepper_motor', 120, '28 38 186 76'),
  stepper_driver: slotThumb('stepper_driver', 120, '0 8 250 106'),
  led_strip: slotThumb('led_strip', 120, '0 8 144 106'),
  // DIP-4 needs a narrower window than dipThumb's fixed 4-column package.
  optocoupler: {
    part: { kind: 'optocoupler', body: 'dip', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 4 } },
    viewBox: '170 132 46 56',
  },
  adc_module: {
    part: { kind: 'adc_module', body: 'dip', strip: 'top', ref: '', value: '', holes: DUMMY_THUMB_HOLES, pinNets: [], meta: { columnStart: 3, columnEnd: 10 } },
    viewBox: '170 132 116 56',
  },
  keypad: slotThumb('keypad', 120, '0 12 200 100'),
  joystick: slotThumb('joystick', 120, '0 12 160 100'),
  rfid_reader: slotThumb('rfid_reader', 120, '0 8 210 106'),
  mouse_sensor: slotThumb('mouse_sensor', 120, '0 8 210 106'),
  current_sensor: slotThumb('current_sensor', 120, '0 8 150 106'),
  rtc_module: { part: thumbPart('rtc_module', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  schottky: { part: thumbPart('schottky', 'twoLead', [3, 6], '1N5819'), viewBox: TWO_LEAD_VIEWBOX },
  fuse: { part: thumbPart('fuse', 'twoLead', [3, 6], '1A'), viewBox: TWO_LEAD_VIEWBOX },
  vibration_motor: { part: thumbPart('vibration_motor', 'twoLead', [3, 6]), viewBox: TWO_LEAD_VIEWBOX },
  bridge_rectifier: { part: thumbPart('bridge_rectifier', 'module', [3, 4, 5, 6], 'DB107'), viewBox: MODULE4_VIEWBOX },
  sound_sensor: { part: thumbPart('sound_sensor', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  hall_sensor: { part: thumbPart('hall_sensor', 'to92', [3, 4, 5]), viewBox: '163 52 60 38' },
  solar_panel: {
    render: () => <BatteryPack battery={{ ref: '', value: '6V', kind: 'solar_panel' }} index={0} />,
    viewBox: '12 26 70 86',
  },
  sd_card: { part: thumbPart('sd_card', 'module', [3, 4, 5, 6, 7, 8]), viewBox: MODULE6_VIEWBOX },
  soil_moisture: { part: thumbPart('soil_moisture', 'module', [3, 4, 5]), viewBox: MODULE3_VIEWBOX },
  gas_sensor: { part: thumbPart('gas_sensor', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
  baro_sensor: { part: thumbPart('baro_sensor', 'module', [3, 4, 5, 6]), viewBox: MODULE4_VIEWBOX },
};

export function PartThumbnail({ kind }) {
  const spec = THUMBNAIL_SPECS[kind] ?? { part: thumbPart(kind, 'module', [3, 4, 5]), viewBox: MODULE3_VIEWBOX };
  return (
    <svg className="realistic-part-thumb" viewBox={spec.viewBox} aria-hidden="true" focusable="false">
      <PartDefs />
      {spec.render ? spec.render() : <RealisticPart part={spec.part} />}
    </svg>
  );
}
