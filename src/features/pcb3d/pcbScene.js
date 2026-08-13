// Builds the three.js scene graph for a procedurally generated PCB layout.
// Pure geometry construction — no renderer or DOM here, so the viewer
// component stays thin and the scene is reusable for GLB export.
import * as THREE from 'three';
import { BOARD_THICKNESS, PAD_DIAMETER, VIA_DIAMETER } from '../../core/pcbLayout.js';
import { rotateOffset } from '../../core/pcbPlace.js';

const TRACE_HEIGHT = 0.06;
const BOARD_TOP = BOARD_THICKNESS / 2;

const materials = () => ({
  board: new THREE.MeshStandardMaterial({ color: 0x0d6b3f, roughness: 0.85, metalness: 0.05 }),
  copper: new THREE.MeshStandardMaterial({ color: 0xc98937, roughness: 0.35, metalness: 0.8 }),
  pad: new THREE.MeshStandardMaterial({ color: 0xd9b653, roughness: 0.25, metalness: 0.9 }),
  via: new THREE.MeshStandardMaterial({ color: 0x9a6b2f, roughness: 0.4, metalness: 0.85 }),
  lead: new THREE.MeshStandardMaterial({ color: 0xb9bec7, roughness: 0.35, metalness: 0.9 }),
  blackPlastic: new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.6, metalness: 0.1 }),
  resistorBody: new THREE.MeshStandardMaterial({ color: 0xd8b98a, roughness: 0.7 }),
  capacitorBody: new THREE.MeshStandardMaterial({ color: 0x2c4a8a, roughness: 0.55 }),
  terminalBody: new THREE.MeshStandardMaterial({ color: 0x2e8b57, roughness: 0.6 }),
  moduleBoard: new THREE.MeshStandardMaterial({ color: 0x14427a, roughness: 0.7 }),
  silver: new THREE.MeshStandardMaterial({ color: 0xc0c5cc, roughness: 0.3, metalness: 0.85 }),
});

const LED_COLORS = {
  red: 0xd42a2a, green: 0x2ad45c, blue: 0x2a6bd4, yellow: 0xe8d43a,
  orange: 0xe8862a, white: 0xf2f2f2, amber: 0xe8a23a,
};

const bandColor = (index) => [0xa63d2f, 0x2f2f2f, 0xd4943a, 0xd4c53a, 0x3a66d4][index % 5];

export const buildPcbScene = (layout) => {
  const group = new THREE.Group();
  group.name = 'pcb';
  const mats = materials();
  const { board } = layout;
  // Board centered at origin, top face at y = BOARD_TOP; layout (x, y) → (x, z).
  const toX = (x) => x - board.width / 2;
  const toZ = (y) => y - board.height / 2;

  const boardMesh = new THREE.Mesh(
    new THREE.BoxGeometry(board.width, board.thickness, board.height),
    mats.board,
  );
  boardMesh.name = 'board';
  group.add(boardMesh);

  // Copper traces: thin boxes just above (top layer) or below (bottom layer).
  for (const trace of layout.traces) {
    const dx = Math.abs(trace.to.x - trace.from.x);
    const dz = Math.abs(trace.to.y - trace.from.y);
    const geometry = new THREE.BoxGeometry(
      dx + trace.width, TRACE_HEIGHT, dz + trace.width,
    );
    const mesh = new THREE.Mesh(geometry, mats.copper);
    mesh.position.set(
      toX((trace.from.x + trace.to.x) / 2),
      trace.layer === 'top' ? BOARD_TOP + TRACE_HEIGHT / 2 : -BOARD_TOP - TRACE_HEIGHT / 2,
      toZ((trace.from.y + trace.to.y) / 2),
    );
    group.add(mesh);
  }

  for (const component of layout.components) {
    for (const pad of component.pads) {
      const diameter = pad.diameter ?? PAD_DIAMETER;
      const geometry = new THREE.CylinderGeometry(diameter / 2, diameter / 2, board.thickness + 0.16, 20);
      const mesh = new THREE.Mesh(geometry, mats.pad);
      mesh.position.set(toX(pad.x), 0, toZ(pad.y));
      group.add(mesh);
    }
  }
  for (const via of layout.vias) {
    const diameter = via.diameter ?? VIA_DIAMETER;
    const geometry = new THREE.CylinderGeometry(diameter / 2, diameter / 2, board.thickness + 0.14, 14);
    const mesh = new THREE.Mesh(geometry, mats.via);
    mesh.position.set(toX(via.x), 0, toZ(via.y));
    group.add(mesh);
  }

  for (const component of layout.components) {
    group.add(componentMesh(component, mats, toX, toZ));
  }

  return group;
};

