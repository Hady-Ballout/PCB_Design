// Interactive realistic breadboard view: auto-places the canonical circuit on a
// solderless breadboard with photo-style SVG parts and jumper wires. The board
// is a pan/zoom canvas — drag empty board to pan, wheel / pinch to zoom (kept
// anchored under the cursor), two-finger trackpad to pan. Clicking a part or
// wire highlights its electrical neighborhood (dim-others); hover previews it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText } from '../../core/download.js';
import { circuitToBreadboard, netAtHole, reconcileOverrides, GROUND_NET } from './breadboardModel.js';
import { describeBreadboard } from './breadboardDescription.js';
import { highlightFor, readoutFor } from './selectionModel.js';
import { HOLE_PITCH, clientToViewBox, holeAt, holeCenter, viewBoxToBoard } from './breadboardGeometry.js';
import { Breadboard, HighlightOverlay } from './Breadboard.jsx';
import { BatteryPack, JumperWire, PartDefs, PinLabels, RealisticPart } from './parts.jsx';
import './RealisticSchematic.css';

// Zoom scale bounds. s = 1 is "board fitted to the viewport" (viewBox + meet);
// below 1 shrinks it, above 1 zooms in for detail.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 8;
const IDENTITY_VIEW = { tx: 0, ty: 0, s: 1 };
const WHEEL_ZOOM_INTENSITY = 0.0015; // per wheel deltaY unit
const CLICK_MOVE_THRESHOLD = 3; // viewBox px of drag below which a press is a click

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const netDisplayName = (net) => (net === GROUND_NET ? 'GND' : net);

export function RealisticSchematic({ circuit, overrides, onCircuitChange, onLayoutChange }) {
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

  return (
    <div className="realistic-schematic">
      <div className="realistic-toolbar">
        <button type="button" onClick={() => zoomAround(centerAnchor(), 1 / 1.25)}>−</button>
        <button type="button" onClick={() => zoomAround(centerAnchor(), 1.25)}>+</button>
        <button type="button" onClick={() => setView(IDENTITY_VIEW)}>Fit</button>
        <span className="realistic-zoom-readout">{Math.round(view.s * 100)}%</span>
        <span className="realistic-readout">{readoutFor(model, selection) ?? 'Click a part or wire'}</span>
        <button
          type="button"
          className="realistic-describe"
          onClick={copyDescription}
          title="Copy a plain-text description of this build to paste into an AI for verification"
        >
          {copied ? 'Copied!' : 'Copy description'}
        </button>
        <button type="button" className="realistic-download" onClick={downloadSvg}>Download SVG</button>
      </div>
      {model.nets.length > 0 && (
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
              </button>
            );
          })}
        </div>
      )}
      {model.warnings.length > 0 && (
        <ul className="realistic-warnings">
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
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
        >
          <PartDefs />
          <g className="rs-world" transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`} style={{ willChange: 'transform' }}>
            <Breadboard board={model.board} rails={model.rails} />
            <HighlightOverlay board={model.board} highlight={highlight} />
            {model.parts.map((part) => {
              const dragging = partDrag?.ref === part.ref;
              return (
                <g
                  key={part.ref}
                  {...interactive(
                    { type: 'part', ref: part.ref },
                    `${part.ref} ${String(part.kind).replaceAll('_', ' ')} ${part.value ?? ''}`.trim(),
                    highlight.partRefs.has(part.ref),
                  )}
                  onPointerDown={(event) => startPartDrag(event, part)}
                  transform={dragging ? `translate(${partDrag.dx} ${partDrag.dy})` : undefined}
                  style={movable ? { cursor: 'grab' } : undefined}
                >
                  <title>{readoutFor(model, { type: 'part', ref: part.ref })}</title>
                  <RealisticPart part={part} />
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
                <title>{readoutFor(model, { type: 'part', ref: battery.ref })}</title>
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
                <title>{readoutFor(model, { type: 'net', net: jumper.net })}</title>
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
    </div>
  );
}
