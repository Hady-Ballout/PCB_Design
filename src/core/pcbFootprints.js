// Mapping seam between the circuit model (SPICE-order nodes on a part) and
// real KiCad through-hole footprint geometry (src/core/kicadFootprintLibrary.js).
// Mirrors the KIND_TO_SYMBOL remap pattern in kicadSchematic.js, but for pads
// instead of schematic pins: KIND_TO_FOOTPRINT[kind].padOrder[i] is the
// footprint pad *number* that carries part.nodes[i].
import { KICAD_FOOTPRINTS } from './kicadFootprintLibrary.js';
import { SMD_FOOTPRINTS } from './smdFootprintLibrary.js';

// Through-hole (generated) plus surface-mount (hand-authored) in one lookup.
// Kept separate on disk because kicadFootprintLibrary.js is machine-generated.
const FOOTPRINTS = { ...KICAD_FOOTPRINTS, ...SMD_FOOTPRINTS };

/**
 * @typedef {{ number: string, x: number, y: number, shape: string,
 *   size: { w: number, h: number }, drill: number, angle: number }} FootprintPad
 * @typedef {{ type: 'line'|'circle'|'arc', width: number, [key: string]: any }} FootprintPrimitive
 * @typedef {{ libId: string, pads: FootprintPad[], silk: FootprintPrimitive[],
 *   fab: FootprintPrimitive[], courtyard: { minX: number, minY: number, maxX: number, maxY: number } }} FootprintRecord
 */

const identity = (count) => Array.from({ length: count }, (_, index) => String(index + 1));

// The vendored library zero-pads the pin count to two digits, so this template
// only names a real footprint for count <= 9 (a 1x10 header is
// `PinHeader_1x10_...`, not `PinHeader_1x010_...`). Every curated caller below
// is well inside that; anything larger would miss the library and fall through
// to synthesizedHeaderRecord, so guard loudly rather than silently degrade.
const pinHeader = (count) => {
  if (count > 9) throw new Error(`pinHeader: no 1x0${count} template — the vendored library only zero-pads to two digits (count <= 9)`);
  return {
    libId: `Connector_PinHeader_2.54mm:PinHeader_1x0${count}_P2.54mm_Vertical`,
    padOrder: identity(count),
  };
};

// Body classification for the 3D viewer (src/features/pcb3d/pcbScene.js),
// keyed by libId. Anything not listed (e.g. a bare pin header) renders as a
// plain labeled box, same as the old catalogue's default.
const BODY_BY_LIBID = {
  'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal': 'axial',
  'Inductor_THT:L_Axial_L9.5mm_D4.0mm_P15.24mm_Horizontal_Fastron_SMCC': 'axial',
  'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal': 'axial',
  'LED_THT:LED_D5.0mm': 'led',
  'Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm': 'radial',
  'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm': 'radial',
  'Package_TO_SOT_THT:TO-92_Inline': 'to92',
  'Package_TO_SOT_THT:TO-220-3_Vertical': 'to220',
  'Package_DIP:DIP-8_W7.62mm': 'dip',
  'Package_DIP:DIP-14_W7.62mm': 'dip',
  'Package_DIP:DIP-16_W7.62mm': 'dip',
  'TerminalBlock:TerminalBlock_bornier-2_P5.08mm': 'terminal',
};

// Module-ish kinds that get the synthesized fallback's larger silk body and
// the 3D viewer's "module" body (sub-board + header strips), matching the
// old FOOTPRINTS catalogue's arduino_uno/raspberry_pi/esp32 entries.
const MODULE_KINDS = new Set(['arduino_uno', 'raspberry_pi', 'esp32']);

/** Body dims (mm) for the synthesized fallback's silk rectangle / 3D sub-board. */
const BODY_SIZES = {
  arduino_uno: { width: 46, height: 34 },
  raspberry_pi: { width: 50, height: 36 },
  esp32: { width: 44, height: 26 },
  generic: { width: 10, height: 8 },
};

