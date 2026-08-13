// Surface-mount pads are copper on ONE side. Everything downstream — the
// router's obstacle masks, the DRC's clearance model, the Gerber layer set and
// the .kicad_pcb pad token — has to agree about that, so these tests pin the
// difference between an SMD pad and a through-hole pad at each stage.
import { describe, expect, it } from 'vitest';
import { SMD_FOOTPRINTS, isSurfaceMount } from './smdFootprintLibrary.js';
import { KICAD_FOOTPRINTS } from './kicadFootprintLibrary.js';
import { footprintRecordFor } from './pcbFootprints.js';
import { buildPcbLayout } from './pcbLayout.js';
import { runDrc } from './pcbDrc.js';
import { checkCircuitTopology } from './topologyRules.js';
import { toKiCadPcb } from './kicadPcb.js';
import { toGerberArchive } from './gerberExport.js';
import { circuitToBreadboard } from '../features/realisticSchematic/breadboardModel.js';

const smdCircuit = {
  title: 'SMD indicator',
  supplyVoltage: 5,
  components: [
    { ref: 'J1', kind: 'terminal_block', value: '2-pos', nodes: ['V', '0'] },
    { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['V', 'A'], footprint: 'Resistor_SMD:R_0805_2012Metric' },
    { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['V', '0'], footprint: 'Capacitor_SMD:C_0805_2012Metric' },
    { ref: 'D1', kind: 'led', value: 'Red', nodes: ['A', '0'], footprint: 'LED_SMD:LED_0805_2012Metric' },
  ],
};

/** Minimal layout with one pad at (10,10) and a bottom trace running under it. */
const padUnderTrace = (padFields) => ({
  board: { width: 20, height: 20, thickness: 1.6, outline: { x: 0, y: 0, width: 20, height: 20 } },
  components: [{
    ref: 'R1',
    pads: [{
      x: 10, y: 10, net: 'A', padNumber: '1', connected: true,
      drill: padFields.type === 'smd' ? 0 : 0.8,
      diameter: 1.4, shape: 'rect', size: { w: 1.025, h: 1.4 }, ...padFields,
    }],
  }],
  traces: [{ layer: 'bottom', net: 'B', from: { x: 2, y: 10 }, to: { x: 18, y: 10 }, width: 0.8 }],
  vias: [], nets: ['A', 'B'], pour: null,
});

describe('SMD footprint library', () => {
  it('marks every pad smd, top-side and undrilled', () => {
    for (const [libId, record] of Object.entries(SMD_FOOTPRINTS)) {
      expect(isSurfaceMount(record), libId).toBe(true);
      for (const pad of record.pads) {
        expect(pad.type, `${libId} pad ${pad.number}`).toBe('smd');
        expect(pad.layer, `${libId} pad ${pad.number}`).toBe('top');
        expect(pad.drill, `${libId} pad ${pad.number}`).toBe(0);
      }
    }
  });

  it('does not collide with the generated through-hole library', () => {
    const overlap = Object.keys(SMD_FOOTPRINTS).filter((id) => id in KICAD_FOOTPRINTS);
    expect(overlap).toEqual([]);
  });

  it('keeps every pad inside its own courtyard', () => {
    for (const [libId, record] of Object.entries(SMD_FOOTPRINTS)) {
      for (const pad of record.pads) {
        expect(Math.abs(pad.x) + pad.size.w / 2, `${libId} pad ${pad.number} x`)
          .toBeLessThanOrEqual(Math.max(-record.courtyard.minX, record.courtyard.maxX) + 1e-9);
        expect(Math.abs(pad.y) + pad.size.h / 2, `${libId} pad ${pad.number} y`)
          .toBeLessThanOrEqual(Math.max(-record.courtyard.minY, record.courtyard.maxY) + 1e-9);
      }
    }
  });

  it('resolves through an explicit footprint field', () => {
    const resolved = footprintRecordFor({ kind: 'resistor', nodes: ['A', 'B'], footprint: 'Resistor_SMD:R_0805_2012Metric' });
    expect(resolved.libId).toBe('Resistor_SMD:R_0805_2012Metric');
    expect(resolved.record.pads[0].type).toBe('smd');
  });
});

