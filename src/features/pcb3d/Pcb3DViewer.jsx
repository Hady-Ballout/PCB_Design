import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildPcbLayout } from '../../core/pcbLayout.js';
import { buildLabelSprites, buildPcbScene, disposeObject } from './pcbScene.js';
import './Pcb3DViewer.css';

// Interactive 3D view of the procedurally routed PCB, with GLB export.
export function Pcb3DViewer({ circuit }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const pcbGroupRef = useRef(null);
  const [showLabels, setShowLabels] = useState(true);
  const [exportError, setExportError] = useState('');

  const layout = useMemo(() => {
    try {
      return buildPcbLayout(circuit);
    } catch {
      return null;
    }
  }, [circuit]);

  // One renderer per mounted viewer; rebuilt board group per layout change.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !layout) return undefined;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(60, 120, 80);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-80, 40, -60);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.95;

    const diagonal = Math.hypot(layout.board.width, layout.board.height);
    camera.position.set(0, diagonal * 0.7, diagonal * 0.6);
    camera.lookAt(0, 0, 0);
    controls.update();

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const pcbGroup = buildPcbScene(layout);
    pcbGroupRef.current = pcbGroup;
    scene.add(pcbGroup);
    const labels = buildLabelSprites(layout);
    labels.visible = showLabels;
    scene.add(labels);
    scene.userData.labels = labels;

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      pcbGroupRef.current = null;
    };
    // showLabels is applied in its own effect; rebuilding the renderer for a
    // label toggle would reset the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    const labels = sceneRef.current?.userData.labels;
    if (labels) labels.visible = showLabels;
  }, [showLabels]);

  const downloadGlb = () => {
    const pcbGroup = pcbGroupRef.current;
    if (!pcbGroup) return;
    setExportError('');
    const exporter = new GLTFExporter();
    exporter.parse(
      pcbGroup,
      (buffer) => {
        const name = `${(circuit?.title || 'pcb').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.glb`;
        const blob = new Blob([buffer], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      (error) => setExportError(error?.message || 'GLB export failed.'),
      { binary: true },
    );
  };

  if (!layout) {
    return (
      <div className="editor-window-empty">
        <strong>No PCB layout</strong>
        <p>This circuit has no placeable components yet.</p>
      </div>
    );
  }

  return (
    <div className="pcb3d-viewer">
      <div className="pcb3d-toolbar">
        <span className="pcb3d-meta">
          {layout.board.width.toFixed(0)}&times;{layout.board.height.toFixed(0)}mm
          &nbsp;&middot;&nbsp; {layout.components.length} parts
          &nbsp;&middot;&nbsp; {layout.nets.length} nets
        </span>
        <div className="button-row">
          <button onClick={() => setShowLabels((current) => !current)} type="button">
            {showLabels ? 'Hide labels' : 'Show labels'}
          </button>
          <button onClick={downloadGlb} type="button">Download GLB</button>
        </div>
      </div>
      {exportError && <p className="inline-error simulation-message">{exportError}</p>}
      <div className="pcb3d-canvas" ref={mountRef} aria-label="3D PCB viewer" />
    </div>
  );
}