// Circuit kind → vendored footprint + node-to-pad remap. Node orders mirror
// KIND_TO_SYMBOL in kicadSchematic.js where the same physical convention
// applies (diode/LED polarity, BJT/MOSFET C-B-E-ish order, regulator
// IN-GND-OUT); footprint pad numbers are assigned by the KiCad library
// authors to match the part's physical pinout, not the SPICE node order.
const KIND_TO_FOOTPRINT = {
  // Resistive 2-terminal parts (resistor-shaped in the schematic too).
  resistor: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },
  load: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },
  fuse: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },
  photoresistor: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },
  ir_phototransistor: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },
  thermistor: { libId: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', padOrder: ['1', '2'] },

  // Non-polar by default; overridden to CP_Radial for electrolytic values
  // (see isElectrolytic below).
  capacitor: { libId: 'Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm', padOrder: ['1', '2'] },

  // Connectors. terminal_block and barrel_jack are both two-terminal power
  // entries; the bornier-2 screw block is the closest real footprint we
  // vendor, so the jack borrows it rather than synthesizing a bare header.
  terminal_block: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  barrel_jack: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },

  inductor: { libId: 'Inductor_THT:L_Axial_L9.5mm_D4.0mm_P15.24mm_Horizontal_Fastron_SMCC', padOrder: ['1', '2'] },

  // SPICE diode order is (anode, cathode); DO-41 pad 1 is the cathode
  // (silkscreen "K" is next to pad 1 in the vendored footprint).
  diode: { libId: 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal', padOrder: ['2', '1'] },
  zener: { libId: 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal', padOrder: ['2', '1'] },
  schottky: { libId: 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal', padOrder: ['2', '1'] },

  // Same (anode, cathode) SPICE order as diode; LED_D5.0mm pad 1 is the
  // square (keyed) pad, matching the DO-41 cathode convention.
  led: { libId: 'LED_THT:LED_D5.0mm', padOrder: ['2', '1'] },
  ir_led: { libId: 'LED_THT:LED_D5.0mm', padOrder: ['2', '1'] },

  // TO-92_Inline pads are just numbered 1-2-3 left to right; they carry no
  // inherent E/B/C meaning, so reuse kicadSchematic's Q_*_BCE pin numbers
  // verbatim (SPICE order is C, B, E; physical pins there are 1=B 2=C 3=E).
  bjt_npn: { libId: 'Package_TO_SOT_THT:TO-92_Inline', padOrder: ['2', '1', '3'] },
  bjt_pnp: { libId: 'Package_TO_SOT_THT:TO-92_Inline', padOrder: ['2', '1', '3'] },
  mosfet_n: { libId: 'Package_TO_SOT_THT:TO-92_Inline', padOrder: ['2', '1', '3'] },
  mosfet_p: { libId: 'Package_TO_SOT_THT:TO-92_Inline', padOrder: ['2', '1', '3'] },

  // Circuit order (IN, GND, OUT) matches the TO-220-3 physical pin order.
  regulator: { libId: 'Package_TO_SOT_THT:TO-220-3_Vertical', padOrder: ['1', '2', '3'] },

  // Single op-amp 5-node (in+, in-, out, v+, v-) placed on a DIP-8 in the
  // LM358-A pin style.
  opamp: { libId: 'Package_DIP:DIP-8_W7.62mm', padOrder: ['3', '2', '1', '8', '4'] },
  comparator: { libId: 'Package_DIP:DIP-8_W7.62mm', padOrder: ['3', '2', '1', '8', '4'] },
  // Canonical order = physical DIP-8 pins 1-8 (see componentKinds.js).
  ua741: { libId: 'Package_DIP:DIP-8_W7.62mm', padOrder: ['1', '2', '3', '4', '5', '6', '7', '8'] },
  timer_555: { libId: 'Package_DIP:DIP-8_W7.62mm', padOrder: ['1', '2', '3', '4', '5', '6', '7', '8'] },
  // PC817 is physically DIP-4 with canonical order = pins 1-4 (anode,
  // cathode, emitter, collector). A DIP-4 straddles the package: pins 1/2 down
  // one side, 3/4 directly opposite them. DIP-8 pads 1-4 are a SINGLE column
  // (all at x = -3.8), so the DIP-4 pins map onto the DIP-8 pads that face each
  // other across the 7.62mm body — pad 7 sits opposite pad 2, pad 8 opposite
  // pad 1. The part still inherits DIP-8 silk and courtyard, oversized for a
  // DIP-4 body; acceptable for v1 (the pads, holes and pin 1 marker are right,
  // which is what makes the board buildable) until a DIP-4 record is vendored.
  optocoupler: { libId: 'Package_DIP:DIP-8_W7.62mm', padOrder: ['1', '2', '7', '8'] },

  // 2-terminal sources and other simple 2-pin loads/actuators.
  voltage_source: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  signal_source: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  solar_panel: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  dc_motor: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  vibration_motor: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },
  buzzer: { libId: 'TerminalBlock:TerminalBlock_bornier-2_P5.08mm', padOrder: ['1', '2'] },

  // N-pin breakout-style connectors: header pin N carries node N.
  temp_sensor: pinHeader(3),
  ultrasonic_sensor: pinHeader(4),
  dht_sensor: pinHeader(3),
  oled_display: pinHeader(4),
  pir_sensor: pinHeader(3),
  servo: pinHeader(3),
  relay_module: pinHeader(6),
  stepper_motor: pinHeader(5),
  lcd_display: pinHeader(4),
  rotary_encoder: pinHeader(5),
  led_strip: pinHeader(3),
  imu_sensor: pinHeader(4),
  ir_receiver: pinHeader(3),
  keypad: pinHeader(8),
  joystick: pinHeader(5),
  rtc_module: pinHeader(4),
  sd_card: pinHeader(6),
  rfid_reader: pinHeader(8),
  mouse_sensor: pinHeader(8),
  soil_moisture: pinHeader(3),
  gas_sensor: pinHeader(4),
  sound_sensor: pinHeader(4),
  hall_sensor: pinHeader(3),
  baro_sensor: pinHeader(4),
  current_sensor: pinHeader(5),
};

// Electrolytic heuristic: value ends in µF/uF with a magnitude >= 1uF.
const isElectrolytic = (part) => {
  const match = /^([\d.]+)\s*[uµ]f$/i.exec(String(part?.value ?? '').trim());
  return match !== null && Number(match[1]) >= 1;
};

const footprintForKind = (part) => {
  // A pin header's footprint is its pin count, which only the circuit knows.
  // 2-8 hit real 1xNN library parts; anything wider falls through to
  // synthesizedHeaderRecord, which lays out a dual row rather than a strip.
  if (part?.kind === 'pin_header') {
    const count = part?.nodes?.length ?? 0;
    return count >= 2 && count <= 8 ? pinHeader(count) : null;
  }
  const mapped = KIND_TO_FOOTPRINT[part?.kind];
  if (!mapped) return null;
  if (part.kind === 'capacitor' && isElectrolytic(part)) {
    // CP_Radial pad "1" is the NEGATIVE terminal (rect pad at origin,
    // minus-sign on fab layer per the vendored KiCad 6.0.11 source); the
    // project convention is part.nodes[0] = positive, so remap like diode/LED.
    return { libId: 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm', padOrder: ['2', '1'] };
  }
  return mapped;
};

// Programmatic 1xN (N <= 6) or 2xN dual-row header at 2.54mm pitch for every
// kind without a curated footprint above (uncurated sensors/modules,
// arduino_uno/esp32/raspberry_pi, and any part whose node count doesn't
// match its kind's usual footprint).
const synthesizedHeaderRecord = (part) => {
  const count = Math.max(part?.nodes?.length ?? 0, 1);
  const pitch = 2.54;
  const drill = 1.0;
  const padSize = 1.7;
  const dualRow = count > 6;
  const perRow = dualRow ? Math.ceil(count / 2) : count;
  const pads = Array.from({ length: count }, (_, index) => {
    const row = dualRow && index >= perRow ? 1 : 0;
    const along = dualRow && index >= perRow ? count - 1 - index : index;
    return {
      number: String(index + 1),
      x: (along - (perRow - 1) / 2) * pitch,
      y: dualRow ? (row === 0 ? -pitch / 2 : pitch / 2) : 0,
      shape: index === 0 ? 'rect' : 'circle',
      size: { w: padSize, h: padSize },
      drill,
      angle: 0,
    };
  });

  const bodySize = BODY_SIZES[part?.kind] || BODY_SIZES.generic;
  const padExtentX = Math.max(...pads.map((pad) => Math.abs(pad.x)), 0) * 2 + padSize;
  const padExtentY = Math.max(...pads.map((pad) => Math.abs(pad.y)), 0) * 2 + padSize;
  const halfW = Math.max(bodySize.width, padExtentX) / 2;
  const halfH = Math.max(bodySize.height, padExtentY) / 2;
  const silk = [
    { type: 'line', start: { x: -halfW, y: -halfH }, end: { x: halfW, y: -halfH }, width: 0.12 },
    { type: 'line', start: { x: halfW, y: -halfH }, end: { x: halfW, y: halfH }, width: 0.12 },
    { type: 'line', start: { x: halfW, y: halfH }, end: { x: -halfW, y: halfH }, width: 0.12 },
    { type: 'line', start: { x: -halfW, y: halfH }, end: { x: -halfW, y: -halfH }, width: 0.12 },
  ];
  const libId = `Synthesized:${part?.kind || 'generic'}_${count}`;

  return {
    libId,
    record: { libId, pads, silk, fab: silk, courtyard: { minX: -halfW - 0.25, minY: -halfH - 0.25, maxX: halfW + 0.25, maxY: halfH + 0.25 } },
    padOrder: pads.map((pad) => pad.number),
  };
};

/**
 * Resolves the real KiCad footprint geometry for a placed part and the
 * node-index -> pad-number remap that carries its circuit nodes onto that
 * footprint's pads.
 *
 * Resolution order: (1) an exact `part.footprint` match against the vendored
 * library, (2) the kind's curated default, (3) a programmatic header
 * fallback. Falls through to the next step whenever a resolved footprint
 * doesn't have enough pads for the part's actual node count.
 *
 * @param {{ kind?: string, value?: string, footprint?: string, nodes?: unknown[] }} part
 * @returns {{ libId: string, record: FootprintRecord, padOrder: string[] }}
 */
export const footprintRecordFor = (part) => {
  const nodeCount = part?.nodes?.length ?? 0;

  if (part?.footprint && FOOTPRINTS[part.footprint]) {
    const record = FOOTPRINTS[part.footprint];
    if (record.pads.length >= nodeCount) {
      // If the exactly-matched libId is the same one the kind's resolved
      // default would pick, reuse its polarity-aware padOrder instead of
      // identity (an exact footprint match shouldn't silently drop the
      // diode/LED/electrolytic-cap pad remap). Uses footprintForKind (not
      // the static KIND_TO_FOOTPRINT table directly) so the electrolytic
      // capacitor override still applies here.
      const kindDefault = footprintForKind(part);
      const padOrder = kindDefault && kindDefault.libId === part.footprint && kindDefault.padOrder.length === nodeCount
        ? kindDefault.padOrder
        : identity(nodeCount);
      return { libId: part.footprint, record, padOrder };
    }
  }

  const mapped = footprintForKind(part);
  if (mapped) {
    const record = FOOTPRINTS[mapped.libId];
    if (record && record.pads.length >= nodeCount && mapped.padOrder.length === nodeCount) {
      return { libId: mapped.libId, record, padOrder: mapped.padOrder };
    }
  }

  return synthesizedHeaderRecord(part);
};

/**
 * The true footprint-local pad/silk/fab record behind a *placed* component
 * (a `pcbLayout.js` component, which carries a resolved `libId` and board-space
 * pads but not the original circuit part). Every exporter that needs local
 * geometry — kicadPcb.js for its footprint blocks, gerberExport.js for
 * silkscreen — goes through here, so there is one answer to "what does this
 * component actually look like".
 *
 * Two cases. (1) An exact `libId` match against the vendored library covers
 * every curated part, and any part whose original circuit `footprint` override
 * matched the library exactly (pcbPlace.js resolves that down to a concrete
 * `libId` before layout ever sees it). (2) Anything else is a
 * `Synthesized:<kind>_<count>` header pcbFootprints built on the fly;
 * `footprintRecordFor` regenerates the identical record from the kind and pad
 * count alone (it is a pure function of both), so a minimal reconstructed part
 * reproduces it exactly without needing the original circuit part object.
 *
 * @param {{ kind?: string, value?: string, libId?: string, pads?: unknown[] }} component
 * @returns {FootprintRecord}
 */
export const recordForPlacedComponent = (component) => {
  const direct = FOOTPRINTS[component?.libId];
  if (direct) return direct;
  const fakePart = {
    kind: component?.kind,
    value: component?.value,
    nodes: (component?.pads || []).map(() => ''),
  };
  return footprintRecordFor(fakePart).record;
};

/** Body classification for the 3D viewer (src/features/pcb3d/pcbScene.js). */
export const bodyKindFor = (libId, part) => {
  if (BODY_BY_LIBID[libId]) return BODY_BY_LIBID[libId];
  if (libId?.startsWith('Synthesized:') && MODULE_KINDS.has(part?.kind)) return 'module';
  return 'generic';
};
