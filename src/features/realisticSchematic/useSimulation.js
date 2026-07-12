// Engine lifecycle for the interactive breadboard simulation. Owns the MNA
// engine in a ref, steps it in a requestAnimationFrame loop, and commits a
// small "sim frame" snapshot to React state at ~30 Hz (every other frame) so
// per-frame math never thrashes React — the same coalescing idea as the view
// transform in RealisticSchematic.jsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSimulation } from '../../core/sim/simEngine.js';
import { buzzerAudioConfig, createSimAudio } from './simAudio.js';

const FRAME_BUDGET_MS = 4;
export const SIM_AUDIO_MUTED_STORAGE_KEY = 'prompt-to-pcb-sim-audio-muted-v1';

const loadAudioMuted = () => {
  try {
    return globalThis.localStorage?.getItem(SIM_AUDIO_MUTED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

// Event-style controls (encoder detents, button presses, IR keys) fire once;
// remembering them would replay the last press on every engine rebuild.
const EVENT_CONTROL_TYPES = new Set(['stepper', 'button', 'ir-key']);

export function useSimulation(circuit, running, mcu = null) {
  const engineRef = useRef(null);
  // Control values survive engine rebuilds (circuit edits while running): the
  // user's held button / thrown switch / wiper position carries over by ref.
  const controlMemoryRef = useRef(new Map());
  const audioRef = useRef(null);
  const [simFrame, setSimFrame] = useState(null);
  const [controls, setControls] = useState([]);
  const [audioMuted, setAudioMutedState] = useState(loadAudioMuted);

  const stopAudio = useCallback(() => {
    audioRef.current?.stop();
    audioRef.current = null;
  }, []);

  // Called directly by the Run click before any asynchronous firmware compile.
  // The service then lives for the whole Run session, so engine rebuilds from
  // mid-run circuit edits do not click the tone off.
  const enableAudio = useCallback(() => {
    if (!(circuit?.components ?? []).some((component) => component.kind === 'buzzer')) return false;
    audioRef.current ??= createSimAudio();
    audioRef.current.setMuted(audioMuted);
    return audioRef.current.start();
  }, [audioMuted, circuit]);

  const setAudioMuted = useCallback((value) => {
    const next = Boolean(value);
    setAudioMutedState(next);
    audioRef.current?.setMuted(next);
    try {
      globalThis.localStorage?.setItem(SIM_AUDIO_MUTED_STORAGE_KEY, String(next));
    } catch { /* storage can be disabled without disabling simulation */ }
  }, []);

  useEffect(() => {
    if (!running) stopAudio();
  }, [running, stopAudio]);

  useEffect(() => () => stopAudio(), [stopAudio]);

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
      serial: engine.serialText?.() ?? '',
      hasMcu: Boolean(engine.mcuRunner),
    };
  }, []);

  useEffect(() => {
    if (!running) {
      engineRef.current = null;
      setSimFrame(null);
      setControls([]);
      return undefined;
    }
    const engine = createSimulation(circuit, mcu ? { mcu } : {});
    engineRef.current = engine;
    // Debug hook: lets the console (and dev harnesses) poke the live engine.
    if (typeof window !== 'undefined') window.__simEngine = engine;
    if (!engine.ok) {
      audioRef.current?.update(new Map(), []);
      setSimFrame({
        time: 0,
        speed: 0,
        converged: false,
        isDynamic: false,
        netVoltages: new Map(),
        observables: new Map(),
        warnings: engine.warnings,
        error: engine.error,
        serial: '',
        hasMcu: false,
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

    const buzzers = (circuit?.components ?? [])
      .filter((component) => component.kind === 'buzzer')
      .map(buzzerAudioConfig);

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
        audioRef.current?.update(frame.observables, buzzers);
      }
      raf = requestAnimationFrame(tick);
    };
    engine.advance(0.016, FRAME_BUDGET_MS); // initial solve so the first frame has data
    setSimFrame(snapshot());
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [circuit, running, mcu, snapshot]);

  const setControl = useCallback((ref, name, value) => {
    const type = engineRef.current?.controls?.find(
      (control) => control.ref === ref && control.name === name,
    )?.type;
    if (!EVENT_CONTROL_TYPES.has(type)) controlMemoryRef.current.set(`${ref}:${name}`, value);
    engineRef.current?.setControl(ref, name, value);
  }, []);

  const sendSerial = useCallback((text) => {
    engineRef.current?.sendSerial?.(text);
  }, []);

  return {
    simFrame,
    setControl,
    controls,
    sendSerial,
    audioMuted,
    enableAudio,
    stopAudio,
    setAudioMuted,
  };
}
