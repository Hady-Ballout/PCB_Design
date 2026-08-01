// Builds the three.js scene graph for a procedurally generated PCB layout.
// Pure geometry construction — no renderer or DOM here, so the viewer
// component stays thin and the scene is reusable for GLB export.
import * as THREE from 'three';
import { BOARD_THICKNESS, PAD_DIAMETER, VIA_DIAMETER } from '../../core/pcbLayout.js';

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
    const bodyY = BOARD_TOP + 1.5;
    const length = component.width * 0.72;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, length, 18), mats.resistorBody);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(x, bodyY, z);
    holder.add(barrel);
    [-0.28, -0.12, 0.04, 0.3].forEach((offset, index) => {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(1.22, 1.22, 0.5, 18),
        new THREE.MeshStandardMaterial({ color: bandColor(index), roughness: 0.6 }),
      );
      band.rotation.z = Math.PI / 2;
      band.position.set(x + offset * length, bodyY, z);
      holder.add(band);
    });
    for (const point of padPoints) {
      holder.add(lead(point.x, point.z, bodyY, mats));
      // Horizontal lead run from the vertical post to the body end.
      const run = Math.abs(point.x - x) - length / 2;
      if (run > 0.2) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, run, 10), mats.lead);
        arm.rotation.z = Math.PI / 2;
        arm.position.set(point.x > x ? point.x - run / 2 : point.x + run / 2, bodyY, point.z);
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
      const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(component.width, 4.4, 3), mats.blackPlastic);
      bodyMesh.position.set(x, BOARD_TOP + 2.2, z - 0.8);
      const tab = new THREE.Mesh(new THREE.BoxGeometry(component.width, tall - 4.4, 1.2), mats.silver);
      tab.position.set(x, BOARD_TOP + 4.4 + (tall - 4.4) / 2, z - 1.7);
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
    // Header strips standing between the module and the host board.
    const rows = new Map();
    for (const point of padPoints) {
      const rowKey = Math.round(point.z * 10);
      if (!rows.has(rowKey)) rows.set(rowKey, []);
      rows.get(rowKey).push(point);
    }
    for (const points of rows.values()) {
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const header = new THREE.Mesh(
        new THREE.BoxGeometry(maxX - minX + 2.54, 2.8, 2.54),
        mats.blackPlastic,
      );
      header.position.set((minX + maxX) / 2, BOARD_TOP + 1.4, points[0].z);
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
