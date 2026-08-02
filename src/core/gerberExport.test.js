import { describe, expect, it } from 'vitest';
import { PcbExportError, fabricationSlug, placedSilkStrokes, toGerberArchive } from './gerberExport.js';
import { KICAD_FOOTPRINTS } from './kicadFootprintLibrary.js';
import { buildPcbLayout } from './pcbLayout.js';
import { RULES } from './pcbDesignRules.js';

const RESISTOR = 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal';

const circuit = { title: 'RC low-pass' };

/**
 * A hand-built, gate-passing layout. Deliberately not the router's output: the
 * numbers below are round so the y-flip and aperture assertions can name exact
 * strings, and the board height (12) differs from twice any pad's y so a
 * flip is distinguishable from an identity.
 */
const fixtureLayout = (overrides = {}) => ({
  board: { width: 20, height: 12, thickness: 1.6, outline: { x: 0, y: 0, width: 20, height: 12 } },
  components: [{
    ref: 'R1',
    kind: 'resistor',
    value: '1k',
    body: 'axial',
    rotation: 0,
    libId: RESISTOR,
    courtyard: KICAD_FOOTPRINTS[RESISTOR].courtyard,
    x: 10,
    y: 4,
    width: 11.66,
    height: 3.5,
    pads: [
      { x: 4.92, y: 4, net: 'IN', pinIndex: 1, connected: true, padNumber: '1', drill: 0.8, diameter: 1.6, shape: 'circle', size: { w: 1.6, h: 1.6 } },
      { x: 15.08, y: 4, net: 'OUT', pinIndex: 2, connected: true, padNumber: '2', drill: 0.8, diameter: 1.6, shape: 'oval', size: { w: 1.6, h: 1.6 } },
    ],
  }],
  traces: [
    { layer: 'top', net: 'IN', from: { x: 4.92, y: 4 }, to: { x: 4.92, y: 8 }, width: 0.8 },
    { layer: 'bottom', net: 'OUT', from: { x: 15.08, y: 4 }, to: { x: 15.08, y: 8 }, width: 0.25 },
  ],
  vias: [{ x: 4.92, y: 8, net: 'IN', diameter: 1.2, drill: 0.6 }],
  nets: ['IN', 'OUT'],
  routing: { complete: true, failedNets: [] },
  drc: { ok: true, violations: [] },
  connectivity: { ok: true, incompleteNets: [] },
  ...overrides,
});

const archiveOf = (overrides) => toGerberArchive(fixtureLayout(overrides), circuit);
const fileNamed = (archive, name) => {
  const file = archive.files.find((entry) => entry.name === name);
  if (!file) throw new Error(`no ${name} in [${archive.files.map((entry) => entry.name).join(', ')}]`);
  return file.data;
};

const GERBER_NAMES = ['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GBO', 'GKO']
  .map((extension) => `rc-low-pass.${extension}`);

const countOf = (text, pattern) => (text.match(pattern) || []).length;

describe('fabricationSlug', () => {
  it('names the archive the same way the files inside it are named', () => {
    const archive = archiveOf();

    expect(fabricationSlug('RC low-pass')).toBe('rc-low-pass');
    expect(archive.files.every((file) => file.name.startsWith(fabricationSlug('RC low-pass'))
      || file.name === 'PCB-README.txt')).toBe(true);
  });

  it('falls back to a usable name when the title has nothing slug-worthy in it', () => {
    expect(fabricationSlug('!!!')).toBe('circuit');
    expect(fabricationSlug(undefined)).toBe('circuit');
  });
});