describe('SMD pads occupy one layer', () => {
  // The whole point of the change: a through-hole pad's barrel conflicts with
  // copper on the far side, an SMD pad's does not.
  it('does not clear against copper on the opposite layer', () => {
    expect(runDrc(padUnderTrace({ type: 'smd', layer: 'top' })).ok).toBe(true);
  });

  it('still clears against copper on the opposite layer when through-hole', () => {
    const drc = runDrc(padUnderTrace({}));
    expect(drc.ok).toBe(false);
    expect(drc.violations.some((violation) => violation.type === 'clearance')).toBe(true);
  });

  it('carries type and layer from the footprint into the layout', () => {
    const layout = buildPcbLayout(smdCircuit);
    const resistor = layout.components.find((component) => component.ref === 'R1');
    const block = layout.components.find((component) => component.ref === 'J1');
    expect(resistor.pads.every((pad) => pad.type === 'smd' && pad.layer === 'top')).toBe(true);
    expect(block.pads.every((pad) => pad.type === undefined)).toBe(true);
  });

  it('routes a mixed SMD / through-hole board cleanly', () => {
    const layout = buildPcbLayout(smdCircuit);
    expect(layout.routing.complete).toBe(true);
    expect(layout.drc.ok).toBe(true);
    expect(layout.connectivity.ok).toBe(true);
  });
});

