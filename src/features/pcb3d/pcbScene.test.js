import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPcbScene } from './pcbScene.js';

// Phase D carry-over fix: three body kinds hardcoded their local geometry
// along the board X axis and ignored the now-real component.rotation, so a
// rotated part's 3D body pointed the wrong way relative to its own pads
// (which ARE placed correctly, at absolute layout coordinates). These tests
// check mesh world-space orientation/position directly from the pad
// coordinates a rotated component actually carries — no browser needed.

const layoutFor = (component) => ({
  board: { width: 100, height: 100, thickness: 1.6 },
  components: [component],
  traces: [],
  vias: [],
  nets: [],
});

const axialComponent = (rotation) => (rotation === 0
  ? {
    ref: 'R1', kind: 'resistor', value: '1k', body: 'axial', rotation: 0,
    x: 50, y: 50, width: 12.26, height: 3,
    pads: [
      { x: 44.92, y: 50, net: 'A', diameter: 1.6 },
      { x: 55.08, y: 50, net: 'B', diameter: 1.6 },
    ],
  }
  : {
    ref: 'R1', kind: 'resistor', value: '1k', body: 'axial', rotation: 90,
    x: 50, y: 50, width: 3, height: 12.26,
    pads: [
      { x: 50, y: 44.92, net: 'A', diameter: 1.6 },
      { x: 50, y: 55.08, net: 'B', diameter: 1.6 },
    ],
  });

const axisOf = (mesh) => {
  mesh.updateMatrixWorld(true);
  const origin = new THREE.Vector3();
  mesh.getWorldPosition(origin);
  const tip = mesh.localToWorld(new THREE.Vector3(0, 1, 0));
  return tip.sub(origin);
};