describe('toGerberArchive export gate', () => {
  it('refuses a board with unrouted nets', () => {
    const layout = fixtureLayout({
      routing: { complete: false, failedNets: [{ net: 'IN', reason: 'no_path' }] },
    });

    expect(() => toGerberArchive(layout, circuit)).toThrow(PcbExportError);
  });

  it('refuses a board with DRC violations and reports them verbatim', () => {
    const violation = { type: 'clearance', nets: ['IN', 'OUT'], at: { x: 1, y: 2 } };
    const layout = fixtureLayout({ drc: { ok: false, violations: [violation] } });

    try {
      toGerberArchive(layout, circuit);
      expect.unreachable('export should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(PcbExportError);
      expect(error.report.violations).toEqual([violation]);
      expect(error.report.failedNets).toEqual([]);
      expect(error.report.incompleteNets).toEqual([]);
    }
  });

  it('refuses a board whose nets are split into islands', () => {
    const layout = fixtureLayout({
      connectivity: { ok: false, incompleteNets: [{ net: 'IN', islands: 2 }] },
    });

    try {
      toGerberArchive(layout, circuit);
      expect.unreachable('export should have refused');
    } catch (error) {
      expect(error.report.incompleteNets).toEqual([{ net: 'IN', islands: 2 }]);
    }
  });
});

describe('toGerberArchive files', () => {
  it('writes every Protel-named layer plus a drill file and a README', () => {
    const archive = archiveOf();

    expect(archive.files.map((file) => file.name)).toEqual([
      ...GERBER_NAMES,
      'rc-low-pass.DRL',
      'PCB-README.txt',
    ]);
  });

  it('gives every Gerber file an RS-274X preamble and an M02 terminator', () => {
    const archive = archiveOf();

    for (const name of GERBER_NAMES) {
      const text = fileNamed(archive, name);
      expect(text, name).toContain('%TF.GenerationSoftware,PromptToPCB,pcb-pilot,dev*%');
      expect(text, name).toContain('%FSLAX46Y46*%');
      expect(text, name).toContain('%MOMM*%');
      expect(text, name).toContain('%LPD*%');
      expect(text, name).toContain('G01*');
      expect(text.trimEnd().endsWith('M02*'), name).toBe(true);
    }
  });

  it('carries no creation timestamp anywhere in the archive', () => {
    const archive = archiveOf();

    for (const file of archive.files) {
      expect(String(file.data), file.name).not.toMatch(/CreationDate/);
      expect(String(file.data), file.name).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
    }
  });

  it('summarises the board it produced', () => {
    const archive = archiveOf();

    expect(archive.summary).toEqual({
      boardWidth: 20,
      boardHeight: 12,
      layerFiles: [...GERBER_NAMES, 'rc-low-pass.DRL', 'PCB-README.txt'],
      drillCount: 3,
      netCount: 2,
      componentCount: 1,
    });
  });

  it('packs every file into the zip', () => {
    const archive = archiveOf();

    expect([...archive.zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(archive.zip);
    for (const file of archive.files) expect(text, file.name).toContain(file.name);
  });

  it('is byte-for-byte deterministic across runs', () => {
    expect([...archiveOf().zip]).toEqual([...archiveOf().zip]);
  });
});

describe('toGerberArchive copper layers', () => {
  it('flashes every through-hole pad and via on BOTH copper layers', () => {
    const archive = archiveOf();

    for (const name of ['rc-low-pass.GTL', 'rc-low-pass.GBL']) {
      // 2 pads + 1 via, and nothing else flashes.
      expect(countOf(fileNamed(archive, name), /D03\*/g), name).toBe(3);
    }
  });

  it('draws each trace only on its own layer', () => {
    const archive = archiveOf();
    const top = fileNamed(archive, 'rc-low-pass.GTL');
    const bottom = fileNamed(archive, 'rc-low-pass.GBL');

    expect(countOf(top, /D01\*/g)).toBe(1);
    expect(countOf(bottom, /D01\*/g)).toBe(1);
  });

  it('declares one circle aperture per distinct trace width', () => {
    const archive = archiveOf();

    expect(fileNamed(archive, 'rc-low-pass.GTL')).toMatch(/%ADD\d+C,0\.800000\*%/);
    expect(fileNamed(archive, 'rc-low-pass.GBL')).toMatch(/%ADD\d+C,0\.250000\*%/);
    // The 0.25mm neck-down width is only used on the bottom layer here, so the
    // top file must not carry a dead aperture for it.
    expect(fileNamed(archive, 'rc-low-pass.GTL')).not.toMatch(/%ADD\d+C,0\.250000\*%/);
  });

  it('flips y exactly once: a pad at layout y=4 on a 12mm board lands at Y=8mm', () => {
    const archive = archiveOf();

    // 4.6 format: millimetres x 1e6. Layout (4.92, 4) -> Gerber (4.92, 12 - 4).
    expect(fileNamed(archive, 'rc-low-pass.GTL')).toContain('X4920000Y8000000D03*');
    expect(fileNamed(archive, 'rc-low-pass.GBL')).toContain('X4920000Y8000000D03*');
    expect(fileNamed(archive, 'rc-low-pass.GTS')).toContain('X4920000Y8000000D03*');
  });

  it('flips the drill file with the identical rule, so holes register with copper', () => {
    const archive = archiveOf();

    expect(fileNamed(archive, 'rc-low-pass.DRL')).toContain('X4.920Y8.000');
  });

  it('flips the board outline with the identical rule', () => {
    const outline = fileNamed(archiveOf(), 'rc-low-pass.GKO');

    // Layout corner (0,0) is the TOP-left, so it must come out at Gerber Y=12mm.
    expect(outline).toContain('X0Y12000000D02*');
    expect(outline).toContain('X20000000Y0D01*');
  });

  it('paints a rectangular pad as a filled region rather than a flash', () => {
    const layout = fixtureLayout();
    layout.components[0].pads[0] = {
      ...layout.components[0].pads[0], shape: 'rect', size: { w: 3, h: 2 },
    };
    const top = toGerberArchive(layout, circuit).files.find((file) => file.name === 'rc-low-pass.GTL').data;

    expect(top).toContain('G36*');
    expect(top).toContain('G37*');
    // Board-space size, axis-aligned and centred on (4.92, 4): x 3.42..6.42,
    // y 3..5, which is Gerber y 9..7.
    expect(top).toContain('X3420000Y9000000D02*');
    expect(top).toContain('X6420000Y7000000D01*');
  });

  it('selects an aperture before the first region, so no file ships with zero %ADD', () => {
    // A G36 region ignores the current aperture, so a layer whose first (or
    // only) graphic object is a region used to emit no %ADD at all — legal
    // RS-274X, but enough to make some CAM front-ends complain.
    const layout = fixtureLayout();
    layout.components[0].pads[0] = {
      ...layout.components[0].pads[0], shape: 'rect', size: { w: 3, h: 2 },
    };
    const top = toGerberArchive(layout, circuit).files.find((file) => file.name === 'rc-low-pass.GTL').data;

    expect(top).toMatch(/%ADD\d+C,0\.010000\*%/);
    const firstRegion = top.indexOf('G36*');
    expect(top.slice(0, firstRegion)).toMatch(/^D\d+\*$/m);
  });

  it('throws on a non-finite coordinate instead of writing XNaN into the file', () => {
    const layout = fixtureLayout();
    layout.components[0].pads[0] = { ...layout.components[0].pads[0], x: Number.NaN };

    expect(() => toGerberArchive(layout, circuit)).toThrow(/non-finite/i);
  });

  it('strokes an elongated oval pad between its foci', () => {
    const layout = fixtureLayout();
    layout.components[0].pads[0] = {
      ...layout.components[0].pads[0], shape: 'oval', size: { w: 3, h: 1.6 },
    };
    const top = toGerberArchive(layout, circuit).files.find((file) => file.name === 'rc-low-pass.GTL').data;

    // A 3 x 1.6 stadium = a 1.6mm-wide stroke from (4.92-0.7, 4) to (4.92+0.7, 4).
    expect(top).toMatch(/%ADD\d+C,1\.600000\*%/);
    expect(top).toContain('X4220000Y8000000D02*');
    expect(top).toContain('X5620000Y8000000D01*');
  });
});

describe('toGerberArchive solder mask', () => {
  it('opens each pad expanded by the mask expansion rule', () => {
    const archive = archiveOf();
    const opening = 1.6 + 2 * RULES.maskExpansion;

    for (const name of ['rc-low-pass.GTS', 'rc-low-pass.GBS']) {
      expect(fileNamed(archive, name), name)
        .toMatch(new RegExp(`%ADD\\d+C,${opening.toFixed(6).replace('.', '\\.')}\\*%`));
      // 2 pads open, the via stays tented.
      expect(countOf(fileNamed(archive, name), /D03\*/g), name).toBe(2);
    }
  });

  it('declares negative file polarity, the convention for a mask of openings', () => {
    const archive = archiveOf();

    for (const name of ['rc-low-pass.GTS', 'rc-low-pass.GBS']) {
      expect(fileNamed(archive, name), name).toContain('%TF.FilePolarity,Negative*%');
    }
    for (const name of ['rc-low-pass.GTL', 'rc-low-pass.GKO']) {
      expect(fileNamed(archive, name), name).toContain('%TF.FilePolarity,Positive*%');
    }
  });

  it('tents vias: no via-sized aperture reaches the mask', () => {
    const archive = archiveOf();

    expect(fileNamed(archive, 'rc-low-pass.GTS')).not.toMatch(/%ADD\d+C,1\.2/);
    expect(fileNamed(archive, 'rc-low-pass.GBS')).not.toMatch(/%ADD\d+C,1\.2/);
  });
});

describe('toGerberArchive silkscreen', () => {
  it('draws the footprint silk primitives on the top silk layer', () => {
    const silk = fileNamed(archiveOf(), 'rc-low-pass.GTO');

    // The vendored resistor silk is six 0.12mm lines.
    expect(silk).toMatch(/%ADD\d+C,0\.120000\*%/);
    expect(countOf(silk, /D01\*/g)).toBeGreaterThanOrEqual(6);
  });

  it('adds the reference designator in a 0.15mm single-stroke font above the courtyard', () => {
    const silk = fileNamed(archiveOf(), 'rc-low-pass.GTO');
    const code = /%ADD(\d+)C,0\.150000\*%/.exec(silk)?.[1];
    expect(code, 'a 0.15mm text aperture').toBeTruthy();

    const strokes = silk.slice(silk.indexOf(`\nD${code}*`));
    const ys = [...strokes.matchAll(/Y(-?\d+)D0[12]\*/g)].map((match) => Number(match[1]));
    expect(ys.length).toBeGreaterThan(4);
    // Courtyard top is layout y = 4 + minY, i.e. Gerber Y = 12 - (4 + minY).
    const courtyardTop = (12 - (4 + KICAD_FOOTPRINTS[RESISTOR].courtyard.minY)) * 1e6;
    for (const y of ys) expect(y).toBeGreaterThan(courtyardTop);
  });

  it('skips characters the font has no glyph for instead of throwing', () => {
    const layout = fixtureLayout();
    layout.components[0].ref = 'R~1';

    expect(() => toGerberArchive(layout, circuit)).not.toThrow();
  });

  it('emits a valid but empty bottom silk file (every part is top-side)', () => {
    const back = fileNamed(archiveOf(), 'rc-low-pass.GBO');

    expect(back).toContain('%FSLAX46Y46*%');
    expect(back.trimEnd().endsWith('M02*')).toBe(true);
    expect(countOf(back, /D0[123]\*/g)).toBe(0);
  });
});

describe('placedSilkStrokes', () => {
  const component = {
    ref: 'R1', kind: 'resistor', value: '1k', libId: RESISTOR, x: 10, y: 4, rotation: 0, pads: [],
  };

  it('returns the footprint silk as board-space polylines with real widths', () => {
    const strokes = placedSilkStrokes(component);
    // The vendored resistor silk is six 0.12mm lines.
    expect(strokes).toHaveLength(6);
    for (const stroke of strokes) {
      expect(stroke.width).toBe(0.12);
      expect(stroke.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('applies the placement rotation (180° mirrors every point through the centre)', () => {
    const flat = placedSilkStrokes(component);
    const turned = placedSilkStrokes({ ...component, rotation: 180 });
    const [x0, y0] = flat[0].points[0];
    const [x180, y180] = turned[0].points[0];
    expect(x180).toBeCloseTo(2 * component.x - x0, 9);
    expect(y180).toBeCloseTo(2 * component.y - y0, 9);
  });
});

describe('toGerberArchive board outline', () => {
  it('draws four edges with a 0.1mm aperture', () => {
    const outline = fileNamed(archiveOf(), 'rc-low-pass.GKO');

    expect(outline).toMatch(/%ADD\d+C,0\.100000\*%/);
    expect(countOf(outline, /D01\*/g)).toBe(4);
  });
});

describe('toGerberArchive Excellon drill', () => {
  it('declares one plated tool per unique diameter, ascending', () => {
    const drill = fileNamed(archiveOf(), 'rc-low-pass.DRL');

    expect(drill).toMatch(/^M48$/m);
    expect(drill).toMatch(/^METRIC,TZ$/m);
    expect(drill).toMatch(/^T1C0\.600$/m);
    expect(drill).toMatch(/^T2C0\.800$/m);
    expect(drill).toMatch(/^%$/m);
    expect(drill.trimEnd().endsWith('M30')).toBe(true);
    expect(drill).toMatch(/^T0$/m);
  });

  it('emits one hit per pad and via', () => {
    const drill = fileNamed(archiveOf(), 'rc-low-pass.DRL');

    expect(countOf(drill, /^X-?[\d.]+Y-?[\d.]+$/gm)).toBe(3);
  });

  it('groups hits under their own tool', () => {
    const drill = fileNamed(archiveOf(), 'rc-low-pass.DRL');
    const viaSection = drill.slice(drill.indexOf('\nT1\n'), drill.indexOf('\nT2\n'));

    expect(countOf(viaSection, /^X-?[\d.]+Y-?[\d.]+$/gm)).toBe(1);
    expect(viaSection).toContain('X4.920Y4.000');
  });
});

describe('toGerberArchive README', () => {
  it('states the board envelope, stack, rules and counts', () => {
    const readme = fileNamed(archiveOf(), 'PCB-README.txt');

    expect(readme).toContain('20 x 12 mm');
    expect(readme).toContain('2-layer');
    expect(readme).toContain('1.6 mm');
    expect(readme).toContain(`${RULES.clearance}`);
    expect(readme).toContain('Nets: 2');
    expect(readme).toContain('Components: 1');
    expect(readme).toContain('vias tented');
    expect(readme.toLowerCase()).toContain('polarity per silkscreen');
  });

  it('does not claim the package is positive polarity, since the mask files are not', () => {
    const readme = fileNamed(archiveOf(), 'PCB-README.txt');

    expect(readme.toLowerCase()).not.toContain('positive polarity');
  });
});

describe('toGerberArchive on a circuit with no ground net', () => {
  // Nothing here matches the router's GROUND_NET_RE, so the bottom-copper
  // ground pour must never appear. Snapshotted before the pour existed, so its
  // additiveness is provable rather than merely asserted.
  const groundFreeCircuit = {
    title: 'Ground-free divider',
    components: [
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['A', 'B'] },
      { ref: 'R2', kind: 'resistor', value: '2k2', nodes: ['B', 'C'] },
    ],
  };

  it('matches the bottom-copper bytes recorded before the ground pour existed', () => {
    const layout = buildPcbLayout(groundFreeCircuit);
    expect(layout.nets.some((net) => /^(gnd|ground|0)$/i.test(net))).toBe(false);

    const archive = toGerberArchive(layout, groundFreeCircuit);
    expect(fileNamed(archive, 'ground-free-divider.GBL')).toMatchSnapshot();
  });
});

describe('toGerberArchive on a real routed layout', () => {
  const rcLowPass = {
    title: 'RC low-pass',
    components: [
      { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VIN', '0'] },
      { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VIN', 'VOUT'] },
      { ref: 'C1', kind: 'capacitor', value: '100nF', nodes: ['VOUT', '0'] },
    ],
  };

  it('paints the ground pour on the bottom copper and nowhere else', () => {
    const layout = buildPcbLayout(rcLowPass);
    expect(layout.pour).toBeTruthy();

    const archive = toGerberArchive(layout, rcLowPass);
    const top = fileNamed(archive, 'rc-low-pass.GTL');
    const bottom = fileNamed(archive, 'rc-low-pass.GBL');

    // The pour is the only difference between the two layers' region counts:
    // pads paint identical regions on both.
    expect(countOf(bottom, /G36\*/g)).toBe(countOf(top, /G36\*/g) + layout.pour.polygons.length);
    expect(countOf(bottom, /G37\*/g)).toBe(countOf(bottom, /G36\*/g));

    // The first pour rectangle's own corner, y-flipped like everything else.
    const [corner] = layout.pour.polygons[0];
    const flipped = Math.round((layout.board.height - corner.y) * 1e6);
    expect(bottom).toContain(`X${Math.round(corner.x * 1e6)}Y${flipped}D02*`);
  });

  it('leaves the solder mask alone: the pour is tented, not opened', () => {
    const layout = buildPcbLayout(rcLowPass);
    const archive = toGerberArchive(layout, rcLowPass);

    expect(countOf(fileNamed(archive, 'rc-low-pass.GBS'), /G36\*/g))
      .toBe(countOf(fileNamed(archive, 'rc-low-pass.GTS'), /G36\*/g));
  });

  it('warns in the README that a poured ground pad needs more heat', () => {
    const readme = fileNamed(toGerberArchive(buildPcbLayout(rcLowPass), rcLowPass), 'PCB-README.txt');

    expect(readme).toContain('ground pour');
    expect(readme.toLowerCase()).toContain('direct connect');
    expect(readme.toLowerCase()).toContain('heat');
  });

  it('exports a board the pipeline actually routed', () => {
    const layout = buildPcbLayout(rcLowPass);
    expect(layout.routing.complete && layout.drc.ok && layout.connectivity.ok).toBe(true);

    const archive = toGerberArchive(layout, rcLowPass);

    expect(archive.summary.componentCount).toBe(3);
    expect(archive.summary.drillCount).toBe(6);
    // (rcLowPass has no multi-pad-footprint part; the DIP-8 case is below.)
    const copper = archive.files.find((file) => file.name === 'rc-low-pass.GTL').data;
    // Six pads: five flash, the terminal block's keyed rect pad paints a region.
    expect(countOf(copper, /D03\*/g) + countOf(copper, /G36\*/g)).toBe(6);
    // Every emitted coordinate must sit inside the board envelope; a botched
    // flip would push half the geometry negative.
    for (const [, y] of copper.matchAll(/Y(-?\d+)D0[123]\*/g)) {
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(layout.board.height * 1e6);
    }
  });

  // A DIP-8 op-amp uses five circuit nodes but has eight legs. If the fab data
  // only carries the five wired pads, the chip physically cannot be inserted —
  // and every gate would still call the board manufacturable.
  const invertingAmp = {
    title: 'Inverting amplifier',
    components: [
      { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['0', 'INV', 'OUT', 'VCC', '0'] },
      { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['IN', 'INV'] },
      { ref: 'R2', kind: 'resistor', value: '100k', nodes: ['INV', 'OUT'] },
      { ref: 'V1', kind: 'signal_source', value: '1Vpp', nodes: ['IN', '0'] },
      { ref: 'V2', kind: 'voltage_source', value: '12V', nodes: ['VCC', '0'] },
    ],
  };

  it('drills, coppers and unmasks all eight legs of a DIP-8 op-amp, not just its five wired nodes', () => {
    const layout = buildPcbLayout(invertingAmp);
    expect(layout.routing.complete && layout.drc.ok && layout.connectivity.ok).toBe(true);

    const opamp = layout.components.find((component) => component.ref === 'XU1');
    expect(opamp.pads).toHaveLength(8);
    expect(opamp.pads.filter((pad) => pad.connected)).toHaveLength(5);

    const archive = toGerberArchive(layout, invertingAmp);
    const padHoles = layout.components
      .reduce((total, component) => total + component.pads.filter((pad) => pad.drill > 0).length, 0);
    const viaHoles = layout.vias.filter((via) => via.drill > 0).length;

    expect(archive.summary.drillCount).toBe(padHoles + viaHoles);
    const drill = fileNamed(archive, 'inverting-amplifier.DRL');
    expect(countOf(drill, /^X-?[\d.]+Y-?[\d.]+$/gm)).toBe(padHoles + viaHoles);

    // Each unwired leg gets a hole, top copper and a mask opening at its own
    // coordinate — the three things a fab house needs to make the hole usable.
    const size3 = (value) => value.toFixed(3);
    const um = (value) => String(Math.round(value * 1e6));
    const top = fileNamed(archive, 'inverting-amplifier.GTL');
    const mask = fileNamed(archive, 'inverting-amplifier.GTS');
    for (const pad of opamp.pads.filter((entry) => !entry.connected)) {
      expect(drill).toContain(`X${size3(pad.x)}Y${size3(layout.board.height - pad.y)}`);
      const at = `X${um(pad.x)}Y${um(layout.board.height - pad.y)}`;
      expect(top).toContain(at);
      expect(mask).toContain(at);
    }
  });
});
