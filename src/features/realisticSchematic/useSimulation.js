// Engine lifecycle for the interactive breadboard simulation. Owns the MNA
// engine in a ref, steps it in a requestAnimationFrame loop, and commits a
// small "sim frame" snapshot to React state at ~30 Hz (every other frame) so
// per-frame math never thrashes React — the same coalescing idea as the view
// transform in RealisticSchematic.jsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSimulation } from '../../core/sim/simEngine.js';
import { createSimAudio } from './simAudio.js';

const FRAME_BUDGET_MS = 4;

export function useSimulation(circuit, running) {
  const engineRef = useRef(null);
  // Control values survive engine rebuilds (circuit edits while running): the
  // user's held button / thrown switch / wiper position carries over by ref.
  const controlMemoryRef = useRef(new Map());
  const audioRef = useRef(null);
  const [simFrame, setSimFrame] = useState(null);
  const [controls, setControls] = useState([]);

  // Audio lives for the whole Run session (keyed on `running` alone) so
  // engine rebuilds from mid-run circuit edits don't click the tone off.
  useEffect(() => {
    if (!running) return undefined;
    audioRef.current = createSimAudio();
    return () => {
      audioRef.current?.stop();
      audioRef.current = null;
    };
  }, [running]);

  const snapshot = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return null;
    const { netVoltages } = engine.probe();
    const status = engine.status();
    return {
      time: engine.time,
      speed: status.lastSpeed,
      converged: status.converged,
      isDynamic: engine.isDynamic,
      netVoltages,
      observables: engine.observables(),
      warnings: engine.warnings,
      error: engine.error,
    };
  }, []);

  useEffect(() => {
    if (!running) {
      engineRef.current = null;
      setSimFrame(null);
      setControls([]);
      return undefined;
    }
    const engine = createSimulation(circuit);
    engineRef.current = engine;
    if (!engine.ok) {
      setSimFrame({
        time: 0,
        speed: 0,
        converged: false,
        isDynamic: false,
        netVoltages: new Map(),
        observables: new Map(),
        warnings: engine.warnings,
        error: engine.error,
      });
      setControls([]);
      return undefined;
    }
    // Replay remembered control values (rebuild-while-running keeps state).
    for (const control of engine.controls) {
      const remembered = controlMemoryRef.current.get(`${control.ref}:${control.name}`);
      if (remembered !== undefined) engine.setControl(control.ref, control.name, remembered);
    }
    setControls(engine.controls);

    const buzzerRefs = (circuit?.components ?? [])
      .filter((component) => component.kind === 'buzzer')
      .map((component) => component.ref);

    let raf = 0;
    let lastTick = 0;
    let frameParity = 0;
    const tick = (timestamp) => {
      const wallDt = lastTick ? (timestamp - lastTick) / 1000 : 0.016;
      lastTick = timestamp;
      engine.advance(wallDt, FRAME_BUDGET_MS);
      frameParity ^= 1;
      if (frameParity === 0) {
        const frame = snapshot();
        setSimFrame(frame);
        audioRef.current?.update(frame.observables, buzzerRefs);
      }
      raf = requestAnimationFrame(tick);
    };
    engine.advance(0.016, FRAME_BUDGET_MS); // initial solve so the first frame has data
    setSimFrame(snapshot());
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [circuit, running, snapshot]);

  const setControl = useCallback((ref, name, value) => {
    controlMemoryRef.current.set(`${ref}:${name}`, value);
    engineRef.current?.setControl(ref, name, value);
  }, []);

  return { simFrame, setControl, controls };
}