describe('ESP32-S3-WROOM-1 castellated module', () => {
  const modulePart = { kind: 'esp32_s3_wroom', nodes: Array.from({ length: 41 }, (_, i) => `N${i + 1}`) };
  const resolved = footprintRecordFor(modulePart);
  const padByNumber = Object.fromEntries(resolved.record.pads.map((pad) => [pad.number, pad]));

  it('resolves to the real RF_Module record with an identity 41-pad order', () => {
    expect(resolved.libId).toBe('RF_Module:ESP32-S3-WROOM-1');
    expect(resolved.record.pads).toHaveLength(41);
    expect(resolved.padOrder).toEqual(Array.from({ length: 41 }, (_, i) => String(i + 1)));
  });

  it('puts the corner pads where the datasheet land pattern does', () => {
    // Left column 1-14 top->bottom, bottom row 15-26 left->right, right
    // column 27-40 bottom->top (the datasheet's CCW numbering), EPAD centred.
    expect(padByNumber['1']).toMatchObject({ x: -8.75, y: -5.08, size: { w: 1.5, h: 0.9 } });
    expect(padByNumber['14']).toMatchObject({ x: -8.75, y: 11.43 });
    expect(padByNumber['15']).toMatchObject({ x: -6.985, y: 12.68, size: { w: 0.9, h: 1.5 } });
    expect(padByNumber['26']).toMatchObject({ x: 6.985, y: 12.68 });
    expect(padByNumber['27']).toMatchObject({ x: 8.75, y: 11.43 });
    expect(padByNumber['40']).toMatchObject({ x: 8.75, y: -5.08 });
    expect(padByNumber['41']).toMatchObject({ x: 0, y: 3.175, size: { w: 3.9, h: 3.9 } });
  });

  it('keeps every pitch-axis coordinate on the routing grid', () => {
    // This is what guarantees a grid-snapped placement puts a routing cell
    // dead-centre in every pad, so escapes never neck below the widest rung.
    for (const pad of resolved.record.pads) {
      const number = Number(pad.number);
      if (number === 41) continue;
      const along = number >= 15 && number <= 26 ? pad.x : pad.y;
      expect(Math.abs(along / 0.635 - Math.round(along / 0.635)), `pad ${pad.number}`).toBeLessThan(1e-9);
    }
  });

  it('leaves the antenna zone bare', () => {
    // Top ~7 mm of the body is the printed antenna: no pad may reach above
    // the pin-1/40 row.
    for (const pad of resolved.record.pads) {
      expect(pad.y - pad.size.h / 2, `pad ${pad.number}`).toBeGreaterThanOrEqual(-5.53 - 1e-9);
    }
  });

  // The worked example from knowledge/components/esp32_s3_wroom.md: regulated
  // 3.3V in, EN and BOOT pull-ups, an LED on IO48 (position 25), the rest NC.
  const nc = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `NC_U1_${from + i}`);
  const workedExample = {
    title: 'S3 module minimal boot',
    supplyVoltage: 3.3,
    components: [
      { ref: 'U1', kind: 'esp32_s3_wroom', value: 'ESP32-S3-WROOM-1-N8',
        nodes: ['0', '3V3', 'EN', ...nc(4, 24), 'LED1', 'NC_U1_26', 'BOOT', ...nc(28, 39), '0', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['EN', '3V3'] },
      { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['BOOT', '3V3'] },
      { ref: 'R3', kind: 'resistor', value: '330', nodes: ['LED1', 'LED1K'] },
      { ref: 'D1', kind: 'led', value: 'red', nodes: ['LED1K', '0'] },
    ],
  };

  it('lays out, routes and passes DRC with the doc worked example', () => {
    const layout = buildPcbLayout(workedExample);
    expect(layout.routing.complete).toBe(true);
    expect(layout.drc.ok).toBe(true);
    expect(layout.connectivity.ok).toBe(true);

    // Pad -> net, the assignment no gate checks (CLAUDE.md step 8): the
    // easiest 41-entry array to shift by one, so pin the named signals.
    const u1 = layout.components.find((component) => component.ref === 'U1');
    const net = (number) => u1.pads.find((pad) => pad.padNumber === number).net;
    expect(net('1')).toBe('0');
    expect(net('2')).toBe('3V3');
    expect(net('3')).toBe('EN');
    expect(net('25')).toBe('LED1');
    expect(net('27')).toBe('BOOT');
    expect(net('40')).toBe('0');
    expect(net('41')).toBe('0');
    expect(u1.pads.every((pad) => pad.type === 'smd' && pad.drill === 0)).toBe(true);
  });

  it('exports the EPAD as a drill-less smd pad token', () => {
    const layout = buildPcbLayout(workedExample);
    const pcb = toKiCadPcb(layout, workedExample);
    expect(pcb).toContain('RF_Module:ESP32-S3-WROOM-1');
    expect(pcb).toMatch(/\(pad "41" smd rect/);
    const drillLines = pcb.split('\n').filter((line) => / smd /.test(line) && line.includes('(drill'));
    expect(drillLines).toEqual([]);
  });
});

describe('connector kinds', () => {
  // dead_active_device fires on wiring-only parts whose live pins are all
  // power or ground. That is a connector's normal state, and the rule used to
  // flag it — but only on boards carrying an MCU, since that is what populates
  // supplyNets. Both halves of that bug are pinned here.
  const powerOnly = (extra = []) => ({
    title: 'connector', supplyVoltage: 3.3,
    components: [
      { ref: 'J1', kind: 'terminal_block', value: '2-pos', nodes: ['V3V3', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['V3V3', '0'] },
      ...extra,
    ],
  });

  it('does not call a power connector dead, with or without an MCU', () => {
    const withMcu = powerOnly([{
      ref: 'U1', kind: 'esp32', value: 'ESP32', nodes:
        ['V3V3', '0', 'NC_U1_3', 'V3V3', 'G2', 'G4', 'G5', 'G13', 'G18', 'G19', 'G21', 'G22'],
    }]);
    for (const circuit of [powerOnly(), withMcu]) {
      const dead = checkCircuitTopology(circuit).violations.filter((v) => v.id === 'dead_active_device');
      expect(dead.map((v) => v.refs?.[0] ?? v.refs)).not.toContain('J1');
    }
  });

  it('sizes a pin header from its node count', () => {
    const four = footprintRecordFor({ kind: 'pin_header', nodes: ['A', 'B', 'C', 'D'] });
    expect(four.libId).toBe('Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical');
    expect(four.record.pads).toHaveLength(4);
    // Past the vendored 1x02-1x08 range it falls through to the synthesized
    // header rather than throwing.
    const wide = footprintRecordFor({ kind: 'pin_header', nodes: Array.from({ length: 12 }, (_, i) => `N${i}`) });
    expect(wide.record.pads).toHaveLength(12);
  });
});

describe('breadboard view of a surface-mount circuit', () => {
  // A breadboard seats leads in 2.54mm holes. An 0805 chip has no leads, so a
  // breadboard layout of one is fiction — and the occupancy / rail-policy
  // checks then describe where imaginary leads landed. Say the real thing once
  // instead.
  it('explains that surface-mount parts cannot be breadboarded', () => {
    const warnings = circuitToBreadboard(smdCircuit).warnings.join(' ');
    expect(warnings).toMatch(/cannot be breadboarded/);
    expect(warnings).toMatch(/R1/);
  });

  it('drops the physical checks that cannot apply', () => {
    const warnings = circuitToBreadboard(smdCircuit).warnings.join(' ');
    for (const noise of ['OCCUPANCY:', 'RAIL-POLICY:', 'SEAM:']) {
      expect(warnings).not.toContain(noise);
    }
  });

  it('still runs them for an all-through-hole circuit', () => {
    const tht = { ...smdCircuit, components: smdCircuit.components.map(({ footprint, ...rest }) => rest) };
    const warnings = circuitToBreadboard(tht).warnings.join(' ');
    expect(warnings).not.toMatch(/cannot be breadboarded/);
  });
});

describe('SMD export', () => {
  const layout = buildPcbLayout(smdCircuit);

  it('emits an smd pad token with side-specific layers and no drill', () => {
    const pcb = toKiCadPcb(layout, smdCircuit);
    const smdLines = pcb.split('\n').filter((line) => / smd /.test(line));
    expect(smdLines).toHaveLength(6); // three 2-pad SMD parts
    for (const line of smdLines) {
      expect(line).toContain('(layers "F.Cu" "F.Paste" "F.Mask")');
      expect(line).not.toContain('(drill');
    }
    // The terminal block is still through-hole.
    expect(pcb.split('\n').filter((line) => /thru_hole/.test(line))).toHaveLength(2);
  });

  it('ships paste layers carrying only the surface-mount pads', () => {
    const archive = toGerberArchive(layout, smdCircuit);
    const data = (extension) => archive.files.find((file) => file.name.endsWith(extension)).data;
    const regions = (text) => (text.match(/G36\*/g) || []).length;
    expect(regions(data('.GTP'))).toBe(6);
    expect(regions(data('.GBP'))).toBe(0);
  });

  it('drills the through-hole pads only', () => {
    const archive = toGerberArchive(layout, smdCircuit);
    const drill = archive.files.find((file) => file.name.endsWith('.DRL')).data;
    expect((drill.match(/^X/gm) || []).length).toBe(2); // the terminal block
  });

  it('keeps a top-side SMD pad off the bottom copper layer', () => {
    // Measured against an otherwise identical through-hole board so the pour
    // and trace geometry cancel out and only the pads differ.
    const thtCircuit = {
      ...smdCircuit,
      components: smdCircuit.components.map(({ footprint, ...rest }) => rest),
    };
    const smdBottom = toGerberArchive(buildPcbLayout(smdCircuit), smdCircuit)
      .files.find((file) => file.name.endsWith('.GBL')).data;
    const thtBottom = toGerberArchive(buildPcbLayout(thtCircuit), thtCircuit)
      .files.find((file) => file.name.endsWith('.GBL')).data;
    const flashes = (text) => (text.match(/D03\*/g) || []).length;
    // Every through-hole pad flashes on the bottom layer; the SMD board's
    // bottom copper only carries the two terminal-block pads.
    expect(flashes(thtBottom)).toBeGreaterThan(flashes(smdBottom));
  });
});