describe('buildPcbScene rotation fixes', () => {
  it('keeps an unrotated axial body along X (regression guard)', () => {
    const group = buildPcbScene(layoutFor(axialComponent(0)));
    const holder = group.getObjectByName('part-R1');
    holder.updateMatrixWorld(true);
    const barrel = holder.getObjectByName('barrel');
    expect(barrel).toBeTruthy();
    const axis = axisOf(barrel);
    expect(Math.abs(axis.x)).toBeGreaterThan(Math.abs(axis.z));
  });

  it('orients an axial body (resistor/inductor/diode) along its own pad-to-pad axis when rotated 90', () => {
    const group = buildPcbScene(layoutFor(axialComponent(90)));
    const holder = group.getObjectByName('part-R1');
    holder.updateMatrixWorld(true);
    const barrel = holder.getObjectByName('barrel');
    expect(barrel).toBeTruthy();
    const axis = axisOf(barrel);
    expect(Math.abs(axis.z)).toBeGreaterThan(Math.abs(axis.x));
  });

  it('runs axial lead arms along the same rotated axis as the barrel, ending near the pads', () => {
    const group = buildPcbScene(layoutFor(axialComponent(90)));
    const holder = group.getObjectByName('part-R1');
    holder.updateMatrixWorld(true);
    // Both arms should sit on the board's X=50 line (toX(50) = 50 - 50 = 0),
    // varying only in Z, once the body is correctly rotated.
    const arms = holder.children.filter((child) => child.name === 'axial-arm');
    for (const arm of arms) {
      expect(arm.position.x).toBeCloseTo(0, 6);
    }
  });

  const to220Component = (rotation) => {
    if (rotation === 0) {
      return {
        ref: 'U1', kind: 'regulator', value: '7805', body: 'to220', rotation: 0,
        x: 50, y: 50, width: 10.5, height: 5,
        pads: [
          { x: 45, y: 50, net: 'A', diameter: 2 },
          { x: 50, y: 50, net: 'B', diameter: 2 },
          { x: 55, y: 50, net: 'C', diameter: 2 },
        ],
      };
    }
    // 90 and 270 share the same board-space width/height/pad span (the
    // lead row still runs along Z either way) — only the tab/body offset
    // sign along X should differ between them.
    return {
      ref: 'U1', kind: 'regulator', value: '7805', body: 'to220', rotation,
      x: 50, y: 50, width: 5, height: 10.5,
      pads: [
        { x: 50, y: 45, net: 'A', diameter: 2 },
        { x: 50, y: 50, net: 'B', diameter: 2 },
        { x: 50, y: 55, net: 'C', diameter: 2 },
      ],
    };
  };

  it('keeps the unrotated TO-220 body/tab offset along Z (regression guard)', () => {
    const group = buildPcbScene(layoutFor(to220Component(0)));
    const holder = group.getObjectByName('part-U1');
    const body = holder.getObjectByName('to220-body');
    const tab = holder.getObjectByName('to220-tab');
    expect(body.position.x).toBeCloseTo(0, 6);
    expect(tab.position.x).toBeCloseTo(0, 6);
    expect(body.position.z).not.toBeCloseTo(0, 6);
    expect(tab.position.z).not.toBeCloseTo(0, 6);
  });

  it('applies the TO-220 body/tab offset along X once rotated 90 (perpendicular to the leads)', () => {
    const group = buildPcbScene(layoutFor(to220Component(90)));
    const holder = group.getObjectByName('part-U1');
    const body = holder.getObjectByName('to220-body');
    const tab = holder.getObjectByName('to220-tab');
    expect(body.position.z).toBeCloseTo(0, 6);
    expect(tab.position.z).toBeCloseTo(0, 6);
    expect(body.position.x).not.toBeCloseTo(0, 6);
    expect(tab.position.x).not.toBeCloseTo(0, 6);
  });

  it('flips the TO-220 tab/body offset side between rotation 90 and rotation 270', () => {
    // Fix wave 1, Minor 2: the offset used to be derived purely from the
    // pad span (symmetric in 90 vs 270), so both rotations put the tab on
    // the same X side. It must now flip sign with the actual rotation
    // direction.
    const group90 = buildPcbScene(layoutFor(to220Component(90)));
    const group270 = buildPcbScene(layoutFor(to220Component(270)));
    const body90 = group90.getObjectByName('part-U1').getObjectByName('to220-body');
    const tab90 = group90.getObjectByName('part-U1').getObjectByName('to220-tab');
    const body270 = group270.getObjectByName('part-U1').getObjectByName('to220-body');
    const tab270 = group270.getObjectByName('part-U1').getObjectByName('to220-tab');

    expect(body90.position.x).not.toBeCloseTo(0, 6);
    expect(body270.position.x).not.toBeCloseTo(0, 6);
    expect(Math.sign(body90.position.x)).toBe(-Math.sign(body270.position.x));
    expect(Math.sign(tab90.position.x)).toBe(-Math.sign(tab270.position.x));
  });

  const moduleComponent = (pads) => ({
    ref: 'U1', kind: 'esp32', value: '', body: 'module', rotation: 0,
    x: 50, y: 50, width: 44, height: 26,
    pads,
  });

  it('groups module header strips by Z-row when pads run mostly along X (regression guard)', () => {
    // Two horizontal rows (wide spread of x within a row; rows differ by a
    // small y offset, same as a real header strip's row pitch).
    const pads = [30, 38, 46, 54, 62, 70].flatMap((x) => [
      { x, y: 44, net: `t${x}`, diameter: 1.7 },
      { x, y: 46, net: `b${x}`, diameter: 1.7 },
    ]);
    const group = buildPcbScene(layoutFor(moduleComponent(pads)));
    const holder = group.getObjectByName('part-U1');
    const headers = holder.children.filter((child) => child.name === 'header-strip');
    expect(headers.length).toBe(2);
  });

  it('groups module header strips by X-column when pads run mostly along Z (rotated)', () => {
    // Two vertical columns (varying y within a column, columns differ by x).
    const pads = [40, 45, 50, 55, 60].flatMap((y) => [
      { x: 48, y, net: `l${y}`, diameter: 1.7 },
      { x: 52, y, net: `r${y}`, diameter: 1.7 },
    ]);
    const group = buildPcbScene(layoutFor(moduleComponent(pads)));
    const holder = group.getObjectByName('part-U1');
    const headers = holder.children.filter((child) => child.name === 'header-strip');
    expect(headers.length).toBe(2);
  });
});