const lead = (x, z, topY, mats) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, topY - BOARD_TOP + 0.2, 10), mats.lead);
  mesh.position.set(x, BOARD_TOP + (topY - BOARD_TOP) / 2, z);
  return mesh;
};

const componentMesh = (component, mats, toX, toZ) => {
  const holder = new THREE.Group();
  holder.name = `part-${component.ref}`;
  const x = toX(component.x);
  const z = toZ(component.y);
  const padPoints = component.pads.map((pad) => ({ x: toX(pad.x), z: toZ(pad.y) }));
  const body = component.body;

  if (body === 'axial') {
    // Barrel/bands/arms are along X by default; a rotated part's pads may
    // instead differ mostly in Z (board y), so orient this body's whole
    // local subgroup along whichever axis its own two pads actually sit on
    // — derived from the pad coordinates themselves, not component.rotation,
    // so it is correct regardless of any internal rotation sign convention.
    const bodyY = BOARD_TOP + 1.5;
    const length = component.width * 0.72;
    const [padA, padB] = padPoints;
    const horizontal = !padB || Math.abs(padB.x - padA.x) >= Math.abs(padB.z - padA.z);

    const inner = new THREE.Group();
    inner.name = 'axial-inner';
    inner.position.set(x, 0, z);
    if (!horizontal) inner.rotation.y = Math.PI / 2;
    holder.add(inner);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, length, 18), mats.resistorBody);
    barrel.name = 'barrel';
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0, bodyY, 0);
    inner.add(barrel);
    [-0.28, -0.12, 0.04, 0.3].forEach((offset, index) => {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(1.22, 1.22, 0.5, 18),
        new THREE.MeshStandardMaterial({ color: bandColor(index), roughness: 0.6 }),
      );
      band.name = 'band';
      band.rotation.z = Math.PI / 2;
      band.position.set(offset * length, bodyY, 0);
      inner.add(band);
    });
    for (const point of padPoints) {
      holder.add(lead(point.x, point.z, bodyY, mats));
      // Lead run from the vertical post to the body end, along the same
      // axis as the barrel.
      const along = horizontal ? point.x - x : point.z - z;
      const run = Math.abs(along) - length / 2;
      if (run > 0.2) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, run, 10), mats.lead);
        arm.name = 'axial-arm';
        if (horizontal) {
          arm.rotation.z = Math.PI / 2;
          arm.position.set(point.x > x ? point.x - run / 2 : point.x + run / 2, bodyY, point.z);
        } else {
          arm.rotation.x = Math.PI / 2;
          arm.position.set(point.x, bodyY, point.z > z ? point.z - run / 2 : point.z + run / 2);
        }
        holder.add(arm);
      }
    }
  } else if (body === 'radial') {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 5.4, 22), mats.capacitorBody);
    can.position.set(x, BOARD_TOP + 2.7, z);
    holder.add(can);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.62, 0.22, 22), mats.silver);
    top.position.set(x, BOARD_TOP + 5.42, z);
    holder.add(top);
    for (const point of padPoints) holder.add(lead(point.x, point.z, BOARD_TOP + 0.6, mats));
  } else if (body === 'led') {
    const colorName = String(component.value || '').toLowerCase().trim();
    const color = LED_COLORS[colorName] ?? LED_COLORS.red;
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.15, transparent: true, opacity: 0.82, emissive: color, emissiveIntensity: 0.25,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 1.4, 22), material);
    base.position.set(x, BOARD_TOP + 0.7, z);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.4, 22), material);
    stem.position.set(x, BOARD_TOP + 2.4, z);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), material);
    dome.position.set(x, BOARD_TOP + 3.6, z);
    holder.add(base, stem, dome);
    for (const point of padPoints) holder.add(lead(point.x, point.z, BOARD_TOP + 0.7, mats));
  } else if (body === 'terminal') {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(component.width, 6, component.height),
      mats.terminalBody,
    );
    block.position.set(x, BOARD_TOP + 3, z);
    holder.add(block);
    for (const point of padPoints) {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 16), mats.silver);
      screw.position.set(point.x, BOARD_TOP + 6.2, point.z);
      holder.add(screw);
    }
  } else if (body === 'to92' || body === 'to220') {
    const tall = body === 'to220' ? 9 : 4.8;
    const radius = body === 'to220' ? 0 : 2.4;
    if (body === 'to92') {
      // D-shaped can: half cylinder plus a flat front face.
      const shape = new THREE.Shape();
      shape.absarc(0, 0, radius, -Math.PI * 0.25, Math.PI * 1.25, false);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: tall, bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2);
      const can = new THREE.Mesh(geometry, mats.blackPlastic);
      can.position.set(x, BOARD_TOP, z);
      holder.add(can);
    } else {
      // component.width/height are already board-space (swapped for a
      // rotated placement), so the lead-row span is whichever one actually
      // covers the pads; the body/tab sit offset from the leads along the
      // perpendicular board axis.
      const spanX = Math.max(...padPoints.map((p) => p.x)) - Math.min(...padPoints.map((p) => p.x));
      const spanZ = Math.max(...padPoints.map((p) => p.z)) - Math.min(...padPoints.map((p) => p.z));
      const horizontal = spanX >= spanZ;
      const along = horizontal ? component.width : component.height;
      const bodyMesh = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? along : 3, 4.4, horizontal ? 3 : along),
        mats.blackPlastic,
      );
      bodyMesh.name = 'to220-body';
      const tab = new THREE.Mesh(
        new THREE.BoxGeometry(horizontal ? along : 1.2, tall - 4.4, horizontal ? 1.2 : along),
        mats.silver,
      );
      tab.name = 'to220-tab';
      // The body/tab sit offset from the lead row along the footprint's
      // local perpendicular axis (local (0, -1), i.e. "north" of the pins
      // in unrotated footprint space). `horizontal` only tells us which
      // board axis the pins ended up on, which is symmetric between 90 and
      // 270 (and between 0 and 180) — it can't tell which SIDE the tab goes
      // on. Rotate the local offset by the component's actual rotation
      // (same convention as pcbPlace.js's rotateOffset, which produced this
      // component's own placement) to get that sign right for every
      // rotation, not just axis.
      const bodyOffset = rotateOffset({ x: 0, y: -0.8 }, component.rotation);
      const tabOffset = rotateOffset({ x: 0, y: -1.7 }, component.rotation);
      bodyMesh.position.set(x + bodyOffset.x, BOARD_TOP + 2.2, z + bodyOffset.y);
      tab.position.set(x + tabOffset.x, BOARD_TOP + 4.4 + (tall - 4.4) / 2, z + tabOffset.y);
      holder.add(bodyMesh, tab);
    }
    for (const point of padPoints) holder.add(lead(point.x, point.z, BOARD_TOP + 1.2, mats));
  } else if (body === 'dip') {
    const spanX = Math.max(...padPoints.map((p) => p.x)) - Math.min(...padPoints.map((p) => p.x));
    const spanZ = Math.max(...padPoints.map((p) => p.z)) - Math.min(...padPoints.map((p) => p.z));
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(spanX + 2.4, 3, Math.max(spanZ - 2.4, 4)), mats.blackPlastic);
    bodyMesh.position.set(x, BOARD_TOP + 1.9, z);
    holder.add(bodyMesh);
    const notch = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.3, 14), mats.silver);
    notch.position.set(x - spanX / 2 - 0.2, BOARD_TOP + 3.35, z);
    holder.add(notch);
    for (const point of padPoints) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.9, 0.5), mats.lead);
      leg.position.set(point.x, BOARD_TOP + 0.95, point.z);
      holder.add(leg);
    }
  } else if (body === 'rf_module') {
    // Bare castellated radio module (ESP32-S3-WROOM-1): a thin module PCB
    // sitting flush on the host board, a metal shield can over the RF
    // section, and the antenna end of the slab left bare. No leads, headers
    // or connectors — the castellations solder directly to the host pads.
    const swap = (((component.rotation % 360) + 360) % 360) % 180 !== 0;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(component.width, 1, component.height),
      mats.moduleBoard,
    );
    slab.position.set(x, BOARD_TOP + 0.5, z);
    holder.add(slab);
    // The can covers local +y; local -y (the top of the footprint, above the
    // antennaY silk line) stays bare — that is the printed antenna zone.
    const canOffset = rotateOffset({ x: 0, y: 3.6 }, component.rotation);
    const can = new THREE.Mesh(
      new THREE.BoxGeometry(swap ? 17.5 : 16, 2.6, swap ? 16 : 17.5),
      mats.silver,
    );
    can.name = 'shield-can';
    can.position.set(x + canOffset.x, BOARD_TOP + 1 + 1.3, z + canOffset.y);
    holder.add(can);
  } else if (body === 'module') {
    const sub = new THREE.Mesh(new THREE.BoxGeometry(component.width, 1.4, component.height), mats.moduleBoard);
    sub.position.set(x, BOARD_TOP + 3.5, z);
    holder.add(sub);
    const chip = new THREE.Mesh(
      new THREE.BoxGeometry(component.width * 0.3, 1.1, component.height * 0.3),
      mats.blackPlastic,
    );
    chip.position.set(x, BOARD_TOP + 4.75, z);
    holder.add(chip);
    const usb = new THREE.Mesh(new THREE.BoxGeometry(component.width * 0.16, 1.6, component.height * 0.22), mats.silver);
    usb.position.set(x - component.width / 2 + component.width * 0.09, BOARD_TOP + 5, z);
    holder.add(usb);
    // Header strips standing between the module and the host board, grouped
    // along whichever axis the pin rows actually run on: at rotation 0 that
    // is horizontal rows distinguished by Z, but a 90-degree-rotated module
    // has vertical rows distinguished by X instead — pick by which
    // coordinate has the wider spread across all the module's pads.
    const spanX = Math.max(...padPoints.map((p) => p.x)) - Math.min(...padPoints.map((p) => p.x));
    const spanZ = Math.max(...padPoints.map((p) => p.z)) - Math.min(...padPoints.map((p) => p.z));
    const rowsRunAlongX = spanX >= spanZ;
    const rows = new Map();
    for (const point of padPoints) {
      const rowKey = rowsRunAlongX ? Math.round(point.z * 10) : Math.round(point.x * 10);
      if (!rows.has(rowKey)) rows.set(rowKey, []);
      rows.get(rowKey).push(point);
    }
    for (const points of rows.values()) {
      const header = new THREE.Mesh(
        rowsRunAlongX
          ? new THREE.BoxGeometry(
            Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)) + 2.54, 2.8, 2.54,
          )
          : new THREE.BoxGeometry(
            2.54, 2.8, Math.max(...points.map((p) => p.z)) - Math.min(...points.map((p) => p.z)) + 2.54,
          ),
        mats.blackPlastic,
      );
      header.name = 'header-strip';
      if (rowsRunAlongX) {
        const minX = Math.min(...points.map((p) => p.x));
        const maxX = Math.max(...points.map((p) => p.x));
        header.position.set((minX + maxX) / 2, BOARD_TOP + 1.4, points[0].z);
      } else {
        const minZ = Math.min(...points.map((p) => p.z));
        const maxZ = Math.max(...points.map((p) => p.z));
        header.position.set(points[0].x, BOARD_TOP + 1.4, (minZ + maxZ) / 2);
      }
      holder.add(header);
    }
    for (const point of padPoints) holder.add(lead(point.x, point.z, BOARD_TOP + 3.5, mats));
  } else {
    const bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(component.width, 3, component.height),
      mats.blackPlastic,
    );
    bodyMesh.position.set(x, BOARD_TOP + 1.5, z);
    holder.add(bodyMesh);
    for (const point of padPoints) holder.add(lead(point.x, point.z, BOARD_TOP + 1, mats));
  }

  return holder;
};

// Reference designators as sprites (kept out of the GLB export group).
export const buildLabelSprites = (layout) => {
  const group = new THREE.Group();
  group.name = 'labels';
  for (const component of layout.components) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.font = '700 30px Inter, Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.strokeStyle = 'rgba(0,0,0,0.85)';
    context.lineWidth = 6;
    context.strokeText(component.ref, 64, 24);
    context.fillText(component.ref, 64, 24);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(8, 3, 1);
    sprite.position.set(
      component.x - layout.board.width / 2,
      BOARD_THICKNESS / 2 + (component.body === 'module' ? 8 : 7),
      component.y - layout.board.height / 2,
    );
    group.add(sprite);
  }
  return group;
};

export const disposeObject = (root) => {
  root.traverse((node) => {
    node.geometry?.dispose?.();
    const materialList = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materialList) {
      if (!material) continue;
      material.map?.dispose?.();
      material.dispose?.();
    }
  });
};
