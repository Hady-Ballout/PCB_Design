// Interactive realistic breadboard view: auto-places the canonical circuit on a
// solderless breadboard with photo-style SVG parts and jumper wires. The board
// is a pan/zoom canvas — drag empty board to pan, wheel / pinch to zoom (kept
// anchored under the cursor), two-finger trackpad to pan. Clicking a part or
// wire highlights its electrical neighborhood (dim-others); hover previews it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PIN_COUNT_BY_KIND, SPICE_PREFIX_BY_KIND } from '../../core/componentKinds.js';
import { downloadText } from '../../core/download.js';
import { formatSI } from '../../core/sim/simObservables.js';
import { circuitToBreadboard, netAtHole, reconcileOverrides, GROUND_NET } from './breadboardModel.js';
import { describeBreadboard } from './breadboardDescription.js';
import { highlightFor, readoutFor, voltageOverlayFor } from './selectionModel.js';
import { HOLE_PITCH, clientToViewBox, holeAt, holeCenter, viewBoxToBoard } from './breadboardGeometry.js';
import { Breadboard, HighlightOverlay } from './Breadboard.jsx';
import { BatteryPack, JumperWire, PartDefs, PinLabels, RealisticPart } from './parts.jsx';
import { ComponentLibrary } from './ComponentLibrary.jsx';
import { IssuesPanel } from './IssuesPanel.jsx';
import { SerialMonitor } from './SerialMonitor.jsx';
import { SimStimulusPanel } from './SimStimulusPanel.jsx';
import { useSimulation } from './useSimulation.js';
import './RealisticSchematic.css';

// Zoom scale bounds. s = 1 is "board fitted to the viewport" (viewBox + meet);
// below 1 shrinks it, above 1 zooms in for detail.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 8;
const IDENTITY_VIEW = { tx: 0, ty: 0, s: 1 };
const WHEEL_ZOOM_INTENSITY = 0.0015; // per wheel deltaY unit
const CLICK_MOVE_THRESHOLD = 3; // viewBox px of drag below which a press is a click

// Starter values for parts dropped in from the component library, so a freshly
// added part is still a runnable SPICE element (and matches the canvas palette's
// defaults). Kinds without an obvious default come in valueless — the netlist
// editor can fill them in. Opamps/comparators must be LM358 (the app injects
// that model); see docs/AI_AND_CIRCUIT_MODEL.md.
const DEFAULT_VALUE_BY_KIND = {
  resistor: '1k', load: '1k', photoresistor: '10k', thermistor: '10k', potentiometer: '10k',
  capacitor: '100nF', inductor: '10mH', crystal: '16MHz', buzzer: '5V active',
  diode: '1N4148', zener: '5.1V', led: 'red', ir_led: '940nm', ir_phototransistor: '10k',
  schottky: '1N5819', fuse: '1A', bridge_rectifier: 'DB107', vibration_motor: '3V',
  bjt_npn: '2N2222', bjt_pnp: '2N2907',
  opamp: 'LM358', comparator: 'LM358',
  voltage_source: '5V', signal_source: 'SINE(0 1 1k)', regulator: '5V', solar_panel: '6V',
  buck_converter: 'LM2596-5.0',
  arduino_uno: 'Uno R3', raspberry_pi: 'Pi 5', esp32: 'DevKit V1',
  esp32_s3_wroom: 'ESP32-S3-WROOM-1-N8',
};

// Build a fresh circuit component for `kind` with a unique SPICE-safe ref and
// all pins left as `NC_<REF>_<pin>` placeholders (unconnected). This mirrors the
// canvas add flow (schematic/geometry.js addedComponent) so both editors grow
// the netlist the same way; the breadboard then greedy-places it and its pins
// become drag-to-wire handles once selected.
const newComponentForKind = (kind, components) => {
  const existingRefs = new Set(components.map((component) => component.ref));
  const prefix = SPICE_PREFIX_BY_KIND[kind] || 'U';
  let number = 1;
  while (existingRefs.has(`${prefix}${number}`)) number += 1;
  const ref = `${prefix}${number}`;
  const pinCount = DEFAULT_PIN_COUNT_BY_KIND[kind] ?? 2;
  return {
    ref,
    kind,
    value: DEFAULT_VALUE_BY_KIND[kind] ?? '',
    footprint: '',
    nodes: Array.from({ length: pinCount }, (_, index) => `NC_${ref}_${index + 1}`),
  };
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const netDisplayName = (net) => (net === GROUND_NET ? 'GND' : net);

export function RealisticSchematic({ circuit, overrides, onCircuitChange, onLayoutChange, issues, firmware, onCompileFirmware, windowControls, runControlHost }) {
  const model = useMemo(
    () => circuitToBreadboard(circuit, reconcileOverrides(overrides, circuit) ?? {}),
    [circuit, overrides],
  );
  const editable = typeof onCircuitChange === 'function';
  const movable = typeof onLayoutChange === 'function';
  const svgRef = useRef(null);
  const [view, setView] = useState(IDENTITY_VIEW); // { tx, ty, s } transform on the world <g>
  const [selection, setSelection] = useState(null); // {type:'part',ref} | {type:'net',net} | null
  const [hovered, setHovered] = useState(null); // same shape; only previews while nothing is selected
  const [copied, setCopied] = useState(false);
  const [wireDrag, setWireDrag] = useState(null); // { ref, pinIndex, from:{x,y}, to:{x,y} } in board coords
  const [partDrag, setPartDrag] = useState(null); // { ref, dx, dy } ghost offset while moving a part
  const [libraryAt, setLibraryAt] = useState(null); // client {x,y} anchor for the component library, or null
  const [running, setRunning] = useState(false); // live-simulation mode
  const [voltageOverlay, setVoltageOverlay] = useState(false); // tint carriers by live voltage
  const [showLegend, setShowLegend] = useState(false); // net legend is hidden until toggled on
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState(null);
  const [mcu, setMcu] = useState(null); // { hex } | { program } for the Uno bridge
  const {
    simFrame,
    setControl,
    controls,
    sendSerial,
    audioMuted,
    enableAudio,
    stopAudio,
    setAudioMuted,
  } = useSimulation(circuit, running, mcu);

  // Run with firmware: compile first (cached per chat by code hash), then
  // start the engine with the avr8js bridge attached.
  const hasUno = (circuit?.components ?? []).some((part) => part.kind === 'arduino_uno');
  const hasBuzzer = (circuit?.components ?? []).some((part) => part.kind === 'buzzer');
  const toggleRun = async () => {
    if (running) {
      stopAudio();
      setRunning(false);
      return;
    }
    // Keep this before the first await: browsers only allow AudioContext to be
    // unlocked while the Run click's user activation is still current.
    enableAudio();
    setCompileError(null);
    if (hasUno && firmware?.trim() && typeof onCompileFirmware === 'function') {
      setCompiling(true);
      try {
        const result = await onCompileFirmware(firmware);
        if (!result?.ok) {
          setCompileError((result?.errors ?? ['Compilation failed.']).join('\n'));
          stopAudio();
          return;
        }
        setMcu({ hex: result.hex });
      } catch (error) {
        setCompileError(String(error?.message ?? error));
        stopAudio();
        return;
      } finally {
        setCompiling(false);
      }
    } else {
      setMcu(null);
    }
    setRunning(true);
  };

  const effective = selection ?? hovered;
  const highlight = useMemo(() => highlightFor(model, effective), [model, effective]);
  const isPreview = !selection && hovered != null;

  // --- pan/zoom plumbing ----------------------------------------------------
  // viewRef always holds the latest (possibly not-yet-committed) view so wheel
  // deltas accumulate smoothly; view state changes are rAF-coalesced so a burst
  // of pointer/wheel events yields at most one React render per frame.
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameRef = useRef(0);
  const pendingRef = useRef(null);
  const pointersRef = useRef(new Map()); // pointerId -> { x, y } client coords
  const gestureRef = useRef(null); // { mode:'pan'|'pinch', ... } active gesture
  const movedRef = useRef(false);
  const wireDragRef = useRef(null); // { ref, pinIndex, pointerId } while rewiring a pin
  const partDragRef = useRef(null); // { ref, pointerId, startBoard, moved } while moving a part
  const suppressClickRef = useRef(false); // swallow the click that ends a part move
  const simButtonRef = useRef(null); // { ref, pointerId } while a pushbutton is held (run mode)
  const simPotDragRef = useRef(null); // { ref, pointerId, startBoard, startWiper } while dragging a wiper (run mode)
  const simJoyDragRef = useRef(null); // { ref, pointerId, startBoard, moved } while dragging a joystick (run mode)
  const simMouseDragRef = useRef(null); // { ref, pointerId, lastBoard } while dragging the mouse-sensor trackpad (run mode)

  const commitView = () => {
    frameRef.current = 0;
    if (pendingRef.current) {
      setView(pendingRef.current);
      pendingRef.current = null;
    }
  };
  const scheduleView = (next) => {
    pendingRef.current = next;
    viewRef.current = next;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(commitView);
  };
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const toViewBox = (clientX, clientY) =>
    clientToViewBox(svgRef.current, clientX, clientY, model.board.width, model.board.height);

  // Zoom by `factor` while keeping the board point under `anchor` (viewBox
  // coords) fixed: t' = anchor - (s'/s)*(anchor - t), per axis.
  const zoomAround = (anchor, factor) => {
    const base = viewRef.current;
    const s = clamp(base.s * factor, ZOOM_MIN, ZOOM_MAX);
    const k = s / base.s;
    scheduleView({
      s,
      tx: anchor.x - k * (anchor.x - base.tx),
      ty: anchor.y - k * (anchor.y - base.ty),
    });
  };

  const centerAnchor = () => {
    const rect = svgRef.current?.getBoundingClientRect?.();
    if (!rect) return { x: model.board.width / 2, y: model.board.height / 2 };
    return toViewBox(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const toBoard = (clientX, clientY) => viewBoxToBoard(toViewBox(clientX, clientY), viewRef.current);

  // --- rewiring: drag a selected part's pin to another hole -----------------
  const startWireDrag = (event, ref, pinIndex, from) => {
    if (!editable) return;
    event.stopPropagation(); // don't let the press bubble to pan/select
    suppressClickRef.current = false;
    const svg = svgRef.current;
    wireDragRef.current = { ref, pinIndex, pointerId: event.pointerId };
    setWireDrag({ ref, pinIndex, from, to: from });
    try { svg.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
  };

  const finishWireDrag = (ref, pinIndex, clientX, clientY) => {
    const hole = holeAt(toBoard(clientX, clientY), model.board.columns);
    if (!hole) return; // dropped in a gap: cancel, no change
    const part = model.parts.find((candidate) => candidate.ref === ref);
    const currentNet = part?.pinNets?.[pinIndex];
    // An empty tie group means "unplug this pin": give it a fresh placeholder net.
    const targetNet = netAtHole(model, hole) ?? `NC_${ref}_${pinIndex + 1}`;
    if (targetNet === currentNet) return;
    onCircuitChange((current) => ({
      ...current,
      components: (current.components ?? []).map((component) =>
        component.ref === ref
          ? { ...component, nodes: component.nodes.map((net, index) => (index === pinIndex ? targetNet : net)) }
          : component),
    }));
  };

  // --- placement: drag a whole part to a different hole --------------------
  const startPartDrag = (event, part) => {
    if (!movable || event.button !== 0) return;
    if (part.meta?.slotIndex != null) return; // off-board MCU boards live in fixed slots
    event.stopPropagation(); // don't pan; selection is handled on release
    suppressClickRef.current = false;
    partDragRef.current = { ref: part.ref, pointerId: event.pointerId, startBoard: toBoard(event.clientX, event.clientY), moved: false };
    try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
  };

  const commitPartMove = (ref, dx, dy) => {
    const part = model.parts.find((candidate) => candidate.ref === ref);
    if (!part) return;
    // Anchor on the part's leftmost column (columnStart for trench packages).
    const anchorHole = part.meta?.columnStart != null
      ? { strip: part.strip, column: part.meta.columnStart, row: 0 }
      : part.holes.filter(Boolean).reduce((left, hole) => (hole.column < left.column ? hole : left));
    const base = holeCenter(anchorHole);
    const dropped = holeAt({ x: base.x + dx, y: base.y + dy }, model.board.columns, HOLE_PITCH);
    const column = dropped ? dropped.column : Math.max(2, anchorHole.column + Math.round(dx / HOLE_PITCH));
    const strip = dropped && (dropped.strip === 'top' || dropped.strip === 'bottom') ? dropped.strip : part.strip;
    onLayoutChange((previous) => ({
      version: 1,
      ...previous,
      parts: { ...(previous?.parts ?? {}), [ref]: { strip, column } },
    }));
  };

  // --- run-mode gestures: hold a pushbutton, drag a pot wiper ---------------
  const controlValue = (ref, name, fallback) =>
    controls.find((control) => control.ref === ref && control.name === name)?.value ?? fallback;

  const startSimGesture = (event, part) => {
    // Keypad artwork keys carry data attributes; a press holds the key until
    // pointer release (the pushbutton pattern with a per-key control name).
    const keypadKey = part.kind === 'keypad' && event.target.closest?.('[data-keypad-key]');
    if (keypadKey) {
      event.stopPropagation();
      suppressClickRef.current = false;
      simButtonRef.current = { ref: part.ref, name: `key_${keypadKey.dataset.keypadKey}`, pointerId: event.pointerId };
      setControl(part.ref, simButtonRef.current.name, 1);
      try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
      return;
    }
    if (part.kind === 'pushbutton') {
      event.stopPropagation();
      suppressClickRef.current = false;
      simButtonRef.current = { ref: part.ref, name: 'pressed', pointerId: event.pointerId };
      setControl(part.ref, 'pressed', 1);
      try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
      return;
    }
    if (part.kind === 'potentiometer') {
      event.stopPropagation();
      suppressClickRef.current = false;
      simPotDragRef.current = {
        ref: part.ref,
        pointerId: event.pointerId,
        startBoard: toBoard(event.clientX, event.clientY),
        startWiper: controlValue(part.ref, 'wiper', 0.5),
      };
      try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
      return;
    }
    if (part.kind === 'joystick') {
      // Drag deflects the stick (both axes), release springs back to center,
      // and a click without movement pulses the stick switch.
      event.stopPropagation();
      suppressClickRef.current = false;
      simJoyDragRef.current = {
        ref: part.ref,
        pointerId: event.pointerId,
        startBoard: toBoard(event.clientX, event.clientY),
        moved: false,
      };
      try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
      return;
    }
    if (part.kind === 'mouse_sensor') {
      // Trackpad drag: pointer deltas become sensor counts (the PMW3360
      // measures displacement, so the drag IS the motion). No spring-back.
      event.stopPropagation();
      suppressClickRef.current = false;
      simMouseDragRef.current = {
        ref: part.ref,
        pointerId: event.pointerId,
        lastBoard: toBoard(event.clientX, event.clientY),
      };
      try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
    }
    // Other parts have no press gesture in run mode; a plain click still selects.
  };

  // Kinds whose run-mode click toggles a control instead of selecting.
  const RUN_CLICK_TOGGLES = {
    switch_spdt: (ref) => setControl(ref, 'position', controlValue(ref, 'position', 'A') === 'A' ? 'B' : 'A'),
    pir_sensor: (ref) => setControl(ref, 'motion', controlValue(ref, 'motion', 0) ? 0 : 1),
    hall_sensor: (ref) => setControl(ref, 'magnet', controlValue(ref, 'magnet', 0) ? 0 : 1),
  };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return; // left-drag only
    const svg = svgRef.current;
    suppressClickRef.current = false;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size >= 2) {
      // Two fingers: pinch-zoom + two-finger pan, anchored at their midpoint.
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = {
        mode: 'pinch',
        startDistance: distance(a, b),
        startAnchor: toViewBox(midpoint(a, b).x, midpoint(a, b).y),
        startView: { ...viewRef.current },
      };
      movedRef.current = true;
      for (const id of pointersRef.current.keys()) {
        try { svg.setPointerCapture(id); } catch { /* capture is best-effort */ }
      }
      return;
    }

    // A single press on an interactive item selects it — never pans.
    if (event.target.closest?.('.rs-item')) return;
    gestureRef.current = {
      mode: 'pan',
      pointerId: event.pointerId,
      startPointer: toViewBox(event.clientX, event.clientY),
      startView: { ...viewRef.current },
    };
    movedRef.current = false;
    if (svg) svg.style.cursor = 'grabbing';
    try { svg.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
  };

  const onPointerMove = (event) => {
    if (simPotDragRef.current) {
      if (event.pointerId !== simPotDragRef.current.pointerId) return;
      const board = toBoard(event.clientX, event.clientY);
      const dx = board.x - simPotDragRef.current.startBoard.x;
      // 60 board px of horizontal drag = the full wiper sweep.
      setControl(simPotDragRef.current.ref, 'wiper', clamp(simPotDragRef.current.startWiper + dx / 60, 0, 1));
      return;
    }
    if (simJoyDragRef.current) {
      if (event.pointerId !== simJoyDragRef.current.pointerId) return;
      const board = toBoard(event.clientX, event.clientY);
      const dx = board.x - simJoyDragRef.current.startBoard.x;
      const dy = board.y - simJoyDragRef.current.startBoard.y;
      if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) simJoyDragRef.current.moved = true;
      // 40 board px of drag = full deflection from center on each axis.
      setControl(simJoyDragRef.current.ref, 'x', clamp(0.5 + dx / 40, 0, 1));
      setControl(simJoyDragRef.current.ref, 'y', clamp(0.5 + dy / 40, 0, 1));
      return;
    }
    if (simMouseDragRef.current) {
      if (event.pointerId !== simMouseDragRef.current.pointerId) return;
      const board = toBoard(event.clientX, event.clientY);
      const dx = board.x - simMouseDragRef.current.lastBoard.x;
      const dy = board.y - simMouseDragRef.current.lastBoard.y;
      simMouseDragRef.current.lastBoard = board;
      // 4 sensor counts per board px; floats accumulate in the model, so
      // slow drags are not quantized away.
      if (dx !== 0) setControl(simMouseDragRef.current.ref, 'dx', dx * 4);
      if (dy !== 0) setControl(simMouseDragRef.current.ref, 'dy', dy * 4);
      return;
    }
    if (wireDragRef.current) {
      if (event.pointerId !== wireDragRef.current.pointerId) return;
      const to = toBoard(event.clientX, event.clientY);
      setWireDrag((drag) => (drag ? { ...drag, to } : drag));
      return;
    }
    if (partDragRef.current) {
      if (event.pointerId !== partDragRef.current.pointerId) return;
      const now = toBoard(event.clientX, event.clientY);
      const dx = now.x - partDragRef.current.startBoard.x;
      const dy = now.y - partDragRef.current.startBoard.y;
      if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) partDragRef.current.moved = true;
      setPartDrag({ ref: partDragRef.current.ref, dx, dy });
      return;
    }
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === 'pan') {
      const p = toViewBox(event.clientX, event.clientY);
      const dx = p.x - gesture.startPointer.x;
      const dy = p.y - gesture.startPointer.y;
      if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) movedRef.current = true;
      scheduleView({ s: gesture.startView.s, tx: gesture.startView.tx + dx, ty: gesture.startView.ty + dy });
      return;
    }

    // pinch: keep the board point under the initial midpoint pinned to the
    // current midpoint, scaled by the change in finger spread.
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    const anchor = toViewBox(midpoint(points[0], points[1]).x, midpoint(points[0], points[1]).y);
    const factor = distance(points[0], points[1]) / gesture.startDistance;
    const s = clamp(gesture.startView.s * factor, ZOOM_MIN, ZOOM_MAX);
    const board = {
      x: (gesture.startAnchor.x - gesture.startView.tx) / gesture.startView.s,
      y: (gesture.startAnchor.y - gesture.startView.ty) / gesture.startView.s,
    };
    scheduleView({ s, tx: anchor.x - s * board.x, ty: anchor.y - s * board.y });
  };

  const endPointer = (event) => {
    const svg = svgRef.current;
    try { svg?.releasePointerCapture?.(event.pointerId); } catch { /* best-effort */ }
    if (simButtonRef.current) {
      if (event.pointerId !== simButtonRef.current.pointerId) return;
      setControl(simButtonRef.current.ref, simButtonRef.current.name ?? 'pressed', 0);
      simButtonRef.current = null;
      suppressClickRef.current = true;
      return;
    }
    if (simJoyDragRef.current) {
      if (event.pointerId !== simJoyDragRef.current.pointerId) return;
      const { ref, moved } = simJoyDragRef.current;
      simJoyDragRef.current = null;
      // Spring back to center; a plain click (no drag) pulses the switch.
      setControl(ref, 'x', 0.5);
      setControl(ref, 'y', 0.5);
      if (!moved) {
        setControl(ref, 'sw', 1);
        setTimeout(() => setControl(ref, 'sw', 0), 150);
      }
      suppressClickRef.current = true;
      return;
    }
    if (simPotDragRef.current) {
      if (event.pointerId !== simPotDragRef.current.pointerId) return;
      simPotDragRef.current = null;
      suppressClickRef.current = true;
      return;
    }
    if (simMouseDragRef.current) {
      if (event.pointerId !== simMouseDragRef.current.pointerId) return;
      // No spring-back: releasing just stops producing counts.
      simMouseDragRef.current = null;
      suppressClickRef.current = true;
      return;
    }
    if (wireDragRef.current) {
      if (event.pointerId !== wireDragRef.current.pointerId) return;
      const { ref, pinIndex } = wireDragRef.current;
      wireDragRef.current = null;
      setWireDrag(null);
      finishWireDrag(ref, pinIndex, event.clientX, event.clientY);
      return;
    }
    if (partDragRef.current) {
      if (event.pointerId !== partDragRef.current.pointerId) return;
      const { ref, startBoard, moved } = partDragRef.current;
      partDragRef.current = null;
      setPartDrag(null);
      // Pointer capture retargets the ending click to the SVG, so the part's
      // onClick never fires in real browsers — resolve selection here. Suppress
      // the click for paths where it still reaches the part (no capture) so
      // selection doesn't double-toggle.
      suppressClickRef.current = true;
      if (moved) {
        const now = toBoard(event.clientX, event.clientY);
        commitPartMove(ref, now.x - startBoard.x, now.y - startBoard.y);
      } else if (event.type === 'pointerup') { // a cancelled press must not toggle
        toggleSelection({ type: 'part', ref });
      }
      return;
    }
    pointersRef.current.delete(event.pointerId);
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === 'pan') {
      if (svg) svg.style.cursor = '';
      // A press that never moved is a background click: clear the selection.
      if (!movedRef.current) setSelection(null);
      gestureRef.current = null;
      return;
    }
    // Lifting one finger during a pinch: hand the remaining finger a fresh pan.
    if (pointersRef.current.size >= 2) return;
    const remaining = [...pointersRef.current.entries()][0];
    if (remaining) {
      const [pointerId, point] = remaining;
      gestureRef.current = {
        mode: 'pan',
        pointerId,
        startPointer: toViewBox(point.x, point.y),
        startView: { ...viewRef.current },
      };
      movedRef.current = true;
    } else {
      gestureRef.current = null;
    }
  };

  // Wheel needs a native non-passive listener so preventDefault stops the page
  // from zooming/scrolling. ctrl+wheel (also how trackpad pinch arrives) zooms
  // at the cursor; a plain wheel pans (replaces the old scrollbars).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        zoomAround(toViewBox(event.clientX, event.clientY), Math.exp(-event.deltaY * WHEEL_ZOOM_INTENSITY));
        return;
      }
      const rect = svg.getBoundingClientRect();
      const perPixel = rect.width ? model.board.width / rect.width : 1; // viewBox units per client px
      const base = viewRef.current;
      scheduleView({ s: base.s, tx: base.tx - event.deltaX * perPixel, ty: base.ty - event.deltaY * perPixel });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.board.width, model.board.height]);

  // Refit to the whole board whenever the circuit (and thus board size) changes.
  useEffect(() => setView(IDENTITY_VIEW), [model.board.width, model.board.height]);

  // Selection can outlive a regenerated circuit; drop it if its target is gone.
  useEffect(() => setSelection(null), [model]);

  useEffect(() => {
    if (!selection) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  const downloadSvg = () => {
    if (!svgRef.current) return;
    downloadText('breadboard.svg', new XMLSerializer().serializeToString(svgRef.current), 'image/svg+xml');
  };

  // Debug aid: dump a plain-text description of the generated build so it can be
  // pasted into an AI to sanity-check the schematic. Copies to the clipboard;
  // if that is unavailable, falls back to a downloadable .txt.
  const copyDescription = async () => {
    const text = describeBreadboard(circuit, model);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      downloadText('breadboard-description.txt', text);
    }
  };

  // Add a part picked from the double-click component library. Appended with
  // unconnected placeholder pins; the board auto-places it and the user wires it
  // by selecting it and dragging its pin handles onto tie groups.
  const addComponent = (kind) => {
    if (!editable) return;
    onCircuitChange((current) => ({
      ...current,
      components: [...(current.components ?? []), newComponentForKind(kind, current.components ?? [])],
    }));
    setLibraryAt(null);
  };

  const toggleSelection = (next) => {
    setSelection((current) =>
      current && current.type === next.type && (current.ref ?? current.net) === (next.ref ?? next.net)
        ? null
        : next);
  };

  // Shared interactive wrapper props for parts, batteries, and jumpers.
  const interactive = (target, label, lit) => ({
    className: `rs-item ${highlight.active && !lit ? 'rs-dim' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: (event) => {
      event.stopPropagation();
      if (suppressClickRef.current) { suppressClickRef.current = false; return; }
      toggleSelection(target);
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSelection(target);
      }
    },
    onMouseEnter: () => setHovered(target),
    onMouseLeave: () => setHovered(null),
  });

  const selectedPart = selection?.type === 'part'
    ? model.parts.find((part) => part.ref === selection.ref)
    : null;

  const simWarnings = running ? [...new Set((simFrame?.warnings ?? []).map((warning) => warning.message))] : [];
  const simStatusText = !running || !simFrame || simFrame.error
    ? null
    : !simFrame.converged
      ? 'not converging'
      : simFrame.isDynamic
        ? (simFrame.speed >= 0.95 ? '1.0×' : `${simFrame.speed.toFixed(1)}× (slow)`)
        : 'live';

  // The Run/Stop control renders in the toolbar by default; when the shell
  // hands over a host element (the top bar's run slot) it portals there
  // instead, so the simulation state stays owned here.
  const runButton = (
    <button
      type="button"
      className={`realistic-run ${running ? 'running' : ''}`}
      onClick={toggleRun}
      disabled={compiling}
      title={running ? 'Stop the live simulation' : 'Simulate this circuit live on the board'}
    >
      {compiling ? '⏳ Compiling…' : running ? '■ Stop' : '▶ Run'}
    </button>
  );

  return (
    <div className="realistic-schematic">
      <div className="realistic-toolbar">
        {runControlHost ? createPortal(runButton, runControlHost) : runButton}
        {simStatusText && (
          <span className={`realistic-sim-status ${simFrame.converged ? '' : 'warn'}`}>{simStatusText}</span>
        )}
        {running && (
          <button
            type="button"
            className={`realistic-vmap ${voltageOverlay ? 'active' : ''}`}
            onClick={() => setVoltageOverlay((value) => !value)}
            title="Tint tie groups and rails by their live voltage (blue 0V → red max)"
          >
            V map
          </button>
        )}
        {running && hasBuzzer && (
          <button
            type="button"
            className={`realistic-audio-toggle ${audioMuted ? 'muted' : ''}`}
            aria-label={audioMuted ? 'Unmute simulated buzzer sound' : 'Mute simulated buzzer sound'}
            aria-pressed={audioMuted}
            onClick={() => setAudioMuted(!audioMuted)}
            title={audioMuted ? 'Unmute simulated buzzer sound' : 'Mute simulated buzzer sound'}
          >
            {audioMuted ? '🔇 Muted' : '🔊 Sound'}
          </button>
        )}
        <button type="button" onClick={() => zoomAround(centerAnchor(), 1 / 1.25)}>−</button>
        <button type="button" onClick={() => zoomAround(centerAnchor(), 1.25)}>+</button>
        <button type="button" onClick={() => setView(IDENTITY_VIEW)}>Fit</button>
        {model.nets.length > 0 && (
          <button
            type="button"
            className={`realistic-legend-toggle ${showLegend ? 'active' : ''}`}
            aria-pressed={showLegend}
            onClick={() => setShowLegend((value) => !value)}
            title={showLegend ? 'Hide the net legend' : 'Show the net legend'}
          >
            {showLegend ? 'Hide nets' : 'Nets'}
          </button>
        )}
        <span className="realistic-zoom-readout">{Math.round(view.s * 100)}%</span>
        <span className="realistic-readout">{readoutFor(model, effective, running ? simFrame : null) ?? 'Click a part or wire'}</span>
        <button
          type="button"
          className={`realistic-describe ${copied ? 'copied' : ''}`}
          onClick={copyDescription}
          aria-label={copied ? 'Description copied' : 'Copy description'}
          title="Copy a plain-text description of this build to paste into an AI for verification"
        >
          {copied ? (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="realistic-download"
          onClick={downloadSvg}
          aria-label="Download SVG"
          title="Download SVG"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
            <path d="M12 3v11m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {windowControls}
      </div>
      {showLegend && model.nets.length > 0 && (
        <div className="realistic-legend" role="group" aria-label="Nets">
          {model.nets.map(({ net, color }) => {
            const active = selection?.type === 'net' && selection.net === net;
            return (
              <button
                key={net}
                type="button"
                className={`realistic-legend-chip ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleSelection({ type: 'net', net })}
                onMouseEnter={() => setHovered({ type: 'net', net })}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="realistic-legend-swatch" style={{ background: color }} aria-hidden="true" />
                {netDisplayName(net)}
                {running && simFrame?.netVoltages?.has(net) && !simFrame.error && (
                  <span className="realistic-legend-volts">{formatSI(simFrame.netVoltages.get(net), 'V')}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <IssuesPanel
        issues={issues}
        boardIssues={[...(model.integrity?.issues ?? []), ...model.warnings]}
      />
      {compileError && (
        <div className="realistic-sim-banner error" role="alert">
          <strong>Sketch failed to compile:</strong> {compileError}
        </div>
      )}
      {running && simFrame?.error && (
        <div className="realistic-sim-banner error" role="alert">{simFrame.error.message}</div>
      )}
      {running && !simFrame?.error && simWarnings.length > 0 && (
        <div className="realistic-sim-banner" role="note">{simWarnings.join(' · ')}</div>
      )}
      {running && simFrame?.hasMcu && (
        <SerialMonitor text={simFrame.serial} onSendSerial={sendSerial} />
      )}
      {running && selection?.type === 'part' && (
        <SimStimulusPanel
          controls={controls.filter((control) => control.ref === selection.ref)}
          onChange={setControl}
        />
      )}
      <div className="realistic-scroll">
        <svg
          ref={svgRef}
          className={`realistic-canvas ${isPreview ? 'rs-preview' : ''}`}
          viewBox={`0 0 ${model.board.width} ${model.board.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Realistic breadboard schematic"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={(event) => setLibraryAt({ x: event.clientX, y: event.clientY })}
        >
          <PartDefs />
          <g className="rs-world" transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`} style={{ willChange: 'transform' }}>
            <Breadboard board={model.board} rails={model.rails} />
            {running && voltageOverlay && simFrame && !simFrame.error && (
              <HighlightOverlay
                board={model.board}
                highlight={voltageOverlayFor(model, simFrame.netVoltages)}
                nets={model.nets}
              />
            )}
            <HighlightOverlay board={model.board} highlight={highlight} nets={model.nets} />
            {model.parts.map((part) => {
              const dragging = partDrag?.ref === part.ref;
              const clickToggle = running ? RUN_CLICK_TOGGLES[part.kind] : undefined;
              const simInteractive = running
                && (part.kind === 'pushbutton' || part.kind === 'potentiometer' || part.kind === 'keypad' || part.kind === 'joystick' || part.kind === 'mouse_sensor' || Boolean(clickToggle));
              const wrapper = interactive(
                { type: 'part', ref: part.ref },
                `${part.ref} ${String(part.kind).replaceAll('_', ' ')} ${part.value ?? ''}`.trim(),
                highlight.partRefs.has(part.ref),
              );
              // In run mode a click on these kinds toggles their control
              // (switch throw, PIR motion, hall magnet) instead of selecting.
              if (clickToggle) {
                wrapper.onClick = (event) => {
                  event.stopPropagation();
                  if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                  clickToggle(part.ref);
                };
              }
              return (
                <g
                  key={part.ref}
                  {...wrapper}
                  onPointerDown={(event) => (running ? startSimGesture(event, part) : startPartDrag(event, part))}
                  transform={dragging ? `translate(${partDrag.dx} ${partDrag.dy})` : undefined}
                  style={simInteractive ? { cursor: 'pointer' } : !running && movable ? { cursor: 'grab' } : undefined}
                >
                  <title>{readoutFor(model, { type: 'part', ref: part.ref }, running ? simFrame : null)}</title>
                  <RealisticPart part={part} sim={running ? simFrame?.observables?.get(part.ref) : undefined} />
                </g>
              );
            })}
            {model.batteries.map((battery, index) => (
              <g
                key={battery.ref}
                {...interactive(
                  { type: 'part', ref: battery.ref },
                  `${battery.ref} voltage source ${battery.value ?? ''}`.trim(),
                  highlight.partRefs.has(battery.ref) || highlight.batteryRefs.has(battery.ref),
                )}
              >
                <title>{readoutFor(model, { type: 'part', ref: battery.ref }, running ? simFrame : null)}</title>
                <BatteryPack battery={battery} index={index} />
              </g>
            ))}
            {model.jumpers.map((jumper) => (
              <g
                key={jumper.id}
                {...interactive(
                  { type: 'net', net: jumper.net },
                  `jumper wire net ${netDisplayName(jumper.net)}`,
                  highlight.jumperIds.has(jumper.id),
                )}
              >
                <title>{readoutFor(model, { type: 'net', net: jumper.net }, running ? simFrame : null)}</title>
                <JumperWire jumper={jumper} />
              </g>
            ))}
            {selectedPart && <PinLabels part={selectedPart} />}
            {editable && selectedPart && (
              <g className="rs-pin-handles">
                {selectedPart.holes.map((hole, index) => {
                  if (!hole) return null;
                  const center = holeCenter(hole);
                  return (
                    <circle
                      key={`${selectedPart.ref}-${index}`}
                      className="rs-pin-handle"
                      cx={center.x}
                      cy={center.y}
                      r={5}
                      onPointerDown={(event) => startWireDrag(event, selectedPart.ref, index, center)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <title>Drag to rewire pin {index + 1}</title>
                    </circle>
                  );
                })}
              </g>
            )}
            {wireDrag && (
              <line
                className="rs-wire-drag"
                x1={wireDrag.from.x}
                y1={wireDrag.from.y}
                x2={wireDrag.to.x}
                y2={wireDrag.to.y}
                pointerEvents="none"
              />
            )}
          </g>
        </svg>
      </div>
      {libraryAt && (
        <ComponentLibrary
          position={libraryAt}
          onClose={() => setLibraryAt(null)}
          onSelect={editable ? addComponent : undefined}
        />
      )}
    </div>
  );
}
